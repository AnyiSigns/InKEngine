"""引擎侧 LLM 链守卫包装单测（用量闭环 + 回合内上下文压缩）。

- :class:`UsageTrackingLLM`：usage 帧 → 当前节点成本账（account_usage）
  + ``llm_usage`` 指标事件；节点上下文缺失/上报失败不阻断 LLM 流；
- :class:`CompressingLLM`：触发阈值（默认 30 条/40000 字符）内零改动
  透传；触发后旧段折叠为确定性摘要（system 恒保留 + 保留尾段）；
- 执行器节点上下文注入（current_node_context）在节点执行期对 LLM
  调用可见。
"""
from __future__ import annotations

from collections.abc import AsyncIterator, Sequence

from ink_engine.core.context import ThresholdCompressionPolicy
from ink_engine.core.llm.base import AsyncLLM, LLMChunk, LLMConfig, LLMResult
from ink_engine.core.llm.guard import (
    CompressingLLM,
    UsageTrackingLLM,
    current_node_context,
)
from ink_engine.core.llm.messages import Message, assistant, system, user


class RecordingLLM(AsyncLLM):
    """脚本化内层模型：记录收到的消息与 usage 回传点。"""

    adapter = "recording"

    def __init__(self, *, stream_usage=None, result_usage=None):
        super().__init__(
            LLMConfig(adapter="recording", model_id="rec", base_url="http://rec")
        )
        self.received: list[Sequence[Message]] = []
        self.aclosed = False
        self._stream_usage = stream_usage
        self._result_usage = result_usage

    async def ainvoke(self, messages, *, tools=None, params=None) -> LLMResult:
        self.received.append(list(messages))
        return LLMResult(content="ok", usage=self._result_usage)

    async def astream(self, messages, *, tools=None, params=None) -> AsyncIterator[LLMChunk]:
        self.received.append(list(messages))
        yield LLMChunk(token="ok")
        if self._stream_usage:
            yield LLMChunk(usage=self._stream_usage)

    async def aclose(self) -> None:
        self.aclosed = True


class FakeCtx:
    """节点上下文鸭子形态（account_usage + emit 留痕）。"""

    def __init__(self):
        self.accounted: list[dict] = []
        self.events: list[tuple[str, dict]] = []

    def account_usage(self, usage: dict) -> None:
        self.accounted.append(usage)

    async def emit(self, etype: str, payload: dict, **kw) -> None:
        self.events.append((etype, payload))


def _long_history(n: int, chars: int = 20) -> list[Message]:
    """n 条历史消息（交替 user/assistant，各 chars 字符）+ system 链首。"""
    messages = [system("系统提示")]
    for i in range(n):
        messages.append(user(f"u{i}" + "x" * chars))
        messages.append(assistant("a" + "y" * chars))
    return messages


# ── 用量闭环 ──


async def test_usage_tracking_ainvoke_accounts_and_emits():
    inner = RecordingLLM(result_usage={"prompt_tokens": 5, "completion_tokens": 3})
    llm = UsageTrackingLLM(inner)
    ctx = FakeCtx()
    token = current_node_context.set(ctx)
    try:
        result = await llm.ainvoke([user("hi")])
    finally:
        current_node_context.reset(token)
    assert result.content == "ok"
    assert ctx.accounted == [{"prompt_tokens": 5, "completion_tokens": 3}]
    assert ("llm_usage", {"prompt_tokens": 5, "completion_tokens": 3}) in ctx.events


async def test_usage_tracking_astream_captures_usage_frame():
    inner = RecordingLLM(stream_usage={"prompt_tokens": 7, "completion_tokens": 2})
    llm = UsageTrackingLLM(inner)
    ctx = FakeCtx()
    token = current_node_context.set(ctx)
    try:
        chunks = [c async for c in llm.astream([user("hi")])]
    finally:
        current_node_context.reset(token)
    assert [c.token for c in chunks if c.token] == ["ok"]
    assert ctx.accounted == [{"prompt_tokens": 7, "completion_tokens": 2}]
    assert ("llm_usage", {"prompt_tokens": 7, "completion_tokens": 2}) in ctx.events


async def test_usage_tracking_without_node_context_is_noop():
    """节点上下文缺失（节点外调用）静默跳过，不阻断 LLM 流。"""
    inner = RecordingLLM(stream_usage={"prompt_tokens": 1})
    llm = UsageTrackingLLM(inner)
    chunks = [c async for c in llm.astream([user("hi")])]
    assert [c.token for c in chunks if c.token] == ["ok"]


async def test_usage_tracking_account_failure_not_blocking():
    """上报失败（account_usage 抛错）不阻断 LLM 调用。"""
    inner = RecordingLLM(result_usage={"prompt_tokens": 1})

    class BadCtx:
        def account_usage(self, usage):
            raise RuntimeError("记账失败")

        async def emit(self, etype, payload, **kw):
            raise RuntimeError("事件失败")

    llm = UsageTrackingLLM(inner)
    token = current_node_context.set(BadCtx())
    try:
        result = await llm.ainvoke([user("hi")])
    finally:
        current_node_context.reset(token)
    assert result.content == "ok"


async def test_usage_tracking_forwards_aclose():
    inner = RecordingLLM()
    llm = UsageTrackingLLM(inner)
    await llm.aclose()
    assert inner.aclosed


# ── 回合内上下文压缩 ──

# 默认策略（30 条/40000 字符）触发所需的历史规模：60 轮 × 700 字符
_DEFAULT_TRIGGER_HISTORY = _long_history(60, chars=700)


def test_compress_under_threshold_passthrough():
    messages = _long_history(5, chars=10)  # 11 条 × 10 字 → 双阈值均不达
    inner = RecordingLLM()
    llm = CompressingLLM(inner)
    result = llm._apply(messages)
    assert result == list(messages)  # 未触发：原样透传
    assert len(result) == len(messages)


def test_compress_over_threshold_summary_and_tail():
    messages = _DEFAULT_TRIGGER_HISTORY  # 121 条 × ~700 字 → 双阈值触发
    inner = RecordingLLM()
    llm = CompressingLLM(inner, keep_recent=6)
    result = llm._apply(messages)
    assert len(result) < len(messages)  # 折叠生效
    # system 恒保留 + 摘要 + 最近 6 条保留
    assert result[0] == messages[0]
    assert result[0].role == "system"
    summary = result[1]
    assert summary.role == "user"
    assert "历史上下文压缩摘要" in summary.content
    # 最近消息原样保留（含原文）
    assert result[-6:] == messages[-6:]


def test_compress_summary_deterministic():
    messages = _DEFAULT_TRIGGER_HISTORY
    llm = CompressingLLM(inner=RecordingLLM(), keep_recent=6)
    first = llm._apply(messages)
    second = llm._apply(messages)
    assert [m.content for m in first] == [m.content for m in second]


def test_compress_custom_policy_thresholds():
    strict = ThresholdCompressionPolicy(min_messages=5, min_chars=100)
    messages = _long_history(3, chars=30)  # 7 条 × 30 字 ≥ 双阈值
    inner = RecordingLLM()
    llm = CompressingLLM(inner, policy=strict, keep_recent=2)
    result = llm._apply(messages)
    assert len(result) < len(messages)


async def test_compressing_llm_forwards_compressed_messages():
    messages = _DEFAULT_TRIGGER_HISTORY
    inner = RecordingLLM()
    llm = CompressingLLM(inner, keep_recent=6)
    await llm.ainvoke(messages)
    assert len(inner.received) == 1
    assert len(inner.received[0]) < len(messages)
    assert inner.received[0][-6:] == messages[-6:]


async def test_compressing_llm_stream_passthrough_when_not_triggered():
    messages = _long_history(2, chars=5)  # 5 条 × 5 字 → 不触发
    inner = RecordingLLM()
    llm = CompressingLLM(inner)
    chunks = [c async for c in llm.astream(messages)]
    assert [c.token for c in chunks] == ["ok"]
    assert inner.received[0] == list(messages)


async def test_compressing_forwards_aclose():
    inner = RecordingLLM()
    llm = CompressingLLM(inner)
    await llm.aclose()
    assert inner.aclosed

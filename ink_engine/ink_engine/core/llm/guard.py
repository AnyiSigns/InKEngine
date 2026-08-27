"""引擎侧 LLM 链守卫包装：用量闭环 + 回合内上下文压缩。

- :class:`UsageTrackingLLM`：LLM usage 帧 → 当前节点成本账
  （``ctx.account_usage``）与 ``llm_usage`` 指标事件（``ctx.emit``）——
  生产用量闭环接线：流式末帧 usage（``stream_options.include_usage``）
  与非流式 ``result.usage`` 统一上报，不再只活在测试里；
- :class:`CompressingLLM`：LLM 调用前按 CompressPolicy 压缩消息流——
  回合内上下文压缩：默认双阈值（30 条 / 40000 字符）触发，阈值
  与保留尾段长度可配，压缩是确定性非破坏视图（原始消息流不修改）。

节点上下文经 :data:`current_node_context`（ContextVar）由执行器在节点
边界注入，包装层据此把用量记入正确的结点账并发射事件——包装层不依赖
执行器具体类型（鸭子协议：``account_usage``/``emit``），节点外调用
（None 上下文）时静默跳过，零影响。
"""
from __future__ import annotations

import contextvars
import inspect
import logging
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from ink_engine.core.context import (
    CompressionPolicy,
    ThresholdCompressionPolicy,
    compress_message_history,
)
from ink_engine.core.llm.base import AsyncLLM, LLMChunk, LLMConfig, LLMParams, LLMResult
from ink_engine.core.llm.messages import Message
from ink_engine.core.llm.tools import ToolSpec

logger = logging.getLogger(__name__)

# 执行器注入的当前节点上下文（节点边界设置，包装层读取；None = 节点外调用）。
# 定义在包装模块而非执行器：包装层读取、执行器写入，避免 llm ↔ executor
# 模块循环依赖（executor 顶层 import 本模块即可）。
current_node_context: contextvars.ContextVar[Any | None] = contextvars.ContextVar(
    "engine_current_node_context", default=None
)

# 包装器协议形态的占位配置（不发网络调用；config 仅是 AsyncLLM 基类协议字段）
_GUARD_CONFIG = LLMConfig(
    adapter="guard",
    model_id="engine-guard",
    base_url="http://guard.local",
)


def _usage_frame(usage: Mapping[str, Any]) -> dict[str, int]:
    """usage 帧 → 指标帧（prompt/completion tokens；缺项/非正值省略）。"""
    frame: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens"):
        try:
            value = int(usage.get(key))
        except (TypeError, ValueError):
            continue
        if value > 0:
            frame[key] = value
    return frame


class UsageTrackingLLM(AsyncLLM):
    """用量闭环包装：LLM usage 帧 → 结点成本账 + llm_usage 指标事件。

    生产用量闭环接线：执行器在节点边界注入当前节点上下文
    （:data:`current_node_context`），本包装在每次调用的 usage 帧处：

    - ``ctx.account_usage(usage)``：token 计入当前节点执行边界成本账
      （随沉淀钩子按边归集 avg_cost）——生产用量记账点不再只有测试；
    - ``ctx.emit("llm_usage", {prompt_tokens, completion_tokens})``：
      指标帧进事件流——metrics.snapshot 的 ``llm_usage`` 链真实可观测。

    用法：引擎/宿主在把 LLM 交给节点消费前包一层（runtime.rebuild_engine
    装配即包装）。用量闭环是增强能力：节点上下文缺失/上报失败只记日志，
    不阻断 LLM 调用。
    """

    adapter = "usage_tracking"

    def __init__(self, inner: AsyncLLM) -> None:
        """包装内层模型（AsyncLLM 协议）。"""
        self._inner = inner
        super().__init__(_GUARD_CONFIG)

    async def _account(self, usage: Mapping[str, Any] | None) -> None:
        if not usage:
            return
        ctx = current_node_context.get()
        if ctx is None:
            return
        try:
            account = getattr(ctx, "account_usage", None)
            if account is not None:
                account(usage)
            emit = getattr(ctx, "emit", None)
            if emit is not None:
                frame = _usage_frame(usage)
                if frame:
                    outcome = emit("llm_usage", frame)
                    if inspect.isawaitable(outcome):
                        await outcome
        except Exception as exc:
            logger.warning("LLM 用量上报失败（忽略，不阻断调用）: %s", exc)

    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        result = await self._inner.ainvoke(messages, tools=tools, params=params)
        await self._account(result.usage)
        return result

    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        async for chunk in self._inner.astream(messages, tools=tools, params=params):
            if chunk.usage:
                await self._account(chunk.usage)
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


class CompressingLLM(AsyncLLM):
    """回合内上下文压缩包装：LLM 调用前按 CompressPolicy 压缩消息流。

    触发阈值与保留尾段长度可配（``policy``/``keep_recent``），默认
    :class:`ThresholdCompressionPolicy`（30 条 / 40000 字符，构造参数可
    覆盖）——触发前原样透传零改动；触发后旧消息段折叠为确定性摘要
    （:func:`compress_message_history`，非破坏性视图：原始消息流不修改）。
    """

    adapter = "compressing"

    def __init__(
        self,
        inner: AsyncLLM,
        *,
        policy: CompressionPolicy | None = None,
        keep_recent: int = 10,
    ) -> None:
        """包装内层模型。

        Args:
            inner: 被包装的模型/模型链（AsyncLLM 协议）。
            policy: 压缩策略（None = 引擎默认
                :class:`ThresholdCompressionPolicy`，30 条/40000 字符）。
            keep_recent: 压缩触发时保留的最近消息条数（system 消息恒保留）。
        """
        self._inner = inner
        self._policy = policy if policy is not None else ThresholdCompressionPolicy()
        self._keep_recent = keep_recent
        super().__init__(_GUARD_CONFIG)

    def _apply(self, messages: Sequence[Message]) -> list[Message]:
        if not messages:
            return list(messages)
        return compress_message_history(
            messages, policy=self._policy, keep_recent=self._keep_recent
        )

    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        return await self._inner.ainvoke(
            self._apply(messages), tools=tools, params=params
        )

    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        async for chunk in self._inner.astream(
            self._apply(messages), tools=tools, params=params
        ):
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


__all__ = ["CompressingLLM", "UsageTrackingLLM", "current_node_context"]

"""InKling 嵌入桥的 Python 侧资产（随壳进程内嵌执行，经 PyO3 暴露给 Rust）。

本模块持有嵌入环境中「用 Python 表达最自然」的少量宿主件：
- 离线模型桩（确定性回复，离线装配与回合验证共用，不发起网络请求）；
- 装配助手（宿主五件套构造、回合执行到完成、协议检查助手）；
- 协议检查助手（Rust 侧实现的嵌入/记忆协议对象经本模块被引擎侧消费的验证入口）。

Rust 接线层对引擎的所有调用都经本模块，避免跨语言边界直接触碰引擎内部。
"""
from __future__ import annotations

import os
import sys

_REPO_ROOT = os.environ.get("INK_ENGINE_REPO_ROOT", "")
if _REPO_ROOT and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


def _split_tokens(text: str) -> list[str]:
    """确定性分片（按字符切分，保证离线流式可断言）。"""
    return [ch for ch in text if ch]


class StubLLM:
    """脚本化确定性模型：按最后一条用户消息子串匹配回复，未命中给缺省文本。

    覆盖统一模型接口的三个方法（ainvoke/astream/aclose），不发起任何网络
    请求——离线装配与回合验证共用此桩。
    """

    adapter = "stub"

    def __init__(self, script=None, default_reply="（stub 缺省回复）"):
        self.script = dict(script or {})
        self.default_reply = default_reply
        self.call_count = 0

    def _reply_for(self, messages) -> str:
        self.call_count += 1
        for message in reversed(list(messages)):
            content = getattr(message, "content", "")
            if not isinstance(content, str):
                continue
            for needle, spec in self.script.items():
                if needle in content:
                    return str(spec.get("reply") or self.default_reply)
        return self.default_reply

    async def ainvoke(self, messages, *, tools=None, params=None):
        from ink_engine.core.llm.base import LLMResult

        return LLMResult(content=self._reply_for(messages))

    async def astream(self, messages, *, tools=None, params=None):
        from ink_engine.core.llm.base import LLMChunk

        reply = self._reply_for(messages)
        for token in _split_tokens(reply):
            yield LLMChunk(token=token)

    async def aclose(self) -> None:
        return None


def make_host(*, storage_uri: str, transport, llm=None):
    """构造宿主五件套：存储 URI/事件传输（Rust 回桥）/模型实例注入。"""
    from legacy.host.host import InKlingHost

    return InKlingHost(storage_uri=storage_uri, llm=llm, transport=transport)


async def execute_round_to_reply(
    runtime,
    host,
    *,
    input_text: str,
    thread_id: str,
    round_id: str,
    step_args: dict | None = None,
    inject: dict | None = None,
    auto_accept_review: bool = True,
    max_cards: int = 8,
):
    """执行一次回合直至终态：审批卡逐张决议（可指定接受决议），直到回复/终止。

    生产宿主按审批卡交互决议；离线验证用 auto_accept_review 一次跑通。
    """
    state = {"input": input_text, "step_args": step_args or {}}
    result = await runtime.engine.ainvoke(
        state,
        thread_id=thread_id,
        round_id=round_id,
        transports=[host.build_transport()],
        inject=inject or {},
    )
    guard = 0
    while result.reason == "interrupted" and auto_accept_review and guard < max_cards:
        guard += 1
        interrupt = await runtime.engine.get_latest_interrupt(thread_id)
        if interrupt is None:
            break
        result = await runtime.resume_run(
            thread_id,
            {interrupt.key: "accept"},
            round_id=f"{round_id}-resume-{guard}",
            transports=[host.build_transport()],
        )
    return {"reason": result.reason, "state": dict(getattr(result, "state", {}) or {})}


async def stop_runtime(runtime) -> None:
    """关停运行时（幂等；排队等完成/关 MCP/关存储/宿主钩子由引擎保证）。"""
    await runtime.stop()


def boot_summary(runtime):
    """装配摘要：工具清单/事件类型清单（宿主观测与门禁断言）。"""
    names = sorted({spec.name for spec in runtime.collect_specs()})
    events = sorted(runtime.event_type_registry.names())
    return {"tool_names": names, "event_types": events}


async def check_embedding_protocol(runtime, embedder, query: str = "墨引擎") -> float:
    """嵌入协议验证：Rust 嵌入器引擎适配桥评分一轮（可等待对象双向桥）。"""
    from legacy.host.assembly_domain import EngineEmbedderBridge

    entries = list(runtime.knowledge_set.entries())
    if not entries:
        return -1.0
    target = entries[0]
    probe = (target.title or target.content or query)
    bridge = EngineEmbedderBridge(embedder)
    return float(await bridge.score(probe, target))


async def check_memory_protocol(store) -> int:
    """记忆协议验证：Rust 记忆存储在引擎语义下走一圈 保存→读→查→改→遗忘。"""
    from ink_engine.core.memory import MemoryEntry, MemoryQuery

    entry = MemoryEntry(namespace="user:bridge", kind="note", content="hello", priority=3)
    entry_id = await store.save(entry)
    got = await store.get(entry_id)
    if got is None or got.content != "hello":
        return -1
    rows = await store.query(MemoryQuery(namespace="user:bridge"))
    if len(rows) != 1:
        return -2
    updated = await store.update(entry_id, {"priority": 9})
    if not updated:
        return -3
    rows = await store.query(MemoryQuery(namespace="user:bridge"))
    if not rows or rows[0].priority != 9:
        return -4
    deleted = await store.delete(entry_id)
    if not deleted:
        return -5
    rows = await store.query(MemoryQuery(namespace="user:bridge"))
    return len(rows)  # 期望 0（遗忘后召回不可见）

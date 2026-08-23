"""InKling 嵌入桥的 Python 侧资产（随壳进程内嵌执行，经 PyO3 暴露给 Rust）。

本模块持有嵌入环境中「用 Python 表达最自然」的少量宿主件：
- 离线模型桩（确定性回复，离线装配与回合验证共用，不发起网络请求）；
- 装配助手（宿主五件套构造、回合执行到完成、协议检查助手）；
- 引擎操作通道（Rust 域模块经此调用引擎公开 API：为薄包装，
  只做事先约定 JSON 字典与引擎对象形态转换，不含领域逻辑）；
- JSON 回调桥（Rust 侧闭包以 json 往返方式注入引擎作为回调的受控形态）。

Rust 接线层对引擎的所有调用都经本模块，避免跨语言边界直接触碰引擎内部。
"""
from __future__ import annotations

import inspect
import json
import os
import sys
from typing import Any, Callable

_REPO_ROOT = os.environ.get("INK_ENGINE_REPO_ROOT", "")
if _REPO_ROOT and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# 当前运行时句柄（boot 后由 Rust 侧绑定；装配期外的引擎对象访问出口）
_RUNTIME: Any = None
_HOST: Any = None


def bind_runtime(runtime, host) -> None:
    """装配完成后绑定运行时句柄（模块级；进程内单实例语义）。"""
    global _RUNTIME, _HOST
    _RUNTIME = runtime
    _HOST = host


def runtime_handle() -> Any:
    """当前运行时（未装配时显式报错，不静默回退）。"""
    if _RUNTIME is None:
        raise RuntimeError("运行时未装配（先经 boot 绑定）")
    return _RUNTIME


def host_handle() -> Any:
    if _HOST is None:
        raise RuntimeError("宿主未装配（先经 boot 绑定）")
    return _HOST


# ── 引擎操作通道（op 注册表：薄包装；域逻辑在 Rust 侧）──

_OPS_SYNC: dict[str, Callable[[dict], Any]] = {}
_OPS_ASYNC: dict[str, Callable[[dict], Any]] = {}


def op_sync(name: str, fn: Callable[[dict], Any] | None = None):
    """同步 op 注册（装饰器或直接调用双形态）。"""
    def register(func: Callable[[dict], Any]) -> Callable[[dict], Any]:
        _OPS_SYNC[name] = func
        return func
    if fn is not None:
        return register(fn)
    return register


def op_async(name: str, fn: Callable[[dict], Any] | None = None):
    """异步 op 注册（装饰器或直接调用双形态）。"""
    def register(func: Callable[[dict], Any]) -> Callable[[dict], Any]:
        _OPS_ASYNC[name] = func
        return func
    if fn is not None:
        return register(fn)
    return register


def _jsonable(value: Any) -> Any:
    """引擎对象序列化兜底（dataclass/枚举 → dict；其余保底 JSON 直转）。"""
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    for attr in ("to_dict", "to_json"):
        method = getattr(value, attr, None)
        if callable(method):
            try:
                return _jsonable(method())
            except Exception:
                pass
    if hasattr(value, "__dataclass_fields__"):
        return {
            str(field): _jsonable(getattr(value, field))
            for field in getattr(value, "__dataclass_fields__")
        }
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)


def invoke(name: str, args_json: str) -> str:
    """同步操作通道：JSON 进、JSON 出（域模块调用引擎公开 API 的薄包装）。"""
    fn = _OPS_SYNC.get(name)
    if fn is None:
        raise KeyError(f"未注册的同步引擎操作: {name}")
    args = json.loads(args_json)
    result = fn(args)
    return json.dumps(_jsonable(result))


async def invoke_async(name: str, args_json: str) -> str:
    """异步操作通道：JSON 进、JSON 出（引擎异步 API 的薄包装）。"""
    fn = _OPS_ASYNC.get(name)
    if fn is None:
        raise KeyError(f"未注册的异步引擎操作: {name}")
    args = json.loads(args_json)
    result = await fn(args)
    return json.dumps(_jsonable(result))


def register_builtin_ops() -> None:
    """注册出厂引擎操作（薄包装集合；随域模块拓展增量注册）。"""

    @op_async("engine.chain_assemble")
    async def _chain_assemble(args: dict) -> Any:
        runtime = runtime_handle()
        assembled = await runtime.self_pipeline.chain.assemble()
        return _jsonable(assembled)

    @op_async("engine.rebuild")
    async def _rebuild(args: dict) -> Any:
        runtime = runtime_handle()
        await runtime.rebuild_engine()
        return None

    @op_sync("engine.collect_specs")
    def _collect_specs(args: dict) -> Any:
        runtime = runtime_handle()
        return [_jsonable(spec) for spec in runtime.collect_specs()]

    @op_async("engine.records_put")
    async def _records_put(args: dict) -> Any:
        runtime = runtime_handle()
        await runtime.storage.put_record(args["collection"], args["key"], args["data"])
        return None

    @op_async("engine.records_get")
    async def _records_get(args: dict) -> Any:
        runtime = runtime_handle()
        return await runtime.storage.get_record(args["collection"], args["key"])

    @op_async("engine.records_list")
    async def _records_list(args: dict) -> Any:
        runtime = runtime_handle()
        return [_jsonable(rec) for rec in await runtime.storage.list_records(args["collection"])]

    @op_sync("engine.knowledge_add")
    def _knowledge_add(args: dict) -> Any:
        from ink_engine.core.knowledge_set import KnowledgeEntry

        runtime = runtime_handle()
        entry = KnowledgeEntry.from_dict(args["entry"])
        runtime.knowledge_set.add(entry)
        return entry.id

    @op_sync("engine.knowledge_get")
    def _knowledge_get(args: dict) -> Any:
        runtime = runtime_handle()
        entry = runtime.knowledge_set.get(args["id"])
        return _jsonable(entry) if entry is not None else None

    @op_sync("engine.declarative_register_definition")
    def _decl_register_definition(args: dict) -> Any:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        runtime = runtime_handle()
        spec = DeclarativeToolSpec.from_dict(args["spec"])
        runtime.harness_registry.declarative.register_definition(spec)
        return None

    @op_sync("engine.declarative_unregister_definition")
    def _decl_unregister_definition(args: dict) -> Any:
        runtime = runtime_handle()
        runtime.harness_registry.declarative.unregister_definition(args["name"])
        return None

    @op_sync("engine.tool_registry_put")
    def _tool_registry_put(args: dict) -> Any:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        runtime = runtime_handle()
        spec = DeclarativeToolSpec.from_dict(args["spec"])
        runtime.tool_registry[spec.name] = spec.to_spec()
        return None

    @op_sync("engine.introspection_refresh_tool_sources")
    def _introspection_refresh(args: dict) -> Any:
        runtime = runtime_handle()
        runtime.introspection_service._sources.tools = runtime.collect_specs()
        return None

    @op_async("engine.event_types_names")
    async def _event_types_names(args: dict) -> Any:
        runtime = runtime_handle()
        return list(runtime.event_type_registry.names())


# ── 协议注入验证助手（Rust 侧实现的嵌入/记忆协议对象经此被消费验证）──

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
    return len(rows)  # 期望 0（遗忘后召回不可见)


register_builtin_ops()

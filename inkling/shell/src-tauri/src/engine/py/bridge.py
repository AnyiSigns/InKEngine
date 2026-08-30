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

import asyncio
import json
import os
import sys
import time
from typing import Any, Callable

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.logging import get_logger

logger = get_logger("host.bridge")

_REPO_ROOT = os.environ.get("INK_ENGINE_REPO_ROOT", "")
if _REPO_ROOT and _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

# 当前运行时句柄（boot 后由 Rust 侧绑定；装配期外的引擎对象访问出口）
_RUNTIME: Any = None
_HOST: Any = None

# 引擎事件循环（异步 op 的宿主循环；同步 op 需要驱动引擎异步 API 时
# 经 run_coroutine_threadsafe 派发到该循环——引擎对象（storage 连接等）
# 与循环绑定，不得在其它线程新建循环驱动）
_ENGINE_LOOP: asyncio.AbstractEventLoop | None = None


def bind_runtime(runtime, host) -> None:
    """装配完成后绑定运行时句柄（模块级；进程内单实例语义）。"""
    global _RUNTIME, _HOST
    _RUNTIME = runtime
    _HOST = host
    _capture_engine_loop()


def _capture_engine_loop() -> None:
    """记录当前线程运行中的事件循环（引擎异步 op 的宿主循环）。

    装配/回合均在引擎循环内执行，invoke_async 每次调用时刷新——循环
    重建后同步 op 的派发目标自动跟随最新循环。
    """
    global _ENGINE_LOOP
    try:
        _ENGINE_LOOP = asyncio.get_running_loop()
    except RuntimeError:
        pass  # 调用方不在循环线程：保留既有引用（惰性由 invoke_async 捕获）


def _run_on_engine_loop(coro_factory: Callable[[], Any]) -> Any:
    """同步通道驱动引擎异步 API（run_coroutine_threadsafe 派发到宿主循环）。

    同步 op（Rust 经 invoke 通道调用）运行在 Rust 线程，引擎异步对象
    与宿主循环绑定——新建循环驱动会破坏绑定（storage 连接跨循环失效）。
    本函数把协程调度到宿主循环并阻塞等待结果；超时/循环未就绪显式
    报错（fail-closed，不静默回退）。
    """
    loop = _ENGINE_LOOP
    if loop is None or loop.is_closed():
        raise RuntimeError(
            "引擎事件循环未就绪（同步 op 派发失败：先经任一异步 op 建立循环）"
        )
    running = asyncio.get_running_loop()
    if running is loop:
        raise RuntimeError(
            "引擎事件循环上不可同步等待自身调度（死锁防护：同步 op 应在"
            " Rust 线程调用）"
        )
    future = asyncio.run_coroutine_threadsafe(coro_factory(), loop)
    return future.result(timeout=_SYNC_OP_AWAIT_TIMEOUT)


# 同步 op 驱动引擎异步 API 的等待上限（秒）：Rust 侧同步阻塞等待，
# 上界防 worker 线程无限挂起；超时 = 显式错误上报
_SYNC_OP_AWAIT_TIMEOUT = 300.0


def runtime_handle() -> Any:
    """当前运行时（未装配时显式报错，不静默回退）。"""
    if _RUNTIME is None:
        raise RuntimeError("运行时未装配（先经 boot 绑定）")
    return _RUNTIME


def host_handle() -> Any:
    if _HOST is None:
        raise RuntimeError("宿主未装配（先经 boot 绑定）")
    return _HOST


# 离线模型桩句柄（Rust 侧 boot 时绑定；可观测 = 提示词生效断言取用）
_STUB_LLM: Any = None


def bind_stub_llm(llm) -> None:
    """绑定离线模型桩（模块级；最近一次调用的消息流可观测）。"""
    global _STUB_LLM
    _STUB_LLM = llm


def stub_llm_handle() -> Any:
    if _STUB_LLM is None:
        raise RuntimeError("模型桩未绑定（先经 boot 绑定）")
    return _STUB_LLM


# ── 引擎操作通道（op 注册表：薄包装；域逻辑在 Rust 侧）──

_OPS_SYNC: dict[str, Callable[[dict], Any]] = {}
_OPS_ASYNC: dict[str, Callable[[dict], Any]] = {}

# 知识拓扑边数上限（防大知识集构建 O(n²) 全互联边爆量；截尾保留
# 先构造的 tag/source/reference 关系）
_KNOWLEDGE_GRAPH_EDGE_CAP = 2000


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
    """同步操作通道：JSON 进、JSON 出（域模块调用引擎公开 API 的薄包装）。

    未知 op = 显式空态标记（不白屏）：返回 {"op": name, "found": false}。
    """
    fn = _OPS_SYNC.get(name)
    if fn is None:
        # P9：未注册 op 返回结构化错误（不再抛 KeyError 原文泄漏内部
        # 注册命名；Rust 侧 host.rs 对结构化错误按 error 字段呈现）
        return json.dumps(
            {"ok": False, "error": "unregistered_op", "op": name},
            ensure_ascii=False,
        )
    args = json.loads(args_json)
    result = fn(args)
    return json.dumps(_jsonable(result))


async def invoke_async(name: str, args_json: str) -> str:
    """异步操作通道：JSON 进、JSON 出（引擎异步 API 的薄包装）。

    未知 op = 显式空态标记（不白屏）：返回 {"op": name, "found": false}。
    """
    _capture_engine_loop()  # 宿主循环锚点（同步 op 派发目标）
    fn = _OPS_ASYNC.get(name)
    if fn is None:
        # P9：未注册 op 返回结构化错误（同 invoke 口径）
        return json.dumps(
            {"ok": False, "error": "unregistered_op", "op": name},
            ensure_ascii=False,
        )
    args = json.loads(args_json)
    result = await fn(args)
    return json.dumps(_jsonable(result))


# ── JSON 回调桥（引擎执行路径上 Rust 域逻辑的受控接入点）──

_CALLBACK_HOST: Any = None


def bind_callback_host(host) -> None:
    """绑定回调宿主（Rust 侧注册的回调经此被引擎侧消费；进程级单实例）。"""
    global _CALLBACK_HOST
    _CALLBACK_HOST = host


def callback_host() -> Any:
    """当前回调宿主实例（未装配显式报错；Rust 侧注册的定位出口）。"""
    if _CALLBACK_HOST is None:
        raise RuntimeError("回调桥未装配（先经 register_objects 绑定）")
    return _CALLBACK_HOST


def _callback(name: str, payload: dict) -> Any:
    """调用 Rust 侧回调（JSON 进/JSON 出；未注册显式报错，不静默回退）。"""
    if _CALLBACK_HOST is None:
        raise RuntimeError(f"回调桥未装配（回调: {name}）")
    raw = _CALLBACK_HOST.invoke(name, json.dumps(payload, ensure_ascii=False))
    return json.loads(raw)


# ── 回合外的审批决议（宿主侧动作经审批卡请求预注入决议）──

_APPROVAL_DECISIONS: dict[str, Any] = {}
_PENDING_CARDS: dict[str, dict] = {}


class StandaloneApprovalContext:
    """回合外的审批上下文：决议经审批卡请求预注入，未知卡按拒绝处理。

    引擎的挂卡审批原语在回合内经中断键持久化；宿主侧动作（补丁应用/
    回退等）不在回合内执行，本上下文以「先请求审批卡再注入决议」
    的两步形态提供同一语义——未提供决议 = fail-closed 拒绝并留痕。
    """

    def __init__(self, thread_id: str | None = None) -> None:
        self._scope = thread_id or "host"

    def _key(self, key: str) -> str:
        return f"{self._scope}:{key}"

    async def interrupt(self, key: str, card: dict) -> Any:
        full = self._key(key)
        decision = _APPROVAL_DECISIONS.pop(full, None)
        if decision is not None:
            return decision
        _PENDING_CARDS[full] = card
        return {
            "decision": "reject",
            "reason": "审批决议未提供（须先经审批卡请求注入）",
        }

    async def get_interrupt_payload(self, key: str) -> dict | None:
        return _PENDING_CARDS.get(self._key(key))


def prefill_approval_decision(
    scope: str | None,
    key: str,
    *,
    decision: str,
    reason: str = "",
    edited_content: Any = None,
) -> None:
    """审批决议预填：回合外宿主动作（启动引导回退等宿主纪律路径）经此
    注入决议，不弹卡不挂起——与 `approval.gate_card_request` 同键语义
    （`{scope}:{key}`），供审批发起方（补丁回退等）按同键消费。"""
    _APPROVAL_DECISIONS[StandaloneApprovalContext(scope)._key(key)] = {
        "decision": decision,
        "edited_content": edited_content,
        "reason": reason,
    }


def _parse_base_version(args: dict) -> int:
    """解析补丁 base_version（缺省 1）；非法输入显式报错而非裸 ValueError。

    裸 int() 对 "abc" 抛 ValueError，经引擎链路会变成不可读的 500，
    统一转为 GraphDefinitionError（与补丁链校验口径一致）。
    """
    raw = args.get("base_version")
    if raw is None or raw == "":
        return 1
    try:
        return int(raw)
    except (TypeError, ValueError):
        raise GraphDefinitionError(f"base_version 须为整数，收到: {raw!r}")


async def _propose_patch_coro(runtime: Any, args: dict) -> Any:
    """engine.propose_patch 的域逻辑（sync/async 两形态共用）。

    契约与 patch.apply 一致（SelfProposal.from_dict 全字段）；payload
    为 JSON 对象（Rust 执行器把扁平签名的 payload 文本还原为对象）。
    """
    from ink_engine.core.self_proposal import SelfProposal

    proposal = SelfProposal.from_dict(
        {
            "kind": args["kind"],
            "payload": args["payload"],
            "base_version": _parse_base_version(args),
            "rationale": args.get("rationale") or "",
            "meta": dict(args.get("meta") or {}),
        }
    )
    ctx = StandaloneApprovalContext(args.get("thread_id"))
    return await runtime.self_pipeline.apply(
        ctx, proposal, round_id=args.get("round_id")
    )


# ── 安全流水线的引擎侧适配（判定语义在 Rust；此处仅协议桥接）──

_CURRENT_TOOL: Any = None
try:
    import contextvars as _contextvars

    _CURRENT_TOOL = _contextvars.ContextVar("bridge_current_tool", default="")
except ImportError:  # pragma: no cover - contextvars 为内置模块，兜底防空
    _CURRENT_TOOL = None


def _tool_name() -> str:
    if _CURRENT_TOOL is None:
        return ""
    return _CURRENT_TOOL.get()


class CallbackSandbox:
    """声明式沙箱守卫的引擎侧协议适配：判定委托 Rust 回调。

    ToolPipeline 的沙箱环节只消费 ``(operation, target)`` 并需要知道
    调用方工具——工具名经上下文变量透传（本类执行前由流水线包装类
    设置），守卫语义（定义即权威）在 Rust 侧实现。
    """

    def guards_operation(self, operation: str) -> bool:
        verdict = _callback(
            "security.guards_operation", {"operation": str(operation)}
        )
        return bool(verdict.get("guarded", False))

    def validate(self, operation: str, target: str) -> str:
        from ink_engine.core.exceptions import SandboxViolation

        verdict = _callback(
            "security.sandbox_validate",
            {
                "tool": _tool_name(),
                "operation": str(operation),
                "target": str(target),
            },
        )
        if not verdict.get("pass", False):
            raise SandboxViolation(str(verdict.get("reason") or "沙箱守卫拒绝"))
        return target


_SECURITY_PIPELINE_CLASS: Any = None


def _security_pipeline_class():
    """安全流水线子类（懒构造）：当前工具名经上下文变量透传沙箱守卫。"""
    from ink_engine.core.tool_pipeline import ToolPipeline

    global _SECURITY_PIPELINE_CLASS
    if _SECURITY_PIPELINE_CLASS is None:

        class _SecurityPipeline(ToolPipeline):
            async def execute(self, ctx: Any, spec: Any, args: dict) -> Any:
                token = (
                    _CURRENT_TOOL.set(spec.name)
                    if _CURRENT_TOOL is not None
                    else None
                )
                try:
                    return await super().execute(ctx, spec, args)
                finally:
                    if token is not None:
                        _CURRENT_TOOL.reset(token)

        _SECURITY_PIPELINE_CLASS = _SecurityPipeline
    return _SECURITY_PIPELINE_CLASS


# ── 活跃态应用目标（补丁落链后的运行时生效钩子；引擎侧薄实现）──

class _UiLiveTarget:
    """UI 补丁生效：布局描述即时切入内省界面快照（渲染器数据源）。"""

    name = "inkling.ui"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        spec = payload.get("spec")
        if isinstance(spec, dict) and spec.get("root"):
            self._runtime.introspection_service._sources.ui_spec = spec


class _ThemeLiveTarget:
    """THEME 补丁生效：token 增量合并进界面快照的 theme 段。"""

    name = "inkling.theme"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return
        sources = self._runtime.introspection_service._sources
        spec = dict(sources.ui_spec or {})
        theme = dict(spec.get("theme") or {})
        theme.update(tokens)
        spec["theme"] = theme
        sources.ui_spec = spec


class _HarnessLiveTarget:
    """HARNESS 补丁生效：领域定义即时登记（同名覆盖 = 配置驱动）。"""

    name = "inkling.harness"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.harness import HarnessDefinition

        definition = payload.get("definition")
        if not isinstance(definition, dict):
            return
        parsed = HarnessDefinition.from_dict(definition)
        self._runtime.harness_registry.register(parsed)


class _KnowledgeLiveTarget:
    """KNOWLEDGE 补丁生效：条目即时 upsert 进知识集（调配器下回合可见）。"""

    name = "inkling.knowledge"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        _upsert_knowledge(self._runtime, payload.get("entry"))


class _RuleLiveTarget:
    """RULE 补丁生效：规则声明即时进知识集（kind=rule 条目）。"""

    name = "inkling.rule"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.knowledge_set import KIND_RULE, KnowledgeEntry

        rule = payload.get("rule")
        if not isinstance(rule, dict):
            return
        rule_id = str(rule.get("id") or payload.get("rule_id") or "rule")
        entry = KnowledgeEntry(
            id=rule_id,
            level="project",
            kind=KIND_RULE,
            data={"rule": rule},
            source="model",
            title=str(rule.get("message") or rule_id)[:80],
        )
        _register_patch_entry(self._runtime, entry.id)
        knowledge_set = self._runtime.knowledge_set
        if knowledge_set.get(entry.id) is None:
            knowledge_set.add(entry)
        else:
            knowledge_set.update(entry.id, data={"rule": rule}, title=entry.title)


class _ToolApplyTarget:
    """TOOL 补丁生效：声明式定义进注册表 + 统一工具表（挂载工具即刻可调）。"""

    name = "inkling.tool"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        spec = DeclarativeToolSpec.from_dict(payload)
        self._runtime.harness_registry.declarative.register_definition(spec)
        self._runtime.tool_registry[spec.name] = spec.to_spec()
        self._runtime.refresh_tool_index()


class _EventTypeApplyTarget:
    """EVENT_TYPE 补丁生效：事件类型注册表即时登记（新类型可渲染/校验）。"""

    name = "inkling.event_type"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.event_types import EventTypeSpec

        spec = EventTypeSpec.from_dict(payload)
        self._runtime.event_type_registry.register(spec)


class _CallbackApplyTarget:
    """回调委托型应用目标：apply 语义在 Rust 域层（经 JSON 回调执行）。"""

    def __init__(self, kind: str, callback: str) -> None:
        self.name = f"callback.{kind}"
        self._callback_name = callback

    async def apply(self, payload: dict, patch_id: int) -> None:
        response = _callback(self._callback_name, {
            "payload": payload,
            "patch_id": patch_id,
        })
        if not response.get("ok", True):
            raise RuntimeError(str(response.get("reason") or "活跃态应用失败"))


def _register_patch_entry(runtime: Any, entry_id: str) -> None:
    """登记补丁来源条目 id（回退恢复的撤销清单；宿主装配时初始化）。"""
    registry = getattr(runtime, "patch_entries", None)
    if registry is None:
        registry = set()
        runtime.patch_entries = registry
    registry.add(entry_id)


def _upsert_knowledge(runtime: Any, entry: Any) -> None:
    """知识条目 upsert（身份字段不可修正——整体字段替换除外，见目标语义）。"""
    from ink_engine.core.knowledge_set import KnowledgeEntry

    if not isinstance(entry, dict):
        return
    parsed = KnowledgeEntry.from_dict(entry)
    _register_patch_entry(runtime, parsed.id)
    knowledge_set = runtime.knowledge_set
    if knowledge_set.get(parsed.id) is None:
        knowledge_set.add(parsed)
    else:
        changes = {
            key: value
            for key, value in parsed.to_dict().items()
            if key not in ("id", "created_at")
        }
        knowledge_set.update(parsed.id, **changes)


class _CollectingTransport:
    """回合事件收集传输（试跑/观察场景：事件留驻本对象，随结果返回）。"""

    def __init__(self) -> None:
        self.events: list[dict] = []

    async def send(self, event: Any) -> None:
        self.events.append(_jsonable(event))


# ── llm_usage 帧桥接收集（引擎 3a 生产 → 指标快照消费的最后一跳）──

# 桥侧累计的 llm_usage 事件帧（每帧 prompt_tokens/completion_tokens，
# 引擎 UsageTrackingLLM 经 ``ctx.emit("llm_usage", frame)`` 生产）；
# metrics.snapshot 在调用方未显式传入 llm_usage 时聚合本清单（进程内
# 跨回合累计，与组装运行期统计同口径）。
_LLM_USAGE_FRAMES: list[dict[str, int]] = []


class _UsageFrameTransport:
    """事件传输包裹：llm_usage 事件帧收集 + 原样转发下游。

    回合入口（execute_round_to_reply / thread_resume / canary 试跑）
    用它包裹宿主传输——引擎生产的使用量帧进桥侧累计，供指标快照
    消费；其它事件零干预。
    """

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    async def send(self, event: Any) -> None:
        _collect_llm_usage_frame(event)
        await self._inner.send(event)


def _collect_llm_usage_frame(event: Any) -> None:
    """从事件对象提取 llm_usage 帧（协议不匹配 = 零操作）。"""
    if getattr(event, "type", None) != "llm_usage":
        return
    payload = getattr(event, "payload", None)
    if not isinstance(payload, dict):
        return
    frame: dict[str, int] = {}
    for key in ("prompt_tokens", "completion_tokens"):
        value = payload.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            frame[key] = value
    if frame:
        _LLM_USAGE_FRAMES.append(frame)


def _usage_collecting_transport(inner: Any) -> Any:
    """回合传输包裹工厂（llm_usage 帧收集；复用传入传输作为下游）。"""
    return _UsageFrameTransport(inner)


def _runtime_recipe_context(runtime: Any) -> Any:
    """按运行时装配产物构造图配方上下文（装配期调用，组件实时引用）。"""
    from ink_engine.core.assembly import AssemblyConfig
    from ink_engine.core.runtime import GraphRecipeContext

    return GraphRecipeContext(
        llm=None,
        tool_pipeline=runtime.tool_pipeline,
        tool_specs=runtime.collect_specs(),
        storage=runtime.storage,
        registries=runtime.graph_registries,
        system_events=runtime.event_type_registry.system_events(),
        assembly=AssemblyConfig(),
        assembly_sources=runtime._assembly_sources(),
    )


def _register_engine_core_ops() -> None:
    """引擎核心操作组（engine.* 基础：装配/记录/知识/声明式注册表）。"""

    @op_async("engine.chain_assemble")
    async def _chain_assemble(args: dict) -> Any:
        runtime = runtime_handle()
        assembled = await runtime.self_pipeline.chain.assemble()
        return _jsonable(assembled)

    @op_async("engine.rebuild")
    async def _rebuild(args: dict) -> Any:
        runtime = runtime_handle()
        await _refresh_max_tool_rounds(runtime)
        await runtime.rebuild_engine()
        return None

    @op_async("model.reload")
    async def _model_reload(args: dict) -> Any:
        """模型连接配置运行期重载：清空宿主解析缓存 + 引擎重建。

        设置页改模型连接后调用，使当前运行期引擎立即感知新配置
        （resolve_llm 按文件重读；无配置/解析失败回落离线桩）。
        """
        host = host_handle()
        reload = getattr(host, "reload_model_config", None)
        if reload is not None:
            reload()
        runtime = runtime_handle()
        await _refresh_max_tool_rounds(runtime)
        await runtime.rebuild_engine()
        return {"reloaded": True}

    @op_async("engine.abort_current_run")
    async def _abort_current_run(args: dict) -> Any:
        """中止在途 run（Rust 停止按钮经 steps.rs 异步通道调用）。

        契约：返回 ``{"aborted": bool}``——无在途 run = 幂等 False；
        中止 = 取消在途任务 + CANCELLED 终止快照落链（可续跑）。
        """
        runtime = runtime_handle()
        aborted = await runtime.abort_current_run()
        return {"aborted": aborted}

    @op_sync("engine.collect_specs")
    def _collect_specs(args: dict) -> Any:
        runtime = runtime_handle()
        return [_jsonable(spec) for spec in runtime.collect_specs()]

    @op_sync("engine.tools_manifest")
    def _tools_manifest(args: dict) -> Any:
        """全量工具清单（设置页「工具」管理面数据源）。

        与 collect_specs 分工：collect_specs 只回常驻必带集（进回合 tools
        参数），本 op 回全部工具（merged_specs）并附常驻标记/来源/声明式
        细节（端点/meta/mcp_server）——前端据此展示全部工具并勾选必带。
        """
        runtime = runtime_handle()
        baseline = set(runtime.baseline_names)
        introspection_names = {spec.name for spec in runtime.introspection_specs}
        self_names = {spec.name for spec in runtime.self_specs}
        harness = getattr(runtime, "harness_registry", None)
        declarative = getattr(harness, "declarative", None) if harness is not None else None
        definitions = getattr(declarative, "definitions", {}) or {}
        tools: list[dict] = []
        for spec in runtime.merged_specs():
            entry: dict = _jsonable(spec)
            entry["baseline"] = spec.name in baseline
            entry["tags"] = sorted(runtime.tool_tags(spec.name))
            if spec.name in introspection_names:
                entry["source"] = "introspection"
            elif spec.name in self_names:
                entry["source"] = "self"
            else:
                entry["source"] = "declarative"
            decl = definitions.get(spec.name)
            if decl is not None:
                entry["endpoint"] = getattr(decl, "endpoint", None)
                entry["endpoint"] = (
                    entry["endpoint"].value
                    if hasattr(entry["endpoint"], "value")
                    else entry["endpoint"]
                )
                entry["endpoint_config"] = getattr(decl, "endpoint_config", {}) or {}
                entry["meta"] = getattr(decl, "meta", {}) or {}
            tools.append(entry)
        return {"tools": tools, "baseline": list(runtime.baseline_names)}

    @op_sync("engine.baseline_get")
    def _baseline_get(args: dict) -> Any:
        runtime = runtime_handle()
        return {"tools": list(runtime.baseline_names)}

    @op_async("engine.baseline_set")
    async def _baseline_set(args: dict) -> Any:
        runtime = runtime_handle()
        names = args.get("tools")
        if not isinstance(names, list) or not all(
            isinstance(name, str) for name in names
        ):
            raise TypeError("常驻必带集 tools 须为字符串清单")
        applied = await runtime.set_baseline_names(names)
        return {"tools": list(applied)}

    @op_sync("engine.ui_components_get")
    def _ui_components_get(args: dict) -> Any:
        """出厂界面组件启停状态（组件 tab 数据源）。

        factory = 出厂白名单基线（配方 ui_allowed_components 未过滤全集）；
        disabled = 当前已停用出厂组件；active = 活跃白名单（factory - disabled）。
        与补丁链产物清单（components_manifest）分属两源，前端合并展示。
        """
        runtime = runtime_handle()
        factory = runtime.ui_factory_components
        disabled = runtime.ui_components_disabled
        return {
            "factory": list(factory),
            "disabled": list(disabled),
            "active": list(runtime.ui_allowed_components),
        }

    @op_async("engine.ui_components_set_disabled")
    async def _ui_components_set_disabled(args: dict) -> Any:
        runtime = runtime_handle()
        names = args.get("disabled")
        if not isinstance(names, list) or not all(
            isinstance(name, str) for name in names
        ):
            raise TypeError("停用组件集 disabled 须为字符串清单")
        applied = await runtime.set_ui_components_disabled(names)
        return {"disabled": list(applied)}

    @op_sync("engine.retrieval_source_names")
    def _retrieval_source_names(args: dict) -> Any:
        runtime = runtime_handle()
        return {"sources": list(retrieval_source_names(runtime))}

    @op_sync("engine.stub_llm_last_messages")
    def _stub_llm_last_messages(args: dict) -> Any:
        """离线模型桩最近一次调用的消息流（提示词生效断言/门禁核对）。"""
        llm = stub_llm_handle()
        return {"messages": getattr(llm, "last_messages", [])}

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
        runtime.refresh_tool_index()
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

def _register_patch_ops() -> None:
    # ── 补丁链（应用/回退/提案/目标注册）──

    @op_async("patch.apply")
    async def _patch_apply(args: dict) -> Any:
        from ink_engine.core.self_proposal import SelfProposal

        runtime = runtime_handle()
        proposal = SelfProposal.from_dict(
            {
                "kind": args["kind"],
                "payload": args["payload"],
                "base_version": _parse_base_version(args),
                "rationale": args.get("rationale") or "",
                "meta": args.get("meta") or {},
            }
        )
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        outcome = await runtime.self_pipeline.apply(
            ctx, proposal, round_id=args.get("round_id")
        )
        return {"outcome": _jsonable(outcome)}

    @op_async("patch.revert")
    async def _patch_revert(args: dict) -> Any:
        runtime = runtime_handle()
        patch_id = int(args["patch_id"])
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        decision = args.get("decision")
        if decision is not None:
            _APPROVAL_DECISIONS[
                f"{ctx._key('revert:' + str(patch_id))}"
            ] = {"decision": decision, "reason": args.get("reason")}
        outcome = await runtime.self_pipeline.revert(
            ctx,
            patch_id,
            reason=args.get("reason") or "",
            round_id=args.get("round_id"),
        )
        return {"outcome": _jsonable(outcome)}

    @op_async("patch.propose_knowledge")
    async def _patch_propose_knowledge(args: dict) -> Any:
        from ink_engine.core.self_proposal import PatchKind, SelfProposal

        runtime = runtime_handle()
        base_version = int(
            args.get("base_version")
            or await runtime.self_pipeline.chain.current_version()
        )
        proposal = SelfProposal(
            kind=PatchKind.KNOWLEDGE,
            payload={"entry": args["entry"]},
            base_version=base_version,
            rationale=args.get("rationale") or "",
            meta=dict(args.get("meta") or {}),
        )
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        decision = args.get("decision")
        if decision is not None:
            _APPROVAL_DECISIONS[ctx._key(runtime.self_pipeline.approval_key(PatchKind.KNOWLEDGE))] = {
                "decision": decision,
                "reason": args.get("reason"),
            }
        outcome = await runtime.self_pipeline.apply(
            ctx, proposal, round_id=args.get("round_id")
        )
        return {"outcome": _jsonable(outcome)}

    @op_sync("engine.propose_patch")
    def _engine_propose_patch(args: dict) -> Any:
        """自指演化提案（Rust 执行器经同步通道调用的断点修复）。

        壳侧 impls.rs 的 propose_patch 执行器经 ``call_engine_op``（同步
        通道）调用本 op——域逻辑（按类型校验/审批分级/补丁链落链）与
        ``patch.propose_knowledge`` 同管线（self_pipeline.apply）。参数
        契约：kind/payload（JSON 对象）/base_version/rationale，与
        SelfProposal.from_dict 对齐；引擎异步 API 经宿主循环派发执行。
        """
        outcome = _run_on_engine_loop(
            lambda: _propose_patch_coro(runtime_handle(), args)
        )
        return {"outcome": _jsonable(outcome)}

    @op_async("engine.propose_patch")
    async def _engine_propose_patch_async(args: dict) -> Any:
        """异步形态（未来调用方切 call_engine_op_async 时直接可用）。"""
        outcome = await _propose_patch_coro(runtime_handle(), args)
        return {"outcome": _jsonable(outcome)}

    @op_sync("patch.apply_target_register")
    def _patch_apply_target_register(args: dict) -> Any:
        from ink_engine.core.self_proposal import PatchKind

        runtime = runtime_handle()
        kind = args["kind"]
        callback = args.get("callback")
        if callback:
            target = _CallbackApplyTarget(kind, callback)
        elif kind == "tool":
            target = _ToolApplyTarget(runtime)
        elif kind == "event_type":
            target = _EventTypeApplyTarget(runtime)
        else:
            raise ValueError(
                f"未知活跃态目标类型: {kind}（callback 受托或 tool/event_type 引擎内置）"
            )
        runtime.self_pipeline.register_target(PatchKind(kind), target)
        return {"registered": kind, "target": target.name}

    @op_sync("patch.register_live_targets")
    def _patch_register_live_targets(args: dict) -> Any:
        from ink_engine.core.self_proposal import PatchKind

        runtime = runtime_handle()
        targets = {
            PatchKind.UI: _UiLiveTarget(runtime),
            PatchKind.THEME: _ThemeLiveTarget(runtime),
            PatchKind.HARNESS: _HarnessLiveTarget(runtime),
            PatchKind.RULE: _RuleLiveTarget(runtime),
            PatchKind.KNOWLEDGE: _KnowledgeLiveTarget(runtime),
        }
        for kind, target in targets.items():
            runtime.self_pipeline.register_target(kind, target)
        return {"registered": [target.name for target in targets.values()]}

def _register_skill_ops() -> None:
    # ── 技能结晶 / 技能市场 ──

    @op_async("skill.list")
    async def _skill_list(args: dict) -> Any:
        """列出已结晶技能（按名+版本升序；domain 可选过滤）。"""
        runtime = runtime_handle()
        store = getattr(runtime, "skill_store", None)
        if store is None:
            return {"skills": []}
        entries = await store.list(args.get("domain"))
        return {"skills": [_jsonable(e) for e in entries]}

    @op_async("skill.export")
    async def _skill_export(args: dict) -> Any:
        """导出技能为可分享 JSON（导出格式与市场导入同构）。

        dest 给定时落盘文件，返回结构含导出路径；缺失技能 = found=False。
        """
        from ink_engine.core.skill_crystal import export_skill

        runtime = runtime_handle()
        store = getattr(runtime, "skill_store", None)
        if store is None:
            raise RuntimeError("技能存储未装配（技能结晶未启用）")
        name = args["name"]
        entry = await store.get(name)
        if entry is None:
            return {"found": False, "skill": None}
        payload = export_skill(entry, dest=args.get("dest"))
        return {"found": True, "skill": payload}

    @op_async("skill.delete")
    async def _skill_delete(args: dict) -> Any:
        """删除某技能全部版本（派生数据可重建）。"""
        runtime = runtime_handle()
        store = getattr(runtime, "skill_store", None)
        if store is None:
            return {"deleted": False}
        removed = await store.delete(args["name"])
        return {"deleted": removed}

    @op_async("skill.market_list")
    async def _skill_market_list(args: dict) -> Any:
        """浏览技能市场目录（候选清单，不预装）。"""
        runtime = runtime_handle()
        market = getattr(runtime, "skill_market", None)
        if market is None:
            return {"entries": [], "premounted": False, "mount_policy": {}}
        return {
            "entries": market.list_entries(),
            "premounted": market.premounted,
            "mount_policy": market.mount_policy,
        }

    @op_async("skill.market_install")
    async def _skill_market_install(args: dict) -> Any:
        """安装市场技能（目录取条目 → vetting → 审批 → 补丁链落链）。

        decision 预填（accept/reject）走 StandaloneApprovalContext 同键语义；
        缺省 = 拒绝（fail-closed）。落链同时写入本地技能存储。
        """
        from inkling_host.skill_market import SkillMarketService

        runtime = runtime_handle()
        market = getattr(runtime, "skill_market", None)
        if market is None or not isinstance(market, SkillMarketService):
            raise RuntimeError("技能市场未装配")
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        decision = args.get("decision")
        if decision is not None:
            _APPROVAL_DECISIONS[
                ctx._key("skill_install:" + str(args["skill_id"]))
            ] = {"decision": decision, "reason": args.get("reason")}
        outcome = await market.propose_install(
            ctx, args["skill_id"], round_id=args.get("round_id")
        )
        return outcome.to_dict()

def _register_pipeline_ops() -> None:
    # ── 工具表/流水线/审批──

    @op_sync("engine.tool_registry_remove")
    def _tool_registry_remove(args: dict) -> Any:
        runtime = runtime_handle()
        removed = runtime.tool_registry.pop(args["name"], None)
        if removed is not None:
            runtime.refresh_tool_index()
        return {"removed": removed is not None}

    @op_sync("pipeline.install_security_pipeline")
    def _install_security_pipeline(args: dict) -> Any:
        from ink_engine.core.permissions import DENY, PermissionGate

        runtime = runtime_handle()
        old = runtime.tool_pipeline
        pipeline = _security_pipeline_class()(
            gate=PermissionGate(
                default_policy=DENY,
                review_tier=lambda tool: bool(
                    _callback(
                        "security.gating_tier", {"tool": str(tool)}
                    ).get("review", False)
                ),
            ),
            extractor=old.extractor,
            executor=old.executor,
            sandboxes=(CallbackSandbox(),),
            guards=tuple(getattr(old, "guards", ()) or ()),
            audit=getattr(old, "audit", None),
            max_result_chars=getattr(old, "max_result_chars", 100_000),
            allow_unchecked=getattr(old, "allow_unchecked", False),
            trace_sink=getattr(old, "trace_sink", None),
        )
        runtime.tool_pipeline = pipeline
        return {"installed": True}

    @op_async("approval.gate_card_request")
    async def _gate_card_request(args: dict) -> Any:
        from ink_engine.core.approval import approve_before_execute

        runtime = runtime_handle()
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        key = str(args["key"])
        decision = args.get("decision")
        if decision is not None:
            _APPROVAL_DECISIONS[ctx._key(key)] = {
                "decision": decision,
                "edited_content": args.get("edited_content"),
                "reason": args.get("reason"),
            }
        pipeline = runtime.self_pipeline
        policy = getattr(pipeline, "_policy", None)
        approval = await approve_before_execute(
            ctx,
            key,
            args.get("action") or {},
            payload=args.get("payload"),
            policy=policy,
        )
        return {
            "decision": approval.decision,
            "reason": approval.reason,
            "source": approval.source,
        }

def _register_graph_ops() -> None:
    # ── 图配方（节点类型登记 + 回合图构造）──

    @op_sync("security.auto_approve_set")
    def _auto_approve_set(args: dict) -> Any:
        """自动审批配置（用户预授权：只跳过人审弹卡，安全环节不动）。

        登记边界在安全域内硬拒（仅声明 auto_approvable 的只读感知/
        测试构建类工具可登记）；边界外请求 = 显式失败，持久化层
        不落盘。
        """
        from inkling_host.security_domain import SecurityDomain

        host = host_handle()
        security = getattr(host, "security", None)
        if security is None:
            raise RuntimeError("安全域未装配（先经 boot 装配）")
        tools = args.get("tools") or []
        if not isinstance(tools, (list, tuple)):
            raise ValueError("自动审批清单须为列表")
        security.set_auto_approve([str(t) for t in tools], bool(args.get("all_review")))
        return {"applied": True}

    @op_sync("security.tier_overrides_set")
    def _tier_overrides_set(args: dict) -> Any:
        """逐工具档位覆盖（权限矩阵写面：工具 tab 档位编辑）。

        安全域校验（deny 出厂档不可覆盖 / 合法值白名单）失败 = 显式失败，
        持久化层不落盘；成功 = 门禁按覆盖档生效 + 随能力记录持久化，
        启动经 restore 装载。
        """
        from inkling_host.security_domain import (
            AUTO_APPROVE_COLLECTION,
            AUTO_APPROVE_KEY,
        )

        host = host_handle()
        security = getattr(host, "security", None)
        if security is None:
            raise RuntimeError("安全域未装配（先经 boot 装配）")
        raw = args.get("overrides") or {}
        if not isinstance(raw, dict):
            raise ValueError("档位覆盖须为对象（工具名 → allow/review/deny）")
        overrides = {str(k): str(v) for k, v in raw.items()}
        security.set_tier_overrides(overrides)
        applied = security.tier_overrides()

        async def _persist() -> None:
            runtime = runtime_handle()
            record = await runtime.storage.get_record(
                AUTO_APPROVE_COLLECTION, AUTO_APPROVE_KEY
            )
            if not isinstance(record, dict):
                record = {}
            record["tier_overrides"] = applied
            await runtime.storage.put_record(
                AUTO_APPROVE_COLLECTION, AUTO_APPROVE_KEY, record
            )

        _run_on_engine_loop(_persist)
        return {"applied": True, "overrides": applied}

    @op_async("workspace.authorize_headless")
    async def _workspace_authorize_headless(args: dict) -> Any:
        """headless 显式工作区授权：调用方声明已获授权（等同 CLI --approve）。

        生效路径与设置页授权卡一致（记录落 storage + 文件工具重注册 +
        引擎重建，重启后经 load 恢复）；headless 无审批交互面，审批由
        调用方显式声明。
        """
        from pathlib import Path

        host = host_handle()
        workspaces = getattr(host, "workspaces", None)
        if workspaces is None:
            raise RuntimeError("工作区授权器未装配（先经 boot 装配）")
        root = Path(str(args["root"]))
        if not root.exists() or not root.is_dir():
            return {"ok": False, "status": "invalid_root", "error": f"工作区不可达: {root}"}
        return await workspaces.authorize_headless(
            root, reason=str(args.get("reason") or "")
        )

    @op_sync("graph.register_node_types")
    def _graph_register_node_types(args: dict) -> Any:
        from inkling_host.graph_recipe import (
            register_node_types,
            workflow_spec_from_data,
        )

        runtime = runtime_handle()
        workflow = workflow_spec_from_data(args["workflow"])
        register_node_types(_runtime_recipe_context(runtime), workflow)
        return {"registered": True}

    @op_sync("graph.build_round_graph")
    def _graph_build_round_graph(args: dict) -> Any:
        from inkling_host.graph_recipe import build_round_graph

        runtime = runtime_handle()
        graph = build_round_graph(
            _runtime_recipe_context(runtime),
            graph_data=args["graph"],
            workflow_data=args["workflow"],
        )
        return {"graph": graph.to_dict()}

    # ── 架构快照 op（W3.1 图快照 / W3.2 池快照 / W3.3 边证据快照）──

    @op_sync("graph.snapshot")
    def _graph_snapshot(args: dict) -> Any:
        """图快照 op：内省 snapshot_graph → 前端 GraphSnapshot 映射。

        映射契约：
        - version = 图内容指纹（digest；不可用时取链版本）
        - nodes = [{id, type, label}]（id = 节点名，type = 类型名，label = 节点名）
        - edges = [{from, to}]（条件边标 condition 字段）
        - patchChain = 补丁链摘要（当前版本 / 补丁数）

        无图 / 不可序列化 = 显式空态标记（不白屏）：degraded=true + 空 nodes/edges。
        """
        try:
            runtime = runtime_handle()
        except RuntimeError:
            return {"version": "none", "nodes": [], "edges": [], "patchChain": {"version": "none", "patch_count": 0}, "degraded": True}
        introspection = runtime.introspection_service
        snapshot = introspection.snapshot_graph()
        graph_data = snapshot.get("graph")
        digest = snapshot.get("digest")

        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        degraded = False
        version = digest

        if graph_data is None:
            degraded = True
        else:
            degraded = bool(graph_data.get("degraded", False))
            nodes = [
                {"id": name, "type": info.get("type", "unknown"), "label": name}
                for name, info in (graph_data.get("nodes") or {}).items()
            ]
            for source, edge_list in (graph_data.get("edges") or {}).items():
                for edge in edge_list:
                    e: dict[str, Any] = {"from": source, "to": edge.get("target", "")}
                    condition = edge.get("condition")
                    if condition is not None and condition != "function":
                        e["condition"] = condition
                    edges.append(e)
            if not version:
                version = graph_data.get("name")

        # 补丁链摘要
        patch_chain: dict[str, Any] = {"version": version, "patch_count": 0}
        chain = getattr(runtime, "self_pipeline", None)
        if chain is not None:
            try:
                patch_chain["patch_count"] = len(
                    getattr(chain.chain, "patches", []) or ()
                )
                if patch_chain["version"] is None:
                    patch_chain["version"] = int(
                        getattr(chain.chain, "current_version", lambda: 0)()
                    )
            except Exception:
                pass

        result: dict[str, Any] = {
            "version": version if version is not None else "none",
            "nodes": nodes,
            "edges": edges,
            "patchChain": patch_chain,
        }
        if degraded:
            result["degraded"] = True
        return result

    @op_async("graph.instance_snapshot")
    async def _graph_instance_snapshot(args: dict) -> Any:
        """实例图快照 op：最近回合实际执行图 + 节点执行态（只读）。

        图结构 = 当前回合图（与 graph.snapshot 同源 introspection）；节点
        执行态从执行日志按 thread_id 归集——事件顶层 node 字段标记执行过的
        节点，error 事件标记 failed，回合未发 end = running。无 storage /
        该线程无事件 = 空态（round_id=None + 空 node_status，不白屏）。
        """
        try:
            runtime = runtime_handle()
        except RuntimeError:
            return {
                "round_id": None,
                "graph": {"nodes": [], "edges": []},
                "node_status": {},
                "degraded": True,
            }
        thread_id = args.get("thread_id") or "-"

        # 图结构（复用 introspection 当前回合图数据源）
        nodes: list[dict[str, Any]] = []
        edges: list[dict[str, Any]] = []
        degraded = False
        introspection = getattr(runtime, "introspection_service", None)
        if introspection is not None:
            graph_data = introspection.snapshot_graph().get("graph")
            if graph_data is not None:
                degraded = bool(graph_data.get("degraded", False))
                nodes = [
                    {"id": name, "type": info.get("type", "unknown"), "label": name}
                    for name, info in (graph_data.get("nodes") or {}).items()
                ]
                for source, edge_list in (graph_data.get("edges") or {}).items():
                    for edge in edge_list:
                        edges.append({"from": source, "to": edge.get("target", "")})

        # 节点执行态：按 thread_id 从执行日志归集最近一回合
        node_status: dict[str, str] = {}
        round_id: str | None = None
        storage = getattr(runtime, "storage", None)
        if storage is not None:
            try:
                events = await storage.events_after(thread_id, 0)
            except Exception:
                events = []
            latest_round: str | None = None
            for event in events:
                if event.round_id:
                    latest_round = event.round_id
            if latest_round:
                round_id = latest_round
                anchor = latest_round or "-"
                round_events = [e for e in events if (e.round_id or "-") == anchor]
                visited: set[str] = set()
                failed: set[str] = set()
                ended = any(e.type == "end" for e in round_events)
                for event in round_events:
                    node = event.node
                    if not node:
                        continue
                    visited.add(node)
                    if event.type == "error":
                        failed.add(node)
                for node in visited:
                    node_status[node] = (
                        "failed" if node in failed else ("success" if ended else "running")
                    )

        result = {
            "round_id": round_id,
            "graph": {"nodes": nodes, "edges": edges},
            "node_status": node_status,
        }
        if degraded:
            result["degraded"] = True
        return result

    @op_sync("pool.snapshot")
    def _pool_snapshot(args: dict) -> Any:
        """池快照 op：PoolNodeSnapshot 列表 + GovernanceVerdict 最近记录。

        返回形态：{pool_nodes: [...], governance_log: [...]}。
        无治理登记器 = 显式空态（不白屏）。
        """
        runtime = runtime_handle()
        governance = getattr(runtime, "pool_governance", None)
        pool_nodes: list[dict[str, Any]] = []
        gov_log: list[dict[str, Any]] = []

        if governance is not None:
            gov_log = [_jsonable(r) for r in governance.log]
            # 池快照结点：从注册表取契约字段（同源 pool_nodes_from_registry）
            registries = getattr(runtime, "graph_registries", None)
            if registries is not None and hasattr(registries, "nodes"):
                try:
                    from ink_engine.core.pool_governance import pool_nodes_from_registry

                    pool_nodes = [
                        _jsonable(n) for n in pool_nodes_from_registry(registries.nodes)
                    ]
                except Exception:
                    pool_nodes = []

        return {"pool_nodes": pool_nodes, "governance_log": gov_log}

    @op_sync("pool.evaluate")
    def _pool_evaluate(args: dict) -> Any:
        """池治理判定 op：对提案做四规则判定并登记（纯规则+登记不执行）。

        输入：proposal（node_id/fields）+ snapshot（pool_count/used_this_week/pool_nodes）。
        返回：GovernanceVerdict dict。无治理登记器 = 显式空态。
        """
        runtime = runtime_handle()
        governance = getattr(runtime, "pool_governance", None)
        if governance is None:
            return {"verdict": "none", "reasons": [], "budget_remaining": 0}
        proposal = args.get("proposal") or {}
        snapshot = args.get("snapshot") or {}
        verdict = governance.evaluate(proposal, snapshot)
        return _jsonable(verdict)

    @op_async("edge_evidence.list")
    async def _edge_evidence_list(args: dict) -> Any:
        """边证据快照 op：按域枚举边证据 + 评分分量（信任档观察/常规/转正）。

        返回形态：{domain, edges: [{src_type, dst_type, success_count, fail_count,
        tier, score, p, weight, decay, tau, avg_cost, policy, origin}], ...}。
        无存储 = 显式空态。
        """
        try:
            runtime = runtime_handle()
        except RuntimeError:
            return {"domain": args.get("domain"), "edges": [], "total_candidates": 0, "evidenced_edges": 0, "cold_start_index": 0.0, "exploration_mode": True}
        domain = args.get("domain")
        store = _safe_attr_call(runtime, "edge_evidence_store")
        if store is None:
            return {"domain": domain, "edges": [], "exploration_index": None}
        from ink_engine.core.edge_evidence import (
            cold_start_index,
            edge_score,
            is_exploration_mode,
        )

        edge_list = await store.list_edges(domain)
        edges: list[dict[str, Any]] = []
        for ev in edge_list:
            score = edge_score(ev)
            edges.append({
                "src_type": ev.src_type,
                "dst_type": ev.dst_type,
                "success_count": ev.success_count,
                "fail_count": ev.fail_count,
                "tier": score.tier,
                "score": score.score,
                "p": score.p,
                "weight": score.weight,
                "decay": score.decay,
                "tau": score.tau,
                "avg_cost": ev.avg_cost,
                "policy": ev.policy,
                "origin": ev.origin,
            })
        # 冷启动探索指数
        total_candidates = await store.evidence_count(domain)
        evidenced = len([e for e in edge_list if e.success_count + e.fail_count > 0])
        index = cold_start_index(evidenced, total_candidates)
        return {
            "domain": domain,
            "edges": edges,
            "total_candidates": total_candidates,
            "evidenced_edges": evidenced,
            "cold_start_index": index,
            "exploration_mode": is_exploration_mode(index),
        }

    @op_async("edge_evidence.update")
    async def _edge_evidence_update(args: dict) -> Any:
        """边证据更新 op：仅信任档降级/停用语义（自动晋级纯算法不开放）。

        契约：target_tier ∈ {observing, regular}（只降级不晋级）；
        update 只做信任档降级/停用，不改计数细节（计数由运行期归集）。
        """
        runtime = runtime_handle()
        store = _safe_attr_call(runtime, "edge_evidence_store")
        if store is None:
            raise RuntimeError("边证据存储未装配")
        key_data = args["key"]
        from ink_engine.core.edge_evidence import EdgeKey, downgrade_edge_tier

        key = EdgeKey.from_dict(key_data)
        target_tier = args.get("target_tier", "observing")
        storage = getattr(runtime, "storage", None)
        result = await downgrade_edge_tier(
            store, key,
            target_tier=target_tier,
            storage=storage,
            reason=str(args.get("reason") or "桥 op 信任档降级"),
        )
        return result

def _register_mcp_ops() -> None:
    # ── MCP 挂载（连接/工具导入/断开）──

    @op_sync("mcp.builtin_registry")
    def _mcp_builtin_registry(args: dict) -> Any:
        """内置 server 注册表（tools.json mcp 工具 server_id 的权威定义）。

        返回 server_id → 传输形态/来源/签名（连接位由宿主按环境填充后
        经 ``mcp.builtin_connect`` 建立真实连接）。
        """
        from ink_engine.core.mcp_client import BUILTIN_MCP_SERVERS

        return {
            "servers": [
                {
                    "server_id": server_id,
                    "transport": config.transport.value,
                    "source": config.source.value,
                    "signature": config.signature,
                }
                for server_id, config in BUILTIN_MCP_SERVERS.items()
            ]
        }

    @op_async("mcp.builtin_connect")
    async def _mcp_builtin_connect(args: dict) -> Any:
        """连接内置 server（tools.json 声明 server 的真实连接入口）。

        server_id 须在注册表内；连接位（stdio 的 command/args、内存
        传输的 server_factory 等）随 args 透传，注册表字段不可覆盖。
        """
        runtime = runtime_handle()
        overrides = dict(args.get("overrides") or {})
        await runtime.mcp_manager.connect_builtin(args["server_id"], **overrides)
        return {"connected": True, "server_id": args["server_id"]}

    @op_async("mcp.connect")
    async def _mcp_connect(args: dict) -> Any:
        from ink_engine.core.mcp_client import McpServerConfig

        runtime = runtime_handle()
        config = McpServerConfig.from_dict(args["config"])
        await runtime.mcp_manager.connect(config)
        return {"connected": True, "server_id": config.id}

    @op_async("mcp.import_tools")
    async def _mcp_import_tools(args: dict) -> Any:
        runtime = runtime_handle()
        specs = await runtime.mcp_manager.import_tools(args["server_id"])
        return {"tools": [_jsonable(spec) for spec in specs]}

    @op_async("mcp.disconnect")
    async def _mcp_disconnect(args: dict) -> Any:
        runtime = runtime_handle()
        closed = await runtime.mcp_manager.disconnect(args["server_id"])
        return {"closed": closed}

    def _mount_service() -> Any:
        """当前挂载服务（host 装配期挂在 runtime 上；未装配显式报错）。"""
        runtime = runtime_handle()
        service = getattr(runtime, "mcp_mount_service", None)
        if service is None:
            raise RuntimeError("MCP 挂载服务未装配")
        return service

    def _mount_outcome(outcome: Any) -> dict:
        """MountOutcome → JSON 可序列化形态。"""
        return {
            "ok": outcome.ok,
            "server_id": outcome.server_id,
            "patch_ids": list(outcome.patch_ids),
            "tool_names": list(outcome.tool_names),
            "status": outcome.status,
            "error": outcome.error,
        }

    @op_async("mcp.market_status")
    async def _mcp_market_status(args: dict) -> Any:
        """市场 + 挂载状态（设置「连接」/「市场」视图数据源）。"""
        return _mount_service().status()

    @op_async("mcp.market_mount")
    async def _mcp_market_mount(args: dict) -> Any:
        """市场一键挂载（手动挂载：免挂载审批卡，逐工具自动放行）。"""
        from inkling_host.mcp_service import MountOutcome

        service = _mount_service()
        server_id = str(args.get("server_id") or "")
        try:
            outcome = await service.propose_mount(
                None, server_id, require_approval=False
            )
        except Exception as exc:
            outcome = MountOutcome(
                ok=False, server_id=server_id,
                status="mount_failed", error=str(exc),
            )
        return _mount_outcome(outcome)

    @op_async("mcp.market_unmount")
    async def _mcp_market_unmount(args: dict) -> Any:
        """市场服务取消挂载（补丁链回退 + 会话断开）。"""
        service = _mount_service()
        server_id = str(args.get("server_id") or "")
        outcome = await service.unmount(None, server_id)
        return _mount_outcome(outcome)

    @op_async("mcp.market_preview")
    async def _mcp_market_preview(args: dict) -> Any:
        """市场摄入预览（拉取 + vetting + 摘要；不落注册表）。"""
        return await _mount_service().preview_market(str(args.get("link") or ""))

    @op_async("mcp.market_add")
    async def _mcp_market_add(args: dict) -> Any:
        """添加市场（外部目录摄入）：预览确认后落注册表持久化。"""
        from inkling_host.mcp_service import McpMountError

        service = _mount_service()
        try:
            summary = await service.add_market(str(args.get("link") or ""))
            return {"ok": True, "market": summary}
        except McpMountError as exc:
            return {"ok": False, "error": str(exc)}

    @op_async("mcp.market_remove")
    async def _mcp_market_remove(args: dict) -> Any:
        """删除市场（内置不可删；级联卸载其下服务）。"""
        from inkling_host.mcp_service import McpMountError

        service = _mount_service()
        try:
            result = await service.remove_market(str(args.get("market_id") or ""))
            return {"ok": True, **result}
        except McpMountError as exc:
            return {"ok": False, "error": str(exc)}

    @op_sync("engine.mcp_process_registry")
    def _mcp_process_registry(args: dict) -> Any:
        runtime = runtime_handle()
        manager = runtime.mcp_manager
        rows: list[dict] = []
        for server_id in manager.list_servers():
            handle = manager._sessions.get(server_id)
            row: dict = {
                "server_id": server_id,
                "tools": len(manager.imported_tools(server_id)),
            }
            if handle is not None:
                row["supervised"] = callable(getattr(handle, "health_check", None))
                if row["supervised"]:
                    failures = getattr(handle, "consecutive_failures", None)
                    row["consecutive_failures"] = (
                        failures() if callable(failures) else 0
                    )
                    broke = getattr(handle, "circuit_open", None)
                    row["circuit_open"] = broke() if callable(broke) else False
            rows.append(row)
        return {"servers": rows}

def _register_thread_ops() -> None:
    # ── 会话/版本链（记录删除、会话删除、分支/续跑/回退）──

    @op_async("engine.records_delete")
    async def _records_delete(args: dict) -> Any:
        import time as _time

        runtime = runtime_handle()
        existing = await runtime.storage.get_record(
            args["collection"], args["key"]
        )
        data = dict(existing or {})
        data["deleted"] = True
        data["deleted_at"] = _time.time()
        await runtime.storage.put_record(args["collection"], args["key"], data)
        return {"deleted": True}

    @op_async("engine.storage_delete_thread")
    async def _storage_delete_thread(args: dict) -> Any:
        runtime = runtime_handle()
        storage = runtime.storage
        thread_id = args["thread_id"]
        links = await storage.chain_index(thread_id)
        ids = [link.checkpoint_id for link in links]
        removed = await storage.delete_checkpoints(thread_id, ids)
        latest = await storage.latest_event_seq(thread_id)
        trimmed = 0
        if latest:
            trimmed = await storage.trim_events(thread_id, latest)
        return {
            "checkpoints_removed": removed,
            "events_trimmed": trimmed,
        }

    @op_async("engine.thread_branch")
    async def _thread_branch(args: dict) -> Any:
        from ink_engine.core.storage import CheckpointRecord

        runtime = runtime_handle()
        storage = runtime.storage
        thread_id = args["thread_id"]
        parent = await storage.get_checkpoint(int(args["parent_id"]))
        if parent is None:
            raise RuntimeError(f"分支锚点检查点不存在: {args['parent_id']}")
        patch = args.get("state_patch") or {}
        merged = dict(parent.state)
        merged.update(patch)
        await storage.truncate_events(thread_id, parent.event_seq)
        created = await storage.put_checkpoint(
            CheckpointRecord(
                checkpoint_id=0,
                thread_id=thread_id,
                node=None,
                state=merged,
                parent_id=parent.checkpoint_id,
                event_seq=parent.event_seq,
                graph_version=parent.graph_version,
                plan=parent.plan,
            ),
            fork=True,
        )
        return {"checkpoint_id": created.checkpoint_id}

    @op_async("engine.thread_resume")
    async def _thread_resume(args: dict) -> Any:
        import uuid as _uuid

        runtime = runtime_handle()
        storage = runtime.storage
        anchor = await storage.get_checkpoint(int(args["checkpoint_id"]))
        if anchor is None:
            raise RuntimeError(f"续跑锚点检查点不存在: {args['checkpoint_id']}")
        result = await runtime.engine.ainvoke(
            {"input": args.get("input") or ""},
            thread_id=args["thread_id"],
            round_id=args.get("round_id") or _uuid.uuid4().hex,
            resume_from=anchor.checkpoint_id,
            inject=args.get("inject") or None,
            transports=[_usage_collecting_transport(host_handle().build_transport())],
        )
        return {
            "reason": getattr(result, "reason", None),
            "state": dict(getattr(result, "state", {}) or {}),
            "error": getattr(result, "error", None),
        }

    @op_async("engine.thread_revert")
    async def _thread_revert(args: dict) -> Any:
        runtime = runtime_handle()
        storage = runtime.storage
        thread_id = args["thread_id"]
        target = int(args["target_id"])
        links = await storage.chain_index(thread_id)
        ids = [
            link.checkpoint_id
            for link in links
            if link.checkpoint_id > target
        ]
        removed = await storage.delete_checkpoints(thread_id, ids)
        return {"reverted_to": target, "checkpoints_removed": removed}

    @op_async("engine.thread_latest_checkpoint")
    async def _thread_latest_checkpoint(args: dict) -> Any:
        runtime = runtime_handle()
        latest = await runtime.storage.get_latest_checkpoint(args["thread_id"])
        return latest.to_dict() if latest is not None else None

    @op_async("engine.thread_chain_index")
    async def _thread_chain_index(args: dict) -> Any:
        runtime = runtime_handle()
        links = await runtime.storage.chain_index(args["thread_id"])
        return [
            {
                "checkpoint_id": link.checkpoint_id,
                "parent_id": link.parent_id,
                "event_seq": link.event_seq,
                "reason": link.reason,
            }
            for link in links
        ]

def _register_memory_ops() -> None:
    # ── 记忆/检索──

    @op_async("engine.memory_query")
    async def _memory_query(args: dict) -> Any:
        from ink_engine.core.memory import MemoryQuery
        from inkling_host.assembly_domain import build_memory_store

        runtime = runtime_handle()
        store = build_memory_store(runtime.storage)
        rows = await store.query(
            MemoryQuery(
                namespace=args.get("namespace"),
                kind=args.get("kind"),
                limit=args.get("limit"),
            )
        )
        return {"entries": [_jsonable(entry) for entry in rows]}

    @op_async("engine.storage_snapshot")
    async def _storage_snapshot(args: dict) -> Any:
        runtime = runtime_handle()
        storage = getattr(runtime.storage, "inner", runtime.storage)
        await storage.snapshot(args["dest"])
        return {"snapshotted": True}

    @op_async("engine.storage_restore")
    async def _storage_restore(args: dict) -> Any:
        runtime = runtime_handle()
        storage = getattr(runtime.storage, "inner", runtime.storage)
        await storage.restore(args["src"])
        return {"restored": True}

    @op_async("engine.chain_reset_to_base")
    async def _chain_reset_to_base(args: dict) -> Any:
        """出厂重置：补丁链清空回基线（宿主纪律操作，审计留痕）。

        清空 = 链记录整体写回空补丁（经机制豁免上下文——演化资产的
        唯一写入路径是自指应用管线，出厂重置是宿主显式纪律操作，与
        管线写入同语义）；被清空的补丁数随审计记录保留（恢复动作
        可查，旧链数据在审计中完整留痕）。
        """
        import time as _time
        import uuid as _uuid

        runtime = runtime_handle()
        record = await runtime.storage.get_record("set_patch_chain", "chain")
        patches = len((record or {}).get("patches") or [])
        async with runtime.storage.allow_mechanism("set_patch_chain"):
            await runtime.storage.put_record(
                "set_patch_chain", "chain", {"base": {}, "patches": []}
            )
        async with runtime.storage.allow_mechanism("set_audit"):
            await runtime.storage.put_record(
                "set_audit",
                f"factory-reset-{_uuid.uuid4().hex[:12]}",
                {
                    "kind": "factory_reset",
                    "reason": args.get("reason") or "出厂重置：清空补丁链至基线",
                    "patches_cleared": patches,
                    "created_at": _time.time(),
                },
            )
        return {"cleared_patches": patches}

    # ── 记忆（MemoryData 契约：namespaces 分组计数 + entries 映射）──

    @op_async("memory.list")
    async def _memory_list(args: dict) -> Any:
        from ink_engine.core.memory import MemoryQuery
        from inkling_host.assembly_domain import build_memory_store

        runtime = runtime_handle()
        store = build_memory_store(runtime.storage)
        rows = await store.query(MemoryQuery(namespace=args.get("namespace")))
        entries: list[dict] = []
        namespaces: dict[str, int] = {}
        for entry in rows:
            ns = entry.namespace or ""
            namespaces[ns] = namespaces.get(ns, 0) + 1
            entries.append({
                "id": entry.id,
                "namespace": entry.namespace,
                "kind": entry.kind,
                "title": entry.title or "",
                "content": entry.content,
                "source": entry.source,
                "credibility": entry.weight,
                "expires_at": entry.expires_at,
                # 引擎无 invalid 概念（失效 = expires_at 过期），前端语义暂恒 False
                "invalid": False,
                "created_at": entry.created_at,
            })
        return _jsonable({
            "namespaces": [
                {"name": name, "count": count}
                for name, count in sorted(namespaces.items())
            ],
            "entries": entries,
        })

    @op_async("memory.invalidate")
    async def _memory_invalidate(args: dict) -> Any:
        from inkling_host.assembly_domain import build_memory_store

        runtime = runtime_handle()
        store = build_memory_store(runtime.storage)
        ok = await store.update(args["id"], {"expires_at": 0})
        return {"id": args["id"], "invalidated": bool(ok)}

    @op_async("memory.update_frontmatter")
    async def _memory_update_frontmatter(args: dict) -> Any:
        from inkling_host.assembly_domain import build_memory_store

        runtime = runtime_handle()
        store = build_memory_store(runtime.storage)
        frontmatter = args.get("frontmatter") or {}
        if not isinstance(frontmatter, dict):
            frontmatter = {}
        ok = await store.update(args["id"], frontmatter)
        return {"id": args["id"], "updated": bool(ok)}

def _register_live_ops() -> None:
    # ── 活跃态生效（界面/主题/harness/知识/试跑/路由轻调用）──

    @op_sync("engine.introspection_ui_apply")
    def _introspection_ui_apply(args: dict) -> Any:
        runtime = runtime_handle()
        sources = runtime.introspection_service._sources
        if "ui_spec" in args:
            sources.ui_spec = args["ui_spec"]
        elif "tokens" in args:
            spec = dict(sources.ui_spec or {})
            theme = dict(spec.get("theme") or {})
            theme.update(args["tokens"] or {})
            spec["theme"] = theme
            sources.ui_spec = spec
        else:
            raise ValueError("界面补丁缺 ui_spec 或 tokens")
        return {"applied": True}

    @op_sync("ui_spec.get")
    def _ui_spec_get(args: dict) -> Any:
        """当前活跃界面描述（渲染器数据源 = introspection 快照）。

        界面编辑器读入面与渲染器消费同一存储（_sources.ui_spec），
        消除「编辑器读写 app_capabilities 幽灵数据」的存储分叉。
        """
        runtime = runtime_handle()
        sources = runtime.introspection_service._sources
        spec = getattr(sources, "ui_spec", None)
        return {"spec": spec if isinstance(spec, dict) else None}

    @op_async("ui_spec.apply")
    async def _ui_spec_apply(args: dict) -> Any:
        """界面描述落补丁链（kind=ui，活跃态即时生效 + 可回退）。

        契约与 patch.apply 一致：spec 经 ui_schema 三层白名单校验后
        落链，_UiLiveTarget 同步切入 introspection 快照（渲染器数据源）。
        """
        from ink_engine.core.self_proposal import PatchKind, SelfProposal

        runtime = runtime_handle()
        spec = args.get("spec")
        if not isinstance(spec, dict) or not spec.get("root"):
            raise ValueError("界面补丁缺有效 spec")
        raw_base = args.get("base_version")
        if raw_base in (None, ""):
            base_version = int(await runtime.self_pipeline.chain.current_version())
        else:
            base_version = _parse_base_version(args)
        proposal = SelfProposal(
            kind=PatchKind.UI,
            payload={"spec": spec},
            base_version=base_version,
            rationale=args.get("rationale") or "界面编辑器保存",
            meta=dict(args.get("meta") or {"source": "ui_editor"}),
        )
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        outcome = await runtime.self_pipeline.apply(
            ctx, proposal, round_id=args.get("round_id")
        )
        return {"outcome": _jsonable(outcome)}

    @op_async("ui_spec.revert_latest")
    async def _ui_spec_revert_latest(args: dict) -> Any:
        """回退最近一笔界面补丁（链尾为 ui 补丁时才可回退）。

        界面编辑器「回退」入口：仅撤销最后一次界面编辑，不动其它
        补丁/数据（区别于恢复全库快照）。
        """
        runtime = runtime_handle()
        chain = runtime.self_pipeline.chain
        current = await chain.current_version()
        if current <= 1:
            return {
                "outcome": None,
                "reason": "无界面补丁可回退（集基线版本 1）",
            }
        last = await chain.last_patch()
        path = (last or {}).get("path") or []
        if not path or path[0] != "ui":
            return {
                "outcome": None,
                "reason": "链尾不是界面补丁，拒绝整库回退（只撤销最近界面编辑）",
            }
        patch_id = current
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        outcome = await runtime.self_pipeline.revert(
            ctx,
            patch_id,
            reason=args.get("reason") or "界面编辑器回退",
            round_id=args.get("round_id"),
        )
        return {"outcome": _jsonable(outcome)}

    @op_sync("engine.harness_register")
    def _harness_register(args: dict) -> Any:
        from ink_engine.core.harness import HarnessDefinition

        runtime = runtime_handle()
        parsed = HarnessDefinition.from_dict(args["definition"])
        runtime.harness_registry.register(parsed)
        return {"registered": parsed.name}

    @op_sync("engine.knowledge_upsert")
    def _knowledge_upsert(args: dict) -> Any:
        runtime = runtime_handle()
        _upsert_knowledge(runtime, args.get("entry"))
        return {"upserted": True}

    @op_async("engine.router_light_complete")
    async def _router_light_complete(args: dict) -> Any:
        from ink_engine.core.llm import messages as llm_messages

        runtime = runtime_handle()
        host = host_handle()
        llm = None
        chains = getattr(host, "tier_chains", None)
        if chains:
            from inkling_host.model_layers import resolve_tier_chain

            llm = resolve_tier_chain(chains, "router") or resolve_tier_chain(
                chains, "main"
            )
        if llm is None:
            llm = runtime.engine_llm
        if llm is None:
            raise RuntimeError("无可用模型（路由器不可用）")
        converted = []
        for item in args.get("messages") or []:
            role = str(item.get("role") or "user")
            if role == "system":
                converted.append(llm_messages.system(str(item.get("content") or "")))
            elif role == "assistant":
                converted.append(llm_messages.assistant(str(item.get("content") or "")))
            elif role == "tool":
                converted.append(
                    llm_messages.tool_result(
                        str(item.get("content") or ""),
                        str(item.get("tool_call_id") or ""),
                    )
                )
            else:
                converted.append(llm_messages.user(str(item.get("content") or "")))
        result = await llm.ainvoke(converted)
        return {"content": getattr(result, "content", None)}

    @op_async("engine.canary_stub_round")
    async def _canary_stub_round(args: dict) -> Any:
        import uuid as _uuid

        from ink_engine.core.assembly import AssemblyConfig
        from ink_engine.core.executor import Engine, RunOptions
        from inkling_host.graph_recipe import build_round_graph

        runtime = runtime_handle()
        if runtime.storage is None or runtime.engine is None:
            raise RuntimeError("运行时未装配（试跑须在装配之后）")
        graph = build_round_graph(
            _runtime_recipe_context(runtime),
            graph_data=args["graph"],
            workflow_data=args["workflow"],
        )
        collector = _CollectingTransport()
        options = RunOptions(
            storage=runtime.storage,
            registries=runtime.graph_registries,
            transports=[_usage_collecting_transport(collector)],
            system_events=runtime.event_type_registry.system_events(),
            assembly=AssemblyConfig(),
            assembly_sources=runtime._assembly_sources(),
        )
        test_engine = Engine(graph, options=options)
        stub = StubLLM(
            script=args.get("stub_script") or {},
            default_reply=args.get("default_reply") or "（stub 缺省回复）",
        )
        result = await test_engine.ainvoke(
            {"input": args.get("input") or "试跑"},
            thread_id=args.get("thread_id") or f"canary-{_uuid.uuid4().hex[:8]}",
            round_id=args.get("round_id") or _uuid.uuid4().hex,
            inject=args.get("inject") or None,
        )
        return {
            "reason": getattr(result, "reason", None),
            "state": dict(getattr(result, "state", {}) or {}),
            "error": getattr(result, "error", None),
            "events": collector.events,
        }


def _register_runtime_ops() -> None:
    # ── 运行时生命周期（状态机：uninitialized/running/paused/stopped）──

    @op_sync("engine.runtime_state")
    def _runtime_state(args: dict) -> Any:
        runtime = runtime_handle()
        return {"state": runtime.state.value}

    @op_sync("engine.runtime_pause")
    def _runtime_pause(args: dict) -> Any:
        runtime = runtime_handle()
        runtime.pause()
        return {"state": "paused"}

    @op_sync("engine.runtime_resume")
    def _runtime_resume(args: dict) -> Any:
        runtime = runtime_handle()
        runtime.resume()
        return {"state": "running"}

    @op_async("engine.runtime_stop")
    async def _runtime_stop(args: dict) -> Any:
        runtime = runtime_handle()
        await runtime.stop()
        return {"state": "stopped"}


def _register_knowledge_ops() -> None:
    # ── 知识集（用户集知识 CRUD / 晋升 / 归档 / 导出）──

    @op_async("knowledge.list")
    async def _knowledge_list(args: dict) -> Any:
        runtime = runtime_handle()
        level = args.get("level")
        include_archived = bool(
            args.get("includeArchived") or args.get("include_archived")
        )
        entries = runtime.knowledge_set.entries(
            level=level, include_archived=include_archived
        )
        out: list[dict] = []
        for entry in entries:
            try:
                content = entry.render_content()
            except Exception:
                content = str(entry.data)
            out.append({
                "id": entry.id,
                "level": entry.level,
                "kind": entry.kind,
                "title": entry.title,
                "content": content,
                "source": entry.source,
                "credibility": entry.credibility,
                "tags": list(entry.tags),
                "archived": bool(entry.archived),
                # 引擎 KnowledgeEntry 无 archived_at 字段（归档只保留
                # 标记位）；不造时间戳，前端按 archived 标记展示。
                "usage_failures": [
                    # 引擎失败日志只有文案无独立时间戳（updated_at 是
                    # 条目最后更新时间，不等于失败发生时间），at 置
                    # null 交由前端仅渲染文案，不伪造时间语义。
                    {"at": None, "reason": s}
                    for s in entry.failure_logs
                ],
                "created_at": entry.created_at,
            })
        return _jsonable({"entries": out})

    @op_sync("knowledge.graph")
    def _knowledge_graph(args: dict) -> Any:
        """知识拓扑 op：条目 → 节点，标签/来源/引用 → 边。

        前端知识关系可视化（knowledge_graph 组件）数据源。节点仅收录
        组件支持的四类（rule/template/tool_rule/weight）；边语义诚实、
        不造数据：
        - tag: 两条目共享至少一个标签；
        - source: 两条目来源相同（默认 model 来源不建边，防全量互联）；
        - reference: 一条目的 id 或标题出现在另一条目渲染内容中。
        运行期未装配 = 显式空态（degraded=true），不白屏。
        """
        try:
            runtime = runtime_handle()
        except RuntimeError:
            return {"nodes": [], "edges": [], "degraded": True}
        from ink_engine.core.knowledge_set import SOURCE_MODEL

        ks = getattr(runtime, "knowledge_set", None)
        if ks is None:
            return {"nodes": [], "edges": [], "degraded": True}
        entries = list(ks.entries(include_archived=False))
        nodes: list[dict[str, Any]] = []
        for entry in entries:
            if entry.kind not in ("rule", "template", "tool_rule", "weight"):
                continue
            nodes.append({
                "id": entry.id,
                "label": entry.title or entry.id,
                "kind": entry.kind,
            })
        edges: list[dict[str, Any]] = []
        if len(entries) > 1:
            rendered: dict[str, str] = {}
            for entry in entries:
                try:
                    rendered[entry.id] = entry.render_content()
                except Exception:
                    rendered[entry.id] = str(entry.data)
            tag_peers: dict[str, list[Any]] = {}
            for entry in entries:
                for tag in entry.tags:
                    tag_peers.setdefault(tag, []).append(entry)
            for peers in tag_peers.values():
                for i in range(len(peers)):
                    for j in range(i + 1, len(peers)):
                        edges.append({
                            "source": peers[i].id,
                            "target": peers[j].id,
                            "relation": "tag",
                        })
            source_peers: dict[str, list[Any]] = {}
            for entry in entries:
                if not entry.source or entry.source == SOURCE_MODEL:
                    continue
                source_peers.setdefault(entry.source, []).append(entry)
            for peers in source_peers.values():
                for i in range(len(peers)):
                    for j in range(i + 1, len(peers)):
                        edges.append({
                            "source": peers[i].id,
                            "target": peers[j].id,
                            "relation": "source",
                        })
            for entry in entries:
                content = rendered[entry.id]
                if not content:
                    continue
                for other in entries:
                    if other.id == entry.id:
                        continue
                    if other.id in content or (other.title and other.title in content):
                        edges.append({
                            "source": entry.id,
                            "target": other.id,
                            "relation": "reference",
                        })
            if len(edges) > _KNOWLEDGE_GRAPH_EDGE_CAP:
                edges = edges[:_KNOWLEDGE_GRAPH_EDGE_CAP]
        return {"nodes": nodes, "edges": edges}

    @op_async("knowledge.add")
    async def _knowledge_add(args: dict) -> Any:
        import uuid as _uuid

        from ink_engine.core.knowledge_set import KnowledgeEntry

        runtime = runtime_handle()
        entry_id = f"k-{_uuid.uuid4().hex[:12]}"
        entry = KnowledgeEntry(
            id=entry_id,
            level=args.get("level") or "work",
            kind=args.get("kind") or "insight",
            title=args.get("title") or "",
            data={
                "title": args.get("title") or "",
                "content": args.get("content") or "",
            },
            source="user",
            credibility=0.5,
        )
        runtime.knowledge_set.add(entry)
        ks = runtime.knowledge_set
        if getattr(ks, "storage", None) is not None:
            await ks.save()
        return {"id": entry_id}

    @op_async("knowledge.promote")
    async def _knowledge_promote(args: dict) -> Any:
        runtime = runtime_handle()
        entry = runtime.knowledge_set.promote(args["id"])
        ks = runtime.knowledge_set
        if getattr(ks, "storage", None) is not None:
            await ks.save()
        return {"id": entry.id, "level": entry.level}

    @op_async("knowledge.archive")
    async def _knowledge_archive(args: dict) -> Any:
        runtime = runtime_handle()
        entry = runtime.knowledge_set.archive(args["id"])
        ks = runtime.knowledge_set
        if getattr(ks, "storage", None) is not None:
            await ks.save()
        return {"id": entry.id}

    @op_async("knowledge.restore")
    async def _knowledge_restore(args: dict) -> Any:
        runtime = runtime_handle()
        entry = runtime.knowledge_set.unarchive(args["id"])
        ks = runtime.knowledge_set
        if getattr(ks, "storage", None) is not None:
            await ks.save()
        return {"id": entry.id}

    @op_async("knowledge.export")
    async def _knowledge_export(args: dict) -> Any:
        """导出知识集：全量补丁链（跨部署可移植）；传 id 则导出单条 to_dict。"""
        runtime = runtime_handle()
        if args.get("id"):
            entry = runtime.knowledge_set.get(args["id"])
            if entry is None:
                raise ValueError(f"知识条目不存在: {args['id']}")
            return _jsonable(entry.to_dict())
        return _jsonable(runtime.knowledge_set.export())

    @op_async("knowledge.skill_import")
    async def _knowledge_skill_import(args: dict) -> Any:
        """外部技能导入：SKILL.md 多形态源 → 知识集条目（转换 + 闸门 + 落位）。

        ``source`` 支持 url:/git:/npm:/file:/text: 前缀；``preview=True``
        只解析评估不落库（前端导入预览）。provenance 留痕支持重导入。
        """
        from inkling_host.skillmd_import import import_skill_source

        return _jsonable(
            await import_skill_source(
                runtime_handle(),
                args["source"],
                preview=bool(args.get("preview")),
            )
        )

    @op_async("knowledge.skill_reimport")
    async def _knowledge_skill_reimport(args: dict) -> Any:
        """外部技能重导入：按条目 provenance 重拉源 → diff → 更新。"""
        from inkling_host.skillmd_import import reimport_skill_source

        return _jsonable(await reimport_skill_source(runtime_handle(), args["id"]))

    @op_async("knowledge.evolve")
    async def _knowledge_evolve(args: dict) -> Any:
        """进化批次自动触发（失败驱动反思式变异 + 三层闸门防退化）。

        候选 = 知识集失败率优先（EvolutionFactory.collect_candidates），
        变异体经 KNOWLEDGE 补丁落集补丁链（审批 → 审计 → 可回退）。
        壳侧回合收尾低频调用（如每 N 回合一次）；limit 控制单批规模
        （缺省 1，防膨胀）。空候选/无可进化条目 = 空结果（不报错）。
        """
        host = host_handle()
        runtime = runtime_handle()
        incubation = getattr(host, "incubation", None)
        if incubation is None:
            return _jsonable({"outcomes": [], "reason": "孵化域未装配"})
        limit = max(1, int(args.get("limit", 1)))
        ctx = StandaloneApprovalContext(args.get("thread_id"))
        outcomes = await incubation.evolve(
            ctx, limit=limit, round_id=args.get("round_id")
        )
        if runtime.knowledge_set is not None:
            ks = runtime.knowledge_set
            if getattr(ks, "storage", None) is not None:
                await ks.save()
        return _jsonable(
            {
                "outcomes": [
                    {
                        "variants": [v.id for v in o.variants],
                        "rejected": list(o.rejected),
                    }
                    for o in outcomes
                ]
            }
        )


def register_builtin_ops() -> None:
    """注册出厂引擎操作（P10 按域拆分：各域注册函数组见 _register_*_ops）。

    op 名与签名保持不变（注册表契约由 tests/test_op_contract.py 回归
    守卫）；新增域 = 新增 _register_<域>_ops 并在本函数登记。
    """
    _register_engine_core_ops()
    _register_patch_ops()
    _register_skill_ops()
    _register_pipeline_ops()
    _register_graph_ops()
    _register_mcp_ops()
    _register_thread_ops()
    _register_memory_ops()
    _register_knowledge_ops()
    _register_runtime_ops()
    _register_live_ops()


# ── 洞察层（Why 审计 / 成长报告 / 数据主权 / 情境建议）──

async def _safe_storage_list(runtime: Any, collection: str) -> list[dict]:
    """读取引擎存储集合（异步；缺失/异常时返回空清单，不阻断洞察聚合）。"""
    storage = getattr(runtime, "storage", None)
    if storage is None:
        return []
    try:
        return list(await storage.list_records(collection))
    except Exception:
        return []


def _safe_attr_call(runtime: Any, attr: str, default: Any = None) -> Any:
    """安全取运行时属性并调用（无属性/异常 = 默认兜底）。"""
    target = getattr(runtime, attr, None)
    if target is None:
        return default
    try:
        result = target() if callable(target) else target
        return result
    except Exception:
        return default


async def _refresh_max_tool_rounds(runtime: Any) -> None:
    """引擎重建前刷新回合工具上限覆盖（能力记录 app_capabilities/capability）。

    覆盖 = 设置项（max_tool_rounds）；无记录/缺失/非法 = 清除覆盖回落
    节点 config 默认。异常吞掉（设置项缺失不阻断引擎重建主流程）。
    """
    from inkling_host.graph_recipe import set_max_tool_rounds_override

    try:
        storage = getattr(runtime, "storage", None)
        if storage is None:
            set_max_tool_rounds_override(None)
            return
        record = await storage.get_record("app_capabilities", "capability")
        raw = None if record is None else record.get("max_tool_rounds")
        set_max_tool_rounds_override(None if raw is None else int(raw))
    except Exception:
        set_max_tool_rounds_override(None)


@op_async("why.audit")
async def _why_audit(args: dict) -> Any:
    """「为什么」下钻：把留痕层的可解释数据汇聚为结构化理由链。

    数据源（均已在留痕层，非本 op 新造）：
    - 候选选择（path_candidate_selection）：人工/自动选中的组装候选；
    - 干预审计（set_audit）：assembly_candidate（候选留痕）、
      policy_edge_review（策略边复审 reason+action+review_tier）、
      失败审计（失败结点 reason）——决策点理由字段；
    - 边证据（若运行时持有 EdgeEvidenceStore 实例）：每条边的
      success/fail/policy/avg_cost 归因（汇流裁决的量化依据）。
    """
    runtime = runtime_handle()
    domain = args.get("domain") or "default"

    selections = [
        rec for rec in await _safe_storage_list(runtime, "path_candidate_selection")
        if (rec.get("domain") or "default") == domain
    ]

    audit = await _safe_storage_list(runtime, "set_audit")
    reason_chain: list[dict] = []
    for rec in audit:
        rtype = rec.get("type") or rec.get("kind") or ""
        if rtype in (
            "policy_edge_review",
            "assembly_candidate",
            "assembly_audit",
            "failure_audit",
        ):
            reason_chain.append({
                "type": rtype,
                "ts": rec.get("ts"),
                "domain": rec.get("domain"),
                "reason": rec.get("reason"),
                "action": rec.get("action"),
                "review_tier": rec.get("review_tier"),
                "candidate_id": rec.get("candidate_id"),
                "src_type": rec.get("src_type"),
                "dst_type": rec.get("dst_type"),
            })

    edges: list[dict] = []
    store = _safe_attr_call(runtime, "edge_evidence_store")
    if store is not None:
        try:
            for ev in await store.list_edges(domain):
                edges.append({
                    "src_type": ev.src_type,
                    "dst_type": ev.dst_type,
                    "success_count": ev.success_count,
                    "fail_count": ev.fail_count,
                    "policy": ev.policy,
                    "avg_cost": ev.avg_cost,
                })
        except Exception:
            edges = []

    return {
        "domain": domain,
        "candidates": selections,
        "reason_chain": reason_chain,
        "edge_evidence": edges,
    }


@op_async("report.growth")
async def _report_growth(args: dict) -> Any:
    """成长报告：对可观测的演化资产做当前窗口聚合（成功率/成本/结点增减/技能数）。

    各源独立取数、单点异常不影响整体（返回 null 而非失败）。技能数取
    批 4 波 1 已交付的 skill_store 计数；成功率/成本取边证据聚合；结点
    增减取知识集与工具表的当前规模（历史增量需持久化回合指标流，当前
    窗口以当前规模为近似）。
    """
    runtime = runtime_handle()

    skill_count = None
    store = _safe_attr_call(runtime, "skill_store")
    if store is not None:
        try:
            skill_count = int(await store.count())
        except Exception:
            skill_count = None

    knowledge_count = None
    ks = _safe_attr_call(runtime, "knowledge_set")
    if ks is not None:
        try:
            if callable(getattr(ks, "count", None)):
                knowledge_count = int(await ks.count())
            else:
                knowledge_count = len(list(ks))
        except Exception:
            knowledge_count = None

    tool_count = None
    try:
        tool_count = len(getattr(runtime, "tool_registry", {}) or {})
    except Exception:
        tool_count = None

    success_total = 0
    fail_total = 0
    cost_sum = 0.0
    cost_n = 0
    ev_store = _safe_attr_call(runtime, "edge_evidence_store")
    if ev_store is not None:
        try:
            for ev in await ev_store.list_edges(args.get("domain")):
                success_total += ev.success_count
                fail_total += ev.fail_count
                if ev.avg_cost:
                    cost_sum += ev.avg_cost
                    cost_n += 1
        except Exception:
            pass
    denom = success_total + fail_total
    success_rate = (success_total / denom) if denom else None
    avg_cost = (cost_sum / cost_n) if cost_n else None

    audit = await _safe_storage_list(runtime, "set_audit")
    recent_activity = sorted(
        [a for a in audit if a.get("ts")], key=lambda a: a["ts"], reverse=True
    )[: int(args.get("recent_limit") or 10)]

    # 自学习管线快照（成长状态只读数据面：孵化中信号/闸门通过率/落位）
    growth_snapshot = None
    pipeline = _safe_attr_call(runtime, "growth_pipeline")
    if pipeline is not None:
        try:
            growth_snapshot = pipeline.snapshot()
        except Exception:
            growth_snapshot = None
    # 成长指标时序（复利实证数据面：range 参数取最近 N 条，缺省 120）
    metrics_series = None
    if pipeline is not None:
        try:
            limit = int(args.get("range") or 0)
            series = await pipeline.metric_series(limit=limit or 120)
            if series:
                metrics_series = series
        except Exception:
            metrics_series = None

    return {
        "window": args.get("window") or "current",
        "skill_count": skill_count,
        "knowledge_count": knowledge_count,
        "tool_count": tool_count,
        "success_rate": success_rate,
        "avg_cost": avg_cost,
        "edge_success_total": success_total,
        "edge_fail_total": fail_total,
        "growth": growth_snapshot,
        "metrics": metrics_series,
        "recent_activity": [
            {"type": a.get("type") or a.get("kind"), "ts": a.get("ts")}
            for a in recent_activity
        ],
    }


@op_async("sovereignty.snapshot")
async def _sovereignty_snapshot(args: dict) -> Any:
    """数据主权快照：本地数据资产位置 + 模型挡位调用统计 + 访问审计概览。

    本地位置取运行时存储后端标识与技能存储路径（缺失/内存态 = 标注）；
    挡位统计取当前生效挡位声明（逐回合 TierCallStats 未持久化，此处仅
    报告挡位配置面）；访问审计取 set_audit 计数与最近若干条。
    """
    runtime = runtime_handle()

    storage = getattr(runtime, "storage", None)
    storage_info: dict[str, Any] = {"backend": type(storage).__name__ if storage else None}
    for attr in ("db_path", "path", "_db_path"):
        value = getattr(storage, attr, None)
        if value:
            storage_info["location"] = str(value)
            break

    skill_path = None
    ss = _safe_attr_call(runtime, "skill_store")
    if ss is not None:
        skill_path = getattr(ss, "_db_path", None)
    if skill_path:
        skill_path = str(skill_path)

    from ink_engine.core.tiers import current_tier_names

    audit = await _safe_storage_list(runtime, "set_audit")
    audit_counts: dict[str, int] = {}
    for rec in audit:
        key = rec.get("type") or rec.get("kind") or "unknown"
        audit_counts[key] = audit_counts.get(key, 0) + 1
    recent_audit = sorted(
        [a for a in audit if a.get("ts")], key=lambda a: a["ts"], reverse=True
    )[: int(args.get("recent_limit") or 10)]

    return {
        "local_storage": storage_info,
        "skill_store_path": skill_path,
        "model_tiers": list(current_tier_names()),
        "tier_call_stats_persisted": False,
        "audit_total": len(audit),
        "audit_counts": audit_counts,
        "recent_audit": recent_audit,
    }


@op_sync("suggestion.scan")
def _suggestion_scan(args: dict) -> Any:
    """情境建议扫描：对提供的上下文求值「情境触发」规则（rules.json 追加行）。

    规则只追加（禁改既有行），以既有谓词 has_fields 表达情境条件；本 op
    读取种子规则中 kind=context_trigger 的行，对传入 context（如系统/
    界面查询产物）求值，命中即生成主动建议。无规则/无上下文 = 空清单。
    """
    context = args.get("context") or {}
    if not isinstance(context, dict):
        context = {}

    root = _REPO_ROOT
    rules: list[dict] = []
    if root:
        import pathlib

        seed = pathlib.Path(root) / "inkling" / "seed_data" / "rules.json"
        try:
            with open(seed, encoding="utf-8") as fh:
                data = json.load(fh)
            rules = [
                r for r in (data.get("rules") or [])
                if r.get("kind") == "context_trigger"
            ]
        except (OSError, ValueError):
            rules = []

    suggestions: list[dict] = []
    for rule in rules:
        predicate = rule.get("predicate")
        config = rule.get("config") or {}
        hit = False
        if predicate == "has_fields":
            fields = config.get("fields") or []
            present = config.get("present", True)
            hit = all(f in context for f in fields) == bool(present)
        if hit:
            suggestions.append({
                "rule_id": rule.get("id"),
                "message": config.get("message") or rule.get("description") or "",
                "severity": rule.get("severity", "info"),
            })
    return {"scanned": len(rules), "suggestions": suggestions}


# ── 路径组装机制（使用方接线：闸门/档位映射/草稿桥/桥 op 注册）──

# 机制开关（默认关闭；装配按装配开关值透传——关闭即 op fail-closed）
_PATH_ASSEMBLER_ENABLED = False
# 七块机制开关全量（装配尾段按名写入；键名 = 引擎 BOOT_KEY_* 同源）
_PATH_FLAGS: dict[str, bool] = {}


class _DraftBridge:
    """草稿源桥（轻量默认）：策略模板 + 模型调用，只输出原始文本。

    默认形态只做「可用性桥」：草稿模型可解析（宿主挡位链 → 运行时
    模型）且策略模板可读时，按模板组织上下文并以「关闭推理」参数
    调用（深推理会吃满输出，草稿层要直出 JSON——该参数见策略模板
    注记）；任一前提不满足 = 返回 None——引擎按空响应语义直接走
    算法兜底，不重试（重试闭环已被证明不可靠，机制在系统层兜底）。
    """

    def __init__(self, host: Any, runtime: Any) -> None:
        self._host = host
        self._runtime = runtime

    def _draft_llm(self) -> Any | None:
        chains = getattr(self._host, "tier_chains", None)
        if chains:
            from inkling_host.model_layers import resolve_tier_chain

            llm = resolve_tier_chain(chains, "main")
            if llm is not None:
                return llm
        runtime = self._runtime
        if runtime is not None:
            llm = getattr(runtime, "engine_llm", None)
            if llm is not None:
                return llm
        return None

    def _prompt_assets(self) -> dict[str, Any] | None:
        """组装草稿策略模板（seed_data/path_prompts.json；读不到 = 不可用）。"""
        root = _REPO_ROOT
        if not root:
            return None
        try:
            with open(
                os.path.join(root, "inkling", "seed_data", "path_prompts.json"),
                encoding="utf-8",
            ) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return None
        for entry in data.get("prompts") or []:
            if entry.get("id") == "seed.inkling.prompt.assembly_draft":
                payload = entry.get("data") or {}
                if isinstance(payload, dict):
                    return payload
        return None

    def _draft_text(self, context: Any) -> str:
        """草稿上下文 → 用户提示词（目标/入口/结点契约摘要/反馈）。"""
        goal = "、".join(context.goal_fields) or "（无）"
        entry = "、".join(context.entry_fields) or "（无）"
        lines = [
            f"目标字段：{goal}",
            f"入口字段：{entry}",
            "可用结点（只列出类型名，不得编造不存在的结点）：",
        ]
        for summary in context.node_summaries:
            inputs = "、".join(summary.inputs) or "无"
            outputs = "、".join(summary.outputs) or "无"
            lines.append(
                f"- {summary.type_name} 输入={inputs} 输出={outputs}"
                f" 安全档={summary.safety_tier}"
            )
        if getattr(context, "feedback", ""):
            lines.append(f"上一次校验反馈（须修正）：{context.feedback}")
        return "\n".join(lines)

    async def draft(self, context: Any) -> str | None:
        """按策略模板组织草稿调用；任一前提不满足返回 None（算法兜底）。"""
        llm = self._draft_llm()
        if llm is None:
            return None
        assets = self._prompt_assets()
        if assets is None:
            return None
        prompt = assets.get("prompt") or {}
        system = str(prompt.get("system") or "")
        if not system:
            return None
        from ink_engine.core.llm import LLMParams, messages as llm_messages

        try:
            result = await llm.ainvoke(
                [llm_messages.system(system), llm_messages.user(self._draft_text(context))],
                params=LLMParams(extra_body={"enable_thinking": False}),
            )
        except Exception:
            return None
        return getattr(result, "content", None)


def _pool_from_specs(specs: list[Any]) -> dict[str, Any]:
    """结点池覆写声明 → 契约池（字段形态：type_name/input_fields/
    output_fields/safety_tier/version；编译为输入必填/产出声明形）。"""
    from ink_engine.core.contracts import NodeContract
    from ink_engine.core.schema_validator import FIELD_STRING, SchemaField, SchemaSpec

    pool: dict[str, Any] = {}
    for raw in specs:
        if not isinstance(raw, dict):
            raise ValueError(f"结点池条目须为对象: {raw!r}")
        type_name = str(raw.get("type_name") or "")
        if not type_name:
            raise ValueError("结点池条目缺 type_name")
        input_fields = [str(n) for n in (raw.get("input_fields") or ())]
        output_fields = [str(n) for n in (raw.get("output_fields") or ())]
        pool[type_name] = NodeContract(
            input_schema=SchemaSpec(
                name=f"{type_name}.in",
                fields=tuple(
                    SchemaField(name=n, required=True, kind=FIELD_STRING)
                    for n in input_fields
                ),
            ),
            output_schema=SchemaSpec(
                name=f"{type_name}.out",
                fields=tuple(
                    SchemaField(name=n, required=False, kind=FIELD_STRING)
                    for n in output_fields
                ),
            ),
            safety_tier=max(0, min(2, int(raw.get("safety_tier") or 0))),
            version=max(1, int(raw.get("version") or 1)),
        )
    return pool


def _pool_registry(pool: dict[str, Any]) -> Any:
    """契约池 → 结点类型注册表（stub 工厂：桥只组装不执行，结点不实例化）。"""
    from ink_engine.core.registry import NodeTypeRegistry

    def stub_factory(config: dict[str, Any]) -> Any:
        async def node(ctx: Any) -> dict[str, Any]:
            return {}

        return node

    registry = NodeTypeRegistry()
    for type_name, contract in pool.items():
        registry.register(type_name, stub_factory, contract=contract)
    return registry


def _run_path_assembly(
    request: Any,
    envelope: Any,
    registry: Any,
    retriever: Any,
    audit_sink: Callable[[dict[str, Any]], Any],
    *, prefer_direct: bool,
) -> Any:
    """组装结果负载（记录落库回调收集；对象全部在 Python 侧构造）。"""
    from ink_engine.core.contracts import PathAssemblyConfig
    from ink_engine.core.path_assembler import PathAssembler

    async def direct() -> Any:
        assembler = PathAssembler(
            registry=registry,
            retriever=retriever,
            config=PathAssemblyConfig(enabled=True),
            sink=audit_sink,
        )
        return await assembler.assemble(request, envelope)

    if prefer_direct:
        return direct()
    try:
        from ink_engine.core.path_assembler import assemble_plan
    except ImportError:
        return direct()
    # 预算信封全程透传（ENG9a-3）：默认路径同样接收 envelope——
    # use_draft/beam_width/max_path_length/llm_retry_limit 覆盖权不再
    # 仅限 prefer_direct 分支
    return assemble_plan(request, envelope=envelope, audit_sink=audit_sink)


@op_async("path.assemble")
async def _path_assemble(args: dict) -> dict[str, Any]:
    """路径组装 op：请求参数 → 引擎侧组装 → 候选/统计/审计（JSON 进出）。

    输入（全部可选按缺省）：
    - ``goal_schema``：目标 schema（SchemaSpec 数据形态）；
    - ``entry_fields``：入口字段清单；
    - ``domain``：上下文域（证据按域聚合）；
    - ``top_k``：候选条数上限（缺省 2）；
    - ``max_safety_tier`` 或 ``approval_tier``：放行档（后者经档位映射）；
    - ``use_draft``：启用草稿层（草稿桥不可用 = 算法兜底）；
    - ``pool``：结点池覆写声明（未提供 = 用运行时契约注册表登记池）。
    """
    if not _PATH_ASSEMBLER_ENABLED:
        return {
            "ok": False,
            "enabled": False,
            "reason": "路径组装未启用（机制开关关闭，fail-closed）",
        }
    from ink_engine.core.path_assembler import (
        DEFAULT_BEAM_WIDTH,
        DEFAULT_LLM_WINDOW,
        DEFAULT_MAX_PATH_LENGTH,
        LLM_RETRY_LIMIT,
        AssemblyEnvelope,
        AssemblyRequest,
        InMemoryPoolRetriever,
    )
    from ink_engine.core.schema_validator import SchemaSpec
    from inkling_host.quality import (
        DomainQualityGate,
        approval_tier_to_max_safety_tier,
    )

    runtime = runtime_handle()
    host = host_handle()

    goal_schema = None
    if isinstance(args.get("goal_schema"), dict):
        goal_schema = SchemaSpec.from_dict(args["goal_schema"])
    entry_fields = tuple(str(f) for f in (args.get("entry_fields") or ()))
    domain = str(args.get("domain") or "default")
    top_k = max(1, int(args.get("top_k") or 2))
    if args.get("max_safety_tier") is not None:
        max_safety_tier = max(0, min(2, int(args["max_safety_tier"])))
    else:
        max_safety_tier = approval_tier_to_max_safety_tier(args.get("approval_tier"))
    use_draft = bool(args.get("use_draft"))

    registry: Any = None
    retriever: Any = None
    use_pool_override = isinstance(args.get("pool"), list) and bool(args["pool"])
    if use_pool_override:
        pool = _pool_from_specs(args["pool"])
        registry = _pool_registry(pool)
        retriever = InMemoryPoolRetriever(pool)
    else:
        registries = getattr(runtime, "graph_registries", None)
        registry = getattr(registries, "nodes", None) if registries is not None else None

    request = AssemblyRequest(
        goal_schema=goal_schema,
        entry_fields=entry_fields,
        domain=domain,
        max_safety_tier=max_safety_tier,
        quality_gate=DomainQualityGate(),
        draft_provider=(
            _DraftBridge(host, runtime) if use_draft else None
        ),
        top_k=top_k,
        graph_name=args.get("graph_name"),
    )
    envelope = AssemblyEnvelope(
        llm_draft=use_draft,
        # 预算信封参数经 op 透传（ENG9a-3：覆盖权全链路可达）
        beam_width=max(1, int(args.get("beam_width") or DEFAULT_BEAM_WIDTH)),
        max_path_length=max(
            1, int(args.get("max_path_length") or DEFAULT_MAX_PATH_LENGTH)
        ),
        llm_retry_limit=max(
            0, int(args.get("llm_retry_limit") or LLM_RETRY_LIMIT)
        ),
        llm_window=max(1, int(args.get("llm_window") or DEFAULT_LLM_WINDOW)),
    )
    audit_records: list[dict[str, Any]] = []
    result = await _run_path_assembly(
        request,
        envelope,
        registry,
        retriever,
        audit_records.append,
        prefer_direct=use_pool_override,
    )
    data = result.to_dict()
    audit = list(audit_records)
    if not audit and isinstance(data.get("audit"), list):
        audit = data["audit"]
    # 组装→结晶接线（走审批卡）：canary 单回合通过的候选 → 技能候选池 →
    # KNOWLEDGE 补丁审批（L1 人工卡）→ 落知识集（补丁链可回退）。
    # 去重 = 同指纹已存在技能跳过；evidence 冷启动全零 = 报告标「证据待积累」。
    skill_candidates = []
    try:
        skill_candidates = await _propose_assembly_skills(
            runtime, host, result, domain, thread_id=args.get("thread_id")
        )
    except Exception as exc:
        logger.warning("组装技能结晶提案失败（忽略）: %s", exc)
    return _jsonable(
        {
            "ok": True,
            "enabled": True,
            "domain": domain,
            "max_safety_tier": max_safety_tier,
            "candidates": list(data.get("candidates") or []),
            "stats": dict(data.get("stats") or {}),
            "audit": audit,
            "fingerprint": data.get("fingerprint", ""),
            "exploration_mode": bool(data.get("exploration_mode", False)),
            "multipath_signal": bool(data.get("multipath_signal", False)),
            "fallback_reason": data.get("fallback_reason"),
            "llm_attempts": int(data.get("llm_attempts") or 0),
            "skill_candidates": skill_candidates,
        }
    )


async def _propose_assembly_skills(
    runtime: Any,
    host: Any,
    result: Any,
    domain: str,
    *,
    thread_id: str | None = None,
) -> list[dict[str, Any]]:
    """组装验证候选 → 技能候选池（审批卡后落知识集补丁链）。

    canary 通过 = 单回合验证成功，进候选池（低频长尾路径可结晶）；
    同指纹已存在 = 跳过（去重）；evidence 冷启动全零 = test_report
    标注「证据待积累」不谎报成功率。提案异常只记日志（观测不阻断
    组装主流程）。
    """
    from ink_engine.core.skill_crystal import (
        build_assembly_skill_entry,
        skill_to_knowledge_entry,
    )

    incubation = getattr(host, "incubation", None)
    if incubation is None:
        return []
    candidates = list(result.candidates or ())
    verdicts = {v.rank: v for v in (result.canary or ())}
    if not candidates or not verdicts:
        return []
    skill_store = getattr(runtime, "skill_store", None)
    evidence_store = getattr(runtime, "edge_evidence_store", None)
    model_id = os.environ.get("INK_LLM_MODEL", "")
    ctx = StandaloneApprovalContext(thread_id)
    proposed: list[dict[str, Any]] = []
    for candidate in candidates:
        verdict = verdicts.get(candidate.rank)
        if verdict is None or not verdict.ok:
            continue
        if skill_store is not None:
            try:
                existing = await skill_store.get_by_fingerprint(verdict.digest)
                if existing is not None:
                    continue
            except Exception:
                pass
        evidence: list[Any] = []
        if evidence_store is not None:
            try:
                evidence = list(await evidence_store.list_edges(domain))
            except Exception:
                evidence = []
        skill = build_assembly_skill_entry(
            candidate,
            verdict,
            domain=domain,
            model_id=model_id,
            evidence_edges=evidence,
        )
        entry = skill_to_knowledge_entry(skill, now=time.time())
        try:
            outcome = await incubation.propose_knowledge_patch(
                ctx,
                entry,
                rationale=(
                    "组装验证路径结晶（canary 通过："
                    + " → ".join(candidate.chain)
                    + "）；证据待积累"
                ),
                round_id=thread_id,
            )
            proposed.append(
                {
                    "name": skill.name,
                    "fingerprint": skill.fingerprint,
                    "applied": bool(getattr(outcome, "applied", False)),
                    "reason": str(getattr(outcome, "reason", "") or ""),
                }
            )
        except Exception as exc:
            logger.warning("组装技能提案失败（忽略）: %s", exc)
    return proposed


@op_async("path.import_seed_paths")
async def _path_import_seed_paths(args: dict) -> dict[str, Any]:
    """种子路径导入：出厂路径语料 → 边证据初始化（同键不覆盖——运行
    统计是事实，种子只补空白；幂等，装配重放不放大状态）。"""
    if not _PATH_ASSEMBLER_ENABLED:
        return {"imported": 0, "enabled": False, "reason": "未启用（fail-closed）"}
    seed_edges = args.get("seed_edges") or []
    if not isinstance(seed_edges, list):
        return {"imported": 0, "enabled": True, "reason": "seed_edges 须为数组"}
    from ink_engine.core.edge_evidence import EdgeEvidenceStore, import_seed_paths

    store = EdgeEvidenceStore(db_path=str(args.get("db_path") or ":memory:"))
    try:
        written = await import_seed_paths(store, seed_edges)
    finally:
        await store.close()
    return {"imported": int(written), "enabled": True}


@op_sync("path.set_flags")
def _path_set_flags(args: dict) -> dict[str, Any]:
    """七块机制开关透传（装配尾段按装配开关值写入；缺省全关）。

    键名与引擎 ``PathAssemblyFlags.from_boot`` 的 BOOT_KEY_* 同源
    （path_assembly_*_enabled）；逐位独立，单块可关闭即回滚路径。
    兼容旧形态：`path.set_assembler_enabled` 只写 assembler 位。
    """
    from ink_engine.core.contracts import PathAssemblyFlags

    global _PATH_FLAGS, _PATH_ASSEMBLER_ENABLED
    flags = PathAssemblyFlags.from_boot(args)
    # 进程内镜像统一 BOOT_KEY_* 长键形态（与引擎落库/读取同口径，
    # 单块翻转 op 读取本镜像时键名不漂移）
    _PATH_FLAGS = dict(flags.to_boot_dict())
    _PATH_ASSEMBLER_ENABLED = flags.assembler_enabled
    return {"enabled": _PATH_ASSEMBLER_ENABLED, "flags": dict(_PATH_FLAGS)}


@op_sync("path.set_assembler_enabled")
def _path_set_assembler_enabled(args: dict) -> dict[str, Any]:
    """组装器单块开关透传（兼容旧调用形态；语义 = set_flags 的 assembler 位）。"""
    return _path_set_flags(
        {"path_assembly_assembler_enabled": bool(args.get("enabled", False))}
    )


@op_async("path.choose_candidate")
async def _path_choose_candidate(args: dict) -> dict[str, Any]:
    """候选路径人工选择 op：assemble 后挑选执行路径（状态落库 + 审计）。

    委托引擎侧 ``choose_candidate``（path_assembler）；候选身份由前端
    candidateId 经壳命令透传（壳命令映射由主会话补齐）。运行时存储用于
    选中态持久化与审计落库；无存储 = 仅做状态计算不落库。
    """
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    candidate_id = str(args.get("candidateId") or args.get("candidate_id") or "")
    domain = str(args.get("domain") or "default")
    chain = [str(c) for c in (args.get("chain") or ())]
    fingerprint = str(args.get("fingerprint") or "")
    from ink_engine.core.path_assembler import choose_candidate

    result = await choose_candidate(
        storage,
        candidate_id,
        domain=domain,
        chain=chain,
        fingerprint=fingerprint,
    )
    return _jsonable(result)


@op_async("path.clear_candidate")
async def _path_clear_candidate(args: dict) -> dict[str, Any]:
    """候选选择清除 op（ENG9a-9 接线）：清除当前域选中候选，恢复多候选
    观察态（前端 clearChoice 不再走 choose_candidate 空 id 的 fail-closed
    拒绝路径）。委托引擎侧 ``clear_candidate_selection``（同一集合同一键，
    状态可断言轮转）；无存储 = 仅状态计算不落库。
    """
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    domain = str(args.get("domain") or "default")
    from ink_engine.core.path_assembler import clear_candidate_selection

    result = await clear_candidate_selection(storage, domain=domain)
    return _jsonable(result)


@op_async("path.set_multipath")
async def _path_set_multipath(args: dict) -> dict[str, Any]:
    """多径开关 op（复用 path.set_flags 单块开关语义；状态落库 + 审计）。

    沿用既有单块开关的字段键约定，只翻转 ``multipath_enabled`` 位（其余装配
    开关保持不变，不做全量重建以免误清其他块），再委托引擎侧 ``set_multipath``
    落持久化与审计——运行期开关与落库状态双通道一致。
    """
    enabled = bool(args.get("enabled", False))
    domain = str(args.get("domain") or "default")
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    # 单块翻转：保留其余装配开关，只改多径位（进程内镜像与引擎落库同用
    # BOOT_KEY_* 长键形态——读取/写入口径统一，防短键落库长键读取全 False）
    global _PATH_FLAGS
    flags = dict(_PATH_FLAGS or {})
    flags["path_assembly_multipath_enabled"] = enabled
    _PATH_FLAGS = flags
    from ink_engine.core.path_assembler import set_multipath

    result = await set_multipath(storage, enabled, domain=domain) if storage is not None else {
        "multipath_enabled": enabled,
        "flags": dict(flags),
    }
    return _jsonable(result)


@op_async("cache.invalidate")
async def _cache_invalidate(args: dict) -> dict[str, Any]:
    """指纹缓存语义化失效 op（复用 FingerprintCacheStore.invalidate 机制）。

    scope 形态：``*``/``all`` 整库、``domain:<域>`` 指定域、其余按上下文指纹
    单条。引擎侧 ``invalidate_cache`` 复用既有失效机制并发审计留痕；运行时
    存储用于审计落库。空 scope = fail-closed 拒绝。
    """
    scope = args.get("scope") or ""
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    db_path = str(args.get("db_path") or ":memory:")
    from ink_engine.core.fingerprint_cache import FingerprintCacheStore, invalidate_cache

    store = FingerprintCacheStore(db_path=db_path)
    try:
        result = await invalidate_cache(
            store, scope, storage=storage, reason=args.get("reason") or "人工失效"
        )
    finally:
        await store.close()
    return _jsonable({"ok": True, **result})


@op_async("cache.stats")
async def _cache_stats(args: dict) -> dict[str, Any]:
    """LLM 缓存命中统计 op（穿透行为层/链定位 CachingLLM）。

    未挂缓存（链路里无 CachingLLM）= available False，stats 为空；
    挂了则返回 entries/hits/misses/hit_rate。
    """
    runtime = runtime_handle()
    llm = getattr(runtime, "engine_llm", None)
    caching = _find_caching_llm(llm)
    if caching is None:
        return _jsonable({"ok": True, "available": False, "stats": {}})
    stats = await caching.stats()
    return _jsonable({"ok": True, "available": True, "stats": stats})


@op_async("cache.rebuild")
async def _cache_rebuild(args: dict) -> dict[str, Any]:
    """指纹缓存重建 op（清空指定域缓存 → 下次访问自动重算；审计留痕）。

    与 cache.invalidate 的差异：rebuild 语义 = 强制该域缓存整包失效重建
    （清空后由后续请求按当前契约重新计算），paired 形态「清除 → 重建」
    在干预卡上形成可复原闭环；域缺省 = 整库。
    """
    domain = args.get("domain") or args.get("scope") or ""
    scope = f"domain:{domain}" if domain else "*"
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    db_path = str(args.get("db_path") or ":memory:")
    from ink_engine.core.fingerprint_cache import FingerprintCacheStore, invalidate_cache

    store = FingerprintCacheStore(db_path=db_path)
    try:
        result = await invalidate_cache(
            store, scope, storage=storage, reason=args.get("reason") or "人工重建"
        )
    finally:
        await store.close()
    return _jsonable({"ok": True, "rebuilt": True, "domain": domain, **result})


@op_async("edge.restore_tier")
async def _edge_restore_tier(args: dict) -> dict[str, Any]:
    """信任档人工恢复 op（反向操作：从 override 快照回写原证据计数）。

    与 edge.downgrade_tier 配对形成可复原闭环；无快照（未降级过/未知边）
    = fail-closed 返回 None（不报错，前端按未降级处理）。
    """
    edge_id = args.get("edgeId") or args.get("edge_id") or ""
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    db_path = str(args.get("db_path") or ":memory:")
    from ink_engine.core.edge_evidence import EdgeEvidenceStore, restore_edge_tier

    key = _edge_key_from_id(edge_id)
    store = EdgeEvidenceStore(db_path=db_path)
    try:
        if key is None:
            raise ValueError(f"边标识非法: {edge_id!r}")
        result = await restore_edge_tier(store, key, storage=storage)
    finally:
        await store.close()
    if result is None:
        return _jsonable({"ok": True, "restored": False, "reason": "无降级快照"})
    return _jsonable({"ok": True, **result})


@op_async("edge.downgrade_tier")
async def _edge_downgrade_tier(args: dict) -> dict[str, Any]:
    """信任档人工降级 op（档位更新 + 审计；降级前快照留痕可复原）。

    边标识 edgeId 支持 ``src|dst|srcVer|dstVer|domain`` 串或 dict 形态；
    未知边 / 非法档位 = fail-closed 拒绝（引擎侧抛错上抛）。运行时存储用于
    审计与降级前快照落库。
    """
    edge_id = args.get("edgeId") or args.get("edge_id") or ""
    target = args.get("tier") or args.get("target_tier") or ""
    runtime = runtime_handle()
    storage = getattr(runtime, "storage", None)
    db_path = str(args.get("db_path") or ":memory:")
    from ink_engine.core.edge_evidence import EdgeEvidenceStore, EdgeKey

    key = _edge_key_from_id(edge_id)
    store = EdgeEvidenceStore(db_path=db_path)
    try:
        if key is None:
            raise ValueError(f"边标识非法: {edge_id!r}")
        from ink_engine.core.edge_evidence import downgrade_edge_tier

        result = await downgrade_edge_tier(
            store,
            key,
            target_tier=target,
            storage=storage,
            reason=args.get("reason") or "人工降级",
        )
    finally:
        await store.close()
    return _jsonable({"ok": True, **result})


def _edge_key_from_id(edge_id: str) -> "EdgeKey | None":
    """边标识 → EdgeKey：``src|dst|srcVer|dstVer|domain`` 串或 dict 形态。"""
    from ink_engine.core.edge_evidence import EdgeKey

    if not edge_id:
        return None
    if isinstance(edge_id, dict):
        return EdgeKey.from_dict(edge_id)
    parts = str(edge_id).split("|")
    if len(parts) < 2:
        return None
    src = parts[0]
    dst = parts[1]
    src_ver = parts[2] if len(parts) > 2 else "1"
    dst_ver = parts[3] if len(parts) > 3 else "1"
    domain = parts[4] if len(parts) > 4 else "default"
    return EdgeKey(
        src_type=src,
        dst_type=dst,
        src_contract_version=src_ver,
        dst_contract_version=dst_ver,
        context_domain=domain,
    )


# ── 指标快照聚合（壳侧观测；纯聚合，不触引擎机制）──

def _as_int(value) -> int:
    """容错转 int（非整数/非法 = 0），聚合不被脏数据打崩。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _as_float(value) -> float:
    """容错转 float（非数字/非法 = 0.0），avg_cost 等聚合不受脏数据打崩。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


@op_async("cache.clear")
async def _cache_clear(args: dict) -> dict[str, Any]:
    """LLM 缓存清空 op（穿透行为层/链定位 CachingLLM 并清空）。"""
    runtime = runtime_handle()
    llm = getattr(runtime, "engine_llm", None)
    caching = _find_caching_llm(llm)
    if caching is None:
        return _jsonable({"ok": True, "available": False, "cleared": 0})
    cleared = await caching.clear()
    return _jsonable({"ok": True, "available": True, "cleared": int(cleared or 0)})


def _find_caching_llm(llm: Any) -> Any:
    """在 LLM 包装链里定位 CachingLLM（行为层/链包装下穿透）。

    返回首个 CachingLLM 实例，找不到返回 None（未挂缓存 = 统计不可用）。
    遍历 ``._inner``（BehaviorLLM/CachingLLM 等单包）与 ``._llms``
    （ModelChain 多模型列表），防环用 id 记忆集。
    """
    from ink_engine.core.llm.cache import CachingLLM

    if llm is None:
        return None
    seen: set[int] = set()
    stack = [llm]
    while stack:
        node = stack.pop()
        if node is None or id(node) in seen:
            continue
        seen.add(id(node))
        if isinstance(node, CachingLLM):
            return node
        inner = getattr(node, "_inner", None)
        if inner is not None:
            stack.append(inner)
        llms = getattr(node, "_llms", None)
        if isinstance(llms, (list, tuple)):
            stack.extend(llms)
    return None


async def _runtime_assembly_stats() -> dict[str, Any]:
    """取组装运行期统计累计 + 缓存条目量（stats 最后一跳的数据源）。

    引擎侧 PathAssemblyRuntime.stats_total 为进程内跨调用累计（命中/
    未命中/失效/顶替四计数器），缓存条目量经 FingerprintCacheStore.count
    实时读取；运行期未挂载（组装关闭）= 空统计。
    """
    from ink_engine.core.path_assembler import get_default_assembly_runtime

    runtime = get_default_assembly_runtime()
    if runtime is None:
        return {"stats": {}, "cache_entries": 0}
    stats = dict(getattr(runtime, "stats_total", {}) or {})
    cache_entries = 0
    cache = getattr(runtime, "cache", None)
    if cache is not None:
        try:
            cache_entries = await cache.count()
        except (TypeError, ValueError, OSError):
            cache_entries = 0
    return {"stats": stats, "cache_entries": cache_entries}


@op_async("assemble_stats")
async def _assemble_stats(args: dict) -> dict[str, Any]:
    """组装统计 op（ENG9a-8 接线：stats 四计数器消费链最后一跳）。

    前端仪表盘经本 op 直取：命中/未命中/失效/顶替四计数器（进程内跨
    调用累计，含顶替计数——ENG9a-19 按值拷贝后仍可见）+ 缓存条目量。
    组装未装配（flag 关）= 空统计 + 条目量 0，不报错。
    """
    data = await _runtime_assembly_stats()
    return _jsonable({"ok": True, **data})


@op_async("metrics.snapshot")
async def _metrics_snapshot(args: dict) -> dict[str, Any]:
    """指标快照聚合 op：回合/LLM/缓存/边证据指标汇成单一观测快照。

    输入（各块缺省容错，缺块 = 0/空，不报错）：
    - ``turn_metrics``：TurnMetrics.snapshot 形态（turns/failures/...
      /llm_calls_by_tier）；
    - ``llm_usage``：LLM usage 帧清单（每帧 ``prompt_tokens``/
      ``completion_tokens``，来自 LLMChunk/LLMResult.usage 捕获点；
      缺省 = 桥侧回合入口收集的 llm_usage 事件帧——引擎
      UsageTrackingLLM 生产 → 帧桥接收集 → 本快照消费的闭环）；
    - ``cache_stats``：path.assemble 回传的 cache_hits/cache_misses/
      cache_invalidations/cache_replacements（缺省 = 壳侧自取组装运行期
      统计累计——ENG9a-8：前端无参调用不再恒 0）；
    - ``cache_entries``：FingerprintCacheStore.count（缓存条目量；
      缺省 = 壳侧自取）；
    - ``edges``：edge_evidence.list_edges 结果（取每条 ``avg_cost``）；
    - ``occupancy``：``{ "current": int, "limit": int }``（占用/上限）。

    输出：聚合快照（命中率 = hits/(hits+misses)，>80% 标 over_threshold）。
    """
    turn = args.get("turn_metrics") or {}
    if not isinstance(turn, dict):
        turn = {}

    usage = args.get("llm_usage") or []
    if not isinstance(usage, list):
        usage = []
    if not usage:
        # 帧桥接收集（批 3a 遗留闭环）：调用方未显式传帧 = 聚合桥侧
        # 回合入口收集的 llm_usage 事件帧（引擎 UsageTrackingLLM 生产）
        usage = list(_LLM_USAGE_FRAMES)
    prompt_total = 0
    completion_total = 0
    last_prompt = None
    last_completion = None
    for frame in usage:
        if not isinstance(frame, dict):
            continue
        p = _as_int(frame.get("prompt_tokens"))
        c = _as_int(frame.get("completion_tokens"))
        prompt_total += p
        completion_total += c
        last_prompt = p
        last_completion = c
    llm_calls = sum(_as_int(v) for v in (turn.get("llm_calls_by_tier") or {}).values())

    cache = args.get("cache_stats") or {}
    if not isinstance(cache, dict) or not cache:
        # 缺省自取：组装运行期统计累计（命中率不再恒 0 的最后一跳）
        runtime_stats = await _runtime_assembly_stats()
        cache = runtime_stats.get("stats") or {}
    if not isinstance(cache, dict):
        cache = {}
    hits = _as_int(cache.get("cache_hits"))
    misses = _as_int(cache.get("cache_misses"))
    invalidations = _as_int(cache.get("cache_invalidations"))
    replacements = _as_int(cache.get("cache_replacements"))
    denom = hits + misses
    hit_rate = (hits / denom) if denom > 0 else 0.0

    edges = args.get("edges") or []
    if not isinstance(edges, list):
        edges = []
    costs = [_as_float(e.get("avg_cost")) for e in edges if isinstance(e, dict)]
    avg_cost_mean = (sum(costs) / len(costs)) if costs else 0.0

    cache_entries = _as_int(args.get("cache_entries"))
    if not cache_entries:
        runtime_stats = await _runtime_assembly_stats()
        cache_entries = _as_int(runtime_stats.get("cache_entries"))

    occupancy = None
    occ = args.get("occupancy")
    if isinstance(occ, dict) and "current" in occ and "limit" in occ:
        current = _as_int(occ.get("current"))
        limit = _as_int(occ.get("limit"))
        over = (limit > 0) and (current > limit * 0.8)
        occupancy = {"current": current, "limit": limit, "over_threshold": over}

    # LLM 缓存命中统计（穿透行为层定位 CachingLLM，未挂 = 空）
    caching_llm: dict[str, Any] = {}
    try:
        runtime = runtime_handle()
        caching = _find_caching_llm(getattr(runtime, "engine_llm", None))
        if caching is not None:
            caching_llm = await caching.stats()
    except Exception:
        # 取缓存统计失败不影响指标快照（fail-open）
        caching_llm = {}

    return _jsonable(
        {
            "ok": True,
            "turn_metrics": turn,
            "llm": {
                "prompt_tokens_total": prompt_total,
                "completion_tokens_total": completion_total,
                "tokens_total": prompt_total + completion_total,
                "last_prompt_tokens": last_prompt,
                "last_completion_tokens": last_completion,
                "calls_total": llm_calls,
            },
            "cache": {
                "hits": hits,
                "misses": misses,
                "invalidations": invalidations,
                "replacements": replacements,
                "hit_rate": hit_rate,
                "caching_llm": caching_llm,
            },
            "edges": {
                "count": len(costs),
                "avg_cost_mean": avg_cost_mean,
                "avg_cost_min": (min(costs) if costs else None),
                "avg_cost_max": (max(costs) if costs else None),
            },
            "cache_entries": cache_entries,
            "occupancy": occupancy,
        }
    )


# ── 过程摘要链合并 / 记忆无感提取 + 冲突消解 ──
# 仅追加本域 op：合并走引擎既有压缩形态，提取走零 LLM 规则抽取 + 仲裁，
# 引擎存储/记忆接口零新增机制，逻辑落在 ink_engine 包内。

@op_async("ledger.merge")
async def _ledger_merge(args: dict) -> Any:
    """回合账本增量合并（复用 context.py 压缩形态，便宜档可选 LLM）。

    输入：``thread_id`` / ``old_summary``（摘要链最新一条）/ ``new_ledgers``
    （本轮事实快照列表）。产出同构摘要 JSON，落位语义与
    ``build_message_compress_patches`` 的 summary 落链首一致。
    """
    from ink_engine.core.ledger import merge_ledger

    thread_id = args.get("thread_id", "")
    old_summary = args.get("old_summary")
    new_ledgers = args.get("new_ledgers") or []
    if not isinstance(new_ledgers, list):
        new_ledgers = []
    # 便宜档 LLM 摘要为扩展点：未配置时走确定性压缩（零模型、可测、可复现）
    merged = merge_ledger(old_summary if old_summary else None, new_ledgers)
    return _jsonable({"thread_id": thread_id, **merged})


@op_sync("ledger.fact_rules")
def _ledger_fact_rules(_args: dict) -> Any:
    """回合事实提取规则导出（权威口径，壳侧契约守卫消费）。

    「哪些事件构成回合事实要点」的口径由引擎单一定义
    （memory_extract.ROUND_FACT_EVENTS）；壳侧账本归约（round_ledger.rs
    RECOGNIZED_EVENTS）与记忆提取引用同源——壳侧经本 op 校验自身常量
    与引擎一致，防两套事件清单漂移（账本漏确认类 → 记忆抽不到）。
    """
    from ink_engine.core.memory_extract import ROUND_FACT_EVENTS

    return _jsonable(
        {
            "round_fact_events": list(ROUND_FACT_EVENTS),
        }
    )


@op_async("memory.extract")
async def _memory_extract(args: dict) -> Any:
    """记忆无感提取 + 冲突仲裁（零 LLM 规则抽取，新旧并存留痕）。

    输入：``ledger``（回合账本 JSON：intent/conclusion/events）。抽取条目
    经 ``StorageBackedMemoryStore`` 存储，同 namespace+kind 内容冲突 →
    新旧并存留痕（不静默覆盖），内容相同 → 去重跳过。
    """
    from ink_engine.core.memory_extract import (
        arbitrate_and_store,
        extract_entries_from_ledger,
    )
    from ink_engine.core.memory import StorageBackedMemoryStore

    runtime = runtime_handle()
    ledger = args.get("ledger") or {}
    entries = extract_entries_from_ledger(ledger)
    store = StorageBackedMemoryStore(runtime.storage)
    result = await arbitrate_and_store(store, entries)
    return _jsonable(
        {
            "extracted": len(entries),
            "stored": result["stored"],
            "arbitrations": result["arbitrations"],
            "skipped": result["skipped"],
        }
    )


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
        # 最近一次调用的消息流（可观测：提示词生效断言/门禁核对取用）
        self.last_messages = []

    def _reply_for(self, messages) -> str:
        self.call_count += 1
        self.last_messages = [dict(getattr(m, "to_dict", lambda: {"role": "?", "content": ""})())
                              for m in messages]
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


def make_host(
    *,
    storage_uri: str,
    transport,
    llm=None,
    embedder=None,
    behavior=None,
    data_dir=None,
):
    """构造宿主五件套：存储 URI/事件传输（Rust 回桥）/模型实例注入/
    本地语义嵌入器注入（None = 检索回落关键词基线）/行为准则层文本
    （None = 不注入）/运行数据目录（模型档案与连接配置回落根；None = 不注入）。

    data_dir 经此落宿主（壳侧 make_host 装配入口），使 resolve_llm 的
    model_connection.json 二次回落与压缩阈值档案读取可在真实运行期生效
    （boot_inkling 复用本宿主，故 data_dir 必须从装配期即注入，不能等 boot）。
    """
    from inkling_host.host import InKlingHost

    return InKlingHost(
        storage_uri=storage_uri,
        llm=llm,
        transport=transport,
        embedder=embedder,
        behavior=behavior,
        data_dir=data_dir,
    )


async def _tune_round_end(runtime: Any, result: Any) -> None:
    """主回合入口收尾调参（E-P5 接线；best-effort，不阻断结果回流）。

    信号口径与引擎 ``Runtime._tune_round_end`` 一致：结果缺失或携带
    error = 失败信号（调参按失败率聚合）；调参失败只记日志。
    """
    try:
        error = getattr(result, "error", None)
        runtime.tune_after_round(
            failed=result is None or bool(error),
            error=(
                str(error)
                if error
                else ("回合执行异常（无结果）" if result is None else "")
            ),
        )
    except Exception as exc:  # noqa: BLE001 —— 调参是增强，失败不阻断结果
        logger.warning("回合收尾调参失败（忽略）: %s", exc)


async def execute_round_to_reply(
    runtime,
    host,
    *,
    input_text: str,
    thread_id: str,
    round_id: str,
    step_args: dict | None = None,
    orchestrate: dict | None = None,
    inject: dict | None = None,
    model: dict | None = None,
    auto_accept_review: bool = True,
    max_cards: int = 32,
):
    """执行一次回合直至终态：审批卡逐张决议（可指定接受决议），直到回复/终止。

    生产宿主按审批卡交互决议；离线验证用 auto_accept_review 一次跑通。
    编排脚本（orchestrate）非空时注入回合入口状态——编排节点按
    plan/spawns/simulate 保留键驱动；缺省走工作流节点序默认规划。
    model（可选 {provider, model_id}）= 输入框选定的 agent 模型：回合
    级解析换入 llm_decider holder（fail-open——解析失败/缺引用回落
    会话默认模型），回合结束恢复（防中断态/后续回合串模型）。
    回合收尾（E-P5）按结果失败信号调参（runtime.tune_after_round，
    best-effort）；llm_usage 事件帧随传输收集（指标快照消费）。
    """
    result = None
    model_restore = _round_model_override(runtime, host, model)
    try:
        state = {"input": input_text, "step_args": step_args or {}}
        if orchestrate is not None:
            state["orchestrate"] = orchestrate
        result = await runtime.engine.ainvoke(
            state,
            thread_id=thread_id,
            round_id=round_id,
            transports=[_usage_collecting_transport(host.build_transport())],
            inject=inject or {},
            continue_chain=True,
        )
        guard = 0
        while result.reason == "interrupted" and auto_accept_review and guard < max_cards:
            guard += 1
            interrupt = await runtime.engine.get_latest_interrupt(thread_id)
            if interrupt is None:
                break
            # 决议值形态（注入值本身）：resume_run 内部再按卡键包一层
            # inject={interrupt.key: decision}，此处传决议值而非嵌套字典
            result = await runtime.resume_run(
                thread_id,
                "accept",
                round_id=f"{round_id}-resume-{guard}",
                transports=[_usage_collecting_transport(host.build_transport())],
            )
        return {"reason": result.reason, "state": dict(getattr(result, "state", {}) or {})}
    finally:
        _restore_round_model_override(model_restore)
        await _tune_round_end(runtime, result)


def _round_model_override(runtime: Any, host: Any, model: Any) -> Any:
    """回合级模型覆盖：按选模型解析换入 holder llm（fail-open 回落默认）。

    Returns:
        (holder, old_llm, old_window) 恢复元组；未解析/无注册表 = None。
    """
    if not model or not isinstance(model, dict):
        return None
    provider = str(model.get("provider") or "")
    model_id = str(model.get("model_id") or "")
    resolve = getattr(host, "resolve_model_llm", None)
    if not provider or not model_id or not callable(resolve):
        return None
    llm = resolve(provider, model_id)
    if llm is None:
        return None
    registries = getattr(runtime, "graph_registries", None)
    if registries is None:
        return None
    from inkling_host.graph_recipe import (
        _specs_holder,
        install_context_window,
    )
    from inkling_host.host import _model_context_window_from_archive

    holder = _specs_holder(registries)
    old_llm = holder.get("llm")
    holder["llm"] = llm
    # 窗口参数按该模型档案同步（工具结果截断数据面；回合级覆盖不换
    # 全局压缩策略——防中断态/后续回合串状态）
    old_window = None
    archive_window = _model_context_window_from_archive(
        getattr(host, "_data_dir", None), model_id
    )
    if archive_window is not None:
        from inkling_host.graph_recipe import _context_window

        old_window = _context_window
        install_context_window(archive_window)
    return (holder, old_llm, old_window)


def _restore_round_model_override(restore: Any) -> None:
    """回合级模型覆盖恢复（holder llm + 窗口原样还原）。"""
    if restore is None:
        return
    holder, old_llm, old_window = restore
    try:
        if old_llm is None:
            holder.pop("llm", None)
        else:
            holder["llm"] = old_llm
        if old_window is not None:
            from inkling_host.graph_recipe import install_context_window

            install_context_window(old_window)
    except Exception as exc:  # 恢复失败不阻断回合结果回流
        logger.warning("回合模型覆盖恢复失败（忽略）: %s", exc)


async def stop_runtime(runtime) -> None:
    """关停运行时（幂等；排队等完成/关 MCP/关存储/宿主钩子由引擎保证）。

    关停同时解绑模块级运行时句柄——装配期外的操作通道回到
    「未装配」显式报错态（进程级单例语义：宿主回收后不得再被
    误用；测试环境依赖此语义恢复前置条件）。
    """
    await runtime.stop()
    bind_runtime(None, None)
    bind_callback_host(None)


def boot_summary(runtime):
    """装配摘要：工具清单/事件类型清单（宿主观测与门禁断言）。"""
    names = sorted({spec.name for spec in runtime.collect_specs()})
    events = sorted(runtime.event_type_registry.names())
    return {"tool_names": names, "event_types": events}


def retrieval_source_names(runtime):
    """装配期检索源清单（来源名；断言 embedding 出厂注入/关键词基线）。"""
    try:
        return sorted(runtime.retriever_registry.names())
    except Exception:
        return []


async def check_embedding_protocol(runtime, embedder, query: str = "墨引擎") -> float:
    """嵌入协议验证：Rust 嵌入器引擎适配桥评分一轮（可等待对象双向桥）。"""
    from inkling_host.assembly_domain import EngineEmbedderBridge

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

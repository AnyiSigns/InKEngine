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

    # ── 补丁链（应用/回退/提案/目标注册）──

    @op_async("patch.apply")
    async def _patch_apply(args: dict) -> Any:
        from ink_engine.core.self_proposal import SelfProposal

        runtime = runtime_handle()
        proposal = SelfProposal.from_dict(
            {
                "kind": args["kind"],
                "payload": args["payload"],
                "base_version": int(args.get("base_version") or 1),
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

    # ── 工具表/流水线/审批──

    @op_sync("engine.tool_registry_remove")
    def _tool_registry_remove(args: dict) -> Any:
        runtime = runtime_handle()
        removed = runtime.tool_registry.pop(args["name"], None)
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

    # ── MCP 挂载（连接/工具导入/断开）──

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
            transports=[host_handle().build_transport()],
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
            transports=[collector],
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
    return assemble_plan(request, audit_sink=audit_sink)


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
    from inkling_host.quality import (
        DomainQualityGate,
        approval_tier_to_max_safety_tier,
    )
    from ink_engine.core.path_assembler import (
        AssemblyEnvelope,
        AssemblyRequest,
        InMemoryPoolRetriever,
    )
    from ink_engine.core.schema_validator import SchemaSpec

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
    envelope = AssemblyEnvelope(llm_draft=use_draft)
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
        }
    )


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
    _PATH_FLAGS = dict(flags.to_dict())
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
    # 单块翻转：保留其余装配开关，只改多径位
    global _PATH_FLAGS
    flags = dict(_PATH_FLAGS or {})
    flags["multipath_enabled"] = enabled
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


@op_async("metrics.snapshot")
async def _metrics_snapshot(args: dict) -> dict[str, Any]:
    """指标快照聚合 op：回合/LLM/缓存/边证据指标汇成单一观测快照。

    输入（各块缺省容错，缺块 = 0/空，不报错）：
    - ``turn_metrics``：TurnMetrics.snapshot 形态（turns/failures/...
      /llm_calls_by_tier）；
    - ``llm_usage``：LLM usage 帧清单（每帧 ``prompt_tokens``/
      ``completion_tokens``，来自 LLMChunk/LLMResult.usage 捕获点）；
    - ``cache_stats``：path.assemble 回传的 cache_hits/cache_misses/
      cache_invalidations/cache_replacements；
    - ``cache_entries``：FingerprintCacheStore.count（缓存条目量）；
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

    occupancy = None
    occ = args.get("occupancy")
    if isinstance(occ, dict) and "current" in occ and "limit" in occ:
        current = _as_int(occ.get("current"))
        limit = _as_int(occ.get("limit"))
        over = (limit > 0) and (current > limit * 0.8)
        occupancy = {"current": current, "limit": limit, "over_threshold": over}

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


def make_host(*, storage_uri: str, transport, llm=None, embedder=None, behavior=None):
    """构造宿主五件套：存储 URI/事件传输（Rust 回桥）/模型实例注入/
    本地语义嵌入器注入（None = 检索回落关键词基线）/行为准则层文本
    （None = 不注入）。"""
    from inkling_host.host import InKlingHost

    return InKlingHost(
        storage_uri=storage_uri,
        llm=llm,
        transport=transport,
        embedder=embedder,
        behavior=behavior,
    )


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
    auto_accept_review: bool = True,
    max_cards: int = 8,
):
    """执行一次回合直至终态：审批卡逐张决议（可指定接受决议），直到回复/终止。

    生产宿主按审批卡交互决议；离线验证用 auto_accept_review 一次跑通。
    编排脚本（orchestrate）非空时注入回合入口状态——编排节点按
    plan/spawns/simulate 保留键驱动；缺省走工作流节点序默认规划。
    """
    state = {"input": input_text, "step_args": step_args or {}}
    if orchestrate is not None:
        state["orchestrate"] = orchestrate
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

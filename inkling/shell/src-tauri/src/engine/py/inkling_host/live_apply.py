"""活跃态应用目标补全 + 回退恢复：补丁落链即生效、回退即还原。

集补丁链是权威记录（重启经链恢复）；本模块补齐其余补丁类型的运行期
活跃态同步（配方已注册 TOOL/EVENT_TYPE，宿主已注册 ENVIRONMENT/
ARTIFACT）：
- UI：布局描述落链 → 内省界面快照即时切换（渲染器数据源）；
- THEME：主题 token 落链 → 内省界面快照的 theme 段即时合并；
- HARNESS：领域定义落链 → harness 注册表即时登记（新能力可检索）；
- RULE/KNOWLEDGE：规则/知识条目落链 → 知识集即时 upsert（调配器
  下一回合即检索命中，无需重启）。

回退恢复（restore_live_views）：链回退后活跃态回到链状态——界面/
主题/工具表/harness/知识集/环境/产物全部按最新组装形态重建（补丁链
为权威，回退不依赖「撤销钩子」逐条反做，而是整体重放最新链态）。
"""
from __future__ import annotations

import contextlib
from typing import Any

from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.knowledge_set import (
    KIND_RULE,
    KnowledgeEntry,
)
from ink_engine.core.self_application import ApplyTarget
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.ui_schema import UISchemaValidator


class UiApplyTarget(ApplyTarget):
    """UI 补丁活跃态生效：布局描述即时切入内省界面快照。"""

    name = "inkling.ui"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = payload.get("spec")
        if isinstance(spec, dict) and spec.get("root"):
            self._runtime.introspection_service._sources.ui_spec = spec


class ThemeApplyTarget(ApplyTarget):
    """THEME 补丁活跃态生效：token 增量合并进界面快照的 theme 段。

    主题 token 是界面快照的组成部分（渲染器经 token 取色）——落链即
    切换渲染主题；回退后经 restore_live_views 整体还原。
    """

    name = "inkling.theme"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return
        sources = self._runtime.introspection_service._sources
        spec = dict(sources.ui_spec or {})
        theme = dict(spec.get("theme") or {})
        theme.update(tokens)
        spec["theme"] = theme
        sources.ui_spec = spec


class HarnessApplyTarget(ApplyTarget):
    """HARNESS 补丁活跃态生效：领域定义即时登记（同名覆盖 = 配置驱动）。"""

    name = "inkling.harness"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        definition = payload.get("definition")
        if not isinstance(definition, dict):
            return
        parsed = HarnessDefinition.from_dict(definition)
        self._runtime.harness_registry.register(parsed)
        # 登记补丁来源 harness 名（回退注销清单：仅注销补丁定义，
        # 不动装配基线 harness 定义）
        _register_harness_patch_entry(self._runtime, parsed.name)


class ToolApplyTarget(ApplyTarget):
    """TOOL 补丁活跃态生效：声明式定义进注册表 + 统一工具表（挂载即生效）。

    与引擎侧 _ToolApplyTarget（bridge.py）同构：落链即进入下一回合工具
    表，无需重启——补齐 live_apply 注册表此前缺失的 TOOL 活跃态目标。
    """

    name = "inkling.tool"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = DeclarativeToolSpec.from_dict(payload)
        self._runtime.harness_registry.declarative.register_definition(spec)
        self._runtime.tool_registry[spec.name] = spec.to_spec()
        # 同步内省工具源，使工具立即在界面/装配可见（与 rebuild_declarative_tools 一致）
        self._runtime.introspection_service._sources.tools = self._runtime.collect_specs()
        # 单源 + 标签：tool_registry 变化后刷新检索索引（search_tools/
        # request_tool 与工具 tab 同源，避免新增工具检索不可见）
        self._runtime.refresh_tool_index()


class EventTypeApplyTarget(ApplyTarget):
    """EVENT_TYPE 补丁活跃态生效：事件类型注册表即时登记（新类型可渲染/校验）。

    与引擎侧 _EventTypeApplyTarget（bridge.py）同构：补齐 live_apply
    注册表此前缺失的 EVENT_TYPE 活跃态目标，落链即生效、无需重启。
    """

    name = "inkling.event_type"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = EventTypeSpec.from_dict(payload)
        self._runtime.event_type_registry.register(spec)


class KnowledgeApplyTarget(ApplyTarget):
    """KNOWLEDGE 补丁活跃态生效：条目即时 upsert 进知识集（调配器可见）。

    知识集 = 调配器检索源（五源之一）：落链即进入下一回合的检索命中
    范围，无需重启——与「知识注入 = 调配器思想复用」同一语义。条目
    id 登记进 runtime.patch_entries（回退恢复的撤销清单）。
    """

    name = "inkling.knowledge"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        entry = payload.get("entry")
        if not isinstance(entry, dict):
            return
        parsed = KnowledgeEntry.from_dict(entry)
        # 回退快照：就地修改前保留旧值（与 G1 回退侧契约）
        _snapshot_knowledge_before(self._runtime, parsed.id)
        _register_patch_entry(self._runtime, parsed.id)
        knowledge_set = self._runtime.knowledge_set
        if knowledge_set.get(parsed.id) is None:
            knowledge_set.add(parsed)
        else:
            # 身份字段（id/created_at）不可修正——整体字段替换其余全量
            changes = {
                key: value
                for key, value in parsed.to_dict().items()
                if key not in ("id", "created_at")
            }
            knowledge_set.update(parsed.id, **changes)


class RuleApplyTarget(ApplyTarget):
    """RULE 补丁活跃态生效：规则声明即时进知识集（kind=rule 条目）。

    规则快照（inspect_rules）与规则检索都读知识集——落链即规则集
    生效，无需重启。条目 id 登记进 runtime.patch_entries（回退撤销
    清单，与 KNOWLEDGE 补丁同一机制）。
    """

    name = "inkling.rule"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        rule = payload.get("rule")
        if not isinstance(rule, dict):
            return
        rule_id = str(rule.get("id") or payload.get("rule_id") or "rule")
        # 回退快照：就地修改前保留旧值（与 G1 回退侧契约）
        _snapshot_knowledge_before(self._runtime, rule_id)
        parsed = KnowledgeEntry(
            id=rule_id,
            level="project",
            kind=KIND_RULE,
            data={"rule": rule},
            source="model",
            title=str(rule.get("message") or rule_id)[:80],
        )
        _register_patch_entry(self._runtime, parsed.id)
        knowledge_set = self._runtime.knowledge_set
        if knowledge_set.get(parsed.id) is None:
            knowledge_set.add(parsed)
        else:
            knowledge_set.update(parsed.id, data={"rule": rule}, title=parsed.title)


def _register_patch_entry(runtime: Any, entry_id: str) -> None:
    """登记补丁来源条目 id（回退恢复的撤销清单；宿主 boot 时初始化）。"""
    registry = getattr(runtime, "patch_entries", None)
    if registry is None:
        registry = set()
        runtime.patch_entries = registry
    registry.add(entry_id)


def _register_harness_patch_entry(runtime: Any, name: str) -> None:
    """登记补丁来源 harness 名（回退注销清单；宿主 boot 时初始化）。"""
    registry = getattr(runtime, "harness_patch_entries", None)
    if registry is None:
        registry = set()
        runtime.harness_patch_entries = registry
    registry.add(name)


def _snapshot_knowledge_before(runtime: Any, entry_id: str) -> None:
    """知识「就地修改」回退快照：apply 前把旧值写入 runtime 契约字段。

    与 G1 约定的回退契约：``runtime.knowledge_before_snapshots[entry_id]``
    = 应用前条目 dict（None 表示该条目为新建）；回退侧据此还原旧值或
    删除新建条目，避免就地修改的回退被误判为「删除」语义。
    """
    snapshots = getattr(runtime, "knowledge_before_snapshots", None)
    if snapshots is None:
        snapshots = {}
        runtime.knowledge_before_snapshots = snapshots
    existing = runtime.knowledge_set.get(entry_id)
    snapshots[entry_id] = existing.to_dict() if existing is not None else None


def register_live_targets(runtime: Any) -> None:
    """注册全部活跃态目标（配方目标 + 本模块补齐的五类）。

    目标钩子幂等可重放：补丁落链时同步当前进程活跃态；重启装配从链
    恢复，不依赖钩子重放（补丁链是权威记录）。
    """
    pipeline = runtime.self_pipeline
    pipeline.register_target(PatchKind.UI, UiApplyTarget(runtime))
    pipeline.register_target(PatchKind.THEME, ThemeApplyTarget(runtime))
    pipeline.register_target(PatchKind.HARNESS, HarnessApplyTarget(runtime))
    pipeline.register_target(PatchKind.RULE, RuleApplyTarget(runtime))
    pipeline.register_target(PatchKind.KNOWLEDGE, KnowledgeApplyTarget(runtime))
    # TOOL/EVENT_TYPE 活跃态目标（此前缺失：落链即生效，无需重启）
    pipeline.register_target(PatchKind.TOOL, ToolApplyTarget(runtime))
    pipeline.register_target(PatchKind.EVENT_TYPE, EventTypeApplyTarget(runtime))


def restore_live_views(
    runtime: Any,
    assembled: dict[str, Any],
    *,
    base_event_names: tuple[str, ...] = (),
    base_ui_spec: dict[str, Any] | None = None,
) -> None:
    """链回退/重启后的活跃态整体还原（最新组装形态 = 权威）。

    逐段恢复（各自容错，坏段跳过不击穿）：界面/主题（无链覆盖回落
    基线）→ harness（登记位语义，只增不减）→ 知识集（补丁来源条目
    与链态对齐，就地增删——种子只读基线不动）→ 事件类型（链外类型
    注销——注册表有注销原语，回退即撤销登记位）。工具表重建由宿主
    在回退通知中另行执行（rebuild_declarative_tools）。
    """
    restore_ui_theme(runtime, assembled, base_ui_spec=base_ui_spec)
    restore_harness_views(runtime, assembled)
    restore_knowledge_view(runtime, assembled)
    restore_event_types(runtime, assembled, base_event_names=base_event_names)
    restore_component_manifest(runtime, assembled)


def restore_component_manifest(runtime: Any, assembled: dict[str, Any]) -> None:
    """产物段恢复：链内组件声明 → 重建前端组件清单（components/manifest.json）。

    补丁链是权威记录：链内产物带 meta.component → 清单条目；回退后
    链外产物自动移除。构建域未装配 = 跳过（清单是派生数据，可重建）。
    """
    build_domain = getattr(runtime, "builds", None)
    if build_domain is None:
        return
    with contextlib.suppress(Exception):
        build_domain.sync_component_manifest(assembled.get("artifacts") or {})


def restore_ui_theme(
    runtime: Any,
    assembled: dict[str, Any],
    *,
    base_ui_spec: dict[str, Any] | None = None,
) -> None:
    """界面/主题段恢复：最新链态覆盖内省快照（校验通过才生效）。

    链上无界面/主题覆盖 = 回落装配基线（base_ui_spec 原样还原——
    回退撤销即回到出厂形态）；有覆盖 = 链态生效（主题增量合并进
    界面快照的 theme 段）。
    """
    sources = runtime.introspection_service._sources
    validator = UISchemaValidator()
    recipe = getattr(runtime, "_recipe", None)
    allowed_components = tuple(
        getattr(recipe, "ui_allowed_components", None) or ()
    )
    allowed_channels = tuple(getattr(recipe, "ui_allowed_channels", None) or ())
    allowed_tokens = tuple(
        getattr(recipe, "ui_allowed_theme_tokens", None) or ()
    )
    ui_state = assembled.get("ui") or {}
    theme_tokens = assembled.get("theme") or {}
    if not ui_state and not theme_tokens:
        if isinstance(base_ui_spec, dict) and base_ui_spec.get("root"):
            sources.ui_spec = base_ui_spec  # 回退撤销：回落出厂基线
        return
    if isinstance(ui_state, dict):
        spec = ui_state.get("boot.panel") or ui_state.get(next(iter(ui_state), ""))
        if isinstance(spec, dict) and spec.get("root"):
            violations = validator.validate(
                spec,
                allowed_components=allowed_components,
                allowed_channels=allowed_channels,
                allowed_theme_tokens=allowed_tokens,
            )
            if not violations:
                sources.ui_spec = spec
    if isinstance(theme_tokens, dict) and theme_tokens:
        spec = dict(sources.ui_spec or {})
        theme = dict(spec.get("theme") or {})
        theme.update(theme_tokens)
        spec["theme"] = theme
        sources.ui_spec = spec


def restore_harness_views(runtime: Any, assembled: dict[str, Any]) -> None:
    """harness 段恢复：链内定义登记 + 补丁来源定义回退注销。

    仅注销「由补丁链注入、且已不在链内」的 harness 定义（harness_patch_entries
    登记位区分于装配基线定义），避免回退时误注销基线 harness 定义。
    """
    registry = runtime.harness_registry
    chain_names = set((assembled.get("harness") or {}).keys())
    for name, definition in (assembled.get("harness") or {}).items():
        if not isinstance(definition, dict) or name in registry.names():
            continue
        with contextlib.suppress(Exception):
            registry.register(HarnessDefinition.from_dict(definition))
    # 回退：补丁来源定义不在链内 = 注销（撤销登记位，不触基线定义）
    patch_names = getattr(runtime, "harness_patch_entries", None)
    if not patch_names:
        return
    for name in [n for n in patch_names if n not in chain_names]:
        with contextlib.suppress(Exception):
            registry.unregister(name)
        patch_names.discard(name)


def restore_knowledge_view(runtime: Any, assembled: dict[str, Any]) -> None:
    """知识段恢复：补丁来源条目与链态就地对齐（检索/内省立即反映回退）。

    就地增删（不重建实例——调配器/检索源持有同一知识集引用）：
    - 补丁来源条目（runtime.patch_entries 登记）不在链内 = 回退撤销：
      新建条目（无 before 快照）从知识集删除；就地修改条目按
      knowledge_before_snapshots 还原旧值（避免回退误删为「删除」语义）；
    - 链内条目未在集内 = 补挂（重启装配后链态与活跃态对齐）；
    - 种子条目（seed. 前缀）是只读基线，任何回退不动。
    """
    knowledge_set = runtime.knowledge_set
    patch_entries = getattr(runtime, "patch_entries", None)
    tracked = set(patch_entries) if patch_entries is not None else set()
    chain_entries = assembled.get("knowledge") or {}
    if not isinstance(chain_entries, dict):
        return
    snapshots = getattr(runtime, "knowledge_before_snapshots", None) or {}
    for entry_id in tracked:
        if entry_id in chain_entries:
            continue
        before = snapshots.get(entry_id)
        if before is None:
            # 新建条目回退 = 删除（其 before 不存在）
            knowledge_set.remove(entry_id)
        else:
            # 就地修改回退 = 还原修改前旧值（非删除）
            changes = {
                key: value
                for key, value in before.items()
                if key not in ("id", "created_at")
            }
            knowledge_set.update(entry_id, **changes)
        if patch_entries is not None:
            patch_entries.discard(entry_id)
        snapshots.pop(entry_id, None)
    for entry_id, raw in chain_entries.items():
        if not isinstance(raw, dict):
            continue
        try:
            parsed = KnowledgeEntry.from_dict(raw)
        except Exception:
            continue
        if knowledge_set.get(entry_id) is None:
            knowledge_set.add(parsed)
        else:
            changes = {
                key: value
                for key, value in parsed.to_dict().items()
                if key not in ("id", "created_at")
            }
            knowledge_set.update(entry_id, **changes)


def restore_event_types(
    runtime: Any,
    assembled: dict[str, Any],
    *,
    base_event_names: tuple[str, ...] = (),
) -> None:
    """事件类型段恢复：链外类型注销（回退 = 登记位撤销，活跃态与链一致）。

    链内类型（装配基线 + 演化补丁）保留；已登记但不在链内 = 回退撤销
    的类型——注册表提供注销原语，回退即从运行期登记位消失。
    """
    registry = runtime.event_type_registry
    chain_names = set(assembled.get("event_types") or {})
    base_names = set(base_event_names)
    for name in list(registry.names()):
        if name in chain_names or name in base_names:
            continue
        with contextlib.suppress(Exception):
            registry.unregister(name)


def rebuild_declarative_tools(
    runtime: Any, base_tools: list[dict[str, Any]], assembled: dict[str, Any]
) -> None:
    """声明式工具表全量重建（基线 + 链工具 + 产物工具；回退 = 链外移除）。

    补丁链是权威记录：链内工具注册、链外移除——回退一个 TOOL/ARTIFACT
    补丁即从工具表消失（活跃态与链一致，不依赖逐条撤销钩子）。
    """
    defs: dict[str, DeclarativeToolSpec] = {}
    for raw in base_tools:
        try:
            spec = DeclarativeToolSpec.from_dict(raw)
        except Exception:
            continue
        defs[spec.name] = spec
    for name, payload in (assembled.get("tools") or {}).items():
        if not isinstance(payload, dict):
            continue
        try:
            defs[name] = DeclarativeToolSpec.from_dict(payload)
        except Exception:
            continue
    for payload in (assembled.get("artifacts") or {}).values():
        if not isinstance(payload, dict):
            continue
        tool_data = (payload.get("meta") or {}).get("tool")
        if not isinstance(tool_data, dict):
            continue
        try:
            spec = DeclarativeToolSpec.from_dict(tool_data)
        except Exception:
            continue
        defs[spec.name] = spec

    registry = runtime.harness_registry.declarative
    for name in list(registry.definitions):
        if name not in defs:
            registry.unregister_definition(name)
            runtime.tool_registry.pop(name, None)
    for name, spec in defs.items():
        registry.register_definition(spec)
        runtime.tool_registry[name] = spec.to_spec()
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    runtime.refresh_tool_index()


__all__ = [
    "HarnessApplyTarget",
    "KnowledgeApplyTarget",
    "RuleApplyTarget",
    "ThemeApplyTarget",
    "UiApplyTarget",
    "rebuild_declarative_tools",
    "register_live_targets",
    "restore_component_manifest",
    "restore_event_types",
    "restore_harness_views",
    "restore_knowledge_view",
    "restore_live_views",
    "restore_ui_theme",
]

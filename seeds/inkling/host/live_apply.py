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
    """harness 段恢复：链内定义登记（与装配期恢复同路径）。"""
    registry = runtime.harness_registry
    for name, definition in (assembled.get("harness") or {}).items():
        if not isinstance(definition, dict) or name in registry.names():
            continue
        with contextlib.suppress(Exception):
            registry.register(HarnessDefinition.from_dict(definition))


def restore_knowledge_view(runtime: Any, assembled: dict[str, Any]) -> None:
    """知识段恢复：补丁来源条目与链态就地对齐（检索/内省立即反映回退）。

    就地增删（不重建实例——调配器/检索源持有同一知识集引用）：
    - 补丁来源条目（runtime.patch_entries 登记）不在链内 = 回退撤销，
      从知识集删除；
    - 链内条目未在集内 = 补挂（重启装配后链态与活跃态对齐）；
    - 种子条目（seed. 前缀）是只读基线，任何回退不动。
    """
    knowledge_set = runtime.knowledge_set
    patch_entries = getattr(runtime, "patch_entries", None)
    tracked = set(patch_entries) if patch_entries is not None else set()
    chain_entries = assembled.get("knowledge") or {}
    if not isinstance(chain_entries, dict):
        return
    for entry_id in tracked:
        if entry_id not in chain_entries:
            knowledge_set.remove(entry_id)
            if patch_entries is not None:
                patch_entries.discard(entry_id)
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


__all__ = [
    "HarnessApplyTarget",
    "KnowledgeApplyTarget",
    "RuleApplyTarget",
    "ThemeApplyTarget",
    "UiApplyTarget",
    "rebuild_declarative_tools",
    "register_live_targets",
    "restore_event_types",
    "restore_harness_views",
    "restore_knowledge_view",
    "restore_live_views",
    "restore_ui_theme",
]

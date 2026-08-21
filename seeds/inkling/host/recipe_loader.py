"""装配配方数据映射：只读 ``seed_data/`` JSON → :class:`AssemblyRecipe`。

本模块是纯数据映射层（PLAN §2 公理二「知识是数据」的装配侧实现）：
- 零领域逻辑——所有产品语义都住在 JSON 数据里，这里只做形态转换；
- 17 个配方字段逐字段落值，每个字段都有明确的数据来源与推导规则
  （见各 ``map_*`` 函数 docstring）；
- 不确定的映射（挂载类工具 → 审批分级、L2 验证钩子）以数据为准，
  缺省值都写在数据里，映射规则可审计。

「怎么装配引擎 = 数据」：宿主换壳 = 换配方，机制层不感知宿主形态。
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.introspection import introspection_tool_specs
from ink_engine.core.knowledge_set import KnowledgeEntry
from ink_engine.core.runtime import AssemblyRecipe, GraphRecipeContext, ToolWiring
from ink_engine.core.schema_validator import SchemaSpec
from ink_engine.core.self_application import (
    DEFAULT_APPROVAL_LEVELS,
    ApplyTarget,
    ApprovalLevel,
)
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs

from .graph_recipe import build_round_graph
from .scoring import dimension_scorer_with_facts

# seed_data 目录下的数据文件名（与 schema 校验脚本同源，17 个文件）
SEED_DATA_FILES: tuple[str, ...] = (
    "boot_prompt.json",
    "ui_spec.json",
    "event_types.json",
    "graph.json",
    "tools.json",
    "rules.json",
    "samples.json",
    "templates.json",
    "knowledge.json",
    "workflow.json",
    "signals.json",
    "tiers.json",
    "review.json",
    "memory.json",
    "env.json",
    "mcp_market.json",
    "build.json",
)

# 域名种子注入清单名（稳定键，供幂等注入与回退锚点）
_DOMAIN_SEED_NAME = "inkling.domain"

# 挂载类工具名：外部能力接入须 L2 人工审批（工具规则条目 seed.inkling.tool_rule.mcp_mount）
_MOUNT_TOOL_NAME = "propose_mcp_mount"

# 内省五元工具名（与引擎 introspection_tool_specs 同源，防魔法字符串漂移）
_INSPECT_TOOL_NAMES: frozenset[str] = frozenset(
    spec.name for spec in introspection_tool_specs()
)


@dataclass(frozen=True, slots=True)
class SeedDataBundle:
    """seed_data 目录的只读装载产物（文件名 → 解析后的 dict）。"""

    root: Path
    data: dict[str, Any] = field(default_factory=dict)


def load_seed_data(root: Path) -> SeedDataBundle:
    """装载 seed_data 目录（缺文件/坏 JSON 显式报错，不静默跳过）。"""
    loaded: dict[str, Any] = {}
    for name in SEED_DATA_FILES:
        path = root / "seed_data" / name
        if not path.is_file():
            raise FileNotFoundError(f"seed_data 缺文件: {path}")
        loaded[name] = json.loads(path.read_text(encoding="utf-8"))
    return SeedDataBundle(root=root, data=loaded)


# ── 界面三层白名单映射 ──


def _walk_bind_channels(node: dict[str, Any], out: set[str]) -> None:
    """递归收集 ui_spec 布局树中的绑定通道（bind.channel）。"""
    bind = node.get("bind")
    if isinstance(bind, dict) and isinstance(bind.get("channel"), str):
        out.add(bind["channel"])
    for child in node.get("children") or ():
        if isinstance(child, dict):
            _walk_bind_channels(child, out)


def map_ui_allowed_channels(bundle: SeedDataBundle) -> tuple[str, ...]:
    """界面绑定通道白名单（三层白名单之一，校验器与渲染器同源）。

    推导规则 = 三源并集（缺一不可，防绑定遗漏被静默拒绝）：
    1. ui_spec 布局树实际使用的 bind.channel；
    2. event_types.json 全部事件名（以 ``events.<name>`` 形态放行——
       事件流绑定通道按注册表放行，未注册事件名不进入白名单）；
    3. 内省五元快照通道（inspect_*，引擎 introspection 工具名同源）。
    """
    ui_spec = bundle.data["ui_spec.json"]
    channels: set[str] = set()
    root = ui_spec.get("root")
    if isinstance(root, dict):
        _walk_bind_channels(root, channels)
    for spec in bundle.data["event_types.json"].get("events") or ():
        channels.add(f"events.{spec['name']}")
    channels.update(_INSPECT_TOOL_NAMES)
    return tuple(sorted(channels))


def map_ui_allowed_components(bundle: SeedDataBundle) -> tuple[str, ...]:
    """界面组件白名单（manifest 契约清单 = 出厂渲染组件集合）。"""
    manifest = json.loads((bundle.root / "manifest.json").read_text(encoding="utf-8"))
    return tuple(manifest["contracts"]["renderer_components"])


def map_ui_allowed_theme_tokens(bundle: SeedDataBundle) -> tuple[str, ...]:
    """主题 token 白名单（ui_spec.theme 的全部语义键，组件经 token 取色）。"""
    theme = bundle.data["ui_spec.json"].get("theme") or {}
    return tuple(sorted(theme))


# ── 事件类型 / harness / 种子映射 ──


def map_event_type_specs(bundle: SeedDataBundle) -> list[EventTypeSpec]:
    """事件类型基线（装配期登记 + 集内演化类型加载的数据形态）。"""
    specs: list[EventTypeSpec] = []
    for raw in bundle.data["event_types.json"].get("events") or ():
        schema = raw.get("schema")
        specs.append(
            EventTypeSpec(
                name=raw["name"],
                schema=SchemaSpec.from_dict(schema) if isinstance(schema, dict) else None,
                renderer=str(raw.get("renderer") or ""),
                system=bool(raw.get("system", False)),
                meta=dict(raw.get("meta") or {}),
            )
        )
    return specs


def map_harness_definitions(bundle: SeedDataBundle) -> list[HarnessDefinition]:
    """自举 harness 定义（领域工具清单数据形态，注册 + 仓库落库）。

    harness 的工具清单 = tools.json 全文（声明式工具定义数据），
    与「工具声明必须走补丁链演化管线产出」的约束同源。
    """
    return [
        HarnessDefinition(
            name="inkling.research",
            description="知识/研究孵化领域 harness（数据形态：领域工具清单 + 领域基线）",
            keywords=("research", "knowledge", "incubation"),
            tools=tuple(bundle.data["tools.json"].get("tools") or ()),
            graph=None,
            schema=None,
            default_plan=None,
            meta={"domain_boot": "知识/研究孵化"},
        )
    ]


def _entry_from_data(raw: dict[str, Any]) -> KnowledgeEntry:
    """seed_data 知识条目/模板条目的直注形态（字段名与 KnowledgeEntry 对齐）。"""
    return KnowledgeEntry(
        id=str(raw["id"]),
        level=str(raw["level"]),
        kind=str(raw["kind"]),
        data=dict(raw.get("data") or {}),
        source=str(raw.get("source") or "model"),
        credibility=float(raw.get("credibility", 0.9)),
        title=str(raw.get("title") or ""),
        tags=tuple(raw.get("tags") or ()),
    )


def _domain_seed_provider(bundle: SeedDataBundle) -> Callable[[], list[KnowledgeEntry]]:
    """领域种子注入直注形态（seed_knowledge_set 幂等跳过已存在条目）。

    数据来源：knowledge.json（规则/权重/工具规则条目）+ templates.json
    （编排模板条目）。rules.json 的谓词规则不进知识集——谓词实现是
    执行件（Rust），知识集只承载可序列化的声明数据（执行件不进知识集）。
    """

    def provider() -> list[KnowledgeEntry]:
        entries = []
        for raw in bundle.data["knowledge.json"].get("entries") or ():
            entries.append(_entry_from_data(raw))
        for raw in bundle.data["templates.json"].get("templates") or ():
            entries.append(_entry_from_data(raw))
        return entries

    return provider


def map_seed_providers(
    bundle: SeedDataBundle,
) -> list[tuple[str, Callable[[], list[KnowledgeEntry]]]]:
    """配方 seeds 直注清单（通用基线由引擎恒注，这里只挂领域种子）。"""
    return [(_DOMAIN_SEED_NAME, _domain_seed_provider(bundle))]


# ── 工具三路 / 审批分级 / 验证钩子映射 ──


def map_tool_wiring() -> ToolWiring:
    """统一工具分发三路声明（内省/自指/声明式）。

    三路本身是引擎机制（Runtime 装配），宿主差异只在这三个工厂：
    - 自指工具规格/执行器/操作判定 = 引擎内核实现（self_tools）；
    - 内省与声明式两路由 Runtime 按工具名路由，无需宿主注入。
    """
    return ToolWiring(
        self_specs=self_tool_specs,
        self_executor_factory=make_self_executor,
        self_operation_of=operation_of,
    )


def declarative_specs_from_tools(bundle: SeedDataBundle) -> list[DeclarativeToolSpec]:
    """tools.json → 声明式工具定义清单（挂载进统一工具表的数据形态）。

    工具条目的额外字段（approval/network_policy/meta）原样保留在
    定义数据里：approval 进档位表（SecurityDomain 三档门禁消费）；
    network_policy 折叠进 meta（DeclarativeToolSpec 无顶层字段，折叠
    后随定义持久化，端点沙箱/执行体按声明消费）；meta 原样透传。
    """
    specs: list[DeclarativeToolSpec] = []
    for raw in bundle.data["tools.json"].get("tools") or ():
        raw = dict(raw)
        meta = dict(raw.get("meta") or {})
        policy = raw.get("network_policy")
        if isinstance(policy, dict) and "network_policy" not in meta:
            meta["network_policy"] = policy
        raw["meta"] = meta
        specs.append(DeclarativeToolSpec.from_dict(raw))
    return specs


def map_approval_levels(bundle: SeedDataBundle) -> dict[PatchKind, ApprovalLevel]:
    """审批分级表（kind → L0/L1/L2）。

    映射规则（数据驱动，见 knowledge.json 工具规则条目）：
    - 基线 = 引擎默认分级表（THEME/UI 直过、知识/规则/工具/环境 L1、
      构建产物 L2）；
    - 挂载类工具（propose_mcp_mount）要求 L2 人工审批——外部能力接入
      一律走提案 → 审批 → 补丁链（出厂零预挂），故 TOOL 补丁整体
      升到 L2（L2 验证钩子放行非挂载类工具补丁，见 vetting 映射）。
    """
    levels = dict(DEFAULT_APPROVAL_LEVELS)
    tool_names = {t.get("name") for t in bundle.data["tools.json"].get("tools") or ()}
    if _MOUNT_TOOL_NAME in tool_names:
        levels[PatchKind.TOOL] = ApprovalLevel.L2
    return levels


def build_mcp_l2_vetting_hook() -> tuple[
    Callable[[Any], list[str]], Callable[..., None]
]:
    """L2 验证钩子（挂载类工具补丁的部署前门禁）+ 放行登记器。

    钩子语义（fail-closed）：TOOL 补丁若为 MCP 端点工具，server 必须
    已通过挂载 vetting（地址解析 → 配置推导 → 清单一致性/命令白名单
    核对）并登记，且声明与影子清单一致（影子 = 导入期工具清单，不真
    执行——工具名/参数必填项比对，不一致拒绝挂载）；未登记 = 未经过
    vetting 的挂载不落链；非 MCP 工具补丁不在此钩子作用域（放行，
    交给审批分级）。
    登记器由挂载服务在 vetting 通过后调用（vetting → 审批 → L2 的
    顺序在机制上被强制执行）；登记时可携带导入期工具清单（影子记录）。
    """
    from .security_domain import ShadowVettingStore, build_security_l2_vetting_hook

    shadow = ShadowVettingStore()
    hook, mark_vetted = build_security_l2_vetting_hook(shadow)
    return hook, mark_vetted


# ── 调配域映射 ──


def map_retrieval_sources(bundle: SeedDataBundle) -> list[Callable[[Any], Any]]:
    """检索源工厂清单（装配期注册进 RetrieverRegistry）。

    数据来源：memory.json recall 配置（default_limit）→ 知识集检索源
    的召回上限；知识集条目按可信度分级注入（检索源工厂接收装配产物
    = Runtime，装配期取用 knowledge_set）。
    """
    from .assembly_domain import KnowledgeSetRetriever

    recall = bundle.data["memory.json"].get("recall") or {}
    limit = int(recall.get("default_limit", 8))

    def factory(runtime: Any) -> KnowledgeSetRetriever:
        return KnowledgeSetRetriever(runtime.knowledge_set, limit=limit)

    return [factory]


class ToolApplyTarget(ApplyTarget):
    """TOOL 补丁落链后的活跃态生效：声明式定义进注册表 + 统一工具表。

    挂载/工具补丁落链即生效（补丁链是权威记录，重启经链恢复；
    本钩子只做当前进程的活跃态同步）。
    """

    name = "inkling.tool"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = DeclarativeToolSpec.from_dict(payload)
        self._runtime.harness_registry.declarative.register_definition(spec)
        self._runtime.tool_registry[spec.name] = spec.to_spec()


class EventTypeApplyTarget(ApplyTarget):
    """EVENT_TYPE 补丁落链后的活跃态生效：注册进事件类型注册表。"""

    name = "inkling.event_type"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = EventTypeSpec.from_dict(payload)
        self._runtime.event_type_registry.register(spec)


def map_apply_targets() -> dict[PatchKind, Callable[[Any], ApplyTarget]]:
    """活跃态应用目标工厂（补丁落链后的运行时生效钩子）。

    - TOOL：声明式定义进注册表 + 统一工具表（挂载工具即刻可调）；
    - EVENT_TYPE：事件类型注册表即时生效（新事件类型可渲染/校验）。
    补丁链是权威记录，目标钩子只做活跃态同步（重启经链恢复）。
    """
    return {
        PatchKind.TOOL: lambda runtime: ToolApplyTarget(runtime),
        PatchKind.EVENT_TYPE: lambda runtime: EventTypeApplyTarget(runtime),
    }


# ── 执行域映射 ──


def map_review_scorer(
    bundle: SeedDataBundle,
) -> Callable[[Any, dict[str, Any]], dict[str, float]]:
    """review.json 打分配置 → 确定性维度打分器（推演分支评估用）。

    维度与权重来自 review.json；samples.json 顶层 facts 作为交叉验证
    锚点参与打分（评分交叉验证维度的数据来源）。
    """
    facts = [f.get("statement") for f in bundle.data["samples.json"].get("facts") or ()]
    scorer = dimension_scorer_with_facts(facts)
    return scorer


def map_graph_recipe(bundle: SeedDataBundle) -> Callable[[GraphRecipeContext], Any]:
    """图配方：seed_data/graph.json 建回合图（节点类型注册见 graph_recipe）。

    配方归宿主（图 = 宿主产品语义），装配动作归机制层——本闭包只
    把数据交给 build_round_graph，运行时从装配上下文取用工具流水线。
    """
    graph_data = bundle.data["graph.json"]
    workflow_data = bundle.data["workflow.json"]

    def graph_recipe(ctx: GraphRecipeContext) -> Any:
        return build_round_graph(
            ctx, graph_data=graph_data, workflow_data=workflow_data
        )

    return graph_recipe


# ── 装配配方组装 ──


def build_recipe(
    bundle: SeedDataBundle,
    *,
    l2_vetting_hook: Callable[[Any], list[str]] | None = None,
    on_reverted: Callable[[int, str], Any] | None = None,
) -> AssemblyRecipe:
    """把 seed_data 数据映射为完整装配配方（17 字段全落值）。

    Args:
        bundle: 装载产物（load_seed_data）。
        l2_vetting_hook: L2 验证钩子覆盖（缺省 = build_mcp_l2_vetting_hook
            产出的挂载放行钩子；宿主可用挂载服务的钩子替换）。
        on_reverted: 回退通知钩子（宿主行为信号；缺省不启用）。
    """
    hook, _mark = build_mcp_l2_vetting_hook()
    return AssemblyRecipe(
        set_id=_set_id(bundle),
        seeds=map_seed_providers(bundle),
        harness_definitions=map_harness_definitions(bundle),
        event_type_specs=map_event_type_specs(bundle),
        ui_spec=dict(bundle.data["ui_spec.json"]),
        ui_allowed_channels=map_ui_allowed_channels(bundle),
        ui_allowed_components=map_ui_allowed_components(bundle),
        ui_allowed_theme_tokens=map_ui_allowed_theme_tokens(bundle),
        tool_wiring=map_tool_wiring(),
        vetting_static_hooks=[],
        vetting_l2_hook=l2_vetting_hook or hook,
        approval_levels=map_approval_levels(bundle),
        retrieval_sources=map_retrieval_sources(bundle),
        apply_targets=map_apply_targets(),
        graph_recipe=map_graph_recipe(bundle),
        on_reverted=on_reverted,
        convergence_provider=None,
    )


def _set_id(bundle: SeedDataBundle) -> str:
    """用户集 id = manifest 身份登记 id（存储隔离键）。"""
    manifest = json.loads((bundle.root / "manifest.json").read_text(encoding="utf-8"))
    return str(manifest.get("id") or "inkling")


__all__ = [
    "SEED_DATA_FILES",
    "SeedDataBundle",
    "build_mcp_l2_vetting_hook",
    "build_recipe",
    "declarative_specs_from_tools",
    "load_seed_data",
    "map_apply_targets",
    "map_approval_levels",
    "map_event_type_specs",
    "map_graph_recipe",
    "map_harness_definitions",
    "map_retrieval_sources",
    "map_review_scorer",
    "map_seed_providers",
    "map_tool_wiring",
    "map_ui_allowed_channels",
    "map_ui_allowed_components",
    "map_ui_allowed_theme_tokens",
]

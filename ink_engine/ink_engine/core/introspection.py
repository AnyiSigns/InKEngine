"""自指层观察原语：引擎内省服务与 inspect_* 元工具。

观察工具是 AI 修改产品形态的前置通道——AI 先看清自己（图/规则/
知识/界面/工具表），再决定提案什么补丁。本模块只负责「读」：把引擎
持有的各类运行时数据整理为 JSON 快照，并以引擎工具描述（ToolSpec）
注册进工具表，经标准工具流水线（权限门禁/审计/截断）执行。

权限形态：``introspection:read:*``（自定义域，action=read，pattern=*）。
流水线判定动作固定为 (read, *)——纯只读通道，无任何外部操作目标，
不触发文件/进程/网络沙箱。

快照皆为确定性 JSON 数据（图结构/条目清单/工具清单），不包含模型
参数等运行期噪音；AI 消费快照后自行决策，引擎不做任何演化动作。
快照出口统一过敏感信息剥离（security.strip_sensitive）——观察通道
与落库通道同规格，凭据永不进入模型上下文。
"""

from __future__ import annotations

import copy
import json
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from .graph import Graph
from .harness import HarnessRegistry
from .knowledge_set import KIND_RULE, KnowledgeSet
from .llm.tools import ToolSpec
from .permissions import PermissionGate
from .rules import SEVERITY_ERROR
from .security import strip_sensitive
from .tool_pipeline import ToolPipeline

# 内省工具的统一权限声明（只读域；未命中默认拒绝，fail-closed）
INTROSPECTION_PERMISSION = "introspection:read:*"

# 判定动作（与权限声明中的 action 配对，流水线 extractor 返回）
_INTROSPECTION_OPERATION = "read"
_INTROSPECTION_TARGET = "*"

# 快照体积上限：知识快照默认条目数、单工具结果截断与工具 schema 声明的
# 条目上限（防超长结果挤爆上下文；限额与引擎工具流水线默认一致）
_DEFAULT_KNOWLEDGE_LIMIT = 20
_KNOWLEDGE_LIMIT_MAX = 100
_MAX_RESULT_CHARS = 100_000


@dataclass(slots=True)
class IntrospectionSources:
    """内省数据源集合（宿主装配时注入，缺省项在快照中按空态呈现）。

    Attributes:
        graph: 当前执行图（节点/边/出口/子图结构）。
        knowledge_set: 用户集知识实体（规则/知识条目）。
        harness_registry: 集内 harness 注册表（领域能力清单）。
        tools: 已注册的工具描述清单（含本组元工具自身）。
        ui_spec: 当前界面描述（JSON 布局，宿主渲染器消费；缺省 = 未定形）。
    """

    graph: Graph | None = None
    knowledge_set: KnowledgeSet | None = None
    harness_registry: HarnessRegistry | None = None
    tools: Sequence[ToolSpec] = field(default_factory=tuple)
    ui_spec: dict | None = None


def _edge_view(edge: Any) -> dict[str, Any]:
    """条件边降级视图：函数直挂条件（无名条件）无法序列化——边结构
    仍可观察（target + 条件类型标记），序列化契约破坏不击穿观察。"""
    view: dict[str, Any] = {"target": edge.target}
    if edge.condition is not None:
        view["condition"] = "function"
    else:
        view["condition"] = edge.condition_name
    return view


class IntrospectionService:
    """引擎内省服务：按工具名分发快照读取（单一入口，快照互相独立）。"""

    def __init__(self, sources: IntrospectionSources) -> None:
        self._sources = sources

    def set_graph(self, graph: Graph | None) -> None:
        """更新图数据源（宿主重建回合图时同步刷新观察视图）。"""
        self._sources.graph = graph

    def snapshot(self, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
        """按工具名返回对应快照；未知工具名显式拒绝（fail-closed）。

        警告：本方法返回未脱敏的原始快照，禁止裸调——须经
        :func:`build_introspection_pipeline` 出口（make_introspection_executor
        内 strip_sensitive）脱敏后，凭据等敏感键才不进入模型上下文。
        """
        if tool_name == "inspect_graph":
            return self.snapshot_graph()
        if tool_name == "inspect_rules":
            return self.snapshot_rules()
        if tool_name == "inspect_knowledge":
            return self.snapshot_knowledge(limit=args.get("limit"))
        if tool_name == "inspect_ui":
            return self.snapshot_ui()
        if tool_name == "inspect_tools":
            return self.snapshot_tools()
        raise ValueError(f"未知内省工具: {tool_name!r}")

    def snapshot_graph(self) -> dict[str, Any]:
        """图结构快照：恒定信封 {graph, digest}，内容随序列化能力分级。

        函数直挂节点无法序列化为数据（Graph.to_dict 显式拒绝）——内省
        是观察通道，遇此情形回退为逐节点结构快照（节点类型/可序列化
        配置/边/出口/子图递归），并在快照上标记 degraded 与原因，让
        AI 知道观察到的形态是降级视图，不让观察动作本身失败。
        """
        graph = self._sources.graph
        if graph is None:
            return {"graph": None, "digest": None}
        degraded = False
        reason: str | None = None
        try:
            data = graph.to_dict()
        except Exception as exc:
            degraded = True
            reason = str(exc)
            data = self._degraded_graph(graph)
        try:
            digest = graph.digest()
        except Exception as exc:
            degraded = True
            reason = reason or f"内容指纹计算失败: {exc}"
            digest = None
        if degraded:
            data["degraded"] = True
            data["degraded_reason"] = reason
        return {"graph": data, "digest": digest}

    def _degraded_graph(self, graph: Graph) -> dict[str, Any]:
        """降级视图：逐节点出结构信息（类型绑定 + 可序列化配置）。

        子图节点与正常序列化路径一致地经 subgraphs 递归呈现、不混入
        nodes；函数直挂节点标 ``function``；配置不可 JSON 序列化的
        节点只出类型名（结构仍可观察，内容契约破坏不击穿观察）。
        """
        bindings = graph.node_bindings or {}
        nodes: dict[str, dict[str, Any]] = {}
        for name in set(graph.nodes) | set(bindings):
            if name in (graph.subgraphs or {}):
                continue
            binding = bindings.get(name)
            if binding is None:
                nodes[name] = {"type": "function"}
                continue
            node: dict[str, Any] = {"type": binding.type_name}
            try:
                json.dumps(binding.config)
            except (TypeError, ValueError):
                pass
            else:
                node["config"] = copy.deepcopy(binding.config)
            nodes[name] = node
        edges = {
            source: [_edge_view(edge) for edge in edge_list]
            for source, edge_list in (graph.edges or {}).items()
        }
        return {
            "name": graph.name,
            "entry": graph.entry,
            "nodes": nodes,
            "edges": edges,
            "exits": sorted(graph.exits or set()),
            "subgraphs": {
                name: self._degraded_graph(sub)
                for name, sub in (graph.subgraphs or {}).items()
            },
            "schema": None,
        }

    def snapshot_rules(self) -> dict[str, Any]:
        """规则集快照：集内规则条目清单（id/严重级/说明/规则体）。"""
        knowledge = self._sources.knowledge_set
        if knowledge is None:
            return {"rules": [], "count": 0}
        rules: list[dict[str, Any]] = []
        for entry in knowledge.entries():
            if entry.kind != KIND_RULE:
                continue
            body = entry.data.get("rule", entry.data)
            rules.append(
                {
                    "id": body.get("id") if isinstance(body, dict) else None,
                    # 缺省严重度补全：声明数据省略默认 error 级（Rule.to_dict
                    # 不输出默认值），快照须呈现真实语义而非 null
                    "severity": (
                        body.get("severity") or SEVERITY_ERROR
                        if isinstance(body, dict)
                        else None
                    ),
                    "description": (
                        body.get("description") or ""
                        if isinstance(body, dict)
                        else None
                    ),
                    "rule": body,
                }
            )
        return {"rules": rules, "count": len(rules)}

    def snapshot_knowledge(self, *, limit: int | None = None) -> dict[str, Any]:
        """知识集快照：按层级/种类统计 + 近期条目概览（limit 限制条数）。

        limit 钳制在 [1, 100]（与工具 schema 声明一致）：负值/越界
        输入不静默失真，越界取声明上限。
        """
        knowledge = self._sources.knowledge_set
        if knowledge is None:
            return {"entries": [], "count": 0, "by_kind": {}, "by_level": {}}
        entries = knowledge.entries()
        raw_limit = int(limit or _DEFAULT_KNOWLEDGE_LIMIT)
        capped_limit = max(1, min(raw_limit, _KNOWLEDGE_LIMIT_MAX))
        capped = min(capped_limit, len(entries))
        by_kind: dict[str, int] = {}
        by_level: dict[str, int] = {}
        for entry in entries:
            by_kind[entry.kind] = by_kind.get(entry.kind, 0) + 1
            by_level[entry.level] = by_level.get(entry.level, 0) + 1
        overview = [
            {
                "id": entry.id,
                "kind": entry.kind,
                "level": entry.level,
                "title": entry.title,
                "tags": list(entry.tags),
                "credibility": entry.credibility,
                "usage_count": entry.usage_count,
            }
            for entry in entries[:capped]
        ]
        return {
            "entries": overview,
            "count": len(entries),
            "by_kind": by_kind,
            "by_level": by_level,
        }

    def snapshot_ui(self) -> dict[str, Any]:
        """界面描述快照：当前 JSON 布局（未定形时为 None）。

        返回深拷贝——快照是观察数据，消费方改写不得反写引擎源数据。
        """
        return {"ui_spec": copy.deepcopy(self._sources.ui_spec)}

    def snapshot_tools(self) -> dict[str, Any]:
        """工具表快照：已注册工具清单与权限声明（AI 内省自身能力清单）。"""
        specs = list(self._sources.tools)
        tools = [
            {"name": spec.name, "description": spec.description, "permissions": list(spec.permissions)}
            for spec in specs
        ]
        snapshot: dict[str, Any] = {"tools": tools, "count": len(tools)}
        registry = self._sources.harness_registry
        if registry is not None:
            snapshot["harnesses"] = list(registry.names())
        return snapshot


def introspection_tool_specs() -> list[ToolSpec]:
    """内省元工具的工具描述清单（注册进引擎工具表走标准流水线）。"""
    return [
        ToolSpec(
            name="inspect_graph",
            description="读取当前执行图的结构快照（节点/边/出口/子图与内容指纹），"
            "供 AI 观察自身运行形态",
            parameters={"type": "object", "properties": {}},
            permissions=(INTROSPECTION_PERMISSION,),
        ),
        ToolSpec(
            name="inspect_rules",
            description="读取当前集内规则集快照（规则 id/严重级/说明），"
            "供 AI 评估既有规则是否仍合适",
            parameters={"type": "object", "properties": {}},
            permissions=(INTROSPECTION_PERMISSION,),
        ),
        ToolSpec(
            name="inspect_knowledge",
            description="读取知识集快照（条目按层级与种类统计 + 近期条目概览），"
            "供 AI 了解已沉淀的知识",
            parameters={
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": _KNOWLEDGE_LIMIT_MAX,
                        "description": "概览条目数上限（缺省 20）",
                    }
                },
            },
            permissions=(INTROSPECTION_PERMISSION,),
        ),
        ToolSpec(
            name="inspect_ui",
            description="读取当前界面描述快照（JSON 布局），供 AI 了解产品当前呈现形态",
            parameters={"type": "object", "properties": {}},
            permissions=(INTROSPECTION_PERMISSION,),
        ),
        ToolSpec(
            name="inspect_tools",
            description="读取工具表快照（已注册工具清单与权限声明），"
            "供 AI 内省自身能力清单与集内 harness 领域",
            parameters={"type": "object", "properties": {}},
            permissions=(INTROSPECTION_PERMISSION,),
        ),
    ]


def make_introspection_executor(
    service: IntrospectionService,
) -> Callable[..., Awaitable[str]]:
    """构造内省执行器（工具流水线 executor 契约：ctx/spec/args/approval → 文本）。"""

    async def executor(ctx: Any, spec: ToolSpec, args: dict, approval: Any) -> str:
        snapshot = service.snapshot(spec.name, args or {})
        # 出口统一剥离敏感键（api_key/token/secret…）——观察通道与落库
        # 通道同规格，凭据永不进入模型上下文；快照必须完整可序列化，
        # 契约破坏显式抛错（fail-closed），不静默降级为字符串
        return json.dumps(strip_sensitive(snapshot), ensure_ascii=False)

    return executor


def build_introspection_pipeline(
    service: IntrospectionService, *, gate: PermissionGate | None = None
) -> ToolPipeline:
    """装配内省工具流水线：只读判定 + 权限门禁 + 审计留痕 + 结果截断。

    gate 缺省为 fail-closed 的 PermissionGate——工具声明了
    ``introspection:read:*`` 权限即可直过（纯只读，无审批分级）；
    未声明/未命中权限的工具调用被拒绝并留痕。
    """
    return ToolPipeline(
        gate=gate or PermissionGate(),
        extractor=lambda _spec, _args: (_INTROSPECTION_OPERATION, _INTROSPECTION_TARGET),
        executor=make_introspection_executor(service),
        max_result_chars=_MAX_RESULT_CHARS,
    )


__all__ = [
    "INTROSPECTION_PERMISSION",
    "IntrospectionService",
    "IntrospectionSources",
    "build_introspection_pipeline",
    "introspection_tool_specs",
    "make_introspection_executor",
]

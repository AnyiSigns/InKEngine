"""harness 声明式定义 / 集内激活 / 注册表 / 存储仓库（领域能力的插拔形态）。

harness = 用户集内的能力包（图定义数据 + 工具清单 + 能力描述 + 可选
编排模板与状态 schema）——定义即数据，注册即插拔：

- 注册表（进程内）：按名取定义、**集内激活**（任务描述 → 集内相关度
  激活——唯一用户集原则：每个用户一个专属集（知识+工具+工作流模板
  混合生长），任务只在集内按相关度裁剪，无跨集选择、无路由误匹配）；
  图/工具经注入的建图注册表从数据重建；
- 仓库（存储后盾）：定义落 records 通道，版本 = 补丁链（新版本 append、
  失败可回退旧版本——与 checkpoint 版本链同哲学）；
- 组合调配：激活返回按相关度排序的候选清单，宿主按序选取并 spawn
  展开（多 harness 组合 = 多候选的实例化与编排，上下文调配器思想升级
  为能力调配器）。

激活匹配默认实现为关键词命中打分（确定性、零 LLM 调用）；宿主可注入
自定义匹配器（如语义检索注入相关度）——换匹配器不改装配。
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .declarative_tools import (
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    build_declarative_pipeline,
)
from .exceptions import GraphDefinitionError
from .graph import Graph
from .llm.tools import ToolSpec
from .logging import get_logger
from .patch_chain import AssembleMode, Patch, PatchChain, PatchOp
from .registry import GraphRegistries
from .state import StateSchema
from .storage import Storage
from .tool_pipeline import ToolPipeline

logger = get_logger(__name__)

# 仓库存储集合名（通用存储服务 records 通道）
HARNESS_COLLECTION = "harness"

# 能力路由缺省置信度门槛（低于 = 不匹配，返回 None 交由宿主询问用户）
DEFAULT_ROUTE_THRESHOLD = 0.5

# 能力匹配器签名：任务描述 × 定义 → 相关度（0-1）
CapabilityMatcher = Callable[[str, "HarnessDefinition"], float]


@dataclass(frozen=True, slots=True)
class HarnessDefinition:
    """harness 声明（纯数据：图定义 + 工具 + 能力描述 + 可选编排模板）。

    Attributes:
        name: harness 名（全局唯一）。
        description: 能力描述（能力路由/用户可见说明）。
        keywords: 能力关键词（默认匹配器的命中依据，如 写作/推演/润色）。
        graph: 图定义数据（:meth:`Graph.to_dict` 产物；None = 无图，
            纯工具/纯模板 harness）。
        tools: 声明式工具定义数据（:meth:`DeclarativeToolSpec.to_dict` 产物）。
        schema: 状态通道 schema 数据（:meth:`StateSchema.to_dict` 产物）。
        default_plan: 默认编排模板（计划数据形态，经
            :meth:`ink_engine.core.plan.Plan.parse` 校验；None = 无模板）。
        meta: 扩展元数据（来源/作者/版本说明等，宿主语义）。
    """

    name: str
    description: str = ""
    keywords: tuple[str, ...] = ()
    graph: dict[str, Any] | None = None
    tools: tuple[dict[str, Any], ...] = ()
    schema: dict[str, Any] | None = None
    default_plan: dict[str, Any] | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "keywords": list(self.keywords),
            "graph": self.graph,
            "tools": list(self.tools),
            "schema": self.schema,
            "default_plan": self.default_plan,
            "meta": self.meta,
        }

    @classmethod
    def from_dict(cls, data: dict) -> HarnessDefinition:
        return cls(
            name=data["name"],
            description=data.get("description") or "",
            keywords=tuple(data.get("keywords") or ()),
            graph=data.get("graph"),
            tools=tuple(data.get("tools") or ()),
            schema=data.get("schema"),
            default_plan=data.get("default_plan"),
            meta=data.get("meta") or {},
        )


def _keyword_match(task: str, definition: HarnessDefinition) -> float:
    """默认能力匹配器：关键词命中率（确定性，零 LLM 调用）。

    相关度 = 命中关键词数 / 关键词总数（无关键词 = 0 相关）；子串命中
    计入（任务描述含关键词即视为相关信号）。数值可解释、可断言——宿主
    可注入语义检索等更精细的匹配器。
    """
    if not definition.keywords:
        return 0.0
    hits = sum(1 for keyword in definition.keywords if keyword in task)
    return hits / len(definition.keywords)


class HarnessRegistry:
    """harness 注册表（进程内运行时视图：按名取定义/能力路由/图与工具重建）。

    注册 = 插拔 U 盘：登记定义即可用（路由/建图/工具清单一条路径），
    同名重复注册 = 覆盖（宿主按配置装配，配置驱动）。
    """

    def __init__(
        self,
        registries: GraphRegistries | None = None,
        *,
        matcher: CapabilityMatcher | None = None,
        declarative: DeclarativeToolExecutors | None = None,
    ) -> None:
        self.registries = registries or GraphRegistries()
        self.matcher = matcher or _keyword_match
        # 声明式工具执行体注册表（端点执行体 + 定义登记）：build_tools 登记
        # 定义，build_pipeline 装配全流水线（执行体由宿主 register 注入）
        self.declarative = declarative or DeclarativeToolExecutors()
        self._definitions: dict[str, HarnessDefinition] = {}

    def register(self, definition: HarnessDefinition) -> None:
        if not definition.name:
            raise ValueError("harness 名不能为空")
        # 注册即校验数据形态：图定义/工具定义必须可解析（LLM 生成图定义
        # 的入口，非法定义在注册期暴露而非执行期静默降级）
        if definition.graph is not None:
            if not isinstance(definition.graph, dict):
                raise GraphDefinitionError(
                    f"harness {definition.name} 的 graph 定义非法: 期望 dict"
                )
            Graph.from_dict(
                definition.graph,
                registry=self.registries.nodes,
                edge_registry=self.registries.edges,
                validate=True,
            )
        for tool_data in definition.tools:
            DeclarativeToolSpec.from_dict(tool_data)  # 构造即校验
        self._definitions[definition.name] = definition

    def get(self, name: str) -> HarnessDefinition | None:
        return self._definitions.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(self._definitions)

    def route(
        self, task: str, *, threshold: float = DEFAULT_ROUTE_THRESHOLD
    ) -> list[tuple[str, float]]:
        """集内激活：任务描述 → 集内相关度激活清单（相关度降序，阈值过滤）。

        作用域 = 用户集（本注册表即集内视图）：任务只在集内按相关度
        裁剪，无跨集选择、无路由误匹配。未命中（空清单）= 集内无承接
        该任务的能力包，由调用方决定询问用户或走默认 harness——引擎只
        做相关度排序，不替宿主做选择。
        """
        scored = [
            (name, self.matcher(task, definition))
            for name, definition in self._definitions.items()
        ]
        scored.sort(key=lambda item: item[1], reverse=True)
        return [(name, score) for name, score in scored if score >= threshold]

    def build_graph(self, name: str) -> Graph | None:
        """按定义重建可执行图（图定义数据 → 注册表解析的函数节点图）。

        Returns:
            Graph：可交予 Engine 编译执行；定义无图（纯工具 harness）
            返回 None。
        """
        definition = self._definitions.get(name)
        if definition is None:
            raise KeyError(f"harness 未注册: {name}")
        if definition.graph is None:
            return None
        return Graph.from_dict(
            definition.graph,
            registry=self.registries.nodes,
            edge_registry=self.registries.edges,
            validate=True,
        )

    def build_schema(self, name: str) -> StateSchema | None:
        """按定义还原状态通道 schema（None = 无 schema，走引擎默认）。"""
        definition = self._definitions.get(name)
        if definition is None:
            raise KeyError(f"harness 未注册: {name}")
        return StateSchema.from_dict(definition.schema)

    def build_tools(self, name: str) -> list[ToolSpec]:
        """按定义还原工具清单（声明式工具定义 → 引擎工具描述，含定义期校验）。

        登记副作用：定义登记进声明式执行体注册表（执行体分发反查）——
        build_tools 后该 harness 的声明式工具即可经 build_pipeline
        走完整执行流水线。
        """
        definition = self._definitions.get(name)
        if definition is None:
            raise KeyError(f"harness 未注册: {name}")
        specs: list[ToolSpec] = []
        for tool_data in definition.tools:
            declarative = DeclarativeToolSpec.from_dict(tool_data)
            self.declarative.register_definition(declarative)
            specs.append(declarative.to_spec())
        return specs

    def build_pipeline(
        self,
        name: str,
        *,
        gate: Any = None,
        sandboxes: tuple[Any, ...] = (),
        guards: tuple[Callable[..., Any], ...] = (),
        audit: Callable[..., Any] | None = None,
        max_result_chars: int = 100_000,
        trace_sink: Callable[..., Any] | None = None,
    ) -> ToolPipeline:
        """构建 harness 声明式工具的完整执行流水线（轻路径接线）。

        登记定义 + 装配 extractor（端点类型操作推导）与 executor（端点
        执行体分发）——声明式工具经此走全流水线（门禁 → 沙箱 → 守卫 →
        审批 → 审计）。门禁/沙箱/守卫由宿主注入（白名单与资源绑定归
        宿主）；判定目标推导失败恒 fail-closed 拒绝。
        """
        self.build_tools(name)
        return build_declarative_pipeline(
            self.declarative,
            gate=gate,
            sandboxes=sandboxes,
            guards=guards,
            audit=audit,
            max_result_chars=max_result_chars,
            trace_sink=trace_sink,
        )


@dataclass(frozen=True, slots=True)
class HarnessVersion:
    """harness 版本信息（仓库索引：版本号 + 写入时间 + 说明）。"""

    version: int
    created_at: float
    note: str | None = None


class HarnessRepository:
    """harness 仓库（存储后盾）：定义 = 补丁链数据，版本可回退。

    版本语义（与 checkpoint 版本链同哲学）：
    - 首版 = 补丁链 base，后续版本 = append 替换补丁（新版本失败可回退
      旧版本——回退 = 组装到指定版本，非物理删除）；
    - 版本号自增（1 起）；历史版本完整保留（Event Sourcing 哲学，
      回放/审计可追溯）。

    存储后盾 = 通用存储服务 records 通道（memory/sqlite/postgres 共用，
    与记忆/轨迹存储同构）。
    """

    def __init__(self, storage: Storage, collection: str = HARNESS_COLLECTION) -> None:
        self._storage = storage
        self._collection = collection

    def _chain_key(self, name: str) -> str:
        return f"chain:{name}"

    @staticmethod
    def _versions_key(name: str) -> str:
        return f"versions:{name}"

    async def save(
        self, definition: HarnessDefinition, *, note: str | None = None
    ) -> int:
        """写入新版本（首版 = 链 base，后续 = append 替换补丁）。

        Returns:
            新版本号。
        """
        chain_record = await self._storage.get_record(
            self._collection, self._chain_key(definition.name)
        )
        if chain_record is None:
            chain = PatchChain(base={"definition": definition.to_dict()})
            version = 1
        else:
            chain = PatchChain.from_dict(chain_record)
            chain.apply(
                Patch(
                    op=PatchOp.REPLACE,
                    path=("definition",),
                    value=definition.to_dict(),
                )
            )
            # 版本号 = 补丁数 + 1（首版 = base 无补丁；每次演进 append 一条
            # 替换补丁，旧版本经补丁链 partial 组装还原）
            version = len(chain.patches) + 1
        await self._storage.put_record(
            self._collection, self._chain_key(definition.name), chain.to_dict()
        )
        versions = await self._storage.get_record(
            self._collection, self._versions_key(definition.name)
        )
        entries = list(versions or [])
        entries.append(
            {
                "version": version,
                "created_at": time.time(),
                "note": note,
            }
        )
        await self._storage.put_record(
            self._collection, self._versions_key(definition.name), entries
        )
        return version

    async def get(
        self, name: str, *, version: int | None = None
    ) -> HarnessDefinition | None:
        """按名取定义（缺省最新版本；version = 回退/审计指定版本）。

        回退 = 组装到指定版本（补丁链 partial 组装，不物理删除历史）。
        """
        chain_record = await self._storage.get_record(
            self._collection, self._chain_key(name)
        )
        if chain_record is None:
            return None
        chain = PatchChain.from_dict(chain_record)
        if version is not None:
            if version < 1 or version > len(chain.patches) + 1:
                return None
            if version == 1:
                doc = chain.assemble(mode=AssembleMode.BASE_ONLY)
            else:
                doc = chain.assemble(mode=AssembleMode.PARTIAL, end=version - 1)
        else:
            doc = chain.assemble()
        raw = doc.get("definition")
        return HarnessDefinition.from_dict(raw) if isinstance(raw, dict) else None

    async def versions(self, name: str) -> list[HarnessVersion]:
        """版本清单（升序：1 → 最新，含时间与说明）。"""
        versions = await self._storage.get_record(
            self._collection, self._versions_key(name)
        )
        return [
            HarnessVersion(
                version=int(entry["version"]),
                created_at=float(entry.get("created_at") or time.time()),
                note=entry.get("note"),
            )
            for entry in (versions or [])
        ]

    async def list(self) -> list[HarnessDefinition]:
        """全量定义（各 harness 最新版本）。

        仓库记录 = 补丁链数据：列表按链组装当前形态（版本演进后返回
        最新定义）；非链记录（版本索引表等）跳过。
        """
        definitions: list[HarnessDefinition] = []
        chain_records = await self._storage.list_records(self._collection)
        for record in chain_records:
            if "base" not in record:
                continue
            chain = PatchChain.from_dict(record)
            doc = chain.assemble()
            raw = doc.get("definition")
            if isinstance(raw, dict):
                definitions.append(HarnessDefinition.from_dict(raw))
        return definitions


__all__ = [
    "DEFAULT_ROUTE_THRESHOLD",
    "HARNESS_COLLECTION",
    "CapabilityMatcher",
    "HarnessDefinition",
    "HarnessRegistry",
    "HarnessRepository",
    "HarnessVersion",
    "_keyword_match",
]

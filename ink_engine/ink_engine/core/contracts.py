"""结点契约与机制装配开关（声明式数据形态：类型化原子的输入/输出声明）。

结点契约把「某类型结点做什么」从代码提升为可序列化数据：输入/输出
schema（复用状态通道的 SchemaSpec 声明语言）声明结点消费与产出的状态
通道字段；安全档与版本随契约落库——契约即数据，随图定义数据
（checkpoint/harness）持久化，旧版本契约快照服务审计复现与回退。

本模块只定义数据形态与窄接口，不含任何执行逻辑：

- :class:`NodeContract`：结点契约（schema 声明 + 安全档 + 版本）；
- :class:`PathAssemblyConfig`：机制装配配置开关（默认全关，读取形态与
  既有装配配置一致：enabled 标志 + 可序列化）；
- :class:`QualityGate`：产出质量判定窄协议（只定义接口，实现归使用方）。

契约可缺省：无契约结点不参与组装、仅可被手绘图引用（旧行为零破坏）。
"""
from __future__ import annotations

from collections.abc import Awaitable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from .exceptions import GraphDefinitionError
from .schema_validator import SchemaSpec

# 安全档三档（0 最严，与审批档 L0-L2 同阶）
SAFETY_TIER_MIN = 0
SAFETY_TIER_MAX = 2
# 契约版本下限（行为变更 = 升版，版本从 1 起）
CONTRACT_VERSION_MIN = 1

# ── 机制装配开关的按名透传键（装配入口按名消费，缺省全关）──────────
# 宿主装配参数（rust 侧 BootOptions 透传的 JSON 键名，见壳侧
# path_assembly_data）按此键名接入：本模块只定义「按名读取」，
# 每个开关键对应一块机制（contract/edge_evidence/settle_hooks/
# pool_governance/assembler/multipath/fingerprint_cache），键名
# 保持不变——键名是装配协议的一部分。
BOOT_KEY_CONTRACT_ENABLED = "path_assembly_contract_enabled"
BOOT_KEY_EDGE_EVIDENCE_ENABLED = "path_assembly_edge_evidence_enabled"
BOOT_KEY_SETTLE_HOOKS_ENABLED = "path_assembly_settle_hooks_enabled"
BOOT_KEY_POOL_GOVERNANCE_ENABLED = "path_assembly_pool_governance_enabled"
BOOT_KEY_ASSEMBLER_ENABLED = "path_assembly_assembler_enabled"
BOOT_KEY_MULTIPATH_ENABLED = "path_assembly_multipath_enabled"
BOOT_KEY_FINGERPRINT_CACHE_ENABLED = "path_assembly_fingerprint_cache_enabled"

# 透传键 → 开关字段（键名不改；装配入口按名读取后构造各块配置）
_BOOT_KEY_TO_FLAG: dict[str, str] = {
    BOOT_KEY_CONTRACT_ENABLED: "contract_enabled",
    BOOT_KEY_EDGE_EVIDENCE_ENABLED: "edge_evidence_enabled",
    BOOT_KEY_SETTLE_HOOKS_ENABLED: "settle_hooks_enabled",
    BOOT_KEY_POOL_GOVERNANCE_ENABLED: "pool_governance_enabled",
    BOOT_KEY_ASSEMBLER_ENABLED: "assembler_enabled",
    BOOT_KEY_MULTIPATH_ENABLED: "multipath_enabled",
    BOOT_KEY_FINGERPRINT_CACHE_ENABLED: "fingerprint_cache_enabled",
}


@dataclass(frozen=True, slots=True)
class PathAssemblyFlags:
    """机制装配开关（七块独立 feature flag，默认全关）。

    读取形态：与壳侧装配参数按名对齐（``path_assembly_*_enabled``），
    未出现的键按 False 处理（缺省全关）；每块独立开启、独立关闭
    （= 单块回滚路径）。本数据形态是装配入口的读取结果，各块机制的
    运行时配置由对应模块按该结果构造。

    Attributes:
        contract_enabled: 结点契约 + 链接校验器。
        edge_evidence_enabled: 边证据存储（评分与统计）。
        settle_hooks_enabled: 沉淀钩子（成败/成本归集、失败点提案）。
        pool_governance_enabled: 结点池治理（容量/淘汰/合并/提案预算）。
        assembler_enabled: 路径组装器（schema 反推/草稿/证据评分）。
        multipath_enabled: 多径执行 + 汇流裁决。
        fingerprint_cache_enabled: 指纹缓存。
    """

    contract_enabled: bool = False
    edge_evidence_enabled: bool = False
    settle_hooks_enabled: bool = False
    pool_governance_enabled: bool = False
    assembler_enabled: bool = False
    multipath_enabled: bool = False
    fingerprint_cache_enabled: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "contract_enabled": self.contract_enabled,
            "edge_evidence_enabled": self.edge_evidence_enabled,
            "settle_hooks_enabled": self.settle_hooks_enabled,
            "pool_governance_enabled": self.pool_governance_enabled,
            "assembler_enabled": self.assembler_enabled,
            "multipath_enabled": self.multipath_enabled,
            "fingerprint_cache_enabled": self.fingerprint_cache_enabled,
        }

    def to_boot_dict(self) -> dict[str, Any]:
        """按 BOOT_KEY_* 长键形态序列化（与 :meth:`from_boot` 读取口径一致）。

        落库形态须与读取形态同源：以短键（to_dict）落库再用 from_boot 读取
        会整体回退 False（长键/短键口径错配）——单块翻转类写入（如
        set_multipath）一律按本方法落库，保证「读取 = 写入」闭环。
        """
        return {
            BOOT_KEY_CONTRACT_ENABLED: self.contract_enabled,
            BOOT_KEY_EDGE_EVIDENCE_ENABLED: self.edge_evidence_enabled,
            BOOT_KEY_SETTLE_HOOKS_ENABLED: self.settle_hooks_enabled,
            BOOT_KEY_POOL_GOVERNANCE_ENABLED: self.pool_governance_enabled,
            BOOT_KEY_ASSEMBLER_ENABLED: self.assembler_enabled,
            BOOT_KEY_MULTIPATH_ENABLED: self.multipath_enabled,
            BOOT_KEY_FINGERPRINT_CACHE_ENABLED: self.fingerprint_cache_enabled,
        }

    @classmethod
    def from_boot(cls, data: Mapping[str, Any] | None) -> PathAssemblyFlags:
        """按名读取装配参数（未知键忽略；缺省键 = False = 默认全关）。

        装配入口把壳侧透传的装配参数数据（JSON dict 形态）传入本方法，
        返回逐块开关；各机制运行时配置按该结果构造，未启用块不参与
        任何运行路径。
        """
        if data is None:
            return cls()
        values: dict[str, bool] = {}
        for key, flag in _BOOT_KEY_TO_FLAG.items():
            values[flag] = bool(data.get(key, False))
        return cls(**values)

    def as_path_assembly_config(self) -> PathAssemblyConfig:
        """组装器块开关形态（装配入口接线用；默认全关）。"""
        return PathAssemblyConfig(enabled=self.assembler_enabled)


@dataclass(frozen=True, slots=True)
class NodeContract:
    """结点契约：类型化原子的输入/输出声明 + 安全档 + 版本。

    Attributes:
        input_schema: 本结点消费的状态通道字段声明（None = 不消费字段）。
        output_schema: 本结点产出的状态通道字段声明（None = 不产出字段）。
        safety_tier: 安全档 0/1/2（默认 0 最严；与审批档同阶，组装请求
            按任务审批档映射放行档位，映射策略归使用方）。
        version: 契约版本（结点行为变更 = 契约升版；旧版本契约随图定义
            快照落库保留，服务审计复现与回退）。
    """

    input_schema: SchemaSpec | None = None
    output_schema: SchemaSpec | None = None
    safety_tier: int = 0
    version: int = 1

    def __post_init__(self) -> None:
        if isinstance(self.safety_tier, bool) or not isinstance(self.safety_tier, int):
            raise GraphDefinitionError(
                f"契约安全档须为整数: {self.safety_tier!r}"
            )
        if not SAFETY_TIER_MIN <= self.safety_tier <= SAFETY_TIER_MAX:
            raise GraphDefinitionError(
                f"契约安全档越界: {self.safety_tier}"
                f"（仅 {SAFETY_TIER_MIN}-{SAFETY_TIER_MAX} 三档）"
            )
        if isinstance(self.version, bool) or not isinstance(self.version, int):
            raise GraphDefinitionError(f"契约版本须为整数: {self.version!r}")
        if self.version < CONTRACT_VERSION_MIN:
            raise GraphDefinitionError(
                f"契约版本须 ≥ {CONTRACT_VERSION_MIN}: {self.version}"
            )
        for label, schema in (
            ("input_schema", self.input_schema),
            ("output_schema", self.output_schema),
        ):
            if schema is not None and not isinstance(schema, SchemaSpec):
                raise GraphDefinitionError(
                    f"契约 {label} 须为 SchemaSpec: {type(schema).__name__}"
                )

    def to_dict(self) -> dict[str, Any]:
        """序列化为数据形态（schema 声明内联，随图定义数据落库）。"""
        return {
            "input_schema": (
                self.input_schema.to_dict() if self.input_schema is not None else None
            ),
            "output_schema": (
                self.output_schema.to_dict() if self.output_schema is not None else None
            ),
            "safety_tier": self.safety_tier,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> NodeContract:
        """反序列化（缺省键 = 默认值；旧数据无契约形态时由调用方传 None）。"""
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"契约声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        for key in ("input_schema", "output_schema"):
            raw = data.get(key)
            if raw is not None and not isinstance(raw, dict):
                raise GraphDefinitionError(
                    f"契约 {key} 声明非法: 期望 dict 或缺省，"
                    f"收到 {type(raw).__name__}"
                )
        safety_tier = data.get("safety_tier", 0)
        version = data.get("version", 1)
        if isinstance(safety_tier, bool) or isinstance(version, bool):
            raise GraphDefinitionError("契约安全档/版本不接受布尔值")
        try:
            tier = int(safety_tier)
            ver = int(version)
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError(
                f"契约安全档/版本须为整数: {safety_tier!r}/{version!r}"
            ) from exc
        input_data = data.get("input_schema")
        output_data = data.get("output_schema")
        return cls(
            input_schema=(
                SchemaSpec.from_dict(input_data) if input_data is not None else None
            ),
            output_schema=(
                SchemaSpec.from_dict(output_data) if output_data is not None else None
            ),
            safety_tier=tier,
            version=ver,
        )


@dataclass(frozen=True, slots=True)
class PathAssemblyConfig:
    """机制装配配置开关（默认全关；读取形态与既有装配配置一致）。

    Attributes:
        enabled: 机制入口开关（False = 机制不参与任何运行路径；默认全关
            的增量接入——本模块只定义开关形态与序列化，读取点由机制
            入口接入时挂接，不改动引擎既有行为基线）。
    """

    enabled: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> PathAssemblyConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"装配配置声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(enabled=bool(data.get("enabled", False)))


class QualityGate(Protocol):
    """产出质量判定窄协议（组装请求注入；只定义接口，实现归使用方）。

    按域提供产出质量判定（领域名 + 产出物 → 布尔结论）；布尔结论随
    沉淀钩子落库（settle 只记录布尔值，不做判定本身）。未注入闸门时
    使用方走 fail-closed 降级链。判定可同步或异步——调用点按引擎既有
    协议惯例检测 awaitable。
    """

    def judge(self, domain: str, artifact: Any) -> bool | Awaitable[bool]: ...


__all__ = [
    "BOOT_KEY_ASSEMBLER_ENABLED",
    "BOOT_KEY_CONTRACT_ENABLED",
    "BOOT_KEY_EDGE_EVIDENCE_ENABLED",
    "BOOT_KEY_FINGERPRINT_CACHE_ENABLED",
    "BOOT_KEY_MULTIPATH_ENABLED",
    "BOOT_KEY_POOL_GOVERNANCE_ENABLED",
    "BOOT_KEY_SETTLE_HOOKS_ENABLED",
    "CONTRACT_VERSION_MIN",
    "SAFETY_TIER_MAX",
    "SAFETY_TIER_MIN",
    "NodeContract",
    "PathAssemblyConfig",
    "PathAssemblyFlags",
    "QualityGate",
]

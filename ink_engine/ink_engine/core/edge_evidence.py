"""边证据存储与纯算法评分（链接统计的持久化与派生指标）。

本模块承载「链接的证据维度」：一条边 = 源结点类型到目标结点类型的
链接，按上下文域分组记录成败计数、平均成本与最近使用时间，并派生
信任档与评分。设计要点（全部为只记录不裁决的机制侧事实）：

- **契约版本入键**：主键含 src/dst 契约版本，升版后旧行自然不命中
  （新版本冷启动），无需任何重置逻辑；
- **按域聚合写死**：评分与统计永远按 ``context_domain`` 分组，不做
  跨域平均——高频域统计不得淹没低频域；
- **归因规则**：失败只记失败结点入边 ``fail+1``、上游边中性不记；
  成功才全边 ``success+1``；成本每次执行归集 ``avg_cost``（滑动均值）；
- **信任档推导式**：观察 N<8 / 常规 N≥8 且 p̂≥0.7 / 转正 N≥30 且
  p̂≥0.9——纯算法自动晋级、零审批；
- **评分公式**（形状 + 默认常数 = 引擎机制，使用方仅有覆盖权）：:
      edge_score = p̂ · w_n · d(t) · τ
      p̂ = (s+1)/(s+f+2)             拉普拉斯平滑成功率
      w_n = max(n,1)/(max(n,1)+8)   样本量加权（半饱和点 8；零证据
                                   边取 1/9 先验下界）
      d(t) = exp(-age_days/30)      30 天半衰期衰减（策略边豁免）
      τ ∈ {0.6, 0.8, 1.0}           信任档：观察/常规/转正
  beam tie-break = (score 降序, avg_cost 升序, type_name 字典序)——
  确定性序，冷启动零分并列可断言；
- **多径触发判据**（同一公式派生）：top-1/top-2 候选边 N<5 或分差
  <0.15 且 N≥5 → 触发信号；证据强（N≥5 且分差≥0.15）绝不触发；
- **冷启动指数** = 有证据边数 / 候选边数，< 0.3 = 探索模式（默认
  参数引擎钉死，宿主仅覆盖）。

存储形态：sqlite 独立表（派生数据，可由运行历史重建），沿既有
sqlite 后端先例（aiosqlite 惰性导入，测试默认内存库）。
"""
from __future__ import annotations

import math
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .audit_log import emit_audit
from .event_types import EVENT_AUDIT_POLICY_REVIEW
from .exceptions import StorageError
from .logging import get_logger

logger = get_logger(__name__)

# 契约版本缺省值：结点契约未声明版本时沿用此值入键——版本一旦
# 声明即自然替换，旧行升版后不命中
DEFAULT_CONTRACT_VERSION = "1"

# 信任档（观察/常规/转正）与 τ 档位（评分乘数；与推荐先验晋升同源）
TIER_OBSERVING = "observing"
TIER_REGULAR = "regular"
TIER_PROMOTED = "promoted"
TIER_TAU = {
    TIER_OBSERVING: 0.6,
    TIER_REGULAR: 0.8,
    TIER_PROMOTED: 1.0,
}

# 证据来源（origin）与先验隔离：种子行携带 origin=seed 并在评分中降权，
# 冷启动仍可靠种子兜底，但种子计数不得与运行期证据同权混算（避免「6/1=86%」
# 假象）；运行期观察行 origin=runtime 参与全权评分；策略边 origin=policy
# 仍取 τ=1.0 豁免（与 seed 降权正交——策略边是显式承诺而非统计先验）。
ORIGIN_SEED = "seed"
ORIGIN_RUNTIME = "runtime"
ORIGIN_POLICY = "policy"
# 种子行评分降权因子（<1）：种子统计是出厂先验、非真实观测，计入评分时
# 按此因子压缩，使冷启动不被过度信任；首次真实成功后该行 origin 翻为
# runtime，降权即解除（真实证据主导）。权威默认 = 引擎钉死（ENG9b-5），
# 数据驱动覆盖经 :func:`set_seed_weight` 注入（宿主装配，与半衰期同形态）。
SEED_WEIGHT = 0.5

# 信任档推导阈值（与推荐先验晋升同一组常数；纯算法自动晋级零审批）
TIER_REGULAR_N = 8  # 常规：N ≥ 8 且 p̂ ≥ 0.7
TIER_REGULAR_P = 0.7
TIER_PROMOTE_N = 30  # 转正：N ≥ 30 且 p̂ ≥ 0.9
TIER_PROMOTE_P = 0.9

# 评分公式默认常数（引擎钉死默认；使用方仅覆盖权——ENG9b-5 起权威
# 常量语义明确：出厂默认 = 本值，运行期覆盖经 set_* 钩子数据驱动注入）
SATURATION_N = 8.0  # 样本量半饱和点（w_n 分母）
# 时间衰减半衰期（天）：默认 30 保持历史行为兼容；改值经数据驱动注入
# （boot env / tiers 装配），评分公式的 τ×d(t) 语义见 :func:`time_decay`。
# ``DECAY_HALF_DAYS`` 为出厂默认值（不变量锚点），运行期覆盖经
# :func:`set_decay_half_days` 注入，二者同义——装配注入即权威。
DECAY_HALF_DAYS = 30.0
ZERO_EVIDENCE_WEIGHT = 1 / 9  # 零证据边 w_n 先验下界（评审决议）
ZERO_EVIDENCE_P = 0.5  # 零证据拉普拉斯先验成功率
ZERO_EVIDENCE_TAU = TIER_TAU[TIER_OBSERVING]

# 多径触发判据常数（与评分公式同源，不另定阈值）
MULTIPATH_MIN_N = 5  # 样本不足判定线（N < 5 = 样本不足）
MULTIPATH_GAP = 0.15  # 证据不足判定线（分差 < 0.15 且 N ≥ 5 = 方差高）

# 冷启动探索模式（指数计算与模式判定归引擎；默认参数引擎钉死）
EXPLORATION_INDEX_THRESHOLD = 0.3


def laplace_success(success: int, fail: int) -> float:
    """拉普拉斯平滑成功率 p̂ = (s+1)/(s+f+2)（零证据先验 0.5）。"""
    return (success + 1) / (success + fail + 2)


def sample_weight(n: int) -> float:
    """样本量加权 w_n = max(n,1)/(max(n,1)+saturation_n)（零证据取 1/9 下界）。

    半饱和点取当前生效值（出厂 :data:`SATURATION_N`，可经
    :func:`set_saturation_n` 数据驱动注入——ENG9b-5）。
    """
    n = max(n, 1)
    return n / (n + get_saturation_n())


# ── 评分常数数据驱动注入（ENG9b-4/5 收口）──
# 出厂默认 = 引擎钉死（模块常量：SEED_WEIGHT / SATURATION_N /
# DECAY_HALF_DAYS），运行期覆盖一律经本组 set_* 钩子注入（boot env /
# tiers 装配调用）——避免「文档声称可注入、实现恒用默认」的假面。
# 注入即权威：覆盖后续所有评分的对应口径；复位 = 传回出厂默认。
# 现状声明（ENG9b-4）：引擎侧无自动装配点（runtime/壳侧接线归宿主域），
# 未注入时按出厂默认生效——默认值即权威，注入钩子为可选增强面。

# 运行期衰减半衰期（数据驱动覆盖锚点；默认 = 出厂 DECAY_HALF_DAYS）
_decay_half_days = DECAY_HALF_DAYS


def set_decay_half_days(value: float) -> None:
    """数据驱动注入衰减半衰期（boot env / tiers 装配调用）。

    声明即权威：注入值覆盖所有后续评分的时间衰减口径，使宿主可按域/
    按信任档收紧或放宽衰减节奏；不传 / 复位 = 回落出厂默认 30 天。
    """
    global _decay_half_days
    _decay_half_days = float(value)


def get_decay_half_days() -> float:
    """当前生效的衰减半衰期（观察侧）。"""
    return _decay_half_days


# 运行期种子降权因子（数据驱动覆盖锚点；默认 = 出厂 SEED_WEIGHT）
_seed_weight = SEED_WEIGHT


def set_seed_weight(value: float) -> None:
    """数据驱动注入种子降权因子（ENG9b-5；装配调用，语义同半衰期钩子）。"""
    global _seed_weight
    _seed_weight = float(value)


def get_seed_weight() -> float:
    """当前生效的种子降权因子（观察侧）。"""
    return _seed_weight


# 运行期样本量半饱和点（数据驱动覆盖锚点；默认 = 出厂 SATURATION_N）
_saturation_n = SATURATION_N


def set_saturation_n(value: float) -> None:
    """数据驱动注入样本量半饱和点（ENG9b-5；装配调用，语义同半衰期钩子）。"""
    global _saturation_n
    _saturation_n = float(value)


def get_saturation_n() -> float:
    """当前生效的样本量半饱和点（观察侧）。"""
    return _saturation_n


def time_decay(age_days: float, *, exempt: bool = False, decay_half_days: float | None = None) -> float:
    """时间衰减 d(t) = exp(-age_days/H)；策略边豁免（恒 1.0）。

    H 默认取数据驱动注入的半衰期（:func:`get_decay_half_days`，出厂 30），
    亦可经 ``decay_half_days`` 形参逐次覆盖（确定性测试注入）。语义：
    评分 = p̂ · w_n · d(t) · τ，其中 d(t) 仅表达对旧证据的信任折旧，
    与 τ（信任档乘数）正交——τ 是静态晋级结论，d(t) 是动态时间权重。
    """
    if exempt or age_days <= 0:
        return 1.0
    half = _decay_half_days if decay_half_days is None else decay_half_days
    return math.exp(-age_days / half)


def derive_edge_tier(success: int, fail: int) -> str:
    """信任档推导式（纯函数）：观察 N<8 / 常规 N≥8 且 p̂≥0.7 / 转正
    N≥30 且 p̂≥0.9——纯算法自动晋级，零审批（边是派生统计可重建）。
    """
    n = success + fail
    p = laplace_success(success, fail)
    if n >= TIER_PROMOTE_N and p >= TIER_PROMOTE_P:
        return TIER_PROMOTED
    if n >= TIER_REGULAR_N and p >= TIER_REGULAR_P:
        return TIER_REGULAR
    return TIER_OBSERVING


def tier_tau(tier: str) -> float:
    """信任档 → τ 乘数（观察 0.6 / 常规 0.8 / 转正 1.0；策略边取 1.0）。"""
    return TIER_TAU.get(tier, TIER_TAU[TIER_OBSERVING])


def zero_evidence_score() -> float:
    """零证据候选边评分（先验下界）：p̂=0.5 · w_n=1/9 · d(t)=1 · τ=0.6。"""
    return ZERO_EVIDENCE_P * ZERO_EVIDENCE_WEIGHT * 1.0 * ZERO_EVIDENCE_TAU


@dataclass(frozen=True, slots=True)
class EdgeScore:
    """评分分量展开（可断言单调性；score 为最终评分）。"""

    score: float
    p: float  # 拉普拉斯平滑成功率
    weight: float  # 样本量加权
    decay: float  # 时间衰减
    tau: float  # 信任档乘数
    tier: str  # 信任档

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "p": self.p,
            "weight": self.weight,
            "decay": self.decay,
            "tau": self.tau,
            "tier": self.tier,
        }


def edge_score(
    evidence: EdgeEvidence | None,
    *,
    success: int | None = None,
    fail: int | None = None,
    age_days: float | None = None,
    now: float | None = None,
    decay_half_days: float | None = None,
) -> EdgeScore:
    """评分函数（公式形状 + 默认常数 = 引擎机制，使用方仅覆盖常数权）。

    先验隔离（降权）：``origin=seed`` 的出厂先验行在 p̂·w_n·d(t)·τ
    之外再乘 :data:`SEED_WEIGHT`（<1），使冷启动不被过度信任；首次真实
    成功后该行 origin 翻为 runtime，降权解除（真实证据主导，不再有「6/1=86%」
    假象）。策略边（``policy=True``）恒取 τ=1.0 且豁免时间衰减，与 seed
    降权正交。

    Args:
        evidence: 边证据行（None = 零证据候选，取先验下界）。
        success/fail/age_days: 覆盖口径（测试与快照重算用；缺省取行内值）。
        now: 当前时间戳（缺省 = 实时；确定性测试注入）。
        decay_half_days: 逐次覆盖衰减半衰期（缺省取数据驱动注入值）。
    """
    if evidence is None:
        score = zero_evidence_score()
        return EdgeScore(
            score=score, p=ZERO_EVIDENCE_P, weight=ZERO_EVIDENCE_WEIGHT,
            decay=1.0, tau=ZERO_EVIDENCE_TAU, tier=TIER_OBSERVING,
        )
    s = success if success is not None else evidence.success_count
    f = fail if fail is not None else evidence.fail_count
    tier = derive_edge_tier(s, f)
    tau = TIER_TAU[TIER_PROMOTED] if evidence.policy else tier_tau(tier)
    p = laplace_success(s, f)
    w = sample_weight(s + f)
    if age_days is None:
        ts = now if now is not None else time.time()
        last = evidence.last_used_at or evidence.created_at
        age_days = max(0.0, (ts - last) / 86400.0)
    d = time_decay(age_days, exempt=evidence.policy, decay_half_days=decay_half_days)
    score = p * w * d * tau
    # 先验隔离：种子行降权（策略边豁免 τ 仍走全权，两者正交）；
    # 降权因子取当前生效值（出厂 SEED_WEIGHT，可经 set_seed_weight
    # 数据驱动注入——ENG9b-5）
    origin = getattr(evidence, "origin", ORIGIN_RUNTIME)
    if origin == ORIGIN_SEED and not evidence.policy:
        score *= get_seed_weight()
    return EdgeScore(
        score=score,
        p=p, weight=w, decay=d, tau=tau, tier=tier,
    )


def multi_path_trigger(
    top1: EdgeEvidence | None,
    top2: EdgeEvidence | None,
    *,
    now: float | None = None,
) -> bool:
    """多径触发判据（同一公式派生，不另定阈值）。

    - top-1/top-2 候选边 N<5（样本不足）或分差<0.15 且 N≥5（证据不足/
      方差高）→ 触发信号；
    - 证据强（N≥5 且分差≥0.15）绝不触发；
    - 候选不足两条（含零条）= 样本不足，触发。

    本函数只提供判据信号，触发决策归使用方（本步只记录不裁决）。
    """
    if top1 is None or top2 is None:
        return True
    n1 = top1.success_count + top1.fail_count
    n2 = top2.success_count + top2.fail_count
    if n1 < MULTIPATH_MIN_N or n2 < MULTIPATH_MIN_N:
        return True
    gap = abs(
        edge_score(top1, now=now).score - edge_score(top2, now=now).score
    )
    return gap < MULTIPATH_GAP


def cold_start_index(evidenced_edges: int, candidate_edges: int) -> float:
    """冷启动指数 = 有证据边数 / 候选边数（0-1；候选为 0 时按 0 处理）。

    指数计算归引擎（数据全在引擎侧）；判定见 :func:`is_exploration_mode`。
    """
    if candidate_edges <= 0:
        return 0.0
    return min(1.0, evidenced_edges / candidate_edges)


def is_exploration_mode(index: float) -> bool:
    """探索模式判定：冷启动指数 < 0.3 = 探索模式（默认参数引擎钉死）。"""
    return index < EXPLORATION_INDEX_THRESHOLD


@dataclass(frozen=True, slots=True)
class EdgeKey:
    """边主键（契约版本入键：升版后旧行自然不命中，无需重置逻辑）。

    实例粒度（变体指纹维）：``variant_hash`` 为可选维度——节点配置 /
    提示词变体指纹（可空 = 类型级兼容，旧行空值归类型级）。当一个结点
    以不同配置/提示词变体执行时，不同变体各自沉淀独立边证据，避免把
    A 变体的成败记到 B 变体头上；空值（默认）= 退化为类型级证据，与旧
    行为完全兼容。
    """

    src_type: str
    dst_type: str
    src_contract_version: str = DEFAULT_CONTRACT_VERSION
    dst_contract_version: str = DEFAULT_CONTRACT_VERSION
    context_domain: str = "default"
    variant_hash: str = ""

    def key(self) -> tuple[str, str, str, str, str, str]:
        return (
            self.src_type,
            self.dst_type,
            self.src_contract_version,
            self.dst_contract_version,
            self.context_domain,
            self.variant_hash,
        )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "src_type": self.src_type,
            "dst_type": self.dst_type,
            "src_contract_version": self.src_contract_version,
            "dst_contract_version": self.dst_contract_version,
            "context_domain": self.context_domain,
        }
        if self.variant_hash:
            data["variant_hash"] = self.variant_hash
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EdgeKey:
        return cls(
            src_type=str(data.get("src_type", "")),
            dst_type=str(data.get("dst_type", "")),
            src_contract_version=str(
                data.get("src_contract_version", DEFAULT_CONTRACT_VERSION)
            ),
            dst_contract_version=str(
                data.get("dst_contract_version", DEFAULT_CONTRACT_VERSION)
            ),
            context_domain=str(data.get("context_domain", "default")),
            variant_hash=str(data.get("variant_hash", "")),
        )


@dataclass(frozen=True, slots=True)
class EdgeEvidence:
    """一条边的证据行（按域聚合的统计事实，可重建可顶替）。"""

    key: EdgeKey
    success_count: int
    fail_count: int
    avg_cost: float = 0.0
    policy: bool = False  # 策略边（声明式承诺）：评分 τ=1.0 且豁免时间衰减
    origin: str = ORIGIN_RUNTIME  # 证据来源：seed/runtime/policy（先验隔离降权）
    last_used_at: float | None = None
    created_at: float = 0.0

    @property
    def src_type(self) -> str:
        return self.key.src_type

    @property
    def dst_type(self) -> str:
        return self.key.dst_type

    @property
    def context_domain(self) -> str:
        return self.key.context_domain

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            **self.key.to_dict(),
            "success_count": self.success_count,
            "fail_count": self.fail_count,
            "avg_cost": self.avg_cost,
            "created_at": self.created_at,
        }
        if self.policy:
            data["policy"] = True
        if self.origin != ORIGIN_RUNTIME:
            data["origin"] = self.origin
        if self.last_used_at is not None:
            data["last_used_at"] = self.last_used_at
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EdgeEvidence:
        return cls(
            key=EdgeKey.from_dict(data),
            success_count=int(data.get("success_count", 0)),
            fail_count=int(data.get("fail_count", 0)),
            avg_cost=float(data.get("avg_cost", 0.0)),
            policy=bool(data.get("policy", False)),
            origin=str(data.get("origin", ORIGIN_RUNTIME)),
            last_used_at=(
                float(data["last_used_at"]) if data.get("last_used_at") is not None else None
            ),
            created_at=float(data.get("created_at", 0.0)),
        )


_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS edge_evidence (
    src_type TEXT NOT NULL,
    dst_type TEXT NOT NULL,
    src_contract_version TEXT NOT NULL,
    dst_contract_version TEXT NOT NULL,
    context_domain TEXT NOT NULL,
    variant_hash TEXT NOT NULL DEFAULT '',
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0.0,
    policy INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'runtime',
    last_used_at REAL,
    created_at REAL NOT NULL,
    PRIMARY KEY (src_type, dst_type, src_contract_version, dst_contract_version, context_domain, variant_hash)
);
CREATE INDEX IF NOT EXISTS idx_edge_evidence_domain ON edge_evidence(context_domain);
"""


class EdgeEvidenceStore:
    """边证据存储（sqlite 独立表；派生数据可由运行历史重建）。

    沿既有 sqlite 后端先例：aiosqlite 惰性导入（禁新增依赖），
    ``:memory:`` 为测试默认；所有读取按 ``context_domain`` 分组——
    评分/统计永远按域聚合，不做跨域平均。
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._conn: Any = None
        self._closed = False
        self._init_lock: Any = None

    async def _connect(self) -> None:
        if self._closed:
            raise StorageError("边证据存储已关闭（close() 后不可再读写）")
        if self._conn is not None:
            return
        if self._init_lock is None:
            import asyncio

            self._init_lock = asyncio.Lock()
        async with self._init_lock:
            if self._conn is not None:
                return
            try:
                import aiosqlite

                self._conn = await aiosqlite.connect(self._db_path)
                self._conn.row_factory = aiosqlite.Row
                script_cur = await self._conn.executescript(_SCHEMA_SQL)
                await script_cur.close()
                await self._conn.commit()
                await self._migrate_schema()
            except Exception as exc:
                if self._conn is not None:
                    await self._conn.close()
                    self._conn = None
                logger.error(f"边证据存储连接失败: {exc}")
                raise StorageError(
                    "边证据存储连接失败（详情见日志）"
                ) from exc

    async def _migrate_schema(self) -> None:
        """存量库迁移：旧表缺 variant_hash/origin 列时重建为新主键形态。

        一次性、幂等：仅当旧表存在且缺新列才重建（重命名旧表 → 建新表 →
        拷贝数据，旧行 origin 回落 runtime），迁移后旧表删除。全新库走
        ``_SCHEMA_SQL`` 直接建表，不触发。
        """
        try:
            cur = await self._conn.execute("PRAGMA table_info(edge_evidence)")
            rows = await cur.fetchall()
            await cur.close()
            cols = {row["name"] for row in rows}
            if "variant_hash" in cols and "origin" in cols:
                return
            exists = await self._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='edge_evidence'"
            )
            if (await exists.fetchone()) is None:
                await exists.close()
                return
            await exists.close()
            await self._conn.execute("ALTER TABLE edge_evidence RENAME TO _edge_evidence_old")
            await self._conn.executescript(_SCHEMA_SQL)
            await self._conn.execute(
                "INSERT INTO edge_evidence (src_type, dst_type, src_contract_version,"
                " dst_contract_version, context_domain, variant_hash, success_count,"
                " fail_count, avg_cost, policy, origin, last_used_at, created_at)"
                " SELECT src_type, dst_type, src_contract_version, dst_contract_version,"
                " context_domain, '', success_count, fail_count, avg_cost, policy,"
                " 'runtime', last_used_at, created_at FROM _edge_evidence_old"
            )
            await self._conn.execute("DROP TABLE _edge_evidence_old")
            await self._conn.commit()
        except Exception as exc:  # 迁移失败不致命，留待后续重试
            logger.warning(f"边证据表迁移跳过: {exc}")

    async def _row_to_evidence(self, row: Any) -> EdgeEvidence:
        return EdgeEvidence(
            key=EdgeKey(
                src_type=row["src_type"],
                dst_type=row["dst_type"],
                src_contract_version=row["src_contract_version"],
                dst_contract_version=row["dst_contract_version"],
                context_domain=row["context_domain"],
                variant_hash=str(row["variant_hash"]),
            ),
            success_count=int(row["success_count"]),
            fail_count=int(row["fail_count"]),
            avg_cost=float(row["avg_cost"]),
            policy=bool(row["policy"]),
            origin=str(row["origin"]),
            last_used_at=float(row["last_used_at"]) if row["last_used_at"] is not None else None,
            created_at=float(row["created_at"]),
        )

    async def get(self, key: EdgeKey) -> EdgeEvidence | None:
        """按主键取证据（契约版本 + 实例变体入键：升版/换变体后旧键自然不命中）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM edge_evidence WHERE src_type=? AND dst_type=?"
                " AND src_contract_version=? AND dst_contract_version=?"
                " AND context_domain=? AND variant_hash=?",
                (*key.key(),),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            # 对外脱敏（ENG9b-12）：原始异常文本（SQL/路径等内部细节）
            # 不内联进对外错误——详情留日志，对外只给类别文案
            logger.error(f"边证据读取失败: {exc}")
            raise StorageError("边证据读取失败（详情见日志）") from exc
        return await self._row_to_evidence(row) if row else None

    async def record_success(
        self, key: EdgeKey, *, cost: float | None = None, now: float | None = None,
        delta: int = 1,
    ) -> EdgeEvidence:
        """成功归集：success+delta（成功才全边 +delta 的归因由调用方保证）。

        成本每次执行归集：avg_cost 滑动均值（按已记录样本数加权）。
        首次真实成功把该行 origin 翻为 runtime（解除种子降权，真实证据主导）。
        """
        return await self._record(key, delta_success=delta, cost=cost, now=now)

    async def record_failure(
        self, key: EdgeKey, *, cost: float | None = None, now: float | None = None,
        delta: int = 1,
    ) -> EdgeEvidence:
        """失败归集：fail+delta（失败归因的加权分摊由调用方经 delta 携带）。

        失败只记失败结点入边的语义由调用方（settle 钩子）保证；首次真实
        失败同样把该行 origin 翻为 runtime（真实观测覆盖种子先验）。
        """
        return await self._record(key, delta_fail=delta, cost=cost, now=now)

    async def _record(
        self,
        key: EdgeKey,
        *,
        delta_success: int = 0,
        delta_fail: int = 0,
        cost: float | None = None,
        now: float | None = None,
    ) -> EdgeEvidence:
        await self._connect()
        ts = now if now is not None else time.time()
        try:
            # 原子 upsert（ENG9b-7）：旧实现读后写（get → UPDATE）非原子，
            # 并发 record_success/record_failure 会丢更新或触发
            # IntegrityError——单条 INSERT ... ON CONFLICT DO UPDATE 由
            # sqlite 语句级原子性保证两次增量都落库。avg_cost 滑动均值在
            # 语句内按「更新前计数」计算（与 delta 加权口径一致），
            # cost=None 不改写均值。
            new_row_avg = float(cost) if cost is not None else 0.0
            cur = await self._conn.execute(
                "INSERT INTO edge_evidence (src_type, dst_type,"
                " src_contract_version, dst_contract_version, context_domain,"
                " variant_hash, success_count, fail_count, avg_cost, policy,"
                " origin, last_used_at, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)"
                " ON CONFLICT(src_type, dst_type, src_contract_version,"
                " dst_contract_version, context_domain, variant_hash)"
                " DO UPDATE SET"
                " success_count = edge_evidence.success_count + excluded.success_count,"
                " fail_count = edge_evidence.fail_count + excluded.fail_count,"
                " avg_cost = CASE WHEN (? IS NOT NULL"
                "   AND (edge_evidence.success_count + edge_evidence.fail_count"
                "        + ? + ?) > 0) THEN"
                "   (edge_evidence.avg_cost"
                "    * (edge_evidence.success_count + edge_evidence.fail_count)"
                "    + ? * (? + ?))"
                "   / ((edge_evidence.success_count + edge_evidence.fail_count)"
                "      + ? + ?)"
                "   ELSE edge_evidence.avg_cost END,"
                " origin = CASE WHEN (? + ?) > 0 THEN 'runtime'"
                "   ELSE edge_evidence.origin END,"
                " last_used_at = ?",
                (
                    *key.key(),
                    delta_success,
                    delta_fail,
                    new_row_avg,
                    ORIGIN_RUNTIME,
                    ts,
                    ts,
                    cost,
                    delta_success,
                    delta_fail,
                    cost,
                    delta_success,
                    delta_fail,
                    delta_success,
                    delta_fail,
                    delta_success,
                    delta_fail,
                    ts,
                ),
            )
            await self._conn.commit()
            await cur.close()
        except Exception as exc:
            raise StorageError("边证据写入失败（并发或存储异常，详情见日志）") from exc
        return await self.get(key)  # type: ignore[return-value]

    async def _insert(
        self,
        key: EdgeKey,
        *,
        success_count: int,
        fail_count: int,
        avg_cost: float,
        last_used_at: float,
        created_at: float | None = None,
        policy: bool = False,
    ) -> None:
        await self._conn.execute(
            "INSERT INTO edge_evidence (src_type, dst_type, src_contract_version,"
            " dst_contract_version, context_domain, variant_hash, success_count,"
            " fail_count, avg_cost, policy, origin, last_used_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                key.src_type,
                key.dst_type,
                key.src_contract_version,
                key.dst_contract_version,
                key.context_domain,
                key.variant_hash,
                success_count,
                fail_count,
                avg_cost,
                int(policy),
                ORIGIN_POLICY if policy else ORIGIN_RUNTIME,
                last_used_at,
                created_at if created_at is not None else last_used_at,
            ),
        )
        await self._conn.commit()

    async def put(self, evidence: EdgeEvidence) -> EdgeEvidence:
        """整行写入（种子导入/策略边声明用；已存在 = 覆盖更新）。

        origin 随证据行写入（策略边落 origin=policy；其余沿用行内声明，
        默认 runtime）。种子导入经专用 :func:`import_seed_paths` 落 origin=seed。
        """
        await self._connect()
        try:
            existing = await self.get(evidence.key)
            origin = evidence.origin
            if evidence.policy:
                origin = ORIGIN_POLICY
            if existing is None:
                await self._insert(
                    evidence.key,
                    success_count=evidence.success_count,
                    fail_count=evidence.fail_count,
                    avg_cost=evidence.avg_cost,
                    last_used_at=evidence.last_used_at or time.time(),
                    created_at=evidence.created_at,
                    policy=evidence.policy,
                )
                if origin != ORIGIN_RUNTIME:
                    await self._conn.execute(
                        "UPDATE edge_evidence SET origin=? WHERE src_type=? AND"
                        " dst_type=? AND src_contract_version=? AND"
                        " dst_contract_version=? AND context_domain=? AND variant_hash=?",
                        (origin, *evidence.key.key()),
                    )
                    await self._conn.commit()
            else:
                cur = await self._conn.execute(
                    "UPDATE edge_evidence SET success_count=?, fail_count=?,"
                    " avg_cost=?, policy=?, origin=?, last_used_at=?, created_at=?"
                    " WHERE src_type=? AND dst_type=? AND src_contract_version=?"
                    " AND dst_contract_version=? AND context_domain=? AND variant_hash=?",
                    (
                        evidence.success_count,
                        evidence.fail_count,
                        evidence.avg_cost,
                        int(evidence.policy),
                        origin,
                        evidence.last_used_at,
                        evidence.created_at or existing.created_at,
                        *evidence.key.key(),
                    ),
                )
                await self._conn.commit()
                await cur.close()
        except Exception as exc:
            logger.error(f"边证据整行写入失败: {exc}")
            raise StorageError("边证据整行写入失败（详情见日志）") from exc
        return evidence

    async def list_edges(self, domain: str | None = None) -> list[EdgeEvidence]:
        """按域枚举（domain=None = 全域枚举——只做逐域分组，不跨域聚合）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute(
                    "SELECT * FROM edge_evidence ORDER BY context_domain,"
                    " src_type, dst_type, src_contract_version, dst_contract_version"
                )
            else:
                cur = await self._conn.execute(
                    "SELECT * FROM edge_evidence WHERE context_domain=?"
                    " ORDER BY src_type, dst_type, src_contract_version,"
                    " dst_contract_version",
                    (domain,),
                )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            logger.error(f"边证据枚举失败: {exc}")
            raise StorageError("边证据枚举失败（详情见日志）") from exc
        return [await self._row_to_evidence(r) for r in rows]

    async def evidence_count(self, domain: str | None = None) -> int:
        """有证据边数（冷启动指数分子；domain=None = 全域计数）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute(
                    "SELECT COUNT(*) AS c FROM edge_evidence"
                )
            else:
                cur = await self._conn.execute(
                    "SELECT COUNT(*) AS c FROM edge_evidence WHERE context_domain=?",
                    (domain,),
                )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            logger.error(f"边证据计数失败: {exc}")
            raise StorageError("边证据计数失败（详情见日志）") from exc
        return int(row["c"]) if row else 0

    async def close(self) -> None:
        self._closed = True
        if self._conn is not None:
            await self._conn.close()
            self._conn = None


async def import_seed_paths(
    store: EdgeEvidenceStore,
    seed_edges: Sequence[dict[str, Any]],
) -> int:
    """种子路径导入（出厂资产通道只供数据：边证据初始化）。

    每条种子 = ``{src_type, dst_type, success_count, fail_count,
    context_domain?, src_contract_version?, dst_contract_version?,
    policy?}``。已存在同键行（运行期证据在先）不覆盖——运行统计是
    事实，种子只补空白。返回写入条数。
    """
    written = 0
    for raw in seed_edges:
        key = EdgeKey.from_dict(raw)
        existing = await store.get(key)
        if existing is not None:
            continue
        await store.put(
            EdgeEvidence(
                key=key,
                success_count=max(0, int(raw.get("success_count", 0))),
                fail_count=max(0, int(raw.get("fail_count", 0))),
                avg_cost=float(raw.get("avg_cost", 0.0)),
                policy=bool(raw.get("policy", False)),
                origin=ORIGIN_SEED,
                last_used_at=float(raw["last_used_at"]) if raw.get("last_used_at") else None,
                created_at=float(raw.get("created_at", 0.0)),
            )
        )
        written += 1
    return written


# ── 干预能力：信任档人工降级（档位更新 + 审计；可复原）──

# 降级前证据快照集合（反向操作 restore_edge_tier 据此回写原档，状态可复原）
EDGE_TIER_OVERRIDE_COLLECTION = "edge_tier_overrides"

# 目标档位 → 推导该档所需的最小成功/失败计数（保留原 avg_cost/policy/时间戳）
_TIER_TARGET_COUNTS = {
    TIER_OBSERVING: (0, 0),  # n<8（success=0 即 n=fail<8 或 n=0）→ 观察
    TIER_REGULAR: (8, 2),    # n≥8 且 p≥0.7 且 n<30 → 常规
    TIER_PROMOTED: (35, 3),  # n=38 且 p̂=36/40=0.9 → 转正（30,3 → p̂=0.886 落常规）
}


def _tier_rank(tier: str) -> int:
    """档位序（观察 0 < 常规 1 < 转正 2；未知档归观察）。"""
    return {TIER_OBSERVING: 0, TIER_REGULAR: 1, TIER_PROMOTED: 2}.get(tier, 0)


async def downgrade_edge_tier(
    store: EdgeEvidenceStore,
    key: EdgeKey,
    *,
    target_tier: str,
    storage: object | None = None,
    reason: str = "",
    now: float | None = None,
) -> dict[str, Any]:
    """信任档人工降级（档位更新 + 审计；降级前快照留痕，可经 restore 复原）。

    信任档由证据计数纯算法推导（``derive_edge_tier``），本函数把边证据改写
    为「恰好落在目标档」的计数（保留 avg_cost / policy / 时间戳），使推导档
    降至目标档——人工干预覆盖自动晋级。目标档非法 / 边不存在 = fail-closed
    拒绝（未知 id 不静默）；目标档高于当前档（已更低）= 不升档、仅留痕。

    降级前把原证据快照落 ``edge_tier_overrides`` 集合（按边主键），供
    :func:`restore_edge_tier` 反向复原。审计复用 ``policy_edge_review_audit``
    既有类型（边信任复审留痕），落 ``set_audit`` 集合。
    """
    if target_tier not in _TIER_TARGET_COUNTS:
        raise ValueError(f"未知信任档: {target_tier!r}（仅 observing/regular/promoted）")
    current = await store.get(key)
    if current is None:
        raise KeyError(f"边证据不存在（未知 id）: {key.key()}")
    ts = now if now is not None else time.time()
    current_tier = derive_edge_tier(current.success_count, current.fail_count)
    new_success, new_fail = _TIER_TARGET_COUNTS[target_tier]
    # 目标档不低于当前推导档：无需改写（不升档），仍记录干预动作
    if _tier_rank(target_tier) >= _tier_rank(current_tier):
        new_success, new_fail = current.success_count, current.fail_count
    if storage is not None:
        await storage.put_record(  # type: ignore[attr-defined]
            EDGE_TIER_OVERRIDE_COLLECTION, "::".join(key.key()), current.to_dict()
        )
        await emit_audit(
            storage,
            {
                "type": EVENT_AUDIT_POLICY_REVIEW,
                "ts": ts,
                "domain": key.context_domain,
                "src_type": key.src_type,
                "dst_type": key.dst_type,
                "reason": reason or "人工信任档降级",
                "action": "tier_downgraded",
                "from_tier": current_tier,
                "to_tier": target_tier,
                "review_tier": "l2",
            },
        )
    await store.put(
        EdgeEvidence(
            key=key,
            success_count=new_success,
            fail_count=new_fail,
            avg_cost=current.avg_cost,
            policy=current.policy,
            last_used_at=current.last_used_at,
            created_at=current.created_at,
        )
    )
    updated = await store.get(key)
    updated_tier = derive_edge_tier(updated.success_count, updated.fail_count) if updated else current_tier
    return {
        "src_type": key.src_type,
        "dst_type": key.dst_type,
        "domain": key.context_domain,
        "from_tier": current_tier,
        "to_tier": updated_tier,
        "changed": (new_success, new_fail) != (current.success_count, current.fail_count),
    }


async def restore_edge_tier(
    store: EdgeEvidenceStore,
    key: EdgeKey,
    *,
    storage: object | None = None,
) -> dict[str, Any] | None:
    """反向操作：恢复降级前的信任档（从 override 快照回写原证据计数）。

    回写后推导档回到干预前水平——配合 :func:`downgrade_edge_tier` 形成可
    复原闭环。无快照（未降级过 / 未知 id）= 返回 None（fail-closed 不报错）。

    .. note:: 接线现状（ENG9b-11）：当前无生产调用方——桥接层仅暴露
       降级 op（``edge.downgrade_tier``），本复原入口未导出为 op。
       保留为引擎机制完整性的反向操作（含测试），宿主暴露 op 后即可
       恢复可写复原链路；若长期无接线需求可删除。
    """
    if storage is None:
        return None
    snapshot = await storage.get_record(  # type: ignore[attr-defined]
        EDGE_TIER_OVERRIDE_COLLECTION, "::".join(key.key())
    )
    if snapshot is None:
        return None
    await store.put(EdgeEvidence.from_dict(snapshot))
    restored = await store.get(key)
    restored_tier = (
        derive_edge_tier(restored.success_count, restored.fail_count)
        if restored is not None
        else ""
    )
    return {
        "src_type": key.src_type,
        "dst_type": key.dst_type,
        "domain": key.context_domain,
        "to_tier": restored_tier,
        "restored": True,
    }


__all__ = [
    "DECAY_HALF_DAYS",
    "DEFAULT_CONTRACT_VERSION",
    "EXPLORATION_INDEX_THRESHOLD",
    "MULTIPATH_GAP",
    "MULTIPATH_MIN_N",
    "SATURATION_N",
    "TIER_OBSERVING",
    "TIER_PROMOTED",
    "TIER_PROMOTE_N",
    "TIER_PROMOTE_P",
    "TIER_REGULAR",
    "TIER_REGULAR_N",
    "TIER_REGULAR_P",
    "TIER_TAU",
    "ZERO_EVIDENCE_WEIGHT",
    "EdgeEvidence",
    "EdgeEvidenceStore",
    "EdgeKey",
    "EdgeScore",
    "cold_start_index",
    "derive_edge_tier",
    "downgrade_edge_tier",
    "edge_score",
    "import_seed_paths",
    "is_exploration_mode",
    "laplace_success",
    "multi_path_trigger",
    "restore_edge_tier",
    "sample_weight",
    "tier_tau",
    "time_decay",
    "zero_evidence_score",
]

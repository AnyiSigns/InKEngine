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

# 信任档推导阈值（与推荐先验晋升同一组常数；纯算法自动晋级零审批）
TIER_REGULAR_N = 8  # 常规：N ≥ 8 且 p̂ ≥ 0.7
TIER_REGULAR_P = 0.7
TIER_PROMOTE_N = 30  # 转正：N ≥ 30 且 p̂ ≥ 0.9
TIER_PROMOTE_P = 0.9

# 评分公式默认常数（引擎钉死；使用方仅覆盖权）
SATURATION_N = 8.0  # 样本量半饱和点（w_n 分母）
DECAY_HALF_DAYS = 30.0  # 时间衰减半衰期（天）
ZERO_EVIDENCE_WEIGHT = 1 / 9  # 零证据边 w_n 先验下界（评审决议）
ZERO_EVIDENCE_P = 0.5  # 零证据拉普拉斯先验成功率
ZERO_EVIDENCE_TAU = TIER_TAU[TIER_OBSERVING]

# 多径触发判据常数（与评分公式同源，不另定阈值）
MULTIPATH_MIN_N = 5  # 样本不足判定线（N < 5 = 样本不足）
MULTIPATH_GAP = 0.15  # 证据不足判定线（分差 < 0.15 且 N ≥ 5 = 方差高）

# 冷启动探索模式（指数计算与模式判定归引擎；默认参数引擎钉死）
EXPLORATION_INDEX_THRESHOLD = 0.3

# 信任档结果形态（声明式枚举，防魔法字符串）
TIER_S = "success"
TIER_F = "fail"


def laplace_success(success: int, fail: int) -> float:
    """拉普拉斯平滑成功率 p̂ = (s+1)/(s+f+2)（零证据先验 0.5）。"""
    return (success + 1) / (success + fail + 2)


def sample_weight(n: int) -> float:
    """样本量加权 w_n = max(n,1)/(max(n,1)+8)（零证据取 1/9 下界）。"""
    n = max(n, 1)
    return n / (n + SATURATION_N)


def time_decay(age_days: float, *, exempt: bool = False) -> float:
    """时间衰减 d(t) = exp(-age_days/30)；策略边豁免（恒 1.0）。"""
    if exempt or age_days <= 0:
        return 1.0
    return math.exp(-age_days / DECAY_HALF_DAYS)


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
) -> EdgeScore:
    """评分函数（公式形状 + 默认常数 = 引擎机制，使用方仅覆盖常数权）。

    Args:
        evidence: 边证据行（None = 零证据候选，取先验下界）。
        success/fail/age_days: 覆盖口径（测试与快照重算用；缺省取行内值）。
        now: 当前时间戳（缺省 = 实时；确定性测试注入）。
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
    d = time_decay(age_days, exempt=evidence.policy)
    return EdgeScore(
        score=p * w * d * tau,
        p=p, weight=w, decay=d, tau=tau, tier=tier,
    )


def rank_candidates(
    candidates: Sequence[EdgeEvidence],
    *,
    now: float | None = None,
) -> list[EdgeEvidence]:
    """beam 候选排序（确定性 tie-break：score 降序, avg_cost 升序,
    dst_type 字典序）——冷启动零分并列可断言。
    """
    return sorted(
        candidates,
        key=lambda e: (
            -edge_score(e, now=now).score,
            e.avg_cost,
            e.dst_type,
        ),
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
    """边主键（契约版本入键：升版后旧行自然不命中，无需重置逻辑）。"""

    src_type: str
    dst_type: str
    src_contract_version: str = DEFAULT_CONTRACT_VERSION
    dst_contract_version: str = DEFAULT_CONTRACT_VERSION
    context_domain: str = "default"

    def key(self) -> tuple[str, str, str, str, str]:
        return (
            self.src_type,
            self.dst_type,
            self.src_contract_version,
            self.dst_contract_version,
            self.context_domain,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "src_type": self.src_type,
            "dst_type": self.dst_type,
            "src_contract_version": self.src_contract_version,
            "dst_contract_version": self.dst_contract_version,
            "context_domain": self.context_domain,
        }

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
        )


@dataclass(frozen=True, slots=True)
class EdgeEvidence:
    """一条边的证据行（按域聚合的统计事实，可重建可顶替）。"""

    key: EdgeKey
    success_count: int
    fail_count: int
    avg_cost: float = 0.0
    policy: bool = False  # 策略边（声明式承诺）：评分 τ=1.0 且豁免时间衰减
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
    success_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0.0,
    policy INTEGER NOT NULL DEFAULT 0,
    last_used_at REAL,
    created_at REAL NOT NULL,
    PRIMARY KEY (src_type, dst_type, src_contract_version, dst_contract_version, context_domain)
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
                await self._conn.executescript(_SCHEMA_SQL)
                await self._conn.commit()
            except Exception as exc:
                if self._conn is not None:
                    await self._conn.close()
                    self._conn = None
                logger.error(f"边证据存储连接失败: {exc}")
                raise StorageError(f"边证据存储连接失败: {exc}") from exc

    async def _row_to_evidence(self, row: Any) -> EdgeEvidence:
        return EdgeEvidence(
            key=EdgeKey(
                src_type=row["src_type"],
                dst_type=row["dst_type"],
                src_contract_version=row["src_contract_version"],
                dst_contract_version=row["dst_contract_version"],
                context_domain=row["context_domain"],
            ),
            success_count=int(row["success_count"]),
            fail_count=int(row["fail_count"]),
            avg_cost=float(row["avg_cost"]),
            policy=bool(row["policy"]),
            last_used_at=float(row["last_used_at"]) if row["last_used_at"] is not None else None,
            created_at=float(row["created_at"]),
        )

    async def get(self, key: EdgeKey) -> EdgeEvidence | None:
        """按主键取证据（契约版本入键：升版后旧键自然不命中）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM edge_evidence WHERE src_type=? AND dst_type=?"
                " AND src_contract_version=? AND dst_contract_version=?"
                " AND context_domain=?",
                key.key(),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"边证据读取失败: {exc}") from exc
        return await self._row_to_evidence(row) if row else None

    async def record_success(
        self, key: EdgeKey, *, cost: float | None = None, now: float | None = None
    ) -> EdgeEvidence:
        """成功归集：success+1（成功才全边 success+1 的归因由调用方保证）。

        成本每次执行归集：avg_cost 滑动均值（按已记录样本数加权）。
        """
        return await self._record(key, delta_success=1, cost=cost, now=now)

    async def record_failure(
        self, key: EdgeKey, *, cost: float | None = None, now: float | None = None
    ) -> EdgeEvidence:
        """失败归集：fail+1（失败只记失败结点入边的归因由调用方保证）。"""
        return await self._record(key, delta_fail=1, cost=cost, now=now)

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
            existing = await self.get(key)
            if existing is None:
                new_avg = float(cost) if cost is not None else 0.0
                await self._insert(
                    key,
                    success_count=delta_success,
                    fail_count=delta_fail,
                    avg_cost=new_avg,
                    last_used_at=ts,
                )
                return EdgeEvidence(
                    key=key,
                    success_count=delta_success,
                    fail_count=delta_fail,
                    avg_cost=new_avg,
                    last_used_at=ts,
                    created_at=ts,
                )
            old_n = existing.success_count + existing.fail_count
            new_avg = existing.avg_cost
            if cost is not None:
                new_avg = (existing.avg_cost * old_n + float(cost)) / (old_n + 1)
            cur = await self._conn.execute(
                "UPDATE edge_evidence SET success_count=?, fail_count=?,"
                " avg_cost=?, last_used_at=? WHERE src_type=? AND dst_type=?"
                " AND src_contract_version=? AND dst_contract_version=?"
                " AND context_domain=?",
                (
                    existing.success_count + delta_success,
                    existing.fail_count + delta_fail,
                    new_avg,
                    ts,
                    *key.key(),
                ),
            )
            await self._conn.commit()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"边证据写入失败: {exc}") from exc
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
            " dst_contract_version, context_domain, success_count, fail_count,"
            " avg_cost, policy, last_used_at, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                key.src_type,
                key.dst_type,
                key.src_contract_version,
                key.dst_contract_version,
                key.context_domain,
                success_count,
                fail_count,
                avg_cost,
                int(policy),
                last_used_at,
                created_at if created_at is not None else last_used_at,
            ),
        )
        await self._conn.commit()

    async def put(self, evidence: EdgeEvidence) -> EdgeEvidence:
        """整行写入（种子导入/策略边声明用；已存在 = 覆盖更新）。"""
        await self._connect()
        try:
            existing = await self.get(evidence.key)
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
            else:
                cur = await self._conn.execute(
                    "UPDATE edge_evidence SET success_count=?, fail_count=?,"
                    " avg_cost=?, policy=?, last_used_at=?, created_at=?"
                    " WHERE src_type=? AND dst_type=? AND src_contract_version=?"
                    " AND dst_contract_version=? AND context_domain=?",
                    (
                        evidence.success_count,
                        evidence.fail_count,
                        evidence.avg_cost,
                        int(evidence.policy),
                        evidence.last_used_at,
                        evidence.created_at or existing.created_at,
                        *evidence.key.key(),
                    ),
                )
                await self._conn.commit()
                await cur.close()
        except Exception as exc:
            raise StorageError(f"边证据整行写入失败: {exc}") from exc
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
            raise StorageError(f"边证据枚举失败: {exc}") from exc
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
            raise StorageError(f"边证据计数失败: {exc}") from exc
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
    TIER_PROMOTED: (30, 3),  # n≥30 且 p≥0.9 → 转正
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
    "rank_candidates",
    "restore_edge_tier",
    "sample_weight",
    "tier_tau",
    "time_decay",
    "zero_evidence_score",
]

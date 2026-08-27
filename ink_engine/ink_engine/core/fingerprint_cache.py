"""指纹缓存存储与纯算法判定（组装结果按上下文指纹复用，派生数据可重建）。

缓存条目 = {上下文指纹(主键), 路径图定义序列化, 路径图指纹(Graph.digest),
证据快照(组装时各边 s/f 计数), 契约版本快照, 模型 id, 时间戳, 命中数,
失败数, 域}。设计要点（全部为机制侧事实）：

- **入缓存质量线**：无质量闸门注入 = fail-closed 不入缓存（沉淀钩子
  侧语义）；存储体只收 ``gate_passed=True`` 的写入；
- **容量上限 + 淘汰**：每域上限（默认 1000 条），达上限按「命中率 +
  时效」淘汰最差条目（命中率降序 → 时效升序 → 指纹字典序，确定性）；
- **契约版本 + 模型 id 钉死**：条目携带契约版本快照与模型 id，查找侧
  校验漂移后标记失效——旧条目「降级不命中」而非静默复用；
- **失效标记**：失效条目（执行失败/版本漂移/证据漂移）不再命中，但
  计数保留（命中数/失败数可观测，供基准与审计），被顶替/淘汰时移除；
- **顶替机制**：证据漂移或抽样重装后重组装比分更高 → 顶替旧条目并
  留 fingerprint_replace 审计（类型名与事件注册表登记一致，经既有
  审计 sink 通道落，不新发射引擎事件）。

存储形态：sqlite 独立表（派生数据，可由运行历史重建），沿既有
sqlite 后端先例（aiosqlite 惰性导入，测试默认内存库，跨会话持久
命中复用靠持久化 db_path）。
"""
from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .audit_log import emit_audit
from .edge_evidence import (
    DEFAULT_CONTRACT_VERSION,
    derive_edge_tier,
)
from .event_types import EVENT_AUDIT_FINGERPRINT_REPLACE
from .exceptions import StorageError
from .logging import get_logger

logger = get_logger(__name__)

# 每域容量上限（达上限按「命中率 + 时效」淘汰最差条目）
DEFAULT_CACHE_CAP_PER_DOMAIN = 1000
# 证据漂移判据常数：相对差 ≥ 0.2（且样本 N ≥ 5 才判漂移，防小样本噪声）
DRIFT_RATIO = 0.2
DRIFT_MIN_N = 5

# 顶替原因（声明式枚举，防魔法字符串）
REPLACE_REASON_DRIFT = "证据漂移"
REPLACE_REASON_SAMPLE = "抽样重装"

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS fingerprint_cache (
    context_fingerprint TEXT PRIMARY KEY,
    path_data TEXT NOT NULL,
    path_fingerprint TEXT NOT NULL DEFAULT '',
    evidence_snapshot TEXT NOT NULL DEFAULT '[]',
    contract_snapshot TEXT NOT NULL DEFAULT '[]',
    model_id TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT 'default',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    invalid INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fingerprint_cache_domain ON fingerprint_cache(domain);
"""


@dataclass(frozen=True, slots=True)
class FingerprintCacheEntry:
    """一条缓存条目（主键 = 上下文指纹；派生数据，可由运行历史重建）。

    Attributes:
        context_fingerprint: 上下文指纹主键（组装请求侧纯函数产出，
            与沉淀侧 upsert 键一致）。
        path: 路径图定义序列化（图定义数据形态；不可序列化图退化为
            ``{"fingerprint": 指纹}`` 只读身份形态）。
        path_fingerprint: 路径图指纹（Graph.digest）。
        evidence_snapshot: 证据快照（组装时域内各边 s/f 计数行）。
        contract_snapshot: 契约版本快照（类型名 → 契约版本对）。
        model_id: 模型标识（钉死：变化 = 降级不命中）。
        domain: 上下文域（容量淘汰按域分组）。
        created_at/updated_at: 创建/最近触碰时间戳。
        hit_count/fail_count: 命中成功/失败计数（执行回馈可观测）。
        invalid: 失效标记（失效条目不再命中，计数保留）。
    """

    context_fingerprint: str
    path: dict[str, Any]
    path_fingerprint: str
    evidence_snapshot: tuple[dict[str, Any], ...]
    contract_snapshot: tuple[tuple[str, str], ...]
    model_id: str
    domain: str
    created_at: float
    updated_at: float
    hit_count: int
    fail_count: int
    invalid: bool


def _contract_snapshot_from_path(path: Mapping[str, Any]) -> tuple[tuple[str, str], ...]:
    """契约版本快照：从路径图定义数据的节点绑定提取（类型 → 契约版本）。

    绑定内契约随图定义数据落库（契约即数据）；缺契约声明的绑定按
    缺省版本入快照。排序保确定性。
    """
    nodes = path.get("nodes") if isinstance(path, dict) else None
    if not isinstance(nodes, dict):
        return ()
    snapshot: list[tuple[str, str]] = []
    for spec in nodes.values():
        if not isinstance(spec, dict) or not spec.get("type"):
            continue
        contract = spec.get("contract")
        if isinstance(contract, dict) and contract.get("version") is not None:
            version = str(contract["version"])
        else:
            version = DEFAULT_CONTRACT_VERSION
        snapshot.append((str(spec["type"]), version))
    return tuple(sorted(snapshot))


def _edge_key_of(row: Mapping[str, Any]) -> tuple[str, str, str, str]:
    """证据行 → 边键（契约版本入键：升版后旧行自然不命中）。"""
    return (
        str(row.get("src_type", "")),
        str(row.get("dst_type", "")),
        str(row.get("src_contract_version", DEFAULT_CONTRACT_VERSION)),
        str(row.get("dst_contract_version", DEFAULT_CONTRACT_VERSION)),
    )


def evidence_drifted(
    snapshot: Sequence[Mapping[str, Any]],
    current: Sequence[Mapping[str, Any]],
    *,
    drift_ratio: float = DRIFT_RATIO,
    min_n: int = DRIFT_MIN_N,
) -> bool:
    """证据漂移判定：快照内任一边 s/f 计数相对差 ≥ 阈值或信任档变化。

    防小样本噪声：该边样本 N（快照与当前取大）< min_n 不判漂移；信任
    档按边证据推导式（观察/常规/转正）比较，档位变化即漂移——信任档
    是评分 τ 乘数的直接决定者，档变 = 评分依据变。快照未覆盖的当前
    新边不参与判定（新证据不推翻旧条目，探索走抽样重装通道）。
    """
    current_by_key = {_edge_key_of(row): row for row in current}
    for row in snapshot:
        cur = current_by_key.get(_edge_key_of(row))
        snap_s = int(row.get("success_count", 0))
        snap_f = int(row.get("fail_count", 0))
        cur_s = int(cur.get("success_count", 0)) if cur is not None else 0
        cur_f = int(cur.get("fail_count", 0)) if cur is not None else 0
        n = max(snap_s + snap_f, cur_s + cur_f)
        if n < min_n:
            continue
        denom = max(snap_s + snap_f, 1)
        if abs(cur_s - snap_s) / denom >= drift_ratio:
            return True
        if abs(cur_f - snap_f) / denom >= drift_ratio:
            return True
        if derive_edge_tier(snap_s, snap_f) != derive_edge_tier(cur_s, cur_f):
            return True
    return False


def fingerprint_replace_audit_record(
    *,
    domain: str,
    fingerprint: str,
    old_fingerprint: str,
    reason: str,
    old_score: float,
    new_score: float,
    ts: float,
) -> dict[str, Any]:
    """指纹顶替审计记录（append-only；类型名与事件注册表登记一致）。"""
    return {
        "type": EVENT_AUDIT_FINGERPRINT_REPLACE,
        "ts": ts,
        "domain": domain,
        "fingerprint": fingerprint,
        "old_fingerprint": old_fingerprint,
        "reason": reason,
        "old_score": old_score,
        "new_score": new_score,
    }


class FingerprintCacheStore:
    """指纹缓存存储（sqlite 独立表；派生数据，可由运行历史重建）。

    沿既有 sqlite 后端先例：aiosqlite 惰性导入（禁新增依赖），
    ``:memory:`` 为测试默认；持久化 db_path 支持跨会话命中复用。
    容量按域分组淘汰（命中率 + 时效）；失效条目不再命中但计数保留。
    """

    def __init__(
        self,
        db_path: str = ":memory:",
        *,
        cap_per_domain: int = DEFAULT_CACHE_CAP_PER_DOMAIN,
        now: float | None = None,
    ) -> None:
        self._db_path = db_path
        self._cap = max(1, int(cap_per_domain))
        self._now = now
        self._conn: Any = None
        self._closed = False
        self._init_lock: Any = None
        # 观测统计（查找/写入/失效/回馈/淘汰计数；供基准与审计）
        self.stats: dict[str, int] = {
            "lookups": 0,
            "upserts": 0,
            "invalidations": 0,
            "reports": 0,
            "evictions": 0,
        }

    async def _connect(self) -> None:
        if self._closed:
            raise StorageError("指纹缓存存储已关闭（close() 后不可再读写）")
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
                logger.error(f"指纹缓存存储连接失败: {exc}")
                raise StorageError(f"指纹缓存存储连接失败: {exc}") from exc

    def _ts(self) -> float:
        return self._now if self._now is not None else time.time()

    async def _row_to_entry(self, row: Any) -> FingerprintCacheEntry:
        return FingerprintCacheEntry(
            context_fingerprint=str(row["context_fingerprint"]),
            path=json.loads(row["path_data"]),
            path_fingerprint=str(row["path_fingerprint"]),
            evidence_snapshot=tuple(json.loads(row["evidence_snapshot"])),
            contract_snapshot=tuple(tuple(pair) for pair in json.loads(row["contract_snapshot"])),
            model_id=str(row["model_id"]),
            domain=str(row["domain"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
            hit_count=int(row["hit_count"]),
            fail_count=int(row["fail_count"]),
            invalid=bool(row["invalid"]),
        )

    async def upsert(
        self,
        fingerprint: str,
        *,
        path: Mapping[str, Any],
        evidence_snapshot: Sequence[Mapping[str, Any]],
        model_id: str,
        gate_passed: bool,
        path_fingerprint: str = "",
        domain: str = "default",
    ) -> bool:
        """写入/顶替缓存条目（fail-closed：``gate_passed=False`` 不落库）。

        已存在同主键 = 顶替（整行替换：新快照/计数清零/失效标记复位）。
        落库后按域执行容量淘汰（达上限淘汰最差条目）。
        """
        if not gate_passed:
            return False  # 入缓存质量线：质量线以下不入缓存
        await self._connect()
        ts = self._ts()
        contract_snapshot = _contract_snapshot_from_path(path)
        try:
            await self._conn.execute(
                "INSERT OR REPLACE INTO fingerprint_cache (context_fingerprint,"
                " path_data, path_fingerprint, evidence_snapshot, contract_snapshot,"
                " model_id, domain, created_at, updated_at, hit_count, fail_count, invalid)"
                " VALUES (?,?,?,?,?,?,?,?,?,0,0,0)",
                (
                    fingerprint,
                    json.dumps(dict(path), ensure_ascii=False, sort_keys=True),
                    path_fingerprint,
                    json.dumps(
                        [dict(e) for e in evidence_snapshot],
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    json.dumps(contract_snapshot, ensure_ascii=False),
                    model_id,
                    domain,
                    ts,
                    ts,
                ),
            )
            await self._conn.commit()
        except Exception as exc:
            raise StorageError(f"指纹缓存写入失败: {exc}") from exc
        self.stats["upserts"] += 1
        await self._evict_if_over_cap(domain)
        return True

    async def lookup(self, fingerprint: str) -> FingerprintCacheEntry | None:
        """按主键取有效条目（失效条目不命中——降级不命中而非静默复用）。"""
        await self._connect()
        self.stats["lookups"] += 1
        try:
            cur = await self._conn.execute(
                "SELECT * FROM fingerprint_cache WHERE context_fingerprint=?"
                " AND invalid=0",
                (fingerprint,),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存读取失败: {exc}") from exc
        return await self._row_to_entry(row) if row else None

    async def get(self, fingerprint: str) -> FingerprintCacheEntry | None:
        """按主键取任意条目（含失效；审计/测试/顶替比较用）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM fingerprint_cache WHERE context_fingerprint=?",
                (fingerprint,),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存读取失败: {exc}") from exc
        return await self._row_to_entry(row) if row else None

    async def invalidate(self, fingerprint: str, *, reason: str = "") -> bool:
        """标记失效（降级不命中）：计数保留，被顶替/淘汰时移除。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "UPDATE fingerprint_cache SET invalid=1, updated_at=?"
                " WHERE context_fingerprint=? AND invalid=0",
                (self._ts(), fingerprint),
            )
            await self._conn.commit()
            updated = cur.rowcount > 0
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存失效标记失败: {exc}") from exc
        if updated:
            self.stats["invalidations"] += 1
            if reason:
                logger.info(f"指纹缓存条目失效[{reason}]: {fingerprint}")
        return updated

    async def report(self, fingerprint: str, *, ok: bool) -> bool:
        """缓存路径执行回馈：命中成功 → 命中数+1 并刷新时间戳；命中失败
        → 失败数+1 且条目立即失效（不命中），调用方重组装。"""
        await self._connect()
        ts = self._ts()
        try:
            if ok:
                cur = await self._conn.execute(
                    "UPDATE fingerprint_cache SET hit_count=hit_count+1,"
                    " updated_at=? WHERE context_fingerprint=?",
                    (ts, fingerprint),
                )
            else:
                cur = await self._conn.execute(
                    "UPDATE fingerprint_cache SET fail_count=fail_count+1,"
                    " invalid=1, updated_at=? WHERE context_fingerprint=?"
                    " AND invalid=0",
                    (ts, fingerprint),
                )
            await self._conn.commit()
            updated = cur.rowcount > 0
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存回馈失败: {exc}") from exc
        if updated:
            self.stats["reports"] += 1
        return updated

    async def remove(self, fingerprint: str) -> bool:
        """物理移除（容量淘汰/清理用；派生数据可重建）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "DELETE FROM fingerprint_cache WHERE context_fingerprint=?",
                (fingerprint,),
            )
            await self._conn.commit()
            removed = cur.rowcount > 0
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存移除失败: {exc}") from exc
        return removed

    async def count(self, domain: str | None = None) -> int:
        """条目计数（含失效；domain=None = 全域计数）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute(
                    "SELECT COUNT(*) AS c FROM fingerprint_cache"
                )
            else:
                cur = await self._conn.execute(
                    "SELECT COUNT(*) AS c FROM fingerprint_cache WHERE domain=?",
                    (domain,),
                )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存计数失败: {exc}") from exc
        return int(row["c"]) if row else 0

    async def entries(self, domain: str | None = None) -> list[FingerprintCacheEntry]:
        """枚举条目（含失效；审计/测试用）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute(
                    "SELECT * FROM fingerprint_cache ORDER BY context_fingerprint"
                )
            else:
                cur = await self._conn.execute(
                    "SELECT * FROM fingerprint_cache WHERE domain=?"
                    " ORDER BY context_fingerprint",
                    (domain,),
                )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"指纹缓存枚举失败: {exc}") from exc
        return [await self._row_to_entry(r) for r in rows]

    async def _evict_if_over_cap(self, domain: str) -> None:
        """容量淘汰：域内条目数超上限 → 按「命中率升序 → 时效升序 →
        指纹字典序」淘汰最差条目（确定性序）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT COUNT(*) AS c FROM fingerprint_cache WHERE domain=?",
                (domain,),
            )
            row = await cur.fetchone()
            await cur.close()
            over = int(row["c"]) - self._cap
            if over <= 0:
                return
            cur = await self._conn.execute(
                "SELECT context_fingerprint FROM fingerprint_cache WHERE domain=?"
                " ORDER BY (CASE WHEN hit_count + fail_count = 0 THEN 0.0"
                " ELSE hit_count * 1.0 / (hit_count + fail_count) END) ASC,"
                " updated_at ASC, context_fingerprint ASC LIMIT ?",
                (domain, over),
            )
            victims = [r["context_fingerprint"] for r in await cur.fetchall()]
            await cur.close()
            for victim in victims:
                await self.remove(victim)
            self.stats["evictions"] += len(victims)
        except Exception as exc:
            raise StorageError(f"指纹缓存淘汰失败: {exc}") from exc

    async def close(self) -> None:
        self._closed = True
        if self._conn is not None:
            await self._conn.close()
            self._conn = None


async def invalidate_cache(
    store: FingerprintCacheStore,
    scope: str,
    *,
    storage: object | None = None,
    reason: str = "",
    now: float | None = None,
) -> dict[str, Any]:
    """指纹缓存语义化失效（复用既有 ``invalidate`` 单条/整库失效机制）。

    scope 三种形态：
    - ``"*"`` / ``"all"``：整库失效（逐项 invalidate，计数累加）；
    - ``"domain:<域>"``：指定域全部条目失效；
    - 其余：按上下文指纹单条失效（未知指纹 = 0 条失效，fail-closed 不报错）。

    空 scope = fail-closed 拒绝（不静默吞错）。每条失效经既有 ``invalidate``
    走「降级不命中」语义，被顶替/淘汰时移除——本函数不另起实现。审计复用
    ``fingerprint_replace_audit`` 既有类型（缓存相关留痕），落 ``set_audit``
    集合。反向复原 = 重新 upsert 该指纹（命中恢复）。
    """
    if not scope:
        raise ValueError("缓存失效 scope 不能为空（fail-closed）")
    invalidated = 0
    # 审计 domain 从 scope 解析真实域（ENG9b-6）：旧实现硬编码 "default"
    # 会在非 default 域失效时留下错误域归属的审计记录。三种形态：
    # domain:<域> → 该域；单条指纹 → 从缓存条目反查所属域；全域失效 →
    # 空串（跨域操作，不冒认单一域）。
    domain_label = ""
    if scope in ("*", "all"):
        for entry in await store.entries():
            if await store.invalidate(entry.context_fingerprint, reason=reason):
                invalidated += 1
    elif scope.startswith("domain:"):
        domain = scope[len("domain:"):]
        domain_label = domain
        for entry in await store.entries(domain or None):
            if await store.invalidate(entry.context_fingerprint, reason=reason):
                invalidated += 1
    else:
        if await store.invalidate(scope, reason=reason):
            invalidated += 1
        for entry in await store.entries():
            if entry.context_fingerprint == scope:
                domain_label = entry.domain
                break
    ts = now if now is not None else time.time()
    await emit_audit(
        storage,
        {
            "type": EVENT_AUDIT_FINGERPRINT_REPLACE,
            "ts": ts,
            "domain": domain_label,
            "fingerprint": scope if scope not in ("*", "all") else "",
            "reason": reason or "人工失效",
            "invalidated": invalidated,
        },
    )
    return {"invalidated": invalidated, "scope": scope}


__all__ = [
    "DEFAULT_CACHE_CAP_PER_DOMAIN",
    "DRIFT_MIN_N",
    "DRIFT_RATIO",
    "REPLACE_REASON_DRIFT",
    "REPLACE_REASON_SAMPLE",
    "FingerprintCacheEntry",
    "FingerprintCacheStore",
    "evidence_drifted",
    "fingerprint_replace_audit_record",
    "invalidate_cache",
]

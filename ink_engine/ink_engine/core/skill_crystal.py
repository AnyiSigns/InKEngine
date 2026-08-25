"""技能结晶（命名化缓存条目 + 派生可重建 sqlite 存储 + 沉淀自动结晶）。

数据源：指纹缓存已沉淀的 ``FingerprintCacheEntry``（路径序列化 / 证据快照 /
命中失败计数 / 契约快照 / 模型 id / 域）。技能 = 命名化缓存条目
（name/version/domain/测试报告/来源路径），沉淀钩子在读到「命中数 ≥ N 且
命中率 ≥ 阈值」的缓存条目后自动结晶为可分享技能；阈值为可配置参数，附默认值。

存储形态：sqlite 独立表（派生数据，可由指纹缓存运行历史重建），沿既有
fingerprint_cache 存储先例（aiosqlite 惰性导入，测试默认内存库）。

视觉技能扩展：高频成功的视觉路径（输入 = image、输出 = 结构化提取，对应
P3.5 感知结点 image→描述链路）按同阈值结晶为视觉技能（kind=visual），结晶
逻辑与通用路径完全同构，仅分类标签与导出语义不同。

导出格式：JSON（技能元数据 + 路径定义 + 测试报告），可经技能市场同构获取层
分享与导入（导入走补丁链 vetting）。
"""
from __future__ import annotations

import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .exceptions import StorageError
from .logging import get_logger

logger = get_logger(__name__)

# 结晶阈值默认值（可配置；hit 数下限 + 命中率下限，双条件 AND）
SKILL_HIT_MIN_DEFAULT = 5
SKILL_SUCCESS_RATE_DEFAULT = 0.8

# 技能分类（声明式枚举，防魔法字符串）
SKILL_KIND_PATH = "path"
SKILL_KIND_VISUAL = "visual"

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS skills (
    name TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    domain TEXT NOT NULL DEFAULT 'default',
    fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'path',
    path_data TEXT NOT NULL DEFAULT '{}',
    contract_snapshot TEXT NOT NULL DEFAULT '[]',
    evidence_snapshot TEXT NOT NULL DEFAULT '[]',
    model_id TEXT NOT NULL DEFAULT '',
    hit_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    test_report TEXT NOT NULL DEFAULT '{}',
    source_path TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS idx_skills_domain ON skills(domain);
"""


@dataclass(frozen=True, slots=True)
class SkillEntry:
    """一条技能（命名化缓存条目；派生数据，可由指纹缓存重建）。

    Attributes:
        name/version: 技能身份（同名重结晶 = 版本递增，旧版本保留可追溯）。
        domain: 上下文域（与指纹缓存同源）。
        fingerprint: 来源路径指纹（Graph.digest；技能可追溯回缓存条目）。
        kind: ``path`` 通用路径技能 / ``visual`` 视觉技能（输入 image→
            结构化提取）。
        path: 路径图定义序列化（可重建 DOM/图）。
        contract_snapshot: 契约版本快照（类型名 → 契约版本对）。
        evidence_snapshot: 证据快照（域内各边 s/f 计数行）。
        model_id: 模型标识（结晶时钉死）。
        hit_count/fail_count: 结晶所据命中/失败计数（来源缓存条目）。
        test_report: 测试报告（命中率/样本边/生成时间，随导出分享）。
        source_path: 来源路径指纹（可读来源标识，与 fingerprint 同源）。
        created_at/updated_at: 创建/最近触碰时间戳。
    """

    name: str
    version: int
    domain: str
    fingerprint: str
    kind: str
    path: dict[str, Any]
    contract_snapshot: tuple[tuple[str, str], ...]
    evidence_snapshot: tuple[dict[str, Any], ...]
    model_id: str
    hit_count: int
    fail_count: int
    test_report: dict[str, Any]
    source_path: str
    created_at: float
    updated_at: float


def classify_skill_kind(path: Mapping[str, Any]) -> str:
    """技能分类：路径首结点消费 image 字段（或结点类型含视觉语义）=
    视觉技能，否则通用路径技能。

    判定纯算法、零 LLM：遍历路径结点契约的输入字段名与结点类型名
    （大小写不敏感），命中 image/视觉语义即判视觉——P3.5 感知结点
    image→描述链路的结晶标签来源。
    """
    if not isinstance(path, dict):
        return SKILL_KIND_PATH
    nodes = path.get("nodes")
    if not isinstance(nodes, dict):
        return SKILL_KIND_PATH
    visual_type_tokens = ("vision", "perceive", "image", "ocr", "describe", "screenshot")
    for spec in nodes.values():
        if not isinstance(spec, dict):
            continue
        type_name = str(spec.get("type", "")).lower()
        if any(token in type_name for token in visual_type_tokens):
            return SKILL_KIND_VISUAL
        contract = spec.get("contract") or {}
        input_schema = spec.get("input_schema") or contract.get("input_schema")
        fields = (input_schema or {}).get("fields") or []
        for field in fields:
            if not isinstance(field, dict):
                continue
            name = str(field.get("name", "")).lower()
            if "image" in name or name in ("screenshot", "picture", "snapshot"):
                return SKILL_KIND_VISUAL
    return SKILL_KIND_PATH


def _skill_name(fingerprint: str, domain: str, kind: str) -> str:
    """技能名（确定性：分类 + 域 + 指纹前缀；同名重结晶版本递增）。"""
    return f"{kind}.{domain}.{fingerprint[:12]}"


def build_test_report(
    *,
    name: str,
    version: int,
    domain: str,
    model_id: str,
    hit_count: int,
    fail_count: int,
    success_rate: float,
    evidence_snapshot: Sequence[Mapping[str, Any]],
    kind: str,
    now: float,
) -> dict[str, Any]:
    """测试报告（随技能导出分享；含命中率/样本边/生成时间）。

    样本边 = 证据快照按净成功（success-fail）降序取前五，供接收方评估
    技能可靠性；报告不携带任何运行时状态，纯派生事实。
    """
    ordered = sorted(
        evidence_snapshot,
        key=lambda r: (
            int(r.get("success_count", 0)) - int(r.get("fail_count", 0))
        ),
        reverse=True,
    )
    sample_edges = [
        {
            "src_type": r.get("src_type"),
            "dst_type": r.get("dst_type"),
            "success_count": int(r.get("success_count", 0)),
            "fail_count": int(r.get("fail_count", 0)),
        }
        for r in ordered[:5]
    ]
    return {
        "skill_name": name,
        "version": version,
        "skill_kind": kind,
        "domain": domain,
        "model_id": model_id,
        "success_rate": round(success_rate, 4),
        "hit_count": hit_count,
        "fail_count": fail_count,
        "sample_edges": sample_edges,
        "generated_at": now,
        "note": "自动结晶：命中数达阈值且命中率达标（来源指纹缓存条目）",
    }


def _success_rate(hit_count: int, fail_count: int) -> float:
    total = hit_count + fail_count
    return (hit_count / total) if total > 0 else 0.0


class SkillStore:
    """技能存储（sqlite 独立表；派生数据，可由指纹缓存运行历史重建）。

    沿既有 sqlite 后端先例：aiosqlite 惰性导入（禁新增依赖），
    ``:memory:`` 为测试默认；``name + version`` 为主键，同名重结晶版本递增。
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._db_path = db_path
        self._conn: Any = None
        self._closed = False
        self._init_lock: Any = None

    async def _connect(self) -> None:
        if self._closed:
            raise StorageError("技能存储已关闭（close() 后不可再读写）")
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
                logger.error(f"技能存储连接失败: {exc}")
                raise StorageError(f"技能存储连接失败: {exc}") from exc

    def _ts(self) -> float:
        return time.time()

    async def _row_to_entry(self, row: Any) -> SkillEntry:
        return SkillEntry(
            name=str(row["name"]),
            version=int(row["version"]),
            domain=str(row["domain"]),
            fingerprint=str(row["fingerprint"]),
            kind=str(row["kind"]),
            path=json.loads(row["path_data"]),
            contract_snapshot=tuple(
                tuple(pair) for pair in json.loads(row["contract_snapshot"])
            ),
            evidence_snapshot=tuple(json.loads(row["evidence_snapshot"])),
            model_id=str(row["model_id"]),
            hit_count=int(row["hit_count"]),
            fail_count=int(row["fail_count"]),
            test_report=json.loads(row["test_report"]),
            source_path=str(row["source_path"]),
            created_at=float(row["created_at"]),
            updated_at=float(row["updated_at"]),
        )

    async def upsert(self, entry: SkillEntry) -> None:
        """写入技能（同名同版本整行替换；调用方负责版本递增）。"""
        await self._connect()
        ts = self._ts()
        try:
            await self._conn.execute(
                "INSERT OR REPLACE INTO skills (name, version, domain, fingerprint,"
                " kind, path_data, contract_snapshot, evidence_snapshot, model_id,"
                " hit_count, fail_count, test_report, source_path, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    entry.name,
                    entry.version,
                    entry.domain,
                    entry.fingerprint,
                    entry.kind,
                    json.dumps(dict(entry.path), ensure_ascii=False, sort_keys=True),
                    json.dumps(entry.contract_snapshot, ensure_ascii=False),
                    json.dumps(
                        [dict(e) for e in entry.evidence_snapshot],
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    entry.model_id,
                    entry.hit_count,
                    entry.fail_count,
                    json.dumps(entry.test_report, ensure_ascii=False),
                    entry.source_path,
                    entry.created_at,
                    ts,
                ),
            )
            await self._conn.commit()
        except Exception as exc:
            raise StorageError(f"技能写入失败: {exc}") from exc

    async def get(self, name: str, version: int | None = None) -> SkillEntry | None:
        """按名取技能（version=None = 取最新版本）。"""
        await self._connect()
        try:
            if version is None:
                cur = await self._conn.execute(
                    "SELECT * FROM skills WHERE name=? ORDER BY version DESC LIMIT 1",
                    (name,),
                )
            else:
                cur = await self._conn.execute(
                    "SELECT * FROM skills WHERE name=? AND version=?",
                    (name, version),
                )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"技能读取失败: {exc}") from exc
        return await self._row_to_entry(row) if row else None

    async def get_by_fingerprint(self, fingerprint: str) -> SkillEntry | None:
        """按来源指纹取最新版本（结晶去重/版本递增判定用）。"""
        await self._connect()
        try:
            cur = await self._conn.execute(
                "SELECT * FROM skills WHERE fingerprint=? ORDER BY version DESC LIMIT 1",
                (fingerprint,),
            )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"技能读取失败: {exc}") from exc
        return await self._row_to_entry(row) if row else None

    async def list(self, domain: str | None = None) -> list[SkillEntry]:
        """枚举技能（domain=None = 全域；按名+版本升序确定性序）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute(
                    "SELECT * FROM skills ORDER BY name, version"
                )
            else:
                cur = await self._conn.execute(
                    "SELECT * FROM skills WHERE domain=? ORDER BY name, version",
                    (domain,),
                )
            rows = await cur.fetchall()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"技能枚举失败: {exc}") from exc
        return [await self._row_to_entry(r) for r in rows]

    async def delete(self, name: str) -> bool:
        """删除某技能全部版本（派生数据可重建）。"""
        await self._connect()
        try:
            cur = await self._conn.execute("DELETE FROM skills WHERE name=?", (name,))
            await self._conn.commit()
            removed = cur.rowcount > 0
            await cur.close()
        except Exception as exc:
            raise StorageError(f"技能删除失败: {exc}") from exc
        return removed

    async def count(self, domain: str | None = None) -> int:
        """技能计数（含全部版本；domain=None = 全域）。"""
        await self._connect()
        try:
            if domain is None:
                cur = await self._conn.execute("SELECT COUNT(*) AS c FROM skills")
            else:
                cur = await self._conn.execute(
                    "SELECT COUNT(*) AS c FROM skills WHERE domain=?", (domain,)
                )
            row = await cur.fetchone()
            await cur.close()
        except Exception as exc:
            raise StorageError(f"技能计数失败: {exc}") from exc
        return int(row["c"]) if row else 0

    async def close(self) -> None:
        self._closed = True
        if self._conn is not None:
            await self._conn.close()
            self._conn = None


def export_skill(entry: SkillEntry, *, dest: str | None = None) -> dict[str, Any]:
    """导出技能为可分享 JSON 结构（技能市场导入与该导出同构）。

    导出体 = 技能元数据 + 路径定义 + 测试报告 + 来源指纹；``dest`` 给定
    时落盘为 JSON 文件（路径随返回），否则仅返回结构（调用方决定落点）。
    """
    payload: dict[str, Any] = {
        "format": "inkling.skill/v1",
        "name": entry.name,
        "version": entry.version,
        "domain": entry.domain,
        "kind": entry.kind,
        "fingerprint": entry.fingerprint,
        "source_path": entry.source_path,
        "model_id": entry.model_id,
        "hit_count": entry.hit_count,
        "fail_count": entry.fail_count,
        "contract_snapshot": list(entry.contract_snapshot),
        "evidence_snapshot": [dict(e) for e in entry.evidence_snapshot],
        "path": dict(entry.path),
        "test_report": dict(entry.test_report),
    }
    if dest:
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        payload["_export_path"] = dest
    return payload


async def crystallize_from_cache(
    cache_store: Any,
    skill_store: SkillStore,
    *,
    hit_min: int = SKILL_HIT_MIN_DEFAULT,
    success_rate: float = SKILL_SUCCESS_RATE_DEFAULT,
    now: float | None = None,
) -> list[str]:
    """从指纹缓存自动结晶技能（读 entries，命中数/命中率双阈值达标即结晶）。

    去重：同指纹技能已存在且计数与指纹均未变化 = 跳过；否则版本递增重写
    （保留历史版本可追溯）。返回本次新结晶/更新的技能名清单。视觉路径经
    ``classify_skill_kind`` 标记为 ``visual``，结晶同构。

    调用方须传入指纹缓存存储与技能存储；任一为 None = fail-closed 不结晶。
    """
    if cache_store is None or skill_store is None:
        return []
    ts = now if now is not None else time.time()
    created: list[str] = []
    for entry in await cache_store.entries():
        if getattr(entry, "invalid", False):
            continue
        if entry.hit_count < hit_min:
            continue
        rate = _success_rate(entry.hit_count, entry.fail_count)
        if rate < success_rate:
            continue
        kind = classify_skill_kind(entry.path)
        name = _skill_name(entry.path_fingerprint, entry.domain, kind)
        existing = await skill_store.get_by_fingerprint(entry.path_fingerprint)
        if (
            existing is not None
            and existing.hit_count == entry.hit_count
            and existing.fail_count == entry.fail_count
            and existing.fingerprint == entry.path_fingerprint
        ):
            continue
        version = (existing.version + 1) if existing is not None else 1
        report = build_test_report(
            name=name,
            version=version,
            domain=entry.domain,
            model_id=entry.model_id,
            hit_count=entry.hit_count,
            fail_count=entry.fail_count,
            success_rate=rate,
            evidence_snapshot=entry.evidence_snapshot,
            kind=kind,
            now=ts,
        )
        skill = SkillEntry(
            name=name,
            version=version,
            domain=entry.domain,
            fingerprint=entry.path_fingerprint,
            kind=kind,
            path=dict(entry.path),
            contract_snapshot=tuple(entry.contract_snapshot),
            evidence_snapshot=tuple(entry.evidence_snapshot),
            model_id=entry.model_id,
            hit_count=entry.hit_count,
            fail_count=entry.fail_count,
            test_report=report,
            source_path=entry.path_fingerprint,
            created_at=ts,
            updated_at=ts,
        )
        await skill_store.upsert(skill)
        created.append(name)
    return created


class SkillCrystallizeHook:
    """沉淀后处理：指纹缓存达标条目自动结晶为技能（FingerprintSettleHook 后继）。

    零 LLM：纯算法读缓存 entries，达「命中数 ≥ N 且命中率 ≥ 阈值」即结晶，
    阈值可配置。未注入缓存/技能存储 = fail-closed 不结晶（与指纹缓存同纪律）。
    """

    def __init__(
        self,
        cache_store: Any,
        skill_store: SkillStore,
        *,
        hit_min: int = SKILL_HIT_MIN_DEFAULT,
        success_rate: float = SKILL_SUCCESS_RATE_DEFAULT,
    ) -> None:
        self._cache = cache_store
        self._skill_store = skill_store
        self._hit_min = hit_min
        self._success_rate = success_rate
        # 本次 run 结晶的技能名（供测试断言自动结晶语义）
        self.crystallized: list[str] = []

    async def settle(self, ctx: Any) -> None:
        if self._cache is None or self._skill_store is None:
            return
        self.crystallized = await crystallize_from_cache(
            self._cache,
            self._skill_store,
            hit_min=self._hit_min,
            success_rate=self._success_rate,
        )


__all__ = [
    "SKILL_HIT_MIN_DEFAULT",
    "SKILL_KIND_PATH",
    "SKILL_KIND_VISUAL",
    "SKILL_SUCCESS_RATE_DEFAULT",
    "SkillCrystallizeHook",
    "SkillEntry",
    "SkillStore",
    "build_test_report",
    "classify_skill_kind",
    "crystallize_from_cache",
    "export_skill",
]

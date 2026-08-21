"""孵化闭环：行为信号 → 蒸馏 → 知识沉淀，与演化收敛管制（冷却/冻结）。

引擎侧三件机制已就绪但相互独立：``knowledge_signals``（信号分类与
确定性蒸馏）、``knowledge_set``（知识集与复用检索）、``evolution``
（失败驱动的进化工厂）。本模块在宿主侧把它们串联成「越用越进化」
的闭环，并补上收敛管制防止「越改越差」：

- **信号源** = 集演化审计（审批决策/回退/冲突）——行为信号的权威
  载体，每回合尾与每次回退后增量消费（游标持久化，崩溃/取消后续跑）；
- **蒸馏按需触发**（复杂度/干预双阈值，与引擎蒸馏语义一致），产物
  走应用管线的 knowledge 补丁（孵化专属管线 L0 直过——确定性蒸馏
  产物 + 来源留痕 + 可回退；宿主可整表替换分级）；
- **自身产物不参与后续信号分类**（origin=incubation 跳过），防自我
  强化循环；游标 + 内容幂等保证重复触发不产生重复补丁；
- **收敛管制**：同目标重写/回退/拒批超过阈值 → 冷却（禁提案，到时
  自动恢复）→ 连续触发升级冻结（更长时间窗），状态持久化重启不丢。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_AUTO,
    DECISION_EDIT,
    DECISION_REJECT,
    DECISION_TERMINATE,
)
from ink_engine.core.knowledge_set import (
    KIND_INSIGHT,
    KnowledgeEntry,
    default_credibility,
)
from ink_engine.core.knowledge_signals import (
    DEFAULT_COMPLEXITY_THRESHOLD,
    DEFAULT_INTERVENTION_THRESHOLD,
    REPEAT_THRESHOLD,
    SOURCE_USER,
    DeterministicDistiller,
    ExecutionSignal,
    SignalClassifier,
    reuse_or_distill,
)
from ink_engine.core.self_application import (
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_CONFLICT,
    AUDIT_STATUS_INVALID,
    AUDIT_STATUS_REJECTED,
    SEGMENT_TO_KIND,
    SET_AUDIT_COLLECTION,
)
from ink_engine.core.self_proposal import PatchKind, SelfProposal

logger = logging.getLogger(__name__)

# 集演化审计集合（权威名来自引擎自指层——单一来源，防双份字面量漂移）
_AUDIT_COLLECTION = SET_AUDIT_COLLECTION
# 演化状态集合（游标/冷却状态/孵化留痕；非集内可演化资产，不受旁路写防护）
_EVOLUTION_COLLECTION = "evolution"
# 孵化游标键（已消费审计的锚点记录；增量消费的断点）
_CURSOR_KEY = "incubate_cursor"
# 孵化留痕键（有界环形留痕：单键保存最近若干条，防集合无限膨胀）
_LOG_KEY = "incubate_log"
# 冷却状态键前缀（按目标独立记录）
_COOLDOWN_KEY_PREFIX = "cooldown:"

# 孵化留痕保留上限（演化日志非审计载体——审计权威在 set_audit）
_LOG_KEEP = 50
# 孵化条目 id 前缀（与种子条目 id 前缀区分，防回捞基线）
_INCUBATE_ID_PREFIX = "incubate."

# 信号摄入新鲜度窗口（升级部署时防全历史蒸馏：只学习近窗口的行为
# 证据——过期语境对当前形态无参考价值；超窗记录被静默消费不阻塞游标）
_INGESTION_WINDOW_SECONDS = 7 * 24 * 3600

# 收敛管制阈值（近窗口聚合；同目标反复折腾 = 演化不收敛的判据）
_COOLDOWN_REJECT_THRESHOLD = 3  # 近窗口用户拒批 ≥ 该值 → 冷却
_COOLDOWN_REVERT_THRESHOLD = 2  # 近窗口回退 ≥ 该值 → 冷却
_COOLDOWN_REWRITE_THRESHOLD = 5  # 近窗口同目标重写 ≥ 该值 → 冷却
_WINDOW_SECONDS = 24 * 3600  # 指标聚合窗口（近一天）
_COOLDOWN_SECONDS = 30 * 60  # 冷却时长（到时自动恢复）
_FREEZE_AFTER_COOLDOWNS = 2  # 连续触发冷却 ≥ 该值 → 升级冻结
_FREEZE_SECONDS = 24 * 3600  # 冻结时长（更长时间窗，强制换策略）

# 查询文本与标题长度上限（有界输出，防日志/条目膨胀）
_QUERY_MAX_CHARS = 200
_TITLE_MAX_CHARS = 64


def target_key_of(kind: Any, payload: Any) -> str:
    """补丁目标键（收敛管制按目标聚合的键：类型 + 名称段）。

    名称段取各类型的关键字段（界面名/工具名/规则 id/知识条目 id/
    harness 名/事件类型名/环境名/产物 id）；theme 无实例名，整类
    合并为单一目标。回退记录（kind=revert）从 last_patch 路径段
    反推类型与名称（路径段与补丁类型词汇对齐：tools→tool 等）。
    """
    kind = kind.value if isinstance(kind, PatchKind) else str(kind or "")
    if not isinstance(payload, dict):
        return kind or "unknown"
    if kind == "revert":
        last = payload.get("last_patch")
        path = last.get("path") if isinstance(last, dict) else None
        if isinstance(path, list) and path:
            # 路径段 → 补丁类型映射取自引擎单一来源（SEGMENT_TO_KIND），
            # 与补丁落点路径段同源维护，防宿主第二份映射漂移
            resolved = SEGMENT_TO_KIND.get(str(path[0] or ""), str(path[0] or ""))
            name = str(path[1]) if len(path) > 1 else ""
            return f"{resolved}:{name}" if name else resolved
        return "revert"
    name = ""
    if kind == "ui":
        spec = payload.get("spec")
        name = spec.get("name") if isinstance(spec, dict) else ""
    elif kind == "theme":
        return "theme"
    elif kind == "tool":
        name = payload.get("name")
    elif kind == "rule":
        rule = payload.get("rule")
        name = rule.get("id") if isinstance(rule, dict) else payload.get("rule_id")
    elif kind == "knowledge":
        entry = payload.get("entry")
        name = entry.get("id") if isinstance(entry, dict) else payload.get("entry_id")
    elif kind == "harness":
        definition = payload.get("definition")
        name = definition.get("name") if isinstance(definition, dict) else ""
    elif kind in ("event_type", "environment", "artifact"):
        name = payload.get("name") or payload.get("artifact_id")
    return f"{kind}:{name}" if name else kind


def _audit_event_of(record: dict) -> dict | None:
    """审计记录 → 信号分类事件（非信号形态/自身产物返回 None）。

    映射语义（行为证据 → 可学习信号）：
    - 用户拒批/终止/编辑（rejected）→ 修正反例（user_correction）；
    - 用户确认落地（applied + accept）→ 可复用经验（insight）；
    - 编辑后落地（applied + edit）→ 修正反例（user_correction）；
    - 形态非法/基准冲突 → 踩坑（pitfall）；
    - 回退 → 修正反例（user_correction）；
    - L0 策略直过（auto）与孵化自身产物（origin=incubation）不参与
      学习（例行变更无行为证据价值；自身产物防自我强化循环）。
    """
    meta = record.get("meta")
    if isinstance(meta, dict) and meta.get("origin") == "incubation":
        return None
    decision = record.get("decision")
    status = record.get("status")
    kind = str(record.get("kind") or "")
    rationale = str(record.get("rationale") or "")
    reason = str(record.get("reason") or "")
    if kind == "revert":
        return {
            "type": "user_correction",
            "message": f"回退补丁 #{record.get('patch_id')}：{reason or '未说明原因'}",
            "source": SOURCE_USER,
            "context": {"target": target_key_of("revert", record), "kind": "revert"},
        }
    if decision == DECISION_AUTO:
        return None
    target = target_key_of(kind, record.get("payload"))
    if status == AUDIT_STATUS_APPLIED:
        if decision == DECISION_ACCEPT:
            return {
                "type": "user_confirm",
                "message": f"{kind} 补丁（{target}）经确认落地：{rationale or reason}",
                "source": SOURCE_USER,
                "context": {"target": target, "kind": kind},
            }
        if decision == DECISION_EDIT:
            return {
                "type": "edit",
                "message": f"{kind} 补丁（{target}）编辑后落地：{rationale or reason}",
                "source": SOURCE_USER,
                "context": {"target": target, "kind": kind},
            }
        return None
    if status == AUDIT_STATUS_REJECTED and decision in (DECISION_REJECT, DECISION_TERMINATE):
        return {
            "type": "reject",
            "message": f"{kind} 补丁（{target}）被拒：{reason or rationale or '未说明原因'}",
            "source": SOURCE_USER,
            "context": {"target": target, "kind": kind},
        }
    if status == AUDIT_STATUS_REJECTED and decision == DECISION_EDIT:
        return {
            "type": "edit",
            "message": f"{kind} 补丁（{target}）编辑未通过：{reason or rationale}",
            "source": SOURCE_USER,
            "context": {"target": target, "kind": kind},
        }
    if status == AUDIT_STATUS_INVALID:
        return {
            "type": "validation_error",
            "message": f"{kind} 补丁（{target}）形态非法：{reason}",
            "source": "model",
            "context": {"target": target, "kind": kind},
        }
    if status == AUDIT_STATUS_CONFLICT:
        return {
            "type": "error",
            "message": f"{kind} 补丁（{target}）基准冲突：{reason}",
            "source": "model",
            "context": {"target": target, "kind": kind},
        }
    return None


def _is_user_decision(record: dict) -> bool:
    """用户干预判定：只计纠偏性决议（编辑/拒批/终止/回退）。

    accept（正向确认）不计入干预——干预 = 需要修正的行为证据；
    正向确认被确认落地信号（insight）单独承载，不撑开蒸馏的
    干预闸门（引擎默认干预阈值 1：一次纠偏即触发按需蒸馏）。
    """
    decision = record.get("decision")
    return (
        record.get("kind") == "revert"
        or decision in (DECISION_EDIT, DECISION_REJECT, DECISION_TERMINATE)
    )


def _entry_id_of(data: dict) -> str:
    """孵化条目 id：内容哈希（同内容幂等——重复沉淀更新同一条目）。

    前缀 incubate. 与种子基线（seed.）区分，回捞时互相不串。
    """
    digest = hashlib.sha256(
        json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f"{_INCUBATE_ID_PREFIX}{digest[:12]}"


# 游标容差（秒）：同毫秒后写入的新记录不被跳过（时间戳相等也算新）；
# 锚点记录身份显式排除，保证既不丢信号也无无限重扫
_CURSOR_EPSILON = 1e-6


def _record_identity(record: dict) -> tuple:
    """审计记录身份（增量消费的去重锚点）。

    身份 = 类型 + 补丁号 + 时间戳 + 决议/状态/理由文本：时间戳同值
    但后写入的新记录身份不同 → 容差窗口内仍被纳入；已处理的锚点
    身份相同 → 下一轮显式排除。
    """
    return (
        str(record.get("kind") or ""),
        record.get("patch_id"),
        float(record.get("created_at") or 0),
        str(record.get("decision") or ""),
        str(record.get("status") or ""),
        str(record.get("rationale") or ""),
        str(record.get("reason") or ""),
    )


def _normalize_identity(value: Any) -> tuple | None:
    """游标锚点归一（存储往返 tuple→list，统一比较形态；None 原样）。"""
    if value is None:
        return None
    return tuple(value) if isinstance(value, (list, tuple)) else None


class IncubatorService:
    """孵化服务：审计 → 信号 → 按需蒸馏 → 知识沉淀（L0 管线）。

    ``run_cycle`` 幂等可重入：游标（已消费审计时间戳）持久化，崩溃/
    取消后从游标续跑不重复沉淀；内容哈希保证同因信号收敛到同一条目
    （重复触发 = 修正同一知识而非新增）。全部失败路径只留痕不击穿
    调用方（孵化是增强能力，回合照常结束）。
    """

    def __init__(
        self,
        app_getter: Callable[[], Any],
        pipeline: Any,
        *,
        complexity_threshold: int = DEFAULT_COMPLEXITY_THRESHOLD,
        intervention_threshold: int = DEFAULT_INTERVENTION_THRESHOLD,
        repeat_threshold: int = REPEAT_THRESHOLD,
        ingestion_window_seconds: float = _INGESTION_WINDOW_SECONDS,
    ) -> None:
        self._app_getter = app_getter
        self._pipeline = pipeline
        self._classifier = SignalClassifier(repeat_threshold=repeat_threshold)
        self._distiller = DeterministicDistiller(
            complexity_threshold=complexity_threshold,
            intervention_threshold=intervention_threshold,
        )
        self._ingestion_window = ingestion_window_seconds
        # 并发入口互斥（回合尾与回退后可能同时触发；串行保证游标一致）
        self._lock = asyncio.Lock()

    async def run_cycle(self) -> dict:
        """消费一次演化信号并沉淀（增量：只处理游标之后的审计记录）。

        Returns:
            摘要 dict（processed/signals/action 等；测试与留痕用）。
        """
        app = self._app_getter()
        async with self._lock:
            try:
                cursor = await self._load_cursor(app)
                records = await app.storage.list_records(_AUDIT_COLLECTION)
                pending = [
                    r
                    for r in records
                    if float(r.get("created_at") or 0) > cursor["ts"] - _CURSOR_EPSILON
                    and _record_identity(r) not in cursor["anchors"]
                ]
                if not pending:
                    return {"processed": 0}
                pending.sort(key=lambda r: float(r.get("created_at") or 0))
                # 新鲜度窗口：超窗记录静默消费（游标推进但不产信号）——
                # 升级部署时旧历史不参与学习，避免全历史一次性蒸馏
                fresh = [
                    r
                    for r in pending
                    if float(r.get("created_at") or 0)
                    >= time.time() - self._ingestion_window
                ]
                signals = self._signals_of(fresh)
                summary: dict[str, Any] = {"processed": len(pending)}
                if signals:
                    aggregated = self._classifier.aggregate(signals)
                    complexity = len(fresh)
                    interventions = sum(1 for r in fresh if _is_user_decision(r))
                    summary["signals"] = len(aggregated)
                    summary["complexity"] = complexity
                    summary["interventions"] = interventions
                    if self._distiller.should_distill(
                        complexity=complexity, interventions=interventions
                    ):
                        summary.update(await self._distill_and_apply(app, aggregated))
                    else:
                        summary["action"] = "skipped"
                        await self._log(
                            app, "skipped", {"complexity": complexity, "interventions": interventions}
                        )
                await self._save_cursor(app, pending)
                return summary
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("孵化循环失败（回合不受影响）: %s", exc)
                return {"processed": 0, "error": str(exc)}

    def _signals_of(self, records: list[dict]) -> list[ExecutionSignal]:
        """审计记录 → 信号清单（噪音记录过滤；非信号形态不沉淀）。"""
        events = [e for r in records if (e := _audit_event_of(r)) is not None]
        return [
            signal
            for event in events
            if (signal := self._classifier.classify(event)) is not None
        ]

    async def _distill_and_apply(self, app: Any, signals: list[ExecutionSignal]) -> dict:
        """复用优先于生成 → 蒸馏 → 知识补丁（经孵化管线 L0 落地）。"""
        query = _query_of(signals)
        title = signals[0].message[:_TITLE_MAX_CHARS]
        decision = reuse_or_distill(
            app.knowledge_set,
            query,
            signals,
            self._distiller,
            limit=5,
            title=title,
            tags=("incubated",),
        )
        if decision.reused:
            await self._log(app, "reuse", {"query": query, "note": decision.note})
            return {"action": "reuse", "note": decision.note}
        if decision.distilled is None:
            await self._log(app, "none", {"query": query, "note": decision.note})
            return {"action": "none", "note": decision.note}
        outcome = decision.distilled
        entry = KnowledgeEntry(
            id=_entry_id_of(outcome.data),
            level="work",
            kind=KIND_INSIGHT,
            data=outcome.data,
            source=outcome.source,
            credibility=default_credibility(outcome.source),
            title=(outcome.title or query)[:_TITLE_MAX_CHARS],
            tags=outcome.tags or ("incubated",),
        )
        existing = app.knowledge_set.get(entry.id)
        if existing is not None and existing.data == entry.data:
            await self._log(app, "unchanged", {"entry": entry.id})
            return {"action": "unchanged", "entry": entry.id}
        # 走应用管线（孵化管线 knowledge L0 直过）：基准冲突重试一次
        # （并发提案间隙，重试取最新版本；再冲突即放弃本次沉淀）
        for _attempt in range(2):
            base_version = await app.self_pipeline.chain.current_version()
            proposal = SelfProposal(
                kind=PatchKind.KNOWLEDGE,
                payload={"entry": entry.to_dict()},
                base_version=base_version,
                rationale=f"孵化沉淀（{len(signals)} 条行为信号）: {query[:_QUERY_MAX_CHARS]}",
                meta={"origin": "incubation"},
            )
            result = await self._pipeline.apply(None, proposal)
            if result.status != "conflict":
                await self._log(
                    app,
                    "applied" if result.applied else "rejected",
                    {"entry": entry.id, "status": result.status, "reason": result.reason},
                )
                return {
                    "action": "applied" if result.applied else "rejected",
                    "entry": entry.id,
                    "patch_id": result.patch_id,
                    "reason": result.reason,
                }
        await self._log(app, "conflict", {"entry": entry.id})
        return {"action": "conflict", "entry": entry.id}

    async def _load_cursor(self, app: Any) -> dict:
        """游标读回（{ts, anchors}；无记录 = 空锚点从 0 起消费）。"""
        record = await app.storage.get_record(_EVOLUTION_COLLECTION, _CURSOR_KEY)
        if not isinstance(record, dict):
            return {"ts": 0.0, "anchors": frozenset()}
        anchors = {
            normalized
            for raw in (record.get("anchors") or [])
            if (normalized := _normalize_identity(raw)) is not None
        }
        return {"ts": float(record.get("ts") or 0), "anchors": frozenset(anchors)}

    async def _save_cursor(self, app: Any, pending: list[dict]) -> None:
        """游标落库：最大已消费时间戳 + 容差窗口内全部已处理身份。

        锚点 = 容差窗口内（与最大时间戳相差 < 1e-6 秒）所有已处理
        记录的完整身份集合：同时间戳后写的新记录身份不在集合内 →
        仍被纳入（不丢信号）；已处理的同时间戳记录身份在集合内 →
        被排除（无重复重扫/乒乓）。两者合起来无丢失且无无限重扫。
        """
        max_ts = max(float(r.get("created_at") or 0) for r in pending)
        anchors = [
            list(_record_identity(r))
            for r in pending
            if float(r.get("created_at") or 0) >= max_ts - _CURSOR_EPSILON
        ]
        await app.storage.put_record(
            _EVOLUTION_COLLECTION,
            _CURSOR_KEY,
            {"ts": max_ts, "anchors": anchors},
        )

    async def _log(self, app: Any, event: str, data: dict) -> None:
        """孵化留痕（有界环形：单键保存最近若干条，防集合无限膨胀）。"""
        record = await app.storage.get_record(_EVOLUTION_COLLECTION, _LOG_KEY)
        items = list(record.get("items") or []) if isinstance(record, dict) else []
        items.append(
            {
                "event": event,
                "created_at": time.time(),
                **{k: v for k, v in data.items() if isinstance(v, (str, int, float, bool, type(None)))},
            }
        )
        items = items[-_LOG_KEEP:]
        await app.storage.put_record(_EVOLUTION_COLLECTION, _LOG_KEY, {"items": items})

    async def recent_log(self, *, limit: int = _LOG_KEEP) -> list[dict]:
        """最近孵化留痕（倒序；观察端点数据源）。"""
        app = self._app_getter()
        record = await app.storage.get_record(_EVOLUTION_COLLECTION, _LOG_KEY)
        items = list(record.get("items") or []) if isinstance(record, dict) else []
        items.sort(key=lambda r: float(r.get("created_at") or 0), reverse=True)
        return items[:limit]


def _query_of(signals: list[ExecutionSignal]) -> str:
    """信号 → 复用检索查询串（主信号消息拼接，有界截断）。"""
    parts = [s.message for s in signals]
    query = " ".join(parts)[:_QUERY_MAX_CHARS]
    return query or "演化沉淀"


class EvolutionMetrics:
    """演化收敛指标聚合（审计记录 → 指标快照；纯函数可测试）。

    口径（回退率/采纳比从补丁链 + 审批记录聚合）：
    - proposals/applied/rejected/conflicts/invalid/reverts：各态计数；
    - adoption_ratio：采纳比 = 已应用 /（已应用 + 用户拒批）；
    - revert_rate：回退率 = 回退数 / 已应用数；
    - incubation：孵化沉淀条数（origin=incubation 的已应用记录）；
    - targets：按补丁目标聚合的重写/拒批/回退热度（Top 5）。
    """

    @staticmethod
    def compute(records: list[dict]) -> dict:
        incubation = [r for r in records if (r.get("meta") or {}).get("origin") == "incubation"]
        incubation_ids = {id(r) for r in incubation}
        user_records = [
            r for r in records if r.get("kind") != "revert" and id(r) not in incubation_ids
        ]
        applied = [r for r in user_records if r.get("status") == AUDIT_STATUS_APPLIED]
        rejected = [
            r
            for r in user_records
            if r.get("status") == AUDIT_STATUS_REJECTED
            and r.get("decision") in (DECISION_REJECT, DECISION_TERMINATE)
        ]
        conflicts = [r for r in user_records if r.get("status") == AUDIT_STATUS_CONFLICT]
        invalid = [r for r in user_records if r.get("status") == AUDIT_STATUS_INVALID]
        reverts = [r for r in records if r.get("kind") == "revert"]
        incubation_applied = [r for r in incubation if r.get("status") == AUDIT_STATUS_APPLIED]
        adoption = len(applied) + len(rejected)
        reverted_applied = len(applied)
        return {
            "proposals": len(user_records),
            "applied": len(applied),
            "rejected": len(rejected),
            "conflicts": len(conflicts),
            "invalid": len(invalid),
            "reverts": len(reverts),
            "adoption_ratio": round(len(applied) / adoption, 4) if adoption else 0.0,
            "revert_rate": (
                round(len(reverts) / reverted_applied, 4) if reverted_applied else 0.0
            ),
            "incubation": len(incubation_applied),
            "incubation_ratio": (
                round(len(incubation_applied) / max(len(applied), 1), 4) if applied else 0.0
            ),
            "targets": EvolutionMetrics._targets(applied, rejected, reverts),
        }

    @staticmethod
    def _targets(applied: list[dict], rejected: list[dict], reverts: list[dict]) -> list[dict]:
        stats: dict[str, dict[str, int]] = defaultdict(
            lambda: {"rewrites": 0, "rejections": 0, "reverts": 0}
        )
        for record in applied:
            stats[target_key_of(record.get("kind"), record.get("payload"))]["rewrites"] += 1
        for record in rejected:
            stats[target_key_of(record.get("kind"), record.get("payload"))]["rejections"] += 1
        for record in reverts:
            stats[target_key_of("revert", record)]["reverts"] += 1
        ranked = sorted(
            (
                {"target": target, **counts}
                for target, counts in stats.items()
            ),
            key=lambda item: (
                item["rewrites"] + item["rejections"] + item["reverts"],
                item["target"],
            ),
            reverse=True,
        )
        return ranked[:5]


@dataclass(frozen=True, slots=True)
class ConvergenceAssessment:
    """一次提案前的收敛管制判定（allowed=False = 被冷却/冻结拦截）。"""

    allowed: bool
    state: str  # normal / cooldown / frozen
    target: str
    reason: str = ""
    metrics: dict = field(default_factory=dict)


class ConvergencePolicy:
    """演化收敛管制：同目标反复重写/回退/拒批 → 冷却 → 冻结。

    判定依据 = 审计记录（近窗口聚合）+ 持久化冷却状态（重启不丢）；
    冷却 = 目标暂时禁提案（时长到自动恢复）；连续触发冷却升级为
    冻结（更长时间窗，强制 AI 换策略）。回退/拒批是用户行为证据：
    信任行为不信任承诺——AI 反复提案被拒即冷却，收敛指标由
    :class:`EvolutionMetrics` 提供观测视图。
    """

    def __init__(
        self,
        storage: Any,
        *,
        clock: Callable[[], float] | None = None,
        reject_threshold: int = _COOLDOWN_REJECT_THRESHOLD,
        revert_threshold: int = _COOLDOWN_REVERT_THRESHOLD,
        rewrite_threshold: int = _COOLDOWN_REWRITE_THRESHOLD,
        window_seconds: float = _WINDOW_SECONDS,
        cooldown_seconds: float = _COOLDOWN_SECONDS,
        freeze_after_cooldowns: int = _FREEZE_AFTER_COOLDOWNS,
        freeze_seconds: float = _FREEZE_SECONDS,
    ) -> None:
        self._storage = storage
        self._clock = clock or time.time
        self._reject_threshold = reject_threshold
        self._revert_threshold = revert_threshold
        self._rewrite_threshold = rewrite_threshold
        self._window_seconds = window_seconds
        self._cooldown_seconds = cooldown_seconds
        self._freeze_after_cooldowns = freeze_after_cooldowns
        self._freeze_seconds = freeze_seconds

    async def assess(
        self, records: list[dict], kind: Any, payload: dict
    ) -> ConvergenceAssessment:
        """评估一次提案：近窗口指标触发冷却/冻结则禁止，否则放行。

        状态写穿（评估即落状态记录）：冷却/冻结启动时持久化，时长到
        自动失效——判定是确定性的（时钟注入可测），无后台定时器。
        """
        target = target_key_of(kind, payload)
        now = self._clock()
        state = dict(await self._storage.get_record(_EVOLUTION_COLLECTION, f"{_COOLDOWN_KEY_PREFIX}{target}") or {})
        freeze_until = float(state.get("freeze_until") or 0)
        cooldown_until = float(state.get("cooldown_until") or 0)
        metrics = self._window_metrics(records, target, now)
        if freeze_until > now:
            return ConvergenceAssessment(
                allowed=False,
                state="frozen",
                target=target,
                reason=f"目标 {target} 已冻结（演化收敛管制）：连续触发冷却后强制换策略，"
                f"{_remaining_seconds(freeze_until, now)} 后自动恢复",
                metrics=metrics,
            )
        if cooldown_until > now:
            return ConvergenceAssessment(
                allowed=False,
                state="cooldown",
                target=target,
                reason=f"目标 {target} 处于冷却期（演化收敛管制）：近窗口重写 "
                f"{metrics['rewrites']} 次 / 拒批 {metrics['rejections']} 次 / 回退 "
                f"{metrics['reverts']} 次，{_remaining_seconds(cooldown_until, now)} 后自动恢复"
                "——请调整方向或换目标",
                metrics=metrics,
            )
        triggered = (
            metrics["rejections"] >= self._reject_threshold
            or metrics["reverts"] >= self._revert_threshold
            or metrics["rewrites"] >= self._rewrite_threshold
        )
        if not triggered:
            # 收敛恢复常态：冷却累积计数归零并清空到期状态——「连续
            # 触发升级冻结」须重新累积，防一次冻结后任何后续触发都
            # 直接再冻结（升级失去冷却缓冲）
            if state.get("cooldown_count") or state.get("cooldown_until") or state.get("freeze_until"):
                await self._storage.put_record(
                    _EVOLUTION_COLLECTION,
                    f"{_COOLDOWN_KEY_PREFIX}{target}",
                    {
                        "target": target,
                        "cooldown_until": 0,
                        "freeze_until": 0,
                        "cooldown_count": 0,
                    },
                )
            return ConvergenceAssessment(
                allowed=True, state="normal", target=target, metrics=metrics
            )
        # 首次触发冷却 / 连续触发升级冻结（状态写穿持久化）
        cooldown_count = int(state.get("cooldown_count") or 0) + 1
        if cooldown_count >= self._freeze_after_cooldowns:
            updated = {
                "target": target,
                "cooldown_until": now,
                "freeze_until": now + self._freeze_seconds,
                "cooldown_count": cooldown_count,
            }
            await self._storage.put_record(
                _EVOLUTION_COLLECTION, f"{_COOLDOWN_KEY_PREFIX}{target}", updated
            )
            return ConvergenceAssessment(
                allowed=False,
                state="frozen",
                target=target,
                reason=f"目标 {target} 冻结（连续 {cooldown_count} 次触发冷却）："
                f"{_remaining_seconds(updated['freeze_until'], now)} 后自动恢复",
                metrics=metrics,
            )
        updated = {
            "target": target,
            "cooldown_until": now + self._cooldown_seconds,
            "freeze_until": 0,
            "cooldown_count": cooldown_count,
        }
        await self._storage.put_record(
            _EVOLUTION_COLLECTION, f"{_COOLDOWN_KEY_PREFIX}{target}", updated
        )
        return ConvergenceAssessment(
            allowed=False,
            state="cooldown",
            target=target,
            reason=f"目标 {target} 进入冷却期（近窗口重写 {metrics['rewrites']} 次 / 拒批 "
            f"{metrics['rejections']} 次 / 回退 {metrics['reverts']} 次）："
            f"{_remaining_seconds(updated['cooldown_until'], now)} 后自动恢复"
            "——请调整方向或换目标",
            metrics=metrics,
        )

    def _window_metrics(self, records: list[dict], target: str, now: float) -> dict:
        """近窗口聚合：命中目标的重写/拒批/回退计数（孵化产物不计）。"""
        window_start = now - self._window_seconds
        metrics = {"rewrites": 0, "rejections": 0, "reverts": 0}
        for record in records:
            if float(record.get("created_at") or 0) < window_start:
                continue
            if record.get("kind") == "revert":
                if target_key_of("revert", record) == target:
                    metrics["reverts"] += 1
                continue
            if (record.get("meta") or {}).get("origin") == "incubation":
                continue
            if target_key_of(record.get("kind"), record.get("payload")) != target:
                continue
            if record.get("status") == AUDIT_STATUS_APPLIED:
                metrics["rewrites"] += 1
            elif record.get("status") == AUDIT_STATUS_REJECTED and record.get("decision") in (
                DECISION_REJECT,
                DECISION_TERMINATE,
            ):
                metrics["rejections"] += 1
        return metrics

    async def list_states(self) -> list[dict]:
        """当前冷却/冻结状态快照（观察端点数据源；过期状态不展示）。"""
        now = self._clock()
        states: list[dict] = []
        for record in await self._storage.list_records(_EVOLUTION_COLLECTION):
            if not isinstance(record, dict) or not record.get("target"):
                continue
            freeze_until = float(record.get("freeze_until") or 0)
            cooldown_until = float(record.get("cooldown_until") or 0)
            if freeze_until > now:
                states.append(
                    {
                        "target": record.get("target"),
                        "state": "frozen",
                        "until": freeze_until,
                        "cooldown_count": record.get("cooldown_count"),
                    }
                )
            elif cooldown_until > now:
                states.append(
                    {
                        "target": record.get("target"),
                        "state": "cooldown",
                        "until": cooldown_until,
                        "cooldown_count": record.get("cooldown_count"),
                    }
                )
        states.sort(key=lambda s: str(s["target"]))
        return states


def _remaining_seconds(until: float, now: float) -> str:
    """剩余时长的人读文本（冷却/冻结倒计时展示）。"""
    seconds = max(int(until - now), 0)
    if seconds >= 3600:
        return f"{seconds // 3600} 小时 {(seconds % 3600) // 60} 分钟"
    if seconds >= 60:
        return f"{seconds // 60} 分钟"
    return f"{seconds} 秒"


__all__ = [
    "ConvergenceAssessment",
    "ConvergencePolicy",
    "EvolutionMetrics",
    "IncubatorService",
    "target_key_of",
]

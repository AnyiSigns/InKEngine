"""孵化闭环单测：行为信号 → 蒸馏 → 知识沉淀 + 演化收敛管制。

覆盖：
- 被拒提案（用户行为证据）→ 回合尾孵化沉淀为知识条目（L0 直过）；
- 蒸馏阈值未达 = 不沉淀；同因信号重复 = 复用命中/内容不变（幂等）；
- 收敛管制：同目标反复拒批 → 冷却 → 连续触发升级冻结 → 到期恢复；
- 指标聚合口径（采纳比/回退率/热度目标）与孵化留痕；
- apply_patch 前置闸门：冷却期提案被显式拦截（AI 换策略而非撞闸）。
"""
from __future__ import annotations

import json
import time

from ink_engine.core.knowledge_set import KIND_RULE, KnowledgeEntry
from ink_engine.core.self_proposal import PatchKind, SelfProposal

from app import boot
from app.evolution import ConvergencePolicy, EvolutionMetrics, IncubatorService
from app.self_tools import make_self_executor, self_tool_specs

# 合法声明式工具定义（L1 挂卡测试的提案素材）
TOOL_PAYLOAD = {
    "name": "list_workspace",
    "description": "列出工作区文件",
    "permissions": ["filesystem:read:/workspace"],
    "endpoint": "file_ops",
    "endpoint_config": {"root": "/workspace"},
}

TOOL_RATIONALE = "注册工作区查看工具"


class RejectCtx:
    """审批注入拒绝的假上下文（L1 挂卡 → reject 决议）。"""

    round_id = "r-test"

    async def interrupt(self, key, card):
        return {"decision": "reject"}

    async def get_interrupt_payload(self, key):
        return None


async def _rejected_tool_proposal(app) -> SelfProposal:
    """基于当前链版本的被拒提案（链版本随沉淀前进，基准须取最新）。"""
    return SelfProposal(
        kind=PatchKind.TOOL,
        payload=dict(TOOL_PAYLOAD),
        base_version=await app.self_pipeline.chain.current_version(),
        rationale=TOOL_RATIONALE,
    )


def _incubated_entries(app) -> list[KnowledgeEntry]:
    return [e for e in app.knowledge_set.entries() if e.id.startswith("incubate.")]


async def test_rejected_proposal_incubates_knowledge_entry() -> None:
    # ① 一次被用户拒绝的工具提案（L1 挂卡 → reject 决议 → 审计留痕）
    app = await boot.init_app()
    outcome = await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    assert outcome.status == "rejected"

    # ② 回合尾孵化：消费该行为信号 → 蒸馏 → 知识条目落库（L0 直过）
    summary = await app.incubator.run_cycle()
    assert summary["processed"] == 1
    assert summary["action"] == "applied"
    entries = _incubated_entries(app)
    assert len(entries) == 1
    # 修正反例来源 = 用户（可信度取用户级），内容为规则声明形态
    assert entries[0].kind == KIND_RULE
    assert entries[0].source == "user"
    assert isinstance(entries[0].data.get("rule"), dict)

    # ③ 审计有孵化记录：origin=incubation 且 L0 直过（decision=auto）
    log = await app.self_pipeline.audit_log()
    incubations = [
        r for r in log if (r.get("meta") or {}).get("origin") == "incubation"
    ]
    assert len(incubations) == 1
    assert incubations[0]["decision"] == "auto"
    assert incubations[0]["status"] == "applied"

    # ④ 再次 run_cycle：孵化自身审计记录为 pending 但被分类器跳过
    #    （origin=incubation 防自我强化），无信号可学 → 不产生新沉淀
    summary2 = await app.incubator.run_cycle()
    assert summary2.get("signals", 0) == 0
    assert len(_incubated_entries(app)) == 1


async def test_incubation_skips_when_thresholds_not_met() -> None:
    # 蒸馏按需触发：干预阈值未达（一次简单拒绝 < 阈值）不沉淀
    app = await boot.init_app()
    incubator = IncubatorService(
        lambda: app, app.incubation_pipeline, intervention_threshold=5
    )
    await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    summary = await incubator.run_cycle()
    assert summary["action"] == "skipped"
    assert _incubated_entries(app) == []


async def test_incubation_is_idempotent_for_same_signal() -> None:
    # 同因信号跨轮重复：首条沉淀，次条复用命中既有条目（不产生重复补丁）
    app = await boot.init_app()
    await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    first = await app.incubator.run_cycle()
    assert first["action"] == "applied"

    await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    second = await app.incubator.run_cycle()
    assert second["action"] in ("reuse", "unchanged")
    entries = _incubated_entries(app)
    assert len(entries) == 1
    # 孵化记录（origin=incubation）只有一条——没有重复沉淀补丁
    log = await app.self_pipeline.audit_log()
    incubations = [
        r for r in log if (r.get("meta") or {}).get("origin") == "incubation"
    ]
    assert len(incubations) == 1


async def test_convergence_cooldown_then_freeze_then_recovery() -> None:
    # 时钟可控：冷却 → 到期自动恢复；连续触发升级冻结 → 到期恢复
    app = await boot.init_app()
    holder = {"now": 1_000_000.0}
    policy = ConvergencePolicy(
        app.storage,
        clock=lambda: holder["now"],
        cooldown_seconds=100,
        freeze_after_cooldowns=2,
        freeze_seconds=200,
    )
    payload = dict(TOOL_PAYLOAD)

    def window_records(count: int) -> list[dict]:
        return [
            {
                "kind": "tool",
                "status": "rejected",
                "decision": "reject",
                "payload": payload,
                "created_at": holder["now"] - 50,
                "meta": {},
            }
            for _ in range(count)
        ]

    # ① 三次拒批（≥ 阈值 3）→ 进入冷却，提案被拦截
    records = window_records(3)
    assessment = await policy.assess(records, "tool", payload)
    assert assessment.state == "cooldown"
    assert assessment.allowed is False
    # 冷却期内再评估 → 仍拦截（不重复计数）
    again = await policy.assess(records, "tool", payload)
    assert again.state == "cooldown"
    assert again.allowed is False

    # ② 冷却到期后同窗口记录仍在 → 再次触发 → 升级冻结
    holder["now"] += 101
    escalated = await policy.assess(records, "tool", payload)
    assert escalated.state == "frozen"
    assert escalated.allowed is False
    frozen_again = await policy.assess(records, "tool", payload)
    assert frozen_again.state == "frozen"

    # ③ 冻结到期且窗口滑出（推进超过窗口时长，记录过期）→ 恢复放行
    holder["now"] += 90_000
    recovered = await policy.assess(records, "tool", payload)
    assert recovered.state == "normal"
    assert recovered.allowed is True

    # ④ 冷却/冻结状态可观测（快照含目标与状态）；恢复后重新触发
    #    从冷却重新累积（③ 已把 cooldown_count 归零——无此修复此处
    #    会因历史计数直接冻结，升级永久失去冷却缓冲）
    holder["now"] = 1_000_000.0
    await policy.assess(records, "tool", payload)
    states = await policy.list_states()
    assert any(s["target"] == "tool:list_workspace" for s in states)

    # ⑤ 冷却重新累积后再次触发 → 仍能升级冻结（升级须重新连续触发）
    holder["now"] += 101
    re_escalated = await policy.assess(records, "tool", payload)
    assert re_escalated.state == "frozen"
    assert re_escalated.allowed is False


async def test_convergence_revert_records_trigger_cooldown() -> None:
    # 回退 ≥ 阈值 → 冷却（回退是用户行为证据：形态被纠偏）
    app = await boot.init_app()
    holder = {"now": 2_000_000.0}
    policy = ConvergencePolicy(app.storage, clock=lambda: holder["now"])
    payload = dict(TOOL_PAYLOAD)
    records = [
        {
            "kind": "revert",
            "patch_id": 3 + i,
            "last_patch": {"op": "replace", "path": ["tools", "list_workspace"]},
            "created_at": holder["now"] - 10,
        }
        for i in range(2)
    ]
    assessment = await policy.assess(records, "tool", payload)
    assert assessment.state == "cooldown"
    assert assessment.allowed is False


def test_metrics_compute() -> None:
    # 指标口径：采纳比 = 已应用/（已应用+拒批）；回退率 = 回退/已应用；
    # 孵化产物单独计数；目标热度按聚合排序
    now = time.time()
    records = [
        {"kind": "theme", "status": "applied", "decision": "auto", "payload": {"tokens": {}}, "created_at": now, "meta": {}},
        {"kind": "tool", "status": "applied", "decision": "accept", "payload": TOOL_PAYLOAD, "created_at": now, "meta": {}},
        {"kind": "tool", "status": "rejected", "decision": "reject", "payload": TOOL_PAYLOAD, "created_at": now, "meta": {}},
        {"kind": "knowledge", "status": "applied", "decision": "auto", "payload": {"entry": {"id": "x", "level": "work", "kind": "rule"}}, "created_at": now, "meta": {"origin": "incubation"}},
        {"kind": "revert", "patch_id": 2, "last_patch": {"path": ["tools", "list_workspace"]}, "created_at": now},
    ]
    metrics = EvolutionMetrics.compute(records)
    assert metrics["proposals"] == 3  # 回退与孵化不计入提案
    assert metrics["applied"] == 2
    assert metrics["rejected"] == 1
    assert metrics["reverts"] == 1
    assert metrics["adoption_ratio"] == round(2 / 3, 4)
    assert metrics["revert_rate"] == round(1 / 2, 4)
    assert metrics["incubation"] == 1
    hottest = metrics["targets"][0]
    assert hottest["target"] == "tool:list_workspace"
    assert hottest["rewrites"] == 1 and hottest["rejections"] == 1 and hottest["reverts"] == 1


async def test_apply_patch_blocked_by_cooldown() -> None:
    # 冷却期 apply_patch 被前置闸门拦截：结构化拒绝（AI 换策略而非撞闸）
    app = await boot.init_app()
    for _ in range(3):
        await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    executor = make_self_executor(app.self_pipeline, lambda: app)
    apply_spec = next(s for s in self_tool_specs() if s.name == "apply_patch")
    ctx = type("Ctx", (), {"round_id": "r-cc"})()
    out = json.loads(
        await executor(
            ctx,
            apply_spec,
            {
                "kind": "tool",
                "payload": dict(TOOL_PAYLOAD),
                "base_version": await app.self_pipeline.chain.current_version(),
                "rationale": "继续折腾同一目标",
            },
            None,
        )
    )
    assert out["ok"] is False
    assert out["status"] == "cooldown"
    assert "冷却" in out["reason"]


async def test_incubation_log_visible() -> None:
    # 孵化留痕可观测（观察端点数据源）：沉淀/复用/跳过均有记录
    app = await boot.init_app()
    await app.self_pipeline.apply(RejectCtx(), await _rejected_tool_proposal(app))
    await app.incubator.run_cycle()
    log = await app.incubator.recent_log()
    assert any(item["event"] == "applied" for item in log)


async def test_incubation_ignores_stale_history() -> None:
    # 升级部署安全：新鲜度窗口外的旧历史被静默消费（不蒸馏不污染）。
    # 首轮游标从 0 起——若无窗口，升级后全部历史会被一次性蒸馏
    app = await boot.init_app()
    incubator = IncubatorService(
        lambda: app, app.incubation_pipeline, ingestion_window_seconds=60
    )
    # 直接落一条「历史」审计记录（30 天前的时间戳；形态与真实一致）
    stale_ts = time.time() - 30 * 86400
    with app.storage.allow_mechanism("set_audit"):
        await app.storage.put_record(
            "set_audit",
            f"{stale_ts:.3f}-stale",
            {
                "kind": "tool",
                "status": "rejected",
                "decision": "reject",
                "payload": dict(TOOL_PAYLOAD),
                "rationale": "远古拒绝",
                "reason": "审批未通过",
                "created_at": stale_ts,
                "meta": {},
            },
        )
    summary = await incubator.run_cycle()
    # 旧记录被静默消费（游标推进）但不产信号、不沉淀
    assert summary["processed"] == 1
    assert summary.get("signals", 0) == 0
    assert _incubated_entries(app) == []
    # 游标已越过旧记录：再跑一轮无事可做（不反复重扫）
    assert (await incubator.run_cycle())["processed"] == 0


async def test_incubation_cursor_never_loses_same_tick_records() -> None:
    # 游标健壮性：与锚点同时间戳的后写记录不丢失（容差窗口纳入）。
    # 同毫秒真实写入罕见，此测试直接构造等价形态验证不丢信号
    app = await boot.init_app()
    incubator = IncubatorService(lambda: app, app.incubation_pipeline)
    now = time.time()
    with app.storage.allow_mechanism("set_audit"):
        # 两条时间戳完全相同的审计记录（同毫秒后写的第二种形态）
        for idx in range(2):
            await app.storage.put_record(
                "set_audit",
                f"{now:.3f}-{idx}",
                {
                    "kind": "tool",
                    "status": "rejected",
                    "decision": "reject",
                    "payload": dict(TOOL_PAYLOAD),
                    "rationale": f"同毫秒拒绝 {idx}",
                    "reason": "审批未通过",
                    "created_at": now,
                    "meta": {},
                },
            )
    summary = await incubator.run_cycle()
    # 两条都被消费并产信号（同毫秒不丢）
    assert summary["processed"] == 2
    assert summary["signals"] == 2

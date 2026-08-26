"""技能市场服务：目录 + vetting + 补丁链导入（复用 MCP 市场同构形态）。

技能市场与 MCP 市场同构（获取层复用既有同构形态）：
- 目录：``skills_market.json``（技能市场清单 seed 数据，条目即技能导出格式）；
- vetting 静态核对：清单一致性 / 必填字段 / 来源声明（与 mcp_market 同形）；
- 导入：审批卡预览 → L2 审批 → 补丁链落链（KNOWLEDGE 提案，可回退）；
  落链同时写入本地技能存储（skill.list/export 可即时消费）。

出厂零预装：目录仅候选清单，任何安装都须走既有 vetting → 审批 → 补丁链链路。
"""
from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ink_engine.core.review_card import build_gate_card
from ink_engine.core.skill_crystal import (
    SKILL_KIND_PATH,
    SKILL_KIND_VISUAL,
    SkillEntry,
    SkillStore,
    build_test_report,
)


@dataclass(frozen=True, slots=True)
class SkillInstallOutcome:
    """一次技能安装尝试的结构化结果（失败也结构化，绝不裸抛）。"""

    ok: bool
    skill_name: str = ""
    patch_id: int = 0
    status: str = ""
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "skill_name": self.skill_name,
            "patch_id": self.patch_id,
            "status": self.status,
            "error": self.error,
        }


_KNOWN_KINDS = (SKILL_KIND_PATH, SKILL_KIND_VISUAL)


class SkillMarketService:
    """技能市场编排服务（宿主装配期创建，运行期安装/可回退入口）。"""

    def __init__(
        self,
        runtime: Any,
        *,
        market: dict[str, Any],
        skill_store: SkillStore,
        external_mark_vetted: Callable[[str], None] | None = None,
    ) -> None:
        self._runtime = runtime
        self._market = market or {"skills": []}
        self._skill_store = skill_store
        self._external_mark_vetted = external_mark_vetted
        self._vetted_set: set[str] = set()

    @property
    def premounted(self) -> bool:
        return bool(self._market.get("premounted", False))

    @property
    def mount_policy(self) -> dict[str, Any]:
        return dict(self._market.get("mount_policy") or {})

    def list_entries(self) -> list[dict[str, Any]]:
        """市场目录（用户浏览用；仅 candidate，不预装）。"""
        return [dict(s) for s in (self._market.get("skills") or ())]

    def _market_entry(self, skill_id: str) -> dict[str, Any] | None:
        for skill in self._market.get("skills") or ():
            if skill.get("id") == skill_id:
                return skill
        return None

    def vetting_checks(self, entry: dict[str, Any]) -> list[str]:
        """安装前静态核对（与 MCP 市场 mount_policy.required 同形）。

        核对项：id/name 必备、kind 合法、path 为对象、契约/证据快照为列表、
        市场目录声明一致（防改头换面安装）。返回违规清单（空 = 通过）。
        """
        violations: list[str] = []
        if not entry.get("id"):
            violations.append("技能市场条目缺 id")
        if not entry.get("name"):
            violations.append("技能市场条目缺 name")
        kind = entry.get("kind", SKILL_KIND_PATH)
        if kind not in _KNOWN_KINDS:
            violations.append(f"技能 kind 非法: {kind!r}（须为 {_KNOWN_KINDS}）")
        if not isinstance(entry.get("path"), dict):
            violations.append("技能 path 须为对象（路径图定义）")
        if not isinstance(entry.get("contract_snapshot"), (list, tuple)):
            violations.append("contract_snapshot 须为列表")
        if not isinstance(entry.get("evidence_snapshot"), (list, tuple)):
            violations.append("evidence_snapshot 须为列表")
        declared = self._market_entry(str(entry.get("id", "")))
        if declared is not None:
            for key in ("name", "kind", "domain"):
                if entry.get(key) != declared.get(key):
                    violations.append(f"清单一致性：{key} 与市场目录声明不符")
        return violations

    def _entry_to_skill(self, entry: dict[str, Any], now: float) -> SkillEntry:
        hit = int(entry.get("hit_count", 0))
        fail = int(entry.get("fail_count", 0))
        rate = (hit / (hit + fail)) if (hit + fail) > 0 else 0.0
        report = entry.get("test_report")
        if not isinstance(report, dict):
            report = build_test_report(
                name=str(entry["name"]),
                version=int(entry.get("version", 1)),
                domain=str(entry.get("domain", "default")),
                model_id=str(entry.get("model_id", "")),
                hit_count=hit,
                fail_count=fail,
                success_rate=rate,
                evidence_snapshot=tuple(entry.get("evidence_snapshot") or ()),
                kind=str(entry.get("kind", SKILL_KIND_PATH)),
                now=now,
            )
        fingerprint = str(entry.get("fingerprint") or entry.get("source_path") or "")
        return SkillEntry(
            name=str(entry["name"]),
            version=int(entry.get("version", 1)),
            domain=str(entry.get("domain", "default")),
            fingerprint=fingerprint,
            kind=str(entry.get("kind", SKILL_KIND_PATH)),
            path=dict(entry.get("path") or {}),
            contract_snapshot=tuple(tuple(p) for p in entry.get("contract_snapshot") or ()),
            evidence_snapshot=tuple(dict(e) for e in entry.get("evidence_snapshot") or ()),
            model_id=str(entry.get("model_id", "")),
            hit_count=hit,
            fail_count=fail,
            test_report=report,
            source_path=str(entry.get("source_path") or fingerprint),
            created_at=now,
            updated_at=now,
        )

    async def propose_install(
        self,
        ctx: Any,
        skill_id: str,
        *,
        round_id: str | None = None,
    ) -> SkillInstallOutcome:
        """对话式安装链路：目录取条目 → vetting → 审批卡 → 补丁链落链。

        vetting 失败 / 审批拒绝 = 结构化返回，不落链；审批通过 = 技能写入
        本地技能存储 + KNOWLEDGE 提案落补丁链（audit/revert 可追踪）。
        """
        entry = self._market_entry(skill_id)
        if entry is None:
            return SkillInstallOutcome(
                ok=False, status="not_found", error=f"市场无此技能: {skill_id}"
            )
        violations = self.vetting_checks(entry)
        if violations:
            return SkillInstallOutcome(
                ok=False, status="vetting_rejected", error="；".join(violations)
            )
        decision = await self._install_approval(ctx, entry)
        if decision in ("reject", "terminate"):
            return SkillInstallOutcome(
                ok=False, status="rejected", error="技能安装审批未通过"
            )
        if decision == "vetting_rejected":
            return SkillInstallOutcome(
                ok=False, status="vetting_rejected",
                error="编辑后的条目未通过校验链",
            )
        from ink_engine.core.self_proposal import PatchKind, SelfProposal

        now = time.time()
        skill = self._entry_to_skill(entry, now)
        await self._skill_store.upsert(skill)
        self._vetted_set.add(skill_id)
        if self._external_mark_vetted is not None:
            self._external_mark_vetted(skill_id, skill)
        base_version = await self._runtime.self_pipeline.chain.current_version()
        proposal = SelfProposal(
            kind=PatchKind.KNOWLEDGE,
            payload={
                "entry": {
                    "id": f"skill.market.{skill.name}",
                    "level": "project",
                    "kind": "skill",
                    "data": {
                        "skill": skill.name,
                        "version": skill.version,
                        "domain": skill.domain,
                        "kind": skill.kind,
                        "source": "skill_market",
                        "market_id": skill_id,
                    },
                    "source": "skill_market",
                    "title": f"技能市场安装：{skill.name}",
                }
            },
            base_version=base_version,
            rationale=f"技能市场安装：{skill_id}",
            meta={"skill_market": skill_id, "skill_name": skill.name},
        )
        outcome = await self._runtime.self_pipeline.apply(
            ctx, proposal, round_id=round_id
        )
        if not outcome.applied:
            return SkillInstallOutcome(
                ok=False, status=outcome.status, error=outcome.reason or "审批未通过"
            )
        return SkillInstallOutcome(
            ok=True,
            skill_name=skill.name,
            patch_id=outcome.patch_id,
            status="installed",
        )

    async def _install_approval(self, ctx: Any, entry: dict[str, Any]) -> str:
        """安装审批卡预览（提案阶段）：可 edit 改条目，重走校验链。

        卡形态经 review_card.build_gate_card 统一构建（E-P12 唯一卡形态
        源），预览字段（skill_id/name/kind/domain）随 payload 透传。
        返回 accept / reject / terminate / vetting_rejected（与 MCP 同语义）。
        """
        card = build_gate_card(
            payload={
                "node_id": "skill_install",
                "node_label": "技能市场安装预览",
                "skill_id": entry.get("id"),
                "name": entry.get("name"),
                "kind": entry.get("kind"),
                "domain": entry.get("domain"),
                "reason": "技能市场安装预览：可 edit 修改条目后重走校验链",
            }
        )
        injected = await ctx.interrupt(f"skill_install:{entry.get('id')}", card)
        if isinstance(injected, str):
            return injected
        if isinstance(injected, dict) and injected.get("decision") == "edit":
            edited = injected.get("edited_content")
            if not isinstance(edited, dict):
                return "vetting_rejected"
            if self.vetting_checks(edited):
                return "vetting_rejected"
            return "accept"
        return "reject"


__all__ = ["SkillInstallOutcome", "SkillMarketService"]

"""自指全钩子 e2e：9 类补丁全枚举 × 落链 → 即时生效 → 审计 → 回退撤销。

引擎机制（core.self_application / self_proposal / self_tools）的种子侧
全钩子用例：引擎 PatchKind 全枚举（ui/theme/tool/rule/knowledge/
harness/event_type/environment/artifact）各一条，覆盖：
- 落链：分级审批（L0 直过 / L1 弹卡 / L2 沙箱验证）→ 补丁链 append；
- apply_targets 即时生效：落链即运行期活跃态同步（工具表/事件注册表/
  知识集/界面快照/harness 登记/环境/产物工具，宿主装配的活跃态目标）；
- 审计留痕：set_audit append-only（applied → reverted 双留痕）；
- 回退撤销：链尾单步折叠 → 活跃态随链态整体还原（on_reverted 通知
  钩子经 host 装配驱动界面/主题/工具表/知识集/事件类型/环境/产物恢复）；
- GuardedStorage 旁路写防护：演化资产集合直写拒绝（令牌/豁免上下文
  放行，退出即收回）；
- convergence_provider 收敛管制：同目标反复提案 → 冷却拒绝（数据驱动
  review.json max_rounds）；
- 同一链语义：挂载/环境/产物补丁与其余类型同链互操作、版本连续。
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import ScriptedApprovalCtx, load_seed
from ink_engine.core.self_application import (
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_REVERTED,
    SelfApplicationPipeline,
)
from ink_engine.core.self_proposal import PatchKind, SelfProposal
from ink_engine.core.storage import create_storage


async def _apply_patch(runtime: Any, ctx: Any, kind: PatchKind, payload: dict) -> Any:
    """经自指应用管线落链（审批分级/校验/审计全生效）。"""
    base_version = await runtime.self_pipeline.chain.current_version()
    return await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=kind,
            payload=payload,
            base_version=base_version,
            rationale=f"e2e 全钩子：{kind.value}",
        ),
    )


async def _last_audit(runtime: Any, status: str) -> dict:
    """审计尾记录（append-only：最新一条即最近动作）。"""
    audit = await runtime.self_pipeline.audit_log()
    assert audit[-1]["status"] == status
    return audit[-1]


def _ui_spec() -> dict[str, Any]:
    """UI 补丁负载（三层白名单内：message_list 组件 + state 通道）。"""
    return {
        "spec": {
            "name": "e2e.panel",
            "version": 1,
            "root": {
                "kind": "container",
                "type": "root",
                "props": {},
                "children": [
                    {
                        "kind": "component",
                        "type": "message_list",
                        "props": {},
                        "bind": {"channel": "state", "path": "messages"},
                    }
                ],
            },
        }
    }


def _theme_tokens() -> dict[str, Any]:
    """THEME 补丁负载（白名单 token 增量；L0 直过无卡）。"""
    return {"tokens": {"bg.base": "#000000"}}


def _tool_spec() -> dict[str, Any]:
    """TOOL 补丁负载（非 MCP 端点声明式工具；L2 验证钩子放行）。"""
    return {
        "name": "e2e.hook_tool",
        "description": "自指全钩子 e2e 工具",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["e2e.hook_tool"],
                }
            },
            "required": ["command"],
        },
        "permissions": ["process:exec:e2e.hook_tool"],
        "endpoint": "process_exec",
        "endpoint_config": {"allowlist": ["e2e.hook_tool"]},
        "meta": {"e2e": "self_hooks"},
    }


def _rule_payload() -> dict[str, Any]:
    """RULE 补丁负载（内置谓词声明；L1 弹卡）。"""
    return {
        "rule": {
            "id": "rule.e2e.hook_rule",
            "predicate": "present",
            "config": {"path": "title", "message": "材料须含标题字段"},
            "type": "constraint",
            "target_path": "material",
            "severity": "error",
            "kind": "e2e_shape",
        }
    }


def _entry_payload() -> dict[str, Any]:
    """KNOWLEDGE 补丁负载（insight 教训条目；L1 弹卡）。"""
    return {
        "entry": {
            "id": "k.e2e.hook_knowledge",
            "level": "work",
            "kind": "insight",
            "data": {
                "insight": {
                    "message": "自指全钩子知识条目",
                    "context": {"e2e": "self_hooks"},
                }
            },
            "source": "model",
            "credibility": 0.7,
            "title": "全钩子知识条目",
            "tags": ["e2e"],
        }
    }


def _harness_payload() -> dict[str, Any]:
    """HARNESS 补丁负载（纯工具/纯模板 harness；L1 弹卡）。"""
    return {
        "definition": {
            "name": "inkling.e2e.hook",
            "description": "自指全钩子 e2e 领域定义",
            "keywords": ("e2e", "hook"),
            "tools": [],
            "graph": None,
            "schema": None,
            "default_plan": None,
            "meta": {"e2e": "self_hooks"},
        }
    }


def _event_type_payload() -> dict[str, Any]:
    """EVENT_TYPE 补丁负载（带渲染组件的事件类型；L1 弹卡）。"""
    return {
        "name": "e2e.hook_event",
        "schema": {
            "name": "e2e.hook_event",
            "fields": [{"name": "note", "required": False, "kind": "string"}],
        },
        "renderer": "message_list",
        "system": False,
        "meta": {"e2e": "self_hooks"},
    }


def _env_payload() -> dict[str, Any]:
    """ENVIRONMENT 补丁负载（local 形态声明；L1 弹卡，ensure 幂等）。"""
    return {
        "name": "e2e.hook_env",
        "runtime": "local",
        "tools": [],
        "install_cmds": [],
        "version": "0.1.0",
        "meta": {"e2e": "self_hooks"},
    }


# ── 9 类补丁全钩子（落链 → 即时生效 → 审计 → 回退撤销）──


async def test_hook_theme_roundtrip(booted):
    """THEME 钩子全链：L0 直过 → 界面主题即时切换 → 回退还原（on_reverted 恢复）。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.THEME, _theme_tokens())
    assert outcome.applied and outcome.decision == "auto"  # L0 策略直过
    ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
    assert ui["theme"]["bg.base"] == "#000000"  # apply_targets 即时生效
    assert "patch:theme" not in ctx.card_keys  # 直过无卡

    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    restored = runtime.introspection_service.snapshot_ui()["ui_spec"]
    assert restored["theme"]["bg.base"] == "#09090b"  # 回退撤销（链态还原）
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_ui_roundtrip(booted):
    """UI 钩子全链：L0 直过 → 界面快照即时切换 → 回退还原基线布局。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.UI, _ui_spec())
    assert outcome.applied
    ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
    assert ui["name"] == "e2e.panel"  # apply_targets 即时生效
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
    assert ui["name"] == load_seed("ui_spec.json")["name"]  # 基线布局还原
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_tool_roundtrip(booted):
    """TOOL 钩子全链：L2 验证放行 → 工具表即时注册 → 回退退出工具表。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.TOOL, _tool_spec())
    assert outcome.applied
    assert outcome.decision == "accept"  # L2：vetting 通过后弹卡
    assert "e2e.hook_tool" in runtime.tool_registry  # apply_targets 即时生效
    assert "patch:tool" in ctx.card_keys  # 审批卡留痕
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert "e2e.hook_tool" not in runtime.tool_registry  # 回退撤销（工具表重建）
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_rule_roundtrip(booted):
    """RULE 钩子全链：L1 弹卡 → 规则进知识集（inspect_rules 可见）→ 回退移除。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.RULE, _rule_payload())
    assert outcome.applied and "patch:rule" in ctx.card_keys
    rules = runtime.introspection_service.snapshot_rules()["rules"]
    assert any(r["id"] == "rule.e2e.hook_rule" for r in rules)  # 即时生效
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    rules = runtime.introspection_service.snapshot_rules()["rules"]
    assert all(r["id"] != "rule.e2e.hook_rule" for r in rules)  # 回退撤销
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_knowledge_roundtrip(booted):
    """KNOWLEDGE 钩子全链：L1 弹卡 → 知识条目即时进知识集 → 回退移除。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.KNOWLEDGE, _entry_payload())
    assert outcome.applied and "patch:knowledge" in ctx.card_keys
    assert runtime.knowledge_set.get("k.e2e.hook_knowledge") is not None  # 即时生效
    snapshot = runtime.introspection_service.snapshot_knowledge()
    assert any(e["id"] == "k.e2e.hook_knowledge" for e in snapshot["entries"])
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert runtime.knowledge_set.get("k.e2e.hook_knowledge") is None  # 回退撤销
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_harness_roundtrip(booted):
    """HARNESS 钩子全链：L1 弹卡 → 领域定义即时登记 → 回退（链态还原 + 审计）。

    harness 注册表为登记位语义（引擎无注销原语）：回退在权威链上生效
    （链态/审计还原），运行期登记位由重启装配收敛——本用例钉住机制
    原语边界。
    """
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.HARNESS, _harness_payload())
    assert outcome.applied and "patch:harness" in ctx.card_keys
    assert "inkling.e2e.hook" in runtime.harness_registry.names()  # 即时登记
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    state = await runtime.self_pipeline.chain.assemble()
    assert "inkling.e2e.hook" not in (state.get("harness") or {})  # 链态还原
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_event_type_roundtrip(booted):
    """EVENT_TYPE 钩子全链：L1 弹卡 → 事件注册表即时登记 → 回退注销登记位。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.EVENT_TYPE, _event_type_payload())
    assert outcome.applied and "patch:event_type" in ctx.card_keys
    assert runtime.event_type_registry.get("e2e.hook_event") is not None  # 即时生效
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert runtime.event_type_registry.get("e2e.hook_event") is None  # 回退撤销
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_environment_roundtrip(booted):
    """ENVIRONMENT 钩子全链：L1 弹卡 → 环境声明即时生效 → 回退回落基线声明。"""
    runtime, host, _mount = booted
    ctx = ScriptedApprovalCtx()

    outcome = await _apply_patch(runtime, ctx, PatchKind.ENVIRONMENT, _env_payload())
    assert outcome.applied and "patch:environment" in ctx.card_keys
    assert host.environments.specs.get("e2e.hook_env") is not None  # 即时生效
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(ctx, outcome.patch_id, reason="e2e 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert "e2e.hook_env" not in host.environments.specs  # 回退撤销（回落基线）
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


async def test_hook_artifact_roundtrip(booted, tmp_path):
    """ARTIFACT 钩子全链：L2 构建验证 → 产物工具即时挂载 → 回退退出工具表。"""
    from ink_engine.core.builder import SmokeProbe
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    runtime, host, _mount = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "build_hook.py").write_text(
        "from pathlib import Path\n"
        "Path('app.py').write_text(\"print('hook')\\n\", encoding='utf-8')\n",
        encoding="utf-8",
    )
    spec = domain.build_spec(
        kind="service",
        command="python",
        args=("build_hook.py",),
        workdir=ws,
        output_paths=("app.py",),
    )
    artifact = await domain.build(spec)
    smoke = await domain.smoke(
        artifact, SmokeProbe(command="python", args=("app.py",), timeout=30)
    )
    assert smoke.ok

    declared = DeclarativeToolSpec(
        name="e2e.hook_artifact_tool",
        description="产物工具（自指全钩子 e2e）",
        parameters={"type": "object"},
        permissions=["process:exec:e2e.hook_artifact_tool"],
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["e2e.hook_artifact_tool"]},
        meta={"artifact": True},
    )
    outcome = await domain.propose_artifact_patch(
        ctx, artifact, declared_tool=declared, smoke=smoke, round_id="hook-artifact"
    )
    assert outcome.applied, outcome.reason
    assert "e2e.hook_artifact_tool" in runtime.tool_registry  # 产物工具即时挂载
    await _last_audit(runtime, AUDIT_STATUS_APPLIED)

    reverted = await runtime.self_pipeline.revert(
        ctx, outcome.patch_id, reason="e2e 产物回退"
    )
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert "e2e.hook_artifact_tool" not in runtime.tool_registry  # 回退撤销
    await _last_audit(runtime, AUDIT_STATUS_REVERTED)


# ── on_reverted 通知钩子（直接钉住）──


async def test_on_reverted_notification_hook_direct():
    """on_reverted 通知钩子：回退时以 (patch_id, reason) 回调宿主。"""
    from ink_engine.core.self_proposal import ProposalValidator

    storage = create_storage("memory://")
    calls: list[tuple[int, str]] = []

    async def spy(patch_id: int, reason: str) -> None:
        calls.append((patch_id, reason))

    pipeline = SelfApplicationPipeline(
        storage,
        on_reverted=spy,
        validator=ProposalValidator(
            allowed_theme_tokens=("bg.base", "text.base", "accent.approval")
        ),
    )
    ctx = ScriptedApprovalCtx()
    outcome = await pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"bg.base": "#111111"}},
            rationale="spy 钩子用例",
        ),
    )
    assert outcome.applied
    reverted = await pipeline.revert(ctx, outcome.patch_id, reason="spy 回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert calls == [(outcome.patch_id, "spy 回退")]  # 通知钩子精确触发


# ── GuardedStorage 旁路写防护 ──


async def test_guarded_storage_blocks_direct_writes(booted):
    """旁路写防护：演化资产集合直写拒绝；令牌/豁免上下文放行，退出即收回。"""
    runtime, _host, _mount = booted
    guarded = runtime.storage

    # 精确集合（工具注册）直写拒绝
    with pytest.raises(Exception, match="旁路写拦截"):
        await guarded.put_record("tool_defs", "k", {"name": "sneaky"})
    # 前缀集合（知识集 knowledge:<id>）直写拒绝
    with pytest.raises(Exception, match="旁路写拦截"):
        await guarded.put_record("knowledge:inkling", "chain", {"base": {}})
    # 非演化资产集合（机制通道）不受限
    await guarded.put_record("checkpoint_meta", "k", {"note": "机制通道"})

    # 机制豁免上下文：显式集合豁免放行
    with guarded.allow_mechanism("tool_defs"):
        await guarded.put_record("tool_defs", "k", {"name": "ok"})
    # 退出上下文即收回：再次直写拒绝
    with pytest.raises(Exception, match="旁路写拦截"):
        await guarded.put_record("tool_defs", "k2", {"name": "blocked"})

    # 守卫令牌放行（应用管线内部写入路径）
    await guarded.put_record(
        "tool_defs", "k3", {"name": "token-ok"}, guard_token=runtime.guard_token
    )


# ── convergence_provider 收敛管制（数据驱动 review.json max_rounds）──


async def test_convergence_cooling_blocks_repeated_target(booted):
    """收敛管制：同目标反复提案（apply_patch 工具路径）→ 冷却拒绝（数据驱动）。"""
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()
    max_rounds = int(load_seed("review.json")["max_rounds"])

    # apply_patch 为自指元工具（self_specs，不在声明式工具表）
    spec = next(s for s in runtime.self_specs if s.name == "apply_patch")
    outcomes = []
    for _index in range(max_rounds + 1):
        result = await runtime.tool_pipeline.execute(
            ctx,
            spec,
            {
                "kind": "knowledge",
                "payload": _entry_payload(),
                "rationale": "收敛管制用例",
            },
        )
        outcomes.append(json.loads(result.output))

    # 前 max_rounds 次落链生效；第 max_rounds+1 次同目标冷却拒绝
    assert all(outcomes[i]["ok"] for i in range(max_rounds))
    denied = outcomes[-1]
    assert denied["ok"] is False
    assert denied["status"] == "cooling"
    assert "knowledge/k.e2e.hook_knowledge" in denied["target"]
    assert "收敛" in denied["reason"]
    assert "冷却" in denied["hint"]

    # 换目标不受管制（冷却按目标隔离）
    other = dict(_entry_payload())
    other["entry"]["id"] = "k.e2e.other_target"
    result = await runtime.tool_pipeline.execute(
        ctx,
        spec,
        {"kind": "knowledge", "payload": other, "rationale": "换目标"},
    )
    assert json.loads(result.output)["ok"] is True


# ── 同一链语义（挂载/环境/产物与其余类型同链互操作）──


async def test_multi_kind_same_chain_semantics(booted):
    """同一链语义：TOOL/ENVIRONMENT/KNOWLEDGE 同链互操作 + 链尾折叠回退。

    引擎 SetPatchChain.revert 为单步链尾折叠语义：回退链尾 = 其余补丁
    折叠进新 base（链长收敛、版本重置为 1），旧链在审计中完整保留——
    本用例钉住该语义（回退撤销 = 链尾补丁生效态消失，前置补丁效果保留
    在折叠 base 中）。
    """
    runtime, _host, _mount = booted
    ctx = ScriptedApprovalCtx()

    tool = await _apply_patch(runtime, ctx, PatchKind.TOOL, _tool_spec())
    assert tool.applied
    env = await _apply_patch(runtime, ctx, PatchKind.ENVIRONMENT, _env_payload())
    assert env.applied
    know = await _apply_patch(runtime, ctx, PatchKind.KNOWLEDGE, _entry_payload())
    assert know.applied

    # 版本连续递增（同一补丁链，无类型分链）
    assert [tool.patch_id, env.patch_id, know.patch_id] == [2, 3, 4]
    state = await runtime.self_pipeline.chain.assemble()
    assert set(state["tools"]) == {"e2e.hook_tool"}
    assert set(state["environments"]) == {"e2e.hook_env"}
    assert set(state["knowledge"]) == {"k.e2e.hook_knowledge"}

    # 链尾单步折叠回退：KNOWLEDGE 撤销，前置 TOOL/ENVIRONMENT 折叠进 base
    reverted = await runtime.self_pipeline.revert(ctx, know.patch_id, reason="e2e 同链回退")
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert await runtime.self_pipeline.chain.current_version() == 1  # 链长收敛
    state = await runtime.self_pipeline.chain.assemble()
    assert not state.get("knowledge")  # 链尾补丁撤销
    assert set(state["tools"]) == {"e2e.hook_tool"}  # 前置补丁效果保留
    assert set(state["environments"]) == {"e2e.hook_env"}
    audit = await runtime.self_pipeline.audit_log()
    assert [r["status"] for r in audit] == [
        AUDIT_STATUS_APPLIED,
        AUDIT_STATUS_APPLIED,
        AUDIT_STATUS_APPLIED,
        AUDIT_STATUS_REVERTED,
    ]  # 审计完整：旧链历史不撒谎（折叠不删记录）

    # 回退后无后继补丁 = 无可回退链尾（折叠语义钉住）
    with pytest.raises(Exception, match="仅允许回退链尾"):
        await runtime.self_pipeline.revert(ctx, env.patch_id, reason="已折叠不可回退")

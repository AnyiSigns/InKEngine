"""宿主安全域自动审批逻辑测试（纯逻辑面，不起真实进程）。

覆盖：登记边界（仅声明 auto_approvable 的工具可登记，边界外硬拒）、
弹卡跳过判定（命中 = review 档直过）、全量开关、审计留痕标记
（auto_approved_by_user 随成功审计记录落位）。
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HOST_PY = _REPO_ROOT / "inkling/shell/src-tauri/src/engine/py"
if str(_HOST_PY) not in sys.path:
    sys.path.insert(0, str(_HOST_PY))

from inkling_host.security_domain import SecurityToolPipeline, TieredGate  # noqa: E402


def _gate() -> TieredGate:
    """出厂档位样例门禁（review 档两件 + 可登记集一件）。"""
    return TieredGate(
        {"probe_check": "review", "launch_app": "review"},
        auto_approvable=frozenset({"probe_check"}),
    )


def test_review_tier_hangs_card_without_auto_approve() -> None:
    gate = _gate()
    verdict = gate.check(
        "probe_check", "exec", "probe_check",
        permissions=("process:exec:probe_check",),
    )
    assert verdict.decision == "review", "未预授权 = 保持弹卡"


def test_auto_approve_hit_skips_review_only() -> None:
    gate = _gate()
    gate.configure_auto_approve(["probe_check"], all_review=False)
    verdict = gate.check(
        "probe_check", "exec", "probe_check",
        permissions=("process:exec:probe_check",),
    )
    assert verdict.decision == "allow", "命中自动审批 = 跳过人审弹卡"
    # 未登记工具不受影响（仍 review）
    other = gate.check(
        "launch_app", "exec", "launch_app",
        permissions=("process:exec:launch_app",),
    )
    assert other.decision == "review", "未登记工具保持弹卡"


def test_auto_approve_all_review_switch() -> None:
    """全量直过开关语义（产品决策：auto_approve_all = 全量直过，含升级档）。

    开启后任何 review/升级档工具（含可登记边界之外的工具）一律直过；
    逐工具登记（configure_auto_approve 的边界外硬拒）不受影响——那是对
    具名登记集的约束，不是全量开关的约束。
    """
    gate = _gate()
    gate.configure_auto_approve([], all_review=True)
    verdict = gate.check(
        "probe_check", "exec", "probe_check",
        permissions=("process:exec:probe_check",),
    )
    assert verdict.decision == "allow", "全量开关对可登记集生效"
    # 全量直过含边界外工具（升级/OS 控制档同样直过，人审不弹卡）
    other = gate.check(
        "launch_app", "exec", "launch_app",
        permissions=("process:exec:launch_app",),
    )
    assert other.decision == "allow", "全量直过开关对全部 review/升级档工具生效"

    # 逐工具登记仍受边界约束（登记集硬拒与全量开关互不影响）
    gate.configure_auto_approve([], all_review=False)
    back = gate.check(
        "launch_app", "exec", "launch_app",
        permissions=("process:exec:launch_app",),
    )
    assert back.decision == "review", "关闭全量开关后边界外工具恢复弹卡"


def test_registration_boundary_rejects_control_tools() -> None:
    gate = _gate()
    try:
        gate.configure_auto_approve(["launch_app"], all_review=False)
    except ValueError as exc:
        assert "launch_app" in str(exc), "边界外工具必须点名"
    else:
        raise AssertionError("OS 控制类工具登记必须硬拒")


def test_snapshot_roundtrip() -> None:
    gate = _gate()
    gate.configure_auto_approve(["probe_check"], all_review=True)
    tools, all_review = gate.auto_approve_snapshot()
    assert tools == ["probe_check"]
    assert all_review is True
    assert gate.auto_approvable_tools() == ["probe_check"]


def test_os_bridge_covers_shell_exec() -> None:
    """引擎宿主 → 壳执行器的桥接清单必须覆盖 shell_exec（否则经
    process_exec 端点分发恒拿 executor_not_registered）。"""
    from inkling_host import host as host_module

    bridged = set(host_module._OS_BRIDGE_COMMANDS)
    assert "shell_exec" in bridged, "shell_exec 必须登记进 OS 执行体桥"


class _AuditCtx:
    """审计事件收集桩（ctx.emit 面）。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def emit(self, etype: str, payload: dict, **_: object) -> None:
        self.events.append((etype, payload))


def test_audit_marker_auto_approved_by_user() -> None:
    import asyncio

    gate = _gate()
    gate.configure_auto_approve(["probe_check"], all_review=False)
    pipeline = SecurityToolPipeline(gate=gate)
    ctx = _AuditCtx()
    asyncio.run(
        pipeline._audit(  # noqa: SLF001 直接验证留痕标记
            ctx,
            {"tool": "probe_check", "decision": "ok", "overflow": False},
        )
    )
    assert any(
        etype == "tool_audit" and payload.get("auto_approved_by_user") is True
        for etype, payload in ctx.events
    ), "自动审批命中的成功审计必须带标记"

    # 未命中的工具不带标记
    ctx.events.clear()
    asyncio.run(
        pipeline._audit(  # noqa: SLF001
            ctx,
            {"tool": "launch_app", "decision": "ok", "overflow": False},
        )
    )
    assert all(
        payload.get("auto_approved_by_user") is not True
        for _, payload in ctx.events
    ), "未命中的工具不得带自动审批标记"


def test_pipeline_auto_approve_zero_card_and_marked_audit() -> None:
    """穿流水线的端到端断言：命中自动审批 = 零弹卡 + 审计带标记。"""
    import asyncio

    from ink_engine.core.declarative_tools import DeclarativeToolSpec
    from ink_engine.core.executor import InterruptSignal

    spec = DeclarativeToolSpec.from_dict(
        {
            "name": "probe_check",
            "description": "类型检查（钉死参数模板）",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
            "permissions": ["process:exec:probe_check"],
            "endpoint": "process_exec",
            "endpoint_config": {"allowlist": ["probe_check"]},
            "meta": {},
        }
    )

    class RoundCtx:
        def __init__(self) -> None:
            self.events: list[tuple[str, dict]] = []

        async def emit(self, etype: str, payload: dict, **_: object) -> None:
            self.events.append((etype, payload))

        async def interrupt(self, key: str, payload: dict) -> object:
            raise InterruptSignal(key, payload)

    async def executor(
        _ctx: object, _spec: object, _args: dict, _approval: object
    ) -> str:
        return "exit 0\n类型检查通过"

    def extractor(_spec: object, _args: dict) -> tuple[str, str]:
        return ("exec", "probe_check")

    gate = _gate()
    pipeline = SecurityToolPipeline(
        gate=gate, extractor=extractor, executor=executor
    )
    ctx = RoundCtx()

    # 未预授权 = 弹卡（挂起等待人审）
    try:
        asyncio.run(pipeline.execute(ctx, spec, {"command": "probe_check"}))
    except InterruptSignal:
        pass
    else:
        raise AssertionError("未预授权必须挂卡等待人审")

    # 预授权后 = 零弹卡直过 + 审计标记
    gate.configure_auto_approve(["probe_check"], all_review=False)
    ctx.events.clear()
    result = asyncio.run(pipeline.execute(ctx, spec, {"command": "probe_check"}))
    assert result.ok, "自动审批命中应直过执行"
    assert not any(etype == "review_card" for etype, _ in ctx.events), "不得出现审批卡"
    audit = [payload for etype, payload in ctx.events if etype == "tool_audit"]
    assert audit and audit[-1].get("auto_approved_by_user") is True, "审计必须带自动审批标记"

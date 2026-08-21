"""AI 开发模式 e2e（PLAN §6 M3-2 AI 开发模式）。

覆盖：工作区授权（设置页授权确认卡形态 + 撤销）→ 文件工具经沙箱在
授权工作区内构建循环（写 → 构建 → 失败信号回流 → 编辑再改 → 冒烟 →
产物挂载）→ 产物挂载全链路（授权 → 文件操作 → 构建 → 冒烟 → 工具表
生效 → 回退撤销）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from conftest import ScriptedApprovalCtx
from ink_engine.core.builder import BuildError, SmokeProbe
from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

from host.build_domain import BuildDomain

# 构建脚本模板（数据驱动：文件工具写代码 → 构建管线产出产物）
_BUILD_SCRIPT_TEMPLATE = (
    "from pathlib import Path\n"
    "Path('app.py').write_text(\"print('dev-loop')\\n\", encoding='utf-8')\n"
)


def _declared_tool_spec() -> DeclarativeToolSpec:
    """AI 开发产物声明工具（e2e 挂载断言；stub 执行器闭环）。"""
    return DeclarativeToolSpec(
        name="dev_artifact_tool",
        description="AI 开发产物声明工具（e2e 挂载断言）",
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["dev_artifact_tool"],
                    "description": "命令名（固定值；与端点操作判定同源）",
                },
                "arg": {"type": "string"},
            },
            "required": ["command"],
        },
        permissions=["process:exec:dev_artifact_tool"],
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["dev_artifact_tool"]},
        meta={"artifact": True, "sandbox": "process_allowlist"},
    )


async def _authorize(runtime: Any, host: Any, ws: Path, ctx: Any) -> None:
    result = await host.workspaces.authorize(ctx, ws, reason="AI 开发模式 e2e")
    assert result["ok"], result
    # 授权后文件工具根目录替换生效（占位符 → 实际挂载点）
    definition = runtime.harness_registry.declarative.definitions["file_write"]
    assert "${workspace_root}" not in definition.endpoint_config.get("root", "")


async def _call(runtime: Any, ctx: Any, name: str, args: dict[str, Any]):
    spec = runtime.tool_registry[name]
    return await runtime.tool_pipeline.execute(ctx, spec, args)


# ── 授权（设置页授权确认卡形态）──


async def test_workspace_authorization_card_flow(booted, approval_ctx, tmp_path):
    """授权确认卡：拒绝 = 文件工具不可用；同意 = 根目录替换生效。"""
    runtime, host, _mount_service = booted
    ws = tmp_path / "ws"
    ws.mkdir()

    # 拒绝授权：文件工具保持未授权态（工具在表但沙箱拒绝）
    denied_ctx = ScriptedApprovalCtx({"workspace:authorize": "reject"})
    result = await host.workspaces.authorize(denied_ctx, ws, reason="拒绝路径")
    assert result["ok"] is False
    assert "workspace:authorize" in denied_ctx.card_keys  # 授权确认卡已弹
    denied = await _call(
        runtime, denied_ctx, "file_read",
        {"operation": "read", "path": str(ws / "x.txt")},
    )
    assert denied.ok is False
    assert "工作区未授权" in (denied.error or "")

    # 同意授权：确认卡 → 持久化 → 文件工具生效
    ctx = approval_ctx()
    await _authorize(runtime, host, ws, ctx)
    assert host.workspaces.authorized_root is not None
    root = await host.workspaces.authorized_root()
    assert root == ws.resolve()
    # 授权可审计：storage 记录留存（重启恢复依据）
    record = await runtime.storage.get_record(
        host.workspaces.AUTH_COLLECTION, host.workspaces._AUTH_KEY
    )
    assert record is not None and record["root"] == str(ws.resolve())


async def test_workspace_revoke_returns_to_denied(booted, approval_ctx, tmp_path):
    """撤销授权：确认卡 → 文件工具回到未授权拒绝态。"""
    runtime, host, _mount_service = booted
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "note.txt").write_text("内容", encoding="utf-8")
    ctx = approval_ctx()
    await _authorize(runtime, host, ws, ctx)

    ok = await _call(
        runtime, ctx, "file_read", {"operation": "read", "path": str(ws / "note.txt")},
    )
    assert ok.ok

    revoked = await host.workspaces.revoke(ctx, reason="e2e 撤销")
    assert revoked["ok"]
    denied = await _call(
        runtime, ctx, "file_read", {"operation": "read", "path": str(ws / "note.txt")},
    )
    assert denied.ok is False
    assert "工作区未授权" in (denied.error or "")


# ── AI 开发闭环：授权 → 文件操作 → 构建 → 冒烟 → 产物挂载 ──


async def test_ai_dev_full_loop_build_fix_mount(booted, approval_ctx, tmp_path):
    """AI 开发闭环：写 → 构建失败信号回流 → 编辑修复 → 冒烟 → 挂载生效。"""
    runtime, host, _mount_service = booted
    ctx = approval_ctx()
    ws = tmp_path / "ws"
    ws.mkdir()
    await _authorize(runtime, host, ws, ctx)
    domain: BuildDomain = host.builds

    # ① 文件工具写构建脚本（v1 带 bug：构建必失败 → 失败信号回流回合）
    v1 = (
        "from pathlib import Path\n"
        "raise SystemExit(3)  # 初版 bug：构建失败信号\n"
    )
    write1 = await _call(
        runtime, ctx, "file_write",
        {"operation": "write", "path": str(ws / "build_artifact.py"), "content": v1},
    )
    assert write1.ok
    assert json.loads(write1.output)["ok"] is True
    assert "workspace:authorize" in ctx.card_keys  # 授权卡留痕
    assert "gate:file_write" in ctx.card_keys  # 写操作 review 档弹卡

    # ② 构建 → 失败（结构化 BuildError，无产物记录）
    spec = domain.build_spec(
        kind="service",
        command="python",
        args=("build_artifact.py",),
        workdir=ws,
        output_paths=("app.py",),
    )
    try:
        await domain.build(spec)
        build_failed = False
    except BuildError:
        build_failed = True
    assert build_failed  # 失败信号回流（回合据此再改）

    # ③ file_read 回读 + file_edit 修复（读-改循环）
    read1 = await _call(
        runtime, ctx, "file_read",
        {"operation": "read", "path": str(ws / "build_artifact.py")},
    )
    assert read1.ok
    edit1 = await _call(
        runtime, ctx, "file_edit",
        {
            "operation": "write",
            "path": str(ws / "build_artifact.py"),
            "old_text": "raise SystemExit(3)  # 初版 bug：构建失败信号\n",
            "new_text": _BUILD_SCRIPT_TEMPLATE.splitlines()[1] + "\n",
        },
    )
    assert edit1.ok
    fixed = (ws / "build_artifact.py").read_text(encoding="utf-8")
    assert "SystemExit" not in fixed

    # ④ 重建 → 通过；冒烟 → 通过
    artifact = await domain.build(spec)
    smoke = await domain.smoke(
        artifact, SmokeProbe(command="python", args=("app.py",), timeout=30)
    )
    assert smoke.ok
    assert "dev-loop" in smoke.output

    # ⑤ 产物挂载：ARTIFACT L2 审批 → 工具表生效
    outcome = await domain.propose_artifact_patch(
        ctx,
        artifact,
        declared_tool=_declared_tool_spec(),
        smoke=smoke,
    )
    assert outcome.applied, outcome.reason
    assert "dev_artifact_tool" in runtime.tool_registry  # 工具表生效

    # ⑥ 挂载产物可调用（stub 执行器注入，闭环断言）
    async def _stub(_ctx, _definition, args):
        return f"dev-ran:{args.get('arg')}"

    host.security.os_registry.register("dev_artifact_tool", _stub)
    call = await runtime.tool_pipeline.execute(
        ctx,
        runtime.tool_registry["dev_artifact_tool"],
        {"command": "dev_artifact_tool", "arg": "loop"},
    )
    assert call.ok
    assert call.output == "dev-ran:loop"

    # ⑦ 回退撤销：声明工具退出工具表（可回退断言）
    reverted = await runtime.self_pipeline.revert(
        ctx, outcome.patch_id, reason="e2e AI 开发产物回退"
    )
    assert reverted.status == "reverted"
    assert "dev_artifact_tool" not in runtime.tool_registry


async def test_ai_dev_unauthorized_write_rejected(booted, approval_ctx, tmp_path):
    """未授权即写：文件工具沙箱拒绝（越权操作结构化失败，不落盘）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    ws = tmp_path / "ws"
    ws.mkdir()
    outcome = await _call(
        runtime, ctx, "file_write",
        {
            "operation": "write",
            "path": str(ws / "sneaky.py"),
            "content": "print('未经授权')",
        },
    )
    assert outcome.ok is False
    assert "工作区未授权" in (outcome.error or "")
    assert not (ws / "sneaky.py").exists()  # 拒绝不落盘

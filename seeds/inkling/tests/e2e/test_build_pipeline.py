"""构建管线 e2e（PLAN §6 M3-2 构建管线）。

覆盖：builder 白名单沙箱构建（通过/非白名单拒绝）、内容寻址产物、
冒烟门禁（失败不 promote）、artifact 补丁（L2 钩子部署前验证 → 落链
→ 声明工具挂载引擎 → 回退撤销）、容器部署（无 Docker 结构化降级，
全链路显式 skipif）。
"""
from __future__ import annotations

from pathlib import Path

import pytest
from conftest import ScriptedApprovalCtx, load_seed
from ink_engine.core.builder import BuildError, SmokeProbe
from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType
from ink_engine.core.self_application import (
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_REJECTED,
)
from ink_engine.core.self_proposal import PatchKind, SelfProposal

from host.build_domain import BuildDomain
from host.environment_domain import docker_available

# ── 构建工作区夹具（数据驱动：构建脚本 + 产物 + 声明工具）──


def _make_workspace(tmp_path: Path, *, fail_build: bool = False) -> Path:
    """构建工作区：build_artifact.py 产出 app.py（冒烟探针自检对象）。"""
    ws = tmp_path / "build-ws"
    ws.mkdir()
    if fail_build:
        (ws / "build_artifact.py").write_text(
            "raise SystemExit(7)\n", encoding="utf-8"
        )
    else:
        (ws / "build_artifact.py").write_text(
            "from pathlib import Path\n"
            "Path('app.py').write_text(\"print('hello artifact')\\n\", encoding='utf-8')\n",
            encoding="utf-8",
        )
    return ws


def _declared_tool_spec() -> DeclarativeToolSpec:
    """产物声明工具（process_exec 端点，e2e 用 stub 执行器闭环）。"""
    return DeclarativeToolSpec(
        name="artifact_tool",
        description="构建产物声明工具（e2e 挂载断言）",
        parameters={
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "enum": ["artifact_tool"],
                    "description": "命令名（固定值；与端点操作判定同源）",
                },
                "arg": {"type": "string"},
            },
            "required": ["command"],
        },
        permissions=["process:exec:artifact_tool"],
        endpoint=EndpointType.PROCESS_EXEC,
        endpoint_config={"allowlist": ["artifact_tool"]},
        meta={"artifact": True, "sandbox": "process_allowlist"},
    )


def _build_domain(tmp_path: Path) -> BuildDomain:
    return BuildDomain(
        load_seed("build.json"), artifact_dir=tmp_path / "artifacts"
    )


# ── 白名单沙箱构建 ──


async def test_build_whitelist_passes_content_addressed(tmp_path):
    """白名单构建通过：产物内容寻址 + 文件级 sha256 哈希（数据驱动声明）。"""
    domain = _build_domain(tmp_path)
    ws = _make_workspace(tmp_path)
    spec = domain.build_spec(
        kind="service",
        command="python",
        args=("build_artifact.py",),
        workdir=ws,
        output_paths=("app.py",),
    )
    artifact = await domain.build(spec)
    assert artifact.kind == "service"
    assert artifact.artifact_id.startswith("service-")
    assert "app.py" in artifact.files
    assert len(artifact.files["app.py"]) == 64  # sha256 hex
    # 内容寻址：同内容重建 → 同 id（幂等可复现）
    again = await domain.build(spec)
    assert again.artifact_id == artifact.artifact_id
    # 产物落盘可读（部署/挂载取用）
    assert (domain.artifact_dir(artifact) / "app.py").is_file()


async def test_build_non_whitelist_rejected(tmp_path):
    """非白名单构建命令：fail-closed 拒绝（BLD_001，不产出任何产物）。"""
    domain = _build_domain(tmp_path)
    ws = _make_workspace(tmp_path)
    spec = domain.build_spec(
        kind="service",
        command="curl",
        args=("http://evil.example",),
        workdir=ws,
        output_paths=("app.py",),
    )
    with pytest.raises(BuildError) as exc_info:
        await domain.build(spec)
    assert "白名单" in str(exc_info.value)
    assert domain.artifacts == {}  # 无半成品记录


async def test_build_failure_structured_no_artifact(tmp_path):
    """构建命令失败：结构化 BuildError（BLD_002），不产出记录。"""
    domain = _build_domain(tmp_path)
    ws = _make_workspace(tmp_path, fail_build=True)
    spec = domain.build_spec(
        kind="service",
        command="python",
        args=("build_artifact.py",),
        workdir=ws,
        output_paths=("app.py",),
    )
    with pytest.raises(BuildError):
        await domain.build(spec)
    assert domain.artifacts == {}


# ── 冒烟门禁 ──


async def test_smoke_gate_pass_and_fail(tmp_path):
    """冒烟门禁：探针自检通过 = ok；失败 = 不 promote（数据驱动探针）。"""
    domain = _build_domain(tmp_path)
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    # 通过探针（默认形态：python app.py 退出码 0）
    ok_probe = SmokeProbe(command="python", args=("app.py",), timeout=30, expect_exit=0)
    result = await domain.smoke(artifact, ok_probe)
    assert result.ok
    assert "hello artifact" in result.output

    # 失败探针：期望退出码不符 → 冒烟失败（产物保留但不得 promote）
    fail_probe = SmokeProbe(command="python", args=("app.py",), timeout=30, expect_exit=1)
    failed = await domain.smoke(artifact, fail_probe)
    assert failed.ok is False


async def test_smoke_fail_blocks_artifact_promote(booted, tmp_path):
    """冒烟失败 → artifact 补丁 L2 钩子拒绝（部署前验证，fail-closed）。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    failed_smoke = await domain.smoke(
        artifact, SmokeProbe(command="python", args=("app.py",), timeout=30, expect_exit=1)
    )
    assert failed_smoke.ok is False
    domain.attach(runtime)
    outcome = await domain.propose_artifact_patch(
        ctx,
        artifact,
        declared_tool=_declared_tool_spec(),
        smoke=failed_smoke,
    )
    assert outcome.applied is False
    assert outcome.status == AUDIT_STATUS_REJECTED
    assert "冒烟" in (outcome.reason or "")  # 冒烟记录未通过 → 拒绝 promote
    assert "artifact_tool" not in runtime.tool_registry  # 未挂载


# ── artifact 补丁 → 产物挂载引擎 → 回退 ──


async def test_artifact_patch_mounts_declared_tool(booted, tmp_path):
    """产物挂载引擎：构建 → 冒烟 → ARTIFACT L2 审批 → 工具表生效 → 可调用。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    smoke = await domain.smoke(
        artifact, SmokeProbe(command="python", args=("app.py",), timeout=30)
    )
    assert smoke.ok
    domain.attach(runtime)

    outcome = await domain.propose_artifact_patch(
        ctx,
        artifact,
        declared_tool=_declared_tool_spec(),
        smoke=smoke,
    )
    assert outcome.applied, outcome.reason
    assert outcome.status == AUDIT_STATUS_APPLIED
    assert any(key == "patch:artifact" for key in ctx.card_keys)  # L2 弹卡

    # 产物声明工具进工具表（patch 应用后工具表含新声明）
    assert "artifact_tool" in runtime.tool_registry
    # 经统一流水线可调用（stub 执行器注入，闭环断言）
    async def _stub(_ctx, _definition, args):
        return f"artifact-ran:{args.get('arg')}"

    host.security.os_registry.register("artifact_tool", _stub)
    call = await runtime.tool_pipeline.execute(
        ctx,
        runtime.tool_registry["artifact_tool"],
        {"command": "artifact_tool", "arg": "x"},
    )
    assert call.ok
    assert call.output == "artifact-ran:x"

    # 补丁链权威记录：产物段可审计
    assembled = await runtime.self_pipeline.chain.assemble()
    artifacts = assembled.get("artifacts") or {}
    assert artifact.artifact_id in artifacts
    assert "artifact_tool" in (artifacts[artifact.artifact_id].get("meta") or {}).get("tool", {}).get("name", "")

    # 回退：声明工具从工具表撤销（产物挂载可回退）
    reverted = await runtime.self_pipeline.revert(
        ctx, outcome.patch_id, reason="e2e 产物回退"
    )
    assert reverted.status == "reverted"
    assert "artifact_tool" not in runtime.tool_registry
    assert "artifact_tool" not in domain.declared_tools


async def test_artifact_patch_vetting_hash_mismatch_rejected(booted, tmp_path):
    """L2 钩子哈希门禁：产物声明哈希与产物目录不符 → 拒绝落链。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    smoke = await domain.smoke(
        artifact, SmokeProbe(command="python", args=("app.py",), timeout=30)
    )
    domain.attach(runtime)
    # 篡改哈希声明（模拟产物切换/声明漂移）→ 部署前验证拒绝
    tampered = artifact.to_dict()
    tampered["hashes"] = {"app.py": "0" * 64}
    proposal = SelfProposal(
        kind=PatchKind.ARTIFACT,
        payload={
            "artifact_id": artifact.artifact_id,
            "kind": artifact.kind,
            "hashes": tampered["hashes"],
            "meta": {
                "tool": _declared_tool_spec().to_dict(),
                "smoke": {"ok": smoke.ok},
                "built_at": artifact.built_at,
            },
        },
        base_version=await runtime.self_pipeline.chain.current_version(),
        rationale="哈希门禁拒绝断言",
    )
    outcome = await runtime.self_pipeline.apply(ctx, proposal)
    assert outcome.applied is False
    assert "哈希" in (outcome.reason or "")
    assert "artifact_tool" not in runtime.tool_registry


# ── 容器部署 ──


async def test_container_deploy_degrades_without_docker(booted, tmp_path):
    """容器部署降级：无 Docker → 结构化失败（ENV_004，不崩溃不假部署）。"""
    if docker_available():
        pytest.skip("本机 Docker 可用，降级路径用例跳过（全链路用例覆盖）")
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    domain.attach(runtime)
    result = await domain.deploy_to_container(
        ctx,
        artifact,
        host.environments,
        env_name="inkling.deploy.e2e",
        command="python",
        args=("app.py",),
    )
    assert result["ok"] is False
    assert result["status"] == "container_unavailable"
    assert "Docker" in (result["error"] or "")


@pytest.mark.skipif(
    not docker_available(),
    reason="本机 Docker 守护进程不可达（容器全链路 e2e 显式跳过，实现已出厂落地）",
)
async def test_container_deploy_full_loop(booted, tmp_path):
    """容器部署全链路（Docker 可用时）：环境补丁落链 → 容器内运行产物。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    domain = host.builds
    ws = _make_workspace(tmp_path)
    artifact = await domain.build(
        domain.build_spec(
            kind="service",
            command="python",
            args=("build_artifact.py",),
            workdir=ws,
            output_paths=("app.py",),
        )
    )
    domain.attach(runtime)
    result = await domain.deploy_to_container(
        ctx,
        artifact,
        host.environments,
        env_name="inkling.deploy.e2e",
        command="python",
        args=("app.py",),
    )
    assert result["ok"], result
    assert result["status"] == "deployed"
    assert result["patch_id"] is not None

"""环境装配 e2e（PLAN §6 M3-2 环境装配）。

覆盖：env.json → EnvironmentSpec → 三环境 providers 注册表 + 域选择
（local/web_bridge/container）；local 环境变量声明应用（env_vars 数据
形态）；web_bridge 形态语义（ensure 恒就绪 / run 显式不支持）；容器
提供器出厂落地（镜像描述 = 数据；无 Docker = 结构化降级 ENV_004，全
链路用例显式 skipif，不假跳过）；PatchKind.ENVIRONMENT 补丁链（落链/
活跃态生效/回退/审计）。
"""
from __future__ import annotations

import asyncio

import pytest
from conftest import ScriptedApprovalCtx, load_seed
from ink_engine.core.environments import EnvironmentSpec, RuntimeKind
from ink_engine.core.self_application import (
    AUDIT_STATUS_APPLIED,
    AUDIT_STATUS_REVERTED,
)
from ink_engine.core.self_proposal import PatchKind, SelfProposal

from host.environment_domain import (
    EnvironmentDomain,
    SeedContainerProvider,
    docker_available,
)

# ── env.json → EnvironmentSpec → 三 provider 注册表 ──


def test_env_json_maps_to_three_specs():
    """env.json 三环境声明 → EnvironmentSpec（runtime 覆盖三形态）。"""
    specs = {
        env["name"]: EnvironmentSpec.from_dict(env)
        for env in load_seed("env.json")["environments"]
    }
    assert set(specs) == {"inkling.local", "inkling.web_bridge", "inkling.container"}
    assert specs["inkling.local"].runtime is RuntimeKind.LOCAL
    assert specs["inkling.web_bridge"].runtime is RuntimeKind.WEB_BRIDGE
    assert specs["inkling.container"].runtime is RuntimeKind.CONTAINER
    # 容器镜像描述 = 数据（补丁链版本化形态）
    image = (specs["inkling.container"].meta or {}).get("image") or {}
    assert image.get("name") == "inkling/base:0.1.0"


def test_environment_domain_registry_three_providers(tmp_path):
    """三 provider 注册表：local/web_bridge/container 齐备（域选择底座）。"""
    domain = EnvironmentDomain(load_seed("env.json"), envs_dir=tmp_path / "envs")
    assert set(domain.names()) == {
        "inkling.local", "inkling.web_bridge", "inkling.container",
    }
    assert domain.provider_names() == ("local", "web_bridge", "container")


# ── 域选择 + 三形态语义 ──


async def test_local_env_ensure_run_destroy_idempotent(tmp_path):
    """local 域选择：ensure 幂等 / run 白名单命令 / destroy 幂等。"""
    domain = EnvironmentDomain(
        load_seed("env.json"),
        envs_dir=tmp_path / "envs",
        run_allowlist=("python", "echo"),
    )
    handle = await domain.ensure("inkling.local")
    assert handle.status == "ready"
    again = await domain.ensure("inkling.local")
    assert again is handle  # ensure 幂等：已就绪返回既有实例

    result = await domain.run(
        "inkling.local", "python",
        ("-c", "import os; print(os.environ.get('INKLING_LOCAL_READY', 'missing'))"),
    )
    assert result.exit_code == 0
    assert "1" in result.stdout  # 环境变量声明（env.json meta.env_vars）已应用

    await domain.destroy("inkling.local")
    await domain.destroy("inkling.local")  # destroy 幂等（重复销毁静默成功）
    stale = await domain.run("inkling.local", "echo", ("x",))
    assert stale.exit_code == -1  # 销毁后运行 = 明确失败
    assert "未就绪" in stale.stderr


async def test_local_provider_run_rejects_non_allowlist(tmp_path):
    """local 运行沙箱：白名单外命令 fail-closed 拒绝（不崩溃）。"""
    domain = EnvironmentDomain(
        load_seed("env.json"),
        envs_dir=tmp_path / "envs",
        run_allowlist=("echo",),
    )
    await domain.ensure("inkling.local")
    result = await domain.run("inkling.local", "curl", ("http://evil",))
    assert result.exit_code == -1
    assert "白名单" in result.stderr


async def test_web_bridge_env_semantics(tmp_path):
    """web_bridge 形态：ensure 恒就绪 / run 显式不支持（浏览器隔离边界）。"""
    domain = EnvironmentDomain(load_seed("env.json"), envs_dir=tmp_path / "envs")
    handle = await domain.ensure("inkling.web_bridge")
    assert handle.status == "ready"
    result = await domain.run("inkling.web_bridge", "echo", ("x",))
    assert result.exit_code == -1
    assert "不支持" in result.stderr


# ── 容器提供器出厂落地（无 Docker = 结构化降级；全链路显式 skipif）──


def test_container_provider_structured_degrade_without_docker(tmp_path):
    """容器降级路径：Docker 不可用 → 结构化错误/失败态（不崩溃不假可用）。"""
    domain = EnvironmentDomain(load_seed("env.json"), envs_dir=tmp_path / "envs")
    if docker_available():
        pytest.skip("本机 Docker 可用，降级路径用例跳过（全链路用例覆盖）")

    async def _run():
        handle = await domain.ensure("inkling.container")
        assert handle.status == "failed"
        assert handle.error and "Docker" in handle.error  # 明确降级原因
        result = await domain.run("inkling.container", "echo", ("x",))
        assert result.exit_code == -1  # 未就绪运行 = 明确失败
        await domain.destroy("inkling.container")  # destroy 幂等不崩溃

    asyncio.run(_run())


async def test_container_ensure_direct_provider_degrades(tmp_path):
    """容器提供器直接调用：Docker 守护进程不可达 → ContainerUnavailable。"""
    if docker_available():
        pytest.skip("本机 Docker 可用，降级路径用例跳过（全链路用例覆盖）")
    provider = SeedContainerProvider()
    spec = EnvironmentSpec(
        name="inkling.container",
        runtime=RuntimeKind.CONTAINER,
        meta={"image": {"name": "inkling/base:0.1.0"}},
    )
    from host.environment_domain import ContainerUnavailable

    with pytest.raises(ContainerUnavailable):
        await provider.ensure(spec)


@pytest.mark.skipif(
    not docker_available(),
    reason="本机 Docker 守护进程不可达（容器全链路 e2e 显式跳过，实现已出厂落地）",
)
async def test_container_full_loop_build_run_destroy(tmp_path):
    """容器全链路（Docker 可用时）：声明 → ensure → run → destroy 幂等。"""
    domain = EnvironmentDomain(load_seed("env.json"), envs_dir=tmp_path / "envs")
    spec = EnvironmentSpec(
        name="inkling.container",
        runtime=RuntimeKind.CONTAINER,
        meta={
            "image": {
                "name": "inkling/e2e-alpine:0.1.0",
                "build_context": None,
            }
        },
    )
    handle = await domain.ensure_spec(spec)
    assert handle.status == "ready"
    result = await domain.run("inkling.container", "echo", ("容器闭环",))
    assert result.exit_code == 0
    assert "容器闭环" in result.stdout
    await domain.destroy("inkling.container")
    await domain.destroy("inkling.container")  # destroy 幂等


# ── PatchKind.ENVIRONMENT 补丁链（落链/生效/回退/审计）──


async def test_environment_patch_chain_apply_revert_audit(booted, approval_ctx):
    """ENVIRONMENT 补丁：L1 弹卡 → 落链 → 声明生效 → 回退 → 审计留痕。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    env_domain = host.environments

    # 环境变量补丁：声明变更 = 数据（env_vars 随补丁版本化）
    payload = {
        "name": "inkling.local",
        "runtime": "local",
        "tools": [],
        "install_cmds": [],
        "version": "0.2.0",
        "meta": {
            "versioned_by_patch_chain": True,
            "env_vars": {"INKLING_LOCAL_READY": "2", "INKLING_PATCHED": "yes"},
        },
    }
    outcome = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.ENVIRONMENT,
            payload=payload,
            base_version=await runtime.self_pipeline.chain.current_version(),
            rationale="e2e 环境补丁",
        ),
    )
    assert outcome.applied
    assert outcome.status == AUDIT_STATUS_APPLIED
    assert any(key == "patch:environment" for key in ctx.card_keys)  # L1 弹卡
    # 活跃态生效：域内声明已更新（补丁链为权威，重启经链恢复）
    assert env_domain.spec("inkling.local").version == "0.2.0"
    handle = env_domain.handle("inkling.local")
    assert handle is not None and handle.status == "ready"

    # 回退（链尾）：声明还原 + 审计留痕
    reverted = await runtime.self_pipeline.revert(
        ctx, outcome.patch_id, reason="e2e 环境补丁回退"
    )
    assert reverted.status == AUDIT_STATUS_REVERTED
    assert env_domain.spec("inkling.local").version == "0.1.0"  # 声明回退生效
    audit = await runtime.self_pipeline.audit_log()
    assert any(record.get("status") == AUDIT_STATUS_REVERTED for record in audit)


async def test_environment_patch_declares_new_env(booted, approval_ctx, tmp_path):
    """ENVIRONMENT 补丁声明新环境：域内注册 + 可 ensure（数据长出环境）。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    env_domain = host.environments

    new_env = {
        "name": "inkling.sandbox",
        "runtime": "local",
        "tools": [],
        "install_cmds": [],
        "version": "0.1.0",
        "meta": {
            "versioned_by_patch_chain": True,
            "purpose": "e2e 补丁长出的沙箱环境",
            "env_vars": {"INKLING_SANDBOX": "1"},
        },
    }
    outcome = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.ENVIRONMENT,
            payload=new_env,
            base_version=await runtime.self_pipeline.chain.current_version(),
            rationale="e2e 新环境声明",
        ),
    )
    assert outcome.applied
    assert "inkling.sandbox" in env_domain.names()
    handle = await env_domain.ensure("inkling.sandbox")
    assert handle.status == "ready"
    await env_domain.destroy("inkling.sandbox")
    # 链上声明保留（可重建）
    assembled = await runtime.self_pipeline.chain.assemble()
    assert "inkling.sandbox" in (assembled.get("environments") or {})

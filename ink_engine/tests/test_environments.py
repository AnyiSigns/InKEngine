"""环境管理单测：声明序列化 + 本地提供器生命周期 + 注册表。

覆盖：EnvironmentSpec 序列化往返与非法声明拒绝、LocalProvider
（工具可用就绪/缺失无安装失败/白名单安装/非白名单命令拒绝/运行
透传沙箱）、WebBridge 恒就绪与运行拒绝、Container 占位拒绝、
提供器注册表取用与覆盖。
"""
from __future__ import annotations

import os

import pytest

from ink_engine.core.environments import (
    ENV_STATUS_DESTROYED,
    ENV_STATUS_FAILED,
    ENV_STATUS_READY,
    ContainerProvider,
    EnvironmentProviders,
    EnvironmentSpec,
    LocalProvider,
    RuntimeKind,
    WebBridgeProvider,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.sandbox import ProcessSandbox

# 测试沙箱注入宿主 PATH：裸命令（python）须显式 PATH 才可解析
_TEST_PATH = os.environ.get("PATH")


def test_spec_roundtrip() -> None:
    spec = EnvironmentSpec(
        name="node_env",
        runtime=RuntimeKind.LOCAL,
        tools=("node", "npm"),
        install_cmds=("npm install -g pkg",),
        version="20",
        meta={"source": "boot"},
    )
    restored = EnvironmentSpec.from_dict(spec.to_dict())
    assert restored == spec
    assert restored.runtime is RuntimeKind.LOCAL


def test_spec_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 name"):
        EnvironmentSpec.from_dict({"runtime": "local"})
    with pytest.raises(GraphDefinitionError, match="runtime 非法"):
        EnvironmentSpec.from_dict({"name": "e", "runtime": "k8s"})
    with pytest.raises(GraphDefinitionError, match="tools"):
        EnvironmentSpec(name="e", tools=("",))


async def test_local_ensure_ready(tmp_path) -> None:
    sandbox = ProcessSandbox(allowlist=("python",), path=_TEST_PATH)
    provider = LocalProvider(sandbox, envs_dir=tmp_path / "envs")
    spec = EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",))
    handle = await provider.ensure(spec)
    assert handle.status == ENV_STATUS_READY
    assert "envs" in handle.workdir
    # ensure 幂等：同一实例
    again = await provider.ensure(spec)
    assert again is handle


async def test_local_ensure_missing_no_install_fails(tmp_path) -> None:
    provider = LocalProvider(ProcessSandbox(), envs_dir=tmp_path / "envs")
    spec = EnvironmentSpec(
        name="ghost", runtime=RuntimeKind.LOCAL, tools=("definitely_not_a_real_tool_xyz",)
    )
    handle = await provider.ensure(spec)
    assert handle.status == ENV_STATUS_FAILED
    assert "缺失" in (handle.error or "")


async def test_local_install_outside_allowlist_rejected(tmp_path) -> None:
    sandbox = ProcessSandbox(allowlist=())
    provider = LocalProvider(sandbox, envs_dir=tmp_path / "envs")
    spec = EnvironmentSpec(
        name="x",
        runtime=RuntimeKind.LOCAL,
        tools=("definitely_not_a_real_tool_xyz",),
        install_cmds=("curl http://evil",),
    )
    with pytest.raises(GraphDefinitionError, match="不在白名单"):
        await provider.ensure(spec)


async def test_local_run_passthrough_sandbox(tmp_path) -> None:
    sandbox = ProcessSandbox(allowlist=("python",), timeout=5.0, path=_TEST_PATH)
    provider = LocalProvider(sandbox, envs_dir=tmp_path / "envs")
    handle = await provider.ensure(
        EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",))
    )
    result = await provider.run(handle, "python", ("-c", "print('hi')"))
    assert result.exit_code == 0
    assert "hi" in result.stdout


async def test_local_destroy_idempotent(tmp_path) -> None:
    provider = LocalProvider(ProcessSandbox(), envs_dir=tmp_path / "envs")
    handle = await provider.ensure(
        EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",))
    )
    await provider.destroy(handle)
    assert handle.status == ENV_STATUS_DESTROYED


async def test_local_spec_change_rebuilds_instance(tmp_path) -> None:
    # 环境声明变更（含版本约束变化）= 旧实例销毁重建（版本回退由
    # 声明回退驱动，实例跟随重建）
    provider = LocalProvider(ProcessSandbox(), envs_dir=tmp_path / "envs")
    v1 = EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",), version="20")
    v2 = EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",), version="21")
    first = await provider.ensure(v1)
    assert first.status == ENV_STATUS_READY
    rebuilt = await provider.ensure(v2)
    assert rebuilt is not first
    assert rebuilt.status == ENV_STATUS_READY
    assert rebuilt.spec.version == "21"
    assert first.status == ENV_STATUS_DESTROYED


async def test_local_run_limited_to_env_workdir(tmp_path) -> None:
    # 运行命令工作目录限定在 envs/<name>（沙箱副本 cwd 注入）
    sandbox = ProcessSandbox(allowlist=("python",), timeout=5.0, path=_TEST_PATH)
    provider = LocalProvider(sandbox, envs_dir=tmp_path / "envs")
    handle = await provider.ensure(
        EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",))
    )
    result = await provider.run(
        handle, "python", ("-c", "import os; print(os.getcwd())")
    )
    assert result.exit_code == 0
    assert "envs" in result.stdout


async def test_local_actions_audited_when_storage_injected(tmp_path) -> None:
    # 注入 storage 时安装/运行动作落审计（append-only 留痕）
    from ink_engine.core.storage import create_storage

    storage = create_storage("memory://")
    sandbox = ProcessSandbox(allowlist=("python",), timeout=5.0, path=_TEST_PATH)
    provider = LocalProvider(sandbox, envs_dir=tmp_path / "envs", storage=storage)
    handle = await provider.ensure(
        EnvironmentSpec(name="py", runtime=RuntimeKind.LOCAL, tools=("python",))
    )
    await provider.run(handle, "python", ("-c", "print('x')"))
    records = await storage.list_records("env_audit")
    assert records
    assert any(r["action"] == "run" and r["env"] == "py" and r["ok"] is True for r in records)


async def test_web_bridge_provider() -> None:
    provider = WebBridgeProvider()
    handle = await provider.ensure(
        EnvironmentSpec(name="web", runtime=RuntimeKind.WEB_BRIDGE)
    )
    assert handle.status == ENV_STATUS_READY
    with pytest.raises(GraphDefinitionError, match="不支持后端子进程"):
        await provider.run(handle, "node", ())


async def test_container_provider_pending() -> None:
    provider = ContainerProvider()
    with pytest.raises(GraphDefinitionError, match="未落地"):
        await provider.ensure(EnvironmentSpec(name="c", runtime=RuntimeKind.CONTAINER))


async def test_provider_registry(tmp_path) -> None:
    registry = EnvironmentProviders(envs_dir=tmp_path / "envs")
    assert "local" in registry.names()
    assert "web_bridge" in registry.names()
    assert "container" in registry.names()
    assert registry.get("local").name == "local"
    with pytest.raises(GraphDefinitionError, match="未注册"):
        registry.get("phantom")


async def test_install_cmds_structured_form():
    """ENG6-11 回归：install_cmds 结构化 (cmd, args) 形态——不再按空格拆分。

    带引号参数（含空格路径）经 shlex 兼容形态与结构化形态均可正确解析；
    结构化形态拒绝缺失 cmd / 非法 args。
    """
    from ink_engine.core.exceptions import GraphDefinitionError

    spec = EnvironmentSpec(
        name="node_env",
        runtime=RuntimeKind.LOCAL,
        tools=("node",),
        install_cmds=(
            "npm install -g typescript",
            {"cmd": "pip", "args": ["install", "-r", "requirements.txt"]},
        ),
    )
    assert spec.to_dict()["install_cmds"] == [
        "npm install -g typescript",
        {"cmd": "pip", "args": ["install", "-r", "requirements.txt"]},
    ]
    restored = EnvironmentSpec.from_dict(spec.to_dict())
    assert restored.install_cmds == spec.install_cmds
    with pytest.raises(GraphDefinitionError, match="cmd"):
        EnvironmentSpec(name="e", install_cmds=({"args": ["x"]},))
    with pytest.raises(GraphDefinitionError, match="args"):
        EnvironmentSpec(name="e", install_cmds=({"cmd": "npm", "args": [1]},))


def test_install_cmds_quoted_args_not_split():
    """ENG6-11 回归：带空格引号参数不按空格裂开（shlex 兼容形态）。"""
    from ink_engine.core.environments import _parse_install_cmd

    command, args = _parse_install_cmd('npm install --prefix "C:/Program Files/node"')
    assert command == "npm"
    assert args == ("install", "--prefix", "C:/Program Files/node")
    # 结构化形态直取 (cmd, args)
    command2, args2 = _parse_install_cmd({"cmd": "pip", "args": ["install", "x"]})
    assert (command2, args2) == ("pip", ("install", "x"))


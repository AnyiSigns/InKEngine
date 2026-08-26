"""E-P13 容器提供器接线测试：容器环境声明 → 容器运行时执行 + 结构化降级。

覆盖（docker_probe 注入形态，免真实 Docker；与 Rust 权威实现 env.rs
的 DockerProbe 测试同构）：
- 缺依赖 fail-fast：Docker 客户端缺失 → ContainerUnavailable；守护进程
  不可达 → ContainerUnavailable（探测结果缓存，不重复探测）；
- ensure 三态：镜像已存在复用 / build_context 构建 / 两者皆缺显式失败；
- run：docker run 命令 argv 组装与结果透传；未就绪 = 结构化失败；
- destroy 幂等（容器移除、镜像保留）；
- 域装配：EnvironmentDomain 三提供器注册 + 容器声明经域 ensure 的
  结构化降级（ENV_004 语义：失败态句柄而非击穿）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_HOST_PY = _REPO_ROOT / "inkling/shell/src-tauri/src/engine/py"
if str(_HOST_PY) not in sys.path:
    sys.path.insert(0, str(_HOST_PY))

from inkling_host.environment_domain import (  # noqa: E402
    ContainerUnavailable,
    EnvironmentDomain,
    SeedContainerProvider,
    docker_available,
)

from ink_engine.core.environments import (  # noqa: E402
    ENV_STATUS_DESTROYED,
    ENV_STATUS_FAILED,
    ENV_STATUS_READY,
    EnvironmentSpec,
    RuntimeKind,
)
from ink_engine.core.exceptions import GraphDefinitionError  # noqa: E402
from ink_engine.core.sandbox import ProcessResult  # noqa: E402

CONTAINER_SPEC = EnvironmentSpec(
    name="inkling.container",
    runtime=RuntimeKind.CONTAINER,
    meta={"image": {"name": "inkling/base:0.1.0", "build_context": None}},
)


class FakeDocker:
    """假 docker 探针：按子命令应答（version/image/build/run/rm），记录 argv。"""

    def __init__(
        self,
        *,
        version_ok: bool = True,
        image_exists: bool = True,
        build_ok: bool = True,
        run_exit: int = 0,
        run_stdout: str = "done",
    ) -> None:
        self.version_ok = version_ok
        self.image_exists = image_exists
        self.build_ok = build_ok
        self.run_exit = run_exit
        self.run_stdout = run_stdout
        self.calls: list[list[str]] = []

    async def __call__(self, argv: list[str], timeout: float) -> ProcessResult:
        self.calls.append(list(argv))
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "version":
            if not self.version_ok:
                return ProcessResult(exit_code=125, stdout="", stderr="cannot connect")
            return ProcessResult(exit_code=0, stdout="24.0.0\n", stderr="")
        if sub == "image":
            if not self.image_exists:
                return ProcessResult(exit_code=1, stdout="", stderr="No such image")
            return ProcessResult(exit_code=0, stdout="[]", stderr="")
        if sub == "build":
            if not self.build_ok:
                return ProcessResult(exit_code=1, stdout="", stderr="build failed")
            return ProcessResult(exit_code=0, stdout="", stderr="")
        if sub == "run":
            return ProcessResult(exit_code=self.run_exit, stdout=self.run_stdout, stderr="")
        if sub == "rm":
            return ProcessResult(exit_code=0, stdout="", stderr="")
        return ProcessResult(exit_code=1, stdout="", stderr=f"unknown: {argv!r}")


class TestContainerStructuredDegrade:
    async def test_daemon_down_raises_and_caches(self):
        probe = FakeDocker(version_ok=False)
        provider = SeedContainerProvider(docker_probe=probe)
        with pytest.raises(ContainerUnavailable, match="守护进程"):
            await provider.ensure(CONTAINER_SPEC)
        # 探测结果缓存：第二次 ensure 不再重复探测
        with pytest.raises(ContainerUnavailable, match="守护进程"):
            await provider.ensure(CONTAINER_SPEC)
        assert len(probe.calls) == 1

    async def test_docker_client_missing_fails_fast(self, monkeypatch):
        monkeypatch.setattr(
            "inkling_host.environment_domain.shutil.which", lambda _name: None
        )
        provider = SeedContainerProvider()
        with pytest.raises(ContainerUnavailable, match="客户端未安装"):
            await provider.ensure(CONTAINER_SPEC)
        with pytest.raises(ContainerUnavailable, match="客户端未安装"):
            await provider.run(
                SeedContainerProvider._make_handle(provider, CONTAINER_SPEC),
                "python",
                (),
            )

    async def test_docker_available_probe(self, monkeypatch):
        monkeypatch.setattr(
            "inkling_host.environment_domain.shutil.which", lambda _name: None
        )
        assert docker_available() is False


class TestContainerEnsure:
    async def test_image_exists_reuses(self):
        probe = FakeDocker(image_exists=True)
        provider = SeedContainerProvider(docker_probe=probe)
        handle = await provider.ensure(CONTAINER_SPEC)
        assert handle.status == ENV_STATUS_READY
        # version 探测 + image inspect 两次调用
        assert [c[1] for c in probe.calls] == ["version", "image"]

    async def test_build_context_builds(self):
        probe = FakeDocker(image_exists=False, build_ok=True)
        provider = SeedContainerProvider(docker_probe=probe)
        spec = EnvironmentSpec(
            name="inkling.deploy",
            runtime=RuntimeKind.CONTAINER,
            meta={
                "image": {
                    "name": "inkling/deploy:0.1.0",
                    "build_context": "/tmp/ctx",
                }
            },
        )
        handle = await provider.ensure(spec)
        assert handle.status == ENV_STATUS_READY
        build_call = probe.calls[-1]
        assert build_call[1] == "build"
        assert build_call[2:5] == ["-t", "inkling/deploy:0.1.0", "/tmp/ctx"]

    async def test_build_failure_failed_handle(self):
        probe = FakeDocker(image_exists=False, build_ok=False)
        provider = SeedContainerProvider(docker_probe=probe)
        spec = EnvironmentSpec(
            name="inkling.deploy",
            runtime=RuntimeKind.CONTAINER,
            meta={"image": {"name": "inkling/deploy:0.1.0", "build_context": "/tmp/ctx"}},
        )
        handle = await provider.ensure(spec)
        assert handle.status == ENV_STATUS_FAILED
        assert "构建失败" in (handle.error or "")

    async def test_no_image_no_context_fails_explicit(self):
        probe = FakeDocker(image_exists=False)
        provider = SeedContainerProvider(docker_probe=probe)
        handle = await provider.ensure(CONTAINER_SPEC)
        assert handle.status == ENV_STATUS_FAILED
        assert "build_context" in (handle.error or "")

    async def test_missing_image_name_fails_explicit(self):
        probe = FakeDocker()
        provider = SeedContainerProvider(docker_probe=probe)
        bad = EnvironmentSpec(name="c", runtime=RuntimeKind.CONTAINER)
        handle = await provider.ensure(bad)
        assert handle.status == ENV_STATUS_FAILED
        assert "meta.image.name" in (handle.error or "")

    async def test_wrong_runtime_rejected(self):
        provider = SeedContainerProvider(docker_probe=FakeDocker())
        local = EnvironmentSpec(name="local", runtime=RuntimeKind.LOCAL)
        with pytest.raises(GraphDefinitionError, match="不承接"):
            await provider.ensure(local)


class TestContainerRunDestroy:
    async def test_run_composes_docker_run_argv(self):
        probe = FakeDocker()
        provider = SeedContainerProvider(docker_probe=probe)
        handle = await provider.ensure(CONTAINER_SPEC)
        result = await provider.run(handle, "python", ("-c", "print(1)"))
        assert result.exit_code == 0
        assert result.stdout == "done"
        run_call = probe.calls[-1]
        assert run_call[1] == "run"
        assert run_call[2:4] == ["--rm", "--name"]
        assert run_call[4].startswith("inkling-inkling.container-")
        assert run_call[5] == "inkling/base:0.1.0"
        assert run_call[6:] == ["python", "-c", "print(1)"]

    async def test_run_not_ready_fails_structured(self):
        probe = FakeDocker()
        provider = SeedContainerProvider(docker_probe=probe)
        handle = provider._make_handle(CONTAINER_SPEC, status=ENV_STATUS_FAILED)
        result = await provider.run(handle, "python", ())
        assert result.exit_code == -1
        assert "未就绪" in result.stderr
        assert probe.calls == [], "未就绪不得触达 docker"

    async def test_run_after_ready_uses_cached_daemon_probe(self):
        # 探测结果缓存：ensure 后守护进程不可达（探针切换），run 不重复
        # 探测（缓存 ok），docker run 结果原样结构化返回（不假装可用）
        probe = FakeDocker(image_exists=True)
        provider = SeedContainerProvider(docker_probe=probe)
        handle = await provider.ensure(CONTAINER_SPEC)
        assert handle.status == ENV_STATUS_READY
        assert await provider.run(handle, "python", ()) is not None
        version_calls = [c for c in probe.calls if c[1] == "version"]
        assert len(version_calls) == 1, "守护进程探测结果应缓存"
        probe.version_ok = False
        probe.run_exit = 125
        result = await provider.run(handle, "python", ())
        assert result.exit_code == 125, "缓存直过探测，docker run 结果结构化透传"
        assert len([c for c in probe.calls if c[1] == "version"]) == 1

    async def test_destroy_idempotent(self):
        probe = FakeDocker()
        provider = SeedContainerProvider(docker_probe=probe)
        handle = await provider.ensure(CONTAINER_SPEC)
        await provider.run(handle, "python", ())
        await provider.destroy(handle)
        await provider.destroy(handle)  # 幂等
        assert handle.status == ENV_STATUS_DESTROYED
        rm_calls = [c for c in probe.calls if c[1] == "rm"]
        assert len(rm_calls) == 1


class TestEnvironmentDomainAssembly:
    def _domain(self, probe=None, data=None) -> EnvironmentDomain:
        env_data = data or {
            "environments": [
                {"name": "inkling.local", "runtime": "local"},
                {"name": "inkling.web_bridge", "runtime": "web_bridge"},
                CONTAINER_SPEC.to_dict(),
            ]
        }
        return EnvironmentDomain(env_data, container_probe=probe)

    def test_three_providers_registered(self):
        domain = self._domain()
        assert set(domain.provider_names()) == {"local", "web_bridge", "container"}
        assert domain.names() == (
            "inkling.local",
            "inkling.web_bridge",
            "inkling.container",
        )

    async def test_domain_container_ensure_via_probe(self):
        domain = self._domain(probe=FakeDocker(image_exists=True))
        handle = await domain.ensure("inkling.container")
        assert handle.status == ENV_STATUS_READY
        assert domain.handle("inkling.container") is handle

    async def test_domain_container_structured_degrade(self, monkeypatch):
        # Docker 客户端缺失：域 ensure 不击穿，失败态句柄（ENV_004 语义）
        monkeypatch.setattr(
            "inkling_host.environment_domain.shutil.which", lambda _name: None
        )
        domain = self._domain()
        handle = await domain.ensure("inkling.container")
        assert handle.status == ENV_STATUS_FAILED
        assert "容器形态不可用" in (handle.error or "")
        # run 未就绪 = 结构化失败，不击穿
        result = await domain.run("inkling.container", "python", ())
        assert result.exit_code == -1
        assert "未就绪" in result.stderr

    async def test_domain_run_container_command(self):
        domain = self._domain(probe=FakeDocker(image_exists=True))
        await domain.ensure("inkling.container")
        result = await domain.run("inkling.container", "python", ("-c", "print('hi')"))
        assert result.exit_code == 0
        assert result.stdout == "done"

    async def test_domain_destroy_unknown_env_noop(self):
        domain = self._domain()
        await domain.destroy("inkling.container")  # 未 ensure 过 = no-op 不崩溃

    async def test_unknown_env_is_structured_error(self):
        domain = self._domain()
        with pytest.raises(GraphDefinitionError, match="环境未声明"):
            await domain.ensure("phantom")

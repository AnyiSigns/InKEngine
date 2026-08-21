"""环境装配域（PLAN §6 M3-2 环境装配）。

env.json → EnvironmentSpec → 三环境提供器注册表（local / web_bridge /
container）+ 域选择 + PatchKind.ENVIRONMENT 补丁链应用：

- **local**：引擎 LocalProvider 之上叠加环境变量声明（spec.meta.env_vars
  注入运行沙箱 env）——本地形态默认可用；
- **web_bridge**：浏览器桥形态（引擎 WebBridgeProvider：ensure 恒就绪、
  run 显式不支持），原样复用；
- **container**：出厂落地容器提供器（镜像描述 = 数据，补丁链版本化
  形态）——ensure 幂等（镜像已存在复用）/run（docker run 白名单命令）/
  destroy 幂等（容器移除，镜像保留可重建）；本机 Docker 客户端缺失或
  守护进程不可达 = 结构化降级（ContainerUnavailable，错误码 ENV_004），
  绝不静默假装可用（e2e 用显式 skipif 标记全链路用例）。

安全边界：环境运行/安装命令一律经 ProcessSandbox 白名单沙箱
（fail-closed）；环境动作落审计（append-only：什么环境跑过什么命令）。
环境变更走补丁链留痕（environment 补丁），回退 = 声明回退 + 实例重建。
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import os
import shutil
import time
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ink_engine.core.environments import (
    ENV_AUDIT_COLLECTION,
    ENV_STATUS_DESTROYED,
    ENV_STATUS_FAILED,
    ENV_STATUS_READY,
    EnvironmentHandle,
    EnvironmentProviders,
    EnvironmentSpec,
    LocalProvider,
    RuntimeKind,
    WebBridgeProvider,
)
from ink_engine.core.exceptions import GraphDefinitionError, SandboxViolation
from ink_engine.core.logging import get_logger
from ink_engine.core.sandbox import ProcessResult, ProcessSandbox
from ink_engine.core.self_application import ApplyTarget

logger = get_logger("host.environment")

# 容器动作缺省超时（docker 拉取/构建/运行统一护栏，秒）
_CONTAINER_TIMEOUT = 120.0


class ContainerUnavailable(GraphDefinitionError):
    """容器环境不可用（Docker 客户端缺失/守护进程不可达的结构化降级）。"""


def docker_available() -> bool:
    """Docker 可用性探测（客户端存在 + 守护进程可达；供 e2e skipif）。"""
    binary = shutil.which("docker")
    if binary is None:
        return False
    try:
        probe = __import__("subprocess").run(
            [binary, "version", "--format", "{{.Server.Version}}"],
            capture_output=True,
            timeout=10,
        )
        return probe.returncode == 0 and bool(probe.stdout.strip())
    except Exception:
        return False


class InkLocalProvider(LocalProvider):
    """本地环境提供器（引擎实现之上叠加环境变量声明应用）。

    引擎 LocalProvider 的 ensure/destroy 语义原样保留（幂等/声明变更
    销毁重建/白名单安装）；run 时把 spec.meta.env_vars 并入运行沙箱
    环境（环境变量声明 = 数据，随补丁链版本化/回退），并注入宿主
    PATH（引擎不替宿主决定平台默认值——PATH 由宿主提供，裸命令名
    才能解析）。
    """

    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult:
        if handle.status != ENV_STATUS_READY:
            return ProcessResult(
                exit_code=-1, stdout="", stderr=f"环境未就绪: {handle.status}"
            )
        workdir = Path(handle.workdir or ".")
        workdir.mkdir(parents=True, exist_ok=True)
        env_vars = (handle.spec.meta or {}).get("env_vars") or {}
        merged_env = None
        if isinstance(env_vars, dict) and env_vars:
            merged_env = dict(self._sandbox.env or {})
            merged_env.update({str(k): str(v) for k, v in env_vars.items()})
        run_sandbox = dataclasses.replace(
            self._sandbox,
            cwd=workdir,
            env=merged_env,
            path=self._sandbox.path or os.environ.get("PATH"),
        )
        result = await run_sandbox.run(command, args)
        await self._audit(
            action="run",
            env=handle.spec.name,
            command=f"{command} {' '.join(args)}".strip(),
            ok=result.exit_code == 0,
        )
        return result


class SeedContainerProvider:
    """容器环境提供器（出厂落地：镜像描述 = 数据，三动作幂等）。

    ensure：镜像已存在（docker image inspect）→ 复用；缺失且声明了
    构建上下文（meta.image.build_context + install_cmds 经沙箱产出
    Dockerfile 上下文）→ 构建；两者皆缺 → 显式失败。run：docker run
    执行白名单命令（输出/退出码/超时结构化返回）。destroy：停止并
    移除容器（幂等；镜像保留——镜像描述是数据，重建成本 = 数据驱动）。

    Docker 不可用（客户端缺失/守护进程不可达）= 结构化错误
    （ContainerUnavailable），所有动作 fail-closed 不假装可用。
    """

    name: str = "container"

    def __init__(self, *, storage: Any | None = None) -> None:
        self._storage = storage
        self._docker = shutil.which("docker")
        self._containers: dict[str, str] = {}
        # 守护进程可用性探测结果缓存（None = 未探测；False = 不可用，
        # 后续调用直接抛结构化错误，不重复探测）
        self._daemon_ok: bool | None = None

    async def _require_docker(self) -> None:
        """Docker 可用性门（客户端 + 守护进程探测，结果缓存）。"""
        if self._daemon_ok is False:
            raise ContainerUnavailable(
                "Docker 守护进程不可达（请确认 Docker Desktop 已启动）"
            )
        if self._daemon_ok is True:
            return
        if self._docker is None:
            raise ContainerUnavailable(
                "Docker 客户端未安装（容器形态不可用，local 为默认形态）"
            )
        try:
            probe = await _run_subprocess(
                [self._docker, "version", "--format", "{{.Server.Version}}"],
                timeout=10,
            )
        except Exception as exc:
            raise ContainerUnavailable(
                f"Docker 探测失败（守护进程不可达）: {exc}"
            ) from exc
        if probe.exit_code != 0 or not probe.stdout.strip():
            self._daemon_ok = False
            raise ContainerUnavailable(
                "Docker 守护进程不可达（请确认 Docker Desktop 已启动）"
            )
        self._daemon_ok = True

    async def ensure(self, spec: EnvironmentSpec) -> EnvironmentHandle:
        if spec.runtime is not RuntimeKind.CONTAINER:
            raise GraphDefinitionError(
                f"容器提供器不承接 {spec.runtime.value} 环境: {spec.name}"
            )
        await self._require_docker()
        image = (spec.meta or {}).get("image") or {}
        image_name = str(image.get("name") or "").strip()
        if not image_name:
            handle = self._make_handle(spec, status=ENV_STATUS_FAILED)
            handle.error = "容器环境声明缺 meta.image.name（镜像描述 = 数据）"
            return handle
        if await self._image_exists(image_name):
            return self._make_handle(spec)
        build_context = image.get("build_context")
        if isinstance(build_context, str) and build_context:
            result = await _run_subprocess(
                [
                    self._docker or "docker",
                    "build",
                    "-t",
                    image_name,
                    build_context,
                ],
                timeout=_CONTAINER_TIMEOUT,
            )
            if result.exit_code != 0:
                handle = self._make_handle(spec, status=ENV_STATUS_FAILED)
                handle.error = f"镜像构建失败: {result.stderr[:300]}"
                await self._audit("build", spec.name, "docker build", False, handle.error)
                return handle
            await self._audit("build", spec.name, "docker build", True)
            return self._make_handle(spec)
        handle = self._make_handle(spec, status=ENV_STATUS_FAILED)
        handle.error = f"镜像 {image_name} 不存在且未声明 build_context（可经补丁链演化）"
        return handle

    async def destroy(self, handle: EnvironmentHandle) -> None:
        """销毁（幂等）：移除运行中的容器；镜像保留（数据形态可重建）。"""
        handle.status = ENV_STATUS_DESTROYED
        container_id = self._containers.pop(handle.spec.name, None)
        if container_id is None or self._docker is None:
            return
        with contextlib.suppress(Exception):
            await _run_subprocess(
                [self._docker, "rm", "-f", container_id], timeout=30
            )

    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult:
        if handle.status != ENV_STATUS_READY:
            return ProcessResult(
                exit_code=-1, stdout="", stderr=f"环境未就绪: {handle.status}"
            )
        await self._require_docker()
        image = (handle.spec.meta or {}).get("image") or {}
        image_name = str(image.get("name") or "").strip()
        container_name = f"inkling-{handle.spec.name}-{uuid.uuid4().hex[:8]}"
        result = await _run_subprocess(
            [
                self._docker or "docker",
                "run",
                "--rm",
                "--name",
                container_name,
                image_name,
                command,
                *args,
            ],
            timeout=_CONTAINER_TIMEOUT,
        )
        self._containers[handle.spec.name] = container_name
        await self._audit(
            "run",
            handle.spec.name,
            f"{command} {' '.join(args)}".strip(),
            result.exit_code == 0,
        )
        return result

    def _make_handle(
        self, spec: EnvironmentSpec, *, status: str = ENV_STATUS_READY
    ) -> EnvironmentHandle:
        return EnvironmentHandle(env_id=spec.name, spec=spec, status=status)

    async def _image_exists(self, image_name: str) -> bool:
        if self._docker is None:
            return False
        result = await _run_subprocess(
            [self._docker, "image", "inspect", image_name], timeout=30
        )
        return result.exit_code == 0

    async def _audit(
        self, action: str, env: str, command: str, ok: bool, detail: str = ""
    ) -> None:
        """环境动作留痕（append-only；审计失败不阻断环境动作）。"""
        if self._storage is None:
            return
        record: dict[str, Any] = {
            "action": action,
            "env": env,
            "command": command[:500],
            "ok": ok,
            "ts": time.time(),
        }
        if detail:
            record["detail"] = detail[:500]
        with contextlib.suppress(Exception):
            await self._storage.put_record(
                ENV_AUDIT_COLLECTION,
                f"{record['ts']:.3f}-{uuid.uuid4().hex[:8]}",
                record,
            )


async def _run_subprocess(
    argv: list[str], *, timeout: float
) -> ProcessResult:
    """子进程执行（超时 kill + 输出截断；容器动作的通用执行通道）。

    启动失败（二进制缺失等）= 结构化结果而非裸异常（降级路径不崩溃）。
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
        return ProcessResult(
            exit_code=proc.returncode or 0,
            stdout=_decode(stdout),
            stderr=_decode(stderr),
        )
    except TimeoutError:
        return ProcessResult(
            exit_code=-1,
            stdout="",
            stderr="容器动作超时（已 kill）",
            timed_out=True,
        )
    except Exception as exc:
        return ProcessResult(
            exit_code=-1,
            stdout="",
            stderr=f"容器动作启动失败: {exc}",
        )


def _decode(data: bytes) -> str:
    text = data.decode(errors="replace")
    return text[:4000] + ("\n…（已截断）" if len(text) > 4000 else "")


class EnvironmentDomain:
    """环境装配域（env.json 装载 + 提供器注册表 + 域选择 + 补丁应用）。

    装配：三形态提供器注册（local 换成本域实现叠加环境变量；container
    换成出厂实现；web_bridge 原样复用）；按环境名选择提供器 ensure/
    run/destroy。环境动作落审计（storage 注入时）。补丁链应用目标 =
    声明 → ensure（幂等），回退由补丁链驱动（声明回退 + 实例重建）。
    """

    def __init__(
        self,
        env_data: dict[str, Any],
        *,
        envs_dir: str | Path = "envs",
        storage: Any | None = None,
        run_allowlist: Sequence[str] = (),
    ) -> None:
        # 基线声明（env.json）：链回退/恢复时回落基准（链只承载补丁增量）
        self._baseline: dict[str, EnvironmentSpec] = {
            spec.name: spec
            for spec in (
                EnvironmentSpec.from_dict(env)
                for env in env_data.get("environments") or ()
            )
        }
        self.specs: dict[str, EnvironmentSpec] = dict(self._baseline)
        self._storage = storage
        sandbox = ProcessSandbox(allowlist=tuple(run_allowlist))
        self.providers = EnvironmentProviders(envs_dir=envs_dir)
        self.providers.register(
            InkLocalProvider(
                sandbox=sandbox, envs_dir=envs_dir, storage=storage
            )
        )
        self.providers.register(SeedContainerProvider(storage=storage))
        # web_bridge：引擎默认提供器（恒就绪；run 显式不支持），保持注册
        self.providers.register(WebBridgeProvider())
        self._handles: dict[str, EnvironmentHandle] = {}

    def names(self) -> tuple[str, ...]:
        """已声明环境名（设置页「环境管理」数据源）。"""
        return tuple(self.specs)

    def provider_names(self) -> tuple[str, ...]:
        return self.providers.names()

    def spec(self, name: str) -> EnvironmentSpec | None:
        return self.specs.get(name)

    async def ensure(self, name: str) -> EnvironmentHandle:
        """按名选择环境并确保就绪（域选择入口；结构化降级不崩溃）。"""
        spec = self.specs.get(name)
        if spec is None:
            raise GraphDefinitionError(f"环境未声明: {name}")
        return await self.ensure_spec(spec)

    async def ensure_spec(self, spec: EnvironmentSpec) -> EnvironmentHandle:
        """声明 → 提供器 ensure（失败 = 状态化句柄，不击穿调用方）。"""
        provider = self.providers.get(spec.runtime.value)
        try:
            handle = await provider.ensure(spec)
        except ContainerUnavailable as exc:
            handle = EnvironmentHandle(
                env_id=spec.name,
                spec=spec,
                status=ENV_STATUS_FAILED,
                error=f"容器形态不可用: {exc}",
            )
            logger.warning(
                "environment degraded env=%s code=ENV_004 detail=%s", spec.name, exc
            )
        except GraphDefinitionError as exc:
            handle = EnvironmentHandle(
                env_id=spec.name,
                spec=spec,
                status=ENV_STATUS_FAILED,
                error=str(exc),
            )
        self._handles[spec.name] = handle
        return handle

    def handle(self, name: str) -> EnvironmentHandle | None:
        return self._handles.get(name)

    async def run(self, name: str, command: str, args: Sequence[str] = ()) -> ProcessResult:
        """在已就绪环境中运行白名单命令（未就绪/越权 = 结构化失败）。

        沙箱拒绝（白名单外命令）与形态不支持（web_bridge 后端子进程）
        一律落为结构化 ProcessResult，不裸抛击穿调用方。
        """
        handle = self._handles.get(name)
        if handle is None or handle.status != ENV_STATUS_READY:
            return ProcessResult(
                exit_code=-1,
                stdout="",
                stderr=f"环境未就绪: {name}（请先 ensure）",
            )
        provider = self.providers.get(handle.spec.runtime.value)
        try:
            return await provider.run(handle, command, args)
        except SandboxViolation as exc:
            return ProcessResult(
                exit_code=-1, stdout="", stderr=f"沙箱拒绝: {exc}"
            )
        except GraphDefinitionError as exc:
            return ProcessResult(
                exit_code=-1, stdout="", stderr=str(exc)
            )

    async def destroy(self, name: str) -> None:
        """销毁环境实例（幂等；声明保留可重建）。"""
        handle = self._handles.pop(name, None)
        if handle is None:
            return
        provider = self.providers.get(handle.spec.runtime.value)
        with contextlib.suppress(Exception):
            await provider.destroy(handle)

    async def restore(self, patch_values: dict[str, Any]) -> None:
        """从集补丁链组装的环境段恢复活跃态（重启/回退后声明生效）。

        声明全景 = 基线（env.json）叠加链补丁增量（链为权威，链值覆盖
        基线）；回退 = 补丁撤销 → 回落基线声明 + 实例重建（ensure 的
        声明变更销毁重建语义覆盖）。
        """
        merged = dict(self._baseline)
        for name, raw in (patch_values or {}).items():
            if not isinstance(raw, dict):
                continue
            with contextlib.suppress(Exception):
                merged[name] = EnvironmentSpec.from_dict(raw)
        self.specs = merged
        for name in merged:
            with contextlib.suppress(Exception):
                await self.ensure_spec(merged[name])


class EnvironmentApplyTarget(ApplyTarget):
    """ENVIRONMENT 补丁落链后的活跃态生效：声明 → ensure（幂等）。

    补丁链是权威记录，本钩子只做当前进程的活跃态同步（声明变更 =
    旧实例销毁重建由提供器 ensure 语义覆盖；重启经链组装恢复）。
    """

    name = "inkling.environment"

    def __init__(self, domain: EnvironmentDomain) -> None:
        self._domain = domain

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = EnvironmentSpec.from_dict(payload)
        self._domain.specs[spec.name] = spec
        await self._domain.ensure_spec(spec)


__all__ = [
    "ContainerUnavailable",
    "EnvironmentApplyTarget",
    "EnvironmentDomain",
    "InkLocalProvider",
    "SeedContainerProvider",
    "docker_available",
]

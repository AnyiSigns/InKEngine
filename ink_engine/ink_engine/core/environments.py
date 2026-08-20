"""环境管理：环境是数据，提供器是机制。

AI 生成/挂载的工具需要运行时（Node/Rust/DB/浏览器等），boot 只带
Python 宿主，其余按需懒装。环境声明（EnvironmentSpec）是数据（随
补丁链版本化/回退），提供器是机制（本地运行时/浏览器形态/容器）。

- local_provider（默认）：白名单安装命令经 ProcessSandbox 执行
  （本机运行时，Windows 桌面无 Docker 的硬约束下的默认形态）；
- web_bridge_provider：浏览器端形态（iframe 桥），无需后端环境；
- container_provider：容器形态（服务化演进后置——桌面无 Docker
  不阻塞，此处占位按需扩展）。

安全边界：安装命令/运行命令一律经白名单沙箱（fail-closed：未在
白名单的命令显式拒绝）；环境实例（envs/ 目录）可销毁重建；环境
变更走补丁链留痕（environment 补丁类型），回退 = 环境声明回退 +
实例重建。
"""
from __future__ import annotations

import contextlib
import shutil
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError
from .logging import get_logger
from .sandbox import ProcessResult, ProcessSandbox

logger = get_logger(__name__)

# 环境状态（声明式枚举，防魔法字符串）
ENV_STATUS_READY = "ready"
ENV_STATUS_INSTALLING = "installing"
ENV_STATUS_FAILED = "failed"
ENV_STATUS_DESTROYED = "destroyed"

# 环境实例根目录（集数据目录内 envs/，可销毁重建）
DEFAULT_ENVS_DIR = "envs"

# 环境运行/安装审计集合（append-only 留痕：什么环境跑过什么命令）
ENV_AUDIT_COLLECTION = "env_audit"


class RuntimeKind(StrEnum):
    """运行时类别（声明式枚举：本地/浏览器/容器）。"""

    LOCAL = "local"
    WEB_BRIDGE = "web_bridge"
    CONTAINER = "container"


@dataclass(frozen=True, slots=True)
class EnvironmentSpec:
    """环境声明（纯数据：运行时清单 = 数据，随补丁链版本化）。

    Attributes:
        name: 环境名（集内唯一）。
        runtime: 运行时类别（local/web_bridge/container）。
        tools: 需要的工具命令清单（本地运行时可用性判定/白名单安装）。
        install_cmds: 安装命令白名单（缺失工具时的懒装命令；命令
            本身须在白名单内才能执行——安装也走沙箱）。
        version: 运行时版本约束（None = 不限定）。
        meta: 扩展元数据（来源/说明等，宿主语义）。
    """

    name: str
    runtime: RuntimeKind = RuntimeKind.LOCAL
    tools: tuple[str, ...] = ()
    install_cmds: tuple[str, ...] = ()
    version: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.name:
            raise GraphDefinitionError("环境声明缺 name")
        if self.runtime not in RuntimeKind:
            raise GraphDefinitionError(
                f"环境 {self.name} 的 runtime 非法: {self.runtime!r}"
            )
        for tool in self.tools:
            if not isinstance(tool, str) or not tool:
                raise GraphDefinitionError(
                    f"环境 {self.name} 的 tools 须为非空命令字符串清单"
                )
        for cmd in self.install_cmds:
            if not isinstance(cmd, str) or not cmd:
                raise GraphDefinitionError(
                    f"环境 {self.name} 的 install_cmds 须为非空命令字符串清单"
                )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": self.name,
            "runtime": self.runtime.value,
        }
        if self.tools:
            data["tools"] = list(self.tools)
        if self.install_cmds:
            data["install_cmds"] = list(self.install_cmds)
        if self.version:
            data["version"] = self.version
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> EnvironmentSpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"环境声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("环境声明缺 name（字符串）")
        try:
            runtime = RuntimeKind(data.get("runtime", RuntimeKind.LOCAL.value))
        except ValueError as exc:
            raise GraphDefinitionError(
                f"环境 {name} 的 runtime 非法: {data.get('runtime')!r}"
            ) from exc
        tools = data.get("tools") or ()
        install_cmds = data.get("install_cmds") or ()
        for label, items in (("tools", tools), ("install_cmds", install_cmds)):
            if not isinstance(items, (list, tuple)) or not all(
                isinstance(item, str) and item for item in items
            ):
                raise GraphDefinitionError(
                    f"环境 {name} 的 {label} 须为非空命令字符串清单"
                )
        version = data.get("version")
        if version is not None and not isinstance(version, str):
            raise GraphDefinitionError(f"环境 {name} 的 version 须为字符串")
        meta = data.get("meta")
        if meta is not None and not isinstance(meta, dict):
            raise GraphDefinitionError(f"环境 {name} 的 meta 须为 dict")
        return cls(
            name=name,
            runtime=runtime,
            tools=tuple(tools),
            install_cmds=tuple(install_cmds),
            version=version,
            meta=dict(meta or {}),
        )


@dataclass(slots=True)
class EnvironmentHandle:
    """环境实例句柄（提供器 ensure 的产物，宿主持有用于运行/销毁）。"""

    env_id: str
    spec: EnvironmentSpec
    status: str = ENV_STATUS_READY
    workdir: str | None = None
    error: str | None = None


@runtime_checkable
class EnvironmentProvider(Protocol):
    """环境提供器接口（机制：按声明提供/销毁/运行环境）。

    实现要求：ensure 幂等（已就绪返回既有实例）；destroy 幂等
    （已销毁静默成功）；run 仅执行白名单命令（沙箱 fail-closed）。
    """

    name: str

    async def ensure(self, spec: EnvironmentSpec) -> EnvironmentHandle: ...
    async def destroy(self, handle: EnvironmentHandle) -> None: ...
    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult: ...


class LocalProvider:
    """本地运行时提供器（默认形态：白名单安装 + 沙箱运行）。

    就绪判定：spec.tools 全部可用（PATH 可寻）；缺工具且声明了
    安装命令 → 按 install_cmds 顺序经 ProcessSandbox 执行（命令
    须在白名单内，安装失败 = 实例标记 failed）；运行 = 白名单命令
    + 工作目录限定（envs/<name>）+ 超时/输出截断（ProcessSandbox
    现成）。环境声明变更（含版本约束变化）= 旧实例销毁重建——
    版本回退语义由声明回退（补丁链）驱动，实例跟随重建。注入
    storage 时安装/运行动作落审计（append-only 留痕：什么环境
    跑过什么命令）；未注入 = 跳过审计（审计是增强不是收紧）。
    """

    name: str = "local"

    def __init__(
        self,
        sandbox: ProcessSandbox | None = None,
        *,
        envs_dir: str | Path = DEFAULT_ENVS_DIR,
        storage: Any | None = None,
    ) -> None:
        self._sandbox = sandbox or ProcessSandbox(allowlist=())
        self._envs_dir = Path(envs_dir)
        self._storage = storage
        self._instances: dict[str, EnvironmentHandle] = {}

    async def ensure(self, spec: EnvironmentSpec) -> EnvironmentHandle:
        if spec.runtime is not RuntimeKind.LOCAL:
            raise GraphDefinitionError(
                f"本地提供器不承接 {spec.runtime.value} 环境: {spec.name}"
            )
        existing = self._instances.get(spec.name)
        if existing is not None and existing.status == ENV_STATUS_READY:
            if existing.spec == spec:
                return existing
            # 声明已变更（含版本约束）：旧实例按当前声明销毁重建——
            # 环境形态跟随声明（回退 = 声明回退 + 实例重建）
            await self.destroy(existing)
        missing = [tool for tool in spec.tools if shutil.which(tool) is None]
        if missing and spec.install_cmds:
            await self._install(spec)
        elif missing:
            handle = self._make_handle(spec, status=ENV_STATUS_FAILED)
            handle.error = f"工具缺失且未声明安装命令: {missing}"
            self._instances[spec.name] = handle
            return handle
        handle = self._make_handle(spec)
        self._instances[spec.name] = handle
        return handle

    async def destroy(self, handle: EnvironmentHandle) -> None:
        handle.status = ENV_STATUS_DESTROYED
        self._instances.pop(handle.spec.name, None)

    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult:
        if handle.status != ENV_STATUS_READY:
            return ProcessResult(
                exit_code=-1, stdout="", stderr=f"环境未就绪: {handle.status}"
            )
        workdir = Path(handle.workdir or ".")
        workdir.mkdir(parents=True, exist_ok=True)
        import dataclasses

        run_sandbox = dataclasses.replace(self._sandbox, cwd=workdir)
        result = await run_sandbox.run(command, args)
        await self._audit(
            action="run",
            env=handle.spec.name,
            command=f"{command} {' '.join(args)}".strip(),
            ok=result.exit_code == 0,
        )
        return result

    async def _install(self, spec: EnvironmentSpec) -> None:
        handle = self._make_handle(spec, status=ENV_STATUS_INSTALLING)
        self._instances[spec.name] = handle
        workdir = Path(handle.workdir or ".")
        workdir.mkdir(parents=True, exist_ok=True)
        import dataclasses

        install_sandbox = dataclasses.replace(self._sandbox, cwd=workdir)
        try:
            for cmd in spec.install_cmds:
                parts = cmd.split()
                if not parts or parts[0] not in self._sandbox.allowlist:
                    raise GraphDefinitionError(
                        f"安装命令不在白名单: {cmd!r}（fail-closed）"
                    )
                result = await install_sandbox.run(parts[0], tuple(parts[1:]))
                if result.exit_code != 0:
                    raise GraphDefinitionError(
                        f"安装失败 [{cmd!r}]: exit={result.exit_code} "
                        f"{result.stderr[:200]}"
                    )
        except Exception as exc:
            handle.status = ENV_STATUS_FAILED
            handle.error = str(exc)
            await self._audit(
                action="install",
                env=spec.name,
                command="; ".join(spec.install_cmds),
                ok=False,
                detail=str(exc)[:200],
            )
            raise
        handle.status = ENV_STATUS_READY
        await self._audit(
            action="install",
            env=spec.name,
            command="; ".join(spec.install_cmds),
            ok=True,
        )

    async def _audit(
        self, *, action: str, env: str, command: str, ok: bool, detail: str = ""
    ) -> None:
        """环境动作留痕（append-only 审计：什么环境跑过什么命令）。"""
        if self._storage is None:
            return
        import time
        import uuid

        record = {
            "action": action,
            "env": env,
            "command": command[:500],
            "ok": ok,
            "ts": time.time(),
        }
        if detail:
            record["detail"] = detail
        key = f"{record['ts']:.3f}-{uuid.uuid4().hex[:8]}"
        with contextlib.suppress(Exception):
            # 审计失败不阻断环境动作（审计是增强不是收紧）
            await self._storage.put_record(ENV_AUDIT_COLLECTION, key, record)

    def _make_handle(
        self, spec: EnvironmentSpec, *, status: str = ENV_STATUS_READY
    ) -> EnvironmentHandle:
        workdir = self._envs_dir / spec.name
        return EnvironmentHandle(
            env_id=spec.name,
            spec=spec,
            status=status,
            workdir=str(workdir),
        )


class WebBridgeProvider:
    """浏览器端形态提供器（iframe 桥，无需后端环境）。

    浏览器天然隔离（sandbox 属性 + postMessage 协议），无安装/运行
    概念——ensure 恒就绪；run 显式不支持（浏览器端执行体由前端
    桥承载，不经后端子进程）。
    """

    name: str = "web_bridge"

    async def ensure(self, spec: EnvironmentSpec) -> EnvironmentHandle:
        if spec.runtime is not RuntimeKind.WEB_BRIDGE:
            raise GraphDefinitionError(
                f"浏览器桥提供器不承接 {spec.runtime.value} 环境: {spec.name}"
            )
        return EnvironmentHandle(env_id=spec.name, spec=spec)

    async def destroy(self, handle: EnvironmentHandle) -> None:
        handle.status = ENV_STATUS_DESTROYED

    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult:
        raise GraphDefinitionError(
            f"浏览器桥环境不支持后端子进程运行: {handle.spec.name}"
        )


class ContainerProvider:
    """容器形态提供器（服务化演进后置的占位）。

    桌面无 Docker 不阻塞（local 为默认形态）；容器提供器在容器化
    演进时落地（镜像描述 = 数据，可销毁重建）。占位语义：ensure
    显式说明未落地，不静默假装可用。
    """

    name: str = "container"

    async def ensure(self, spec: EnvironmentSpec) -> EnvironmentHandle:
        raise GraphDefinitionError(
            f"容器提供器为服务化演进后置形态，当前未落地: {spec.name}"
        )

    async def destroy(self, handle: EnvironmentHandle) -> None:
        raise GraphDefinitionError("容器提供器未落地")

    async def run(
        self, handle: EnvironmentHandle, command: str, args: Sequence[str] = ()
    ) -> ProcessResult:
        raise GraphDefinitionError("容器提供器未落地")


class EnvironmentProviders:
    """环境提供器注册表（插拔 U 盘：新运行时 = 注册新提供器）。

    缺省装配：local（默认）/web_bridge/container 三形态；宿主可
    覆盖注册（同名覆盖 = 配置驱动）。取用未注册提供器显式报错
    （fail-closed，不静默回落）。
    """

    _DEFAULTS = (LocalProvider, WebBridgeProvider, ContainerProvider)

    def __init__(self, *, envs_dir: str | Path = DEFAULT_ENVS_DIR) -> None:
        self._providers: dict[str, EnvironmentProvider] = {}
        for factory in self._DEFAULTS:
            provider = factory(envs_dir=envs_dir) if factory is LocalProvider else factory()
            self._providers[provider.name] = provider

    def register(self, provider: EnvironmentProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str) -> EnvironmentProvider:
        provider = self._providers.get(name)
        if provider is None:
            raise GraphDefinitionError(f"环境提供器未注册: {name}")
        return provider

    def names(self) -> tuple[str, ...]:
        return tuple(self._providers)


__all__ = [
    "DEFAULT_ENVS_DIR",
    "ENV_STATUS_DESTROYED",
    "ENV_STATUS_FAILED",
    "ENV_STATUS_INSTALLING",
    "ENV_STATUS_READY",
    "ContainerProvider",
    "EnvironmentHandle",
    "EnvironmentProvider",
    "EnvironmentProviders",
    "EnvironmentSpec",
    "LocalProvider",
    "RuntimeKind",
    "WebBridgeProvider",
]

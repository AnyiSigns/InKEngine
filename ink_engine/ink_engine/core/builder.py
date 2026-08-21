"""构建管线：构建是机制，产物可回退。

AI 生成/挂载的代码（前端组件/任意语言工具/服务）需要编译构建：
本机构建为默认（npm/uv 等白名单命令经 ProcessSandbox 执行，超时/
隔离），容器构建为服务化演进后的可选路径。产物（bundle/二进制）
落补丁链管理——产物哈希命名、可回退、可审计；构建产物必须过冒烟
门禁（启动/连通/回归）才可 promote；构建失败 = 保留现状 + 留痕。

安全边界：构建命令一律经白名单沙箱（fail-closed：未在白名单的
命令显式拒绝）；产物目录哈希命名（artifact_id 内容寻址，防产物
篡改静默切换）；哈希校验 = 部署/回退前的强制门禁。
"""
from __future__ import annotations

import dataclasses
import hashlib
import shutil
import time
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from .exceptions import GraphDefinitionError
from .logging import get_logger
from .sandbox import ProcessSandbox

logger = get_logger(__name__)

# 产物哈希算法（sha256，hex 64 字符）
_ARTIFACT_HASH_ALGO = "sha256"
_ARTIFACT_HASH_LENGTH = 64


class BuildKind(StrEnum):
    """构建产物类别（声明式枚举：前端 bundle/后端包/任意服务）。"""

    JS_BUNDLE = "js_bundle"
    PYTHON_PACKAGE = "python_package"
    SERVICE = "service"


@dataclass(frozen=True, slots=True)
class BuildSpec:
    """构建声明（白名单命令 + 产物路径清单）。

    Attributes:
        kind: 构建产物类别。
        command: 构建命令（须在构建沙箱白名单内）。
        args: 命令参数。
        workdir: 构建工作目录（产物读取的相对基准）。
        env: 环境变量（透传沙箱 env 白名单）。
        timeout: 超时秒数（超时 kill，产物视为失败）。
        output_paths: 产物相对路径清单（拷贝进产物目录并哈希）。
        meta: 扩展元数据（来源/版本说明等）。
    """

    kind: BuildKind
    command: str
    args: tuple[str, ...] = ()
    workdir: str | Path = "."
    env: dict[str, str] | None = None
    timeout: float = 120.0
    output_paths: tuple[str, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.command:
            raise GraphDefinitionError("构建声明缺 command（白名单命令）")
        if self.timeout <= 0:
            raise GraphDefinitionError(f"构建超时须为正数: {self.timeout}")
        for path in self.output_paths:
            if not isinstance(path, str) or not path:
                raise GraphDefinitionError(
                    "构建声明的 output_paths 须为非空相对路径清单"
                )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "kind": self.kind.value,
            "command": self.command,
            "workdir": str(self.workdir),
            "timeout": self.timeout,
        }
        if self.args:
            data["args"] = list(self.args)
        if self.env:
            data["env"] = dict(self.env)
        if self.output_paths:
            data["output_paths"] = list(self.output_paths)
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BuildSpec:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"构建声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        try:
            kind = BuildKind(data.get("kind"))
        except ValueError as exc:
            raise GraphDefinitionError(
                f"构建产物类别非法: {data.get('kind')!r}"
            ) from exc
        command = data.get("command")
        if not command or not isinstance(command, str):
            raise GraphDefinitionError("构建声明缺 command（字符串）")
        args = data.get("args") or ()
        output_paths = data.get("output_paths") or ()
        for label, items in (("args", args), ("output_paths", output_paths)):
            if not isinstance(items, (list, tuple)) or not all(
                isinstance(item, str) and item for item in items
            ):
                raise GraphDefinitionError(
                    f"构建声明的 {label} 须为非空字符串清单"
                )
        env = data.get("env")
        if env is not None and not isinstance(env, dict):
            raise GraphDefinitionError("构建声明的 env 须为 dict")
        timeout = float(data.get("timeout") or 120.0)
        meta = data.get("meta")
        if meta is not None and not isinstance(meta, dict):
            raise GraphDefinitionError("构建声明的 meta 须为 dict")
        return cls(
            kind=kind,
            command=command,
            args=tuple(args),
            workdir=str(data.get("workdir") or "."),
            env=dict(env) if env is not None else None,
            timeout=timeout,
            output_paths=tuple(output_paths),
            meta=dict(meta or {}),
        )


@dataclass(frozen=True, slots=True)
class BuildArtifact:
    """构建产物（内容寻址：产物 id = 文件内容哈希派生的标识）。

    Attributes:
        artifact_id: 产物 id（kind + 内容哈希前缀，防篡改切换）。
        kind: 产物类别。
        files: 文件 → sha256 hex 映射（部署/回退前的哈希门禁依据）。
        built_at: 构建完成时间（epoch 秒）。
        meta: 构建源信息（spec 摘要等）。
    """

    artifact_id: str
    kind: str
    files: dict[str, str] = field(default_factory=dict)
    built_at: float = 0.0
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "kind": self.kind,
            "files": dict(self.files),
            "built_at": self.built_at,
            "meta": dict(self.meta),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> BuildArtifact:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"构建产物声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        artifact_id = data.get("artifact_id")
        kind = data.get("kind")
        files = data.get("files")
        if not artifact_id or not isinstance(artifact_id, str):
            raise GraphDefinitionError("构建产物缺 artifact_id（字符串）")
        if not kind or not isinstance(kind, str):
            raise GraphDefinitionError("构建产物缺 kind（字符串）")
        if not isinstance(files, dict):
            raise GraphDefinitionError("构建产物的 files 须为文件 → 哈希 dict")
        return cls(
            artifact_id=artifact_id,
            kind=kind,
            files=dict(files),
            built_at=float(data.get("built_at") or 0.0),
            meta=dict(data.get("meta") or {}),
        )


@dataclass(frozen=True, slots=True)
class SmokeProbe:
    """冒烟探针（构建产物 promote 前的启动/回归验证声明）。

    Attributes:
        command: 探针命令（须在构建沙箱白名单内）。
        args: 命令参数。
        timeout: 超时秒数（超时 = 冒烟失败）。
        expect_exit: 期望退出码（默认 0 = 成功）。
    """

    command: str
    args: tuple[str, ...] = ()
    timeout: float = 30.0
    expect_exit: int = 0


@dataclass(frozen=True, slots=True)
class SmokeResult:
    """冒烟结果（门禁判定依据）。"""

    ok: bool
    output: str = ""
    timed_out: bool = False
    exit_code: int = 0


class BuildError(GraphDefinitionError):
    """构建/冒烟失败（产物保留现状，不 promote）。"""


class Builder:
    """本机构建管线（白名单命令 + 产物哈希 + 冒烟门禁）。

    装配：sandbox（白名单命令沙箱，构建与冒烟共用）、artifact_dir
    （产物根目录，哈希命名子目录）。构建失败 = 抛 BuildError 且不
    落产物记录（保留现状 + 调用方留痕）。
    """

    def __init__(
        self,
        sandbox: ProcessSandbox,
        artifact_dir: str | Path,
    ) -> None:
        self._sandbox = sandbox
        self._artifact_dir = Path(artifact_dir)

    async def build(self, spec: BuildSpec) -> BuildArtifact:
        """执行构建：产物拷贝进内容寻址目录 + 文件级 sha256 哈希。

        构建命令须在沙箱白名单内（fail-closed）；产物缺 output_paths
        或哈希异常 = 构建失败（不产出半成品记录）。
        """
        if spec.command not in self._sandbox.allowlist:
            raise BuildError(
                f"构建命令不在白名单: {spec.command!r}（fail-closed）"
            )
        workdir = Path(spec.workdir).resolve()
        if not workdir.is_dir():
            raise BuildError(f"构建工作目录不存在: {workdir}")
        # 构建沙箱副本：工作目录限定在构建目录（构建命令产出落在目录内），
        # 超时按声明注入（声明值与沙箱执行一致，超时 kill 归因于构建）
        build_sandbox = dataclasses.replace(
            self._sandbox, cwd=workdir, timeout=spec.timeout
        )
        result = await build_sandbox.run(spec.command, tuple(spec.args))
        if result.timed_out:
            raise BuildError(
                f"构建超时（>{spec.timeout}s）: {spec.command} {spec.args}"
            )
        if result.exit_code != 0:
            raise BuildError(
                f"构建失败: exit={result.exit_code} "
                f"{result.stderr[:300] or result.stdout[:300]}"
            )
        if not spec.output_paths:
            raise BuildError("构建声明未指定 output_paths（无产物可收）")
        files: dict[str, str] = {}
        contents: list[bytes] = []
        for relative in spec.output_paths:
            # 产物路径越界防护：拒绝绝对路径与 `..` 片段（声明可来自
            # 补丁链/AI 生成，路径穿越会让构建管线读取并落盘任意文件）
            rel = Path(relative)
            if rel.is_absolute() or any(seg == ".." for seg in rel.parts):
                raise BuildError(f"产物路径越界（拒绝绝对路径/..）: {relative!r}")
            source = workdir / rel
            if not source.is_file():
                raise BuildError(f"产物缺失: {relative}")
            digest = _sha256_file(source)
            files[relative] = digest
            contents.append(digest.encode("ascii"))
        # 内容寻址：产物 id = 类别 + 文件内容哈希前缀（防篡改切换）
        content_hash = hashlib.sha256(b"".join(sorted(contents))).hexdigest()
        artifact_id = f"{spec.kind.value}-{content_hash[:16]}"
        target_dir = self._artifact_dir / artifact_id
        target_dir.mkdir(parents=True, exist_ok=True)
        for relative in spec.output_paths:
            shutil.copy2(workdir / relative, target_dir / relative)
        return BuildArtifact(
            artifact_id=artifact_id,
            kind=spec.kind.value,
            files=files,
            built_at=time.time(),
            meta={"spec": spec.to_dict()},
        )

    async def smoke(self, artifact: BuildArtifact, probe: SmokeProbe) -> SmokeResult:
        """冒烟门禁：探针命令经沙箱执行，退出码/超时判定（fail-closed）。

        探针工作目录 = 产物目录（probe 在产物上下文中运行——产物内的
        可执行文件/依赖文件可被探针直接引用），超时按探针声明注入。
        """
        if probe.command not in self._sandbox.allowlist:
            return SmokeResult(ok=False, output="冒烟命令不在白名单（fail-closed）")
        smoke_sandbox = dataclasses.replace(
            self._sandbox,
            cwd=self.artifact_dir(artifact),
            timeout=probe.timeout,
        )
        result = await smoke_sandbox.run(probe.command, tuple(probe.args))
        if result.timed_out:
            return SmokeResult(ok=False, output=result.stdout, timed_out=True)
        ok = result.exit_code == probe.expect_exit
        return SmokeResult(
            ok=ok, output=result.stdout, exit_code=result.exit_code
        )

    def verify_hash(self, artifact: BuildArtifact, name: str, digest: str) -> bool:
        """哈希校验（部署/回退前强制门禁）：产物目录内文件与声明一致。"""
        declared = artifact.files.get(name)
        if declared is None or declared != digest:
            return False
        source = self._artifact_dir / artifact.artifact_id / name
        if not source.is_file():
            return False
        return _sha256_file(source) == digest

    def artifact_dir(self, artifact: BuildArtifact) -> Path:
        """产物目录路径（部署/挂载读取）。"""
        return self._artifact_dir / artifact.artifact_id


def _sha256_file(path: Path) -> str:
    """文件内容 sha256（分块读取，防大文件整读占内存）。"""
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


__all__ = [
    "BuildArtifact",
    "BuildError",
    "BuildKind",
    "BuildSpec",
    "Builder",
    "SmokeProbe",
    "SmokeResult",
    "_sha256_file",
]

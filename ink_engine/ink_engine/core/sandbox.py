"""工具执行沙箱（文件系统守卫 + 写前快照 + 进程沙箱）。

沙箱是机制、非安全边界承诺——默认拒绝兜底 + 纵深防御，宿主可叠加 OS 级隔离。

- :class:`FileSandbox`：根目录前缀 + ``Path.resolve`` 校验 + symlink 逃逸
  检测（read/write/delete 三类守卫）+ 写前快照（快照 → 写 → 可还原，
  事务性文件写入的机制底座）；
- :class:`ProcessSandbox`：受限子进程包装（超时 kill/退出码/输出截断/
  工作目录限定/环境变量清理/默认禁 ``shell=True``），进程型工具 =
  白名单命令 + 参数透传；
- 网络判定在 ``core.permissions``（:class:`NetworkPolicy`：默认禁网，
  白名单域名由宿主配置）。

守卫接口：``validate(operation, target)``——违规抛 :class:`SandboxViolation`。

白名单审计：``FS_OPERATIONS``（文件守卫操作域）= **机制固有**——FileSandbox
守卫语义绑定（与权限域 filesystem 动作同源）。
"""
from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .exceptions import SandboxViolation

# FileSandbox 支持的操作（三类守卫 + 两类只读检索）
FS_OPERATIONS = ("read", "write", "delete", "search", "search_paths")


@dataclass(slots=True)
class FileSandbox:
    """文件系统沙箱：根目录前缀 + resolve 校验 + symlink 逃逸检测。

    ``validate(operation, target)`` 返回解析后的绝对路径（调用方执行
    读写删除用解析结果，防二次拼接引入逃逸）。root 接受 str 或 Path
    （构造时归一为 Path，避免 str/Path 混用触发的属性缺失）。
    """

    root: Path

    def __post_init__(self) -> None:
        self.root = Path(self.root)

    def guards_operation(self, operation: str) -> bool:
        """是否本沙箱守卫的操作域（多端点流水线各司其职的依据）。"""
        return operation in FS_OPERATIONS

    def resolve(self, path: str | Path) -> Path:
        """路径解析：绝对化 → ``Path.resolve``（跟随 symlink）→ 前缀校验。

        symlink 逃逸检测 = resolve 后仍须落在根目录内（指向外部的链接
        经 resolve 越界即拒绝）。不存在的路径按词法解析（父目录已存在
        的部分仍会跟随链接）。
        """
        p = Path(path)
        if not p.is_absolute():
            p = self.root / p
        resolved = p.resolve()
        try:
            resolved.relative_to(self.root.resolve())
        except ValueError:
            raise SandboxViolation(f"路径越界: {path}") from None
        return resolved

    def validate(self, operation: str, target: str) -> Path:
        if operation not in FS_OPERATIONS:
            raise SandboxViolation(f"不支持的 fs 操作: {operation}")
        return self.resolve(target)


@dataclass(frozen=True, slots=True)
class FileSnapshot:
    """写/删前快照（旧内容 + 存在性，可还原）。"""

    path: Path
    existed: bool
    content: bytes | None

    def restore(self) -> None:
        """还原：原存在恢复旧内容，原不存在删除（幂等）。"""
        if self.existed:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(self.content or b"")
        else:
            self.path.unlink(missing_ok=True)


def snapshot_before(path: Path) -> FileSnapshot:
    """写/删前快照：记录旧内容与存在性（宿主挂工具流水线写前调用）。"""
    if path.exists() and path.is_file():
        return FileSnapshot(path=path, existed=True, content=path.read_bytes())
    return FileSnapshot(path=path, existed=False, content=None)


@dataclass(slots=True)
class ProcessResult:
    """受限子进程的执行结果（退出码 + 截断输出 + 超时标记）。"""

    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool = False


def _truncate(data: bytes, limit: int) -> str:
    text = data.decode(errors="replace")
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（已截断）"


@dataclass(slots=True)
class ProcessSandbox:
    """受限子进程执行（白名单命令 + 超时 kill + 输出截断 + 目录/环境限定）。

    Attributes:
        allowlist: 白名单命令集合（缺省空 = 全部拒绝，fail-closed）。
        timeout: 超时秒数（超时 kill 并标记 timed_out）。
        cwd: 工作目录限定（缺省 None = 继承引擎进程目录）。
        max_output: stdout/stderr 各自截断上限（字符）。
        env: 环境变量白名单（缺省空 = 干净环境，不含宿主变量）。
        path: 显式 PATH 注入（None = 不注入；env 无 PATH 时裸命令名
            无法解析——白名单用裸命令名（如 git）须注入 path 或改用
            绝对路径）。注入值用于 create_subprocess_exec 的 PATH
            查找，与宿主配置协同（引擎不替宿主决定平台默认值）。
    """

    allowlist: tuple[str, ...] = ()
    timeout: float = 30.0
    cwd: str | Path | None = None
    max_output: int = 100_000
    env: dict[str, str] | None = None
    path: str | None = None

    def guards_operation(self, operation: str) -> bool:
        """是否本沙箱守卫的操作域（多端点流水线各司其职的依据）。"""
        return operation == "exec"

    def validate(self, operation: str, target: str) -> None:
        if operation != "exec":
            raise SandboxViolation(f"不支持的进程操作: {operation}")
        if target not in self.allowlist:
            raise SandboxViolation(f"命令不在白名单: {target}")
        # 裸命令名 + 未注入 PATH + env 无 PATH：执行必失败且报错难懂
        # （FileNotFoundError）——在守卫期给出明确指引（fail-closed，
        # 不自动注入平台默认值）
        if (
            "/" not in target
            and "\\" not in target
            and self.path is None
            and not (self.env or {}).get("PATH")
        ):
            raise SandboxViolation(
                f"命令 {target!r} 为裸命令名但未配置 PATH（ProcessSandbox.path "
                f"或 env.PATH）：请注入 PATH 或改用绝对路径"
            )

    async def run(self, command: str, args: Sequence[str] = ()) -> ProcessResult:
        """执行白名单命令（参数透传，默认禁 shell——不经 shell 解释）。"""
        self.validate("exec", command)
        run_env = dict(self.env or {})
        if self.path is not None:
            run_env.setdefault("PATH", self.path)
        proc = await asyncio.create_subprocess_exec(
            command,
            *args,
            cwd=str(self.cwd) if self.cwd is not None else None,
            env=run_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), self.timeout)
        except TimeoutError:
            proc.kill()
            await proc.communicate()
            return ProcessResult(exit_code=-1, stdout="", stderr="", timed_out=True)
        return ProcessResult(
            exit_code=proc.returncode or 0,
            stdout=_truncate(stdout, self.max_output),
            stderr=_truncate(stderr, self.max_output),
        )


__all__ = [
    "FS_OPERATIONS",
    "FileSandbox",
    "FileSnapshot",
    "ProcessResult",
    "ProcessSandbox",
    "snapshot_before",
]

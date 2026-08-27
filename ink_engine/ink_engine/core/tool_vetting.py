"""工具可信度闸门：默认不信 + 渐进信任。

挂载外部工具的完整路径：清单校验（来源/签名/哈希/权限声明/SBOM）→
静态审查（lint/类型检查/依赖扫描，宿主注入钩子）→ 观察模式（影子
运行：独立工作目录副本 + 写操作虚拟化 + 结果标记 untrusted）→
试用授权 → 常规授权。本模块承载前三环节的机制——信任靠行为证据
累积，不靠承诺。

安全边界（fail-closed）：
- 未知来源且无签名 = 清单校验拒绝（签名缺失拒绝）；
- 权限声明逐项解析（parse_permission，声明非法 = 拒绝）；
- 静态审查钩子命中 = 结果降级 review（需人工）或 rejected；
- 影子运行 = 写虚拟化（独立工作目录 + 快照 diff），结果恒标记
  untrusted（观察数据不作信任依据，只作行为证据）。
"""
from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from .exceptions import GraphDefinitionError
from .logging import get_logger
from .permissions import parse_permission

logger = get_logger(__name__)

# 哈希声明形态（sha256 hex，64 字符）
_HASH_LENGTH = 64

# 静态审查钩子签名：代码文件清单 → 违规描述清单（空 = 通过）
StaticHook = Callable[[Sequence[Path]], list[str]]


class ToolSource(StrEnum):
    """工具来源（清单校验的可信度分类）。"""

    MARKET = "market"
    GITHUB = "github"
    AI_GENERATED = "ai_generated"
    UNKNOWN = "unknown"


class VettingVerdict(StrEnum):
    """清单+审查的总体判定（approved/review/rejected）。"""

    VERIFIED = "verified"
    REVIEW = "review"
    REJECTED = "rejected"


@dataclass(frozen=True, slots=True)
class ToolManifest:
    """工具清单（来源/签名/哈希/权限声明/SBOM，挂载前的身份声明）。

    Attributes:
        name: 工具名。
        source: 来源分类（market/github/ai_generated/unknown）。
        signature: 来源签名（未知来源且缺签名 = 清单校验拒绝）。
        hashes: 代码文件 → sha256 hex 映射（哈希一致性门禁）。
        permissions: 权限声明清单（逐项 parse_permission 校验）。
        dependencies: 依赖清单（SBOM 声明，依赖漏洞扫描钩子消费）。
        meta: 扩展元数据（作者/版本/下载地址等）。
    """

    name: str
    source: ToolSource = ToolSource.UNKNOWN
    signature: str | None = None
    hashes: dict[str, str] = field(default_factory=dict)
    permissions: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": self.name,
            "source": self.source.value,
        }
        if self.signature:
            data["signature"] = self.signature
        if self.hashes:
            data["hashes"] = dict(self.hashes)
        if self.permissions:
            data["permissions"] = list(self.permissions)
        if self.dependencies:
            data["dependencies"] = list(self.dependencies)
        if self.meta:
            data["meta"] = dict(self.meta)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ToolManifest:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"工具清单非法: 期望 dict，收到 {type(data).__name__}"
            )
        name = data.get("name")
        if not name or not isinstance(name, str):
            raise GraphDefinitionError("工具清单缺 name（字符串）")
        try:
            source = ToolSource(data.get("source", ToolSource.UNKNOWN.value))
        except ValueError as exc:
            raise GraphDefinitionError(
                f"工具 {name} 的来源分类非法: {data.get('source')!r}"
            ) from exc
        signature = data.get("signature")
        if signature is not None and not isinstance(signature, str):
            raise GraphDefinitionError(f"工具 {name} 的 signature 须为字符串")
        hashes = data.get("hashes") or {}
        if not isinstance(hashes, dict):
            raise GraphDefinitionError(f"工具 {name} 的 hashes 须为文件 → 哈希 dict")
        for path, digest in hashes.items():
            if not isinstance(path, str) or not isinstance(digest, str):
                raise GraphDefinitionError(
                    f"工具 {name} 的哈希声明非法: {path!r} → {digest!r}"
                )
        permissions = data.get("permissions") or ()
        dependencies = data.get("dependencies") or ()
        for label, items in (("permissions", permissions), ("dependencies", dependencies)):
            if not isinstance(items, (list, tuple)) or not all(
                isinstance(item, str) and item for item in items
            ):
                raise GraphDefinitionError(
                    f"工具 {name} 的 {label} 须为非空字符串清单"
                )
        return cls(
            name=name,
            source=source,
            signature=signature,
            hashes=dict(hashes),
            permissions=tuple(permissions),
            dependencies=tuple(dependencies),
            meta=dict(data.get("meta") or {}),
        )


@dataclass(frozen=True, slots=True)
class VettingCheck:
    """单项闸门结果（清单/静态审查/观察模式，逐项可审计）。"""

    name: str
    ok: bool
    detail: str = ""


@dataclass(frozen=True, slots=True)
class ShadowWrite:
    """影子运行记录的写操作（写虚拟化：只记录不落真实工作区）。"""

    path: str
    operation: str
    size: int = 0


@dataclass(frozen=True, slots=True)
class ShadowRunResult:
    """观察模式结果（行为证据：写操作清单 + 输出，恒标记 untrusted）。"""

    ok: bool
    writes: tuple[ShadowWrite, ...] = ()
    output: str = ""
    error: str | None = None
    untrusted: bool = True


@dataclass(frozen=True, slots=True)
class VettingResult:
    """vetting 总体结果（判定 + 逐项检查 + 观察证据）。"""

    ok: bool
    verdict: VettingVerdict
    checks: tuple[VettingCheck, ...] = ()
    shadow: ShadowRunResult | None = None
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "verdict": self.verdict.value,
            "checks": [
                {"name": c.name, "ok": c.ok, "detail": c.detail}
                for c in self.checks
            ],
            "shadow": (
                {
                    "ok": self.shadow.ok,
                    "writes": [
                        {"path": w.path, "operation": w.operation, "size": w.size}
                        for w in self.shadow.writes
                    ],
                    "untrusted": self.shadow.untrusted,
                }
                if self.shadow is not None
                else None
            ),
            "reason": self.reason,
        }


class ToolVetting:
    """工具可信度闸门（清单校验 + 静态审查钩子 + 影子运行）。

    装配：static_hooks（宿主注入静态审查钩子：ruff/pyright/eslint/
    tsc/npm audit 等）。静态审查默认非空操作（ENG6-7）：出厂基线附带
    :func:`code_files_exist`（代码文件存在性校验）——宿主未注入任何
    钩子时审查至少覆盖「声明的代码文件真实存在」，杜绝「零钩子 =
    静态审查静默空操作」；宿主注入钩子时存在性校验仍保留（低成本
    前置防线，与宿主钩子叠加）。vet 返回判定：
    - 清单校验失败（签名缺失/权限声明非法/哈希形态非法）= rejected；
    - 静态审查命中 = review（需人工确认，不自动放行）；
    - 全过 = verified。观察模式由宿主显式调用（shadow_run）。
    """

    def __init__(self, *, static_hooks: Sequence[StaticHook] = ()) -> None:
        # 默认附加 code_files_exist（ENG6-7）：宿主未注入/部分注入时
        # 静态审查恒有基础防线；已显式包含时不重复附加
        hooks = [code_files_exist]
        hooks.extend(hook for hook in static_hooks if hook is not code_files_exist)
        self._static_hooks = tuple(hooks)

    async def vet(
        self,
        manifest: ToolManifest,
        code_paths: Sequence[Path] = (),
        *,
        strict: bool = False,
    ) -> VettingResult:
        """执行闸门：清单校验 → 静态审查 → 判定。

        Args:
            manifest: 工具清单（身份声明）。
            code_paths: 待审查的代码文件路径（静态钩子消费）。
            strict: True = 静态审查命中直接 rejected（高危形态）；
                False = 命中降级 review（默认，需人工确认）。
        """
        checks: list[VettingCheck] = []
        checks.append(await self._check_manifest(manifest))
        if not checks[-1].ok:
            return VettingResult(
                ok=False,
                verdict=VettingVerdict.REJECTED,
                checks=tuple(checks),
                reason=checks[-1].detail,
            )
        static_violations: list[str] = []
        for index, hook in enumerate(self._static_hooks):
            try:
                violations = hook(list(code_paths))
            except Exception as exc:
                violations = [f"静态审查钩子异常: {exc}"]
            static_violations.extend(violations)
            checks.append(
                VettingCheck(
                    name=f"static_hook_{index + 1}",
                    ok=not violations,
                    detail="；".join(violations) or "通过",
                )
            )
        if static_violations:
            verdict = VettingVerdict.REJECTED if strict else VettingVerdict.REVIEW
            return VettingResult(
                ok=verdict is VettingVerdict.REVIEW,
                verdict=verdict,
                checks=tuple(checks),
                reason="；".join(static_violations[:5]),
            )
        return VettingResult(
            ok=True,
            verdict=VettingVerdict.VERIFIED,
            checks=tuple(checks),
        )

    async def shadow_run(
        self,
        executor: Callable[[dict[str, Any], Path], Any],
        args: dict[str, Any],
        *,
        workdir: Path,
    ) -> ShadowRunResult:
        """观察模式：独立影子工作区执行 + 写虚拟化。

        影子工作区 = 真实工作目录的独立副本（临时目录）：executor 以
        (args, shadow_workdir) 调用，须在传入的影子目录内执行——写操作
        全部落在副本上，真实目录零触碰（写虚拟化）；执行后 diff 副本
        前后快照得写操作清单，随后副本销毁。结果恒标记 untrusted
        （观察数据不作信任依据，只作行为证据累积）。

        Args:
            executor: 观察回调（args, shadow_workdir）→ 任意结果；
                写操作须发生在 shadow_workdir 内才被记录。
            args: 回调参数（宿主语义）。
            workdir: 真实工作目录（只读模板源，观察期间不被触碰）。
        """
        workdir = Path(workdir)
        if not workdir.is_dir():
            return ShadowRunResult(
                ok=False, error=f"影子工作区不存在: {workdir}"
            )
        shadow_root = Path(tempfile.mkdtemp(prefix="forge-shadow-"))
        shadow_dir = shadow_root / "work"
        try:
            _copy_tree(workdir, shadow_dir)
            before = _snapshot_tree(shadow_dir)
            output = ""
            try:
                result = executor(args, shadow_dir)
                if hasattr(result, "__await__"):
                    result = await result
                output = str(result)
            except Exception as exc:
                return ShadowRunResult(
                    ok=False, output=output, error=str(exc)
                )
            after = _snapshot_tree(shadow_dir)
            writes = _diff_writes(before, after, shadow_dir)
            return ShadowRunResult(ok=True, writes=writes, output=output)
        finally:
            shutil.rmtree(shadow_root, ignore_errors=True)

    async def _check_manifest(self, manifest: ToolManifest) -> VettingCheck:
        """清单校验：来源/签名/哈希/权限声明（逐项 fail-closed）。"""
        violations: list[str] = []
        if manifest.source is ToolSource.UNKNOWN and not manifest.signature:
            violations.append("来源未知且无签名（签名缺失拒绝）")
        for perm in manifest.permissions:
            try:
                parse_permission(perm)
            except ValueError as exc:
                violations.append(f"权限声明非法: {perm!r}（{exc}）")
        for path, digest in manifest.hashes.items():
            if len(digest) != _HASH_LENGTH:
                violations.append(
                    f"哈希声明非法（须 sha256 hex {_HASH_LENGTH} 字符）: {path!r}"
                )
                continue
            try:
                int(digest, 16)
            except ValueError:
                violations.append(
                    f"哈希声明非法（非合法 hex 字符）: {path!r}"
                )
        if not manifest.permissions:
            violations.append("未声明权限（fail-closed：无权限声明的工具拒绝挂载）")
        ok = not violations
        return VettingCheck(
            name="manifest", ok=ok, detail="；".join(violations) or "清单校验通过"
        )


def _snapshot_tree(root: Path) -> dict[str, int]:
    """目录内容快照：相对路径 → 文件字节数（执行前/后 diff 的依据）。"""
    snapshot: dict[str, int] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            try:
                snapshot[str(path.relative_to(root))] = path.stat().st_size
            except OSError:
                continue
    return snapshot


def _copy_tree(source: Path, target: Path) -> None:
    """目录递归拷贝（影子工作区模板；符号链接按链接复制防逃逸）。"""
    target.mkdir(parents=True, exist_ok=True)
    for entry in source.iterdir():
        if entry.is_symlink():
            link_target = os.readlink(entry)
            (target / entry.name).symlink_to(link_target)
        elif entry.is_dir():
            _copy_tree(entry, target / entry.name)
        elif entry.is_file():
            shutil.copy2(entry, target / entry.name)


def _diff_writes(
    before: dict[str, int], after: dict[str, int], root: Path
) -> tuple[ShadowWrite, ...]:
    """前后快照 diff → 写操作清单（新增/修改/删除）。"""
    writes: list[ShadowWrite] = []
    for path, size in after.items():
        if path not in before:
            writes.append(ShadowWrite(path=path, operation="write", size=size))
        elif before[path] != size:
            writes.append(ShadowWrite(path=path, operation="modify", size=size))
    for path in before:
        if path not in after:
            writes.append(ShadowWrite(path=path, operation="delete"))
    return tuple(writes)


def code_files_exist(code_paths: Sequence[Path]) -> list[str]:
    """常用静态审查前置钩子：代码文件存在性校验（宿主可复用）。"""
    missing = [str(p) for p in code_paths if not Path(p).is_file()]
    return [f"代码文件缺失: {path}" for path in missing]


__all__ = [
    "ShadowRunResult",
    "ShadowWrite",
    "StaticHook",
    "ToolManifest",
    "ToolSource",
    "ToolVetting",
    "VettingCheck",
    "VettingResult",
    "VettingVerdict",
    "code_files_exist",
]

"""本地文件访问授权（挂载点模型）：AI 只见显式授权的挂载点，磁盘其余部分 fail-closed。

挂载点 = 数据（路径 + 权限级 + 绑定应用），经 storage records 通道
随集持久化；注册/撤销是用户动作（撤销语义走补丁链，旁路写防护由
应用管线接管后统一经该通道）。权限分级：read（已授权目录直通，沙箱内）/ write
（写前快照可还原）/ execute（沙箱 + 人工审批）/ 系统级目录（白名单
外硬拒绝）。校验语义：路径规范化 + 前缀边界匹配（防 ../ 逃逸与同
名前缀误匹配）；权限请求按分级序满足（read < write < execute）。
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ink_engine.core.storage import Storage

# 挂载点集合（storage records 通道）
_COLLECTION_FILE_MOUNTS = "file_mounts"

# 权限分级（声明式枚举，防魔法字符串；按分级序满足）
MOUNT_LEVEL_READ = "read"
MOUNT_LEVEL_WRITE = "write"
MOUNT_LEVEL_EXECUTE = "execute"
_VALID_LEVELS = (MOUNT_LEVEL_READ, MOUNT_LEVEL_WRITE, MOUNT_LEVEL_EXECUTE)
_LEVEL_ORDER = {
    MOUNT_LEVEL_READ: 1,
    MOUNT_LEVEL_WRITE: 2,
    MOUNT_LEVEL_EXECUTE: 3,
}

# 系统级目录硬拒绝（Windows 基线；其它平台按平台语义扩展）：
# 系统根 = 等值拒绝（挂载根盘本身）；系统子目录 = 祖先拒绝
# （Windows/Program Files/ProgramData 及其下内容）。用户工作区
# （AppData/Local/Temp 等）不属于系统目录，不在此列。
_SYSTEM_ROOT = Path(os.environ.get("SYSTEMROOT") or "C:/Windows")
_SYSTEM_ROOTS: tuple[Path, ...] = (
    _SYSTEM_ROOT.parent if _SYSTEM_ROOT.parent.drive else Path("C:/"),
)
_SYSTEM_DIRS: tuple[Path, ...] = (
    _SYSTEM_ROOT,
    Path("C:/Program Files"),
    Path("C:/Program Files (x86)"),
    Path("C:/ProgramData"),
)


def normalize_path(path: str) -> Path:
    """路径规范化：展开用户目录 + 绝对化（resolve 消除 ../ 逃逸）。"""
    return Path(path).expanduser().resolve()


def is_system_path(path: Path) -> bool:
    """系统级目录判定（白名单外硬拒绝的基线）。"""
    if any(path == root for root in _SYSTEM_ROOTS):
        return True
    return any(path == prefix or prefix in path.parents for prefix in _SYSTEM_DIRS)


@dataclass(frozen=True, slots=True)
class MountRecord:
    """挂载点声明（数据形态：路径 + 权限级 + 绑定应用）。"""

    id: str
    path: str
    level: str
    app: str
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "level": self.level,
            "app": self.app,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> MountRecord:
        return cls(
            id=str(data["id"]),
            path=str(data["path"]),
            level=str(data["level"]),
            app=str(data.get("app") or "forge"),
            note=str(data.get("note") or ""),
        )


class MountRegistry:
    """挂载点注册表（注册/列表/撤销 + 路径-权限双锁校验，fail-closed）。"""

    def __init__(self, storage: Storage) -> None:
        self._storage = storage

    async def register(
        self,
        *,
        path: str,
        level: str,
        app: str = "forge",
        note: str = "",
    ) -> MountRecord:
        """注册挂载点（非法级别/系统级目录显式拒绝；路径规范化后落库）。"""
        if level not in _VALID_LEVELS:
            raise ValueError(f"挂载点权限级非法: {level!r}（仅 {_VALID_LEVELS}）")
        normalized = normalize_path(path)
        if is_system_path(normalized):
            raise PermissionError(f"系统级目录拒绝挂载: {normalized}")
        record = MountRecord(
            id=uuid.uuid4().hex[:12],
            path=str(normalized),
            level=level,
            app=app,
            note=note,
        )
        await self._storage.put_record(
            _COLLECTION_FILE_MOUNTS, record.id, record.to_dict()
        )
        return record

    async def list_mounts(self) -> list[MountRecord]:
        """挂载点清单（AI 可见的全部已授权且未撤销目录；磁盘其余部分不可见）。"""
        mounts: list[MountRecord] = []
        for record in await self._storage.list_records(_COLLECTION_FILE_MOUNTS):
            if record.get("revoked"):
                continue
            mounts.append(MountRecord.from_dict(record))
        return mounts

    async def revoke(self, mount_id: str) -> None:
        """撤销挂载点（revoked 置位留痕——撤销历史不删除，审计可追溯；
        未找到显式拒绝，不静默）。"""
        record = await self._storage.get_record(_COLLECTION_FILE_MOUNTS, mount_id)
        if record is None:
            raise KeyError(f"挂载点不存在: {mount_id}")
        await self._storage.put_record(
            _COLLECTION_FILE_MOUNTS, mount_id, {**record, "revoked": True}
        )

    async def check(self, target: str, *, level: str) -> MountRecord | None:
        """路径-权限双锁校验：target 须落在某挂载点目录边界内且权限级满足。

        fail-closed：无匹配挂载点 / 权限不足 → None（调用方拒绝）。
        目录边界语义：target == mount.path 或以 mount.path + 分隔符开头
        （同名前缀如 D:/Novels 不匹配 D:/Novels2）。
        """
        if level not in _VALID_LEVELS:
            return None
        required = _LEVEL_ORDER[level]
        normalized = normalize_path(target)
        for record in await self.list_mounts():
            mount_path = Path(record.path)
            if not _within(mount_path, normalized):
                continue
            if _LEVEL_ORDER[record.level] < required:
                continue
            return record
        return None

    async def browse(self, path: str) -> dict[str, Any] | None:
        """挂载点内目录浏览（一层；未授权路径 → None，fail-closed）。"""
        mount = await self.check(path, level=MOUNT_LEVEL_READ)
        if mount is None:
            return None
        directory = normalize_path(path)
        if not directory.is_dir():
            return None
        entries: list[dict[str, Any]] = []
        for entry in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            try:
                stat = entry.stat()
                entries.append(
                    {
                        "name": entry.name,
                        "type": "dir" if entry.is_dir() else "file",
                        "size": stat.st_size if entry.is_file() else 0,
                    }
                )
            except OSError:
                continue  # 无权限条目跳过，不击穿浏览
        return {"path": str(directory), "mount": mount.to_dict(), "entries": entries}


def _within(mount_path: Path, target: Path) -> bool:
    """目录边界匹配（target 是 mount_path 自身或其后代；同名前缀不误匹配）。"""
    if target == mount_path:
        return True
    return str(target).startswith(str(mount_path) + os.sep)

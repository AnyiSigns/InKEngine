"""引擎接线：跨平台进程锁 + 引擎存储生命周期（SQLite 集目录 engine.db）。

单机单集唯一进程锁（启动即持锁，防双开写坏补丁链）：Windows 用
msvcrt.locking 非阻塞锁首字节，Unix 用 fcntl.flock——纯标准库实现，
锁随进程退出（含崩溃）由操作系统自动释放。存储经引擎 Storage
接口读写（records/checkpoint/事件日志全走该通道）。
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from ink_engine.core.storage import Storage, create_storage

from . import config

_storage: Storage | None = None
_process_lock: ProcessLock | None = None
_lock = asyncio.Lock()


class ProcessLock:
    """跨平台进程锁（防双开）。

    锁文件常驻；重复获取（另一实例存活）抛 RuntimeError，启动方
    据此友好退出。锁由 OS 在进程退出时自动释放，无残留风险。
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._file = None
        self._fd: int | None = None

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 锁句柄须跨 acquire/release 存活，不能用上下文管理器
        self._file = open(self.path, "a+b")  # noqa: SIM115
        self._fd = self._file.fileno()
        # 仅新建的锁文件写入首字节（已存在的文件首字节即锁位，
        # 反复持锁不追加字节，锁文件体积恒定）
        if self._file.tell() == 0:
            self._file.write(b"\0")
            self._file.flush()
        self._file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._file.close()
            self._file = None
            self._fd = None
            raise RuntimeError(
                f"另一 Forge 实例正在运行（锁文件: {self.path}）"
            ) from exc

    def release(self) -> None:
        if self._file is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self._file.seek(0)
                msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            self._file.close()
            self._file = None
            self._fd = None


async def init_engine() -> None:
    """启动时初始化引擎存储并持有进程锁（幂等）。"""
    global _storage, _process_lock
    async with _lock:
        if _storage is not None:
            return
        _process_lock = ProcessLock(config.LOCK_PATH)
        _process_lock.acquire()
        _storage = create_storage(f"sqlite:///{config.ENGINE_DB_PATH.as_posix()}")


async def close_engine() -> None:
    """关闭存储并释放进程锁（进程退出前调用）。"""
    global _storage, _process_lock
    async with _lock:
        if _storage is not None:
            await _storage.close()
            _storage = None
        if _process_lock is not None:
            _process_lock.release()
            _process_lock = None


def get_storage() -> Storage:
    """访问引擎存储；未初始化时抛错（lifespan 之外调用即编程错误）。"""
    if _storage is None:
        raise RuntimeError("引擎存储未初始化（init_engine 未执行）")
    return _storage

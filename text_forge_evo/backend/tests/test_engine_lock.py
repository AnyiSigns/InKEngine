"""跨平台进程锁单测：获取/释放/双开拒绝。"""

from __future__ import annotations

import pytest

from app.config import LOCK_PATH
from app.engine import ProcessLock


def test_acquire_and_release(tmp_path) -> None:
    lock = ProcessLock(tmp_path / ".lock")
    lock.acquire()
    lock.release()
    lock.acquire()
    lock.release()


def test_second_acquire_denied(tmp_path) -> None:
    first = ProcessLock(tmp_path / ".lock")
    first.acquire()
    second = ProcessLock(tmp_path / ".lock")
    with pytest.raises(RuntimeError, match="另一 Forge 实例"):
        second.acquire()
    first.release()
    # 释放后重获成功（锁随持有者释放归还）
    third = ProcessLock(tmp_path / ".lock")
    third.acquire()
    third.release()


def test_config_lock_path_under_set_dir() -> None:
    assert LOCK_PATH.name == ".forge.lock"
    assert "sets" in LOCK_PATH.parts

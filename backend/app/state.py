"""应用级共享状态：settings 内存快照。

settings.json 为真相；本模块提供带缓存的读写入口，写操作同步落盘。
"""

from __future__ import annotations

import asyncio
from typing import Any

from . import config


class SettingsStore:
    """settings.json 的内存快照 + 落盘入口（单进程内 asyncio 锁）。"""

    def __init__(self) -> None:
        self._data: dict[str, Any] = config.load_settings()
        self._lock = asyncio.Lock()

    def get(self) -> dict[str, Any]:
        return self._data

    async def update(self, patch: dict[str, Any]) -> dict[str, Any]:
        """深度合并补丁并落盘（list 字段整体替换）。"""
        async with self._lock:
            merged = _deep_merge(self._data, patch)
            config.save_settings(merged)
            self._data = merged
            return merged


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    result = dict(base)
    for key, value in patch.items():
        if (
            key in result
            and isinstance(result[key], dict)
            and isinstance(value, dict)
        ):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


_store: SettingsStore | None = None


def get_settings() -> SettingsStore:
    global _store
    if _store is None:
        _store = SettingsStore()
    return _store

"""设置域 API：settings.json 读取/更新（模型三挡等细分页签后续补充）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ... import state

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("")
def get_settings():
    store = state.get_settings()
    return store.get()


@router.put("")
async def update_settings(patch: dict[str, Any]):
    store = state.get_settings()
    return await store.update(patch)

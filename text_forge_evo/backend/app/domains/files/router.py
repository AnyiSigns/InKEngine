"""文件域 API：挂载点注册/撤销/清单 + 目录浏览（沙箱内）。

挂载点模型（本地文件访问授权）：AI 只见显式授权的挂载点，磁盘
其余部分 fail-closed 不可见。注册/撤销 = 用户动作（挂载点数据走
storage 通道，撤销语义随补丁链管线接管）；浏览仅限挂载点内（read
级即满足），越界 403。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ... import boot
from .mounts import MOUNT_LEVEL_READ

router = APIRouter(prefix="/files", tags=["files"])


@router.get("/mounts")
async def list_mounts() -> dict:
    """挂载点清单（AI 可见的全部已授权目录）。"""
    app = await boot.init_app()
    mounts = await app.mount_registry.list_mounts()
    return {"mounts": [m.to_dict() for m in mounts]}


@router.post("/mounts")
async def register_mount(body: dict[str, Any]) -> dict:
    """注册挂载点（用户授权动作：路径 + 权限级 + 绑定应用）。"""
    path = body.get("path")
    if not path or not isinstance(path, str):
        raise HTTPException(status_code=422, detail="挂载点缺 path（字符串）")
    level = body.get("level") or MOUNT_LEVEL_READ
    app_name = body.get("app") or "forge"
    note = body.get("note") or ""
    app = await boot.init_app()
    try:
        record = await app.mount_registry.register(
            path=path, level=level, app=app_name, note=note
        )
    except PermissionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return record.to_dict()


@router.delete("/mounts/{mount_id}")
async def revoke_mount(mount_id: str) -> dict:
    """撤销挂载点（未找到显式拒绝）。"""
    app = await boot.init_app()
    try:
        await app.mount_registry.revoke(mount_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.get("/browse")
async def browse(path: str) -> dict:
    """挂载点内目录浏览（一层）；越界路径 fail-closed 403。"""
    app = await boot.init_app()
    result = await app.mount_registry.browse(path)
    if result is None:
        raise HTTPException(
            status_code=403,
            detail="路径不在已授权挂载点内（fail-closed，请先授权）",
        )
    return result

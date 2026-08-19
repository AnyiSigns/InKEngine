"""自指层观察端点：界面描述、事件类型、知识集快照与 ui_context 上报（只读 + 机制通道直写）。

观察通道的前端消费形态：boot 渲染器经 /api/self/ui 取当前界面
描述（JSON 布局），动态组件注册表经 /api/self/event-types 取事件
→ 渲染组件映射；响应均为深拷贝快照，消费方改写不反写引擎源数据。
ui_context（用户位置感知）属机制通道：位置快照与交互事件由前端
渲染器自动上报，字段白名单把关（不可伪造补丁链上下文），交互
事件带时间戳审计留痕（同时作行为信号源）。AI 提案/审批等写入口
随应用管线接入后开放。
"""

from __future__ import annotations

import copy
import time
import uuid

from fastapi import APIRouter, HTTPException

from ... import boot

router = APIRouter(prefix="/self", tags=["self"])

# ui_context 机制通道：位置快照字段白名单（渲染器契约；未知字段拒绝，
# 前端可直写但不可伪造补丁链上下文）
UI_CONTEXT_FIELDS = (
    "active_app",
    "active_view",
    "current_layout",
    "focused_component",
    "selection",
)
_COLLECTION_UI_CONTEXT = "ui_context"
_COLLECTION_UI_EVENTS = "ui_events"

# 交互事件字段长度上限（审计留痕有界，防日志膨胀）
_MAX_UI_EVENT_TYPE = 32
_MAX_UI_EVENT_COMPONENT = 64
_MAX_UI_EVENT_DETAIL = 200


@router.get("/ui")
async def current_ui() -> dict:
    """当前界面描述（未定形时为 null；渲染器据此显示占位）。"""
    app = await boot.init_app()
    return {
        "ui_spec": copy.deepcopy(
            app.introspection_service.snapshot_ui()["ui_spec"]
        )
    }


@router.get("/event-types")
async def event_types() -> dict:
    """已注册事件类型清单（渲染映射与折叠兜底的数据源）。"""
    app = await boot.init_app()
    registry = app.event_type_registry
    return {
        "count": len(registry.names()),
        "types": [
            {
                "name": spec.name,
                "renderer": spec.renderer,
                "system": spec.system,
                "meta": copy.deepcopy(spec.meta),
            }
            for spec in registry.specs()
        ],
    }


@router.get("/knowledge")
async def knowledge() -> dict:
    """知识集快照（孵化面板数据源：条目概览 + 按种类/层级统计）。

    与 inspect_knowledge 内省通道同源（观察通道统一语义）；条目写入
    走补丁链管线（写入路径唯一），本端点只读。
    """
    app = await boot.init_app()
    return app.introspection_service.snapshot_knowledge(limit=100)


@router.post("/ui/context")
async def report_ui_context(snapshot: dict) -> dict:
    """位置快照上报（渲染器契约）：字段白名单校验后落库（latest）。

    未知字段显式拒绝（防伪造上下文）；值仅接受字符串或 null（防
    结构注入）。快照为机制通道数据，回合感知时读取注入。
    """
    for key in snapshot:
        if key not in UI_CONTEXT_FIELDS:
            raise HTTPException(status_code=422, detail=f"未知 ui_context 字段: {key}")
        value = snapshot[key]
        if value is not None and not isinstance(value, str):
            raise HTTPException(
                status_code=422, detail=f"字段 {key} 须为字符串或 null"
            )
    app = await boot.init_app()
    await app.storage.put_record(_COLLECTION_UI_CONTEXT, "latest", dict(snapshot))
    return {"ok": True}


@router.post("/ui/event")
async def report_ui_event(body: dict) -> dict:
    """交互事件上报（点击/输入/切换）：带时间戳审计留痕。

    事件日志为审计载体（append-only 语义，历史不撒谎）；同时是
    行为信号源（演化侧汇入的原始素材）。
    """
    etype = body.get("type")
    if not etype or not isinstance(etype, str) or len(etype) > _MAX_UI_EVENT_TYPE:
        raise HTTPException(
            status_code=422,
            detail=f"交互事件缺 type（字符串，≤{_MAX_UI_EVENT_TYPE} 字符）",
        )
    component = body.get("component")
    detail = body.get("detail")
    if component is not None and not isinstance(component, str):
        raise HTTPException(status_code=422, detail="component 须为字符串")
    if detail is not None and not isinstance(detail, str):
        raise HTTPException(status_code=422, detail="detail 须为字符串")
    app = await boot.init_app()
    record = {
        "type": etype,
        "component": (component or "")[:_MAX_UI_EVENT_COMPONENT],
        "detail": (detail or "")[:_MAX_UI_EVENT_DETAIL],
        "ts": time.time(),
    }
    key = f"{record['ts']:.3f}-{uuid.uuid4().hex[:8]}"
    await app.storage.put_record(_COLLECTION_UI_EVENTS, key, record)
    return {"ok": True}

"""对话回合域：/api/chat SSE 流端点。

回合 = 引擎图一次执行：POST 进入后即返回 SSE 流，事件经
QueueTransport 桥直出（引擎信封 → data 帧，心跳防代理超时）。
模型未配置时返回可读错误（前端据此进入引导页）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from ink_engine.core.events import EngineEvent
from pydantic import BaseModel

from ... import boot
from ...transport import QueueTransport, sse_frame

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    message: str
    thread_id: str | None = None


class ResumeRequest(BaseModel):
    thread_id: str
    decision: str
    edited_content: dict | str | None = None
    reason: str | None = None


@router.post("")
async def chat(req: ChatRequest):
    """发起一个回合：返回 SSE 事件流（回合内全部引擎事件）。"""
    message = req.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="消息不能为空")
    app = await boot.init_app()
    llm = await app.resolve_llm()
    if llm is None:
        raise HTTPException(
            status_code=400, detail="模型未配置，请先完成模型设置"
        )
    await app.rebuild_engine(llm)
    if app.engine is None:
        raise HTTPException(status_code=503, detail="引擎未装配，请稍后重试")
    thread_id = req.thread_id or uuid.uuid4().hex
    round_id = uuid.uuid4().hex
    bridge = QueueTransport()

    async def runner() -> None:
        try:
            await app.engine.ainvoke(
                {"input": message, "thread_id": thread_id},
                thread_id=thread_id,
                round_id=round_id,
                transports=[bridge],
            )
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("回合执行失败")
            await bridge.send(
                EngineEvent(type="error", payload={"message": f"回合执行失败: {exc}"})
            )
        finally:
            bridge.close()

    task = asyncio.create_task(runner())

    async def stream():
        try:
            async for event in bridge.drain():
                yield sse_frame(event)
        finally:
            task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/resume")
async def resume(req: ResumeRequest):
    """审批决议注入：回合挂起（审批卡）后按决议重入续跑。

    决议语义（对齐引擎 approval 机制）：accept 执行 / reject 拒绝 /
    terminate 终止 / edit 带 edited_content 重校验后应用。注入键 =
    链尾挂起卡的 interrupt key（与挂起时一致，防错注入）。
    """
    app = await boot.init_app()
    if app.engine is None:
        raise HTTPException(status_code=503, detail="引擎未装配，请稍后重试")
    interrupt = await app.engine.get_latest_interrupt(req.thread_id)
    if interrupt is None:
        raise HTTPException(status_code=409, detail="该会话无挂起审批卡")
    # 重入锚点 = 挂起卡所在的 checkpoint（快照 + 注入值重入中断节点）
    latest = await app.storage.get_latest_checkpoint(req.thread_id)
    if latest is None or latest.interrupt is None:
        raise HTTPException(status_code=409, detail="挂起卡已失效，请重新发起回合")
    if req.decision not in ("accept", "reject", "edit", "terminate"):
        raise HTTPException(status_code=422, detail="决议须为 accept/reject/edit/terminate")
    inject = {"decision": req.decision}
    if req.edited_content is not None:
        if req.decision == "edit":
            # 补丁编辑：前端编辑框提交 JSON 文本 → 解析为对象（形态不符 422）
            if isinstance(req.edited_content, str):
                try:
                    parsed = json.loads(req.edited_content)
                except ValueError as exc:
                    raise HTTPException(
                        status_code=422, detail="edit 决议的 edited_content 须为 JSON 对象"
                    ) from exc
                req.edited_content = parsed
            if not isinstance(req.edited_content, dict):
                raise HTTPException(
                    status_code=422, detail="edit 决议须携带补丁对象（JSON dict）"
                )
        inject["edited_content"] = req.edited_content
    if req.reason:
        inject["reason"] = req.reason
    round_id = uuid.uuid4().hex
    bridge = QueueTransport()

    async def runner() -> None:
        try:
            await app.engine.ainvoke(
                {},
                thread_id=req.thread_id,
                round_id=round_id,
                resume_from=latest.checkpoint_id,
                inject={interrupt.key: inject},
                transports=[bridge],
            )
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.exception("决议重入执行失败")
            await bridge.send(
                EngineEvent(type="error", payload={"message": f"决议重入失败: {exc}"})
            )
        finally:
            bridge.close()

    task = asyncio.create_task(runner())

    async def stream():
        try:
            async for event in bridge.drain():
                yield sse_frame(event)
        finally:
            task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

"""对话回合域：/api/chat SSE 流端点。

回合 = 引擎图一次执行：POST 进入后即返回 SSE 流，事件经
QueueTransport 桥直出（引擎信封 → data 帧，心跳防代理超时）。
模型未配置时返回可读错误（前端据此进入引导页）。
"""

from __future__ import annotations

import asyncio
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

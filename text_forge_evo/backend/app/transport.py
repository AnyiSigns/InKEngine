"""SSE 传输桥：引擎事件信封 → SSE 数据帧。

QueueTransport 实现引擎的 EngineTransport 协议（``async send(EngineEvent)``）：
回合执行期间引擎把事件逐帧投入队列，SSE 响应端经 drain 逐帧消费直出
（引擎事件 to_dict 序列化，无中间层）。连接空闲时按心跳间隔产出
heartbeat 帧防代理超时；回合结束/连接断开后队列关闭。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

from ink_engine.core.events import EngineEvent, EngineTransport

HEARTBEAT_INTERVAL = 15.0


def sse_frame(data: dict[str, Any]) -> str:
    """事件字典 → SSE 数据帧（data: <json>\\n\\n）。"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


class QueueTransport(EngineTransport):
    """引擎传输实现：事件入队，SSE 端消费（队列哨兵收尾）。

    入队前把事件信封的 payload 字段摊平到帧顶层（保留 version/seq/
    trace_id 等信封字段）——前端事件协议消费扁平字段，摊平后直出
    即协议原生形态。
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._closed = False

    async def send(self, event: EngineEvent) -> None:
        if self._closed:
            return
        data = event.to_dict()
        payload = data.pop("payload") or {}
        data.update(payload)
        self._queue.put_nowait(data)

    def close(self) -> None:
        """关闭桥：消费端 drain 收到哨兵后结束。"""
        self._closed = True
        self._queue.put_nowait(None)

    async def drain(self) -> AsyncIterator[dict[str, Any]]:
        """逐帧产出事件字典；空闲时产出 heartbeat，哨兵后结束。"""
        while True:
            try:
                item = await asyncio.wait_for(
                    self._queue.get(), timeout=HEARTBEAT_INTERVAL
                )
            except TimeoutError:
                yield {"type": "heartbeat"}
                continue
            if item is None:
                break
            yield item

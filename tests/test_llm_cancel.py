"""流式中断（cancel 语义）单测：真实本地 SSE 服务器验证上游终止。

场景：消费方任务被取消（客户端中断）→ 引擎终止上游请求（连接关闭）。
服务端（stdlib http.server 线程）发首帧后持续保活，检测到连接断开
（写失败）即置 disconnected 标志——断言「上游已终止」而非仅客户端侧干净退出。
"""
from __future__ import annotations

import asyncio
import functools
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from engine_core.llm.base import LLMConfig
from engine_core.llm.messages import user
from engine_core.llm.openai_compat import OpenAICompatibleLLM

# 首帧后保活窗口（秒）：客户端取消后服务端应在此窗口内观察到断连
_KEEPALIVE_WINDOW_SECONDS = 10.0


class _SseHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args) -> None:
        pass

    def do_POST(self) -> None:
        server = self.server
        server.requests_seen += 1
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        first = b'data: {"choices":[{"delta":{"content":"\xe7\xac\xac\xe4\xb8\x80\xe5\x9d\x97"}}]}\n\n'
        try:
            self.wfile.write(first)
            self.wfile.flush()
            deadline = time.monotonic() + _KEEPALIVE_WINDOW_SECONDS
            while time.monotonic() < deadline:
                time.sleep(0.05)
                try:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    server.disconnected.set()
                    return
            # 客户端始终未断开（窗口耗尽）：测试视为失败态，置标志以便断言
            server.disconnected.set()
        except (BrokenPipeError, ConnectionResetError, OSError):
            server.disconnected.set()


class SseServer:
    """线程版极简 SSE 服务器（localhost，零外部依赖）。"""

    def __init__(self) -> None:
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_SseHandler))
        self._httpd.daemon_threads = True
        self._httpd.disconnected = threading.Event()
        self._httpd.requests_seen = 0
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_port}/v1"

    @property
    def disconnected(self) -> threading.Event:
        return self._httpd.disconnected

    @property
    def requests_seen(self) -> int:
        return self._httpd.requests_seen


@pytest.fixture
def sse_server():
    server = SseServer()
    server.start()
    yield server
    server.stop()


async def _drain(stream):
    async for _ in stream:
        pass


class TestCancelSemantics:
    async def test_cancel_terminates_upstream_request(self, sse_server):
        llm = OpenAICompatibleLLM(
            LLMConfig(
                adapter="openai_compat",
                model_id="test-model",
                base_url=sse_server.base_url,
                api_key="k",
                request_timeout=5.0,
            )
        )
        stream = llm.astream([user("hi")])
        first = await anext(stream)
        assert first.token == "第一块"

        task = asyncio.create_task(_drain(stream))
        await asyncio.sleep(0.1)  # 等待消费任务挂起在流上
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # 服务端视角：连接已被引擎终止（写保活失败）
        assert sse_server.disconnected.wait(5), "上游请求未被终止（服务端仍可写入）"

    async def test_normal_completion_closes_stream(self, sse_server):
        llm = OpenAICompatibleLLM(
            LLMConfig(
                adapter="openai_compat",
                model_id="test-model",
                base_url=sse_server.base_url,
                api_key="k",
                request_timeout=5.0,
            )
        )
        stream = llm.astream([user("hi")])
        chunks = [c.token async for c in stream]
        assert chunks == ["第一块"]
        # 正常迭代结束也关闭连接：服务端保活写入随即失败
        assert sse_server.disconnected.wait(5)

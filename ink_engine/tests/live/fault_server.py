"""本地故障端点（真实 OpenAI 兼容 SSE，引擎真实客户端访问）。

测试说明文档第六节：故障类用例在真实厂商端点不可控，此为全真实策略下唯一
可控替代——标准 HTTP/1.1 + text/event-stream 传输，engine 的
OpenAICompatibleLLM 用真实 httpx 客户端访问本端点，服务器按模式注入
故障：超时/429/坏帧/空流/error 帧/乱序增量/中途断开/取消悬挂。

模式选择：请求查询参数 ``?mode=xxx`` > 请求头 ``X-Fault-Mode`` >
服务器实例默认模式（``FaultServer(mode=...)``）。

模式清单：
- ok             标准流式成功（内容帧 + finish + [DONE]），真实协议零费用闭环
- http_429       HTTP 429 JSON 错误体（限流语义）
- http_401       HTTP 401 JSON 错误体（认证语义，fail-closed 不切备用）
- http_400       HTTP 400 JSON 错误体（非法请求语义）
- http_404       HTTP 404 JSON 错误体（模型不存在语义）
- http_500       HTTP 500 JSON 错误体（服务端错误语义）
- empty_stream   200 + 零数据帧（空流 → LLMEmptyStreamError）
- bad_frames     垃圾帧 + 正常帧（坏帧容错跳过）
- bad_frames_only 垃圾帧 + [DONE]（坏帧跳过且无有效帧 → 空流）
- error_frame    正常帧后 error 帧（code=rate_limit → LLMError 中流抛出）
- disconnect     少量帧后无 Content-Length 直接断连接（网络错误）
- timeout        延迟 delay 秒后才发响应头（客户端 request_timeout 更小 → 读超时）
- slow_stream    帧间延迟 delay 秒（流中读超时）
- reorder        finish_reason 帧先于内容帧（乱序增量，容错不中断）
- cancel         无限 keep-alive 流（配合客户端取消测试；断开即退出）

线程模型：ThreadingHTTPServer + daemon 线程，127.0.0.1:0 动态端口，
close() 时 shutdown 回收。
"""
from __future__ import annotations

import contextlib
import json
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse


def _sse_frame(obj: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()


def _chunk(role: str, delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
    choice: dict[str, Any] = {"index": 0, "delta": delta}
    if finish is not None:
        choice["finish_reason"] = finish
    return {"id": "fault-chunk", "object": "chat.completion.chunk", "choices": [choice]}


def _error_body(status: int, message: str, code: str) -> bytes:
    return json.dumps(
        {"error": {"message": message, "code": code, "type": "fault_injection"}},
        ensure_ascii=False,
    ).encode("utf-8")


class _FaultHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "InkEngineFaultServer/1.0"

    def log_message(self, *args: Any) -> None:  # 静默访问日志（测试输出噪音）
        pass

    def _mode(self) -> str:
        # 路径形态路由（单实例多模式）：base_url 带 /m/<mode> 段时按路径取
        # 模式——引擎请求路径恒为 base_url + /chat/completions，路径段可精确注入
        path = urlparse(self.path).path
        marker = "/m/"
        if marker in path:
            candidate = path.split(marker, 1)[1].split("/", 1)[0]
            if candidate:
                return candidate
        query = parse_qs(urlparse(self.path).query)
        if query.get("mode"):
            return query["mode"][0]
        header = self.headers.get("X-Fault-Mode")
        if header:
            return header
        return getattr(getattr(self.server, "fault", None), "mode", "ok")

    def do_POST(self) -> None:  # noqa: N802（http.server 钩子命名）
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            self.rfile.read(length)  # 丢弃请求体（模式已从 query/header 取）
        handler = getattr(self, f"_mode_{self._mode().replace('-', '_')}", self._mode_ok)
        with contextlib.suppress(BrokenPipeError, ConnectionError, OSError):
            handler()  # 客户端提前断开（超时/取消）后的写失败属预期噪音

    def do_GET(self) -> None:  # noqa: N802（http_fetch 端点真实抓取用）
        # GET 抓取场景默认返回非流式 JSON 文本（ok_json 语义）
        handler = getattr(self, f"_mode_{self._mode().replace('-', '_')}", self._mode_ok_json)
        with contextlib.suppress(BrokenPipeError, ConnectionError, OSError):
            handler()

    # ------------------------------------------------------------------
    # 模式实现
    # ------------------------------------------------------------------
    def _write_error(self, status: int, message: str, code: str) -> None:
        body = _error_body(status, message, code)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_sse(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # SSE 流以连接关闭为终止信号（无 Content-Length）：响应写完后
        # 服务端关闭连接，客户端读到 EOF 自然结束流
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

    def _mode_ok(self) -> None:
        self._send_sse()
        for token in ("你好", "，", "这是", "故障端点", "的", "标准", "流式", "响应"):
            self.wfile.write(_sse_frame(_chunk("assistant", {"content": token})))
            self.wfile.flush()
        self.wfile.write(_sse_frame(_chunk("assistant", {}, finish="stop")))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _mode_ok_json(self) -> None:
        body = json.dumps(
            {
                "id": "fault-completion",
                "object": "chat.completion",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": "这是非流式标准响应"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 9, "total_tokens": 14},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _mode_http_429(self) -> None:
        self._write_error(429, "rate limited, retry later", "rate_limit")

    def _mode_http_401(self) -> None:
        self._write_error(401, "invalid api key", "invalid_api_key")

    def _mode_http_400(self) -> None:
        self._write_error(400, "invalid request parameter", "invalid_request")

    def _mode_http_404(self) -> None:
        self._write_error(404, "model not found", "model_not_found")

    def _mode_http_500(self) -> None:
        self._write_error(500, "internal server error", "server_error")

    def _mode_empty_stream(self) -> None:
        self._send_sse()
        self.wfile.flush()  # 200 头部 + 零数据帧：空流语义

    def _mode_bad_frames(self) -> None:
        self._send_sse()
        self.wfile.write(b"garbage: not sse\n\n")
        self.wfile.write(b"data: {not-json}\n\n")
        self.wfile.write(_sse_frame(_chunk("assistant", {"content": "容错"})))
        self.wfile.write(_sse_frame(_chunk("assistant", {}, finish="stop")))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _mode_bad_frames_only(self) -> None:
        self._send_sse()
        self.wfile.write(b"garbage: not sse\n\n")
        self.wfile.write(b"data: {not-json}\n\n")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _mode_error_frame(self) -> None:
        self._send_sse()
        self.wfile.write(_sse_frame(_chunk("assistant", {"content": "先正常"})))
        self.wfile.flush()
        self.wfile.write(
            b"data: {\"error\": {\"code\": \"rate_limit\", \"message\": \"quota exceeded\"}}\n\n"
        )
        self.wfile.flush()

    def _mode_disconnect(self) -> None:
        # chunked 传输中途断开（不写终止 0-chunk）：客户端解析「流未完成」
        # → 传输异常 → LLMNetworkError（确定性；干净关闭会被视为正常流结束）
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        partial = _sse_frame(_chunk("assistant", {"content": "半截"}))
        self.wfile.write(f"{len(partial):x}\r\n".encode("ascii") + partial + b"\r\n")
        self.wfile.flush()
        with contextlib.suppress(OSError):
            self.connection.setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
            )
        self.wfile.close()

    def _mode_timeout(self) -> None:
        delay = float(getattr(getattr(self.server, "fault", None), "delay", 8.0))
        time.sleep(delay)  # 客户端 request_timeout 更小 → 读超时
        self._mode_ok()

    def _mode_slow_stream(self) -> None:
        delay = float(getattr(getattr(self.server, "fault", None), "delay", 3.0))
        self._send_sse()
        self.wfile.write(_sse_frame(_chunk("assistant", {"content": "慢"})))
        self.wfile.flush()
        time.sleep(delay)
        self.wfile.write(_sse_frame(_chunk("assistant", {}, finish="stop")))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _mode_reorder(self) -> None:
        self._send_sse()
        # 乱序增量：finish 帧先行，内容帧随后（客户端容错不中断）
        self.wfile.write(_sse_frame(_chunk("assistant", {}, finish="stop")))
        self.wfile.write(_sse_frame(_chunk("assistant", {"content": "乱序"})))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _mode_cancel(self) -> None:
        # 无限 keep-alive 流：连接保持打开（无 Connection: close），
        # 客户端取消断开后写失败即退出——配合客户端取消穿透用例
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        while True:
            self.wfile.write(b": keep-alive\n\n")
            self.wfile.flush()
            time.sleep(0.5)
            if self.wfile.closed or self.connection.fileno() < 0:
                break


class FaultServer:
    """本地故障端点实例（动态端口 127.0.0.1:0）。

    ``mode`` 为默认故障模式；``delay`` 供 timeout/slow_stream 注入延迟。
    每请求可用查询参数/请求头覆盖默认模式。
    """

    def __init__(self, mode: str = "ok", *, delay: float = 8.0) -> None:
        self.mode = mode
        self.delay = delay
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("FaultServer 未启动")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> FaultServer:
        server = ThreadingHTTPServer(("127.0.0.1", 0), _FaultHandler)
        server.mode = self.mode  # type: ignore[attr-defined]
        server.fault = self  # type: ignore[attr-defined]（动态读取 mode/delay）
        self._server = server
        self._thread = threading.Thread(target=server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None

    def __enter__(self) -> FaultServer:
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()

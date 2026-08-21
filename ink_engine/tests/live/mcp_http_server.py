"""本地真实 MCP http 传输 server（mcp SDK streamable http，动态端口）。

测试计划 §6：http 传输真实挂载用例。经 uvicorn 线程挂载
``Server.streamable_http_app()``（Starlette），提供 echo/adder 两个
确定性工具；127.0.0.1:0 动态端口，无外网依赖。
"""
from __future__ import annotations

import threading
import time

import uvicorn
from mcp.server.mcpserver import MCPServer

server = MCPServer("live-e2e-echo")


@server.tool()
async def echo(text: str) -> str:
    """回显传入文本。"""
    return text


@server.tool()
async def adder(a: int, b: int) -> int:
    """两个整数相加。"""
    return a + b


class McpHttpServer:
    """动态端口 uvicorn 线程挂载 streamable http app。"""

    def __init__(self) -> None:
        self._thread: threading.Thread | None = None
        self._uvicorn: uvicorn.Server | None = None
        self.url: str | None = None

    def start(self) -> McpHttpServer:
        app = server.streamable_http_app(streamable_http_path="/mcp")
        config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
        runner = uvicorn.Server(config)
        self._uvicorn = runner
        self._thread = threading.Thread(target=runner.run, daemon=True)
        self._thread.start()
        for _ in range(200):  # 等待监听就绪（动态端口需从 socket 取）
            if runner.started and runner.servers:
                host, port = runner.servers[0].sockets[0].getsockname()[:2]
                self.url = f"http://{host}:{port}/mcp"
                break
            time.sleep(0.05)
        if self.url is None:
            raise RuntimeError("MCP http server 启动超时")
        return self

    def stop(self) -> None:
        if self._uvicorn is not None:
            self._uvicorn.should_exit = True
            if self._thread is not None:
                self._thread.join(timeout=10.0)


def start_mcp_http_server() -> McpHttpServer:
    return McpHttpServer().start()

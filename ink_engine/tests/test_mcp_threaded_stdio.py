"""自写 MCP stdio 传输（线程私有事件循环）单测。

覆盖：真实 stdio server 全链路（open/list_tools/call_tool/ping/
aclose）；**跨独立事件循环**调用（open 在 loop A、调用在 loop B、
关闭在 loop C——模拟 headless 壳每次 ``tokio::run`` 新建并销毁
event loop 的嵌入环境）；server 业务拒绝（-32602）与结果 is_error
的收敛；server→client 请求应答（ping）；真实进程崩溃的监督拉起
（``_McpConnectionLost`` 判定 + ``_SupervisedStdioSession`` 重建）。

测试 server 为纯标准库脚本（不依赖 mcp SDK），保证传输层测试独立
于任何第三方封装。
"""
from __future__ import annotations

import asyncio
import sys

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.mcp_client import (
    CONTENT_LENGTH_FRAMING,
    JSON_LINES_FRAMING,
    McpClientManager,
    McpServerConfig,
    McpToolImportError,
    McpTransport,
    StdioRestartPolicy,
    _SupervisedStdioSession,
    _SdkSession,
)
from ink_engine.core.tool_vetting import ToolSource

# 最小 MCP stdio server（纯标准库）：echo_text 工具 + ping 应答 +
# server→client ping 请求应答 + 可选故障注入。帧形态由 ECHO_FRAMING
# 决定（缺省 json_lines，匹配本环境 SDK 2.x/inkling_exec 形态）；
# content_length 模式覆盖 MCP 旧标准分帧（读侧自适应兼容）。
# - ECHO_CRASH_FILE=<path>：首次 tools/call 时写标记文件并 exit(1)
#   （崩溃后拉起的新进程继续正常——验证监督拉起）；
# - ECHO_DIE_ON_START=1：进程启动即 exit(1)（拉起也失败——验证熔断）。
_ECHO_SERVER = r'''
import json
import os
import sys

CRASH_FILE = os.environ.get("ECHO_CRASH_FILE", "")
DIE_ON_START = os.environ.get("ECHO_DIE_ON_START", "")
FRAMING = os.environ.get("ECHO_FRAMING", "json_lines")
if DIE_ON_START:
    sys.exit(1)

def send(payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if FRAMING == "content_length":
        sys.stdout.buffer.write(
            b"Content-Length: %d\r\n\r\n" % len(body) + body
        )
    else:
        sys.stdout.buffer.write(body + b"\n")
    sys.stdout.buffer.flush()

def read_msg():
    if FRAMING == "content_length":
        headers = {}
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                sys.exit(0)
            if line in (b"\r\n", b"\n"):
                break
            key, _, value = line.decode("utf-8").partition(":")
            headers[key.strip().lower()] = value.strip()
        length = int(headers.get("content-length", 0))
        return json.loads(sys.stdin.buffer.read(length))
    line = sys.stdin.buffer.readline()
    if not line:
        sys.exit(0)
    return json.loads(line.decode("utf-8"))

def reply(req_id, result=None, error=None):
    if error is not None:
        send({"jsonrpc": "2.0", "id": req_id, "error": error})
    else:
        send({"jsonrpc": "2.0", "id": req_id, "result": result})

msg = read_msg()
assert msg["method"] == "initialize", msg
reply(
    msg["id"],
    {"protocolVersion": "2025-03-26", "capabilities": {},
     "serverInfo": {"name": "echo", "version": "1"}},
)

while True:
    msg = read_msg()
    method = msg.get("method")
    if method == "notifications/initialized":
        continue
    if method == "tools/list":
        reply(msg["id"], {"tools": [
            {"name": "echo_text", "description": "echo a text",
             "inputSchema": {"type": "object",
                             "properties": {"text": {"type": "string"}}}},
        ]})
    elif method == "tools/call":
        if CRASH_FILE and not os.path.exists(CRASH_FILE):
            with open(CRASH_FILE, "w") as f:
                f.write("crashed")
            sys.stderr.write('{"level":"info","msg":"dying"}\n')
            sys.stderr.flush()
            sys.exit(1)
        params = msg.get("params", {})
        args = params.get("arguments", {}) or {}
        name = params.get("name")
        if name == "echo_text":
            reply(msg["id"], {"content": [{"type": "text",
                                           "text": str(args.get("text", ""))}],
                              "isError": False})
        elif name == "reject":
            reply(msg["id"], error={"code": -32602,
                                    "message": "invalid params"})
        elif name == "fail":
            reply(msg["id"], {"content": [{"type": "text",
                                           "text": "boom"}],
                              "isError": True})
        else:
            reply(msg["id"], error={"code": -32601,
                                    "message": f"method not found: {name}"})
    elif method == "ping":
        reply(msg["id"], {})
    else:
        reply(msg["id"], error={"code": -32601,
                                "message": f"method not found: {method}"})
'''


def _config(*, crash_file=None, die_on_start=False, framing=JSON_LINES_FRAMING,
            **extra) -> McpServerConfig:
    env = {"ECHO_FRAMING": framing}
    if crash_file is not None:
        env["ECHO_CRASH_FILE"] = str(crash_file)
    if die_on_start:
        env["ECHO_DIE_ON_START"] = "1"
    return McpServerConfig(
        id="echo",
        transport=McpTransport.STDIO,
        command=sys.executable,
        args=("-c", _ECHO_SERVER),
        env=env,
        source=ToolSource.MARKET,
        stdio_framing=framing,
        **extra,
    )


def _run_in_new_loop(coro_factory):
    """在全新事件循环里执行协程工厂（模拟 headless 每 op 独立 loop）。"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro_factory())
    finally:
        loop.close()


class TestThreadedStdioTransport:
    async def test_full_chain_real_server(self):
        """真实 stdio server：open → list_tools → call_tool → ping → close。"""
        session = await _SdkSession.open(_config())
        try:
            tools = await session.list_tools()
            assert len(tools) == 1
            assert tools[0]["name"] == "echo_text"
            out = await session.call_tool("echo_text", {"text": "hello"})
            assert out == "hello"
            await session.ping()
        finally:
            await session.aclose()

    def test_cross_independent_event_loops(self):
        """跨独立事件循环稳定（headless 每次 tokio::run 新建 loop）。

        open 在 loop A、list_tools/call_tool 在 loop B、aclose 在 loop C
        ——传输生命周期绑工作线程私有 loop，与调用侧 loop 无关。
        """
        session = _run_in_new_loop(lambda: _SdkSession.open(_config()))
        try:
            tools = _run_in_new_loop(lambda: session.list_tools())
            assert [t["name"] for t in tools] == ["echo_text"]
            out = _run_in_new_loop(
                lambda: session.call_tool("echo_text", {"text": "x"})
            )
            assert out == "x"
            # 多次跨 loop 调用累积（每轮模拟一个新 op）
            out2 = _run_in_new_loop(
                lambda: session.call_tool("echo_text", {"text": "y"})
            )
            assert out2 == "y"
        finally:
            _run_in_new_loop(lambda: session.aclose())

    async def test_business_reject_maps_to_graph_error(self):
        """server 返回 JSON-RPC error（-32602 参数校验）→ 业务错误。"""
        session = await _SdkSession.open(_config())
        try:
            with pytest.raises(GraphDefinitionError, match="MCP 工具执行失败"):
                await session.call_tool("reject", {})
        finally:
            await session.aclose()

    async def test_result_is_error_maps_to_graph_error(self):
        """server 返回 isError=true → 业务错误（提取失败文本）。"""
        session = await _SdkSession.open(_config())
        try:
            with pytest.raises(GraphDefinitionError, match="boom"):
                await session.call_tool("fail", {})
        finally:
            await session.aclose()

    async def test_unknown_tool_server_replies_not_found(self):
        """未知方法 → server 回 -32601 → 业务拒绝收敛为 GraphDefinitionError。"""
        session = await _SdkSession.open(_config())
        try:
            with pytest.raises(GraphDefinitionError):
                await session.call_tool("nope", {})
        finally:
            await session.aclose()

    async def test_clean_close_no_lingering_tasks(self):
        """aclose 确定性收尾：进程终止、无残留 pending、可重开。"""
        session = await _SdkSession.open(_config())
        transport = session._transport
        assert transport is not None
        await session.aclose()
        assert transport._thread is not None
        assert not transport._thread.is_alive()
        assert transport._pending == {}
        # 重开新会话（原连接已彻底释放，不冲突）
        session2 = await _SdkSession.open(_config())
        try:
            assert await session2.call_tool("echo_text", {"text": "again"}) == "again"
        finally:
            await session2.aclose()

    async def test_content_length_legacy_framing(self):
        """MCP 旧标准 Content-Length 分帧（写侧配置、读侧自适应）兼容。"""
        session = await _SdkSession.open(_config(framing=CONTENT_LENGTH_FRAMING))
        try:
            tools = await session.list_tools()
            assert [t["name"] for t in tools] == ["echo_text"]
            assert await session.call_tool("echo_text", {"text": "cl"}) == "cl"
        finally:
            await session.aclose()

    async def test_connect_failure_wraps_import_error(self):
        """命令不存在 → start 失败统一收敛为 McpToolImportError。"""
        config = McpServerConfig(
            id="nope", transport=McpTransport.STDIO,
            command="definitely-not-a-real-binary-xyz",
        )
        with pytest.raises(McpToolImportError, match="连接失败"):
            await _SdkSession.open(config)


class TestThreadedStdioSupervision:
    async def test_real_process_crash_pulls_up(self, tmp_path):
        """真实进程崩溃（首次 tools/call 后 exit）→ _McpConnectionLost 判定 →
        监督拉起 + 重试一次原操作成功（E-P15）。"""
        crash_file = tmp_path / "crash.marker"
        config = _config(
            crash_file=crash_file,
            restart_policy=StdioRestartPolicy(max_retries=1, backoff=0.0),
        )
        manager = McpClientManager()
        supervised = await manager.connect(config)
        assert isinstance(supervised, _SupervisedStdioSession)
        try:
            # 首次调用触发真实进程崩溃 → 拉起新进程 → 重试一次成功
            out = await supervised.call_tool("echo_text", {"text": "x"})
            assert out == "x"
            assert supervised.consecutive_failures == 0
            # 第二次调用命中新会话，正常
            assert await supervised.call_tool("echo_text", {"text": "ok"}) == "ok"
        finally:
            await supervised.aclose()

    async def test_circuit_break_after_repeated_real_crashes(self):
        """真实进程反复启动即崩 → 拉起耗尽 → 熔断打开 → fail-closed。"""
        config = _config(
            die_on_start=True,
            restart_policy=StdioRestartPolicy(
                max_retries=1, backoff=0.0, circuit_break_threshold=2
            ),
        )
        supervised = _SupervisedStdioSession(config)
        try:
            for _ in range(2):
                with pytest.raises(McpToolImportError, match="崩溃"):
                    await supervised.call_tool("echo_text", {"text": "x"})
            assert supervised.circuit_open is True
            with pytest.raises(McpToolImportError, match="熔断已打开"):
                await supervised.call_tool("echo_text", {"text": "x"})
        finally:
            await supervised.aclose()

"""终端事件传输单测：帧渲染 + 传输聚合语义。

覆盖：render_frame 各事件类型输出（思考聚合/工具行/正文缓冲收尾/
错误/心跳忽略/未知类型折叠一行摘要）、TerminalTransport 全序列
输出行序、附加模式 SSE 流解析渲染（HTTP 假服务）。
"""
from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from ink_engine.core.events import EngineEvent

from app import cli
from app.terminal import TerminalTransport, render_frame


def _render(frame: dict, lines: list[str], thinking: list[str], reply: list[str]) -> None:
    render_frame(frame, lines.append, thinking, reply)


def test_render_thinking_aggregation() -> None:
    # 思考 token 缓冲聚合：thinking_end 输出整段（strip 后非空才打印）
    lines: list[str] = []
    thinking: list[str] = []
    reply: list[str] = []
    _render({"type": "thinking_start"}, lines, thinking, reply)
    _render({"type": "thinking_token", "token": "让我"}, lines, thinking, reply)
    _render({"type": "thinking_token", "token": "想想"}, lines, thinking, reply)
    _render({"type": "thinking_end"}, lines, thinking, reply)
    assert lines == ["[思考]", "  让我想想"]


def test_render_empty_thinking_silent() -> None:
    # 空思考卡不输出正文行（只留状态行，防刷屏）
    lines: list[str] = []
    thinking: list[str] = []
    reply: list[str] = []
    _render({"type": "thinking_start"}, lines, thinking, reply)
    _render({"type": "thinking_end"}, lines, thinking, reply)
    assert lines == ["[思考]"]


def test_render_tool_and_reply_and_end() -> None:
    lines: list[str] = []
    thinking: list[str] = []
    reply: list[str] = []
    _render({"type": "tool_start", "tool": "inspect_graph"}, lines, thinking, reply)
    _render({"type": "tool_end", "tool": "inspect_graph", "success": True}, lines, thinking, reply)
    _render({"type": "reply_token", "token": "你好"}, lines, thinking, reply)
    _render({"type": "reply_token", "token": "世界"}, lines, thinking, reply)
    _render({"type": "end", "reply": "你好世界"}, lines, thinking, reply)
    assert lines == [
        "[工具] inspect_graph 调用中",
        "[工具] inspect_graph 完成",
        "Forge: 你好世界",
    ]


def test_render_tool_failure_with_message() -> None:
    lines: list[str] = []
    thinking: list[str] = []
    reply: list[str] = []
    _render(
        {"type": "tool_end", "tool": "inspect_x", "success": False, "message": "执行被拒: 权限不足"},
        lines,
        thinking,
        reply,
    )
    assert lines == ["[工具] inspect_x 失败 · 执行被拒: 权限不足"]


def test_render_error_heartbeat_unknown() -> None:
    lines: list[str] = []
    thinking: list[str] = []
    reply: list[str] = []
    _render({"type": "heartbeat"}, lines, thinking, reply)
    _render({"type": "error", "message": "模型调用失败"}, lines, thinking, reply)
    _render({"type": "mystery_event", "step_id": "x"}, lines, thinking, reply)
    assert lines[0] == "[错误] 模型调用失败"
    assert lines[1].startswith("[事件] mystery_event")


def test_terminal_transport_sequence() -> None:
    # 完整事件序列 → 输出行序（信封 → 摊平帧 → 渲染）
    lines: list[str] = []
    transport = TerminalTransport(write=lines.append)
    events = [
        EngineEvent(type="thinking_start"),
        EngineEvent(type="thinking_token", payload={"token": "观察中"}),
        EngineEvent(type="thinking_end"),
        EngineEvent(type="tool_start", payload={"tool": "inspect_graph"}),
        EngineEvent(type="tool_audit", payload={"tool": "inspect_graph", "decision": "ok"}),
        EngineEvent(type="tool_end", payload={"tool": "inspect_graph", "success": True}),
        EngineEvent(type="reply_token", payload={"token": "完成"}),
        EngineEvent(type="end", payload={"reply": "完成"}),
    ]

    async def pump() -> None:
        for event in events:
            await transport.send(event)

    asyncio.run(pump())
    assert lines == [
        "[思考]",
        "  观察中",
        "[工具] inspect_graph 调用中",
        "[工具] inspect_graph 完成",
        "Forge: 完成",
    ]


def test_attach_round_streams_frames(monkeypatch, capsys) -> None:
    # 附加模式：SSE 流（假 HTTP 服务）→ 终端渲染（协议直通验证）
    frames = [
        {"type": "thinking_start"},
        {"type": "thinking_token", "token": "让我想想"},
        {"type": "thinking_end"},
        {"type": "reply_token", "token": "你好"},
        {"type": "reply_token", "token": "世界"},
        {"type": "end", "reply": "你好世界"},
    ]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for frame in frames:
                line = f"data: {json.dumps(frame, ensure_ascii=False)}\n\n"
                self.wfile.write(line.encode("utf-8"))
            self.wfile.flush()

        def log_message(self, *args) -> None:  # 静默访问日志
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(cli, "WEB_PORT", port)
    try:
        code = asyncio.run(cli._attach_round("你好"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    out = capsys.readouterr().out
    assert code == 0
    assert "附加对话" in out
    assert "让我想想" in out
    assert "Forge: 你好世界" in out


def test_chat_loop_local_holds_lock_until_quit(monkeypatch, capsys) -> None:
    # 交互终端本地模式：会话全程持锁，/quit 后统一释放（回合间不释放）
    from app import boot
    from app.boot import ForgeApp
    from tests.test_round import FakeLLM

    async def _fake_resolve(_self):
        return FakeLLM()

    monkeypatch.setattr(ForgeApp, "resolve_llm", _fake_resolve)
    answers = iter(["介绍一下你自己", "/quit"])

    def fake_input(_prompt: str = "") -> str:
        try:
            return next(answers)
        except StopIteration as exc:
            raise EOFError from exc

    monkeypatch.setattr("builtins.input", fake_input)
    code = asyncio.run(cli.chat_loop())
    out = capsys.readouterr().out
    assert code == 0
    assert "Forge: 我是 Forge，这是观察后的回复。" in out
    # 会话结束后装配产物与锁一并释放（close_app 幂等）
    assert boot._app is None


async def test_run_cli_round_stale_lock_reports(monkeypatch, capsys) -> None:
    # 锁文件残留（锁失败 + 端口无实例）：明确提示，不静默转附加
    from app import boot

    async def _fail_init(*_args, **_kwargs):
        raise RuntimeError("另一 Forge 实例正在运行")

    async def _dead_port() -> bool:
        return False

    monkeypatch.setattr(boot, "init_app", _fail_init)
    monkeypatch.setattr(cli, "_port_alive", _dead_port)
    code = await cli.run_cli_round("你好")
    out = capsys.readouterr().out
    assert code == 1
    assert "未在监听" in out


async def test_run_cli_round_attaches_when_port_alive(monkeypatch, capsys) -> None:
    # 锁失败但端口有实例：进入附加模式（HTTP 转发到运行中实例）
    from app import boot

    async def _fail_init(*_args, **_kwargs):
        raise RuntimeError("另一 Forge 实例正在运行")

    async def _live_port() -> bool:
        return True

    async def _fake_attach(_text: str) -> int:
        print("附加对话（桩）")
        return 0

    monkeypatch.setattr(boot, "init_app", _fail_init)
    monkeypatch.setattr(cli, "_port_alive", _live_port)
    monkeypatch.setattr(cli, "_attach_round", _fake_attach)
    code = await cli.run_cli_round("你好")
    out = capsys.readouterr().out
    assert code == 0
    assert "附加对话" in out

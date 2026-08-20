"""对话回合 HTTP 级测试：/api/chat SSE 流端到端。"""

from __future__ import annotations

import json

from tests.test_round import FakeLLM


def test_chat_streams_events_via_sse(client, monkeypatch) -> None:
    # 类级注入假模型：路由取用的 resolve_llm 走同一实现（跨事件循环安全）
    from app.boot import ForgeApp

    async def _fake_resolve(_self):
        return FakeLLM()

    monkeypatch.setattr(ForgeApp, "resolve_llm", _fake_resolve)

    frames: list[dict] = []
    with client.stream(
        "POST", "/api/chat", json={"message": "介绍一下你自己"}
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")
        for line in resp.iter_lines():
            if line.startswith("data: "):
                frames.append(json.loads(line[6:]))

    types = [frame["type"] for frame in frames]
    assert "thinking_start" in types
    assert "tool_start" in types
    assert "tool_end" in types
    assert "reply_token" in types
    assert types[-1] == "end"
    tool_start = next(f for f in frames if f["type"] == "tool_start")
    assert tool_start["tool"] == "inspect_graph"
    assert tool_start["step_id"] == "tool:call_1"
    assert tool_start["round_id"]
    tool_end = next(f for f in frames if f["type"] == "tool_end")
    assert tool_end["success"] is True
    end = frames[-1]
    assert "我是 Forge" in end["reply"]
    assert end["round_id"]
    assert end["thread_id"]


def test_chat_empty_message_rejected(client) -> None:
    resp = client.post("/api/chat", json={"message": "   "})
    assert resp.status_code == 400

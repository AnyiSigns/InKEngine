"""MCP 生态接入端点单测：/api/mcp 挂载/清单/卸载契约。

覆盖：请求形态校验（transport 白名单 / 空 id / 缺 server_id 的 422）、
挂载失败 502（fail-closed）、空清单与未知 server 卸载语义、以注入
假会话的完整挂载 → 清单 → 卸载闭环（host 装配接线经 HTTP 层贯通）。
"""
from __future__ import annotations

from ink_engine.core.mcp_client import McpToolImportError

from app import boot


class _FakeSession:
    def __init__(self, tools) -> None:
        self._tools = tools

    async def list_tools(self):
        return list(self._tools)

    async def call_tool(self, name, args):
        return f"result-of-{name}"

    async def aclose(self) -> None:
        return None


def _fake_connect(fail_message=None):
    async def connect(config):
        if fail_message is not None:
            raise McpToolImportError(fail_message)
        app = boot.get_app()
        app.mcp_manager.register_session(
            config.id,
            _FakeSession(
                [
                    {
                        "name": "t1",
                        "description": "外部工具",
                        "inputSchema": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}}
                        },
                    }
                ]
            ),
        )
        return app.mcp_manager._sessions[config.id]

    return connect


def test_mount_rejects_excluded_transport(client) -> None:
    # 内存传输只供宿主内注入，API 白名单外 = 422
    resp = client.post(
        "/api/mcp/mount", json={"id": "s1", "transport": "in_memory"}
    )
    assert resp.status_code == 422


def test_mount_rejects_blank_id(client) -> None:
    resp = client.post("/api/mcp/mount", json={"id": "", "url": "http://x"})
    assert resp.status_code == 422


def test_servers_starts_empty(client) -> None:
    resp = client.get("/api/mcp/servers")
    assert resp.status_code == 200
    assert resp.json() == {"servers": []}


def test_unmount_missing_server_id_rejected(client) -> None:
    resp = client.post("/api/mcp/unmount", json={})
    assert resp.status_code == 422


def test_unmount_unknown_server_reports_not_removed(client) -> None:
    resp = client.post("/api/mcp/unmount", json={"server_id": "ghost"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "removed": False}


def test_mount_connection_failure_returns_502(client, monkeypatch) -> None:
    # 连接失败 = 502 fail-closed（宿主转拒绝语义，不伪装成功）
    app = boot.get_app()
    monkeypatch.setattr(
        app.mcp_manager, "connect", _fake_connect(fail_message="模拟连接失败")
    )
    resp = client.post("/api/mcp/mount", json={"id": "s2", "url": "http://x"})
    assert resp.status_code == 502
    assert "模拟连接失败" in resp.json()["detail"]


def test_mount_list_unmount_round_trip(client, monkeypatch) -> None:
    app = boot.get_app()
    monkeypatch.setattr(app.mcp_manager, "connect", _fake_connect())

    resp = client.post(
        "/api/mcp/mount",
        json={
            "id": "s1",
            "transport": "http",
            "url": "http://x",
            "source": "market",
            "headers": {"Authorization": "Bearer t"},
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True and data["server_id"] == "s1"
    assert data["tools"] == ["t1"]
    # 工具进入动态表（回合可用）
    assert "t1" in app.tool_registry

    servers = client.get("/api/mcp/servers").json()
    assert servers == {"servers": ["s1"]}

    unmount = client.post("/api/mcp/unmount", json={"server_id": "s1"})
    assert unmount.status_code == 200
    assert unmount.json() == {"ok": True, "removed": True}
    assert client.get("/api/mcp/servers").json() == {"servers": []}
    assert "t1" not in app.tool_registry

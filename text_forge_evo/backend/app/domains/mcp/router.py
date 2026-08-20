"""MCP 生态接入端点：挂载/列出/卸载外部 MCP server（借外部工具进引擎）。

挂载 = 能力缺口闭环的「生态借用」形态：用户/AI 经本端点把外部 MCP
server 的工具借为引擎声明式工具，走统一工具流水线（vetting 闸门 +
权限门禁 + 沙箱守卫 + 审计留痕），连接失败/工具被拒/工具名冲突均
fail-closed 拒绝（不静默降级）。离线环境（无 server）时本端点返回
502，但内建工具集照常，自举不依赖外部生态。

配置数据形态（McpServerConfig 同名契约）：传输 http/stdio 两种暴露
形态；http 须 url、stdio 须 command；in_memory 仅供宿主内侧注入
（本端点不暴露）；headers 供需要鉴权请求头的远程 server 使用，
注意其非凭证安全存储（留意服务端日志脱敏）。
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from ink_engine.core.mcp_client import (
    McpServerConfig,
    McpToolImportError,
    McpTransport,
)
from ink_engine.core.tool_vetting import ToolSource
from pydantic import BaseModel, Field

from ... import boot

router = APIRouter(prefix="/mcp", tags=["mcp"])


class MountRequest(BaseModel):
    """挂载请求（McpServerConfig 的传输层契约；server_factory 不外露）。"""

    id: str = Field(..., min_length=1, description="server 唯一标识（权限域 mcp:call:<id>）")
    transport: Literal["http", "stdio"] = Field(
        "http", description="传输形态（内存形态仅供宿主内注入，不对外暴露）"
    )
    url: str | None = Field(None, description="http 传输的 Streamable HTTP 端点")
    headers: dict[str, str] | None = Field(
        None, description="http 附加请求头（鉴权场景；注意脱敏）"
    )
    command: str | None = Field(None, description="stdio 传输的本地可执行命令")
    args: list[str] = Field(default_factory=list, description="stdio 命令参数")
    source: Literal["market", "github", "ai_generated", "unknown"] = Field(
        "unknown", description="工具来源分类（vetting 可信度依据）"
    )


class UnmountRequest(BaseModel):
    """卸载请求（server 标识即请求体）。"""

    server_id: str = Field(..., min_length=1, description="要断开的 server 标识")


def _build_config(body: MountRequest) -> McpServerConfig:
    """请求 → McpServerConfig（枚举转换失败 422，形态在模型层已约束）。"""
    try:
        transport = McpTransport(body.transport)
        source = ToolSource(body.source)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return McpServerConfig(
        id=body.id,
        transport=transport,
        url=body.url,
        headers=dict(body.headers) if body.headers else None,
        command=body.command,
        args=tuple(body.args),
        source=source,
    )


@router.post("/mount")
async def mount_mcp(body: MountRequest) -> dict[str, Any]:
    """挂载外部 MCP server：连接 → 导入工具（vetting 闸门过滤）→ 注册
    进工具表。返回导入的工具名清单；连接/导入失败 = 502（fail-closed）。"""
    app = await boot.init_app()
    config = _build_config(body)
    try:
        tools = await app.mount_mcp_server(config)
    except McpToolImportError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"ok": True, "server_id": config.id, "tools": tools}


@router.get("/servers")
async def list_mcp() -> dict[str, Any]:
    """已连接 server 清单（会话路由密钥，供卸载参考）。"""
    app = await boot.init_app()
    return {"servers": app.mcp_manager.list_servers()}


@router.post("/unmount")
async def unmount_mcp(body: UnmountRequest) -> dict[str, Any]:
    """断开并注销外部 MCP server：会话关闭、导入的工具撤出工具表。"""
    app = await boot.init_app()
    removed = await app.unmount_mcp_server(body.server_id)
    return {"ok": True, "removed": removed}

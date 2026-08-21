"""MCP 挂载 e2e：双入口 + 三传输闭环 + 出厂零预挂 + 挂载/拒绝/回退/对话安装。

PLAN §6 M3 挂载验收四用例各一条：
- 挂载：设置页「连接」一键挂载（市场目录数据源 → vetting → L2 → 补丁链）；
- 拒绝：审批拒绝 → 不落链、会话清理、审计留痕；
- 回退：补丁链回退 → 工具失效、会话断开、链版本还原；
- 对话安装：propose_mcp_mount 声明式工具（地址解析 → 配置推导 →
  vetting 核对 → 审批卡预览可 edit 重走校验链 → L2 → 补丁链）。

三传输闭环（http/stdio/in_memory）：经引擎 McpClientManager 全链路
连接 → 导入 → 调用（mcp SDK 2.x；stdio 用真实 Rust 执行件，http 用
uvicorn 承载 fixture server，in_memory 用嵌入式 server 工厂）。
"""
from __future__ import annotations

import asyncio
import copy
import json
from contextlib import suppress
from typing import Any

import pytest
from conftest import SEED_ROOT, ScriptedApprovalCtx, load_seed
from fixtures.mcp_fixture_server import build_echo_server, build_server
from ink_engine.core.mcp_client import McpServerConfig, McpTransport

from host.mcp_service import in_memory_server_factory

MARKET = load_seed("mcp_market.json")


def _market_with(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """市场数据副本 + 测试条目（市场是数据，测试注入本地可离线条目）。"""
    market = copy.deepcopy(MARKET)
    market["servers"] = [*market["servers"], *entries]
    return market


_IN_MEMORY_ECHO_ENTRY: dict[str, Any] = {
    "id": "test.echo",
    "name": "测试回声 server（嵌入式）",
    "source": "e2e fixture",
    "transport": "in_memory",
    "url": None,
    "command": None,
    "args": [],
    "credentials": {"required": False},
    "risk": "low",
    "risk_note": "e2e 离线测试条目",
    "category": "fixture",
    "premounted": False,
}


async def _boot(market: dict[str, Any] | None = None):
    """独立装配（MCP 用例需要自定义市场数据时用，缺省走标准市场）。"""
    from conftest import StubLLM, boot_runtime

    return await boot_runtime(llm=StubLLM(), market=market)


# ── 出厂零预挂 ──


async def test_market_zero_premount(booted):
    """出厂零预挂断言：市场是候选清单，boot 后无任何会话/挂载工具。"""
    runtime, _host, mount_service = booted
    assert runtime.mcp_manager.list_servers() == []
    assert mount_service.mounted_servers == ()
    assert MARKET["premounted"] is False
    assert len(MARKET["servers"]) >= 2  # 目录有候选（示例条目）但零预挂


# ── 一键挂载（设置页「连接」） ──


async def test_mount_from_market_in_memory(storage_uri, approval_ctx):
    """一键挂载：市场条目 id → 配置推导 → vetting → L2 批准 → 补丁链挂载。"""
    market = _market_with([_IN_MEMORY_ECHO_ENTRY])
    runtime, _host, mount_service = await _boot(market)
    try:
        ctx = approval_ctx()
        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok, outcome.error
        assert outcome.status == "mounted"
        assert "echo" in outcome.tool_names
        assert mount_service.mounted_servers == ("test.echo",)
        # 工具进统一工具表（挂载即生效）
        assert "echo" in runtime.tool_registry
        # 工具可经统一流水线调用
        spec = runtime.tool_registry["echo"]
        text = await _call_tool(runtime, spec, {"message": "你好"})
        assert text == "echo: 你好"
        # 补丁链留痕（权威记录，重启可恢复）
        audit = await runtime.self_pipeline.audit_log()
        assert any(record.get("status") == "applied" for record in audit)
        # 回退卸载（保持环境干净）
        unmounted = await mount_service.unmount(ctx, "test.echo")
        assert unmounted.ok, unmounted.error
    finally:
        await runtime.stop()


async def _call_tool(runtime: Any, spec: Any, args: dict[str, Any]) -> str:
    """经统一工具流水线调用（权限/审计机制全生效）。"""
    outcome = await runtime.tool_pipeline.execute(_SilentCtx(), spec, args)
    assert outcome.ok, outcome.error
    return outcome.output


class _SilentCtx:
    """流水线执行 ctx（emit 静默收集，挂卡由外部注入）。"""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    async def emit(self, etype: str, payload: dict, **kw: Any) -> None:
        self.events.append((etype, payload))


# ── 拒绝 ──


async def test_mount_rejected_by_approval(storage_uri, approval_ctx):
    """审批拒绝：挂载卡拒绝 → 不连接、不落链、无残留（fail-closed）。"""
    runtime, _host, mount_service = await _boot(_market_with([_IN_MEMORY_ECHO_ENTRY]))
    try:
        ctx = approval_ctx({"mount:test.echo": "reject"})
        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok is False
        assert outcome.status == "rejected"
        assert outcome.patch_ids == ()
        # 拒绝发生在提案阶段：未连接、未落链（「仅提案不直接执行」）
        assert runtime.mcp_manager.list_servers() == []
        assert "echo" not in runtime.tool_registry
        assert await runtime.self_pipeline.chain.current_version() == 1
    finally:
        await runtime.stop()


async def test_mount_vetting_rejected_before_card(storage_uri, approval_ctx):
    """vetting 静态核对拒绝：命令不在白名单 → 未到审批卡即拒绝。"""
    runtime, _host, mount_service = await _boot()
    try:
        ctx = approval_ctx()
        # stdio 命令不在市场白名单（数据驱动：市场声明命令 ∪ npx）
        outcome = await mount_service.mount_config(
            ctx,
            McpServerConfig(
                id="evil.mount",
                transport=McpTransport.STDIO,
                command="curl",
                args=("http://evil.example",),
            ),
        )
        assert outcome.ok is False
        assert outcome.status == "vetting_rejected"
        assert "白名单" in (outcome.error or "")
        assert ctx.card_keys == []  # 未到审批卡
    finally:
        await runtime.stop()


# ── 回退 ──


async def test_mount_revert_restores_chain(storage_uri, approval_ctx):
    """补丁链挂载可回退：回退 → 工具失效、会话断开、链版本还原、审计留痕。"""
    market = _market_with([_IN_MEMORY_ECHO_ENTRY])
    runtime, _host, mount_service = await _boot(market)
    try:
        ctx = approval_ctx()
        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok, outcome.error
        chain_version_before = await runtime.self_pipeline.chain.current_version()
        assert chain_version_before > 1

        unmounted = await mount_service.unmount(ctx, "test.echo", reason="e2e 回退")
        assert unmounted.ok, unmounted.error
        assert unmounted.status == "unmounted"
        assert "echo" not in runtime.tool_registry
        assert runtime.mcp_manager.list_servers() == []
        assert mount_service.mounted_servers == ()
        # 链版本还原（回退后折叠回 base）
        assert await runtime.self_pipeline.chain.current_version() == 1
        # 审计保留回退记录（append-only，历史不撒谎）
        audit = await runtime.self_pipeline.audit_log()
        assert any(record.get("status") == "reverted" for record in audit)
        # 已卸载工具不可调用（引擎重建后工具表无此名）
        assert "echo" not in runtime.tool_registry
    finally:
        await runtime.stop()


# ── 对话式安装（propose_mcp_mount） ──


async def test_conversational_install_happy_path(storage_uri, approval_ctx):
    """对话式安装：propose_mcp_mount 工具 → 地址解析 → 提案卡 → L2 → 挂载。"""
    market = _market_with([_IN_MEMORY_ECHO_ENTRY])
    runtime, _host, mount_service = await _boot(market)
    try:
        mount_service.register_server_factory(
            "test.echo", in_memory_server_factory(build_echo_server())
        )
        ctx = approval_ctx()
        spec = runtime.tool_registry["propose_mcp_mount"]
        outcome = await runtime.tool_pipeline.execute(
            ctx, spec, {"command": "propose_mcp_mount", "address": "test.echo"},
        )
        assert outcome.ok, outcome.error
        result = json.loads(outcome.output)
        assert result["ok"] is True
        assert "echo" in result["tools"]
        assert "echo" in runtime.tool_registry
        # 审批卡预览留痕：挂载提案卡 + L2 补丁卡内容可审计
        assert any(key == "mount:test.echo" for key in ctx.card_keys)
        assert any(key == "patch:tool" for key in ctx.card_keys)
        text = await _call_tool(runtime, runtime.tool_registry["echo"], {"message": "hi"})
        assert text == "echo: hi"
    finally:
        await runtime.stop()


async def test_conversational_install_edit_revalidates(storage_uri, approval_ctx):
    """对话式安装可 edit：审批卡改传输/命令 → 重走校验链 → 拒绝（白名单守卫）。"""
    runtime, _host, _mount_service = await _boot()
    try:
        ctx = approval_ctx(
            {
                "mount:npm.some-mcp-server": {
                    "decision": "edit",
                    "edited_content": {
                        "transport": "stdio",
                        "command": "curl",
                        "args": ["http://evil.example"],
                    },
                }
            }
        )
        spec = runtime.tool_registry["propose_mcp_mount"]
        outcome = await runtime.tool_pipeline.execute(
            ctx, spec, {"command": "propose_mcp_mount", "address": "npm:some-mcp-server"},
        )
        assert outcome.ok, outcome.error
        result = json.loads(outcome.output)
        assert result["ok"] is False
        assert result["status"] == "vetting_rejected"  # 编辑内容重走校验链
        # 「仅提案不直接执行」：npm 推导从未产生任何子进程
        assert runtime.mcp_manager.list_servers() == []
        assert await runtime.self_pipeline.chain.current_version() == 1
    finally:
        await runtime.stop()


async def test_address_resolution_rules(storage_uri):
    """地址解析规则：市场条目 / http / npm / git / 非法地址（仅提案不执行）。"""
    runtime, _host, mount_service = await _boot(_market_with([_IN_MEMORY_ECHO_ENTRY]))
    try:
        market_cfg = mount_service.resolve_address("test.echo")
        assert market_cfg.id == "test.echo"
        assert market_cfg.transport is McpTransport.IN_MEMORY

        http_cfg = mount_service.resolve_address("https://api.example.com/mcp")
        assert http_cfg.transport is McpTransport.HTTP
        assert http_cfg.url == "https://api.example.com/mcp"

        npm_cfg = mount_service.resolve_address("npm:@modelcontextprotocol/server-everything")
        assert npm_cfg.transport is McpTransport.STDIO
        assert npm_cfg.command == "npx"
        assert npm_cfg.args == ("-y", "@modelcontextprotocol/server-everything")

        git_cfg = mount_service.resolve_address("git:github:owner/repo")
        assert git_cfg.transport is McpTransport.STDIO
        assert git_cfg.args == ("-y", "github:owner/repo")

        from host.mcp_service import McpMountError

        with pytest.raises(McpMountError):
            mount_service.resolve_address("ftp://not-supported")
        with pytest.raises(McpMountError):
            mount_service.resolve_address("npm:Bad_Package!")
    finally:
        await runtime.stop()


# ── 三传输闭环 ──


async def test_transport_in_memory_full_loop(storage_uri, approval_ctx):
    """in_memory 传输闭环：嵌入式 server 工厂 → 挂载 → 调用（离线确定性）。"""
    market = _market_with([_IN_MEMORY_ECHO_ENTRY])
    runtime, _host, mount_service = await _boot(market)
    try:
        ctx = approval_ctx()
        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok, outcome.error
        assert outcome.status == "mounted"
        assert runtime.mcp_manager.list_servers() == ["test.echo"]
        text = await _call_tool(runtime, runtime.tool_registry["echo"], {"message": "内存"})
        assert text == "echo: 内存"
        await mount_service.unmount(ctx, "test.echo")
    finally:
        await runtime.stop()


@pytest.mark.skipif(
    not (SEED_ROOT / "exec" / "target" / "debug" / "inkling_exec.exe").is_file(),
    reason="Rust 执行件未构建（cargo build 后重跑）",
)
async def test_transport_stdio_rust_exec(storage_uri, approval_ctx):
    """stdio 传输闭环：真实 Rust 执行件（inkling_exec）挂载 → 统一流水线调用。"""
    binary = SEED_ROOT / "exec" / "target" / "debug" / "inkling_exec.exe"
    market = _market_with([
        {
            "id": "inkling_exec",
            "name": "InKling Rust 执行件（本产品）",
            "source": "本仓库构建产物",
            "transport": "stdio",
            "url": None,
            "command": str(binary),
            "args": [],
            "credentials": {"required": False},
            "risk": "low",
            "risk_note": "产品自带执行件，命令白名单声明在市场内",
            "category": "executor",
            "premounted": False,
        }
    ])
    runtime, _host, mount_service = await _boot(market)
    try:
        ctx = approval_ctx()
        outcome = await mount_service.propose_mount(ctx, "inkling_exec")
        assert outcome.ok, outcome.error
        assert outcome.status == "mounted"
        assert any(name.startswith("inkling_") for name in outcome.tool_names)
        # 真实执行件经统一流水线调用（协议 conformance：initialize →
        # tools/list → tools/call 全流程）
        tool_name = next(n for n in outcome.tool_names if n == "inkling_collect")
        spec = runtime.tool_registry[tool_name]
        text = await _call_tool(runtime, spec, {"source": "text", "text": "墨引擎机制"})
        assert '"ok":true' in text
        assert '"content"' in text
        await mount_service.unmount(ctx, "inkling_exec")
    finally:
        await runtime.stop()


async def test_transport_http_full_loop(storage_uri, approval_ctx):
    """http 传输闭环：uvicorn 承载 fixture server → streamable-http 挂载调用。"""
    import uvicorn


    app = build_server().streamable_http_app
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="warning")
    )
    serve_task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        market = _market_with([
            {
                "id": "fixture.http",
                "name": "HTTP fixture server",
                "source": "e2e fixture",
                "transport": "http",
                "url": f"http://127.0.0.1:{port}/mcp",
                "command": None,
                "args": [],
                "credentials": {"required": False},
                "risk": "low",
                "risk_note": "e2e 离线 http 闭环",
                "category": "fixture",
                "premounted": False,
            }
        ])
        runtime, _host, mount_service = await _boot(market)
        try:
            ctx = approval_ctx()
            outcome = await mount_service.propose_mount(ctx, "fixture.http")
            assert outcome.ok, outcome.error
            assert outcome.status == "mounted"
            text = await _call_tool(runtime, runtime.tool_registry["echo"], {"message": "http"})
            assert text == "echo: http"
            await mount_service.unmount(ctx, "fixture.http")
        finally:
            await runtime.stop()
    finally:
        server.should_exit = True
        # uvicorn 收尾（启动失败/提前退出都是正常结束路径）
        with suppress(Exception):
            await serve_task


async def test_connect_failure_degrades_cleanly(storage_uri):
    """挂载失败降级路径：连接失败 → 结构化失败、无残留会话/补丁、不崩溃。"""
    # 白名单是数据：把不存在的二进制声明进市场（过 vetting 后在连接阶段失败）
    bogus_binary = str(SEED_ROOT / "no-such-binary.exe")
    market = _market_with([
        {
            "id": "dead.stdio",
            "name": "不存在的执行件",
            "source": "e2e fixture",
            "transport": "stdio",
            "url": None,
            "command": bogus_binary,
            "args": [],
            "credentials": {"required": False},
            "risk": "low",
            "risk_note": "e2e 连接失败降级路径",
            "category": "fixture",
            "premounted": False,
        }
    ])
    runtime, _host, mount_service = await _boot(market)
    try:
        ctx = ScriptedApprovalCtx()
        # stdio 命令不存在（子进程启动失败 → 引擎统一包装为导入错误）
        outcome = await mount_service.propose_mount(ctx, "dead.stdio")
        assert outcome.ok is False
        assert outcome.status == "connect_failed"
        assert "连接失败" in (outcome.error or "")
        assert runtime.mcp_manager.list_servers() == []
        assert mount_service.mounted_servers == ()
        # 运行时仍可用（失败不击穿装配）
        assert runtime.engine is not None
    finally:
        await runtime.stop()

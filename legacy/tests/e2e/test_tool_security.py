"""工具安全纵深 e2e（PLAN §6 M3-2 工具安全纵深）。

覆盖：三档权限分级全姿势（allow/review/deny × L0/L1/L2）、文件工具
沙箱（越界/符号链接逃逸/大小上限/未授权拒绝）、网络策略（域名单
越域拒绝）、vetting L2 影子运行（清单比对不一致拒绝挂载）、调配器
动态组装（挂载 → 工具源预算刷新 → 下一回合生效）、shell 执行器进
工具表（OS 七件 command 固定枚举 + stub 执行器闭环）、审批卡恢复
路径（旧卡恢复/过期卡拒绝/已决定卡去重）。
"""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import ScriptedApprovalCtx, load_seed
from fixtures.mcp_fixture_server import build_echo_server
from ink_engine.core.self_application import AUDIT_STATUS_REJECTED
from ink_engine.core.self_proposal import PatchKind, SelfProposal

from host.mcp_service import in_memory_server_factory

MARKET = load_seed("mcp_market.json")

_ECHO_ENTRY = {
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


def _market_with_echo() -> dict[str, Any]:
    market = copy.deepcopy(MARKET)
    market["servers"] = [*market["servers"], _ECHO_ENTRY]
    return market


async def _boot_with_echo(**kwargs: Any):
    from conftest import StubLLM, boot_runtime

    return await boot_runtime(llm=StubLLM(), market=_market_with_echo(), **kwargs)


async def _call(runtime: Any, ctx: Any, name: str, args: dict[str, Any]):
    """经统一安全流水线调用（门禁/沙箱/审批/审计全生效）。"""
    spec = runtime.tool_registry[name]
    return await runtime.tool_pipeline.execute(ctx, spec, args)


# ── 三档权限分级全姿势（allow/review/deny × L0/L1/L2）──


async def test_tier_allow_auto_passes_without_card(booted, approval_ctx):
    """allow 档（L0 自动放行）：无审批卡、判定 allow、执行闭环。"""
    runtime, host, _mount_service = booted
    ctx = approval_ctx()
    # notify = OS 控制 allow 档；stub 执行器注入（免真实桌面）

    async def _notify_impl(_ctx, _definition, args):
        return f"notified: {args.get('title')}"

    host.security.os_registry.register("notify", _notify_impl)
    outcome = await _call(
        runtime, ctx, "notify",
        {"command": "notify", "title": "你好", "body": "通知内容"},
    )
    assert outcome.ok
    assert outcome.decision == "allow"
    assert outcome.output == "notified: 你好"
    assert not any(key == "gate:notify" for key in ctx.card_keys)  # L0 无卡


async def test_tier_review_raises_card_and_accept_executes(booted, approval_ctx):
    """review 档（L1 弹卡同意）：审批卡 → accept → 执行闭环。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx({"gate:launch_app": "accept"})

    async def _launch_impl(_ctx, _definition, args):
        return f"launched: {args.get('app')}"

    _host.security.os_registry.register("launch_app", _launch_impl)
    outcome = await _call(
        runtime, ctx, "launch_app",
        {"command": "launch_app", "app": "notepad"},
    )
    assert outcome.ok
    assert outcome.decision == "allow"  # 审批通过后按 allow 执行
    assert outcome.approval is not None
    assert outcome.output == "launched: notepad"
    assert "gate:launch_app" in ctx.card_keys  # review 档弹卡


async def test_tier_review_reject_skips_execution(booted, approval_ctx):
    """review 档拒绝：卡拒绝 → 不执行（fail-closed 方向）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx({"gate:launch_app": "reject"})
    calls: list[dict[str, Any]] = []

    async def _launch_impl(_ctx, _definition, args):
        calls.append(args)
        return "should-not-happen"

    _host.security.os_registry.register("launch_app", _launch_impl)
    outcome = await _call(
        runtime, ctx, "launch_app",
        {"command": "launch_app", "app": "notepad"},
    )
    assert outcome.ok is False
    assert outcome.decision == "reject"
    assert calls == []  # 执行器未触达


async def test_tier_deny_always_rejected(booted, approval_ctx):
    """deny 档：无条件拒绝（不弹卡、不执行、权限命中与否无关）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    outcome = await _call(
        runtime, ctx, "shell_exec", {"command": "shell_exec", "argv": ["rm", "-rf", "/"]},
    )
    assert outcome.ok is False
    assert outcome.decision == "deny"
    assert "deny" in (outcome.error or "").lower() or "默认拒绝" in (outcome.error or "")
    assert not any(key == "gate:shell_exec" for key in ctx.card_keys)  # deny 无卡
    # 审批卡注入也无法放行（门禁先于审批卡）
    ctx.set_decision("gate:shell_exec", "accept")
    outcome = await _call(
        runtime, ctx, "shell_exec", {"command": "shell_exec", "argv": ["ls"]},
    )
    assert outcome.ok is False


async def test_patch_level_l0_l1_l2_matrix(booted, approval_ctx):
    """补丁级分级矩阵：L0 直过无卡 / L1 弹卡 / L2 卡前须 vetting。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    base = await runtime.self_pipeline.chain.current_version()

    # L0（THEME）：策略直过，无审批卡
    theme_outcome = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.THEME,
            payload={"tokens": {"bg.base": "#000000"}},
            base_version=base,
            rationale="L0 直过断言",
        ),
    )
    assert theme_outcome.applied
    assert not any(key == "patch:theme" for key in ctx.card_keys)

    # L1（RULE）：弹卡，accept 后落链
    rule_outcome = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.RULE,
            payload={
                "rule": {
                    "id": "rule.e2e.l1",
                    "predicate": "has_fields",
                    "config": {"fields": ["title"]},
                    "type": "constraint",
                    "severity": "error",
                    "kind": "e2e_shape",
                }
            },
            base_version=await runtime.self_pipeline.chain.current_version(),
            rationale="L1 弹卡断言",
        ),
    )
    assert rule_outcome.applied
    assert any(key == "patch:rule" for key in ctx.card_keys)

    # L2（TOOL，未过 vetting）：vetting 钩子在卡前拒绝（fail-closed）
    tool_outcome = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.TOOL,
            payload={
                "name": "e2e.unvetted",
                "description": "未过 vetting 的工具",
                "parameters": {"type": "object"},
                "permissions": ["test:run:ok"],
                "endpoint": "mcp",
                "endpoint_config": {"server_id": "svc.no-vetting"},
                "meta": {},
            },
            base_version=await runtime.self_pipeline.chain.current_version(),
            rationale="L2 vetting 前置断言",
        ),
    )
    assert tool_outcome.applied is False
    assert tool_outcome.status == AUDIT_STATUS_REJECTED
    assert "vetting" in (tool_outcome.reason or "") or "未经" in (tool_outcome.reason or "")
    assert not any(key == "patch:tool" for key in ctx.card_keys)  # 卡前已拒


# ── 文件工具沙箱（工作区授权 + 越界/符号链接/大小上限）──


async def _authorize_workspace(runtime: Any, host: Any, ws: Path, ctx: Any) -> None:
    result = await host.workspaces.authorize(ctx, ws, reason="e2e 工作区")
    assert result["ok"], result


async def test_file_tools_denied_until_authorized(booted, approval_ctx, tmp_path):
    """工作区未授权：文件工具注册但沙箱拒绝（占位符未解析，fail-closed）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "hello.txt").write_text("你好", encoding="utf-8")

    assert "file_read" in runtime.tool_registry  # 工具在表（占位符形态）
    outcome = await _call(
        runtime, ctx, "file_read",
        {"operation": "read", "path": str(ws / "hello.txt")},
    )
    assert outcome.ok is False
    assert "工作区未授权" in (outcome.error or "")


async def test_file_sandbox_out_of_root_and_symlink_escape(booted, approval_ctx, tmp_path):
    """授权后沙箱生效：越界路径拒绝、符号链接逃逸拒绝、界内读写闭环。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    ws = tmp_path / "ws"
    ws.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("越界文件", encoding="utf-8")
    await _authorize_workspace(runtime, host, ws, ctx)

    # 界内写入 + 读取闭环（file_write review 档弹卡，默认 accept）
    write_outcome = await _call(
        runtime, ctx, "file_write",
        {"operation": "write", "path": str(ws / "note.txt"), "content": "墨引擎笔记"},
    )
    assert write_outcome.ok
    data = json.loads(write_outcome.output)
    assert data["ok"] is True
    assert (ws / "note.txt").read_text(encoding="utf-8") == "墨引擎笔记"

    read_outcome = await _call(
        runtime, ctx, "file_read",
        {"operation": "read", "path": str(ws / "note.txt")},
    )
    assert read_outcome.ok
    assert "墨引擎笔记" in read_outcome.output

    # 越界路径（.. 穿越 + 绝对路径出根）一律拒绝（门禁/沙箱任一层拒绝）
    for evil in (str(outside), str(ws / ".." / "outside.txt")):
        denied = await _call(
            runtime, ctx, "file_read", {"operation": "read", "path": evil},
        )
        assert denied.ok is False
        assert denied.error  # 拒绝原因结构化可观测

    # 符号链接逃逸：工作区内链接指向根外文件 → 拒绝
    try:
        (ws / "escape_link.txt").symlink_to(outside)
    except OSError:
        pytest.skip("当前环境无法创建符号链接（需管理员/开发者模式）")
    link_outcome = await _call(
        runtime, ctx, "file_read",
        {"operation": "read", "path": str(ws / "escape_link.txt")},
    )
    assert link_outcome.ok is False


async def test_file_sandbox_size_limits_data_driven(booted, approval_ctx, tmp_path):
    """大小上限：声明 sandbox_limits 数据驱动，超限拒绝（SEC_004）。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    ws = tmp_path / "ws"
    ws.mkdir()
    await _authorize_workspace(runtime, host, ws, ctx)

    # 数据契约：tools.json 文件工具声明正整数大小上限
    for tool in load_seed("tools.json")["tools"]:
        if tool.get("endpoint") == "file_ops":
            limits = (tool.get("meta") or {}).get("sandbox_limits") or {}
            assert limits["max_read_bytes"] > 0
            assert limits["max_write_bytes"] > 0

    # 注入限值极小的文件工具：写入超限 → 执行体拒绝（纵深防御第二层）
    from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

    tiny = DeclarativeToolSpec(
        name="file_write_tiny",
        description="限值极小的工作区写入工具（e2e 断言大小上限）",
        parameters={"type": "object"},
        permissions=[f"filesystem:write:{ws.as_posix()}/**"],
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": str(ws)},
        meta={"sandbox_limits": {"max_read_bytes": 10, "max_write_bytes": 10}},
    )
    runtime.harness_registry.declarative.register_definition(tiny)
    runtime.tool_registry["file_write_tiny"] = tiny.to_spec()
    outcome = await runtime.tool_pipeline.execute(
        ctx,
        runtime.tool_registry["file_write_tiny"],
        {
            "operation": "write",
            "path": str(ws / "big.txt"),
            "content": "x" * 64,
        },
    )
    assert outcome.ok
    result = json.loads(outcome.output)
    assert result["ok"] is False
    assert result["status"] == "size_limit"
    assert "1048576" not in outcome.output  # 走声明限值而非缺省值
    assert not (ws / "big.txt").exists()  # 超限不落盘


# ── 网络策略（域名单核对，越域拒绝）──


async def test_network_policy_domain_allowlist(booted, approval_ctx):
    """fetch_web 网络策略：白名单域名放行、越域拒绝（沙箱 + 执行体双层）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()

    async def _stub_fetch(_definition, args):
        return f"stub-fetch:{args.get('url')}"

    # 测试注入 stub 取回实现（免真实出网；宿主缺省 = httpx 受控取回）
    from ink_engine.core.declarative_tools import EndpointType

    from host.security_domain import make_http_fetch_executor

    runtime.harness_registry.declarative.register(
        EndpointType.HTTP_FETCH,
        make_http_fetch_executor(fetch=_stub_fetch),
    )
    # 界内域名：arxiv.org ∈ 出厂白名单 → 沙箱放行 + 执行体二次核对 → 执行
    inside = await _call(
        runtime, ctx, "fetch_web",
        {"url": "https://arxiv.org/abs/2401.12345"},
    )
    assert inside.ok
    assert "stub-fetch:" in inside.output
    # 越域域名：权限模式/域名单任一层拒绝（门禁先行，沙箱兜底）
    outside = await _call(
        runtime, ctx, "fetch_web",
        {"url": "https://evil.example.com/payload"},
    )
    assert outside.ok is False
    assert outside.error  # 拒绝原因结构化可观测
    # 执行体二次核对（纵深防御第二层）：直调执行体（绕过沙箱层）越域拒绝

    from ink_engine.core.declarative_tools import DeclarativeToolSpec

    rogue_def = DeclarativeToolSpec(
        name="fetch_rogue",
        description="越域抓取定义（e2e 断言执行体二次核对）",
        parameters={"type": "object"},
        permissions=["network:connect:*"],
        endpoint=EndpointType.HTTP_FETCH,
        endpoint_config={"method": "GET"},
        meta={"network_policy": {"allow_domains": ["arxiv.org"]}},
    )
    executor = make_http_fetch_executor(fetch=_stub_fetch)
    denied = await executor(ctx, rogue_def, {"url": "https://other.example.net/x"}, None)
    result = json.loads(denied)
    assert result["ok"] is False
    assert result["status"] == "network_domain_blocked"


# ── vetting L2 影子运行（清单一致性核对，不真执行）──


async def test_vetting_shadow_run_mismatch_rejects_mount(storage_uri, approval_ctx):
    """影子运行：声明工具不在导入清单/参数不符 → L2 拒绝挂载。"""
    runtime, _host, mount_service = await _boot_with_echo(storage_uri=storage_uri)
    try:
        ctx = ScriptedApprovalCtx()
        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok, outcome.error
        base = await runtime.self_pipeline.chain.current_version()

        # 影子清单已登记（导入期 tools/list，不执行任何工具调用）
        shadow = _host.security.shadow
        assert "echo" in shadow.server_tools("test.echo")

        # 声明工具不在影子清单 → 影子核对失败 → 拒绝挂载（vetting 在卡前拒绝）
        tool_cards_before = sum(1 for k in ctx.card_keys if k == "patch:tool")
        ghost = await runtime.self_pipeline.apply(
            ctx,
            SelfProposal(
                kind=PatchKind.TOOL,
                payload={
                    "name": "ghost_tool",
                    "description": "server 实际未暴露的工具",
                    "parameters": {"type": "object"},
                    "permissions": ["mcp:call:test.echo"],
                    "endpoint": "mcp",
                    "endpoint_config": {"server_id": "test.echo"},
                    "meta": {"mcp_server": "test.echo"},
                },
                base_version=base,
                rationale="影子比对拒绝断言",
            ),
        )
        assert ghost.applied is False
        assert "影子" in (ghost.reason or "")
        # 卡前拒绝：本次提案未新增审批卡（挂载期的卡是历史记录）
        tool_cards_after = sum(1 for k in ctx.card_keys if k == "patch:tool")
        assert tool_cards_after == tool_cards_before

        # 参数必填项与影子清单不符 → 同样拒绝
        param_mismatch = await runtime.self_pipeline.apply(
            ctx,
            SelfProposal(
                kind=PatchKind.TOOL,
                payload={
                    "name": "echo",
                    "description": "回声工具（参数声明漂移）",
                    "parameters": {
                        "type": "object",
                        "properties": {"ghost_param": {"type": "string"}},
                        "required": ["ghost_param"],
                    },
                    "permissions": ["mcp:call:test.echo"],
                    "endpoint": "mcp",
                    "endpoint_config": {"server_id": "test.echo"},
                    "meta": {"mcp_server": "test.echo"},
                },
                base_version=base,
                rationale="影子参数比对拒绝断言",
            ),
        )
        assert param_mismatch.applied is False
        assert "参数必填项" in (param_mismatch.reason or "")

        # 一致声明 → L2 审批卡 → accept → 落链（影子放行的正向闭环）。
        # 声明参数 = 挂载后工具表的实际形态（引擎归一化产物：properties
        # 为空即无必填声明——影子比对按「必填项须能在影子中证明存在」
        # 的 fail-closed 语义放行）
        consistent = await runtime.self_pipeline.apply(
            ctx,
            SelfProposal(
                kind=PatchKind.TOOL,
                payload={
                    "name": "echo",
                    "description": "回声工具（与影子清单一致）",
                    "parameters": {"type": "object", "properties": {}},
                    "permissions": ["mcp:call:test.echo"],
                    "endpoint": "mcp",
                    "endpoint_config": {"server_id": "test.echo"},
                    "meta": {"mcp_server": "test.echo"},
                },
                base_version=await runtime.self_pipeline.chain.current_version(),
                rationale="影子放行断言",
            ),
        )
        assert consistent.applied
        assert any(key == "patch:tool" for key in ctx.card_keys)  # L2 弹卡
    finally:
        await runtime.stop()


# ── 调配器动态组装（挂载 → 工具源预算刷新 → 下一回合生效）──


async def test_dynamic_tool_assembly_next_round(storage_uri, approval_ctx):
    """调配器动态组装：新挂载工具 → 五源工具预算下一回合纳入 + 回合可执行。"""
    runtime, host, mount_service = await _boot_with_echo(storage_uri=storage_uri)
    try:
        ctx = ScriptedApprovalCtx()

        async def _tool_names() -> list[str]:
            provider = runtime._assembly_sources()
            sources = await provider(_FakeCtx("墨引擎"))
            return [
                s.meta.get("tool")
                for s in sources
                if s.meta.get("tool")
            ]

        assert "echo" not in await _tool_names()  # 挂载前：工具源预算无 echo

        outcome = await mount_service.propose_mount(
            ctx, "test.echo",
            server_factory=in_memory_server_factory(build_echo_server()),
        )
        assert outcome.ok, outcome.error
        assert "echo" in runtime.tool_registry
        await runtime.rebuild_engine()

        # 工具源预算刷新：下一回合装配纳入新工具（调配器动态组装）
        names = await _tool_names()
        assert "echo" in names

        # 回合级下一回合生效：tool_pipeline 节点消费 pending 调用新工具
        result = await runtime.engine.ainvoke(
            {
                "input": "调用 echo",
                "orchestrate": {"plan": [{"nodes": ["tool_pipeline"]}]},
                "pending": [
                    {"name": "echo", "arguments": {"message": "动态组装"}, "id": "call-dyn-1"}
                ],
            },
            thread_id="dyn-round-1",
            round_id="round-dyn-1",
            transports=[host.build_transport()],
        )
        assert result.reason == "reply"
        # pending 调用结果回填消息流（tool 角色消息 = 执行输出）
        messages = result.state.get("messages") or []
        assert messages and messages[-1].get("content") == "echo: 动态组装"
        assert result.state.get("pending") == []  # 待执行清单已消费
        await mount_service.unmount(ctx, "test.echo")
    finally:
        await runtime.stop()


class _FakeCtx:
    """装配源调用上下文（回合输入查询串）。"""

    def __init__(self, query: str) -> None:
        self.state = {"input": query}


# ── shell 执行器进工具表（OS 七件 command 固定枚举 + 闭环）──


def test_os_seven_tools_command_enum_declared():
    """OS 七件参数 schema 声明 command 固定枚举（与端点操作判定同源）。"""
    tools = load_seed("tools.json")["tools"]
    by_name = {tool["name"]: tool for tool in tools}
    for name in (
        "launch_app", "open_file", "system_query",
        "set_volume", "set_brightness", "notify", "schedule",
    ):
        tool = by_name[name]
        props = tool["parameters"]["properties"]
        assert props["command"]["type"] == "string"
        assert props["command"]["enum"] == [name]
        assert "command" in tool["parameters"]["required"]


async def test_os_control_stub_executors_full_loop(booted, approval_ctx):
    """OS 七件经统一流水线闭环（stub 执行器注入，免真实桌面）。"""
    runtime, host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    calls: list[str] = []

    def _stub(name: str):
        async def impl(_ctx, _definition, args):
            calls.append(name)
            return f"stub-{name}:{json.dumps(args, ensure_ascii=False)}"

        return impl

    registry = host.security.os_registry
    for name in (
        "launch_app", "open_file", "system_query",
        "set_volume", "set_brightness", "notify", "schedule",
    ):
        registry.register(name, _stub(name))

    sample_args = {
        "launch_app": {"app": "notepad"},
        "open_file": {"path": "C:/tmp/note.md"},
        "system_query": {"scope": "system"},
        "set_volume": {"level": 30},
        "set_brightness": {"level": 60},
        "notify": {"title": "t", "body": "b"},
        "schedule": {"when": "09:00", "action": "提醒"},
    }
    for name, extra in sample_args.items():
        outcome = await _call(
            runtime, ctx, name, {"command": name, **extra},
        )
        assert outcome.ok, f"{name}: {outcome.error}"
        assert outcome.output.startswith(f"stub-{name}:")
        if name not in ("notify", "system_query"):
            # review 档（allow 档 notify/system_query 无卡）
            assert any(key == f"gate:{name}" for key in ctx.card_keys)
    assert set(calls) == set(sample_args)


async def test_command_enum_mismatch_rejected(booted, approval_ctx):
    """command 固定枚举不符：门禁/白名单拒绝（参数与端点判定同源）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    outcome = await _call(
        runtime, ctx, "launch_app",
        {"command": "evil_command", "app": "anything"},
    )
    assert outcome.ok is False
    assert outcome.decision == "deny"
    assert "白名单" in (outcome.error or "") or "权限" in (outcome.error or "")


# ── 审批卡恢复路径（旧卡恢复/过期卡拒绝/已决定卡去重）──


async def test_resume_run_old_card_recovery(booted):
    """旧卡恢复：回合挂起 review 卡 → 逐卡 resume 续跑至终态（不重跑已决卡）。"""
    runtime, host, _mount_service = booted
    offset = len(host.events)

    first = await runtime.engine.ainvoke(
        {"input": "研究墨引擎机制"},
        thread_id="resume-thread-1",
        round_id="round-resume-1",
        transports=[host.build_transport()],
    )
    assert first.reason == "interrupted"
    assert first.interrupt is not None
    assert first.interrupt.key == "gate:collect_material"  # 首个 review 卡

    # 逐卡恢复（collect → review_material → distill 三张 review 卡）
    resumed = first
    recovered_keys: list[str] = []
    for _ in range(3):
        assert resumed.reason == "interrupted"
        key = resumed.interrupt.key
        recovered_keys.append(key)
        resumed = await runtime.resume_run(
            "resume-thread-1", "accept",
            round_id=f"round-resume-{key}",
            transports=[host.build_transport()],
        )
    assert resumed.reason == "reply"  # 全部卡恢复后回合完成
    assert recovered_keys == [
        "gate:collect_material", "gate:review_material", "gate:distill_knowledge",
    ]
    # 已决定卡不重跑：collect_material 在整个恢复链中只执行完成一次
    # （tool_start 按节点进入次数发射——恢复重入会重发 start，执行完成
    # 次数以 tool_end 计数为准）
    tool_ends = [
        e for e in host.events[offset:]
        if e.type == "tool_end" and e.payload["tool"] == "collect_material"
    ]
    assert len(tool_ends) == 1


async def test_resume_run_already_decided_dedupe(booted):
    """已决定卡去重：卡已消费后再次恢复 = 显式拒绝（无挂起卡，不重复执行）。"""
    runtime, host, _mount_service = booted

    first = await runtime.engine.ainvoke(
        {"input": "研究墨引擎机制"},
        thread_id="resume-thread-2",
        round_id="round-resume-2",
        transports=[host.build_transport()],
    )
    assert first.reason == "interrupted"
    for _ in range(3):
        result = await runtime.resume_run(
            "resume-thread-2", "accept", transports=[host.build_transport()]
        )
        if result.reason != "interrupted":
            break
    # 已全部决定：再次恢复 = 无挂起卡，显式拒绝（不静默重放）
    with pytest.raises(RuntimeError, match="无挂起审批卡"):
        await runtime.resume_run(
            "resume-thread-2", "accept", transports=[host.build_transport()]
        )


async def test_expired_card_rejected_fail_closed(booted, approval_ctx):
    """过期卡拒绝：expires_at 已过 → 重入一律 reject（fail-closed，防补批）。"""
    runtime, _host, _mount_service = booted
    ctx = ScriptedApprovalCtx()
    base = await runtime.self_pipeline.chain.current_version()

    first = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.RULE,
            payload={
                "rule": {
                    "id": "rule.e2e.expired",
                    "predicate": "has_fields",
                    "config": {"fields": ["title"]},
                    "type": "constraint",
                    "severity": "error",
                    "kind": "e2e_shape",
                }
            },
            base_version=base,
            rationale="过期卡断言",
        ),
    )
    assert first.applied
    # 篡改已挂卡的超时窗口为过去时刻（模拟长时间未决的旧卡）
    for card in ctx.cards:
        if card["key"] == "patch:rule":
            card["payload"]["expires_at"] = time.time() - 1
    expired = await runtime.self_pipeline.apply(
        ctx,
        SelfProposal(
            kind=PatchKind.RULE,
            payload={
                "rule": {
                    "id": "rule.e2e.expired.2",
                    "predicate": "has_fields",
                    "config": {"fields": ["title"]},
                    "type": "constraint",
                    "severity": "error",
                    "kind": "e2e_shape",
                }
            },
            base_version=await runtime.self_pipeline.chain.current_version(),
            rationale="过期卡拒绝断言",
        ),
    )
    assert expired.applied is False
    assert expired.status == AUDIT_STATUS_REJECTED
    assert "超时" in (expired.reason or "")
    # 审计留痕：过期拒绝可查
    audit = await runtime.self_pipeline.audit_log()
    assert any(
        record.get("status") == AUDIT_STATUS_REJECTED
        and "超时" in str(record.get("reason") or "")
        for record in audit
    )

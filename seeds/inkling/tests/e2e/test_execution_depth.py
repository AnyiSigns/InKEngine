"""执行深度 e2e：编辑重放/预算三态/异常三态/生命周期/晋升导出/脱敏追踪/
存储三后端/UI 三层白名单。

「执行即日志、状态即快照」的可审计性深水区（引擎机制 + 宿主装配）：
- 编辑重放：审批卡 edit 重走校验链（非法编辑拒绝、合法编辑落链）；
  回合日志截断 + 分叉重放（历史前缀可追溯，修正输入生效）；
- 预算三态：正常完成 / 超限自动终止 / 超限恢复后重试成功；
- 异常三态：重试（瞬时故障恢复）/ 跳过（继续执行）/ 终止（本轮失败）；
- 生命周期：boot 幂等 / pause 拒新 / resume 恢复 / stop 排空 / 引擎
  重建缓存（配置不变复用实例）；
- 知识晋升导出：晋升后导出含新层级（跨集迁移形态）；
- 脱敏与 trace_id：日志 redact（敏感形态遮蔽）+ trace_id 贯穿回合 +
  存储落库剥离敏感键；
- 存储三后端：memory / sqlite 内存 / sqlite 文件（落盘持久化 + 重启
  链版本延续）；
- UI 三层白名单：未声明组件/通道/token 拒绝；损坏 ui_spec 回落未定形；
  渲染器契约同源断言（前端夹具组件集 ⊆ manifest 白名单）。
"""
from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from conftest import SEED_ROOT, ScriptedApprovalCtx, StubLLM, load_seed
from ink_engine.core.budget import BudgetExceededError
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.logging import JsonFormatter, redact, trace_id_var
from ink_engine.core.registry import GraphRegistries
from ink_engine.core.self_proposal import PatchKind, SelfProposal
from ink_engine.core.storage import create_storage
from ink_engine.core.ui_schema import UISchemaValidator

from host.host import InKlingHost, InkRuntime, boot_inkling
from host.recipe_loader import build_recipe, load_seed_data

# ── 编辑重放 ──


async def test_edit_replay_card_revalidates(booted):
    """编辑重放（审批卡 edit）：非法编辑内容重走校验链被拒（不落链）；
    合法编辑落链且内容生效。"""
    runtime, _host, _mount = booted
    base = await runtime.self_pipeline.chain.current_version()
    rule_payload = {
        "rule": {
            "id": "rule.depth.edit",
            "predicate": "present",
            "config": {"path": "title", "message": "原版规则"},
            "type": "constraint",
            "target_path": "material",
            "severity": "error",
        }
    }

    def _proposal() -> SelfProposal:
        return SelfProposal(
            kind=PatchKind.RULE,
            payload=rule_payload,
            base_version=base,
            rationale="编辑重放用例",
        )

    # 编辑决议 = 非法内容（缺 rule id → 校验器拒绝）→ 不落链
    ctx = ScriptedApprovalCtx(
        {"patch:rule": {"decision": "edit", "edited_content": {"rule": {"message": "缺 id"}}}}
    )
    outcome = await runtime.self_pipeline.apply(ctx, _proposal())
    assert outcome.applied is False
    assert outcome.status == "rejected"
    assert "重新校验未通过" in (outcome.reason or "")
    assert await runtime.self_pipeline.chain.current_version() == base  # 未落链

    # 编辑决议 = 合法内容（改 message）→ 重走校验链通过 → 落链生效
    ctx = ScriptedApprovalCtx(
        {
            "patch:rule": {
                "decision": "edit",
                "edited_content": {
                    "rule": {
                        "id": "rule.depth.edit",
                        "predicate": "present",
                        "config": {"path": "title", "message": "编辑后规则"},
                        "type": "constraint",
                        "target_path": "material",
                        "severity": "error",
                    }
                },
            }
        }
    )
    outcome = await runtime.self_pipeline.apply(ctx, _proposal())
    assert outcome.applied
    assert outcome.decision == "edit"
    state = await runtime.self_pipeline.chain.assemble()
    assert (
        state["rules"]["rule.depth.edit"]["config"]["message"] == "编辑后规则"
    )  # 编辑生效
    audit = await runtime.self_pipeline.audit_log()
    assert audit[-1]["status"] == "applied"
    assert audit[-1]["decision"] == "edit"


async def test_edit_replay_fork_and_log_truncation():
    """编辑重放（回合级）：对已结束回合注入修正 → 日志截断 + 分叉重放，
    历史前缀可追溯（原链/原事件保留，修正输入生效）。"""
    from helpers import (
        build_ctx,
        build_round_graph,
        build_test_pipeline,
        domain_tool_specs,
    )

    storage = create_storage("memory://")
    registries = GraphRegistries()
    pipeline = build_test_pipeline({"collect_material": "材料已取回"})
    graph = build_round_graph(
        build_ctx(
            pipeline=pipeline,
            tool_specs=domain_tool_specs(),
            registries=registries,
        )
    )
    engine = Engine(graph, options=RunOptions(storage=storage, registries=registries))

    first = await engine.ainvoke(
        {"input": "旧输入"}, thread_id="depth-replay", round_id="round-old"
    )
    assert first.reason == "reply"
    links = await storage.chain_index("depth-replay")
    assert len(links) >= 5  # 回合产生版本链
    mid = links[len(links) // 2].checkpoint_id
    log_seq = await storage.latest_event_seq("depth-replay")

    # 注入修正 + 日志截断 + 从锚点分叉重放
    replay = await engine.ainvoke(
        {"input": "修正输入"},
        thread_id="depth-replay",
        round_id="round-replay",
        resume_from=mid,
        truncate_log_after=log_seq,
        inject={},
    )
    assert replay.reason == "reply"
    assert replay.state["input"] == "修正输入"  # 修正输入生效

    # 历史可追溯：原链前缀原样保留（1 → … → 锚点），重放分支挂在锚点后
    after = await storage.chain_index("depth-replay")
    by_id = {link.checkpoint_id: link for link in after}
    assert by_id[1].parent_id is None
    for link in after:
        if link.parent_id is not None:
            assert link.parent_id in by_id  # 无悬挂父指针
    # 原事件 + 重放事件并存（collect_material 执行两次：原回合 + 重放）
    events = await storage.events_after("depth-replay", 0)
    starts = [e for e in events if e.type == "tool_start"]
    assert len(starts) >= 2


# ── 预算三态 ──


class _StepBudgetPolicy:
    """调用计数预算策略（节点边界检查；超限抛 BudgetExceededError）。

    策略自计数（引擎 ctx 不提供 step_count 属性——协议示例中的
    ctx.step_count 为业务侧计数约定，此处按协议真实可跑形态实现）。
    """

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self.steps = 0

    async def check(self, ctx: Any) -> None:
        self.steps += 1
        if self.steps >= self._limit:
            raise BudgetExceededError("steps", self._limit, self.steps)


def _budget_graph() -> Graph:
    """预算用例图（b1 → b2 → 出口；每节点一步）。"""

    async def mark(ctx: Any) -> dict[str, Any]:
        return {"ran": True}

    g = Graph(name="budget", entry="b1")
    g.add_node("b1", mark)
    g.add_node("b2", mark)
    g.add_edge("b1", "b2")
    g.add_exit("b2")
    return g


async def test_budget_three_states():
    """预算三态：正常完成 / 超限自动终止 / 超限恢复后重试成功。"""
    from ink_engine.core.budget import BudgetManager

    # 态一：正常完成（预算充足 → reply）
    budget_ok = BudgetManager()
    budget_ok.register(_StepBudgetPolicy(limit=10))
    ok_engine = Engine(
        _budget_graph(), options=RunOptions(budget=budget_ok)
    )
    result = await ok_engine.ainvoke(
        {"input": "x"}, thread_id="budget-ok", round_id="r-ok"
    )
    assert result.reason == "reply"

    # 态二：超限自动终止（预算护栏 → budget_exceeded）
    budget_cut = BudgetManager()
    budget_cut.register(_StepBudgetPolicy(limit=1))
    cut_engine = Engine(
        _budget_graph(), options=RunOptions(budget=budget_cut)
    )
    result = await cut_engine.ainvoke(
        {"input": "x"}, thread_id="budget-cut", round_id="r-cut"
    )
    assert result.reason == "budget_exceeded"

    # 态三：超限恢复重试（提高预算后重跑 → 完成）
    budget_retry = BudgetManager()
    budget_retry.register(_StepBudgetPolicy(limit=5))
    retry_engine = Engine(
        _budget_graph(), options=RunOptions(budget=budget_retry)
    )
    result = await retry_engine.ainvoke(
        {"input": "x"}, thread_id="budget-retry", round_id="r-retry"
    )
    assert result.reason == "reply"


# ── 异常三态 ──


def _boom_graph() -> Graph:
    """异常注入图（boom 必炸；after 标记到达）。"""

    async def boom(ctx: Any) -> None:
        raise RuntimeError("boom 节点故障")

    async def after(ctx: Any) -> dict[str, Any]:
        return {"reached_after": True}

    g = Graph(name="boom", entry="boom")
    g.add_node("boom", boom)
    g.add_node("after", after)
    g.add_edge("boom", "after")
    g.add_exit("after")
    return g


def _flaky_graph() -> Graph:
    """瞬时故障图（前两次失败，第三次成功）。"""
    attempts = {"n": 0}

    async def flaky(ctx: Any) -> dict[str, Any]:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("瞬时故障")
        return {"recovered": True}

    g = Graph(name="flaky", entry="flaky")
    g.add_node("flaky", flaky)
    g.add_exit("flaky")
    return g


async def test_error_three_states_retry_skip_terminate():
    """异常三态：重试（瞬时故障恢复）/ 跳过（继续执行）/ 终止（本轮失败）。"""
    # 重试：max_node_retries 内瞬时故障恢复
    engine = Engine(
        _flaky_graph(),
        options=RunOptions(error_on_exception=True, max_node_retries=2),
    )
    result = await engine.ainvoke({}, thread_id="err-retry", round_id="r-retry")
    assert result.reason == "reply"
    assert result.state.get("recovered") is True

    # 跳过：error_on_exception=False → 异常节点跳过，后续节点继续
    engine = Engine(
        _boom_graph(),
        options=RunOptions(error_on_exception=False, max_node_retries=0),
    )
    result = await engine.ainvoke({}, thread_id="err-skip", round_id="r-skip")
    assert result.reason == "reply"
    assert result.state.get("reached_after") is True

    # 终止：error_on_exception=True 且不重试 → 本轮 error 终止
    engine = Engine(
        _boom_graph(),
        options=RunOptions(error_on_exception=True, max_node_retries=0),
    )
    result = await engine.ainvoke({}, thread_id="err-stop", round_id="r-stop")
    assert result.reason == "error"
    assert "boom" in (result.error or "")


# ── 生命周期（boot 幂等 / pause 拒新 / resume / stop 排空 / 重建缓存）──


async def test_lifecycle_boot_idempotent_and_rebuild_cache():
    """boot 幂等（已装配再次调用返回自身）+ 引擎重建缓存（配置不变复用实例）。"""
    bundle = load_seed_data(SEED_ROOT)
    recipe = build_recipe(bundle)
    host = InKlingHost(llm=StubLLM())
    runtime = InkRuntime()
    try:
        await runtime.boot(host, recipe)
        await runtime.boot(host, recipe)  # 幂等：已装配直接返回自身
        assert runtime._state.value == "running"

        engine_before = runtime.engine
        rebuilt = await runtime.rebuild_engine()
        assert rebuilt is engine_before  # 配置不变 → 复用实例（缓存生效）

        # 工具表变更 → 重建（缓存键 = 工具表名集合）
        from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

        spec = DeclarativeToolSpec(
            name="depth.cache_probe",
            description="重建缓存探针",
            parameters={"type": "object"},
            permissions=["test:run:ok"],
            endpoint=EndpointType.PROCESS_EXEC,
            endpoint_config={"allowlist": ["depth.cache_probe"]},
        )
        runtime.tool_registry[spec.name] = spec.to_spec()
        rebuilt = await runtime.rebuild_engine()
        assert rebuilt is not engine_before
    finally:
        await runtime.stop()


async def test_lifecycle_pause_rejects_resume_recovers_and_stop_drains(booted):
    """pause 拒新 / resume 恢复 / stop 排空（在途 run 等完成才关停）。"""
    runtime, _host, _mount = booted

    runtime.pause()
    with pytest.raises(RuntimeError, match="不允许开始新 run"):
        runtime.begin_run()
    runtime.resume()
    ticket = runtime.begin_run()  # 恢复后接受新 run
    assert ticket.id

    # stop 排空：在途 run 注销前 stop 等待，注销后完成
    import asyncio

    stop_task = asyncio.create_task(runtime.stop())
    await asyncio.sleep(0.05)
    assert not stop_task.done()  # 在途 run 未排空 → stop 等待
    runtime.end_run(ticket)
    await stop_task
    assert stop_task.result() is None
    assert runtime._state.value == "stopped"
    with pytest.raises(RuntimeError, match="不允许开始新 run"):
        runtime.begin_run()  # 停用后拒新


# ── 知识晋升导出（晋升后导出含新层级）──


async def test_knowledge_promote_then_export_keeps_level(booted):
    """知识晋升导出：晋升到用户级后导出，导入集含新层级（跨集迁移形态）。"""
    runtime, host, _mount = booted
    entry_id = "seed.inkling.domain_guide"
    assert runtime.knowledge_set.get(entry_id).level == "project"

    promoted = host.incubation.promote(entry_id)
    assert promoted.level == "user"

    exported = host.incubation.export()
    migrated = __import__("ink_engine.core.knowledge_set", fromlist=["KnowledgeSet"]).KnowledgeSet.from_export(
        "depth-import", exported
    )
    assert migrated.get(entry_id).level == "user"  # 晋升层级随导出迁移
    # 导出形态可序列化落库（补丁链结构完整）
    assert isinstance(exported["base"], dict)
    assert isinstance(exported["patches"], list)
    assert any(
        p["path"] == ["entries", entry_id] and p["value"]["level"] == "user"
        for p in exported["patches"]
    )


# ── 脱敏与 trace_id（日志/事件/审计无敏感字段，trace_id 贯穿）──


def test_log_redaction_and_structured_trace_id():
    """日志脱敏：敏感形态（sk- 密钥/口令键值）遮蔽；trace_id 贯穿结构化日志。"""
    assert "[REDACTED]" in redact("api_key=sk-abc123secret123456")
    assert "sk-abc123secret123456" not in redact("key sk-abc123secret123456 end")

    records: list[str] = []

    class _Capture:
        def write(self, text: str) -> int:
            records.append(text)
            return len(text)

        def flush(self) -> None:
            return None

    handler = logging.StreamHandler()
    handler.stream = _Capture()
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("depth.trace")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    token = trace_id_var.set("trace-depth-001")
    try:
        logger.info("round 完成 trace=%s secret=sk-hunter2000xxxxxxxx", trace_id_var.get())
    finally:
        trace_id_var.reset(token)
    line = json.loads(records[-1])
    assert line["trace_id"] == "trace-depth-001"  # trace_id 贯穿结构化日志
    assert "sk-hunter2000xxxxxxxx" not in line["msg"]  # 敏感形态遮蔽
    assert "trace-depth-001" in line["msg"]


async def test_trace_id_threads_round_and_storage_strips_sensitive():
    """trace_id 贯穿回合（回合内可读）+ 存储落库剥离敏感键（状态即快照不留凭据）。"""

    async def probe(ctx: Any) -> dict[str, Any]:
        return {"trace": trace_id_var.get(), "api_key": "sk-round-secret12345678"}

    g = Graph(name="probe", entry="probe")
    g.add_node("probe", probe)
    g.add_exit("probe")
    storage = create_storage("memory://")
    engine = Engine(g, options=RunOptions(storage=storage))

    result = await engine.ainvoke(
        {"input": "x"},
        thread_id="trace-round",
        round_id="r-trace",
        trace_id="trace-round-9",
    )
    assert result.reason == "reply"
    assert result.state["trace"] == "trace-round-9"  # trace_id 贯穿至节点执行

    # 存储剥离敏感值：落库快照敏感键值置空（序列化即剥离，凭据不落盘）
    checkpoint = await storage.get_latest_checkpoint("trace-round")
    assert checkpoint is not None
    dumped = json.dumps(checkpoint.state)
    assert "sk-round-secret12345678" not in dumped
    assert checkpoint.state["api_key"] == ""  # 敏感值剥离（键保留为审计形状）


# ── 存储三后端（memory / sqlite 内存 / sqlite 文件）──


@pytest.fixture(
    params=["memory://", "sqlite:///:memory:", "file"],
    ids=["memory", "sqlite-memory", "sqlite-file"],
)
def depth_storage_uri(request: pytest.FixtureRequest, tmp_path: Any) -> str:
    """三后端参数化：内存 / sqlite 内存 / sqlite 文件（落盘形态）。"""
    if request.param == "file":
        return f"sqlite:///{(tmp_path / 'depth.db').as_posix()}"
    return request.param


async def test_storage_three_backends(depth_storage_uri):
    """存储三后端：boot 全链路跑通；文件后端落盘持久化（重启链版本延续）。"""
    runtime, host, _mount = await boot_inkling(
        SEED_ROOT, llm=StubLLM(), storage_uri=depth_storage_uri
    )
    version_before = await runtime.self_pipeline.chain.current_version()
    try:
        assert host.boot_prompt["name"] == "inkling.boot_prompt"
        ctx = ScriptedApprovalCtx()
        outcome = await runtime.self_pipeline.apply(
            ctx,
            SelfProposal(
                kind=PatchKind.THEME,
                payload={"tokens": {"bg.base": "#123456"}},
                base_version=version_before,
                rationale="三后端用例",
            ),
        )
        assert outcome.applied
        assert await runtime.self_pipeline.chain.current_version() == version_before + 1
    finally:
        await runtime.stop()

    if depth_storage_uri.startswith("sqlite:///") and not depth_storage_uri.endswith(":memory:"):
        # 文件后端：新运行时同存储重启 → 链版本延续（持久化生效）
        runtime2, _host2, _mount2 = await boot_inkling(
            SEED_ROOT, llm=StubLLM(), storage_uri=depth_storage_uri
        )
        try:
            assert (
                await runtime2.self_pipeline.chain.current_version()
                == version_before + 1
            )  # 重启链版本延续
            ui = runtime2.introspection_service.snapshot_ui()["ui_spec"]
            assert ui["theme"]["bg.base"] == "#123456"  # 链态恢复（含回退前的补丁）
        finally:
            await runtime2.stop()


# ── UI 三层白名单（引擎装配校验 + 渲染器契约同源断言）──


def _whitelists() -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    """配方三层白名单（引擎装配校验口径，与渲染器契约同源）。"""
    from host.recipe_loader import (
        map_ui_allowed_channels,
        map_ui_allowed_components,
        map_ui_allowed_theme_tokens,
    )

    bundle = load_seed_data(SEED_ROOT)
    return (
        map_ui_allowed_components(bundle),
        map_ui_allowed_channels(bundle),
        map_ui_allowed_theme_tokens(bundle),
    )


def test_ui_three_layer_whitelist_rejects_undeclared():
    """三层白名单：未声明组件/绑定通道/主题 token 拒绝（校验器与渲染器同源）。"""
    components, channels, tokens = _whitelists()
    validator = UISchemaValidator()
    spec = load_seed("ui_spec.json")

    assert not validator.validate(
        spec,
        allowed_components=components,
        allowed_channels=channels,
        allowed_theme_tokens=tokens,
    )  # 基线通过

    evil_spec = {
        "name": "evil.panel",
        "root": {
            "kind": "component",
            "type": "evil_component",  # 未声明组件
            "props": {},
            "bind": {"channel": "events.hacked", "path": ""},  # 未放行通道
        },
    }
    violations = validator.validate(
        evil_spec,
        allowed_components=components,
        allowed_channels=channels,
        allowed_theme_tokens=tokens,
    )
    assert any("组件未注册" in v for v in violations)
    assert any("未放行" in v for v in violations)

    # 未声明主题 token 拒绝（白名单 = ui_spec.theme 键）
    token_violations = validator.validate(
        spec,
        allowed_components=components,
        allowed_channels=channels,
        allowed_theme_tokens=tokens,
    )
    assert not token_violations
    evil_theme = dict(spec)
    evil_theme["theme"] = {"evil.token": "#000000"}
    token_violations = validator.validate(
        evil_theme,
        allowed_components=components,
        allowed_channels=channels,
        allowed_theme_tokens=tokens,
    )
    assert any("token" in v for v in token_violations)


async def test_damaged_ui_spec_falls_back_unformed():
    """损坏 ui_spec 回落未定形：装配不击穿启动，界面快照为未定形。"""
    bundle = load_seed_data(SEED_ROOT)
    recipe = build_recipe(bundle)
    recipe.ui_spec = {
        "name": "broken.panel",
        "root": {"kind": "component", "type": "not_registered", "props": {}},
    }  # 三层白名单外组件 → 校验失败
    host = InKlingHost(llm=StubLLM())
    runtime = InkRuntime()
    try:
        await runtime.boot(host, recipe)
        ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
        assert ui is None  # 回落未定形（不击穿启动）
        result = await runtime.engine.ainvoke(
            {"input": "x"}, thread_id="broken-ui", round_id="r-broken-ui"
        )
        assert result.reason == "reply"  # 启动/回合不受损坏界面影响
    finally:
        await runtime.stop()


def test_renderer_contract_same_source_with_engine_whitelist():
    """渲染器契约同源：前端渲染夹具的组件集 ⊆ manifest 白名单（引擎同口径）。"""
    import json as _json

    components, _channels, _tokens = _whitelists()
    manifest = _json.loads((SEED_ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert set(components) == set(manifest["contracts"]["renderer_components"])

    fixture_path = (
        SEED_ROOT / "frontend" / "src" / "data" / "ui_spec.fixture.json"
    )
    fixture = _json.loads(fixture_path.read_text(encoding="utf-8"))

    def walk(node: Any, out: set[str]) -> None:
        if isinstance(node, dict):
            if node.get("kind") == "component" and node.get("type"):
                out.add(node["type"])
            for child in node.get("children") or ():
                walk(child, out)

    fixture_components: set[str] = set()
    walk(fixture.get("root"), fixture_components)
    assert fixture_components  # 夹具非空
    assert fixture_components <= set(components)  # 渲染器契约 ⊆ 引擎白名单
    # 渲染器夹具主题 token ⊆ 白名单（同源取色）
    fixture_theme = set((fixture.get("theme") or {}).keys())
    assert fixture_theme <= set(manifest["contracts"]["theme_tokens"])

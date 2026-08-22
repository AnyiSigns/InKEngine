"""InKling 出厂演示：注入 → 挂载 → 回合 → 孵化 → 补丁 → 回退 → 领域长出。

照 ``examples/ts_seed_demo.py`` 模式的种子侧演示脚本（headless 一次性
任务，对应 PLAN §6 M4 发布说明的无头形态）：全链在 stub AsyncLLM 下
离线确定性可跑；配置 ``INK_LLM_BASE_URL`` / ``INK_LLM_MODEL`` /
``INK_LLM_API_KEY`` 环境变量后，同一脚本以真实模型驱动回合回复。

运行（任意目录）::

    python inkling/examples/factory_demo.py

演示步骤：
1. 注入：boot_prompt 定稿形态 + 种子基线（知识集/界面）注入；
2. 挂载：stdio 真 Rust 执行件（inkling_exec，已构建时）经 vetting →
   L2 → 补丁链挂载并真实调用；未构建时降级为嵌入式 fixture 并给出
   构建指引（不中断演示）；
3. 回合：研究编排计划执行 + 工具流水线 + 审批卡（六步全绿）；
4. 孵化沉淀：轨迹信号 → 蒸馏 → L1/L2/L3 三层闸门 → 落库；
5. 补丁落链：孵化产物以 KNOWLEDGE 补丁自指挂载（审批 → 审计）；
6. 回退：补丁链链尾折叠撤销（活跃态还原 + 审计留痕）；
7. 领域长出：新规则经样例闸门放行 → 自指挂载生效 → 可回退。

桌面形态（第二种形态，真实桌面冒烟可选）：frontend 开发服务器
（``npm --prefix inkling/frontend run dev``）+ shell 桌面壳
（``cargo tauri dev``，见 PLAN §6 M4 遗留说明）。

任何一步失败均输出修复方向指引（不裸抛），并以非零退出码结束。
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
from pathlib import Path
from typing import Any

# 路径自举：脚本可从任意目录运行（seed 包与引擎包都未必在安装位）
SEED_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SEED_ROOT.parent.parent
for _entry in (str(SEED_ROOT), str(REPO_ROOT)):
    if _entry not in sys.path:
        sys.path.insert(0, _entry)

from ink_engine.core.knowledge_set import KnowledgeEntry  # noqa: E402
from ink_engine.core.llm import AsyncLLM, LLMChunk, LLMConfig, LLMResult  # noqa: E402
from mcp.server import Server  # noqa: E402
from mcp.types import (  # noqa: E402
    CallToolRequestParams,
    CallToolResult,
    ListToolsResult,
    PaginatedRequestParams,
    TextContent,
    Tool,
)

from host.host import boot_inkling  # noqa: E402
from host.knowledge_domain import entry_from_distill  # noqa: E402
from host.mcp_service import in_memory_server_factory  # noqa: E402

# ── 演示常数 ──

ROUND_INPUT = "研究墨引擎机制"
ROUND_STEP_ARGS = {"collect_material": {"text": "墨引擎机制概览"}}
REVIEW_TOOLS = ("collect_material", "review_material", "distill_knowledge")
RUST_BINARY = SEED_ROOT / "exec" / "target" / "debug" / (
    "inkling_exec.exe" if os.name == "nt" else "inkling_exec"
)


class StubLLM(AsyncLLM):
    """确定性 stub 模型（演示离线可复现：按消息内容返回缺省回复）。"""

    adapter = "stub"

    def __init__(self) -> None:
        super().__init__(
            LLMConfig(adapter="stub", model_id="stub-model", base_url="http://stub.local")
        )
        self.call_count = 0

    def _reply_for(self, messages: list[Any]) -> str:
        self.call_count += 1
        for message in reversed(messages):
            content = getattr(message, "content", "")
            if isinstance(content, str) and "研究" in content:
                return "研究计划已按工作流展开：材料采集 → 解析 → 校验 → 评分 → 评审 → 蒸馏。"
        return "（stub 缺省回复）"

    async def ainvoke(
        self,
        messages: list[Any],
        *,
        tools: list[Any] | None = None,
        params: Any = None,
    ) -> LLMResult:
        return LLMResult(content=self._reply_for(messages))

    async def astream(
        self,
        messages: list[Any],
        *,
        tools: list[Any] | None = None,
        params: Any = None,
    ):
        reply = self._reply_for(messages)
        for ch in reply:
            yield LLMChunk(token=ch)

    async def aclose(self) -> None:
        return None


class DemoApprovalCtx:
    """演示审批上下文：全部卡自动通过，逐卡留痕（输出审批轨迹）。"""

    def __init__(self) -> None:
        self.cards: list[dict[str, Any]] = []

    async def interrupt(self, key: str, payload: dict[str, Any]) -> str:
        self.cards.append({"key": key, "payload": payload})
        return "accept"

    async def get_interrupt_payload(self, key: str) -> dict[str, Any] | None:
        for card in reversed(self.cards):
            if card["key"] == key:
                return card["payload"]
        return None

    @property
    def card_keys(self) -> list[str]:
        return [card["key"] for card in self.cards]


# ── 嵌入式演示 server（in_memory 传输；挂载机制与真实执行件同一链路）──

def _tool(name: str, description: str) -> Tool:
    return Tool(name=name, description=description, inputSchema={"type": "object"})


def build_demo_server() -> Server:
    """领域工具 server（工具名与 tools.json 同源：回合计划可全绿执行）。"""

    async def list_tools(
        ctx: Any, params: PaginatedRequestParams | None
    ) -> ListToolsResult:
        return ListToolsResult(tools=DEMO_TOOLS)

    async def call_tool(
        ctx: Any, params: CallToolRequestParams
    ) -> CallToolResult:
        text = {
            "collect_material": '{"title": "墨引擎机制", "text": "机制概览", "source": "web"}',
            "parse_material": '{"title": "解析标题", "points": ["图执行", "补丁链", "事件流"]}',
            "validate_material": '{"violations": [], "passed": true}',
            "score_material": '{"citation_quality": 0.8, "cross_validation": 0.8,'
            ' "consistency": 0.8, "readability": 0.8}',
            "review_material": '{"score": 0.85, "passed": true, "feedback": "来源可追溯"}',
            "distill_knowledge": '{"kind": "rule", "data": {"rule": {"message": "蒸馏产物"}}}',
            "mutate_knowledge": '{"variants": [{"id": "v1"}]}',
        }.get(params.name, f'{{"error": "未知工具: {params.name}"}}')
        return CallToolResult(content=[TextContent(type="text", text=text)])

    return Server(
        "inkling_demo_fixture",
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


DEMO_TOOLS = tuple(
    _tool(name, description)
    for name, description in (
        ("collect_material", "采集研究材料（文本/URL 取回）"),
        ("parse_material", "解析材料：结构化抽取"),
        ("validate_material", "校验材料/知识条目：按规则谓词评估"),
        ("score_material", "评分：引用质量/交叉验证维度打分"),
        ("review_material", "评审：按维度/阈值打分与改进意见"),
        ("distill_knowledge", "蒸馏：信号序列 → 结构化知识数据"),
        ("mutate_knowledge", "变异：按失败日志生成知识条目变体"),
    )
)


# ── 输出辅助 ──

def say(text: str) -> None:
    print(text)


def flag(text: str) -> None:
    print(f"  ◆ {text}")


def header(step: int, total: int, title: str) -> None:
    print(f"\n== [{step}/{total}] {title} ==")


def ok(text: str) -> None:
    print(f"  ✔ {text}")


def warn(text: str) -> None:
    print(f"  ⚠ {text}")


def fail(text: str) -> None:
    print(f"  ✘ {text}")


def rust_market_with_entry() -> dict[str, Any]:
    """出厂市场数据 + 本产品执行件条目（命令白名单声明在市场内）。

    执行件条目以 ``inkling_exec_rust`` 为演示 id：回合阶段的嵌入式
    server 占用 ``inkling_exec``（tools.json 领域工具的端点路由 id），
    两形态并存互不冲突；正式装配使用出厂条目 id（inkling_exec）。
    """
    market = copy.deepcopy(
        json.loads((SEED_ROOT / "seed_data" / "mcp_market.json").read_text(encoding="utf-8"))
    )
    market["servers"] = [
        *market["servers"],
        {
            "id": "inkling_exec_rust",
            "name": "InKling Rust 执行件（本产品，演示 id）",
            "source": "本仓库构建产物",
            "transport": "stdio",
            "url": None,
            "command": str(RUST_BINARY),
            "args": [],
            "credentials": {"required": False},
            "risk": "low",
            "risk_note": "产品自带执行件，命令白名单声明在市场内",
            "category": "executor",
            "premounted": False,
        },
    ]
    return market


def _make_llm() -> Any:
    """模型选择：INK_LLM_* 环境变量 → 真实模型（宿主解析），否则 stub。"""
    if os.environ.get("INK_LLM_BASE_URL") and os.environ.get("INK_LLM_MODEL"):
        say("模型形态：真实 LLM（INK_LLM_* 环境变量，宿主解析）")
        return None
    say("模型形态：stub AsyncLLM（离线确定性；配置 INK_LLM_* 环境变量切换真实模型）")
    return StubLLM()


# ── 演示步骤 ──

async def step_inject(runtime: Any, host: Any) -> None:
    seeds = [e for e in runtime.knowledge_set.entries() if e.id.startswith("seed.")]
    flag(f"boot_prompt 定稿形态：{host.boot_prompt['prompt']}")
    flag(f"种子基线注入：知识集 {len(runtime.knowledge_set.entries())} 条"
         f"（其中种子条目 {len(seeds)} 条：{[e.id for e in seeds[:5]]}{'…' if len(seeds) > 5 else ''}）")
    ui = runtime.introspection_service.snapshot_ui()["ui_spec"]
    flag(f"界面基线：ui_spec name = {ui['name']}（三层白名单校验通过）")
    manifest = json.loads((SEED_ROOT / "manifest.json").read_text(encoding="utf-8"))
    flag(f"身份：{manifest['name']} v{manifest['version']} ｜ engine_version_compat = "
         f"{manifest['engine_version_compat']}")


async def step_mount_rust(runtime: Any, mount_service: Any, ctx: Any) -> None:
    """stdio 真 Rust 执行件：挂载全链路 + 真实调用 + 卸载撤销。"""
    header(2, 7, "挂载执行件（stdio 真 Rust 执行件）")
    if not RUST_BINARY.is_file():
        warn("Rust 执行件未构建：跳过真实执行件路径（降级说明）")
        warn("构建指引：cargo build --manifest-path inkling/exec/Cargo.toml"
             "（构建后本步骤自动走真实执行件）")
        return
    outcome = await mount_service.propose_mount(ctx, "inkling_exec_rust")
    if not outcome.ok:
        raise RuntimeError(f"真实执行件挂载失败: {outcome.status} {outcome.error}")
    ok(f"挂载成功：{outcome.status} ｜ 工具 {list(outcome.tool_names)} ｜ 补丁 #{outcome.patch_ids}")
    spec = runtime.tool_registry["inkling_collect"]
    result = await runtime.tool_pipeline.execute(
        ctx, spec, {"source": "text", "text": "墨引擎机制"}
    )
    if not result.ok:
        raise RuntimeError(f"真实执行件调用失败: {result.error}")
    payload = json.loads(result.output)
    ok(f"真实执行件调用（initialize → tools/list → tools/call）：ok={payload.get('ok')}，"
       f"content={str(payload.get('content'))[:60]}…")
    audit = await runtime.self_pipeline.audit_log()
    ok(f"挂载审计留痕：{audit[-1]['kind']} #{audit[-1]['patch_id']} "
       f"status={audit[-1]['status']}")
    unmounted = await mount_service.unmount(ctx, "inkling_exec_rust")
    if not unmounted.ok:
        raise RuntimeError(f"真实执行件卸载失败: {unmounted.error}")
    ok("卸载撤销：工具表移除 + 会话断开（挂载可回退）")


async def step_round(runtime: Any, host: Any, mount_service: Any, ctx: Any) -> None:
    """回合：研究编排计划 + 工具流水线 + 审批卡（嵌入式 server 全绿）。"""
    header(3, 7, "回合：计划执行 + 工具流水线（嵌入式 server，六步全绿）")
    config = _in_memory_exec_config()
    outcome = await mount_service.mount_config(
        ctx, config, server_factory=in_memory_server_factory(build_demo_server())
    )
    if not outcome.ok:
        raise RuntimeError(f"嵌入式执行件挂载失败: {outcome.status} {outcome.error}")
    ok(f"回合执行件挂载：{outcome.status} ｜ 工具 {list(outcome.tool_names)} ｜ 补丁 #{outcome.patch_ids}")

    offset = len(host.events)
    result = await runtime.engine.ainvoke(
        {"input": ROUND_INPUT, "step_args": ROUND_STEP_ARGS},
        thread_id="demo-round",
        round_id="round-demo-1",
        transports=[host.build_transport()],
        inject={f"gate:{name}": "accept" for name in REVIEW_TOOLS},
    )
    events = list(host.events[offset:])
    ok(f"回合终态：{result.reason}")
    for event in events:
        if event.type == "plan_start":
            plan = event.payload.get("plan") or []
            flag(f"plan_start：研究规划 {len(plan)} 步"
                 f"（{[step.get('nodes', [None])[0] for step in plan]}）")
    tool_ends = [e for e in events if e.type == "tool_end"]
    for event in tool_ends:
        mark = "成功" if event.payload.get("success") else "失败"
        flag(f"tool_end：{event.payload.get('tool')} → {mark}")
    card_events = [e for e in events if e.type == "review_card"]
    flag(f"回合事件流：review_card {len(card_events)} 张；review 档工具门禁卡"
         f"（{len(REVIEW_TOOLS)} 张）经注入 accept 直过（挂载卡轨迹见步骤 2/3）")

    unmounted = await mount_service.unmount(ctx, "inkling_exec")
    if not unmounted.ok:
        raise RuntimeError(f"嵌入式执行件卸载失败: {unmounted.error}")
    ok("回合执行件卸载撤销（挂载可回退）")


def _in_memory_exec_config() -> Any:
    from ink_engine.core.mcp_client import McpServerConfig, McpTransport

    return McpServerConfig(
        id="inkling_exec",
        transport=McpTransport.IN_MEMORY,
        source="model",
    )


async def step_incubate(runtime: Any, host: Any) -> None:
    """孵化沉淀：轨迹信号 → 蒸馏 → 三层闸门 → 落库。"""
    header(4, 7, "孵化沉淀：信号 → 蒸馏 → 三层闸门 → 落库")
    signals = host.incubation.classify(
        [
            {"type": "review_pass", "message": "评审通过：来源可追溯", "source": "model"},
            {"type": "tool_error", "message": "一次预期外失败（教训来源）", "source": "model"},
        ]
    )
    flag(f"信号分类：{[s.kind for s in signals]}（同因聚合后）")
    flag(f"蒸馏触发判定：should_distill(complexity=6) = "
         f"{host.incubation.should_distill(complexity=6)}")
    outcome = host.incubation.distill(signals, "来源可追溯的评审经验")
    distilled = outcome.distilled
    ok(f"蒸馏产出：kind={distilled.data.get('kind')}（title={distilled.title!r}）")
    entry = entry_from_distill(distilled, "k.demo.incubated")
    l1, l2, l3 = await host.incubation.verify_gate(entry)
    flag(f"三层闸门裁决：L1={l1.passed} L2（样例全绿）={l2.passed} L3={l3.passed}")
    landed = await host.incubation.sediment(entry)
    ok(f"落库：{landed.id}（level={landed.level}）")


async def step_patch(runtime: Any, host: Any, ctx: Any) -> int:
    """补丁落链：孵化产物以 KNOWLEDGE 补丁自指挂载，返回补丁 id。"""
    header(5, 7, "补丁落链：孵化沉淀 → KNOWLEDGE 补丁（审批 → 审计）")
    entry = runtime.knowledge_set.get("k.demo.incubated")
    if entry is None:
        raise RuntimeError("孵化产物不在知识集（上一步落库失败）")
    version_before = await runtime.self_pipeline.chain.current_version()
    outcome = await host.incubation.propose_knowledge_patch(
        ctx, entry, "演示：孵化沉淀自指挂载", round_id="demo-patch"
    )
    if not outcome.applied:
        raise RuntimeError(f"知识补丁未落链: {outcome}")
    ok(f"补丁 #{outcome.patch_id} 落链（链版本 {version_before} → "
       f"{await runtime.self_pipeline.chain.current_version()}）")
    audit = await runtime.self_pipeline.audit_log()
    ok(f"审计尾：{audit[-1]['kind']} #{audit[-1]['patch_id']} "
       f"status={audit[-1]['status']} reason={audit[-1].get('reason', '')!r}")
    return int(outcome.patch_id)


async def step_revert(runtime: Any, ctx: Any, patch_id: int) -> None:
    """回退：补丁链链尾折叠 → 活跃态撤销 + 审计。"""
    header(6, 7, "回退：补丁链链尾折叠撤销")
    reverted = await runtime.self_pipeline.revert(
        ctx, patch_id, reason="演示：链尾折叠回退"
    )
    if reverted.status != "reverted":
        raise RuntimeError(f"回退未完成: {reverted}")
    ok(f"补丁 #{patch_id} 回退：{reverted.status}")
    ok(f"活跃态撤销：知识条目 k.demo.incubated 是否仍在 = "
       f"{runtime.knowledge_set.get('k.demo.incubated') is not None}")
    audit = await runtime.self_pipeline.audit_log()
    ok(f"审计尾：{audit[-1]['kind']} #{audit[-1]['patch_id']} "
       f"status={audit[-1]['status']}")


async def step_growth(runtime: Any, host: Any, ctx: Any) -> None:
    """领域长出：新规则经样例闸门放行 → 自指挂载 → 可回退。"""
    header(7, 7, "领域长出：新规则经样例闸门 → 自指挂载 → 可回退")
    new_rule = KnowledgeEntry(
        id="k.demo.grown_rule",
        level="work",
        kind="rule",
        data={
            "rule": {
                "id": "rule.demo.grown_rule",
                "predicate": "present",
                "config": {"path": "title", "message": "材料须含标题字段"},
                "type": "constraint",
                "target_path": "material",
                "severity": "error",
            }
        },
        source="model",
        title="领域长出的新规则",
    )
    l1, l2, l3 = await host.incubation.verify_gate(new_rule)
    if not (l1.passed and l2.passed and l3.passed):
        raise RuntimeError("新规则未通过样例闸门（机制拒绝，演示中断）")
    flag("样例闸门放行：L1/L2/L3 全过（新规则不违反领域形态约定）")
    await host.incubation.sediment(new_rule)
    grown = await host.incubation.propose_knowledge_patch(
        ctx, new_rule, "演示：领域长出样例放行后自指挂载", round_id="demo-grown"
    )
    if not grown.applied:
        raise RuntimeError(f"领域长出补丁未落链: {grown}")
    ok(f"领域长出挂载：补丁 #{grown.patch_id} 落链")
    rules = runtime.introspection_service.snapshot_rules()["rules"]
    active = any(r["id"] == "rule.demo.grown_rule" for r in rules)
    ok(f"活跃态生效：新规则已在规则表（id=rule.demo.grown_rule，active={active}）")
    undone = await runtime.self_pipeline.revert(
        ctx, grown.patch_id, reason="演示：领域长出回退"
    )
    if undone.status != "reverted":
        raise RuntimeError(f"领域长出回退未完成: {undone}")
    rules_after = runtime.introspection_service.snapshot_rules()["rules"]
    active_after = any(r["id"] == "rule.demo.grown_rule" for r in rules_after)
    ok(f"长出可回退：{undone.status}，活跃态撤销（active={active_after}）")


# ── 主流程 ──

async def main() -> int:
    from contextlib import suppress

    with suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print("=" * 68)
    print("InKling 出厂演示：自进化认知伙伴（你用得越多，它越懂你的领域）")
    print("=" * 68)
    llm = _make_llm()
    try:
        market = rust_market_with_entry()
        runtime, host, mount_service = await boot_inkling(SEED_ROOT, llm=llm, market=market)
    except Exception as exc:
        fail(f"运行时装配失败: {exc}")
        fail("修复方向：确认 .venv 已安装引擎依赖（pip install -e .）且自检门禁全绿："
             "python inkling/self_check.py")
        return 1

    ctx = DemoApprovalCtx()
    try:
        try:
            header(1, 7, "注入 boot_prompt（种子基线）")
            await step_inject(runtime, host)
            await step_mount_rust(runtime, mount_service, ctx)
            await step_round(runtime, host, mount_service, ctx)
            await step_incubate(runtime, host)
            patch_id = await step_patch(runtime, host, ctx)
            await step_revert(runtime, ctx, patch_id)
            await step_growth(runtime, host, ctx)
        except Exception as exc:
            fail(f"演示中断于步骤: {exc}")
            fail("修复方向：定位上一步输出；常见原因——引擎依赖缺失"
                 "（python inkling/self_check.py 定位）、执行件未构建"
                 "（cargo build --manifest-path inkling/exec/Cargo.toml）")
            return 1
        finally:
            await runtime.stop()
    except Exception as exc:
        fail(f"运行时关停异常: {exc}")
        return 1

    print("\n" + "=" * 68)
    print("演示完成：冷启动 → 挂载 → 回合 → 孵化 → 补丁 → 回退 → 领域长出 全链通过")
    flag(f"审批卡轨迹 {len(ctx.cards)} 张：{', '.join(card['key'] for card in ctx.cards[:6])}…")
    flag("出厂自检：python inkling/self_check.py（四项门禁一键聚合）")
    flag("文档：inkling/PLAN.md ｜ manifest：inkling/manifest.json")
    flag("桌面形态：npm --prefix inkling/frontend run dev（前端）"
         "＋ shell 桌面壳（真实桌面冒烟可选）")
    print("=" * 68)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

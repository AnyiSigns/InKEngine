"""InkEngine demo：小说生成场景最小示例（可独立运行，仅依赖引擎包）。

演示引擎核心能力：线性图执行 + 事件流 + checkpoint 持久化 +
interrupt 弹卡挂起/注入重入 + 内容型补丁链（草稿累积）。
"""
from __future__ import annotations

import asyncio

from engine_core.events import EngineEvent
from engine_core.executor import Engine, RunOptions
from engine_core.graph import Graph, NodeContext, TerminateReason
from engine_core.patch_chain import Patch, PatchChain, PatchOp
from engine_core.storage import CheckpointRecord, create_storage


async def _main() -> None:
    # ── 1. 状态 schema：消息累积 + 草稿补丁链 ──
    from engine_core.state import StateSchema

    schema = StateSchema(
        channels={"messages": "add_messages", "draft": "patch_chain"}
    )

    # ── 2. 图：规划 → 弹卡审批 → 起草（草稿 = 补丁链累积）──
    async def plan(ctx: NodeContext) -> dict | None:
        await ctx.emit("thinking_start", {"text": "规划章节大纲"}, step_id="think:1")
        await ctx.emit("thinking_end", {}, step_id="think:1")
        return {"messages": [{"id": "m1", "type": "ai", "content": "计划写第一章"}]}

    async def gated_draft(ctx: NodeContext) -> dict | None:
        chain: PatchChain = ctx.state.get("draft") or PatchChain()
        decision = await ctx.interrupt("gate", {"question": "是否开始起草?"})
        if decision == "yes":
            chain.apply(Patch(op=PatchOp.APPEND, path=("content",), value="第一章草稿……"))
            await ctx.emit("reply_token", {"text": "开始起草"}, step_id="reply:1")
            return {"draft": chain, "approved": True}
        ctx.terminate(TerminateReason.STOP)
        return {}

    g = Graph(name="novel_demo", entry="plan")
    g.add_node("plan", plan)
    g.add_node("gated_draft", gated_draft)
    g.add_edge("plan", "gated_draft")
    g.add_exit("gated_draft")

    storage = create_storage("sqlite:///:memory:")
    engine = Engine(g, options=RunOptions(storage=storage, schema=schema))

    # ── 3. 第一轮：挂起在审批卡（无注入）──
    events: list[EngineEvent] = []
    async for event in engine.run({}, thread_id="book-1", round_id="r1"):
        events.append(event)
    latest: CheckpointRecord | None = await storage.get_latest_checkpoint("book-1")
    assert latest is not None and latest.reason == "interrupted"
    print(f"[1] 事件: {[e.type for e in events]}")
    print(f"[2] 挂起: {latest.reason}（等待审批注入）")

    # ── 4. 第二轮：注入审批值 → 从中断点重入，草稿补丁链落地 ──
    async for event in engine.run(
        {},
        thread_id="book-1",
        round_id="r1",
        resume_from=latest.checkpoint_id,
        inject={"gate": "yes"},
    ):
        events.append(event)
    latest = await storage.get_latest_checkpoint("book-1")
    assert latest is not None
    chain: PatchChain = latest.state["draft"]
    print(f"[3] 重入后状态: approved={latest.state.get('approved')}")
    print(f"[4] 草稿组装: {chain.assemble()['content']}")
    print("[demo OK] 图执行 / 事件流 / interrupt 重入 / 补丁链 全链路跑通")


if __name__ == "__main__":
    asyncio.run(_main())

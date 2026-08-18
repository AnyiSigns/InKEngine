"""InkEngine demo：挂卡审批的标准姿势（approve_before_execute / approve_batch）。

演示引擎核心能力：interrupt 挂起 gate 卡 → 注入决议（accept/edit/
reject/terminate）→ 宿主按决议执行/跳过/终止；合并卡（同回合多写操作
聚合一张卡）；决议策略钩子（auto-approve 直过 / 超时默认拒绝）。

可独立运行，仅依赖引擎包（零宿主依赖、零 LLM 调用）。
"""
from __future__ import annotations

import asyncio

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_EDIT,
    DefaultInterruptPolicy,
    approve_batch,
    approve_before_execute,
)
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.storage import create_storage


class _Workspace:
    """demo 用虚拟写工具（真实宿主导入自己的工作区实现）。"""

    def __init__(self) -> None:
        self.files: dict[str, str] = {}

    def write(self, path: str, content: str) -> None:
        self.files[path] = content


async def _scenario_single(ws: _Workspace) -> None:
    """单动作挂卡：挂起 gate 卡 → 注入 accept → 宿主按决议执行。"""

    async def write_node(ctx):
        decision = await approve_before_execute(
            ctx,
            "gate",
            {"tool": "write_file", "args": {"path": "卷1.md"}, "summary": "写入卷1正文"},
        )
        if decision.decision == DECISION_ACCEPT:
            ws.write("卷1.md", "正文…")
        return {"decided": decision.decision, "source": decision.source}

    g = Graph(name="approval_demo", entry="write")
    g.add_node("write", write_node)
    g.add_exit("write")
    engine = Engine(g, options=RunOptions(storage=create_storage("memory://")))

    first = await engine.ainvoke({}, thread_id="demo-single")
    card = first.interrupt.payload if first.interrupt else {}
    print(f"〔单动作〕挂起 gate 卡：{card.get('node_id')}｜{card.get('output_preview')}")
    resumed = await engine.ainvoke(
        {},
        thread_id="demo-single",
        resume_from=first.checkpoint_id,
        inject={"gate": {"decision": DECISION_ACCEPT}},
    )
    print(
        f"〔单动作〕决议={resumed.state['decided']}（source={resumed.state['source']}）"
        f"→ 已写入 {sorted(ws.files)}"
    )


async def _scenario_batch(ws: _Workspace) -> None:
    """合并卡：同回合多写操作聚合一张卡，注入 edit 逐条采纳。"""

    async def batch_node(ctx):
        decisions = await approve_batch(
            ctx,
            "batch_gate",
            [
                {"tool": "write_file", "args": {"path": "a.md"}, "summary": "写入 a.md"},
                {"tool": "write_file", "args": {"path": "b.md"}, "summary": "写入 b.md"},
            ],
        )
        for d in decisions:
            if d.decision == DECISION_ACCEPT:
                ws.write(d.action["args"]["path"], "内容")
            elif d.decision == DECISION_EDIT:
                ws.write(d.action["args"]["path"], d.edited_content or "")
        return {"batch": [d.decision for d in decisions]}

    g = Graph(name="batch_demo", entry="batch")
    g.add_node("batch", batch_node)
    g.add_exit("batch")
    engine = Engine(g, options=RunOptions(storage=create_storage("memory://")))

    first = await engine.ainvoke({}, thread_id="demo-batch")
    card = first.interrupt.payload if first.interrupt else {}
    print(f"〔合并卡〕挂起：{len(card.get('actions') or [])} 个写操作聚合一张卡")
    resumed = await engine.ainvoke(
        {},
        thread_id="demo-batch",
        resume_from=first.checkpoint_id,
        inject={
            "batch_gate": {
                "decision": DECISION_EDIT,
                "edited_contents": ["a 改写", "b 改写"],
            }
        },
    )
    print(f"〔合并卡〕决议={resumed.state['batch']} → 逐条用编辑后内容落盘：{sorted(ws.files)}")


async def _scenario_policy() -> None:
    """决议策略：list_dir 在直过名单内 → auto 直过（不挂起）。"""

    async def policy_node(ctx):
        policy = DefaultInterruptPolicy(auto_approve_tools=frozenset({"list_dir"}))
        decision = await approve_before_execute(
            ctx,
            "gate",
            {"tool": "list_dir", "args": {"path": "."}, "summary": "列出目录"},
            policy=policy,
        )
        return {"decided": decision.decision, "source": decision.source}

    g = Graph(name="policy_demo", entry="p")
    g.add_node("p", policy_node)
    g.add_exit("p")
    engine = Engine(g, options=RunOptions(storage=create_storage("memory://")))
    result = await engine.ainvoke({}, thread_id="demo-policy")
    print(
        f"〔策略〕list_dir 直过：决议={result.state['decided']}"
        f"（source={result.state['source']}，全程无挂起）"
    )


async def _main() -> None:
    ws = _Workspace()
    await _scenario_single(ws)
    await _scenario_batch(ws)
    await _scenario_policy()


if __name__ == "__main__":
    asyncio.run(_main())

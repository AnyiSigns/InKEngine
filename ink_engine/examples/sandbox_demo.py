"""InkEngine demo：工具执行沙箱与流水线（FileSandbox/ProcessSandbox/ToolPipeline）。

演示引擎核心能力：路径前缀守卫 + symlink 逃逸检测、写前快照还原、
进程白名单 + 超时 kill + 输出截断 + 环境清理、工具执行流水线全环节
（权限门禁 → 挂卡审批 → 沙箱守卫 → 执行 → 审计留痕）。

可独立运行，仅依赖引擎包（零宿主依赖、零 LLM 调用）。
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from ink_engine.core.approval import DECISION_ACCEPT
from ink_engine.core.events import CollectorTransport
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.sandbox import FileSandbox, ProcessSandbox, snapshot_before
from ink_engine.core.storage import create_storage
from ink_engine.core.tool_pipeline import ToolPipeline


async def _scenario_filesystem() -> Path:
    """文件沙箱：允许范围内读写；越界路径拒绝；写前快照可还原。"""
    root = Path(tempfile.mkdtemp(prefix="sandbox-fs-"))
    fs = FileSandbox(root)
    inside = root / "book" / "ch1.md"
    inside.parent.mkdir()
    inside.write_text("旧正文", encoding="utf-8")

    snap = snapshot_before(inside)
    inside.write_text("新正文", encoding="utf-8")
    snap.restore()
    print(f"〔文件沙箱〕根目录内写入正常：{fs.resolve('book/ch1.md')}｜快照还原后={inside.read_text(encoding='utf-8')}")

    try:
        fs.validate("write", str(root.parent / "evil.txt"))
    except Exception as exc:
        print(f"〔文件沙箱〕越界路径被拒：{type(exc).__name__}")
    return root


async def _scenario_process() -> None:
    """进程沙箱：白名单执行 + 环境清理 + 超时 kill + 输出截断。"""
    sb = ProcessSandbox(
        allowlist=(sys.executable,),
        timeout=2.0,
        max_output=50,
        env={"PYTHONIOENCODING": "utf-8"},
    )
    ok = await sb.run(sys.executable, ("-c", "print('hello from sandbox')"))
    print(f"〔进程沙箱〕白名单执行：exit={ok.exit_code}｜stdout={ok.stdout.strip()}")
    long = await sb.run(sys.executable, ("-c", "print('x' * 500)"))
    print(f"〔进程沙箱〕输出截断：{len(long.stdout)} 字符（上限 50，含截断标记）")
    hung = await sb.run(sys.executable, ("-c", "import time; time.sleep(10)"))
    print(f"〔进程沙箱〕超时 kill：timed_out={hung.timed_out}")
    try:
        await sb.run("rm", ("-rf", "/"))
    except Exception as exc:
        print(f"〔进程沙箱〕白名单外命令被拒：{type(exc).__name__}")


async def _scenario_pipeline() -> None:
    """工具执行流水线：权限门禁（review 委托挂卡）→ 沙箱守卫 → 执行 → 审计事件。"""
    root = Path(tempfile.mkdtemp(prefix="sandbox-pipeline-"))
    fs = FileSandbox(root)
    transport = CollectorTransport()

    async def tool_node(ctx):
        pipeline = ToolPipeline(
            gate=PermissionGate(review_tier=lambda tool: tool == "write_file"),
            extractor=lambda spec, args: ("write", str(fs.resolve(str(args["path"])))),
            sandboxes=(fs,),
            executor=lambda ctx, spec, args, approval: "正文已写入（模拟执行）",
        )
        result = await pipeline.execute(
            ctx,
            ToolSpec(
                name="write_file",
                permissions=(f"filesystem:write:{root}/**",),
            ),
            {"path": "ch1.md"},
        )
        return {"decision": result.decision, "error": result.error or ""}

    g = Graph(name="sandbox_demo", entry="tool")
    g.add_node("tool", tool_node)
    g.add_exit("tool")
    engine = Engine(
        g,
        options=RunOptions(storage=create_storage("memory://"), transports=[transport]),
    )

    first = await engine.ainvoke({}, thread_id="pipeline-demo")
    card = first.interrupt.payload if first.interrupt else {}
    print(f"〔流水线〕权限命中 + 门控 L2 → 挂卡审批：{card.get('review_type')}｜{card.get('node_id')}")
    resumed = await engine.ainvoke(
        {},
        thread_id="pipeline-demo",
        resume_from=first.checkpoint_id,
        inject={"gate:write_file": {"decision": DECISION_ACCEPT}},
    )
    print(f"〔流水线〕审批 accept → 执行完成，决议={resumed.state['decision']}")
    audits = [e for e in transport.events if e.type == "tool_audit"]
    print(f"〔流水线〕审计留痕 {len(audits)} 条 tool_audit 事件（operation/decision 入事件流）")


async def _main() -> None:
    await _scenario_filesystem()
    await _scenario_process()
    await _scenario_pipeline()


if __name__ == "__main__":
    asyncio.run(_main())

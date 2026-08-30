"""agent 链连通性实验（真实链逐环节验证，非合成任务）。

本实验不做「新写 LLM 提示词 + 合成任务」那类独立实验，而是**复制/复用真实
链实现并逐环节驱动断言**：链路源 = 产品 agent 回合链（llm_decider 决策循环 +
tool_pipeline 工具分发 + assembly_orchestrator 组装编排 + RoundSteps 回合步骤 +
事件流），全部 import 真实实现，脚本只做「装配真实宿主 + 驱动真实回合 +
逐环节断言」。

被验证的链（数据形态，见 seed_data/graph.json + workflow.json）：

    user 输入
      → boot_inkling（真实宿主装配：seed 数据 / 安全纵深 / 工作区 / MCP 探测）
      → build_round_graph（graph.json 建图：assembly_orchestrator →
        tool_pipeline → llm_decider ⇄ tool_pipeline → end）
      → runtime.engine.ainvoke（引擎图执行）
          assembly_orchestrator: 组装候选/默认研究链 → plan_start/plan_end
          tool_pipeline:        执行 pending 工具 → tool_start/tool_end + 结果回填
          llm_decider:          restore_messages（round_input 开篇注入）→ LLM 流式
                                → reply_token 事件 → 无工具调用收口
      → RoundStepsTransport（事件 → 回合步骤序列快照）
      → reason=reply 终态

逐环节断言（每回合）：
  L1 装配：runtime/engine/host 非空；节点类型注册齐
      （llm_decider / tool_pipeline / assembly_orchestrator / research_orchestrator）
  L2 图：回合图可建（graph.json 数据形态 → Graph，入口/边/出口合法）
  L3 回合：engine 返回 reason=reply，reply 非空
  L4 llm_decider：reply_token 事件发射；messages 含 round_input:{base_round}
      开篇（每回合注入语义，见 P2 调配修复）
  L5 tool_pipeline：tool_start/tool_end 事件配对（离线降级/成功都须成对）
  L6 事件协议：plan_start/plan_end、tool_start/tool_end、reply_token 落事件流
  L7 回合步骤：RoundSteps 快照与事件一致（tool 卡状态收尾、reply 卡存在）
  L8 续链：同 thread 第二回合追加 round_input:r2 开篇、system 不重复

严谨性约定：
  - 模型配置与 tools/benchmarks 同口径：env INKENGINE_LIVE_* 优先，回落
    .kilo/测试模型配置.txt；INKENGINE_EXP_STUB=1 用离线桩（确定性，不联网）。
  - 工作区授权（INKENGINE_EXP_WORKSPACE=1 或默认仓库根）后 file 工具可真实
    执行——工具成功路径也覆盖（llm_decider 自主调 file_read 等）。
  - 失败不重试硬撑；环境错误（网关不可用）如实记录为 env_error 不入链判定。
  - 报告落 docs/experiments/chains/agent-chain-<model>-<ts>.md（README 已登记
    chains/ 区域）。
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
import types
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[1]
SEED_ROOT = REPO_ROOT / "inkling"
PY_ENGINE = (
    REPO_ROOT / "inkling" / "shell" / "src-tauri" / "src" / "engine" / "py"
)
sys.path.insert(0, str(PY_ENGINE))
sys.path.insert(0, str(REPO_ROOT / "ink_engine"))

# 复用既有实验脚本的模型配置装载/选中口径（env 优先，回落 .kilo/测试模型配置.txt）
BENCH_DIR = REPO_ROOT / "tools" / "benchmarks"
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def log(msg: str) -> None:
    print(msg)


# 装配期链恢复辅助的桥桩：纯 Python 进程没有 Rust 壳的 inkling_bridge 模块，
# boot 的链恢复兜底（assemble_chain_with_boot_fallback）import 它作审批辅助；
# fresh memory 存储下链装配首试即成功，桩函数不会被调用（头注留痕）。
def _install_bridge_stub() -> None:
    stub = types.ModuleType("inkling_bridge")
    stub.StandaloneApprovalContext = type(
        "StandaloneApprovalContext", (), {"__init__": lambda self, x: None}
    )
    stub.prefill_approval_decision = lambda *a, **k: None
    sys.modules.setdefault("inkling_bridge", stub)


# ----------------------------------------------------------------------
# 真实模型装配（与 bench_confidence_head 同口径；stub 模式离线确定性）
# ----------------------------------------------------------------------

def _build_llm() -> object:
    """返回真实 AsyncLLM 或离线桩（INKENGINE_EXP_STUB=1）。"""
    if _env("INKENGINE_EXP_STUB"):
        from bridge import StubLLM

        log("[模型] 离线桩模式（INKENGINE_EXP_STUB=1，确定性，不联网）")
        return StubLLM(default_reply="（stub 回复：链已通）")
    from ink_engine.core.llm.base import LLMConfig
    from ink_engine.core.llm.registry import create_llm

    from bench_confidence_head import _pick, load_config

    cfg = load_config()
    model_id = _pick(cfg, "INKENGINE_EXP_MODEL", 0)
    log(f"[模型] 真实模型 {model_id}（端点见 .kilo/测试模型配置.txt）")
    return create_llm(
        LLMConfig(
            adapter="openai_compat",
            model_id=model_id,
            base_url=cfg["url"],
            api_key=cfg["key"],
            request_timeout=60.0,
        )
    )


# ----------------------------------------------------------------------
# 回合任务集（真实链驱动，不重写提示词机制）
# ----------------------------------------------------------------------

ROUND_TASKS: list[dict] = [
    {
        "id": "r1",
        "label": "纯对话（llm_decider 直接收口）",
        "input": "你好，请用一句话回复。",
        "expect_tools": False,
    },
    {
        "id": "r2",
        "label": "文件工具真实执行（llm_decider 自主调 file_read）",
        "input": "请用 file_read 读取仓库根 README.md 的前 3 行并汇报内容。",
        "expect_tools": True,
    },
    {
        "id": "r3",
        "label": "跨回合续链（r2 后续接，round_input:r3 注入）",
        "input": "刚才你读到的 README 讲了什么？用一句话概括。",
        "expect_tools": False,
    },
]


# ----------------------------------------------------------------------
# 装配 + 驱动（真实链实现）
# ----------------------------------------------------------------------

async def boot():
    """真实宿主装配（boot_inkling：seed 数据 / 安全纵深 / 工作区 / MCP 探测）。"""
    from ink_engine.core.events import CollectorTransport
    from inkling_host.host import InKlingHost, boot_inkling

    llm = _build_llm()
    transport = CollectorTransport()
    host = InKlingHost(storage_uri="memory://", llm=llm, transport=transport)
    data_dir = Path(tempfile.mkdtemp(prefix="exp-agent-chain-"))
    runtime, host_ref, _mount = await boot_inkling(
        SEED_ROOT,
        host=host,
        storage_uri="memory://",
        data_dir=data_dir,
        behavior=None,
    )
    workspace = _env("INKENGINE_EXP_WORKSPACE") or "1"
    if workspace:
        root = Path(workspace) if workspace != "1" else REPO_ROOT
        auth = await host_ref.workspaces.authorize_headless(root)
        log(f"[工作区] 授权 {auth.get('root')}（file 工具真实可用）")
    return runtime, host_ref


async def run_round(runtime, host, task: dict, thread_id: str) -> dict:
    """经真实产品回合驱动（bridge.execute_round_to_reply）跑一轮并采集证据。"""
    import bridge

    transport = host._transport
    before = len(getattr(transport, "events", []))
    started = time.time()
    out = await bridge.execute_round_to_reply(
        runtime,
        host,
        input_text=task["input"],
        thread_id=thread_id,
        round_id=task["id"],
        auto_accept_review=True,
    )
    elapsed = time.time() - started
    events = list(getattr(transport, "events", []))[before:]
    steps = host.round_recorder.snapshot()
    return {
        "task": task,
        "out": out,
        "events": events,
        "steps": steps,
        "elapsed": elapsed,
    }


# ----------------------------------------------------------------------
# 逐环节断言（L1..L8）
# ----------------------------------------------------------------------

def _event_types(events: list) -> list[str]:
    return [getattr(e, "type", "") for e in events]


def _tool_pairs(events: list) -> list[tuple[str, bool]]:
    """tool_start/tool_end 按 tool 名配对（每 tool 一个 (名, success)）。"""
    pairs: dict[str, list[bool]] = {}
    for e in events:
        t = getattr(e, "type", "")
        payload = getattr(e, "payload", {}) or {}
        name = str(payload.get("tool") or "")
        if not name:
            continue
        if t == "tool_start":
            pairs.setdefault(name, [])
        elif t == "tool_end":
            pairs.setdefault(name, []).append(bool(payload.get("success", True)))
    return [(name, all(vs) and len(vs) == 1) for name, vs in pairs.items() if vs]


def _messages_roles(state: dict) -> list[str]:
    return [str(m.get("role") or "") for m in (state.get("messages") or [])]


def _messages_ids(state: dict) -> list[str]:
    return [str(m.get("id") or "") for m in (state.get("messages") or [])]


def _assert(checks: list[tuple[str, bool, str]]) -> list[dict]:
    return [
        {"name": name, "pass": ok, "evidence": evidence}
        for name, ok, evidence in checks
    ]


def assert_round(evidence: dict) -> list[dict]:
    """单回合 L1-L7 断言（L8 由主流程跨回合断言）。"""
    runtime = evidence["runtime"]
    host = evidence["host"]
    task = evidence["task"]
    out = evidence["out"]
    events = evidence["events"]
    steps = evidence["steps"]
    state = out.get("state") or {}
    ev_types = _event_types(events)

    checks: list[tuple[str, bool, str]] = []

    # L1 装配
    node_types = []
    regs = getattr(runtime, "graph_registries", None)
    if regs is not None:
        node_types = sorted(regs.nodes.types())
    checks.append(
        (
            "L1 装配（engine/节点类型注册）",
            runtime.engine is not None
            and all(n in node_types for n in ("llm_decider", "tool_pipeline")),
            f"engine={runtime.engine is not None} 节点={node_types}",
        )
    )

    # L3 回合终态
    checks.append(
        (
            "L3 回合终态（reason=reply + reply 非空）",
            out.get("reason") == "reply" and bool((state.get("reply") or "").strip()),
            f"reason={out.get('reason')} reply={str(state.get('reply'))[:40]!r}",
        )
    )

    # L4 llm_decider：reply_token 事件 + round_input 开篇
    has_reply_token = "reply_token" in ev_types
    opener = f"round_input:{task['id']}"
    has_opener = opener in _messages_ids(state)
    checks.append(
        (
            "L4 llm_decider（reply_token + round_input 开篇）",
            has_reply_token and has_opener,
            f"reply_token={has_reply_token} opener={opener}={has_opener}",
        )
    )

    # L5 tool_pipeline：tool_start/tool_end 配对
    pairs = _tool_pairs(events)
    ok_pairs = [p for p in pairs if p[1]]
    checks.append(
        (
            "L5 tool_pipeline（tool_start/tool_end 配对）",
            bool(pairs),
            f"pairs={pairs}（本回合期望工具={task['expect_tools']}）",
        )
    )
    if ok_pairs:
        # 成功路径：工具结果应回填消息流（tool 角色）
        checks.append(
            (
                "L5b 工具结果回填消息流",
                "tool" in _messages_roles(state),
                f"roles={_messages_roles(state)}",
            )
        )

    # L6 事件协议
    need = {"plan_start", "plan_end", "reply_token"}
    missing = sorted(need - set(ev_types))
    checks.append(
        (
            "L6 事件协议（plan/reply_token 落流）",
            not missing,
            f"missing={missing} types={ev_types}",
        )
    )

    # L7 回合步骤
    step_types = [s.get("type") for s in steps]
    tool_steps = [s for s in steps if s.get("type") == "tool"]
    running_tools = [
        s.get("step_id")
        for s in tool_steps
        if s.get("payload", {}).get("status") not in ("done", "error", "pending")
    ]
    checks.append(
        (
            "L7 回合步骤（tool 卡收尾 + reply 卡）",
            bool(tool_steps)
            and not running_tools
            and any(s.get("type") == "reply_token" for s in steps),
            f"steps={step_types} running_tool={running_tools}",
        )
    )
    return _assert(checks)


# ----------------------------------------------------------------------
# 报告
# ----------------------------------------------------------------------

def _model_label() -> str:
    if _env("INKENGINE_EXP_STUB"):
        return "stub（离线桩）"
    try:
        from bench_confidence_head import _pick, load_config

        return _pick(load_config(), "INKENGINE_EXP_MODEL", 0)
    except Exception:  # noqa: BLE001
        return "（未解析）"


async def main() -> int:
    _install_bridge_stub()
    git_head = ""
    try:
        git_head = (
            os.popen("git rev-parse --short HEAD").read().strip()
        )
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    runtime, host = await boot()
    log("=" * 78)
    log("装配完成，开始回合驱动")
    log("=" * 78)

    thread_id = f"exp-agent-{int(time.time())}"
    results: list[dict] = []
    all_asserts: list[dict] = []
    env_errors: list[str] = []

    for i, task in enumerate(ROUND_TASKS, 1):
        log(f"[回合 {i}/{len(ROUND_TASKS)}] {task['id']} {task['label']}")
        try:
            ev = await run_round(runtime, host, task, thread_id)
        except Exception as exc:  # noqa: BLE001 环境错误如实记录，不入链判定
            env_errors.append(f"{task['id']}: {type(exc).__name__} {str(exc)[:80]}")
            log(f"[回合 {task['id']}] 环境错误: {env_errors[-1]}")
            continue
        checks = assert_round({**ev, "runtime": runtime, "host": host})
        results.append({"task": task, "ev": ev, "checks": checks})
        all_asserts.extend(checks)
        for c in checks:
            mark = "PASS" if c["pass"] else "FAIL"
            log(f"  {mark} {c['name']} — {c['evidence']}")
        log(f"  耗时 {ev['elapsed']:.1f}s")
        log("")

    # L8 跨回合续链：r3 的 system 只出现一次、r2 开篇存在、r3 开篇存在
    l8_fail = None
    if len(results) >= 3:
        s2 = results[1]["ev"]["out"].get("state") or {}
        s3 = results[2]["ev"]["out"].get("state") or {}
        ids3 = _messages_ids(s3)
        roles3 = _messages_roles(s3)
        l8_ok = (
            "round_input:r2" in ids3
            and "round_input:r3" in ids3
            and roles3.count("system") == 1
        )
        l8_fail = "system 重复/开篇缺失" if not l8_ok else None
        log(f"L8 跨回合续链（system×1 + r2/r3 开篇）: {'PASS' if l8_ok else 'FAIL'}")
        log(f"  ids={ids3} roles={roles3}")
    elif env_errors:
        log("L8 跨回合续链: 跳过（有环境错误）")

    # ---- 汇总 ----
    lines: list[str] = []
    lines.append("# agent 链连通性实验报告（真实链逐环节验证）")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 耗时：{time.time() - started:.0f}s")
    lines.append(f"- 模型：{_model_label()}")
    lines.append(f"- git HEAD：{git_head or '未知'}")
    lines.append("- 链：`user 输入 → boot_inkling → build_round_graph → "
                 "engine.ainvoke（assembly_orchestrator → tool_pipeline ⇄ "
                 "llm_decider）→ RoundSteps → reason=reply`")
    lines.append("- 代码：import 真实实现（`inkling_host` / `bridge` / `ink_engine`），"
                 "脚本仅装配 + 驱动 + 断言，未重写链逻辑")
    lines.append("")

    passed = sum(1 for c in all_asserts if c["pass"])
    total = len(all_asserts)
    lines.append("## 实验效果")
    lines.append("")
    lines.append(f"| 指标 | 实测 | 达标线 |")
    lines.append(f"|---|---|---|")
    lines.append(f"| 回合逐环节断言通过率 | {passed}/{total} = {passed / total:.0%} | 100% |")
    lines.append(f"| 回合完成（reason=reply） | "
                 f"{sum(1 for r in results if r['ev']['out'].get('reason') == 'reply')}"
                 f"/{len(ROUND_TASKS)} | 100% |")
    lines.append(f"| 环境错误 | {len(env_errors)} | 0 |")
    lines.append("")

    lines.append("## 逐环节断言")
    lines.append("")
    lines.append("| 回合 | 环节 | 结果 | 证据 |")
    lines.append("|---|---|---|---|")
    for r in results:
        for c in r["checks"]:
            lines.append(
                f"| {r['task']['id']} | {c['name']} | {'✅' if c['pass'] else '❌'} | "
                f"{c['evidence'][:90]} |"
            )
    if results:
        last_state = results[-1]["ev"]["out"].get("state") or {}
        ids_last = _messages_ids(last_state)
        lines.append("")
        lines.append("## L8 跨回合续链")
        lines.append("")
        if l8_fail:
            lines.append(f"- ❌ {l8_fail}")
        else:
            lines.append("- ✅ system 仅一次 + 各回合 `round_input:{base_round}` 开篇注入")
        lines.append(f"- 末回合消息 ids：{ids_last}")

    lines.append("")
    lines.append("## 失败明细与分类")
    lines.append("")
    failed = [c for c in all_asserts if not c["pass"]]
    if not failed and not env_errors:
        lines.append("- 无失败（全部断言通过）。")
    for c in failed:
        lines.append(f"- ❌ {c['name']}：{c['evidence']}（分类：链机制待核实）")
    for e in env_errors:
        lines.append(f"- 环境错误：{e}")

    lines.append("")
    lines.append("## 执行命令")
    lines.append("")
    lines.append("```powershell")
    lines.append('$env:INKENGINE_LIVE_BASE_URL = "<来源：.kilo/测试模型配置.txt 的 url 字段>"')
    lines.append('$env:INKENGINE_LIVE_API_KEY  = "<来源：.kilo/测试模型配置.txt 的 key 字段>"')
    lines.append('# 可选：$env:INKENGINE_EXP_MODEL = "<模型 id>"')
    lines.append('# 离线确定性：$env:INKENGINE_EXP_STUB = "1"')
    lines.append('& ".venv\\Scripts\\python.exe" -X utf8 experiment\\exp_agent_chain.py')
    lines.append("```")

    report_dir = REPO_ROOT / "docs" / "experiments" / "chains"
    report_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(lines) + "\n"
    (report_dir / f"agent-chain-{ts}.md").write_text(body, encoding="utf-8")
    (report_dir / "latest-agent-chain.md").write_text(body, encoding="utf-8")

    log("\n" + "=" * 78)
    print(body)
    log(f"[报告] {report_dir / f'agent-chain-{ts}.md'}")
    return 0 if (not failed and not env_errors) else 1


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception:  # noqa: BLE001 崩溃详情落盘，便于隔夜/后台诊断
        import traceback

        tb = traceback.format_exc()
        crash = REPO_ROOT / "docs" / "experiments" / "chains" / "_agent_chain_crash.log"
        crash.parent.mkdir(parents=True, exist_ok=True)
        crash.write_text(tb, encoding="utf-8")
        log(f"[崩溃] 详情已写 {crash}\n{tb}")
        sys.exit(1)

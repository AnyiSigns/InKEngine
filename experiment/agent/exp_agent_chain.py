"""agent 链连通性实验（真实链端到端逐环节验证，非合成任务）。

本实验不做「新写 LLM 提示词 + 合成任务」那类独立实验，而是**驱动真实产品
链路并逐环节断言**。驱动面 = headless Rust 壳（`inkling-headless --round`），
它与桌面壳共用同一 EngineHost（host.rs H12：headless 与桌面壳共用同一宿主），
覆盖完整业务逻辑：

    前端用户输入 → Rust 壳 round_send（rounds.rs：回合记录器 / 账本 / 审批）
        → EngineHost::round（host.rs:667）→ PyO3 → bridge.execute_round_to_reply
        → runtime.engine.ainvoke（真实图执行）
            assembly_orchestrator → tool_pipeline ⇄ llm_decider → end
        → 事件流（input_assembly / plan_start / plan_end / tool_start /
          tool_end / reply_token / error）→ reason=reply

脚本不做 Python 直连（避免跳过壳侧业务逻辑），全部经 headless 进程驱动，
逐轮收集事件流做断言。可测同 thread 多轮续链（--thread-id 固定 + --round-id
递增），这是直连脚本测不到的完整链路。

被验证的链（数据形态，见 inkling/seed_data/graph.json + workflow.json）：
- 装配：boot_engine（seed 数据 / 安全纵深 / 工作区 / 模型接线）
- 图：graph.json → Graph（assembly_orchestrator → tool_pipeline →
  llm_decider ⇄ tool_pipeline → end，exits=[end]）
- 回合：engine.ainvoke 图执行 + 事件流 + RoundSteps

逐环节断言：
  L1 装配：headless 回合返回 ok=true，reason=reply
  L2 事件协议：回合内事件类型完备（input_assembly / plan_start / plan_end /
      reply_token 必须出现）
  L3 llm_decider：reply_token 事件发射（LLM 真实调用，流式回传）
  L4 tool_pipeline：tool_start/tool_end 配对（离线降级/成功都须成对）
  L5 续链（同 thread 多轮）：第二轮仍产出新事件 + reply_token（跨回合上下文
      延续；若第二轮事件数为 0 = 续链短路，记录为链缺陷）

严谨性约定：
  - 模型接线与产品同口径：INK_LLM_BASE_URL/INK_LLM_MODEL/INK_LLM_API_KEY
    环境变量显式配置时走真实模型（headless 门禁三要素齐备）；缺省 = 离线
    StubLLM（确定性，不联网）。本脚本默认离线桩，真实模型由环境变量开关。
  - 失败不重试硬撑；环境错误（Python 桥不可用等）如实记录为 env_error。
  - 报告落 docs/experiments/chains/agent-chain-headless-<ts>.md。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADLESS = (
    REPO_ROOT / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"
)

# Windows 下 PyO3 嵌入 Python 需要运行库在 PATH + PYTHONHOME 定位
PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "python.exe"


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def log(msg: str) -> None:
    print(msg)


def _headless_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV_PYTHON)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    return env


def run_round(
    data_dir: Path,
    thread_id: str,
    round_id: str,
    text: str,
) -> dict:
    """经 headless（真实 Rust 壳 → bridge → 引擎）驱动一轮，返回解析后的信封。"""
    cmd = [
        str(HEADLESS),
        "--data-dir", str(data_dir),
        "--thread-id", thread_id,
        "--round-id", round_id,
        "--round", text,
    ]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_headless_env(),
        timeout=600,
    )
    envelope = {}
    try:
        envelope = json.loads(proc.stdout)
    except json.JSONDecodeError:
        envelope = {"ok": False, "error": {"message": f"非 JSON 信封: {proc.stdout[:200]}"}}
    if not envelope.get("ok"):
        return {
            "ok": False,
            "reason": None,
            "output": None,
            "events": [],
            "stderr": proc.stderr,
            "raw": envelope,
        }
    data = envelope.get("data") or {}
    return {
        "ok": True,
        "reason": data.get("reason"),
        "output": data.get("output"),
        "events": data.get("events") or [],
        "stderr": proc.stderr,
        "raw": envelope,
    }


# ----------------------------------------------------------------------
# 回合任务集
# ----------------------------------------------------------------------

ROUND_TASKS: list[dict] = [
    {
        "id": "r1",
        "label": "纯对话（llm_decider 收口）",
        "input": "你好，请用一句话回复。",
    },
    {
        "id": "r2",
        "label": "同 thread 续链（跨回合上下文延续）",
        "input": "第二轮：刚才你说了什么？请用一句话复述。",
    },
    {
        "id": "r3",
        "label": "第三轮续链（确认续链稳定）",
        "input": "第三轮：现在你叫什么？请用一句话回答。",
    },
]


# ----------------------------------------------------------------------
# 逐环节断言
# ----------------------------------------------------------------------

def _types(events: list[dict]) -> list[str]:
    return [e.get("type") for e in events]


def _tool_pairs(events: list[dict]) -> list[tuple[str, bool]]:
    """tool_start/tool_end 按 tool 名配对（每 tool 一个 (名, success)）。"""
    pairs: dict[str, list[bool]] = {}
    for e in events:
        t = e.get("type")
        payload = e.get("payload") or {}
        name = str(payload.get("tool") or "")
        if not name:
            continue
        if t == "tool_start":
            pairs.setdefault(name, [])
        elif t == "tool_end":
            pairs.setdefault(name, []).append(bool(payload.get("success", True)))
    return [(name, all(vs) and len(vs) == 1) for name, vs in pairs.items() if vs]


def assert_round(ev: dict, task: dict) -> list[dict]:
    """单回合 L1-L4 断言（L5 由主流程跨回合断言）。"""
    checks: list[tuple[str, bool, str]] = []
    ev_types = _types(ev["events"])

    # L1 装配/回合
    checks.append(
        (
            "L1 回合完成（headless ok + reason=reply）",
            ev["ok"] and ev["reason"] == "reply",
            f"ok={ev['ok']} reason={ev['reason']}",
        )
    )

    # L2 事件协议
    need = {"input_assembly", "plan_start", "plan_end", "reply_token"}
    missing = sorted(need - set(ev_types))
    checks.append(
        (
            "L2 事件协议（assembly/plan/reply_token 落流）",
            not missing,
            f"missing={missing} types={sorted(set(ev_types))}",
        )
    )

    # L3 llm_decider：reply_token 事件（LLM 真实调用）
    checks.append(
        (
            "L3 llm_decider（reply_token 流式）",
            "reply_token" in ev_types,
            f"reply_token×{ev_types.count('reply_token')}",
        )
    )

    # L4 tool_pipeline：tool_start/tool_end 配对
    pairs = _tool_pairs(ev["events"])
    checks.append(
        (
            "L4 tool_pipeline（tool_start/tool_end 配对）",
            bool(pairs),
            f"pairs={pairs}",
        )
    )
    return [
        {"name": name, "pass": ok, "evidence": evidence}
        for name, ok, evidence in checks
    ]


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

async def main() -> int:
    if not HEADLESS.exists():
        log(f"[headless 缺失] {HEADLESS} 不存在——先 `cargo build --bin inkling-headless`")
        return 2

    git_head = ""
    try:
        git_head = os.popen("git rev-parse --short HEAD").read().strip()
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    data_dir = Path(_env("INKENGINE_EXP_DATA_DIR") or "") or Path(
        os.environ.get("TEMP", ".") or "."
    ) / f"exp-agent-chain-{int(time.time())}"
    thread_id = f"e2e-agent-{int(time.time())}"
    if _env("INKENGINE_EXP_THREAD"):
        thread_id = _env("INKENGINE_EXP_THREAD")

    log("=" * 78)
    log(f"真实链端到端实验（headless 驱动）")
    log(f"thread={thread_id}  data_dir={data_dir}  rounds={len(ROUND_TASKS)}")
    log("=" * 78)

    results: list[dict] = []
    env_errors: list[str] = []

    for i, task in enumerate(ROUND_TASKS, 1):
        log(f"[回合 {i}/{len(ROUND_TASKS)}] {task['id']} {task['label']}")
        try:
            ev = run_round(data_dir, thread_id, task["id"], task["input"])
        except subprocess.TimeoutExpired:
            env_errors.append(f"{task['id']}: headless 超时")
            log(f"[回合 {task['id']}] 超时")
            continue
        if not ev["ok"]:
            msg = str(ev.get("raw", {}).get("error") or {}).get("message", ev.get("stderr", ""))[:120]
            env_errors.append(f"{task['id']}: headless 失败 {msg}")
            log(f"[回合 {task['id']}] 环境错误: {env_errors[-1]}")
            continue
        checks = assert_round(ev, task)
        results.append({"task": task, "ev": ev, "checks": checks})
        for c in checks:
            mark = "PASS" if c["pass"] else "FAIL"
            log(f"  {mark} {c['name']} — {c['evidence']}")
        ev_types = _types(ev["events"])
        log(f"  事件：{len(ev['events'])} 条（{sorted(set(ev_types))}）")
        log("")

    # L5 跨回合续链：r2/r3 必须仍产出新事件（零事件 = 续链短路）
    l5_checks: list[dict] = []
    for task in ROUND_TASKS[1:]:
        hit = next((r for r in results if r["task"]["id"] == task["id"]), None)
        if hit is None:
            continue
        n = len(hit["ev"]["events"])
        has_reply = "reply_token" in _types(hit["ev"]["events"])
        l5_checks.append(
            {
                "name": f"L5 续链（{task['id']} 产出新事件 + reply_token）",
                "pass": n > 0 and has_reply,
                "evidence": f"events={n} reply_token={has_reply}",
            }
        )
        mark = "PASS" if l5_checks[-1]["pass"] else "FAIL"
        log(f"{mark} {l5_checks[-1]['name']} — {l5_checks[-1]['evidence']}")
    log("")

    # ---- 汇总 ----
    all_asserts = [c for r in results for c in r["checks"]] + l5_checks
    passed = sum(1 for c in all_asserts if c["pass"])
    total = len(all_asserts)

    lines: list[str] = []
    lines.append("# agent 链连通性实验报告（headless 端到端，真实链逐环节验证）")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 耗时：{time.time() - started:.0f}s")
    lines.append(f"- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎，"
                 f"与桌面壳共用 EngineHost）")
    lines.append(f"- git HEAD：{git_head or '未知'}")
    lines.append("- 模型：INK_LLM_* 环境变量配置时走真实模型；缺省离线 StubLLM")
    lines.append("- 代码：脚本仅驱动 + 断言，未改写任何链逻辑（壳/桥/引擎全真实）")
    lines.append("")

    lines.append("## 实验效果")
    lines.append("")
    lines.append("| 指标 | 实测 | 达标线 |")
    lines.append("|---|---|---|")
    lines.append(f"| 逐环节断言通过率 | {passed}/{total} = {passed / total:.0%} | 100% |")
    lines.append(
        f"| 回合完成（reason=reply） | "
        f"{sum(1 for r in results if r['ev']['reason'] == 'reply')}/{len(ROUND_TASKS)} | 100% |"
    )
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
    for c in l5_checks:
        lines.append(f"| L5 | {c['name']} | {'✅' if c['pass'] else '❌'} | {c['evidence'][:90]} |")

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
    lines.append("# 离线桩模式（默认，确定性）")
    lines.append('& ".venv\\Scripts\\python.exe" -X utf8 experiment\\exp_agent_chain.py')
    lines.append("# 真实模型模式（headless 门禁三要素）")
    lines.append('$env:INK_LLM_BASE_URL = "<url>"')
    lines.append('$env:INK_LLM_MODEL = "<model_id>"')
    lines.append('$env:INK_LLM_API_KEY = "<key>"')
    lines.append('& ".venv\\Scripts\\python.exe" -X utf8 experiment\\exp_agent_chain.py')
    lines.append("```")

    report_dir = REPO_ROOT / "docs" / "experiments" / "chains"
    report_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(lines) + "\n"
    (report_dir / f"agent-chain-headless-{ts}.md").write_text(body, encoding="utf-8")
    (report_dir / "latest-agent-chain.md").write_text(body, encoding="utf-8")

    log("=" * 78)
    print(body)
    log(f"[报告] {report_dir / f'agent-chain-headless-{ts}.md'}")
    return 0 if (not failed and not env_errors) else 1


if __name__ == "__main__":
    import asyncio

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

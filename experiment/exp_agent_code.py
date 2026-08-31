"""agent 代码任务续航实验（真实链端到端，工作区挂载 + 全程无人值守）。

与 exp_agent_chain.py 的连通性验证不同，本实验**驱动真实 agent 在真实工作区
完成一个完整代码任务**，刻意不引导实现细节，测试：
  1. 续航：单回合内 agent 自主推进到交付（工具调用轮数 / 事件量 / 耗时）；
  2. 稳定性/随机性：真实模型 + 不固定实现路径，重复跑应能可靠产出；
  3. 链路通畅：演化（propose_patch/apply_patch）、知识集（distill/mutate
     knowledge）、组装（plan/assembly）、推演（validate/score/review）事件
     是否真实发生并可观测；
  4. 端点问题：file_ops / process_exec / mcp / http_fetch 各端点工具执行
     成败与兜底行为。

驱动面 = headless Rust 壳（与桌面壳共用 EngineHost），工作区授权经
`INKENGINE_WS_ROOT` 覆盖到仓库外目录（lib.rs wire_round_execution），
agent 的文件工具沙箱根即该工作区。

任务（不引导细节）：企业客服 RAG 问答服务，mock 外部端点 + 工作区虚拟
环境跑测试。技术选型/结构/接口形态全部由 agent 自主决定。
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
HEADLESS = REPO_ROOT / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"

# 底层 headless 运行库（PyO3 嵌入需要；非 agent 工作区虚拟环境）
PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "python.exe"

# agent 工作区（挂载工作点，文件工具沙箱根）
WS_ROOT = Path(r"C:\Users\Anyi\Documents\test")
# agent 工作区虚拟环境（agent 跑测试用，非底层）
WS_VENV = WS_ROOT / ".venv" / "Scripts" / "python.exe"


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def log(msg: str) -> None:
    print(msg)


def _headless_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV_PYTHON)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    env["INKENGINE_WS_ROOT"] = str(WS_ROOT)
    return env


def run_round(
    data_dir: Path,
    thread_id: str,
    round_id: str,
    text: str,
    live_file: Path,
    timeout: float = 1800.0,
) -> dict:
    """经 headless（真实 Rust 壳 → bridge → 引擎）驱动一轮，返回解析后的信封。

    live_file：回合内实时观测文件（stderr 诊断行逐行追加，即时刷新）。
    """
    cmd = [
        str(HEADLESS),
        "--data-dir", str(data_dir),
        "--thread-id", thread_id,
        "--round-id", round_id,
        "--round", text,
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=_headless_env(),
    )
    # 实时可观测：回合内 stderr 诊断行（live_progress）逐行落盘（flush 即时刷新），
    # 不打印控制台；stdout 终态信封收集后统一解析。
    import selectors

    live_lines: list[str] = []
    assert proc.stderr is not None
    assert proc.stdout is not None
    import threading

    timed_out = threading.Event()
    stdout_text: list[str] = []

    def _collect_stdout() -> None:
        try:
            data = proc.stdout.read()
            stdout_text.append(data)
        except Exception:  # noqa: BLE001
            pass

    t = threading.Thread(target=_collect_stdout, daemon=True)
    t.start()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            line = proc.stderr.readline()
            if not line and proc.poll() is not None:
                break
            if line:
                line = line.rstrip("\n")
                live_lines.append(line)
                live_file.write_text("\n".join(live_lines) + "\n", encoding="utf-8")
        else:
            timed_out.set()
            proc.kill()
            raise subprocess.TimeoutExpired("inkling-headless", timeout)
    finally:
        proc.wait(timeout=60)
        t.join(timeout=30)
    envelope = {}
    try:
        envelope = json.loads(stdout_text[0] if stdout_text else "")
    except json.JSONDecodeError:
        envelope = {"ok": False, "error": {"message": f"非 JSON 信封: {(stdout_text[0] if stdout_text else '')[:200]}"}}
    if not envelope.get("ok"):
        return {
            "ok": False,
            "reason": None,
            "output": None,
            "events": [],
            "stderr": "\n".join(live_lines),
            "raw": envelope,
        }
    data = envelope.get("data") or {}
    return {
        "ok": True,
        "reason": data.get("reason"),
        "output": data.get("output"),
        "events": data.get("events") or [],
        "stderr": "\n".join(live_lines),
        "raw": envelope,
    }


# ----------------------------------------------------------------------
# 任务描述（刻意不引导实现细节；只给需求 + 约束）
# ----------------------------------------------------------------------

# 提示词刻意不告知工作区路径：工作区由脚本经端点（INKENGINE_WS_ROOT →
# workspace.authorize_headless）挂载，agent 用文件工具（glob/file_read）时应
# 自然看到挂载的工作区内容——这本身即「挂载是否生效」的观测点。
TASK_R1 = (
    "在您的工作区中创建一个完整可运行的企业客服 RAG 问答服务项目。需求：\n"
    "1. 知识库：内置若干企业客服常见问题文档，做切分 → 索引 → 检索，"
    "给定客服问题能召回最相关的知识片段；\n"
    "2. 问答：基于召回片段生成客服回答。生成器不接真实 LLM 端点，"
    "用 mock 占位（可模板/规则/本地伪生成器实现），保持接口形态真实；\n"
    "3. 服务形态：CLI 或 HTTP 接口均可，能实际调用（输入客服问题 → 得到回答），"
    "并支持把新知识写入知识库；\n"
    "4. 外部依赖全部 mock 占位：embedding（可用词频/hash 占位）、向量检索"
    "（可用内存实现）、知识库存储（可用本地文件），不接任何真实端点；\n"
    "5. 必须带自动化测试：覆盖检索与问答主路径，使用您工作区中的虚拟环境"
    "运行并全部通过（虚拟环境的位置可用 glob 在工作区中确认，通常为 .venv）；\n"
    "6. 项目结构、接口设计、测试框架、实现细节全部自主决定，"
    "无需中途确认或征询意见，直接做完全部工作。\n"
    "完成后简要汇报：项目结构、如何运行、测试结果。"
)

TASK_CONTINUE = (
    "请继续完成你在该工作区尚未完成的工作：补齐缺失模块、修复失败测试，"
    "直至项目完整可运行且测试全部通过。完成后给出项目结构、运行方式、测试结果。"
    "细节仍自主决定，无需征询意见。"
)

TASK_WRAPUP = (
    "请确认项目已完整可交付：如有未完成项请继续完成；如已完成，请给出"
    "最终的项目结构清单、运行方式、测试结果与交付说明。"
)


# ----------------------------------------------------------------------
# 链路观测
# ----------------------------------------------------------------------

# 链路 → 工具名映射（观测各链路是否真实发生）
CHAIN_TOOLS = {
    "演化": {"propose_patch", "apply_patch", "revert_patch"},
    "知识集": {"distill_knowledge", "mutate_knowledge", "material_import"},
    "推演": {"validate_material", "review_material", "parse_material"},
    "研究": {"collect_material", "fetch", "web_search"},
    "文件端点": {"file_read", "file_write", "file_edit", "grep", "glob"},
    "命令端点": {"run_test_python", "run_typecheck", "shell_exec", "system_query"},
    "内省/装配": {"inspect_tools", "inspect_graph", "inspect_rules", "search_tools", "request_tool"},
}


def analyze(ev: dict) -> dict:
    """回合事件流 → 链路观测统计。"""
    events = ev["events"]
    tool_calls: list[dict] = []
    opens: dict[str, dict] = {}
    for e in events:
        t = e.get("type")
        payload = e.get("payload") or {}
        name = str(payload.get("tool") or "")
        if not name:
            continue
        if t == "tool_start":
            opens[name] = payload
        elif t == "tool_end":
            opens.pop(name, None)
            tool_calls.append(
                {
                    "tool": name,
                    "success": bool(payload.get("success", True)),
                    "message": str(payload.get("message") or "")[:140],
                }
            )
    calls = {}
    for c in tool_calls:
        calls.setdefault(c["tool"], {"n": 0, "ok": 0, "fail": 0, "msgs": []})
        calls[c["tool"]]["n"] += 1
        if c["success"]:
            calls[c["tool"]]["ok"] += 1
        else:
            calls[c["tool"]]["fail"] += 1
            calls[c["tool"]]["msgs"].append(c["message"])
    chain_stats = {}
    for chain, tools in CHAIN_TOOLS.items():
        hit = [t for t in tools if t in calls]
        if hit:
            total = sum(calls[t]["n"] for t in hit)
            ok = sum(calls[t]["ok"] for t in hit)
            chain_stats[chain] = {"tools": sorted(hit), "total": total, "ok": ok, "fail": total - ok}
    types = [e.get("type") for e in events]
    return {
        "event_count": len(events),
        "tool_calls": len(tool_calls),
        "unique_tools": sorted(calls),
        "calls": calls,
        "chain_stats": chain_stats,
        "event_types": sorted(set(types)),
        "has_reply": "reply_token" in types,
        "has_plan": "plan_start" in types and "plan_end" in types,
        "has_assembly": "input_assembly" in types,
    }


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

async def main() -> int:
    if not HEADLESS.exists():
        log(f"[headless 缺失] {HEADLESS} 不存在——先 `cargo build --bin inkling-headless`")
        return 2
    if not WS_ROOT.is_dir():
        log(f"[工作区缺失] {WS_ROOT} 不存在")
        return 2

    git_head = ""
    try:
        git_head = os.popen("git rev-parse --short HEAD").read().strip()
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    data_dir = Path(os.environ.get("TEMP", ".")) / f"exp-agent-code-{int(time.time())}"
    thread_id = f"e2e-code-{int(time.time())}"
    round = {"id": "r1", "label": "单回合：RAG 客服服务（自主实现 + 测试通过）", "text": TASK_R1}

    # 产物目录（实时观测落盘：live 流 / 完整事件 / 输出 content / 报告）
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = REPO_ROOT / "docs" / "experiments" / "chains" / "agent-code" / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    live_file = out_dir / "live.r1.log"
    events_file = out_dir / "events.r1.json"
    output_file = out_dir / "output.r1.txt"
    report_file = out_dir / "report.md"
    log(f"[实验] 单回合 agent 代码任务，产物目录: {out_dir}")
    log(f"[实验] live 实时观测: {live_file}")
    log(f"[实验] 工作区={WS_ROOT}  工作区虚拟环境={WS_VENV}")

    model_env = bool(
        _env("INK_LLM_BASE_URL") and _env("INK_LLM_MODEL") and _env("INK_LLM_API_KEY")
    )
    log(f"[模型] 真实模型={'是' if model_env else '否（缺 INK_LLM_* 环境变量，回落离线桩）'}")
    log(f"[回合 r1] 开始（单回合续航，回合内不中断交流）")

    result: dict = {}
    env_errors: list[str] = []
    elapsed = 0.0
    t0 = time.time()
    try:
        result = run_round(
            data_dir, thread_id, round["id"], round["text"], live_file=live_file
        )
        elapsed = time.time() - t0
    except subprocess.TimeoutExpired:
        elapsed = time.time() - t0
        env_errors.append("r1: headless 超时（>1800s，续航断链）")
        log(f"[回合 r1] 超时（{elapsed:.0f}s）")
    if result and not result["ok"]:
        msg = str(result.get("raw", {}).get("error") or {}).get("message", result.get("stderr", ""))[:200]
        env_errors.append(f"r1: headless 失败 {msg}")
        log(f"[回合 r1] 环境错误: {env_errors[-1]}")

    if result and result["ok"]:
        stats = analyze(result)
        # 完整事件 + 输出 content 落文件（终态）
        events_file.write_text(
            json.dumps(result["events"], ensure_ascii=False, indent=1), encoding="utf-8"
        )
        output_file.write_text((result["output"] or "").strip(), encoding="utf-8")
        log(f"[回合 r1] 完成 耗时 {elapsed:.0f}s  reason={result['reason']}  "
            f"events={stats['event_count']}  tool_calls={stats['tool_calls']}")
        for chain, s in sorted(stats["chain_stats"].items()):
            log(f"[链路] {chain}: {', '.join(sorted(s['tools']))} 调 {s['total']}（成功 {s['ok']} / 失败 {s['fail']}）")
        log(f"[产物] 完整事件: {events_file}  ({len(result['events'])} 条)")
        log(f"[产物] 输出 content: {output_file}")
    elif not env_errors:
        log(f"[回合 r1] 无结果（进程异常退出）")

    # ---- 报告 ----
    lines: list[str] = []
    lines.append("# agent 代码任务实验报告（headless 端到端，单回合，工作区挂载）")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 回合耗时：{elapsed:.0f}s")
    lines.append(f"- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎，与桌面壳共用 EngineHost）")
    lines.append(f"- 工作区：{WS_ROOT}（经 INKENGINE_WS_ROOT 授权为文件工具沙箱根，提示词未告知路径）")
    lines.append(f"- 工作区虚拟环境：{WS_VENV}（agent 跑测试用）")
    lines.append(f"- git HEAD：{git_head or '未知'}")
    lines.append(f"- 模型：{'真实模型（INK_LLM_*）' if model_env else '离线桩'}")
    lines.append("")

    if result and result["ok"]:
        stats = analyze(result)
        lines.append("## 回合概览")
        lines.append("")
        lines.append(f"| 指标 | 值 |")
        lines.append("|---|---|")
        lines.append(f"| 耗时 | {elapsed:.0f}s |")
        lines.append(f"| reason | {result['reason']} |")
        lines.append(f"| 事件数 | {stats['event_count']} |")
        lines.append(f"| 工具调用数 | {stats['tool_calls']} |")
        lines.append(f"| 事件类型 | {', '.join(stats['event_types'])} |")
        lines.append("")
        lines.append("## 链路观测（演化/知识集/推演/研究/端点）")
        lines.append("")
        lines.append("| 链路 | 工具 | 调用 | 成功 | 失败 |")
        lines.append("|---|---|---|---|---|")
        for chain, s in sorted(stats["chain_stats"].items()):
            lines.append(
                f"| {chain} | {', '.join(sorted(s['tools']))} | {s['total']} | {s['ok']} | {s['fail']} |"
            )
        lines.append("")
        lines.append("## 工具明细")
        lines.append("")
        lines.append("| 工具 | 调用 | 成功 | 失败 | 失败原因 |")
        lines.append("|---|---|---|---|---|")
        for tool, s in sorted(stats["calls"].items()):
            fails = "；".join(dict.fromkeys(s["msgs"]))[:100]
            lines.append(f"| {tool} | {s['n']} | {s['ok']} | {s['fail']} | {fails} |")
        lines.append("")
        lines.append("## 回合输出 content（完整，非事件）")
        lines.append("")
        lines.append("```")
        lines.append((result["output"] or "").strip() or "（无输出）")
        lines.append("```")
        lines.append("")
        lines.append("## 产物文件")
        lines.append("")
        lines.append(f"- 实时观测流（回合内逐行刷新）：`live.r1.log`（{len((result['stderr'] or '').splitlines())} 行）")
        lines.append(f"- 完整事件流：`events.r1.json`（{stats['event_count']} 条）")
        lines.append(f"- 输出 content：`output.r1.txt`")
        lines.append("")
    else:
        lines.append("## 回合失败")
        lines.append("")
        lines.append("- 失败: " + (env_errors[0] if env_errors else "无结果"))

    lines.append("## 工作区产物")
    lines.append("")
    try:
        files = sorted(
            p.relative_to(WS_ROOT).as_posix()
            for p in WS_ROOT.rglob("*")
            if p.is_file() and ".venv" not in p.parts and not p.name.endswith(".pyc")
        )
        for f in files[:60]:
            lines.append(f"- {f}")
        if len(files) > 60:
            lines.append(f"- …（共 {len(files)} 个文件）")
    except Exception as exc:  # noqa: BLE001
        lines.append(f"- 产物扫描失败: {exc}")

    lines.append("")
    lines.append("## 环境错误")
    lines.append("")
    if not env_errors:
        lines.append("- 无")
    for e in env_errors:
        lines.append(f"- {e}")

    body = "\n".join(lines) + "\n"
    report_file.write_text(body, encoding="utf-8")
    (out_dir.parent.parent / "latest-agent-code.md").write_text(body, encoding="utf-8")
    log(f"[报告] {report_file}")
    return 0 if (result and result["ok"] and not env_errors) else 1


if __name__ == "__main__":
    import asyncio

    try:
        sys.exit(asyncio.run(main()))
    except Exception:  # noqa: BLE001 崩溃详情落盘，便于隔夜/后台诊断
        import traceback

        tb = traceback.format_exc()
        crash = REPO_ROOT / "docs" / "experiments" / "chains" / "_agent_code_crash.log"
        crash.parent.mkdir(parents=True, exist_ok=True)
        crash.write_text(tb, encoding="utf-8")
        log(f"[崩溃] 详情已写 {crash}\n{tb}")
        sys.exit(1)

"""工具全覆盖巡检实验：真实 agent（headless 端到端）逐个调用所有可用工具。

与 exp_agent_code.py 的「完成任务」不同，本实验刻意要求 agent **系统性覆盖
全部工具**，让使用者获得每个工具最真实的执行反馈：
  1. 覆盖：inspect_tools 列出全量清单 → 每个工具真实调用一次（不跳过）；
  2. 反馈：每个工具记录参数形态要求 / 白名单 / 审批档位 / 端点可用性 /
     错误信息原文——使用者的真实细节来源；
  3. 链路：演化（propose_patch/apply_patch）、推演（MCP 研究链）、知识集
     （distill/mutate）、账本（审批/审计）关键链路逐项验证。

驱动面 = headless Rust 壳（与桌面壳共用 EngineHost），工作区授权经
INKENGINE_WS_ROOT 覆盖，agent 的工具调用全部真实执行。
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADLESS = REPO_ROOT / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"

PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "python.exe"

WS_ROOT = Path(r"C:\Users\Anyi\Documents\test")


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


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
    timeout: float = 2400.0,
) -> dict:
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
    import threading

    live_lines: list[str] = []
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
            if proc.poll() is not None:
                # headless 已退出：非阻塞排空剩余 stderr 后收口——孙进程
                # （回合内 shell_exec 等起的子进程）可能持有管道写端，
                # readline 会永久阻塞，必须转非阻塞读（EOF/BlockingIOError 即止）
                fd = proc.stderr.fileno()
                os.set_blocking(fd, False)
                try:
                    while True:
                        try:
                            chunk = os.read(fd, 65536)
                        except (BlockingIOError, OSError):
                            break
                        if not chunk:
                            break
                        for raw in chunk.decode("utf-8", "replace").split("\n"):
                            s = raw.strip()
                            if s:
                                live_lines.append(s)
                finally:
                    with contextlib.suppress(OSError):
                        os.set_blocking(fd, True)
                if live_lines:
                    live_file.write_text("\n".join(live_lines) + "\n", encoding="utf-8")
                break
            line = proc.stderr.readline()
            if not line:
                continue
            line = line.rstrip("\n")
            live_lines.append(line)
            live_file.write_text("\n".join(live_lines) + "\n", encoding="utf-8")
        else:
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
# 任务描述：要求 agent 覆盖所有可用工具并反馈真实细节
# ----------------------------------------------------------------------

TASK_COVERAGE = (
    "这是一个工具全覆盖巡检任务。请系统性地调用您当前可用的**每一个工具**，"
    "收集最真实的执行反馈，最后输出完整的『工具覆盖矩阵』。\n\n"
    "执行步骤：\n"
    "1. 先用 inspect_tools 列出您当前可用的全部工具清单，以此为准逐项覆盖，"
    "不要遗漏任何工具；\n"
    "2. 逐个真实调用每个工具（不得跳过；无法调用的如实记录原因）：\n"
    "   - 文件类（file_read/file_write/file_edit/grep/glob/file_query 等）："
    "在工作区创建并读写一个测试文件、做检索/通配符匹配；\n"
    "   - 命令执行类（shell_exec/system_query 等）：用无害命令（如 python --version、"
    "pytest --version、git status）探测；\n"
    "   - MCP 研究链（collect_material/parse_material/validate_material/"
    "review_material/distill_knowledge/mutate_knowledge/"
    "material_import）：用工具描述与参数 schema 构造合理样例数据真实调用"
    "（如 collect_material 传 text、parse_material 传文本+spec、"
    "review_material 传 candidates（phase=score 评分）、validate_material 传 data、"
    "distill_knowledge 传 signals）；\n"
    "   - 演化/补丁（propose_patch/apply_patch/revert_patch）：提交一个"
    "真实补丁提案并尝试应用；\n"
    "   - 检索/内省（search_tools/inspect_tools/inspect_graph/request_tool 等）："
    "逐一调用；\n"
    "   - 系统控制类（set_volume/set_brightness/screenshot_capture/notify/"
    "sleep 等）：只读或最小副作用探测，被权限拒绝则如实记录拒绝原文；\n"
    "3. 每个工具记录：工具名、传入参数、结果（成功/失败/拒绝）、错误信息原文、"
    "对使用者的真实反馈（参数形态要求、白名单命令、审批档位、端点是否可用）；\n"
    "4. 在全部工具调用完成后，**最后必须以『问题清单』形式汇报本次巡检发现的"
    "每一个问题**（这是本任务最重要的产出，逐条列出，不得遗漏）：\n"
    "   - 格式：| # | 工具/机制 | 现象（实际返回原文） | 根因判断 | 改进建议 |\n"
    "   - 覆盖三类问题：a) 工具不可用/被拒/报错（含拒绝原因原文、白名单/审批/"
    "端点档位）；b) 工具行为异常或契约不一致（schema 参数名 vs 执行器、路径"
    "口径、返回抖动等）；c) 机制层面（工具调用成功但实际效果/持久化/消费链路"
    "未达预期，如绑定≠可用、apply≠生效）。\n"
    "   - 每个问题必须给出：可复现的现象描述、触发条件（参数/调用形态）、"
    "对使用者的影响。\n\n"
    "测试数据自拟；所有工具调用务必真实执行，结果以实际返回为准，不得编造。"
    "先完成工具覆盖矩阵，再逐条输出问题清单。"
)


# ----------------------------------------------------------------------
# 链路观测：全部工具按链路分组（覆盖矩阵统计）
# ----------------------------------------------------------------------

CHAIN_TOOLS = {
    "演化/补丁链": {"propose_patch", "apply_patch", "revert_patch"},
    "知识集": {"distill_knowledge", "mutate_knowledge", "material_import"},
    "推演": {"validate_material", "review_material", "parse_material"},
    "研究": {"collect_material", "fetch", "web_search"},
    "文件端点": {"file_read", "file_write", "file_edit", "grep", "glob", "file_query"},
    "命令端点": {"shell_exec", "system_query"},
    "内省/装配": {"inspect_tools", "inspect_graph", "inspect_rules", "search_tools", "request_tool", "propose_mcp_mount", "collab_request"},
    "文档/解析": {"doc_generate", "doc_parse", "open_file"},
    "系统控制": {"notify", "sleep", "set_volume", "set_brightness", "screenshot_capture", "ui_query", "ui_click", "ui_type", "window_focus", "window_minimize", "launch_app"},
}

# 工具名 → 参数 schema 简表（供分析脚本标注「未覆盖工具」的归属链路；不强制）
TOOL_LINK = {}
for chain, tools in CHAIN_TOOLS.items():
    for t in tools:
        TOOL_LINK[t] = chain


TASK_COVERAGE_PLUS = (
    "这是一个工具全覆盖补缺任务。前几轮巡检已覆盖大部分工具，但以下 9 个工具"
    "从未被实际调用，本轮必须逐个真实调用它们并汇报结果：\n\n"
    "待补缺工具：doc_generate、doc_parse、fetch、mutate_knowledge、"
    "propose_mcp_mount、ui_click、web_search、window_minimize。\n\n"
    "执行要求：\n"
    "1. 这些工具大多在注册表但未注入本会话——先用 search_tools 确认其存在与状态，"
    "再用 request_tool 逐个绑定到本会话；\n"
    "2. 绑定后逐个真实调用：\n"
    "   - doc_generate/doc_parse：生成一份简单 Markdown 文档并解析它；\n"
    "   - fetch/web_search：用无害关键词（如 'python'）真实检索/获取；\n"
    "   - mutate_knowledge：基于知识集里已有的种子条目（如 seed.inkling.source_"
    "credibility）提交一次带 failure_logs 的变异提案；\n"
    "   - propose_mcp_mount：用无效地址提交挂载提案（应被校验拒绝——记录返回原文）；\n"
    "   - ui_click/window_minimize：headless 环境可能无桌面会话——如实记录执行结果"
    "（成功/报错/权限拒绝原文）。\n"
    "3. 对每个工具记录：工具名、绑定结果、真实调用结果、返回原文、对使用者的影响；\n"
    "4. 最后输出『补缺覆盖矩阵』（| 工具 | 绑定 | 调用结果 | 返回原文 |）与『问题清单』"
    "（每个工具暴露的问题：不可用原因、环境限制、契约不一致等）。\n\n"
    "所有调用务必真实执行，结果以实际返回为准，不得编造。"
)


def analyze(ev: dict) -> dict:
    """回合事件流 → 工具覆盖矩阵统计。"""
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
                    "message": str(payload.get("message") or "")[:240],
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
            chain_stats[chain] = {
                "tools": sorted(hit), "total": total, "ok": ok, "fail": total - ok,
                "covered": len(hit), "declared": len(tools),
            }
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


async def main() -> int:
    if not HEADLESS.exists():
        print(f"[headless 缺失] {HEADLESS} 不存在")
        return 2
    if not WS_ROOT.is_dir():
        print(f"[工作区缺失] {WS_ROOT} 不存在")
        return 2

    git_head = ""
    try:
        git_head = os.popen("git rev-parse --short HEAD").read().strip()
    except Exception:  # noqa: BLE001
        pass

    started = time.time()
    data_dir = Path(os.environ.get("TEMP", ".")) / f"exp-tool-coverage-{int(time.time())}"
    thread_id = f"e2e-coverage-{int(time.time())}"
    round = {"id": "r1", "label": "工具全覆盖巡检", "text": TASK_COVERAGE}

    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = REPO_ROOT / "docs" / "experiments" / "chains" / "tool-coverage" / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    live_file = out_dir / "live.r1.log"
    events_file = out_dir / "events.r1.json"
    output_file = out_dir / "output.r1.txt"
    report_file = out_dir / "report.md"
    print(f"[实验] 工具全覆盖巡检，产物目录: {out_dir}")

    model_env = bool(
        _env("INK_LLM_BASE_URL") and _env("INK_LLM_MODEL") and _env("INK_LLM_API_KEY")
    )
    print(f"[模型] 真实模型={'是' if model_env else '否'}")
    print(f"[回合 r1] 开始（工具全覆盖巡检）")

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
        env_errors.append("r1: headless 超时（>2400s）")
    if result and not result["ok"]:
        msg = str(result.get("raw", {}).get("error") or {}).get("message", result.get("stderr", ""))[:200]
        env_errors.append(f"r1: headless 失败 {msg}")
        print(f"[回合 r1] 环境错误: {env_errors[-1]}")

    if result and result["ok"]:
        stats = analyze(result)
        events_file.write_text(
            json.dumps(result["events"], ensure_ascii=False, indent=1), encoding="utf-8"
        )
        output_file.write_text((result["output"] or "").strip(), encoding="utf-8")
        print(f"[回合 r1] 完成 耗时 {elapsed:.0f}s  events={stats['event_count']}  tool_calls={stats['tool_calls']}")
        for chain, s in sorted(stats["chain_stats"].items()):
            print(f"[链路] {chain}: 覆盖 {s['covered']}/{s['declared']} 调 {s['total']}（成功 {s['ok']} / 失败 {s['fail']}）")

    lines: list[str] = []
    lines.append("# 工具全覆盖巡检实验报告（headless 端到端，单回合）")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 回合耗时：{elapsed:.0f}s")
    lines.append(f"- 驱动面：`inkling-headless --round`（Rust 壳 → bridge → 引擎）")
    lines.append(f"- 工作区：{WS_ROOT}（工具调用全部真实执行）")
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
        lines.append(f"| 事件数 | {stats['event_count']} |")
        lines.append(f"| 工具调用数 | {stats['tool_calls']} |")
        lines.append(f"| 去重工具数 | {len(stats['unique_tools'])} |")
        lines.append("")
        lines.append("## 链路覆盖（声明工具 vs 实际调用）")
        lines.append("")
        lines.append("| 链路 | 覆盖 | 调用 | 成功 | 失败 | 工具 |")
        lines.append("|---|---|---|---|---|---|")
        for chain, s in sorted(stats["chain_stats"].items()):
            lines.append(
                f"| {chain} | {s['covered']}/{s['declared']} | {s['total']} | "
                f"{s['ok']} | {s['fail']} | {', '.join(sorted(s['tools']))} |"
            )
        covered = set(stats["unique_tools"])
        declared = set(TOOL_LINK)
        uncovered = sorted(declared - covered)
        if uncovered:
            lines.append("")
            lines.append("## 未覆盖工具（agent 未调用的声明工具）")
            lines.append("")
            for t in uncovered:
                lines.append(f"- {t}（{TOOL_LINK.get(t, '未分组')}）")
        lines.append("")
        lines.append("## 工具明细（每个工具的调用与失败原文）")
        lines.append("")
        lines.append("| 工具 | 调用 | 成功 | 失败 | 失败原因原文 |")
        lines.append("|---|---|---|---|---|")
        for tool, s in sorted(stats["calls"].items()):
            fails = "；".join(dict.fromkeys(s["msgs"]))[:160]
            lines.append(f"| {tool} | {s['n']} | {s['ok']} | {s['fail']} | {fails} |")
        lines.append("")
        lines.append("## agent 输出 content（完整，含覆盖矩阵）")
        lines.append("")
        lines.append("```")
        lines.append((result["output"] or "").strip() or "（无输出）")
        lines.append("```")
        lines.append("")
        lines.append("## 产物文件")
        lines.append("")
        lines.append(f"- 实时观测流：`live.r1.log`（{len((result['stderr'] or '').splitlines())} 行）")
        lines.append(f"- 完整事件流：`events.r1.json`（{stats['event_count']} 条）")
        lines.append(f"- 输出 content：`output.r1.txt`")
        lines.append("")
    else:
        lines.append("## 回合失败")
        lines.append("")
        lines.append("- 失败: " + (env_errors[0] if env_errors else "无结果"))

    lines.append("## 环境错误")
    lines.append("")
    if not env_errors:
        lines.append("- 无")
    for e in env_errors:
        lines.append(f"- {e}")

    body = "\n".join(lines) + "\n"
    report_file.write_text(body, encoding="utf-8")
    print(f"[报告] {report_file}")
    return 0 if (result and result["ok"] and not env_errors) else 1


if __name__ == "__main__":
    import asyncio

    try:
        sys.exit(asyncio.run(main()))
    except Exception:  # noqa: BLE001
        import traceback

        tb = traceback.format_exc()
        crash = REPO_ROOT / "docs" / "experiments" / "chains" / "_tool_coverage_crash.log"
        crash.parent.mkdir(parents=True, exist_ok=True)
        crash.write_text(tb, encoding="utf-8")
        print(f"[崩溃] 详情已写 {crash}\n{tb}")
        sys.exit(1)

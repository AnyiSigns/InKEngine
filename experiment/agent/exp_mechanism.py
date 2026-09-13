"""引擎机制专项验证实验：真实 agent 端到端走通关键机制。

与工具覆盖巡检不同，本实验**按机制**驱动 agent 真实执行并产出可验证物：
  1. 知识检索命中（装配按 query 检索知识集 → 命中 seed 条目注入上下文）
  2. 协作者召唤（collab_request → EntitySpec 物化 spawn 子图 → 子代理产出回流）
  3. 真实数据修改（propose_patch/apply_patch 修改生产数据 → 确认落盘 → revert 回退）
  4. 知识沉淀（distill_knowledge 信号蒸馏 → 知识集新增条目）

验证 = agent 产出（输出文本）+ 引擎持久化（data_dir sqlite：knowledge 链 /
  set_audit / event_log 的 spawn·patch·distill 事件）双重印证。
"""
from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import threading
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


def run_round(data_dir: Path, thread_id: str, round_id: str, text: str, live_file: Path, timeout: float = 2400.0) -> dict:
    cmd = [
        str(HEADLESS), "--data-dir", str(data_dir),
        "--thread-id", thread_id, "--round-id", round_id, "--round", text,
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", env=_headless_env(),
    )
    live_lines: list[str] = []
    stdout_text: list[str] = []

    def _collect_stdout() -> None:
        try:
            stdout_text.append(proc.stdout.read())
        except Exception:  # noqa: BLE001
            pass

    t = threading.Thread(target=_collect_stdout, daemon=True)
    t.start()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            if proc.poll() is not None:
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
        envelope = {"ok": False, "error": {"message": "非 JSON 信封"}}
    if not envelope.get("ok"):
        return {"ok": False, "events": [], "output": None, "stderr": "\n".join(live_lines), "raw": envelope}
    data = envelope.get("data") or {}
    return {
        "ok": True,
        "reason": data.get("reason"),
        "output": data.get("output"),
        "events": data.get("events") or [],
        "stderr": "\n".join(live_lines),
        "raw": envelope,
    }


TASK_MECHANISM = (
    "这是一个引擎机制专项验证任务。请逐项真实执行以下机制并汇报每项的产出（"
    "所有调用务必真实执行，结果以实际返回为准，不得编造）：\n\n"
    "1. 知识检索命中：知识集中已存在种子条目，如『来源可信度权重基线』"
    "（id=seed.inkling.source_credibility）、『领域基线：知识/研究孵化闭环』"
    "（id=seed.inkling.domain_guide）。请先调用 inspect_knowledge 确认知识集"
    "内容与条目数；随后在您接下来的工作描述中提及『来源可信度』『领域基线』"
    "相关措辞，使装配检索命中它们，并说明命中的条目。\n\n"
    "2. 协作者召唤：调用 collab_request 召唤实体目录中的研究分析师"
    "（entity_id=research_analyst），任务为：『从以下文本提炼可沉淀的知识要点"
    "：本引擎支持声明式材料抽取、三层闸门知识校验、来源分级可信度与审计回退"
    "，工具描述采用行为意图结构。』等待其子代理执行完成，汇报协作者返回的产出"
    "（子代理结论/沉淀要点）。\n\n"
    "3. 真实数据修改：先用 propose_patch 提交一条真实的规则补丁（例如新增一条"
    "知识规则条目，或经 propose_domain_manifest 修改领域清单字段），再用"
    "apply_patch 应用它，确认数据真实落盘（补丁链版本推进、内容生效），最后用"
    "revert_patch 回退并确认恢复到修改前状态。全程汇报补丁 id、版本号与回退结果。\n\n"
    "4. 知识沉淀：用 distill_knowledge 把本次验证的执行心得蒸馏成知识条目"
    "（signals 数组，每条含 kind/message；source 用 model），确认产物通过校验"
    "并落库到知识集，汇报新增知识条目。\n\n"
    "最后汇总：每项机制的产出（协作者返回了什么、数据修改前后对比、知识集新增"
    "条目），并说明哪些机制完整走通、哪些有缺口。"
)


CHAIN_TOOLS = {
    "协作者/子代理": {"collab_request"},
    "知识检索/内省": {"inspect_knowledge", "search_tools", "request_tool"},
    "演化/数据修改": {"propose_patch", "apply_patch", "revert_patch", "propose_domain_manifest"},
    "知识沉淀": {"distill_knowledge", "mutate_knowledge", "material_import"},
}


def analyze(ev: dict) -> dict:
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
            tool_calls.append({"tool": name, "success": bool(payload.get("success", True)),
                               "message": str(payload.get("message") or "")[:200]})
    calls = {}
    for c in tool_calls:
        calls.setdefault(c["tool"], {"n": 0, "ok": 0, "fail": 0, "msgs": []})
        calls[c["tool"]]["n"] += 1
        if c["success"]:
            calls[c["tool"]]["ok"] += 1
        else:
            calls[c["tool"]]["fail"] += 1
            calls[c["tool"]]["msgs"].append(c["message"])
    return {
        "event_count": len(events),
        "tool_calls": len(tool_calls),
        "unique_tools": sorted(calls),
        "calls": calls,
        "event_types": sorted({e.get("type") for e in events}),
    }


async def main() -> int:
    if not HEADLESS.exists():
        print(f"[headless 缺失] {HEADLESS}")
        return 2
    if not WS_ROOT.is_dir():
        print(f"[工作区缺失] {WS_ROOT}")
        return 2

    started = time.time()
    data_dir = Path(os.environ.get("TEMP", ".")) / f"exp-mechanism-{int(time.time())}"
    thread_id = f"e2e-mechanism-{int(time.time())}"
    ts = time.strftime("%Y%m%d-%H%M%S")
    out_dir = REPO_ROOT / "docs" / "experiments" / "chains" / "mechanism" / ts
    out_dir.mkdir(parents=True, exist_ok=True)
    live_file = out_dir / "live.r1.log"
    events_file = out_dir / "events.r1.json"
    output_file = out_dir / "output.r1.txt"
    report_file = out_dir / "report.md"
    print(f"[实验] 机制专项验证，产物目录: {out_dir}")

    model_env = bool(_env("INK_LLM_BASE_URL") and _env("INK_LLM_MODEL") and _env("INK_LLM_API_KEY"))
    print(f"[模型] 真实模型={'是' if model_env else '否'}")
    t0 = time.time()
    result = {"ok": False}
    env_errors: list[str] = []
    try:
        result = run_round(data_dir, thread_id, "r1", TASK_MECHANISM, live_file=live_file)
    except subprocess.TimeoutExpired:
        env_errors.append("r1: headless 超时（>2400s）")
    elapsed = time.time() - t0
    if result and not result["ok"]:
        msg = str(result.get("raw", {}).get("error") or {}).get("message", "")[:200]
        env_errors.append(f"r1: headless 失败 {msg}")
        print(f"[回合 r1] 失败: {env_errors[-1]}")
    if result and result["ok"]:
        stats = analyze(result)
        events_file.write_text(json.dumps(result["events"], ensure_ascii=False, indent=1), encoding="utf-8")
        output_file.write_text((result["output"] or "").strip(), encoding="utf-8")
        print(f"[回合 r1] 完成 耗时 {elapsed:.0f}s events={stats['event_count']} tool_calls={stats['tool_calls']}")

    lines: list[str] = []
    lines.append("# 引擎机制专项验证报告（headless 端到端，单回合）")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 回合耗时：{elapsed:.0f}s")
    lines.append(f"- 工作区：{WS_ROOT}")
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
        lines.append("## 机制相关工具调用")
        lines.append("")
        lines.append("| 工具 | 调用 | 成功 | 失败 | 结果原文 |")
        lines.append("|---|---|---|---|---|")
        for tool, s in sorted(stats["calls"].items()):
            fails = "；".join(dict.fromkeys(s["msgs"]))[:150]
            lines.append(f"| {tool} | {s['n']} | {s['ok']} | {s['fail']} | {fails} |")
        lines.append("")
        lines.append("## agent 输出 content（完整）")
        lines.append("")
        lines.append("```")
        lines.append((result["output"] or "").strip() or "（无输出）")
        lines.append("```")
        lines.append("")
        lines.append("## 引擎持久化验证（data_dir inkling.sqlite）")
        lines.append("")
        lines.append("提示：本报告配套回合产物，用 `sqlite_records.py`/`sqlite_events.py` 核对：")
        lines.append("- knowledge 链是否新增非 seed 条目（知识沉淀/检索命中）")
        lines.append("- set_audit 的 knowledge/revert/patch 审计（数据修改闭环）")
        lines.append("- event_log 的 spawn_start/spawn_end（协作者子代理执行）")
        lines.append(f"- data_dir: {data_dir}")
        lines.append("")
    else:
        lines.append("## 回合失败")
        lines.append("")
        for e in env_errors:
            lines.append(f"- {e}")
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
        crash = REPO_ROOT / "docs" / "experiments" / "chains" / "_mechanism_crash.log"
        crash.parent.mkdir(parents=True, exist_ok=True)
        crash.write_text(tb, encoding="utf-8")
        print(f"[崩溃] 详情已写 {crash}\n{tb}")
        sys.exit(1)

"""agent 自写工具并注册使用 端到端验证（headless, qwen3.8-2.4t-a95b）。

回合 1：agent 用 propose_patch(kind=tool) 新增自定义工具 + apply_patch 落地；
回合 2：inspect_tools 确认注册 → request_tool 绑定 → 调用新工具。
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

sys_out = __import__("sys").stdout
sys_out.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADLESS = REPO_ROOT / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"
PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV_PYTHON = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
WS_ROOT = Path(r"C:\Users\Anyi\Documents\test")
DATA_DIR = WS_ROOT / "mcp_verify_data9"


def _headless_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV_PYTHON)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    env["INKENGINE_WS_ROOT"] = str(WS_ROOT)
    env["INK_HEADLESS_AUTO_APPROVE_ALL"] = "1"
    env["INK_LLM_BASE_URL"] = "https://ws-6rnv50cb3kvs261t.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    env["INK_LLM_MODEL"] = "qwen3.8-2.4t-a95b"
    env["INK_LLM_API_KEY"] = "sk-da98029948304384b660c0f07656e020"
    return env


def run_round(data_dir: Path, thread_id: str, round_id: str, text: str, label: str, timeout: float = 1500.0) -> dict:
    cmd = [
        str(HEADLESS),
        "--data-dir", str(data_dir),
        "--thread-id", thread_id,
        "--round-id", round_id,
        "--round", text,
    ]
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
        errors="replace", env=_headless_env(),
    )
    t0 = time.time()
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        proc.wait(timeout=30)
        print(f"[{label}] 回合超时（{timeout}s）")
        return {"ok": False, "stderr": err, "events": [], "data": {}}
    elapsed = time.time() - t0
    try:
        env_out = json.loads(out)
    except json.JSONDecodeError:
        env_out = {"ok": False, "error": {"message": f"非 JSON: {out[:200]}"}}
    data = env_out.get("data") or {}
    print(f"[{label}] ok={env_out.get('ok')} reason={data.get('reason')} events={len(data.get('events') or [])} 耗时={elapsed:.0f}s")
    return {"ok": env_out.get("ok"), "data": data, "stderr": err, "events": data.get("events") or []}


def dump_tools(events: list, label: str) -> None:
    for e in events:
        t = e.get("type")
        if t in ("tool_start", "tool_end"):
            pl = e.get("payload", {})
            tool = pl.get("tool", "?")
            if t == "tool_start":
                print(f"  → {tool} args={str(pl.get('args', ''))[:130]}")
            else:
                print(f"  ← {tool} ok={pl.get('success')} msg={str(pl.get('message', ''))[:260]}")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    thread_id = "self-tool-thread"

    print("=" * 70)
    print("回合 1：agent 自写工具（propose_patch kind=tool → apply_patch）")
    print("=" * 70)
    TASK_WRITE = (
        "任务：自写并注册一个工具。\n"
        "1. 调用 propose_patch（kind=tool），新增自定义工具 greet_user：\n"
        "   payload={name:'greet_user', description:'返回欢迎语并带上输入的用户名',\n"
        "   parameters:{type:'object',properties:{command:{type:'string'},username:{type:'string'}},required:['command','username']},\n"
        "   permissions:['process:exec:echo'], endpoint:'process_exec',\n"
        "   endpoint_config:{allowlist:['echo'], operation_param:'command'}}\n"
        "   注意：process_exec 端点用 endpoint_config.operation_param 声明参数名='command'，"
        "调用时传 command='echo' 及 echo 的实参。\n"
        "2. 若 propose_patch 返回合法提案，接着调用 apply_patch 应用它（kind=tool，payload 同前）。\n"
        "3. 应用成功后调用 request_tool 绑定新工具 greet_user，并调用它（command='echo', username='alice'）验证可用。\n"
        "4. 如实汇报每一步的结果；若遇审批卡 interrupt，原样汇报卡片内容。\n"
        "在完成工具调用前不要结束回合。"
    )
    r1 = run_round(DATA_DIR, thread_id, "self-tool-r1", TASK_WRITE, "self-tool-write")
    print("回合 1 事件流：")
    dump_tools(r1.get("events") or [], "r1")
    applied = any(
        e.get("payload", {}).get("tool") == "apply_patch" and e.get("payload", {}).get("success")
        for e in r1.get("events") or []
    )
    print(f"apply_patch 成功: {applied}")

    print("=" * 70)
    print("回合 2：确认注册 + 绑定 + 调用 greet_user")
    print("=" * 70)
    TASK_USE = (
        "任务：上回合已用 apply_patch 注册了 greet_user 工具。\n"
        "1. 调用 inspect_tools 查看全量注册面，确认 greet_user 是否在注册清单中；\n"
        "2. 若在，调用 request_tool 绑定 greet_user，然后调用它（command='echo', username='bob'）；\n"
        "3. 如实报告 greet_user 的注册状态与调用结果。\n"
        "不要做其它排查。"
    )
    r2 = run_round(DATA_DIR, thread_id, "self-tool-r2", TASK_USE, "self-tool-use")
    print("回合 2 事件流：")
    dump_tools(r2.get("events") or [], "r2")
    called = any(
        e.get("payload", {}).get("tool") == "greet_user"
        for e in r2.get("events") or []
    )
    called_ok = any(
        e.get("type") == "tool_end" and e.get("payload", {}).get("tool") == "greet_user"
        and e.get("payload", {}).get("success")
        for e in r2.get("events") or []
    )
    print("=" * 70)
    print("验证汇总")
    print("=" * 70)
    print(f"1. 回合 1 apply_patch 落地: {applied}")
    print(f"2. 回合 2 调用 greet_user: {'成功' if called_ok else ('尝试过但失败' if called else '未尝试')}")


if __name__ == "__main__":
    main()

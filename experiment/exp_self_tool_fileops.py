"""agent 自写工具（file_ops）注册并成功调用 验证（qwen3.8-2.4t-a95b）。

回合 1：propose_patch(kind=tool) 自写 read-file 工具 + apply_patch + 调用。
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
DATA_DIR = WS_ROOT / "mcp_verify_data10"
WORKSPACE = WS_ROOT.as_posix()


def _headless_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV_PYTHON)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    env["INKENGINE_WS_ROOT"] = str(WS_ROOT)
    env["INK_HEADLESS_AUTO_APPROVE_ALL"] = "1"
    env["INK_LLM_ADAPTER"] = "openai_compatible"
    env["INK_LLM_BASE_URL"] = "https://api.kilo.ai/api/gateway"
    env["INK_LLM_MODEL"] = "tencent/hy3:free"
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


def dump_tools(events: list) -> None:
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
    thread_id = "self-tool-thread2"

    print("=" * 70)
    print("回合 1：自写 file_ops 工具 + 注册 + 调用")
    print("=" * 70)
    TASK_WRITE = (
        "任务：自写并注册一个读文件工具，然后调用它。\n"
        "1. 调用 propose_patch（kind=tool），payload 如下（注意工具名不含下划线，端点 file_ops 参数契约是 operation+path）：\n"
        "   {name:'read-file', description:'读取工作区指定文件内容',\n"
        "   parameters:{type:'object',properties:{operation:{type:'string',enum:['read']},path:{type:'string'}},required:['operation','path']},\n"
        "   permissions:['filesystem:read:" + WORKSPACE + "'], endpoint:'file_ops',\n"
        "   endpoint_config:{root:'" + WORKSPACE + "'}}\n"
        "2. 若 propose_patch 返回合法提案，调用 apply_patch 应用它。\n"
        "3. 应用成功后调用 request_tool 绑定 read-file，并调用它"
        "(operation='read', path='" + WORKSPACE + "/hello_self_tool.txt')。\n"
        "   注：工作区 " + WORKSPACE + " 下已存在文件 hello_self_tool.txt（内容是 hello-from-self-tool）。\n"
        "4. 如实汇报每一步结果。在完成工具调用前不要结束回合。"
    )
    hello = WS_ROOT / "hello_self_tool.txt"
    hello.write_text("hello-from-self-tool", encoding="utf-8")

    r1 = run_round(DATA_DIR, thread_id, "self-tool-r1", TASK_WRITE, "self-tool-write")
    print("回合 1 事件流：")
    dump_tools(r1.get("events") or [])
    applied = any(
        e.get("payload", {}).get("tool") == "apply_patch" and e.get("payload", {}).get("success")
        for e in r1.get("events") or []
    )
    called_ok = any(
        e.get("type") == "tool_end" and e.get("payload", {}).get("tool") == "read-file"
        and e.get("payload", {}).get("success")
        for e in r1.get("events") or []
    )
    msg = ""
    for e in reversed(r1.get("events") or []):
        pl = e.get("payload", {})
        if e.get("type") == "tool_end" and pl.get("tool") == "read-file":
            msg = pl.get("message", "")
            break
    print("=" * 70)
    print("验证汇总")
    print("=" * 70)
    print(f"1. apply_patch 落地: {applied}")
    print(f"2. read-file 调用成功: {called_ok}")
    if msg:
        print(f"   read-file 返回: {msg[:200]}")


if __name__ == "__main__":
    main()

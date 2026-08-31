"""agent 回合内自写工具（file_ops read-file）→ 同回合调用 全链路验证。

回合 1（同一回合）：propose_patch → apply_patch → request_tool → 调用 read-file，
确认「自写→注册→同回合可用」闭环。模型 qwen3.8-2.4t-a95b（百炼端点）。
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
DATA_DIR = WS_ROOT / "mcp_verify_data11"
WORKSPACE = WS_ROOT.as_posix()


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


def dump_tools(events: list) -> None:
    for e in events:
        t = e.get("type")
        if t in ("tool_start", "tool_end"):
            pl = e.get("payload", {})
            tool = pl.get("tool", "?")
            if t == "tool_start":
                print(f"  → {tool} args={str(pl.get('args', ''))[:140]}")
            else:
                print(f"  ← {tool} ok={pl.get('success')} msg={str(pl.get('message', ''))[:280]}")


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    thread_id = "self-tool-thread3"
    hello = WS_ROOT / "hello_self_tool.txt"
    hello.write_text("hello-from-self-tool", encoding="utf-8")

    print("=" * 70)
    print("回合 1：回合内自写 read-file 工具并同回合调用")
    print("=" * 70)
    payload = (
        "{'name':'read-file', 'description':'读取工作区指定文件内容',"
        " 'parameters':{'type':'object','properties':"
        "{'operation':{'type':'string','enum':['read']},'path':{'type':'string'}},"
        "'required':['operation','path']},"
        " 'permissions':['filesystem:read:" + WORKSPACE + "'],"
        " 'endpoint':'file_ops','endpoint_config':{'root':'" + WORKSPACE + "'}}"
    )
    task = (
        "严格按下面 4 步执行，每步都必须真实调用工具，不要在中间只回文字：\n"
        "1. 调用 propose_patch，参数 kind='tool'、payload=" + payload + "\n"
        "2. 若 propose_patch 返回 ok 且 violations 为空，立即调用 apply_patch，参数 kind='tool'、payload 同上、base_version=返回的 current_version\n"
        "3. apply_patch 返回 applied 后，调用 request_tool，参数 name='read-file'\n"
        "4. 绑定成功后调用 read-file，参数 operation='read'、path='" + WORKSPACE + "/hello_self_tool.txt'\n"
        "每步返回后都要继续下一步，直到 read-file 调用完成，然后如实汇报结果。"
    )
    r1 = run_round(DATA_DIR, thread_id, "self-tool-r1", task, "self-tool-write")
    print("回合 1 事件流：")
    dump_tools(r1.get("events") or [])
    applied = any(
        e.get("payload", {}).get("tool") == "apply_patch" and e.get("payload", {}).get("success")
        for e in r1.get("events") or []
    )
    bound = any(
        e.get("payload", {}).get("tool") == "request_tool" and e.get("payload", {}).get("success")
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
    print("验证汇总（回合内自写→自调用）")
    print("=" * 70)
    print(f"1. propose+apply 落链: {applied}")
    print(f"2. request_tool 绑定: {bound}")
    print(f"3. read-file 同回合调用成功: {called_ok}")
    if msg:
        print(f"   read-file 返回: {msg[:200]}")


if __name__ == "__main__":
    main()

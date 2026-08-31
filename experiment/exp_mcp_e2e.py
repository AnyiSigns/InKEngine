"""MCP 挂载端到端验证（回合 1 挂载 → 回合 2 调用挂载工具）。

引擎语义：MCP 挂载落链 + rebuild_engine 后，「下一回合」新注入面生效
（当前回合 holder 是建图时快照）。因此分两回合验证：
  回合 1：propose_mcp_mount 挂载 server-everything；
  回合 2：search_tools 确认新工具已注册 → 绑定 echo → 调用验证。
"""
from __future__ import annotations

import json
import os
import signal
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


def _kill_tree(pid: int) -> None:
    """Windows 上 taskkill 整个进程树（MCP node 子进程一并清）。"""
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True, timeout=30,
        )
    except Exception:
        pass


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
        print(f"[{label}] 回合超时（{timeout}s），清理进程树")
        _kill_tree(proc.pid)
        proc.wait(timeout=30)
        return {"ok": False, "stderr": err, "events": [], "data": {}, "output": ""}
    elapsed = time.time() - t0
    try:
        env_out = json.loads(out)
    except json.JSONDecodeError:
        env_out = {"ok": False, "error": {"message": f"非 JSON: {out[:200]}"}}
    data = env_out.get("data") or {}
    events = data.get("events") or []
    print(f"[{label}] ok={env_out.get('ok')} reason={data.get('reason')} events={len(events)} 耗时={elapsed:.0f}s")
    return {
        "ok": env_out.get("ok"),
        "data": data,
        "stderr": err,
        "events": events,
        "output": data.get("output") or "",
    }


def main():
    data_dir = WS_ROOT / "mcp_verify_data7"
    data_dir.mkdir(parents=True, exist_ok=True)
    thread_id = "mcp-e2e-thread"

    print("=" * 70)
    print("回合 1：MCP 挂载（server-everything）")
    print("=" * 70)
    TASK_MOUNT = (
        "你必须执行以下工具调用，不允许直接文字回复任务完成：\n"
        "第一步：调用 request_tool 绑定 propose_mcp_mount（name='propose_mcp_mount'）；\n"
        "第二步：调用 propose_mcp_mount，address='npm:@modelcontextprotocol/server-everything'；\n"
        "第三步：把挂载返回的完整结果原文汇报。\n"
        "在完成这两次工具调用前不要结束回合。"
    )
    r1 = run_round(data_dir, thread_id, "mcp-e2e-r1", TASK_MOUNT, "mcp-mount", timeout=1500)
    mounted = False
    for e in r1.get("events") or []:
        p = e.get("payload", {})
        if e.get("type") == "tool_end" and p.get("tool") == "propose_mcp_mount":
            msg = p.get("message", "")
            mounted = '"status": "mounted"' in msg or "挂载成功" in msg
            print(f"  → propose_mcp_mount 结果: ok={p.get('success')} {msg[:200]}")
    print(f"挂载成功: {mounted}")

    print("=" * 70)
    print("回合 2：确认注册 + 绑定 + 调用 echo")
    print("=" * 70)
    TASK_USE = (
        "这是 MCP 挂载后使用验证任务，只做以下事，不要排查：\n"
        "1. 用 search_tools（query='echo 回显'）确认 server-everything 导入的 echo 工具已注册；\n"
        "2. 用 request_tool 绑定 echo；\n"
        "3. 调用 echo（message='hello-mcp'）验证可用；\n"
        "4. 如实汇报注册与调用结果。"
    )
    r2 = run_round(data_dir, thread_id, "mcp-e2e-r2", TASK_USE, "mcp-use", timeout=1500)

    print("=" * 70)
    print("回合 2 事件流摘要")
    print("=" * 70)
    for e in r2.get("events") or []:
        p = e.get("payload", {})
        if e.get("type") in ("tool_start", "tool_end"):
            tool = p.get("tool", "?")
            if e["type"] == "tool_start":
                print(f"  → {tool} args={str(p.get('args',''))[:110]}")
            else:
                print(f"  ← {tool} ok={p.get('success')} msg={str(p.get('message',''))[:160]}")

    print("=" * 70)
    print("验证汇总")
    print("=" * 70)
    print(f"1. MCP 挂载: {'成功' if mounted else '失败'}")
    print(f"2. 回合 2 正常完成: {bool(r2.get('ok'))}")


if __name__ == "__main__":
    main()

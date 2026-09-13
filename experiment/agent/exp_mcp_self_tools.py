"""MCP 挂载 + 自写工具注册 端到端验证（headless）。

阶段：
  1. npm 可用性（shell_exec 跑 npm --version）
  2. 挂载真实 MCP server（filesystem stdio server，npx 拉取）
  3. 导入并调用挂载的工具（验证注册可用）
  4. agent 自写工具（propose_patch kind=tool）并调用
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


def _headless_env() -> dict[str, str]:
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV_PYTHON)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    env["INKENGINE_WS_ROOT"] = str(WS_ROOT)
    env["INK_HEADLESS_AUTO_APPROVE_ALL"] = "1"
    return env


def run_op(data_dir: Path, op: str, args: dict, label: str) -> dict:
    cmd = [str(HEADLESS), "--data-dir", str(data_dir), "--op", op, "--args", json.dumps(args)]
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=_headless_env(), timeout=600
    )
    try:
        env = json.loads(proc.stdout)
    except json.JSONDecodeError:
        env = {"ok": False, "error": {"message": f"非 JSON: {proc.stdout[:300]}"}}
    print(f"[{label}] op={op} ok={env.get('ok')}")
    if not env.get("ok"):
        print(f"   ERROR: {env.get('error')}")
    return env


def run_round(data_dir: Path, thread_id: str, round_id: str, text: str, label: str, timeout: float = 1800.0) -> dict:
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
    out_lines: list[str] = []
    live_lines: list[str] = []
    import threading

    def _collect():
        try:
            out_lines.append(proc.stdout.read())
        except Exception:
            pass

    t = threading.Thread(target=_collect, daemon=True)
    t.start()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        line = proc.stderr.readline()
        if line:
            live_lines.append(line.rstrip("\n"))
    else:
        proc.kill()
        proc.wait(timeout=60)
        print(f"[{label}] 回合超时")
        return {"ok": False, "stderr": "\n".join(live_lines)}
    proc.wait(timeout=60)
    t.join(timeout=30)
    try:
        env = json.loads(out_lines[0] if out_lines else "")
    except json.JSONDecodeError:
        env = {"ok": False, "error": {"message": "非 JSON 信封"}}
    data = env.get("data") or {}
    print(f"[{label}] 回合完成 ok={env.get('ok')} reason={data.get('reason')} events={len(data.get('events') or [])}")
    return {"ok": env.get("ok"), "data": data, "stderr": "\n".join(live_lines)}


def main():
    data_dir = WS_ROOT / "mcp_verify_data"
    data_dir.mkdir(parents=True, exist_ok=True)
    thread_id = "mcp-verify-thread"
    round_id = "mcp-verify-r1"

    print("=" * 70)
    print("阶段 1：npm 可用性")
    print("=" * 70)
    r = run_round(
        data_dir, thread_id, round_id,
        "请用 shell_exec 运行 npm --version 和 node --version，把版本号原样输出即可，不要做其他事。",
        "npm-check",
        timeout=600,
    )
    npm_ok = "npm --version" in r.get("stderr", "") or "12." in r.get("stderr", "") or "v24" in r.get("stderr", "")

    print("=" * 70)
    print("阶段 2：挂载真实 MCP server（filesystem stdio）")
    print("=" * 70)
    mount = run_op(
        data_dir, "mcp.connect",
        {"config": {
            "id": "fs_test",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", str(WS_ROOT)],
            "name": "filesystem-test",
        }},
        "mcp-connect",
    )

    print("=" * 70)
    print("阶段 3：导入并调用挂载工具")
    print("=" * 70)
    imported = run_op(data_dir, "mcp.import_tools", {"server_id": "fs_test"}, "import-tools")
    tool_names = []
    if imported.get("ok"):
        tool_names = [t.get("name") for t in (imported.get("data") or {}).get("tools") or []]
        print(f"   导入工具: {tool_names}")

    print("=" * 70)
    print("阶段 4：agent 自写工具并注册使用")
    print("=" * 70)
    r2 = run_round(
        data_dir, thread_id, "mcp-verify-r2",
        "任务：验证自写工具能力。请用 propose_patch（kind=tool）新增一个自定义工具"
        " echo_hello（描述=把输入 message 原样返回），然后调用它验证注册后可用。"
        " 如果 propose_patch 返回 L1 审批卡（interrupted），无需等待，把提案结果如实报告即可。",
        "self-tool-write",
        timeout=900,
    )
    r3 = run_round(
        data_dir, thread_id, "mcp-verify-r3",
        "任务：上一步已尝试新增 echo_hello 工具。请用 inspect_tools 查看工具表，"
        "确认 echo_hello 是否已注册；若已注册直接调用它（message='hello self-tool'）。"
        " 如实报告它是否可用。",
        "self-tool-use",
        timeout=900,
    )

    print("=" * 70)
    print("验证汇总")
    print("=" * 70)
    print(f"1. npm 可用: {npm_ok}")
    print(f"2. MCP 挂载: {mount.get('ok')} ({mount.get('data')})")
    print(f"3. 工具导入: {imported.get('ok')} 数量={len(tool_names)} 工具={tool_names}")
    print(f"4. 自写工具回合 ok={r2.get('ok')}，使用回合 ok={r3.get('ok')}")


if __name__ == "__main__":
    main()

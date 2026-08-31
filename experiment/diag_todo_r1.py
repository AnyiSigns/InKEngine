"""r1 诊断：task_manager 是否被调用、清单是否落库。"""
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(r"C:\Users\Anyi\Documents\PycharmProjects\InkEngine")
HEADLESS = REPO / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"
PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV = REPO / ".venv" / "Scripts" / "python.exe"

R1 = (
    "请先用 task_manager 创建 3 项待办（title：'调用 shell_exec 探测 python 版本'、"
    "'调用 glob 列出工作区'、'调用 grep 搜索关键字'）。然后只完成第 1 项"
    "（shell_exec python --version 并附 evidence）。完成后用 list 确认。"
)


def main():
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH','')}"
    data_dir = Path(os.environ["TEMP"]) / f"exp-todo-diag-{int(time.time())}"
    proc = subprocess.run(
        [str(HEADLESS), "--data-dir", str(data_dir), "--thread-id", "diag",
         "--round-id", "r1", "--round", R1],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=900,
    )
    print("exit:", proc.returncode)
    stderr = proc.stderr
    # 工具调用事件
    for line in stderr.splitlines():
        if any(k in line for k in ("tool_start", "tool_audit", "tool_end", "llm_usage")):
            if "task_manager" in line or "shell_exec" in line or "glob" in line or "grep" in line or "llm_usage" in line:
                print("  ", line[:220])
    envelope = {}
    if proc.stdout:
        try:
            envelope = json.loads(proc.stdout)
            data = envelope.get("data") or {}
            print("reason:", data.get("reason"))
            print("output tail:", (data.get("output") or "")[-600:])
        except json.JSONDecodeError:
            pass
    sqlite = data_dir / "inkling.sqlite"
    print("sqlite:", sqlite.exists())
    if sqlite.exists():
        conn = sqlite3.connect(sqlite)
        cur = conn.cursor()
        cur.execute("SELECT key, data FROM records WHERE collection LIKE 'todo:%'")
        for k, d in cur.fetchall():
            obj = json.loads(d)
            print(f"[{k}] entries:", [(e.get("id"), e.get("status"), e.get("title")) for e in obj.get("entries", [])])
        conn.close()


if __name__ == "__main__":
    main()

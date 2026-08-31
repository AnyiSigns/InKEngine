"""task_manager 完整续航闭环验证：同 thread 两回合。

r1：agent 开局用 task_manager 创建 3 项待办，只完成第 1 项，然后收口。
r2：续回合（同 data_dir + thread_id），agent 应经开篇注入看到清单，
    主动完成剩余待办并 list 收尾——验证清单跨回合接续。
"""
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
    "（shell_exec python --version 并附 evidence），第 2、3 项保持 pending。"
    "完成后用 list 确认。本轮结束后请直接收口，不要继续做第 2、3 项。"
)
R2 = (
    "请继续完成你的待办清单：查一下当前清单，把剩余未完成的待办逐项完成"
    "（glob 列出工作区、grep 搜索 'InKling'），每项附 evidence，最后 list 确认全部 done。"
)


def run_round(data_dir, thread_id, round_id, text, timeout=600):
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH', '')}"
    env["INKENGINE_WS_ROOT"] = str(Path(r"C:\Users\Anyi\Documents\test"))
    proc = subprocess.run(
        [str(HEADLESS), "--data-dir", str(data_dir), "--thread-id", thread_id,
         "--round-id", round_id, "--round", text],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=timeout,
    )
    envelope = {}
    if proc.stdout:
        try:
            envelope = json.loads(proc.stdout)
        except json.JSONDecodeError:
            pass
    data = envelope.get("data") or {}
    return {
        "ok": envelope.get("ok"),
        "reason": data.get("reason"),
        "output": data.get("output") or "",
        "stderr_tail": proc.stderr[-300:],
    }


def todo_snapshot(data_dir):
    sqlite = data_dir / "inkling.sqlite"
    if not sqlite.exists():
        return []
    conn = sqlite3.connect(sqlite)
    cur = conn.cursor()
    cur.execute("SELECT data FROM records WHERE collection='todo' AND key='list'")
    row = cur.fetchone()
    conn.close()
    if not row:
        return []
    obj = json.loads(row[0])
    return [(e.get("id"), e.get("status"), e.get("title")) for e in obj.get("entries", [])]


def main():
    ts = int(time.time())
    data_dir = Path(os.environ["TEMP"]) / f"exp-todo-chain-{ts}"
    thread_id = "todo-chain-test"
    print("== r1 ==")
    r1 = run_round(data_dir, thread_id, "r1", R1)
    print("ok:", r1["ok"], "reason:", r1["reason"])
    print("r1 后清单:", todo_snapshot(data_dir))
    print()
    print("== r2（续回合）==")
    r2 = run_round(data_dir, thread_id, "r2", R2)
    print("ok:", r2["ok"], "reason:", r2["reason"])
    final = todo_snapshot(data_dir)
    print("r2 后清单:", final)
    all_done = all(s == "done" for _, s, _ in final) and len(final) == 3
    print()
    print("== 结论 ==")
    print("r2 输出提及清单:", "待办" in r2["output"] or "task_manager" in r2["output"] or "清单" in r2["output"])
    print("r2 输出尾部:", r2["output"][-400:])
    print("续回合完成 3 项全 done:", all_done)
    print("data_dir:", data_dir)


if __name__ == "__main__":
    main()

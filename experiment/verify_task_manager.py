"""task_manager 端到端验证：headless 单回合 + 落库核对。"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(r"C:\Users\Anyi\Documents\PycharmProjects\InkEngine")
HEADLESS = REPO / "inkling" / "cli" / "target" / "debug" / "inkling-headless.exe"
PYTHON_ROOT = Path(r"C:\Users\Anyi\AppData\Local\Programs\Python\Python314")
VENV = REPO / ".venv" / "Scripts" / "python.exe"

TASK = (
    "先用 task_manager 创建两项待办（operation=create，title 分别为："
    "'绑定并调用 shell_exec'、'调用 glob 列出工作区'，第二项 detail='返回目录树'）。"
    "然后实际完成第一项（用 shell_exec 执行 python --version 作为证据，operation=complete"
    "附 evidence）。最后用 operation=list 列出当前清单。"
)


def main():
    env = dict(os.environ)
    env["PYO3_PYTHON"] = str(VENV)
    env["PYTHONHOME"] = str(PYTHON_ROOT)
    env["PATH"] = f"{PYTHON_ROOT};{env.get('PATH','')}"
    for k in ("INK_LLM_BASE_URL", "INK_LLM_MODEL", "INK_LLM_API_KEY"):
        if k in os.environ and k not in env:
            env[k] = os.environ[k]
    if not env.get("INK_LLM_MODEL"):
        print("[警告] 未设置 INK_LLM_MODEL —— 将走离线桩，需真实模型环境")
    data_dir = Path(os.environ["TEMP"]) / f"exp-todo-{int(time.time())}"
    proc = subprocess.run(
        [str(HEADLESS), "--data-dir", str(data_dir), "--thread-id", "todo-test",
         "--round-id", "r1", "--round", TASK],
        capture_output=True, text=True, encoding="utf-8", errors="replace", env=env,
        timeout=900,
    )
    print("exit:", proc.returncode)
    if proc.stdout:
        try:
            env_json = json.loads(proc.stdout)
            print("envelope ok:", env_json.get("ok"))
            data = env_json.get("data") or {}
            print("reason:", data.get("reason"))
            out = data.get("output") or ""
            print("output tail:", out[-800:])
        except json.JSONDecodeError:
            print("stdout:", proc.stdout[-500:])
    print("stderr tail:", proc.stderr[-400:])
    sqlite = data_dir / "inkling.sqlite"
    print("sqlite:", sqlite, sqlite.exists())
    if sqlite.exists():
        import sqlite3
        conn = sqlite3.connect(sqlite)
        cur = conn.cursor()
        cur.execute("SELECT key, data FROM records WHERE collection LIKE 'todo:%'")
        for k, d in cur.fetchall():
            obj = json.loads(d)
            entries = obj.get("entries", [])
            print(f"[todo 集合] {k}: {len(entries)} 条")
            for e in entries:
                print("   ", e.get("id"), e.get("status"), "|", e.get("title"),
                      "| evidence:", (e.get("evidence") or "")[:40])
        cur.execute("SELECT key, data FROM records WHERE collection='set_audit'")
        todo_audits = [json.loads(d) for _, d in cur.fetchall() if "todo" in d]
        print(f"[审计] todo 相关 {len(todo_audits)} 条")
        for a in todo_audits:
            print("   ", a.get("kind"), a.get("op"), a.get("id"))
        conn.close()


if __name__ == "__main__":
    main()

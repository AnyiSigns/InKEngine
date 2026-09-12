"""适配层 ToolAdapter：文件系统工具节点（网络外唯一的跨脚本复用点）。

只收 agent_demo / agent_demo2 两份逐字节相同的工具节点函数（append/list/read），
函数体原样搬入。save_fn 两版存在真实差异（v1 `chapters or []` 语义不同）、
代码验收 _exec_code_test 两版不同（v2 多一步 _strip_fences），均保留在各
demo 本地，不合并——合并即改逻辑。
"""

from __future__ import annotations

import os


class ToolAdapter:
    @staticmethod
    def append_fn(state):
        content = state.get("polished") or state.get("code") or state.get("answer") or ""
        if len(content) < 30:
            return None
        os.makedirs(state["workdir"], exist_ok=True)
        existed = os.path.exists(state["path"]) and os.path.getsize(state["path"]) > 0
        with open(state["path"], "a", encoding="utf-8") as f:
            f.write(("\n\n" if existed else "") + content)
        return {**state, "saved": True}

    @staticmethod
    def list_fn(state):
        try:
            files = os.listdir(state["workdir"])
            return {**state, "answer": "\n".join(files) if files else "(empty)"}
        except Exception:
            return None

    @staticmethod
    def read_fn(state):
        if not os.path.exists(state["path"]):
            return None
        with open(state["path"], encoding="utf-8", errors="ignore") as f:
            return {**state, "answer": f.read()[:2000]}

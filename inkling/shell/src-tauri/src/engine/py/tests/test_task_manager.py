"""待办清单（task_manager）执行体全链路测试。

覆盖：单工具多操作（create/update/complete/list/clear）、thread 隔离、
持久化（todo:<thread_id> 落库 + 重启读回）、审计留痕（set_audit）、
错误路径（缺 title/未知 operation/不存在 id）、装配注入器（make_todo_injector
摘要文本 + 预算截断 + 全完成空注入）。
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from ink_engine.core.storage_memory import MemoryStorage  # noqa: E402

from inkling_host.graph_recipe import make_todo_injector  # noqa: E402
from inkling_host.host import make_task_manager_executor  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


class _FakeCtx:
    def __init__(self, thread_id: str):
        self.thread_id = thread_id


class _FakeRuntime:
    def __init__(self, storage):
        self.storage = storage


class TaskManagerTest(unittest.TestCase):
    def setUp(self):
        self.storage = MemoryStorage()
        self.executor = make_task_manager_executor(_FakeRuntime(self.storage))
        self.defn = object()

    def _call(self, thread_id: str, args: dict) -> dict:
        raw = _run(self.executor(_FakeCtx(thread_id), self.defn, dict(args), None))
        return json.loads(raw)

    def test_operations_full_chain(self):
        r = self._call("t1", {"operation": "create", "title": "绑定 shell_exec"})
        self.assertTrue(r["ok"])
        tid = r["id"]
        r = self._call("t1", {"operation": "create", "title": "跑测试", "detail": "全部通过", "priority": "high"})
        self.assertTrue(r["ok"])
        r = self._call("t1", {"operation": "list"})
        self.assertEqual(r["total"], 2)
        # update：改状态 doing + 标题
        r = self._call("t1", {"operation": "update", "id": tid, "status": "doing", "title": "绑定 shell_exec"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["entry"]["status"], "doing")
        # complete：附证据
        r = self._call("t1", {"operation": "complete", "id": tid, "evidence": "exit 0"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["entry"]["status"], "done")
        self.assertEqual(r["entry"]["evidence"], "exit 0")
        self.assertIsNotNone(r["entry"]["completed_at"])
        # list 过滤：仅剩 pending 1 条
        r = self._call("t1", {"operation": "list", "status_filter": "pending"})
        self.assertEqual(len(r["entries"]), 1)
        # clear：清 done
        r = self._call("t1", {"operation": "clear"})
        self.assertEqual(r["removed"], [tid])
        r = self._call("t1", {"operation": "list"})
        self.assertEqual(r["total"], 1)

    def test_thread_isolation(self):
        r = self._call("thread-a", {"operation": "create", "title": "A 任务"})
        r = self._call("thread-b", {"operation": "create", "title": "B 任务"})
        a = self._call("thread-a", {"operation": "list"})
        b = self._call("thread-b", {"operation": "list"})
        self.assertEqual(a["total"], 1)
        self.assertEqual(b["total"], 1)
        self.assertEqual(a["entries"][0]["title"], "A 任务")
        self.assertEqual(b["entries"][0]["title"], "B 任务")

    def test_persistence_across_restart(self):
        self._call("t1", {"operation": "create", "title": "持久任务"})
        # 新执行体实例（模拟重启）读同一 storage
        executor2 = make_task_manager_executor(_FakeRuntime(self.storage))
        r = json.loads(_run(executor2(_FakeCtx("t1"), self.defn, {"operation": "list"}, None)))
        self.assertEqual(r["total"], 1)
        rec = _run(self.storage.get_record("todo:t1", "list"))
        self.assertIsNotNone(rec)
        self.assertEqual(len(rec["entries"]), 1)

    def test_audit_recorded(self):
        self._call("t1", {"operation": "create", "title": "审计条目"})
        self._call("t1", {"operation": "complete", "id": "task-0", "evidence": "ok"})
        recs = _run(self.storage.list_records("set_audit"))
        kinds = [json.loads(json.dumps(r))["kind"] for r in recs if isinstance(r, dict)]
        todo_ops = [r for r in recs if isinstance(r, dict) and r.get("kind") == "todo"]
        self.assertEqual(len(todo_ops), 2)
        self.assertEqual(todo_ops[0]["op"], "create")
        self.assertEqual(todo_ops[1]["op"], "complete")

    def test_error_paths(self):
        # 缺 title
        r = self._call("t1", {"operation": "create"})
        self.assertFalse(r["ok"])
        self.assertIn("title", r["error"])
        # 未知 operation
        r = self._call("t1", {"operation": "explode"})
        self.assertFalse(r["ok"])
        self.assertIn("未知 operation", r["error"])
        # 不存在 id
        self._call("t1", {"operation": "create", "title": "x"})
        r = self._call("t1", {"operation": "complete", "id": "task-99"})
        self.assertFalse(r["ok"])
        self.assertIn("不存在", r["error"])
        # 缺 operation（判定目标无法推导）
        r = self._call("t1", {})
        self.assertFalse(r["ok"])
        self.assertIn("未知 operation", r["error"])

    def test_priority_sort(self):
        self._call("t1", {"operation": "create", "title": "low", "priority": "low"})
        self._call("t1", {"operation": "create", "title": "high", "priority": "high"})
        self._call("t1", {"operation": "create", "title": "med"})
        r = self._call("t1", {"operation": "list"})
        titles = [e["title"] for e in r["entries"]]
        self.assertEqual(titles, ["high", "med", "low"])

    def test_delete_operation(self):
        r = self._call("t1", {"operation": "create", "title": "将被删除"})
        tid = r["id"]
        r = self._call("t1", {"operation": "delete", "id": tid})
        self.assertTrue(r["ok"])
        self.assertEqual(r["removed"], True)
        r = self._call("t1", {"operation": "list"})
        self.assertEqual(r["total"], 0)
        # 不存在 id
        r = self._call("t1", {"operation": "delete", "id": "task-99"})
        self.assertFalse(r["ok"])

    def test_injector_summary(self):
        injector = make_todo_injector(self.storage)
        # 空清单 → 空串
        self.assertEqual(_run(injector("t1")), "")
        self._call("t1", {"operation": "create", "title": "任务甲", "detail": "验收标准"})
        self._call("t1", {"operation": "create", "title": "任务乙", "priority": "high"})
        text = _run(injector("t1"))
        self.assertIn("任务甲", text)
        self.assertIn("验收标准", text)
        self.assertIn("任务乙", text)
        self.assertIn("task-0", text)
        # 全部完成 → 空注入
        self._call("t1", {"operation": "complete", "id": "task-0", "evidence": "e"})
        self._call("t1", {"operation": "complete", "id": "task-1", "evidence": "e"})
        self.assertEqual(_run(injector("t1")), "")
        # storage 不可用 → 空注入
        self.assertIsNone(make_todo_injector(None))

    def test_injector_thread_isolation(self):
        injector = make_todo_injector(self.storage)
        self._call("t-a", {"operation": "create", "title": "A"})
        self.assertIn("A", _run(injector("t-a")))
        self.assertEqual(_run(injector("t-b")), "")


if __name__ == "__main__":
    unittest.main()

"""工具循环短路测试（ENG3-12）：llm_decider 在 pending 未清空时不重调模型。

根因：graph_recipe 回合图 ``tool_pipeline → llm_decider`` 无条件回环，此前
llm_decider 每轮重调 LLM 会把 tool_pipeline 只消费 ``pending[0]`` 后剩余的
并行 tool_calls 覆盖丢弃（实测并行 create 第二条 title 错位/丢失）。修复 =
llm_decider 见 state.pending 非空即短路返回 None，条件边把控制交回
tool_pipeline 继续消费剩余项，直到清空才回 llm_decider。
"""

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from inkling_host.graph_recipe import (  # noqa: E402
    STATE_PENDING,
    make_llm_decider_factory,
)


def _run(coro):
    return asyncio.run(coro)


class _Calls:
    def __init__(self):
        self.count = 0

    async def astream(self, messages, tools=None, params=None):
        self.count += 1
        yield SimpleNamespace(token="无需重调", tool_calls_delta=None)


class _FakeCtx:
    def __init__(self, state, holder):
        self.state = state
        self._holder = holder
        self.round_id = "r1"

    @property
    def thread_id(self):
        return "t1"

    async def emit(self, etype, payload, **kw):
        pass


class ToolLoopShortCircuitTest(unittest.TestCase):
    def test_pending_nonempty_short_circuits_llm(self):
        """pending 未清空 → llm_decider 短路（不调模型，返回 None 保留剩余项）。"""
        calls = _Calls()
        holder = {"llm": calls}
        factory = make_llm_decider_factory(holder)
        node = factory({"system_prompt": "", "max_tool_rounds": 8})
        state = {
            STATE_PENDING: [
                {"name": "task_manager", "id": "c2", "arguments": {"operation": "create", "title": "第二个"}}
            ],
            "messages": [],
            "tool_rounds": 1,
        }
        ctx = _FakeCtx(state, holder)
        result = _run(node(ctx))
        self.assertIsNone(result, "pending 非空时 llm_decider 应短路返回 None")
        self.assertEqual(calls.count, 0, "短路不得触发模型调用")
        self.assertEqual(len(state[STATE_PENDING]), 1, "剩余 pending 不得被覆盖")

    def test_pending_empty_calls_llm(self):
        """pending 清空 → 正常调模型。"""
        calls = _Calls()
        holder = {"llm": calls}
        factory = make_llm_decider_factory(holder)
        node = factory({"system_prompt": "", "max_tool_rounds": 8})
        state = {STATE_PENDING: [], "messages": [], "tool_rounds": 0}
        ctx = _FakeCtx(state, holder)
        result = _run(node(ctx))
        self.assertIsNotNone(result, "pending 空时应正常调模型收口")
        self.assertEqual(calls.count, 1, "应触发一次模型调用")


if __name__ == "__main__":
    unittest.main()

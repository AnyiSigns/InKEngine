"""研究链链条节点参数传递测试（ENG3-12 遗留修复）。

断链根因：spawn 链式子图节点 = tool_pipeline（config.tool=工具名），参数
只从 step_args/config.args 取，无上游产物传递——链条下游缺参调用执行体
失败（parse 缺 text、validate 缺 data、score 缺 answer、review 缺
candidates，真实模型实证）。修复 = tool_pipeline 节点缺参时按研究链
契约从上游产物（state.results）推导参数：collect 以回合输入作 text 入料，
parse 取上游 collect 的 content、validate 取上游 parse 的 fields、
score/review/distill 以素材文本构造最小契约形态。
"""

import asyncio
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from inkling_host.graph_recipe import (  # noqa: E402
    STATE_RESULTS,
    chain_derived_args,
    make_tool_pipeline_factory,
)


def _run(coro):
    return asyncio.run(coro)


class _Outcome:
    def __init__(self, ok=True, output=""):
        self.ok = ok
        self.output = output


class _Pipeline:
    def __init__(self):
        self.calls = []

    async def execute(self, ctx, spec, args):
        self.calls.append((spec.name, dict(args)))
        payload = {"ok": True}
        if spec.name == "collect_material" and "text" in args:
            payload["content"] = args["text"]
        return _Outcome(ok=True, output=json.dumps(payload))


class _Spec:
    def __init__(self, name):
        self.name = name


class _FakeCtx:
    def __init__(self, state, holder):
        self.state = state
        self._holder = holder
        self.round_id = "r1"
        self._assembled = None

    @property
    def thread_id(self):
        return "t1"

    async def emit(self, etype, payload, **kw):
        pass


class ChainDerivedArgsTest(unittest.TestCase):
    def test_collect_uses_round_input(self):
        self.assertEqual(
            chain_derived_args("collect_material", {}, "素材文本"),
            {"text": "素材文本"},
        )
        self.assertIsNone(chain_derived_args("collect_material", {}, ""))

    def test_parse_takes_upstream_content(self):
        results = {"collect_material": json.dumps({"ok": True, "content": "原文"})}
        args = chain_derived_args("parse_material", results, "输入")
        self.assertEqual(args["text"], "原文")
        self.assertEqual(args["spec"], [])

    def test_validate_takes_upstream_fields(self):
        results = {
            "collect_material": json.dumps({"ok": True, "content": "原文"}),
            "parse_material": json.dumps(
                {"ok": True, "fields": {"title": "标题"}, "matched": ["title"]}
            ),
        }
        args = chain_derived_args("validate_material", results, "输入")
        self.assertEqual(args["data"], {"title": "标题"})

    def test_validate_falls_back_to_content_when_no_fields(self):
        results = {"collect_material": json.dumps({"ok": True, "content": "原文"})}
        args = chain_derived_args("validate_material", results, "输入")
        self.assertEqual(args["data"], {"content": "原文"})

    def test_review_builds_minimal_candidates(self):
        results = {"collect_material": json.dumps({"ok": True, "content": "原文"})}
        args = chain_derived_args("review_material", results, "输入")
        self.assertEqual(args["candidates"], [{"text": "原文", "claims": [{"text": "原文"}]}])

    def test_distill_builds_signal(self):
        results = {"collect_material": json.dumps({"ok": True, "content": "原文"})}
        args = chain_derived_args("distill_knowledge", results, "输入")
        self.assertEqual(
            args["signals"],
            [{"kind": "insight", "message": "原文", "source": "model"}],
        )

    def test_unknown_chain_tool_without_upstream_is_none(self):
        self.assertIsNone(chain_derived_args("some_other_tool", {}, "输入"))
        self.assertIsNone(chain_derived_args("parse_material", {}, "输入"))


class ToolPipelineChainPassingTest(unittest.TestCase):
    def test_chain_nodes_pass_upstream_results(self):
        """spawn 链式子图：collect → parse → validate，下游从上游 results 取参。"""
        pipeline = _Pipeline()
        holder = {
            "pipeline": pipeline,
            "specs": [_Spec("collect_material"), _Spec("parse_material"), _Spec("validate_material")],
            "all_specs": [_Spec("collect_material"), _Spec("parse_material"), _Spec("validate_material")],
            "inject": None,
            "llm": None,
        }
        factory = make_tool_pipeline_factory(holder)
        node_collect = factory({"tool": "collect_material"})
        node_parse = factory({"tool": "parse_material"})
        node_validate = factory({"tool": "validate_material"})

        state = {"input": "输入"}
        ctx = _FakeCtx(state, holder)
        delta = _run(node_collect(ctx))
        state.update(delta or {})
        self.assertEqual(pipeline.calls[-1][1], {"text": "输入"})

        delta = _run(node_parse(ctx))
        state.update(delta or {})
        self.assertEqual(pipeline.calls[-1][0], "parse_material")
        self.assertEqual(pipeline.calls[-1][1]["text"], "输入")

        _run(node_validate(ctx))
        self.assertEqual(pipeline.calls[-1][0], "validate_material")
        self.assertIn("data", pipeline.calls[-1][1])

    def test_results_accumulate_across_chain(self):
        """每个链环节点的产物累积进 state.results（下游可读）。"""
        pipeline = _Pipeline()
        holder = {
            "pipeline": pipeline,
            "specs": [_Spec("collect_material"), _Spec("parse_material")],
            "all_specs": [_Spec("collect_material"), _Spec("parse_material")],
            "inject": None,
            "llm": None,
        }
        factory = make_tool_pipeline_factory(holder)
        node = factory({"tool": "collect_material"})
        state = {}
        ctx = _FakeCtx(state, holder)
        delta = _run(node(ctx))
        state.update(delta or {})
        self.assertIn("collect_material", state[STATE_RESULTS])


if __name__ == "__main__":
    unittest.main()

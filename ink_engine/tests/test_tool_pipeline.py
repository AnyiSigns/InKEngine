"""工具执行流水线本体单测（门禁/沙箱/守卫/审计/轨迹的机制环节）。

语义检查点：
- 未配置操作提取器且未显式放宽 = 拒绝（fail-closed）；
- 权限门禁默认拒绝；显式放宽（default_policy）是明示安全让步；
- 沙箱校验结果回写执行参数（执行对象 = 校验对象）；
- 守卫抛异常即拒绝；结果观察截断 + 溢出标记；
- 默认审计经 ctx.emit 发 tool_audit 事件；轨迹回调失败不阻断执行。
"""
from __future__ import annotations

import pytest

from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import ALLOW, DENY, REVIEW, PermissionGate
from ink_engine.core.sandbox import FileSandbox
from ink_engine.core.tool_pipeline import ToolPipeline


def _spec(**kw) -> ToolSpec:
    base = {"name": "t", "description": "工具", "parameters": {}}
    base.update(kw)
    return ToolSpec(**base)


async def _execute(pipeline: ToolPipeline, spec: ToolSpec, args: dict, transport=None):
    class Ctx:
        def __init__(self):
            self.events = []

        async def emit(self, etype, payload, **kw):
            self.events.append((etype, payload))

    ctx = Ctx()
    result = await pipeline.execute(ctx, spec, args)
    if transport is not None:
        transport.extend(ctx.events)
    return result


async def test_pipeline_no_extractor_fail_closed():
    """未配置操作提取器且未显式放宽 = 拒绝（fail-closed 底线）。"""
    calls: list[dict] = []

    async def executor(ctx, spec, args, approval):
        calls.append(args)
        return "ok"

    pipeline = ToolPipeline(executor=executor)
    result = await _execute(pipeline, _spec(), {"x": 1})
    assert result.ok is False
    assert result.decision == DENY
    assert "未配置操作提取器" in (result.error or "")
    assert calls == []  # 拒绝路径不触碰执行体


async def test_pipeline_extractor_none_fail_closed():
    """提取器配置了但本次解析不出目标 = 拒绝（无法判定就不执行）。"""
    calls: list[dict] = []

    async def executor(ctx, spec, args, approval):
        calls.append(args)
        return "ok"

    pipeline = ToolPipeline(
        extractor=lambda spec, args: None,  # 恒无判定目标
        executor=executor,
    )
    result = await _execute(pipeline, _spec(), {})
    assert result.ok is False
    assert result.decision == DENY
    assert "无法判定目标" in (result.error or "")
    assert calls == []


async def test_gate_explicit_relaxation_is_explicit():
    """门禁显式放宽（default_policy=ALLOW）才是明示安全让步。"""
    async def executor(ctx, spec, args, approval):
        return "ok"

    # 默认策略：未命中权限拒绝
    strict = ToolPipeline(
        gate=PermissionGate(),  # 默认 deny
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
    )
    result = await _execute(strict, _spec(), {"command": "rm"})
    assert result.ok is False
    assert result.decision == DENY

    # 显式放宽：未命中权限也放行（宿主明示让步）
    relaxed = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
    )
    result = await _execute(relaxed, _spec(), {"command": "rm"})
    assert result.ok is True
    assert result.decision == ALLOW


async def test_sandbox_resolved_target_substituted():
    """沙箱校验结果回写执行参数（执行对象 = 校验对象，防二次拼接）。"""
    async def executor(ctx, spec, args, approval):
        return args["path"]

    sandbox = FileSandbox(root="/root")
    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("write", args["path"]),
        sandboxes=(sandbox,),
        executor=executor,
    )
    result = await _execute(pipeline, _spec(), {"path": "sub/a.md"})
    assert result.ok is True
    assert result.output.startswith(str(sandbox.resolve("sub/a.md")))


async def test_sandbox_violation_denies():
    """沙箱违规（路径越界）→ 拒绝并留痕原因。"""
    async def executor(ctx, spec, args, approval):
        raise AssertionError("沙箱违规不应触达执行体")

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("write", args["path"]),
        sandboxes=(FileSandbox(root="/root"),),
        executor=executor,
    )
    result = await _execute(pipeline, _spec(), {"path": "../etc/passwd"})
    assert result.ok is False
    assert result.decision == DENY
    assert "路径越界" in (result.error or "")


async def test_guard_exception_denies():
    """单调守卫抛异常即拒绝（fail-closed）。"""
    def guard(ctx, spec, args):
        raise RuntimeError("同一动作重复执行")

    async def executor(ctx, spec, args, approval):
        return "ok"

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("exec", args["command"]),
        guards=(guard,),
        executor=executor,
    )
    result = await _execute(pipeline, _spec(), {"command": "git"})
    assert result.ok is False
    assert result.decision == DENY
    assert "同一动作重复执行" in (result.error or "")


async def test_result_overflow_truncated():
    """结果观察：超限截断 + 溢出标记（全量由宿主按 locator 取回）。"""
    async def executor(ctx, spec, args, approval):
        return "x" * 1000

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
        max_result_chars=100,
    )
    result = await _execute(pipeline, _spec(), {"command": "git"})
    assert result.ok is True
    assert result.overflow is True
    assert result.output == "x" * 100 + "\n…（溢出截断）"


async def test_default_audit_via_ctx_emit(memory_storage):
    """默认审计：经 ctx.emit 发 tool_audit 事件（允许与拒绝均留痕）。"""
    async def executor(ctx, spec, args, approval):
        return "ok"

    pipeline = ToolPipeline(
        gate=PermissionGate(),  # 默认 deny（本测试借拒绝路径验审计）
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
    )

    class Ctx:
        def __init__(self):
            self.events = []

        async def emit(self, etype, payload, **kw):
            self.events.append((etype, payload))

    ctx = Ctx()
    denied = await pipeline.execute(ctx, _spec(), {"command": "rm"})
    assert denied.ok is False
    assert ctx.events and ctx.events[0][0] == "tool_audit"
    assert ctx.events[0][1]["decision"] == "deny"


async def test_trace_sink_failure_tolerated():
    """轨迹回调失败只记日志不阻断（观测不阻断执行）。"""
    async def executor(ctx, spec, args, approval):
        return "ok"

    def bad_sink(trace):
        raise RuntimeError("轨迹落库失败")

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
        trace_sink=bad_sink,
    )
    result = await _execute(pipeline, _spec(), {"command": "git"})
    assert result.ok is True
    assert result.output == "ok"


async def test_trace_sink_receives_outcome():
    """轨迹回调收到调用结果（成败/决议/耗时——经验闭环信号源）。"""
    traces: list = []

    async def executor(ctx, spec, args, approval):
        return "ok"

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=ALLOW),
        extractor=lambda spec, args: ("exec", args["command"]),
        executor=executor,
        trace_sink=lambda trace: traces.append(trace),
    )
    result = await _execute(pipeline, _spec(), {"command": "git"})
    assert result.ok is True
    assert len(traces) == 1
    assert traces[0].tool == "t"
    assert traces[0].ok is True
    assert traces[0].decision == ALLOW
    assert traces[0].duration_ms >= 0


async def test_auto_approval_prefixes_result_text():
    """auto 决议（策略直过）执行结果前缀标注（审批语义可观测）。

    回归：修复前 auto 直过只透传 approval.decision=auto，执行结果文本
    无任何审批语义标记——模型把已放行的执行误判为 interrupted 反复重试；
    修复后结果文本前缀「已自动批准执行」，模型可辨识为已放行。
    """
    from ink_engine.core.approval import DefaultInterruptPolicy

    calls: list[str] = []

    async def executor(ctx, spec, args, approval):
        calls.append(str(approval.decision))
        return "done"

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=REVIEW),
        extractor=lambda spec, args: ("write", args["path"]),
        executor=executor,
        approval_policy=DefaultInterruptPolicy(auto_approve_tools={"t"}),
    )
    result = await _execute(pipeline, _spec(), {"path": "a.md"})
    assert result.ok is True
    assert result.decision == ALLOW
    assert result.approval is not None and result.approval.decision == "auto"
    assert result.output.startswith("【已自动批准执行】")
    assert result.output.endswith("done")
    assert calls == ["auto"]


async def test_auto_approval_prefix_present_with_empty_output():
    """auto 直过即使执行输出为空也标注放行语义（模型不误判 interrupted）。"""
    from ink_engine.core.approval import DefaultInterruptPolicy

    async def executor(ctx, spec, args, approval):
        return None  # 执行成功但无输出

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=REVIEW),
        extractor=lambda spec, args: ("write", args["path"]),
        executor=executor,
        approval_policy=DefaultInterruptPolicy(auto_approve_tools={"t"}),
    )
    result = await _execute(pipeline, _spec(), {"path": "a.md"})
    assert result.ok is True
    assert result.output == "【已自动批准执行】"


async def test_review_not_in_auto_policy_hangs_gate():
    """非直过工具（review 未在 auto 名单）仍挂卡：auto 名单是明示让步。"""
    from ink_engine.core.approval import DefaultInterruptPolicy
    from ink_engine.core.interrupt import InterruptSignal

    async def executor(ctx, spec, args, approval):
        raise AssertionError("挂卡路径不应执行")

    pipeline = ToolPipeline(
        gate=PermissionGate(default_policy=REVIEW),
        extractor=lambda spec, args: ("write", args["path"]),
        executor=executor,
        approval_policy=DefaultInterruptPolicy(auto_approve_tools=()),  # 空名单
    )

    class HangingCtx:
        async def interrupt(self, key, payload):
            raise InterruptSignal(key, payload)

    with pytest.raises(InterruptSignal):
        await pipeline.execute(HangingCtx(), _spec(), {"path": "a.md"})

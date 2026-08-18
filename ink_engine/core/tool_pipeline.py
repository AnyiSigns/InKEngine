"""工具执行流水线（权限门禁 → 沙箱守卫 → 单调守卫 → 分发执行 → 审计 → 结果观察）。

流水线把工具调用的机制环节规范化装配，宿主无需重写：

- 调用前策略：PermissionGate 判定（fail-closed）；需审批（review）委托
  ``approve_before_execute`` 挂 gate 卡（PermissionGate 自身不挂起）；
- 沙箱守卫：FileSandbox/ProcessSandbox 的 ``validate(operation, target)``；
- 单调守卫：可注入守卫钩子（同一动作重复执行保护等），抛异常即拒绝；
- 分发执行：``executor`` 钩子（宿主工具实现；也可传 ``ProcessSandbox.run``
  之类内置执行器），审批决议（含 edit 的 edited_content）透传给执行器；
- 调用后策略：审计留痕（operation/decision/result 事件或宿主钩子）；
- 结果观察：输出截断 + 溢出标记（全量内容由宿主按需存 locator 取回）。

操作提取（operation extractor）：工具参数语义由宿主声明——
``extractor(spec, args)`` 返回 ``(operation, target)``（如 ``("write",
"/book/ch1.md")`` / ``("exec", "git")``），None = 无权限/沙箱判定目标
（纯内存工具直通）。
"""
from __future__ import annotations

import inspect
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from .approval import (
    DECISION_REJECT,
    DECISION_TERMINATE,
    ApprovalDecision,
    approve_before_execute,
)
from .exceptions import SandboxViolation
from .llm.tools import ToolSpec
from .logging import get_logger
from .permissions import ALLOW as _ALLOW
from .permissions import DENY as _DENY
from .permissions import REVIEW as _REVIEW
from .tool_orchestrator import ToolTrace

logger = get_logger(__name__)

DENY = _DENY
ALLOW = _ALLOW
REVIEW = _REVIEW


def _substitute_target(value: Any, target: str, resolved: str) -> Any:
    """递归替换 args 中与原始 target 相等的值 → 沙箱解析结果。

    执行对象与校验对象一致：extractor 从 args 提取 target 判定的路径，
    分发执行前替换为规范化绝对路径（防二次拼接/相对基准漂移引入逃逸）。
    """
    if isinstance(value, dict):
        return {k: _substitute_target(v, target, resolved) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute_target(v, target, resolved) for v in value]
    if value == target:
        return resolved
    return value


@dataclass(slots=True)
class ToolResult:
    """单次工具调用的执行结果（宿主按 decision/ok 分发）。

    Attributes:
        ok: 是否成功执行（True = 已执行；False = 拒绝/审批未过/执行出错）。
        decision: allow（已执行）/ deny（拒绝）/ accept/terminate（审批决议）/
            error（执行异常）。
        output: 截断后的结果文本（结果观察）。
        overflow: 结果是否超限截断（全量可由宿主存 locator 取回）。
        approval: 审批决议透传（edit 的 edited_content 供执行器使用）。
        error: 拒绝/出错原因。
    """

    ok: bool
    decision: str = ALLOW
    output: str = ""
    overflow: bool = False
    approval: ApprovalDecision | None = None
    error: str | None = None


@dataclass(slots=True)
class ToolPipeline:
    """工具执行流水线装配（机制环节全可注入，缺省 = fail-closed 拒绝）。

    Attributes:
        gate: 权限门禁（None = 跳过权限判定，宿主自行取舍）。
        extractor: 操作提取器 (spec, args) -> (operation, target) | None
            （None = 纯内存工具无判定目标，直通）。
        sandboxes: 沙箱守卫列表（validate(operation, target) 协议）。
        guards: 单调守卫列表 (ctx, spec, args)，抛异常即拒绝执行。
        executor: 分发执行器 (ctx, spec, args, approval) -> 结果文本。
        audit: 审计钩子 (ctx, record)；None = 默认经 ctx.emit 发 tool_audit 事件。
        max_result_chars: 结果观察截断上限。
        allow_unchecked: 未配置 extractor 时是否允许直通执行器（默认
            False = 拒绝；宿主须明示安全让步才可放宽）。
    """

    gate: Any | None = None
    extractor: Callable[[ToolSpec, dict], tuple[str, str] | None] | None = None
    sandboxes: tuple[Any, ...] = ()
    guards: tuple[Callable[..., Any], ...] = ()
    executor: Callable[..., Awaitable] | None = None
    audit: Callable[..., Any] | None = None
    max_result_chars: int = 100_000
    allow_unchecked: bool = False
    # 工具轨迹回调（经验闭环的信号出口）：每次调用结束后回调
    # (trace: ToolTrace)，宿主接 ToolTraceStore 落库；None = 不记录。
    # 回调失败只记日志不阻断主流程（观测不阻断执行）。
    trace_sink: Callable[..., Any] | None = None

    async def execute(self, ctx: Any, spec: ToolSpec, args: dict) -> ToolResult:
        """执行一次工具调用（全环节机制化装配，任一环节拒绝即 fail-closed）。

        全程计时并在出口回调轨迹（成败/决议/耗时/错误——经验闭环的
        原始信号）；所有返回路径统一经 :meth:`_finish` 收口，保证轨迹
        记录不遗漏。
        """
        started = time.monotonic()

        async def _finish(result: ToolResult) -> ToolResult:
            if self.trace_sink is not None:
                try:
                    outcome = self.trace_sink(
                        ToolTrace(
                            tool=spec.name,
                            ok=result.ok,
                            decision=result.decision,
                            args=dict(args),
                            error=result.error,
                            duration_ms=(time.monotonic() - started) * 1000.0,
                        )
                    )
                    if inspect.isawaitable(outcome):
                        await outcome
                except Exception as exc:
                    logger.warning(f"工具轨迹记录失败（忽略）[{spec.name}]: {exc}")
            return result

        # 未配置操作提取器：无判定目标即无法做权限/沙箱判定——默认拒绝
        # （fail-closed），宿主须显式 allow_unchecked=True 才可直通
        if self.extractor is None and not self.allow_unchecked:
            await self._audit(
                ctx,
                {"tool": spec.name, "decision": "deny", "reason": "未配置操作提取器，拒绝执行（fail-closed）"},
            )
            return await _finish(
                ToolResult(ok=False, decision=DENY, error="未配置操作提取器，拒绝执行（fail-closed）")
            )
        op_target = self.extractor(spec, args) if self.extractor is not None else None
        if op_target is None:
            # 提取器已配置但本次调用解析不出判定目标（非法/缺参）：
            # 与「未配置提取器」同语义 fail-closed——无法判定目标就无法做
            # 权限/沙箱判定，绝不直通执行（声明式工具的非法参数路径）。
            # allow_unchecked=True 的直通仅对「有意不做判定」的工具生效。
            if not self.allow_unchecked:
                await self._audit(
                    ctx,
                    {"tool": spec.name, "decision": "deny", "reason": "操作提取器无法判定目标，拒绝执行（fail-closed）"},
                )
                return await _finish(
                    ToolResult(ok=False, decision=DENY, error="操作提取器无法判定目标，拒绝执行（fail-closed）")
                )
            operation, target = None, None
        else:
            operation, target = op_target

        # ── 调用前策略：权限门禁（review 委托挂卡审批）──
        approval: ApprovalDecision | None = None
        if self.gate is not None and operation is not None:
            verdict = self.gate.check(
                spec.name, operation, target, permissions=spec.permissions
            )
            if verdict.decision == _ALLOW:
                pass
            elif verdict.decision == _REVIEW:
                approval = await approve_before_execute(
                    ctx,
                    f"gate:{spec.name}",
                    {"tool": spec.name, "args": args},
                )
                if approval.decision in (DECISION_REJECT, DECISION_TERMINATE):
                    await self._audit(
                        ctx,
                        {"tool": spec.name, "operation": operation, "decision": approval.decision, "reason": approval.reason},
                    )
                    return await _finish(
                        ToolResult(ok=False, decision=approval.decision, approval=approval, error=approval.reason or "审批未通过")
                    )
            else:
                # DENY 与任何未知 decision：一律拒绝（fail-closed——未知
                # 判定值不得静默落到"继续执行"）
                await self._audit(
                    ctx,
                    {"tool": spec.name, "operation": operation, "decision": "deny", "reason": verdict.reason or f"未命中的权限判定: {verdict.decision!r}"},
                )
                return await _finish(
                    ToolResult(ok=False, decision=DENY, error=verdict.reason or "权限拒绝")
                )

        # ── 沙箱守卫（校验结果回写执行参数：执行对象 = 校验对象）──
        resolved_target: str | None = None
        if operation is not None:
            for sb in self.sandboxes:
                try:
                    resolved = sb.validate(operation, target)
                except SandboxViolation as exc:
                    await self._audit(
                        ctx,
                        {"tool": spec.name, "operation": operation, "decision": "deny", "reason": str(exc)},
                    )
                    return await _finish(ToolResult(ok=False, decision=DENY, error=str(exc)))
                if resolved is not None and resolved_target is None:
                    resolved_target = str(resolved)
            if resolved_target is not None and resolved_target != target:
                args = _substitute_target(args, target, resolved_target)

        # ── 单调守卫（抛异常即拒绝，fail-closed）──
        for guard in self.guards:
            try:
                result = guard(ctx, spec, args)
                if inspect.isawaitable(result):
                    await result
            except Exception as exc:
                await self._audit(
                    ctx,
                    {"tool": spec.name, "decision": "deny", "reason": f"守卫拒绝: {exc}"},
                )
                return await _finish(
                    ToolResult(ok=False, decision=DENY, error=f"守卫拒绝: {exc}")
                )

        # ── 分发执行（兼容同步/异步执行器）──
        if self.executor is None:
            return await _finish(
                ToolResult(ok=False, decision=DENY, error="未配置执行器")
            )
        try:
            output = self.executor(ctx, spec, args, approval)
            if inspect.isawaitable(output):
                output = await output
        except Exception as exc:
            await self._audit(
                ctx, {"tool": spec.name, "decision": "error", "error": str(exc)}
            )
            return await _finish(
                ToolResult(ok=False, decision="error", error=str(exc))
            )

        # ── 调用后：审计留痕 + 结果观察（截断/溢出标记）──
        text = str(output) if output is not None else ""
        overflow = len(text) > self.max_result_chars
        truncated = text[: self.max_result_chars] + ("\n…（溢出截断）" if overflow else "")
        await self._audit(
            ctx, {"tool": spec.name, "decision": "ok", "overflow": overflow}
        )
        return await _finish(
            ToolResult(
                ok=True, decision=ALLOW, output=truncated, overflow=overflow, approval=approval
            )
        )

    async def _audit(self, ctx: Any, record: dict) -> None:
        if self.audit is not None:
            result = self.audit(ctx, record)
            if inspect.isawaitable(result):
                await result
            return
        emit = getattr(ctx, "emit", None)
        if emit is not None:
            await emit("tool_audit", record)


__all__ = ["ALLOW", "DENY", "ToolPipeline", "ToolResult"]

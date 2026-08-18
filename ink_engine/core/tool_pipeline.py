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
from .permissions import ALLOW as _ALLOW
from .permissions import DENY as _DENY

DENY = _DENY
ALLOW = _ALLOW


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
    """工具执行流水线装配（机制环节全可注入，缺省 = 无门禁直通执行器）。

    Attributes:
        gate: 权限门禁（None = 跳过权限判定，宿主自行取舍）。
        extractor: 操作提取器 (spec, args) -> (operation, target) | None。
        sandboxes: 沙箱守卫列表（validate(operation, target) 协议）。
        guards: 单调守卫列表 (ctx, spec, args)，抛异常即拒绝执行。
        executor: 分发执行器 (ctx, spec, args, approval) -> 结果文本。
        audit: 审计钩子 (ctx, record)；None = 默认经 ctx.emit 发 tool_audit 事件。
        max_result_chars: 结果观察截断上限。
    """

    gate: Any | None = None
    extractor: Callable[[ToolSpec, dict], tuple[str, str] | None] | None = None
    sandboxes: tuple[Any, ...] = ()
    guards: tuple[Callable[..., Any], ...] = ()
    executor: Callable[..., Awaitable] | None = None
    audit: Callable[..., Any] | None = None
    max_result_chars: int = 100_000

    async def execute(self, ctx: Any, spec: ToolSpec, args: dict) -> ToolResult:
        """执行一次工具调用（全环节机制化装配，任一环节拒绝即 fail-closed）。"""
        op_target = self.extractor(spec, args) if self.extractor is not None else None
        operation, target = op_target if op_target is not None else (None, None)

        # ── 调用前策略：权限门禁（review 委托挂卡审批）──
        approval: ApprovalDecision | None = None
        if self.gate is not None and operation is not None:
            verdict = self.gate.check(
                spec.name, operation, target, permissions=spec.permissions
            )
            if verdict.decision == DENY:
                await self._audit(
                    ctx,
                    {"tool": spec.name, "operation": operation, "decision": "deny", "reason": verdict.reason},
                )
                return ToolResult(ok=False, decision=DENY, error=verdict.reason)
            if verdict.decision == "review":
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
                    return ToolResult(ok=False, decision=approval.decision, approval=approval, error=approval.reason or "审批未通过")

        # ── 沙箱守卫 ──
        if operation is not None:
            for sb in self.sandboxes:
                try:
                    sb.validate(operation, target)
                except SandboxViolation as exc:
                    await self._audit(
                        ctx,
                        {"tool": spec.name, "operation": operation, "decision": "deny", "reason": str(exc)},
                    )
                    return ToolResult(ok=False, decision=DENY, error=str(exc))

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
                return ToolResult(ok=False, decision=DENY, error=f"守卫拒绝: {exc}")

        # ── 分发执行（兼容同步/异步执行器）──
        if self.executor is None:
            return ToolResult(ok=False, decision=DENY, error="未配置执行器")
        try:
            output = self.executor(ctx, spec, args, approval)
            if inspect.isawaitable(output):
                output = await output
        except Exception as exc:
            await self._audit(
                ctx, {"tool": spec.name, "decision": "error", "error": str(exc)}
            )
            return ToolResult(ok=False, decision="error", error=str(exc))

        # ── 调用后：审计留痕 + 结果观察（截断/溢出标记）──
        text = str(output) if output is not None else ""
        overflow = len(text) > self.max_result_chars
        truncated = text[: self.max_result_chars] + ("\n…（溢出截断）" if overflow else "")
        await self._audit(
            ctx, {"tool": spec.name, "decision": "ok", "overflow": overflow}
        )
        return ToolResult(
            ok=True, decision=ALLOW, output=truncated, overflow=overflow, approval=approval
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

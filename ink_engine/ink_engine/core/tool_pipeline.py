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
    DECISION_AUTO,
    DECISION_EDIT,
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
from .security import strip_sensitive
from .tool_orchestrator import ToolTrace

logger = get_logger(__name__)

DENY = _DENY
ALLOW = _ALLOW
REVIEW = _REVIEW

# 工具结果文本截断上限（ENG6-6：100_000 魔法数字共享常量——引擎工具
# 流水线默认值；声明式工具流水线/自指工具/内省工具同源引用，防多份
# 拷贝漂移）
DEFAULT_MAX_RESULT_CHARS = 100_000


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
        failure_reason: 提取失败的原因钩子 (spec, args) -> str | None；
            判定目标推导失败时把原因并入 fail-closed 拒绝文案，指引
            模型自我纠正（缺参/非法形态可定位）。
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
    failure_reason: Callable[[ToolSpec, dict], str | None] | None = None
    sandboxes: tuple[Any, ...] = ()
    guards: tuple[Callable[..., Any], ...] = ()
    executor: Callable[..., Awaitable] | None = None
    audit: Callable[..., Any] | None = None
    max_result_chars: int = DEFAULT_MAX_RESULT_CHARS
    allow_unchecked: bool = False
    # 审批决议策略（None = approve_before_execute 默认全挂起；宿主注入
    # 直过白名单（auto-approve）后 review 档可策略直过，决议 auto 会
    # 在执行结果文本前缀标注——审批语义对模型可观测）
    approval_policy: Any | None = None
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
                            # 轨迹落库前对参数脱敏：凭据类参数不得随轨迹
                            # 持久化留存（strip_sensitive 纯函数，无敏感键
                            # 时零拷贝返回原对象）
                            args=strip_sensitive(dict(args)),
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
                hint = ""
                if self.failure_reason is not None:
                    try:
                        reason = self.failure_reason(spec, args)
                    except Exception:
                        reason = None
                    if reason:
                        hint = f"：{reason}"
                message = f"操作提取器无法判定目标，拒绝执行（fail-closed）{hint}"
                await self._audit(
                    ctx,
                    {"tool": spec.name, "decision": "deny", "reason": message},
                )
                return await _finish(
                    ToolResult(ok=False, decision=DENY, error=message)
                )
            operation, target = None, None
        else:
            operation, target = op_target

        # ── 路径解析前置（ENG6-4：统一两闸基准）──
        # 权限门禁与沙箱守卫的判定对象必须一致：相对路径在 PermissionGate
        # 规则基准下无法命中（沙箱基线 = 绝对路径白名单），导致「沙箱接
        # 住但 gate 漏过 / gate 接住但沙箱按相对路径拒」的判定漂移。本步
        # 在 gate 判定前复用沙箱 resolve 逻辑把 target 解析为沙箱基准下
        # 的绝对路径（沙箱异常时拒绝，fail-closed），并同步回写 args——
        # 后续 gate.check 与 sb.validate 看同一份解析结果。原始字面
        # 量 target 保留 = ``_resolved_pre_target``，权限规则按字面量
        # 注册时仍可命中（不强制要求规则升级为绝对路径）。
        _resolved_pre_target: str | None = None
        if operation is not None and target is not None:
            _resolved_pre_target = target
            try:
                resolved = self._resolve_target(spec, operation, target)
            except SandboxViolation as exc:
                await self._audit(
                    ctx,
                    {"tool": spec.name, "operation": operation, "decision": "deny", "reason": str(exc)},
                )
                return await _finish(ToolResult(ok=False, decision=DENY, error=str(exc)))
            if resolved is not None and resolved != target:
                args = _substitute_target(args, target, resolved)
                target = resolved

        # ── 调用前策略：权限门禁（review 委托挂卡审批）──
        # edit 决议的编辑内容须重走校验链：宿主编辑可能改写工具参数
        # （路径/命令），绕过已校验的沙箱边界——编辑内容（dict 形态）
        # 作为新 args 重新提取判定目标并重过权限门禁，校验对象 =
        # 执行对象。编辑轮次限 1 次（二次编辑 = 拒绝，防挂卡死循环）。
        # ENG6-4：路径解析前置已将 target 规范化为沙箱基准下的绝对路径；
        # 权限规则可能仍按原始字面量（如 ``/ws``）注册——同时按解析前
        # 后的 target 判定（任一命中 = ALLOW），保证相对路径规则不
        # 因解析规范化而失配。
        approval: ApprovalDecision | None = None
        for _edit_round in range(2):
            if self.gate is not None and operation is not None:
                verdict = self.gate.check(
                    spec.name, operation, target, permissions=spec.permissions
                )
                if verdict.decision == _ALLOW:
                    pass
                elif (
                    verdict.decision != _REVIEW
                    and _resolved_pre_target is not None
                    and _resolved_pre_target != target
                ):
                    # 解析后未命中：尝试原始 target（规则按字面量注册的场景）
                    verdict = self.gate.check(
                        spec.name,
                        operation,
                        _resolved_pre_target,
                        permissions=spec.permissions,
                    )
                if verdict.decision == _ALLOW:
                    pass
                elif verdict.decision == _REVIEW:
                    approval = await approve_before_execute(
                        ctx,
                        f"gate:{spec.name}",
                        {"tool": spec.name, "args": args},
                        policy=self.approval_policy,
                    )
                    if approval.decision in (DECISION_REJECT, DECISION_TERMINATE):
                        await self._audit(
                            ctx,
                            {"tool": spec.name, "operation": operation, "decision": approval.decision, "reason": approval.reason},
                        )
                        return await _finish(
                            ToolResult(ok=False, decision=approval.decision, approval=approval, error=approval.reason or "审批未通过")
                        )
                    if approval.decision == DECISION_EDIT:
                        edited = approval.edited_content
                        if not isinstance(edited, dict) or _edit_round >= 1:
                            reason = (
                                "edit 决议内容无法重新校验"
                                "（须为参数对象且仅允许一次编辑），拒绝执行"
                            )
                            await self._audit(
                                ctx,
                                {"tool": spec.name, "operation": operation, "decision": "deny", "reason": reason},
                            )
                            return await _finish(
                                ToolResult(ok=False, decision=DENY, approval=approval, error=reason)
                            )
                        # 编辑内容作为新参数重走提取器：判定目标可能改变
                        # （改写路径/命令），沙箱守卫必须对编辑后目标生效
                        new_args = edited
                        op_target = (
                            self.extractor(spec, new_args)
                            if self.extractor is not None
                            else None
                        )
                        if op_target is None:
                            reason = "edit 决议内容无法提取判定目标，拒绝执行（fail-closed）"
                            await self._audit(
                                ctx,
                                {"tool": spec.name, "operation": operation, "decision": "deny", "reason": reason},
                            )
                            return await _finish(
                                ToolResult(ok=False, decision=DENY, approval=approval, error=reason)
                            )
                        args = new_args
                        operation, target = op_target
                        continue  # 重走权限门禁（编辑后目标重新判定）
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
            break

        # ── 沙箱守卫（校验结果回写执行参数：执行对象 = 校验对象）──
        if operation is not None:
            for sb in self.sandboxes:
                # 操作域过滤：沙箱只守卫自己声明的操作（多端点流水线
                # 自动接线时各沙箱各司其职——进程调用不被文件/网络沙箱
                # 误拒，反之亦然）；未声明守卫域 = 全量判定（旧语义）
                if (
                    getattr(sb, "guards_operation", None) is not None
                    and not sb.guards_operation(operation)
                ):
                    continue
                try:
                    if "name" in inspect.signature(sb.validate).parameters:
                        # 定义反查型沙箱（_AutoDefinitionSandbox）按当前
                        # 调用工具自身定义构造守卫（防跨工具 root 泄漏）
                        resolved = sb.validate(operation, target, name=spec.name)
                    else:
                        resolved = sb.validate(operation, target)
                except SandboxViolation as exc:
                    await self._audit(
                        ctx,
                        {"tool": spec.name, "operation": operation, "decision": "deny", "reason": str(exc)},
                    )
                    return await _finish(ToolResult(ok=False, decision=DENY, error=str(exc)))
                if resolved is not None and resolved != target:
                    args = _substitute_target(args, target, resolved)
                    target = str(resolved)

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
        if approval is not None and approval.decision == DECISION_AUTO:
            # 审批语义可观测：策略直过（auto）在执行结果文本前缀
            # 标注——模型不再把「已放行的执行」误判为 interrupted 重试
            text = f"【已自动批准执行】{text}"
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

    def _resolve_target(
        self, spec: ToolSpec, operation: str, target: str
    ) -> str | None:
        """复用沙箱 resolve 逻辑预解析 target（ENG6-4 统一两闸基准）。

        任一沙箱能解析（validate 返回非 None 路径/命令）= 取首个解析
        结果作为「绝对基准」target；全部沙箱都不解析（None 或未声明守
        卫域）= 返回原 target（无法规范化的命令等直通字面量）。沙箱
        抛 ``SandboxViolation`` 由调用方收口（拒绝），不在此吞。
        """
        for sb in self.sandboxes:
            if (
                getattr(sb, "guards_operation", None) is not None
                and not sb.guards_operation(operation)
            ):
                continue
            if "name" in inspect.signature(sb.validate).parameters:
                resolved = sb.validate(operation, target, name=spec.name)
            else:
                resolved = sb.validate(operation, target)
            if resolved is not None:
                return str(resolved)
        return target


__all__ = ["ALLOW", "DEFAULT_MAX_RESULT_CHARS", "DENY", "ToolPipeline", "ToolResult"]

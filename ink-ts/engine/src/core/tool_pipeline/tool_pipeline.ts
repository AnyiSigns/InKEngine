/**
 * 工具执行流水线（权限门禁 → 沙箱守卫 → 单调守卫 → 分发执行 → 审计 →
 * 结果观察），tool_pipeline.py 移植。机制环节全可注入，缺省 fail-closed。
 *
 * 路径解析前置：gate 判定前复用沙箱 resolve 把 target 解析为沙箱基准下的
 * 绝对路径（ENG6-4 统一两闸基准）并回写 args（判定对象 = 执行对象），字面
 * 量 target 保留为 resolved_pre_target 供字面量规则命中。review 委托挂卡、
 * edit 决议重走校验链（限 1 轮）；调用后审计留痕 + 轨迹回调（参数先脱敏）。
 *
 * TS seam 差异：单调时钟注入 seam（等价 time.monotonic），缺省确定值 0
 * （core 零 IO 可复现）；logging 留痕属可观测性副作用，core 不落；执行体
 * 为注入 seam，缺省未注入 = 未配置执行器拒绝。
 */

import { SandboxViolation } from '../errors.js';
import { isRecord } from '../json.js';
import {
  DECISION_AUTO, DECISION_EDIT, DECISION_REJECT, DECISION_TERMINATE,
  approve_before_execute,
  type ApprovalDecision, type ApprovalInterruptContext, type InterruptPolicy,
} from '../approval/approval.js';
import type { ToolSpec } from '../llm/tools.js';
import { ALLOW as _ALLOW, DENY as _DENY, REVIEW as _REVIEW } from '../permissions/permissions.js';
import { strip_sensitive } from '../security/security.js';
import { ToolTrace } from '../tool_orchestrator/_types.js';
import {
  DEFAULT_MAX_RESULT_CHARS, ToolResult, _substitute_target, isAwaitable,
  sandbox_guarded, sandbox_resolve,
  type AuditSink, type Executor, type Extractor, type FailureReasonHook,
  type GateSeam, type Guard, type SandboxSeam, type TraceSink,
} from './_types.js';

/** 工具执行流水线装配（机制环节全可注入，缺省 = fail-closed 拒绝）。
 *
 * gate: 权限门禁（null = 跳过权限判定，宿主自行取舍）；extractor: 操作
 * 提取器 (spec, args) → (operation, target) | null（null = 纯内存工具无
 * 判定目标直通）；failure_reason: 提取失败原因钩子（原因并入拒绝文案，
 * 指引模型自我纠正）；sandboxes: 沙箱守卫列表；guards: 单调守卫列表；
 * executor: 分发执行器（宿主 seam）；audit: 审计钩子（null = 默认经
 * ctx.emit 发 tool_audit 事件）；max_result_chars: 结果观察截断上限；
 * allow_unchecked: 无判定目标时是否直通（默认 false = 拒绝，宿主明示
 * 安全让步才可放宽）；approval_policy: 审批决议策略（null = 默认全挂起）；
 * trace_sink: 工具轨迹回调（失败只忽略不阻断）；monotonic: 单调时钟 seam。
 */
export class ToolPipeline {
  readonly gate: GateSeam | null;
  readonly extractor: Extractor | null;
  readonly failure_reason: FailureReasonHook | null;
  readonly sandboxes: readonly SandboxSeam[];
  readonly guards: readonly Guard[];
  readonly executor: Executor | null;
  readonly audit: AuditSink | null;
  readonly max_result_chars: number;
  readonly allow_unchecked: boolean;
  readonly approval_policy: InterruptPolicy | null;
  readonly trace_sink: TraceSink | null;
  readonly monotonic: () => number;

  constructor(options: {
    gate?: GateSeam | null;
    extractor?: Extractor | null;
    failure_reason?: FailureReasonHook | null;
    sandboxes?: readonly SandboxSeam[];
    guards?: readonly Guard[];
    executor?: Executor | null;
    audit?: AuditSink | null;
    max_result_chars?: number;
    allow_unchecked?: boolean;
    approval_policy?: InterruptPolicy | null;
    trace_sink?: TraceSink | null;
    monotonic?: (() => number) | null;
  } = {}) {
    this.gate = options.gate ?? null;
    this.extractor = options.extractor ?? null;
    this.failure_reason = options.failure_reason ?? null;
    this.sandboxes = options.sandboxes ?? [];
    this.guards = options.guards ?? [];
    this.executor = options.executor ?? null;
    this.audit = options.audit ?? null;
    this.max_result_chars = options.max_result_chars ?? DEFAULT_MAX_RESULT_CHARS;
    this.allow_unchecked = options.allow_unchecked ?? false;
    this.approval_policy = options.approval_policy ?? null;
    this.trace_sink = options.trace_sink ?? null;
    this.monotonic = options.monotonic ?? (() => 0);
  }

  /** 执行一次工具调用（任一环节拒绝即 fail-closed）；所有返回路径统一经
   *  _finish 收口，保证轨迹记录不遗漏。 */
  async execute(ctx: unknown, spec: ToolSpec, argsIn: Record<string, unknown>): Promise<ToolResult> {
    const started = this.monotonic();
    let args = argsIn;
    // 审计 + 轨迹收口的拒绝路径（镜像 Python 各分支的 audit+_finish 对）
    const deny = async (record: Record<string, unknown>, result: ToolResult): Promise<ToolResult> => {
      await this._audit(ctx, { tool: spec.name, ...record });
      return await this._finish(result, spec, args, started);
    };

    // 未配置操作提取器：无判定目标即无法做权限/沙箱判定——默认拒绝
    // （fail-closed），宿主须显式 allow_unchecked=True 才可直通
    if (this.extractor === null && !this.allow_unchecked) {
      const message = '未配置操作提取器，拒绝执行（fail-closed）';
      return await deny({ decision: 'deny', reason: message }, new ToolResult({ ok: false, decision: _DENY, error: message }));
    }
    let op_target = this.extractor !== null ? this.extractor(spec, args) : null;
    let operation: string | null;
    let target: string | null;
    if (op_target === null) {
      // 提取器已配置但本次调用解析不出判定目标（非法/缺参）：与「未配置
      // 提取器」同语义 fail-closed——无法判定目标就无法做权限/沙箱判定，
      // 绝不直通执行。allow_unchecked 的直通仅对「有意不做判定」生效。
      if (!this.allow_unchecked) {
        let hint = '';
        if (this.failure_reason !== null) {
          let reason: string | null = null;
          try {
            reason = this.failure_reason(spec, args);
          } catch {
            reason = null;
          }
          if (reason) hint = `：${reason}`;
        }
        const message = `操作提取器无法判定目标，拒绝执行（fail-closed）${hint}`;
        return await deny({ decision: 'deny', reason: message }, new ToolResult({ ok: false, decision: _DENY, error: message }));
      }
      operation = null;
      target = null;
    } else {
      operation = op_target[0];
      target = op_target[1];
    }

    // ── 路径解析前置（ENG6-4 统一两闸基准）──
    // 权限门禁与沙箱守卫的判定对象必须一致：相对路径在 gate 规则基准下
    // 无法命中（沙箱基线 = 绝对路径），导致「沙箱接住但 gate 漏过 / gate
    // 接住但沙箱按相对路径拒」的判定漂移。gate 判定前把 target 解析为沙箱
    // 基准下的绝对路径并回写 args；沙箱异常即拒绝（fail-closed）。字面量
    // target 保留为 resolved_pre_target，字面量规则仍可命中。
    let resolved_pre_target: string | null = null;
    if (operation !== null && target !== null) {
      resolved_pre_target = target;
      let resolved: string | null;
      try {
        resolved = this._resolve_target(spec, operation, target);
      } catch (exc) {
        if (!(exc instanceof SandboxViolation)) throw exc;
        return await deny({ operation, decision: 'deny', reason: String(exc) }, new ToolResult({ ok: false, decision: _DENY, error: String(exc) }));
      }
      if (resolved !== null && resolved !== target) {
        args = _substitute_target(args, target, resolved) as Record<string, unknown>;
        target = resolved;
      }
    }

    // ── 调用前策略：权限门禁（review 委托挂卡审批）──
    // edit 决议的编辑内容须重走校验链（宿主编辑可能改写路径/命令，绕过已
    // 校验的沙箱边界）——作为新 args 重提取判定目标并重过门禁，限 1 轮；
    // 解析前后 target 各判一次（任一命中 = ALLOW），字面量规则不因规范化
    // 失配。
    let approval: ApprovalDecision | null = null;
    for (let editRound = 0; editRound < 2; editRound += 1) {
      if (this.gate !== null && operation !== null && target !== null) {
        let verdict = this.gate.check(spec.name, operation, target, { permissions: spec.permissions });
        if (verdict.decision !== _ALLOW) {
          if (verdict.decision !== _REVIEW && resolved_pre_target !== null && resolved_pre_target !== target) {
            // 解析后未命中：尝试原始 target（规则按字面量注册的场景）
            verdict = this.gate.check(spec.name, operation, resolved_pre_target, { permissions: spec.permissions });
          }
        }
        if (verdict.decision === _ALLOW) {
          // pass
        } else if (verdict.decision === _REVIEW) {
          // 审批卡 action 负载脱敏：args 可能含 URL/命令（url 参数可带 query
          // token），凭据不得经审批卡扩散到前端卡面
          approval = await approve_before_execute(
            ctx as ApprovalInterruptContext,
            `gate:${spec.name}`,
            { tool: spec.name, args: strip_sensitive({ ...args }) },
            null,
            this.approval_policy,
          );
          if (approval.decision === DECISION_REJECT || approval.decision === DECISION_TERMINATE) {
            const result = new ToolResult({ ok: false, decision: approval.decision, approval, error: approval.reason || '审批未通过' });
            return await deny({ operation, decision: approval.decision, reason: approval.reason }, result);
          }
          if (approval.decision === DECISION_EDIT) {
            const edited = approval.edited_content;
            if (!isRecord(edited) || editRound >= 1) {
              const reason = 'edit 决议内容无法重新校验（须为参数对象且仅允许一次编辑），拒绝执行';
              return await deny({ operation, decision: 'deny', reason }, new ToolResult({ ok: false, decision: _DENY, approval, error: reason }));
            }
            // 编辑内容作为新参数重走提取器：判定目标可能改变（改写路径/
            // 命令），沙箱守卫必须对编辑后目标生效
            const newArgs = edited as Record<string, unknown>;
            op_target = this.extractor !== null ? this.extractor(spec, newArgs) : null;
            if (op_target === null) {
              const reason = 'edit 决议内容无法提取判定目标，拒绝执行（fail-closed）';
              return await deny({ operation, decision: 'deny', reason }, new ToolResult({ ok: false, decision: _DENY, approval, error: reason }));
            }
            args = newArgs;
            operation = op_target[0];
            target = op_target[1];
            continue; // 重走权限门禁（编辑后目标重新判定）
          }
        } else {
          // DENY 与任何未知 decision：一律拒绝（fail-closed——未知判定值
          // 不得静默落到"继续执行"）
          const reason = verdict.reason || `未命中的权限判定: '${verdict.decision}'`;
          return await deny({ operation, decision: 'deny', reason }, new ToolResult({ ok: false, decision: _DENY, error: verdict.reason || '权限拒绝' }));
        }
      }
      break;
    }

    // ── 沙箱守卫（校验结果回写执行参数：执行对象 = 校验对象）──
    if (operation !== null && target !== null) {
      for (const sb of this.sandboxes) {
        // 操作域过滤：沙箱只守卫自己声明的操作（多端点流水线各司其职）；
        // 定义反查型沙箱（接受 name）按当前调用工具自身端点判定，防跨工具
        // root 泄漏——见 sandbox_guarded/sandbox_resolve 的 name 感知分发
        if (!sandbox_guarded(sb, operation, spec.name)) continue;
        let resolved: string | null;
        try {
          resolved = sandbox_resolve(sb, operation, target, spec.name);
        } catch (exc) {
          if (!(exc instanceof SandboxViolation)) throw exc;
          return await deny({ operation, decision: 'deny', reason: String(exc) }, new ToolResult({ ok: false, decision: _DENY, error: String(exc) }));
        }
        if (resolved !== null && resolved !== target) {
          args = _substitute_target(args, target, resolved) as Record<string, unknown>;
          target = String(resolved);
        }
      }
    }

    // ── 单调守卫（抛异常即拒绝，fail-closed）──
    for (const guard of this.guards) {
      try {
        const result = guard(ctx, spec, args);
        if (isAwaitable(result)) await result;
      } catch (exc) {
        const reason = `守卫拒绝: ${String(exc)}`;
        return await deny({ decision: 'deny', reason }, new ToolResult({ ok: false, decision: _DENY, error: reason }));
      }
    }

    // ── 分发执行（兼容同步/异步执行器；执行体属宿主 seam）──
    if (this.executor === null) {
      return await this._finish(new ToolResult({ ok: false, decision: _DENY, error: '未配置执行器' }), spec, args, started);
    }
    let output: unknown;
    try {
      output = this.executor(ctx, spec, args, approval);
      if (isAwaitable(output)) output = await output;
    } catch (exc) {
      return await deny({ decision: 'error', error: String(exc) }, new ToolResult({ ok: false, decision: 'error', error: String(exc) }));
    }

    // ── 调用后：审计留痕 + 结果观察（截断/溢出标记）──
    let text = output !== null && output !== undefined ? String(output) : '';
    if (approval !== null && approval.decision === DECISION_AUTO) {
      // 审批语义可观测：策略直过（auto）前缀标注——模型不把「已放行的执行」
      // 误判为 interrupted 重试
      text = `【已自动批准执行】${text}`;
    }
    const overflow = text.length > this.max_result_chars;
    const truncated = text.slice(0, this.max_result_chars) + (overflow ? '\n…（溢出截断）' : '');
    await this._audit(ctx, { tool: spec.name, decision: 'ok', overflow });
    return await this._finish(new ToolResult({ ok: true, decision: _ALLOW, output: truncated, overflow, approval }), spec, args, started);
  }

  /** 出口统一收口：轨迹回调（成败/决议/耗时/错误）。回调失败只忽略不阻断
   *  （观测不阻断执行）。 */
  private async _finish(
    result: ToolResult,
    spec: ToolSpec,
    args: Record<string, unknown>,
    started: number,
  ): Promise<ToolResult> {
    if (this.trace_sink === null) return result;
    try {
      const outcome = this.trace_sink(
        new ToolTrace({
          tool: spec.name,
          ok: result.ok,
          decision: result.decision,
          // 轨迹落库前对参数脱敏：凭据类参数不得随轨迹持久化留存
          args: strip_sensitive({ ...args }),
          error: result.error,
          duration_ms: (this.monotonic() - started) * 1000.0,
        }),
      );
      if (isAwaitable(outcome)) await outcome;
    } catch {
      // Python 侧仅记 warning 日志（可观测性副作用）；TS core 零日志，
      // 回调失败只忽略
    }
    return result;
  }

  async _audit(ctx: unknown, record: Record<string, unknown>): Promise<void> {
    if (this.audit !== null) {
      const result = this.audit(ctx, record);
      if (isAwaitable(result)) await result;
      return;
    }
    const ctxEmit = ctx as { emit?: (etype: string, payload: Record<string, unknown>) => unknown };
    if (typeof ctxEmit.emit === 'function') {
      // 成员式调用保留 this 绑定（宿主 emit 依赖实例状态时不可拆出裸调用）
      await ctxEmit.emit('tool_audit', record);
    }
  }

  /** 复用沙箱 resolve 逻辑预解析 target（ENG6-4 统一两闸基准）。
   *
   * 任一沙箱能解析（validate 返回非 null）= 取首个解析结果作为「绝对基准」
   * target；全部沙箱都不解析（null 或未声明守卫域）= 返回原 target。沙箱抛
   * SandboxViolation 由调用方收口（拒绝），不在此吞。
   */
  private _resolve_target(spec: ToolSpec, operation: string, target: string): string | null {
    for (const sb of this.sandboxes) {
      if (!sandbox_guarded(sb, operation, spec.name)) continue;
      const resolved = sandbox_resolve(sb, operation, target, spec.name);
      if (resolved !== null) return String(resolved);
    }
    return target;
  }
}

// ── 导出面（镜像 Python __all__；REVIEW 为公开名，与 Python 模块同）──
export {
  ALLOW,
  DEFAULT_MAX_RESULT_CHARS,
  DENY,
  REVIEW,
  ToolResult,
} from './_types.js';
export type {
  AuditSink,
  Executor,
  Extractor,
  FailureReasonHook,
  GateSeam,
  Guard,
  SandboxSeam,
  TraceSink,
} from './_types.js';
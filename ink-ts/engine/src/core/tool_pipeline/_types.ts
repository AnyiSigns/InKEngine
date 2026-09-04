/**
 * 工具执行流水线的数据形态与注入 seam（tool_pipeline.py 移植的数据面）。
 *
 * 流水线把工具调用的机制环节规范化装配，宿主无需重写：
 * - 调用前策略：PermissionGate 判定（fail-closed）；需审批（review）委托
 *   approve_before_execute 挂 gate 卡（PermissionGate 自身不挂起）；
 * - 沙箱守卫：沙箱的 validate(operation, target)（鸭子类型 seam，本文件
 *   只声明形状，FileSandbox/ProcessSandbox 由宿主或后续模块满足）；
 * - 单调守卫：可注入守卫钩子（同一动作重复执行保护等），抛异常即拒绝；
 * - 分发执行：executor 钩子（宿主工具实现；也可传内置执行器）——执行体
 *   属宿主注入面，core 不实现真实工具，缺省不注入；
 * - 调用后策略：审计留痕（operation/decision/result 事件或宿主钩子）；
 * - 结果观察：输出截断 + 溢出标记（全量内容由宿主按需存 locator 取回）。
 *
 * 操作提取（operation extractor）：工具参数语义由宿主声明——
 * extractor(spec, args) 返回 (operation, target)（如 ("write", "/book/ch1.md")
 * / ("exec", "git")），null = 无权限/沙箱判定目标（纯内存工具直通）。
 *
 * name 感知形参（接受 name= 的沙箱）：Python 侧以 inspect.signature 静态
 * 判定；TS 侧运行时只能拿到函数形参个数——以声明形参是否多于最少位判定
 * （acceptsName）：guards_operation 多于 1 位、validate 多于 2 位即视为
 * 接受 name。宿主实现 name 感知沙箱时须显式声明第三形参（含默认值占位
 * 会使 .length 少计，等同不接受 name）。
 */

import { isRecord } from '../json.js';
import type { ApprovalDecision } from '../approval/approval_types.js';
import type { InterruptPolicy } from '../approval/approval_types.js';
import type { ToolSpec } from '../llm/tools.js';
import { ALLOW, DENY, REVIEW } from '../permissions/permissions.js';
import type { GateResult } from '../permissions/permissions.js';
import type { ToolTrace } from '../tool_orchestrator/_types.js';

export { ALLOW, DENY, REVIEW };

// 工具结果文本截断上限（ENG6-6：100_000 魔法数字共享常量——引擎工具
// 流水线默认值；声明式工具流水线/自指工具/内省工具同源引用，防多份
// 拷贝漂移）
export const DEFAULT_MAX_RESULT_CHARS = 100_000;

/** Python inspect.isawaitable 的镜像（同步/异步钩子兼容判定）。 */
export function isAwaitable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** name 位形参感知判定（见文件头注释；min = 含 name 位的最小形参个数）。
 *  按 unknown 接收（运行时 .length 探测，不作可调用性约束）。 */
export function acceptsName(fn: unknown, min: number): boolean {
  return typeof fn === 'function' && (fn as (...args: unknown[]) => unknown).length > min;
}

/** 权限门禁 seam（鸭子类型；PermissionGate 满足该形状）。 */
export interface GateSeam {
  check(
    tool: string,
    operation: string,
    target: string,
    options?: { permissions?: readonly string[] },
  ): GateResult;
}

/** 操作提取器 seam：(spec, args) → (operation, target) | null。 */
export type Extractor = (spec: ToolSpec, args: Record<string, unknown>) => [string, string] | null;

/** 提取失败原因钩子 seam：(spec, args) → 原因文案 | null（指引模型自我纠正）。 */
export type FailureReasonHook = (
  spec: ToolSpec,
  args: Record<string, unknown>,
) => string | null;

/** 沙箱守卫 seam（鸭子类型）：validate 返回解析后的绝对路径/命令（null =
 *  不解析）；guards_operation 声明守卫域（未声明 = 全量判定，旧语义）。 */
export interface SandboxSeam {
  guards_operation?(operation: string, name?: string): boolean;
  validate(operation: string, target: string, name?: string): string | null;
}

/** 操作域过滤 + name 透传（对齐 Python inspect.signature 分支）：未声明
 *  guards_operation = 全量判定（返回 true）；声明即按其结果过滤。成员式
 *  调用保留 this 绑定（宿主沙箱依赖实例状态时不可拆出裸调用）。 */
export function sandbox_guarded(sb: SandboxSeam, operation: string, name: string): boolean {
  if (typeof sb.guards_operation !== 'function') return true;
  if (acceptsName(sb.guards_operation, 1)) return sb.guards_operation(operation, name);
  return sb.guards_operation(operation);
}

/** 沙箱 validate 分发（name 感知分支）：返回解析后的绝对路径/命令（null =
 *  不解析）；沙箱抛 SandboxViolation 由调用方收口。成员式调用保留 this。 */
export function sandbox_resolve(
  sb: SandboxSeam,
  operation: string,
  target: string,
  name: string,
): string | null {
  if (acceptsName(sb.validate, 2)) return sb.validate(operation, target, name);
  return sb.validate(operation, target);
}

/** 单调守卫 seam：抛异常即拒绝（fail-closed）。 */
export type Guard = (
  ctx: unknown,
  spec: ToolSpec,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** 分发执行器 seam（宿主工具实现/内置执行器）：输出转字符串为结果文本。 */
export type Executor = (
  ctx: unknown,
  spec: ToolSpec,
  args: Record<string, unknown>,
  approval: ApprovalDecision | null,
) => unknown | Promise<unknown>;

/** 审计钩子 seam：None = 默认经 ctx.emit 发 tool_audit 事件。 */
export type AuditSink = (
  ctx: unknown,
  record: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** 工具轨迹回调 seam（经验闭环的信号出口）；回调失败只忽略不阻断主流程
 *  （观测不阻断执行；core 零日志，Python 侧 warning 留痕不移植）。 */
export type TraceSink = (trace: ToolTrace) => unknown | Promise<unknown>;

/** 递归替换 args 中与原始 target 相等的值 → 沙箱解析结果。
 *
 * 执行对象与校验对象一致：extractor 从 args 提取 target 判定的路径，
 * 分发执行前替换为规范化绝对路径（防二次拼接/相对基准漂移引入逃逸）。
 */
export function _substitute_target(
  value: unknown,
  target: string,
  resolved: string,
): unknown {
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = _substitute_target(item, target, resolved);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => _substitute_target(item, target, resolved));
  }
  if (value === target) return resolved;
  return value;
}

/** 单次工具调用的执行结果（宿主按 decision/ok 分发）。
 *
 * ok: 是否成功执行（True = 已执行；False = 拒绝/审批未过/执行出错）；
 * decision: allow（已执行）/ deny（拒绝）/ accept/terminate（审批决议）/
 *   error（执行异常）；
 * output: 截断后的结果文本（结果观察）；
 * overflow: 结果是否超限截断（全量可由宿主存 locator 取回）；
 * approval: 审批决议透传（edit 的 edited_content 供执行器使用）；
 * error: 拒绝/出错原因。
 */
export class ToolResult {
  readonly ok: boolean;
  readonly decision: string;
  readonly output: string;
  readonly overflow: boolean;
  readonly approval: ApprovalDecision | null;
  readonly error: string | null;

  constructor(options: {
    ok: boolean;
    decision?: string;
    output?: string;
    overflow?: boolean;
    approval?: ApprovalDecision | null;
    error?: string | null;
  }) {
    this.ok = options.ok;
    this.decision = options.decision ?? ALLOW;
    this.output = options.output ?? '';
    this.overflow = options.overflow ?? false;
    this.approval = options.approval ?? null;
    this.error = options.error ?? null;
  }
}
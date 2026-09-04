/**
 * 工具调用前挂卡审批的标准辅助（approval.py 移植）——审批唯一性原则的
 * 「唯一标准姿势」：宿主不得另写"工具调用前挂卡"实现，本模块提供机制化
 * 封装：
 *
 * - approve_before_execute：单动作挂卡——interrupt 挂起 gate 卡 → 注入决议
 *   （accept/edit/reject/terminate）→ 返回决议，宿主按决议执行/跳过/终止；
 * - approve_batch：同回合多写操作聚合一张卡（合并卡，仍是 gate 卡形态）；
 * - DefaultInterruptPolicy：默认决议策略（全量挂起 + 可选直过名单 + 可选
 *   统一超时窗口；不配置 = 全挂起、不限时——最保守 fail-closed）。
 *
 * 机制定在 core、语义归属审批卡协议（review_card 四类卡）——不绑领域语义、
 * 跨域共用；挂起/重入走引擎 interrupt 原语（ApprovalInterruptContext seam），
 * 本模块不引入第二套挂起语义。gate 卡形态统一由 build_gate_card 构造，宿主
 * 只提供动作描述与 payload 数据，不在发卡点手工拼卡。
 *
 * 超时默认拒绝：policy.timeout_for 给出审批窗口（null = 不限时，默认），
 * 挂起负载写入 expires_at（epoch 秒）；重入时已过期 → 一律返回 reject
 * （source=expired）——fail-closed 兜底，防"超时后补批"绕过。重入读回已挂
 * 卡的 expires_at（随中断 checkpoint 持久化）才是超时判定权威时钟——重算
 * （now+timeout）会让超时默认拒绝永不触发（重入时 now 恒小于重算值）；若
 * 卡负载缺 expires_at 且无法判定超时窗口 = 无法证明未超时，宁拒勿放。
 *
 * TS seam 差异：clock 为注入时间源（等价 Python time.time）；core 纯函数
 * 零 IO，未注入时按确定值 0 走（镜像 ledger 的 now 缺省），超时判定依赖
 * 宿主注入真实时钟。logging 留痕属可观测性副作用，core 不落。
 */

import { isRecord } from '../json.js';
import { build_gate_card } from '../review_card/reviewCard.js';
import type { CardPayload } from '../review_card/reviewCard_types.js';
import {
  ApprovalDecision,
  DECISION_AUTO,
  DECISION_EDIT,
  DECISION_REJECT,
  VALID_DECISION_SET,
} from './approval_types.js';
import type { ApprovalInterruptContext, InterruptPolicy } from './approval_types.js';

export {
  ApprovalDecision,
  DECISION_ACCEPT,
  DECISION_AUTO,
  DECISION_EDIT,
  DECISION_REJECT,
  DECISION_TERMINATE,
  VALID_DECISIONS,
} from './approval_types.js';
export type { ApprovalInterruptContext, InterruptPolicy } from './approval_types.js';

/** 时钟注入选项（等价 Python 的 keyword-only clock 参数）。 */
export interface ApprovalOptions {
  /** 时间源（等价 time.time）；缺省按确定值 0 保证纯函数可复现。 */
  clock?: (() => number) | null;
}

/** 取注入 dict 的 reason 字段（Python dict.get 口径：缺失/空值归 null，
 *  原值透传不强制字符串——注入什么形状就保留什么形状）。 */
function reasonOf(injected: { [key: string]: unknown }): string | null {
  const reason = injected['reason'];
  if (reason === undefined || reason === null) return null;
  return reason as string;
}

/** Python repr() 口径渲染（错误消息携带注入值形态；字符串带引号）。 */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const record = value as { [key: string]: unknown };
    const parts = Object.keys(record).map((key) => `${pyRepr(key)}: ${pyRepr(record[key])}`);
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/**
 * 默认决议策略：全量挂起 + 可选直过名单（key/工具集）+ 可选统一超时窗口。
 * 默认值由宿主构造时配置；不配置 = 全挂起、不限时（最保守 fail-closed）。
 */
export class DefaultInterruptPolicy {
  readonly auto_approve_keys: ReadonlySet<string>;
  readonly auto_approve_tools: ReadonlySet<string>;
  readonly timeout: number | null;

  constructor(
    auto_approve_keys: ReadonlySet<string> = new Set<string>(),
    auto_approve_tools: ReadonlySet<string> = new Set<string>(),
    timeout: number | null = null,
  ) {
    this.auto_approve_keys = auto_approve_keys;
    this.auto_approve_tools = auto_approve_tools;
    this.timeout = timeout;
  }

  should_approve(key: string, action: Record<string, unknown>): boolean {
    if (this.auto_approve_keys.has(key)) return false;
    const tool = action['tool'];
    return !(typeof tool === 'string' && this.auto_approve_tools.has(tool));
  }

  timeout_for(): number | null {
    return this.timeout;
  }
}

/** 注入值解析结果（单动作与合并卡共用；内容清单按决议对齐）。 */
interface ResolvedInjection {
  decision: string;
  contents: unknown[] | null;
  reason: string | null;
  source: string;
}

/**
 * 注入值 → (decision, contents, reason, source)（单动作与合并卡共用）。
 *
 * batch_count=null = 单动作（edit 需 edited_content 单值）；batch_count=N =
 * 合并卡（edit 需 edited_contents 列表对齐 N）。超时/非法注入一律回落
 * reject（fail-closed）。
 */
function resolve_decision(
  injected: unknown,
  now: number,
  card: { [key: string]: unknown },
  batch_count: number | null,
): ResolvedInjection {
  const expires_at = card['expires_at'];
  if (typeof expires_at === 'number' && now > expires_at) {
    return {
      decision: DECISION_REJECT,
      contents: null,
      reason: '审批已超时，默认拒绝',
      source: 'expired',
    };
  }
  if (typeof injected === 'string') {
    // 字符串形态与 dict 形态同口径：auto 属策略直过来源，外部注入不得以
    // 字符串 "auto" 伪装直过（dict 分支已拒绝，此处对齐）
    if (!VALID_DECISION_SET.has(injected) || injected === DECISION_EDIT || injected === DECISION_AUTO) {
      return {
        decision: DECISION_REJECT,
        contents: null,
        reason: `注入值非法: ${pyRepr(injected)}`,
        source: 'invalid',
      };
    }
    return { decision: injected, contents: null, reason: null, source: 'inject' };
  }
  if (isRecord(injected)) {
    const decision = injected['decision'];
    if (
      typeof decision !== 'string'
      || !VALID_DECISION_SET.has(decision)
      || decision === DECISION_AUTO
    ) {
      return {
        decision: DECISION_REJECT,
        contents: null,
        reason: `注入值非法: ${pyRepr(injected)}`,
        source: 'invalid',
      };
    }
    if (decision === DECISION_EDIT) {
      if (batch_count === null) {
        if (!('edited_content' in injected)) {
          return {
            decision: DECISION_REJECT,
            contents: null,
            reason: 'edit 决议需 edited_content',
            source: 'invalid',
          };
        }
        return {
          decision,
          contents: [injected['edited_content']],
          reason: reasonOf(injected),
          source: 'inject',
        };
      }
      const contents = injected['edited_contents'];
      if (!Array.isArray(contents) || contents.length !== batch_count) {
        return {
          decision: DECISION_REJECT,
          contents: null,
          reason: 'edit 决议需 edited_contents 与动作数对齐',
          source: 'invalid',
        };
      }
      return { decision, contents, reason: reasonOf(injected), source: 'inject' };
    }
    return { decision, contents: null, reason: reasonOf(injected), source: 'inject' };
  }
  return {
    decision: DECISION_REJECT,
    contents: null,
    reason: `注入值非法: ${pyRepr(injected)}`,
    source: 'invalid',
  };
}

/** 重入读回已挂卡负载，解析持久化的 expires_at（随中断 checkpoint 落盘）。 */
async function readSavedExpiry(
  ctx: ApprovalInterruptContext,
  key: string,
): Promise<{ saved: unknown; saved_expires: unknown }> {
  if (typeof ctx.get_interrupt_payload !== 'function') return { saved: null, saved_expires: null };
  // 成员式调用保留 this 绑定（宿主实现依赖实例状态时不可拆出裸调用）
  const saved = await ctx.get_interrupt_payload(key);
  if (isRecord(saved)) {
    return { saved, saved_expires: saved['expires_at'] ?? null };
  }
  return { saved, saved_expires: null };
}

/**
 * 单动作挂卡审批的标准姿势（gate 卡包装，宿主按决议执行/跳过/终止）。
 *
 * @param ctx 节点上下文（interrupt 原语入口，鸭子类型）。
 * @param key 中断点 key（与注入值对齐；同回合多动作请用 approve_batch）。
 * @param action 动作描述（{tool, args, summary, diff, ...}——渲染与策略
 *   分级判定用，宿主自定形态）。
 * @param payload gate 卡负载（宿主构造；缺省从 action 生成最小卡）。
 * @param policy 决议策略钩子（默认 DefaultInterruptPolicy()：全挂起、不限时）。
 * @param options.clock 时钟注入（默认确定值 0；测试可控，用于超时判定）。
 * @returns 宿主按决议执行（accept/edit）/ 跳过（reject）/ 终止（terminate）/
 *   直过（auto，source=policy）。
 */
export async function approve_before_execute(
  ctx: ApprovalInterruptContext,
  key: string,
  action: Record<string, unknown>,
  payload: Record<string, unknown> | null = null,
  policy: InterruptPolicy | null = null,
  options: ApprovalOptions = {},
): Promise<ApprovalDecision> {
  const activePolicy = policy ?? new DefaultInterruptPolicy();
  const clock = options.clock ?? (() => 0);
  if (!activePolicy.should_approve(key, action)) {
    return new ApprovalDecision(DECISION_AUTO, action, null, null, 'policy');
  }
  const card = build_gate_card(action, { payload: payload ?? null });
  const timeout = activePolicy.timeout_for(key, action);
  const { saved, saved_expires } = await readSavedExpiry(ctx, key);
  if (saved_expires !== null) {
    card['expires_at'] = saved_expires;
  } else if (timeout !== null) {
    // 重入但卡负载缺超时字段（宿主持久化的卡没有 expires_at，或卡形态
    // 异常）：无法判定超时窗口 = 无法证明未超时——fail-closed 拒绝（宁拒
    // 勿放）。首次挂起（saved=None）才允许按策略写入新的 expires_at。
    if (isRecord(saved)) {
      return new ApprovalDecision(
        DECISION_REJECT,
        action,
        null,
        '审批卡负载缺 expires_at（无法判定超时窗口），fail-closed 拒绝',
        'invalid',
      );
    }
    card['expires_at'] = clock() + timeout;
  }
  const injected = await ctx.interrupt(key, card);
  const resolved = resolve_decision(injected, clock(), card, null);
  return new ApprovalDecision(
    resolved.decision,
    action,
    resolved.contents ? (resolved.contents[0] ?? null) : null,
    resolved.reason,
    resolved.source,
  );
}

/**
 * 同回合多写操作聚合一张卡（合并卡，仍是 gate 卡形态，宿主可选）。
 *
 * 单次挂起（key 一次）；任一动作需审批 → 整批挂起，注入一个决议作用于
 * 全部动作（混合直过/挂起由宿主策略层保证 tool 判定一致性）：
 * - accept：全部执行；
 * - edit：注入 edited_contents（列表，与 actions 对齐）逐条替换；
 * - reject / terminate：全部跳过 / 宿主终止；
 * - 全部 auto（策略直过）：整批不挂起，逐条返回 auto。
 */
export async function approve_batch(
  ctx: ApprovalInterruptContext,
  key: string,
  actions: readonly Record<string, unknown>[],
  payload: Record<string, unknown> | null = null,
  policy: InterruptPolicy | null = null,
  options: ApprovalOptions = {},
): Promise<ApprovalDecision[]> {
  const activePolicy = policy ?? new DefaultInterruptPolicy();
  const clock = options.clock ?? (() => 0);
  if (!actions.some((action) => activePolicy.should_approve(key, action))) {
    return actions.map((action) => new ApprovalDecision(DECISION_AUTO, action, null, null, 'policy'));
  }
  const card: CardPayload = build_gate_card(undefined, { actions, payload: payload ?? null });
  const timeouts = actions.map((action) => activePolicy.timeout_for(key, action));
  const finiteTimeouts = timeouts.filter((t): t is number => t !== null);
  const shortest = finiteTimeouts.length > 0 ? Math.min(...finiteTimeouts) : null;
  const { saved, saved_expires } = await readSavedExpiry(ctx, key);
  if (saved_expires !== null) {
    card['expires_at'] = saved_expires;
  } else if (shortest !== null) {
    // 与 approve_before_execute 同语义：卡负载缺超时字段 = 无法判定窗口，
    // fail-closed 拒绝；仅首次挂起（saved=None）允许写入新窗口。
    if (isRecord(saved)) {
      return actions.map(
        (action) =>
          new ApprovalDecision(
            DECISION_REJECT,
            action,
            null,
            '审批卡负载缺 expires_at（无法判定超时窗口），fail-closed 拒绝',
            'invalid',
          ),
      );
    }
    card['expires_at'] = clock() + shortest;
  }
  const injected = await ctx.interrupt(key, card);
  const resolved = resolve_decision(injected, clock(), card, actions.length);
  return actions.map((action, index) => {
    const edited = resolved.contents ? (resolved.contents[index] ?? null) : null;
    return new ApprovalDecision(resolved.decision, action, edited, resolved.reason, resolved.source);
  });
}

/**
 * 工具调用前挂卡审批的域数据形态：决议集合常量、决议结果容器与策略/上下文
 * 接口（approval.py 移植的数据面）。
 *
 * 审批决议集合（VALID_DECISIONS）为机制固有——审批协议决议语义（注入值校验
 * + fail-closed 兜底方向绑定），新增决议须在此登记：
 * - accept：按原动作执行；
 * - edit：用 edited_content 替换后执行（注入须带 edited_content）；
 * - reject：跳过执行（fail-closed 默认方向）；
 * - terminate：宿主终止本轮；
 * - auto：策略直过（should_approve=False，不挂起，来源=policy，注入无效）。
 *
 * ApprovalInterruptContext 是本模块消费的节点上下文 seam 子集（鸭子类型，
 * graph 引擎移植后由节点 ctx 满足）——挂起走引擎 interrupt 原语，本模块
 * 不引入第二套挂起语义；get_interrupt_payload 用于重入读回已挂卡超时窗口
 * （随中断 checkpoint 持久化的 expires_at 才是超时判定的权威时钟）。
 */

/** 决议：按原动作执行。 */
export const DECISION_ACCEPT = 'accept';

/** 决议：用 edited_content 替换后执行。 */
export const DECISION_EDIT = 'edit';

/** 决议：跳过执行（fail-closed 默认方向）。 */
export const DECISION_REJECT = 'reject';

/** 决议：宿主终止本轮。 */
export const DECISION_TERMINATE = 'terminate';

/** 决议：策略直过（非注入决议，注入无效——防伪装直过绕过审批）。 */
export const DECISION_AUTO = 'auto';

/** 全部合法决议取值（审批决议集合，按声明顺序）。 */
export const VALID_DECISIONS: readonly string[] = [
  DECISION_ACCEPT,
  DECISION_EDIT,
  DECISION_REJECT,
  DECISION_TERMINATE,
  DECISION_AUTO,
];

/** 决议取值白名单（注入值合法性判定用；O(1) 命中）。 */
export const VALID_DECISION_SET: ReadonlySet<string> = new Set<string>(VALID_DECISIONS);

/**
 * 单动作的审批决议（宿主按决议执行/跳过/终止）。
 *
 * decision: accept / edit / reject / terminate / auto；
 * action: 对应动作（approve_batch 时逐条对应）；
 * edited_content: edit 决议的替换内容（注入透传；其余决议为 null）；
 * reason: reject/terminate 的原因（注入透传或超时/非法标记）；
 * source: 决议来源（policy=策略直过 / inject=注入 / expired=超时默认拒绝
 *   / invalid=注入值非法 fail-closed）。
 */
export class ApprovalDecision {
  readonly decision: string;
  readonly action: Record<string, unknown>;
  readonly edited_content: unknown;
  readonly reason: string | null;
  readonly source: string;

  constructor(
    decision: string,
    action: Record<string, unknown>,
    edited_content: unknown = null,
    reason: string | null = null,
    source = 'inject',
  ) {
    this.decision = decision;
    this.action = action;
    this.edited_content = edited_content;
    this.reason = reason;
    this.source = source;
  }
}

/**
 * 决议策略钩子（可替换；默认实现见 DefaultInterruptPolicy）。
 * 宿主按需定制：auto-approve 开关、按工具/卡类型放行、超时窗口。
 */
export interface InterruptPolicy {
  /** 是否需挂起审批；False = 直过（决议 auto，不挂起）。 */
  should_approve(key: string, action: Record<string, unknown>): boolean;
  /** 审批超时秒数（null = 不限时）；挂起负载据此写 expires_at。 */
  timeout_for(key: string, action: Record<string, unknown>): number | null;
}

/**
 * 节点上下文 interrupt seam 子集（鸭子类型）：挂起/重入走引擎 interrupt
 * 原语，本模块只消费这两个成员；graph 模块移植后由节点 ctx 满足该形状。
 */
export interface ApprovalInterruptContext {
  /** 声明中断点：挂起负载随 checkpoint 持久化；重入有注入值则返回注入值。 */
  interrupt(key: string, payload: Record<string, unknown>): unknown | Promise<unknown>;
  /** 读回中断点已挂卡负载（可选；用于重入时读取持久化的 expires_at）。 */
  get_interrupt_payload?(key: string): unknown | Promise<unknown>;
}

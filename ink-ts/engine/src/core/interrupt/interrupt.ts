/**
 * interrupt 挂起/注入重入机制的纯逻辑面（interrupt.py 移植）——弹卡审批
 * 一等能力。语义（节点边界 + 重入幂等）：
 *
 * - 节点内 ``await ctx.interrupt(key, payload)`` 声明中断点——首次执行时
 *   引擎捕获 InterruptSignal，持久化 checkpoint（含中断点状态），本轮
 *   挂起；
 * - 外部注入（review_action 值）后从该节点重入：interrupt() 返回注入值，
 *   节点按状态通道分支执行剩余逻辑；
 * - 不做「节点内任意点」中断（需保存协程剩余逻辑，复杂无必要）；
 * - 挂起卡保留：中断点状态随 checkpoint 持久化，执行中新消息打断时审批卡
 *   不丢弃（打断重定向语义）。
 *
 * 本文件承载：中断键基底运算（interrupt_base_key）、宽容判定
 * （interrupt_key_matches）与注入协调状态机（InterruptCoordinator）——
 * 注入值挂载/一次性消费、重入命中判定、gate 发卡键的 (thread, base) 单调
 * 计数与回合边界复位。数据形态（InterruptSignal / InterruptState / 键常量）
 * 见 interrupt_types.ts；本文件合并导出即 Python 模块的公共面（__all__）。
 *
 * 纯函数边界：协调器为纯内存实例态状态机（无全局状态、零 IO）；checkpoint
 * 持久化/恢复由引擎（executor/graph/storage）接线，本模块不感知存储。
 */
import { InterruptError } from '../errors.js';
import {
  FINGERPRINT_SEP,
  GATE_KEY_PREFIX,
  InterruptSignal,
  InterruptState,
} from './interrupt_types.js';

export { FINGERPRINT_SEP, GATE_KEY_PREFIX, InterruptSignal, InterruptState } from './interrupt_types.js';

/**
 * 中断键基底（剥离调用级唯一指纹后缀；无后缀 = 原键）。
 * 对齐 Python str.partition('#'): 只切首个分隔符之前的段。
 */
export function interrupt_base_key(key: string): string {
  const index = key.indexOf(FINGERPRINT_SEP);
  return index === -1 ? key : key.slice(0, index);
}

/**
 * 中断键是否命中判定面键（宽容匹配：相等或 gate 基底的 ``base#N`` 前缀命中）。
 *
 * gate 审批的卡身份键（``base#N``）与判定面键（``base``）属同一中断：
 * 注入消费/挂起负载读取以基底命中，保证「第二次审批的新卡决议只命中对应
 * 中断」且重入（按卡键注入）仍能被同一中断点消费。非 gate 键只做相等判定
 * （其余中断键本身已是调用级或同类合并语义，无指纹维度）。
 */
export function interrupt_key_matches(interrupt_key: string, review_key: string): boolean {
  if (interrupt_key === review_key) return true;
  if (!review_key.startsWith(GATE_KEY_PREFIX)) return false;
  return interrupt_key.startsWith(review_key + FINGERPRINT_SEP);
}

/**
 * 中断协调器（执行器内部持有）：注入值挂载 + 重入判定 + gate 发卡键计数。
 *
 * 注入语义：inject 后写入 pending_inject，节点内下一次 interrupt() 调用消费
 * 该值（一次性）。已注入决策的审批视为放弃（防门控绕过）。
 *
 * gate 审批的调用级唯一指纹按 (thread, base) 发卡计数：next_gate_key 在每次
 * 真正发卡（无注入可消费 = 新中断）时推进序号；首次保持原键，之后返回
 * ``base#N``。已消费（注入命中）不推进——同一次中断的决议注入与重入消费
 * 保持同一键。新回合入口（用户消息 → 无 resume_from）由引擎调用
 * reset_thread_gate_count 复位计数，指纹作用域 = 回合内。
 */
export class InterruptCoordinator {
  /** 待消费注入值（键 → 注入值）。公开字段对齐 Python dataclass。 */
  readonly pending_inject: Map<string, unknown>;

  /** (thread → base → 发卡计数) 的单调计数表。 */
  private readonly gateIssueCount: Map<string, Map<string, number>>;

  constructor() {
    this.pending_inject = new Map<string, unknown>();
    this.gateIssueCount = new Map<string, Map<string, number>>();
  }

  /** 批量挂载注入值（已存在的键覆盖；新键按序追加，对齐 dict.update）。 */
  inject(values: { [key: string]: unknown }): void {
    for (const [key, value] of Object.entries(values)) {
      this.pending_inject.set(key, value);
    }
  }

  /** 消费键的注入值（一次性弹出）；键无注入值抛 InterruptError。 */
  consume(key: string): unknown {
    if (!this.pending_inject.has(key)) {
      throw new InterruptError(`中断点无注入值: ${key}`);
    }
    const value = this.pending_inject.get(key);
    this.pending_inject.delete(key);
    return value;
  }

  /** 是否有待消费注入值。 */
  has_inject(key: string): boolean {
    return this.pending_inject.has(key);
  }

  /**
   * 按判定面键消费注入（宽容匹配 base / base#N）。
   *
   * gate 审批重入时节点以基底键调用 interrupt()，注入值可能挂在带指纹后缀
   * 的卡键（``base#N``）上——先精确命中基底，再按插入序前缀命中指纹键
   * （同一次中断的决议只挂一个键，命中即消费）。返回消费值；无注入返回
   * null（调用方按新中断处理）。
   */
  consume_review(review_key: string): unknown | null {
    if (this.has_inject(review_key)) {
      return this.consume(review_key);
    }
    if (!review_key.startsWith(GATE_KEY_PREFIX)) {
      return null;
    }
    for (const candidate of [...this.pending_inject.keys()]) {
      if (interrupt_key_matches(candidate, review_key)) {
        return this.consume(candidate);
      }
    }
    return null;
  }

  /**
   * gate 命名空间新中断的发卡键（首次 = 原键，之后掺入序号）。
   *
   * 每次真正发卡推进 (thread, base) 计数；消费/重入不经过本方法（同一次
   * 中断保持同一键），第二次起同工具审批产生 ``base#N``。非 gate 键原样
   * 返回且不计数（其余中断键本身已是调用级语义，不掺指纹）。
   */
  next_gate_key(thread_id: string, base_key: string): string {
    if (!base_key.startsWith(GATE_KEY_PREFIX)) {
      return base_key;
    }
    let byBase = this.gateIssueCount.get(thread_id);
    if (byBase === undefined) {
      byBase = new Map<string, number>();
      this.gateIssueCount.set(thread_id, byBase);
    }
    const count = (byBase.get(base_key) ?? 0) + 1;
    byBase.set(base_key, count);
    if (count <= 1) return base_key;
    return `${base_key}${FINGERPRINT_SEP}${count}`;
  }

  /** 新回合入口复位该线程的 gate 发卡计数（同回合同工具二次审批仍产新键）。 */
  reset_thread_gate_count(thread_id: string): void {
    this.gateIssueCount.delete(thread_id);
  }
}

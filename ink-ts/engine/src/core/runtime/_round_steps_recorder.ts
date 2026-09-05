/**
 * 回合步骤记录器（引擎自接线：订阅现有 EngineEvent/transport 载荷）。
 *
 * Runtime 装配默认把本记录器挂进 RunOptions.transports（与 growth/实体
 * 演化同流观察）：回合内节点/事件流逐条落地为「回合步骤」的内存记录，
 * 供运行时查询（runtime.round_steps(thread)）与未来前端订阅。
 *
 * 设计取舍（不重造 round_steps 语义）：core/round_steps 的 RoundSteps 是
 * 宿主/UI 流映射器按 step 语义逐个调用（thinking/plan/tool/node 分段累积
 * 的类内方法），不是可由「任意 EngineEvent 载荷」直接驱动的订阅件——把
 * 引擎事件流自动映射成 UI 步骤语义会把壳侧 steps.rs 的语义映射搬进 core。
 * 因此本记录器在 runtime 侧做轻量记录，**复用 round_steps 的公开形态**
 * （StepRecord = {step_id, type, payload}），不改字段语义：
 * - 只收回合步骤事件（step_id 非空；系统信号/机制事件 step_id=null =
 *   不入回合步骤序列——事件协议对 system_events 的既有语义）；
 * - step_id/type/payload 事件原样投影（不发明新事件名，事件名/载荷不动，
 *   避免与 event_types 漂移）。
 *
 * 状态：内存、thread 隔离、有界——每线程保留最近 N 步（回合边界 = 事件
 * round_id 变化即开新回合缓冲，旧回合丢弃）。零 IO、确定性可测。
 */

import type { EngineEvent, EngineTransport } from '../events/events.js';
import type { JsonRecord } from '../json.js';
import type { StepRecord } from '../round_steps/index.js';

/** 每线程保留的回合步骤上限（防无限膨胀；默认 50）。 */
export const DEFAULT_STEP_LIMIT = 50;

/** 线程缓冲：当前回合 id + 该回合步骤（有界 FIFO）。 */
type ThreadBuffer = { round_id: string | null; steps: StepRecord[] };

/** 回合步骤记录器（EngineTransport 协议；事件顺序 = 录制顺序）。 */
export class _RoundStepsRecorder implements EngineTransport {
  readonly #limit: number;
  readonly #threads = new Map<string, ThreadBuffer>();

  constructor(limit: number = DEFAULT_STEP_LIMIT) {
    this.#limit = Math.max(1, limit);
  }

  async send(event: EngineEvent): Promise<void> {
    // 系统信号/机制事件（step_id=null）不入回合步骤序列（事件协议语义）
    if (event.step_id === null) return;
    const thread_id = event.thread_id || '-';
    const round_id = event.round_id ?? null;
    let buf = this.#threads.get(thread_id);
    if (buf === undefined || buf.round_id !== round_id) {
      buf = { round_id, steps: [] };
      this.#threads.set(thread_id, buf);
    }
    buf.steps.push({
      step_id: event.step_id,
      type: event.type,
      payload: { ...event.payload } as JsonRecord,
    });
    if (buf.steps.length > this.#limit) {
      buf.steps.splice(0, buf.steps.length - this.#limit);
    }
  }

  /** 当前线程缓冲的回合步骤（浅拷贝；无缓冲 = 空）。 */
  steps(thread_id: string | null): StepRecord[] {
    const buf = this.#threads.get(thread_id ?? '-');
    return buf === undefined ? [] : [...buf.steps];
  }

  /** 线程数（测试/诊断）。 */
  thread_count(): number {
    return this.#threads.size;
  }
}

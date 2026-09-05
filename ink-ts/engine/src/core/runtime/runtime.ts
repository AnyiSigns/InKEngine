/**
 * 运行时（Runtime）：装配产物持有者 + 生命周期状态机（进程级）——叶类。
 *
 * 装配（boot）幂等；生命周期转换带守卫（非法转换显式报错）；stop 幂等
 * 且按序关停。装配决策全部来自配方数据，Runtime 只做「读配方并执行装配」
 * ——装配动作是机制，不可被补丁链修改（与补丁链不能补丁自己同族的自指
 * 终止）。
 *
 * 分层实现（≤350 行/文件纪律，与 executor 同构）：字段基座（_runtime_base）
 * → 生命周期/回合登记（_runtime_state/_runtime_runs）→ 工具标签与常驻必带
 * 集（_runtime_specs/_runtime_ui）→ 自指上下文/装配源/引擎重建/集状态恢复
 * （_runtime_contexts/_runtime_engine）→ 装配（_runtime_assemble）→ 本叶类。
 */

import { ROUND_LEDGER_COLLECTION } from './_settle.js';
import type { StepRecord } from '../round_steps/index.js';
import { RuntimeAssemble } from './_runtime_assemble.js';

/** 运行时叶类（完整公开形态 = 分层链全量方法）。 */
export class Runtime extends RuntimeAssemble {
  /** 线程最近回合账本（ledger 集合；未记账/未装配返回 null）。 */
  async ledger(thread_id: string): Promise<Record<string, unknown> | null> {
    const storage = this.storage;
    if (storage === null) return null;
    let best: Record<string, unknown> | null = null;
    let bestIndex = -1;
    try {
      for (const record of await storage.list_records(ROUND_LEDGER_COLLECTION)) {
        if (record['thread_id'] !== thread_id) continue;
        const index = Number(record['round_index'] ?? -1);
        if (!Number.isFinite(index) || index < 0) continue;
        if (index > bestIndex) {
          bestIndex = index;
          best = record;
        }
      }
    } catch {
      // 账本读取失败（返回 null）
      return null;
    }
    return best;
  }

  /** 线程最近回合步骤序列（round_steps 记录器；缺省当前在途线程）。 */
  round_steps(thread_id?: string | null): StepRecord[] {
    const recorder = this.round_steps_recorder;
    if (recorder === null) return [];
    return recorder.steps(thread_id ?? this._active_run_thread ?? null);
  }
}

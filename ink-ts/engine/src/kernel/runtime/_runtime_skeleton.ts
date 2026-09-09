// gate: 超限(420 行) - 会话级骨架运行面（P4 单文件承载会话尺度数据结构/加载/校验/续跑协议，拆文件破坏会话生命周期可读性）
/**
 * Runtime 会话级骨架运行面（P4 §五-b）：线程骨架加载/校验 + 骨架 ↔ 回合图
 * 数据转换 + 续跑意图协议。
 *
 * 定位：骨架 = thread 尺度会话数据（非资产），随该 thread checkpoint state
 * 落库恢复；本层负责「读 checkpoint 骨架 → 按当前池重校验 → 沿骨架推进或
 * 回落组装」。执行体解析沿既有注册表（骨架只引池内类型名，运行时不建任何
 * 会话局部类型——见 P4 §4.2 进化即留存）。
 *
 * 续跑意图协议（P4 §4.4）：回合结束状态（state）可带保留键
 * ROUND_CONTINUATION_STATE_KEY 的显式声明 {reason:'evolved'|'continue'}——
 * 引擎只在声明确认且护栏允许时自动发起下一轮（不进 UI、无用户输入）。
 */

import { isRecord } from '../../core/json.js';
import type { RunResult } from '../../core/run_result/run_result.js';
import type { CheckpointRecord } from '../../core/storage/storage_records.js';
import {
  THREAD_SKELETON_STATE_KEY,
  ThreadSkeleton,
} from '../../core/thread_skeleton/index.js';
import {
  derive_skeleton_from_graph,
  skeleton_to_graph_data,
  validate_skeleton_impl,
  type SkeletonCheckResult,
  type SkeletonPoolEnv,
} from '../thread_skeleton/index.js';
import { RuntimeAssemble } from './_runtime_assemble.js';

/** 回合结束续跑意图状态键（state 保留键；显式声明协议，见文件头）。 */
export const ROUND_CONTINUATION_STATE_KEY = '_round_continuation';

/** 续跑意图 reason（evolved=本回合发生进化需以新资产续跑；continue=继续推进）。 */
export type ContinuationReason = 'evolved' | 'continue';

/** 续跑意图（回合结束状态携带的显式声明；reason 之外字段为可读元信息）。 */
export interface ContinuationIntent {
  reason: ContinuationReason;
  meta?: Record<string, unknown>;
}

/** 自续跑护栏上限的语义钳制（0/负 = 关闭；>0 = 单次显式触发可自动续回合数）。 */
export function _clamp_auto_continue_limit(raw: unknown): number {
  const value = typeof raw === 'number' ? Math.trunc(raw) : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

/** 续跑意图解析（state 保留键 → 意图；非声明形态/畸形 = null 不触发续跑）。 */
export function parse_continuation_state(state: Record<string, unknown>): ContinuationIntent | null {
  const raw = state[ROUND_CONTINUATION_STATE_KEY];
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  const reason = raw['reason'];
  if (reason !== 'evolved' && reason !== 'continue') return null;
  const meta = raw['meta'];
  if (meta !== undefined && meta !== null && !isRecord(meta)) return null;
  return {
    reason,
    ...(meta === undefined || meta === null ? {} : { meta: { ...(meta as Record<string, unknown>) } }),
  };
}

/** Runtime 会话级骨架运行面（RuntimeRounds 之下；RuntimeRounds extends 本层）。 */
export abstract class RuntimeSkeleton extends RuntimeAssemble {
  /** 会话级骨架模式开关（配方 thread_skeleton_enabled；缺省 = 旧回合级行为）。 */
  protected _thread_skeleton_enabled(): boolean {
    return this._recipe?.thread_skeleton_enabled === true;
  }

  /** 自续跑护栏上限（配方 auto_continue_limit；0 = 关闭旧行为）。 */
  protected _auto_continue_limit(): number {
    const recipe = this._recipe;
    if (recipe === null) return 0;
    return _clamp_auto_continue_limit(recipe.auto_continue_limit);
  }

  /** 当前池视图（校验骨架引用的执行体来源 + 终态候选；未装配 = 全 false）。 */
  private _skeleton_pool_env(): SkeletonPoolEnv {
    const registries = this.graph_registries;
    const store = this.node_registry_store;
    return {
      has_type: (type_name) => registries !== null && registries.nodes.has(type_name),
      has_condition: (name) => registries !== null && registries.edges.has(name),
      is_terminal: (type_name) => {
        if (registries === null || !registries.nodes.has(type_name)) return false;
        const reg = store?.get(type_name) ?? null;
        return reg !== null && reg.is_active() && reg.flags?.terminal === true;
      },
      has_any_terminal: () => {
        if (store === null || registries === null) return false;
        return store.active().some(
          (reg) => reg.flags?.terminal === true && registries.nodes.has(reg.type_name),
        );
      },
    };
  }

  /** 骨架校验（公开只读校验面；sketch = 序列化数据 dict 或 ThreadSkeleton 实例）。
   *  供 P4-B 自修改工具面在挂载前调用——返回通过/拒绝原因，不落任何写。 */
  validate_skeleton(sketch: unknown): SkeletonCheckResult {
    let skeleton: ThreadSkeleton;
    try {
      skeleton =
        sketch instanceof ThreadSkeleton
          ? sketch
          : ThreadSkeleton.from_dict(sketch);
    } catch (error) {
      return { ok: false, reasons: [`骨架数据形态非法: ${String(error)}`] };
    }
    return validate_skeleton_impl(skeleton, this._skeleton_pool_env());
  }

  /** 读取线程 checkpoint 中的会话骨架（无 = null；数据损坏/校验不过 = null →
   *  调用方按骨架缺失回落组装）。 */
  protected async _load_thread_skeleton(
    thread_id: string,
  ): Promise<ThreadSkeleton | null> {
    const storage = this.storage;
    if (storage === null) return null;
    let latest: CheckpointRecord | null = null;
    try {
      latest = await storage.get_latest_checkpoint(thread_id);
    } catch {
      return null;
    }
    if (latest === null) return null;
    const raw = latest.state[THREAD_SKELETON_STATE_KEY];
    if (raw === null || raw === undefined) return null;
    try {
      return ThreadSkeleton.from_dict(raw);
    } catch {
      return null;
    }
  }

  /** 线程骨架「当前可用」判定：存在 + 结构/池校验全过（骨架失效 = 回落组装）。 */
  protected async _usable_thread_skeleton(thread_id: string): Promise<ThreadSkeleton | null> {
    const skeleton = await this._load_thread_skeleton(thread_id);
    if (skeleton === null) return null;
    const check = validate_skeleton_impl(skeleton, this._skeleton_pool_env());
    return check.ok ? skeleton : null;
  }

  /** 回合 state 显式携带的会话骨架种子（P4-B-2 可写/可分接线点）：命令面把经
   *  validate_skeleton_sketch/mount_skeleton_to_state 校验挂载的骨架随回合 state
   *  显式携带（骨架编辑后续跑 / 新线程骨架试跑蓝图）。引擎只认结构 + 池校验
   *  通过者；非法种子 = null（回落 checkpoint/组装），不因调用方预校验而盲信。 */
  protected _seed_skeleton(state: Record<string, unknown>): ThreadSkeleton | null {
    const raw = state[THREAD_SKELETON_STATE_KEY];
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    try {
      const skeleton = ThreadSkeleton.from_dict(raw);
      const check = validate_skeleton_impl(skeleton, this._skeleton_pool_env());
      return check.ok ? skeleton : null;
    } catch {
      return null;
    }
  }

  /** 组装图定义 → 会话骨架（不可派生 = null：图含子图/无名节点/缺出口）。 */
  protected _skeleton_from_graph(
    graphData: Record<string, unknown>,
    thread_id: string,
  ): ThreadSkeleton | null {
    return derive_skeleton_from_graph(graphData, {
      thread_id,
      created_at: this._r_now(),
    });
  }

  /** 骨架序列化形态 → 本轮图定义数据（无可用骨架 = null）。 */
  protected _skeleton_graph_data(skeleton: ThreadSkeleton): Record<string, unknown> | null {
    if (Object.keys(skeleton.nodes).length === 0) return null;
    return skeleton_to_graph_data(skeleton);
  }

  /** 把骨架以序列化形态放入回合 state（随 checkpoint state 落库恢复）。 */
  protected _embed_skeleton(
    runState: Record<string, unknown>,
    skeleton: ThreadSkeleton,
  ): void {
    const now = this._r_now();
    const data = skeleton.to_dict();
    data['updated_at'] = now;
    runState[THREAD_SKELETON_STATE_KEY] = data;
  }

  /** 续跑意图护栏：本轮结果可否自动续跑（显式意图 + 正常收尾 + 无审批卡）。
   *  error/cancelled/budget 终态与挂起审批卡 = 必须回落用户，不自动续。 */
  protected _continuation_allowed(result: RunResult): ContinuationIntent | null {
    if (result.interrupt !== null && result.interrupt !== undefined) return null;
    const reason = result.reason;
    if (reason !== 'reply' && reason !== 'stop') return null;
    return parse_continuation_state(result.state);
  }

  /** 自续跑下轮回合的输入态（清空单轮回合输入 + 续跑意图置空——防意图经
   *  checkpoint 基底泄漏为下一轮的隐式声明；新声明只能来自本轮显式写入）。 */
  protected _auto_round_state(): Record<string, unknown> {
    const state: Record<string, unknown> = {};
    if (this._auto_continue_limit() > 0) {
      state[ROUND_CONTINUATION_STATE_KEY] = null;
    }
    return state;
  }

  /** 骨架状态回合边界归一（收尾观察面）：evo 意图回合 → evolving，其余 active。 */
  protected _mark_skeleton_after_round(result: RunResult): void {
    if (this._thread_skeleton_enabled()) {
      const raw = result.state[THREAD_SKELETON_STATE_KEY];
      if (isRecord(raw)) {
        const intent = parse_continuation_state(result.state);
        const status = intent?.reason === 'evolved' ? 'evolving' : 'active';
        result.state[THREAD_SKELETON_STATE_KEY] = {
          ...(raw as Record<string, unknown>),
          status,
          updated_at: this._r_now(),
        };
      }
    }
  }
}

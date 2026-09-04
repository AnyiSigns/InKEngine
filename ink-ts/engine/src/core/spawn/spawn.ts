/**
 * 动态子图展开原语的数据面（子任务清单模型/校验/实例归属）。
 *
 * 路由节点（宿主注册）产出子任务清单，本模块定义清单的数据形态与收集
 * 校验；清单的并发展开与结果回收由执行器承担。数据驱动形态（节点返回值
 * 携带 ``__spawn__`` 保留键）与命令式 ``ctx.spawn`` 收集的清单在这里统一
 * 合并校验。
 *
 * 实例隔离：入口状态自包含（清单 state 即实例完整入口）；checkpoint 独
 * 立子链（``{父thread}:spawn:{index}``）；事件统一父链（graph_path 追加
 * 序号归属）。失败语义：部分失败剔除（fan_out 语义），成功结果回流、失
 * 败留痕，父链继续。
 */

import { GraphDefinitionError } from '../errors.js';
import { Graph } from '../graph/graph.js';
import { deepCopy, isRecord, type Json, type JsonRecord } from '../json.js';
import { is_merge_reducer } from '../state/reducers.js';
import type { StateSchema } from '../state/schema.js';

// 数据驱动形态的保留键：节点返回值携带此键 = 子任务清单（引擎内部
// 消费，不落状态通道）；命令式 ctx.spawn 收集的清单与此等价合并。
export const SPAWN_KEY = '__spawn__';

// ── 子任务清单条目 ──────────────────────────────────────────────────────────

/** 子任务清单条目：子图 + 自包含入口状态 + 实例序号。 */
export class SpawnSpec {
  readonly subgraph: Graph;
  readonly state: Record<string, unknown>;
  readonly index: number;

  constructor(init: { subgraph: Graph; state: Record<string, unknown>; index: number }) {
    this.subgraph = init.subgraph;
    this.state = init.state;
    this.index = init.index;
    Object.freeze(this);
  }

  to_dict(): { subgraph: Record<string, unknown>; state: Record<string, unknown>; index: number } {
    return {
      subgraph: this.subgraph.to_dict(),
      state: deepCopy(this.state as Json) as Record<string, unknown>,
      index: this.index,
    };
  }
}

/** 单实例失败信息（剔除原因留痕，父链继续）。 */
export class SpawnFailure {
  readonly index: number;
  readonly error: string;

  constructor(init: { index: number; error: string }) {
    this.index = init.index;
    this.error = init.error;
    Object.freeze(this);
  }

  to_dict(): { index: number; error: string } {
    return { index: this.index, error: this.error };
  }
}

/** 展开结果：成功实例回流增量（按 index 序合并）+ 失败剔除清单。 */
export class SpawnResult {
  overlay: Record<string, unknown>;
  failures: SpawnFailure[];

  constructor(init: { overlay?: Record<string, unknown>; failures?: SpawnFailure[] } = {}) {
    this.overlay = init.overlay ? { ...init.overlay } : {};
    this.failures = init.failures ? [...init.failures] : [];
  }

  to_dict(): { overlay: Record<string, unknown>; failures: Array<{ index: number; error: string }> } {
    return {
      overlay: deepCopy(this.overlay as Json) as Record<string, unknown>,
      failures: this.failures.map((f) => f.to_dict()),
    };
  }
}

// ── 实例归属 / 入口状态 ──────────────────────────────────────────────────────

/** 实例版本链归属：``{父thread}:spawn:{index}``（可回放/回溯定位）。 */
export function instance_thread_id(parent_thread: string, index: number): string {
  return `${parent_thread}:spawn:${index}`;
}

/**
 * 实例入口状态：清单 state 自包含；合并累加族通道归零（回流增量口径）。
 *
 * 与静态子图同语义：子图内从 0 起算，回流增量 = 子图内新增（父图 reducer
 * 加和恰好一次，防二次加和翻倍）。清单未携带的通道不继承父状态（隔离由
 * 清单完整决定）。
 */
export function instance_entry_state(spec: SpawnSpec, sub_schema: StateSchema | null): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...spec.state };
  if (sub_schema !== null) {
    for (const [key, channel] of Object.entries(sub_schema.channels)) {
      if (is_merge_reducer(channel.reducer) && key in entry) {
        entry[key] = {};
      }
    }
  }
  return entry;
}

// ── 清单汇总 ────────────────────────────────────────────────────────────────

/** 图定义数据解析回调：把声明式图定义数据重建为 Graph 实例。 */
export type ResolveGraph = (data: Record<string, unknown>) => Graph;

/**
 * 清单汇总：命令式 ctx.spawn 收集项 + 数据驱动返回键（``SPAWN_KEY``）。
 *
 * 子图放宽：数据驱动项的子图可为 Graph 实例或图定义数据 dict（经
 * ``resolve_graph`` 回调重建——图 = 数据，spawn 清单可跨进程传递、可随
 * 计划版本化）。未注入解析器时 dict 形态显式拒绝（防静默当作缺子图）。
 *
 * 与命令式项统一排序（先命令式后数据驱动，序号保持稳定）；实例序号全局
 * 唯一（重复序号会造成实例链/回流顺序冲突，拒绝）。
 */
export function collect_spawn_specs(
  overlay: Record<string, unknown> | null,
  pending: readonly SpawnSpec[],
  options: { resolve_graph?: ResolveGraph | null } = {},
): SpawnSpec[] {
  const { resolve_graph = null } = options;
  const specs: SpawnSpec[] = [...pending];
  if (overlay !== null && SPAWN_KEY in overlay) {
    const items = overlay[SPAWN_KEY];
    delete overlay[SPAWN_KEY];
    if (!Array.isArray(items) || !items.every((i) => isRecord(i))) {
      throw new GraphDefinitionError('spawn 清单须为 [{subgraph, state, index}, ...] 形态');
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as JsonRecord;
      let subgraph: unknown = item['subgraph'];
      if (subgraph instanceof Graph) {
        // 直挂 Graph 实例
      } else if (isRecord(subgraph) && resolve_graph !== null) {
        subgraph = resolve_graph(subgraph);
      } else {
        const hint = !isRecord(subgraph) ? '，需注入解析器' : '';
        throw new GraphDefinitionError(
          `spawn 清单第 ${i} 项缺子图实例（Graph 或图定义数据${hint}）`,
        );
      }
      const rawState = item['state'];
      if (rawState !== null && rawState !== undefined && !isRecord(rawState)) {
        throw new GraphDefinitionError(`spawn 清单第 ${i} 项状态须为 dict`);
      }
      const state = isRecord(rawState)
        ? (deepCopy(rawState as unknown as Json) as Record<string, unknown>)
        : {};
      const rawIndex = item['index'];
      let index: number;
      try {
        index = rawIndex === null || rawIndex === undefined
          ? specs.length
          : Math.trunc(Number(rawIndex));
      } catch (cause) {
        throw new GraphDefinitionError(
          `spawn 清单第 ${i} 项序号非法: ${String(cause)}`,
        );
      }
      if (!Number.isFinite(index) || Number.isNaN(index)) {
        throw new GraphDefinitionError(`spawn 清单第 ${i} 项序号非法: ${String(rawIndex)}`);
      }
      specs.push(
        new SpawnSpec({
          subgraph: subgraph as Graph,
          state: state as Record<string, unknown>,
          index,
        }),
      );
    }
  }
  const indexes = specs.map((s) => s.index);
  if (new Set(indexes).size !== indexes.length) {
    throw new GraphDefinitionError(`spawn 实例序号重复: ${[...indexes].sort((a, b) => a - b)}`);
  }
  return specs;
}

/**
 * skeleton 命令面（get/edit）——会话级骨架声明式修改读/写口（P4-B-2 目标 1）。
 *
 * 数据与写纪律：骨架 = thread 尺度会话数据，读 = 最新 checkpoint state 的
 * _thread_skeleton 投影（键名与引擎常量一致）；写 = 声明式修改（改
 * active_target/增删节点实例或边/设出口，引用池内已登记类型）→ 经 B-1 封装
 * validate_skeleton_sketch 校验 → mount_skeleton_to_state（唯一写口，禁止旁路
 * 直写）→ 草稿落 host 会话簿记（skeleton_draft），下一次 rounds.send 把草稿作为
 * 回合 state 的显式骨架种子消费（引擎沿新骨架推进，见 engine _seed_skeleton）——
 * 命令面自身不触发回合，不绕过引擎的回合驱动/护栏。
 *
 * 本域为 UI/调试/后续 agent 工具执行器的最小接线面（agent 工具包面写入遗留）；
 * 机制语义（结构/池校验）全在引擎，host 只接线不复制。
 */

import type { SkeletonCommand } from './commands.generated.js';
export { SKELETON_COMMANDS, type SkeletonCommand } from './commands.generated.js';
import type { Storage } from '@ink-ts/engine';
import { THREAD_SKELETON_STATE_KEY, ThreadSkeleton } from '@ink-ts/engine';

import { HostSessionStore } from '../sessions/store.js';
import {
  mount_skeleton_to_state,
  pre_register_skeleton_routes,
  validate_skeleton_sketch,
} from '../skeleton.js';
import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';

/** 声明式修改动作（op 必填；字段随 op 校验，畸形 = invalid_params）。 */
export type SkeletonEditOp =
  | { op: 'set_target'; target: string | null }
  | { op: 'upsert_node'; id: string; type: string; config?: Record<string, unknown> | null; contract?: Record<string, unknown> | null }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; from: string; to: string; condition?: string | null }
  | { op: 'remove_edge'; from: string; to: string; condition?: string | null }
  | { op: 'set_exits'; exits: string[] };

/** skeleton.get 结果（present=false = 线程尚无骨架；valid = 池/结构校验态）。 */
export interface SkeletonGetView {
  thread_id: string;
  present: boolean;
  skeleton: Record<string, unknown> | null;
  valid: boolean;
  reasons: string[];
}

/** skeleton.edit 参数（sketch = 整份替换；actions = 对当前骨架声明式增量）。 */
export interface SkeletonEditParams {
  thread_id: string;
  actions?: SkeletonEditOp[];
  sketch?: Record<string, unknown>;
  /** true = 只校验预览，不落草稿（不写 host 簿记）。 */
  dry?: boolean;
}

/** skeleton.edit 结果（ok=false = 校验拒绝不落写；mounted=true = 已挂载草稿）。 */
export interface SkeletonEditView {
  ok: boolean;
  mounted: boolean;
  reasons: string[];
  thread_id: string;
  dry: boolean;
  skeleton: Record<string, unknown> | null;
}

const SKELETON_OPS = new Set([
  'set_target',
  'upsert_node',
  'remove_node',
  'add_edge',
  'remove_edge',
  'set_exits',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new BridgeError(`skeleton.edit ${name} 须为非空字符串`, 'invalid_params');
  }
  return value;
}

/** 动作参数逐条归一（字段校验；畸形动作 fail-closed 拒绝，不半写）。 */
function normalizeOp(raw: unknown): SkeletonEditOp {
  if (!isObject(raw) || typeof raw['op'] !== 'string' || !SKELETON_OPS.has(raw['op'])) {
    throw new BridgeError('skeleton.edit actions 条目须为 {op, ...} 且 op 受支持', 'invalid_params');
  }
  const op = raw['op'] as string;
  switch (op) {
    case 'set_target': {
      const target = raw['target'] === null || raw['target'] === undefined ? null : raw['target'];
      if (target !== null && typeof target !== 'string') {
        throw new BridgeError('skeleton.edit set_target target 须为字符串或 null', 'invalid_params');
      }
      return { op: 'set_target', target: target as string | null };
    }
    case 'upsert_node': {
      const id = requireString(raw['id'], 'upsert_node.id');
      const type = requireString(raw['type'], 'upsert_node.type');
      const config = raw['config'];
      if (config !== undefined && config !== null && !isObject(config)) {
        throw new BridgeError('skeleton.edit upsert_node config 须为 dict', 'invalid_params');
      }
      const contract = raw['contract'];
      if (contract !== undefined && contract !== null && !isObject(contract)) {
        throw new BridgeError('skeleton.edit upsert_node contract 须为 dict', 'invalid_params');
      }
      return {
        op: 'upsert_node',
        id,
        type,
        ...(config === undefined || config === null ? {} : { config: config as Record<string, unknown> }),
        ...(contract === undefined || contract === null ? {} : { contract: contract as Record<string, unknown> }),
      };
    }
    case 'remove_node':
      return { op: 'remove_node', id: requireString(raw['id'], 'remove_node.id') };
    case 'add_edge': {
      const condition = raw['condition'] === undefined || raw['condition'] === null ? undefined : raw['condition'];
      if (condition !== undefined && typeof condition !== 'string') {
        throw new BridgeError('skeleton.edit add_edge condition 须为字符串', 'invalid_params');
      }
      return {
        op: 'add_edge',
        from: requireString(raw['from'], 'add_edge.from'),
        to: requireString(raw['to'], 'add_edge.to'),
        ...(condition === undefined ? {} : { condition }),
      };
    }
    case 'remove_edge': {
      const condition = raw['condition'] === undefined || raw['condition'] === null ? undefined : raw['condition'];
      if (condition !== undefined && typeof condition !== 'string') {
        throw new BridgeError('skeleton.edit remove_edge condition 须为字符串', 'invalid_params');
      }
      return {
        op: 'remove_edge',
        from: requireString(raw['from'], 'remove_edge.from'),
        to: requireString(raw['to'], 'remove_edge.to'),
        ...(condition === undefined ? {} : { condition }),
      };
    }
    case 'set_exits': {
      const exits = raw['exits'];
      if (!Array.isArray(exits) || exits.some((item) => typeof item !== 'string' || item === '')) {
        throw new BridgeError('skeleton.edit set_exits exits 须为非空字符串数组', 'invalid_params');
      }
      return { op: 'set_exits', exits: exits as string[] };
    }
    default:
      throw new BridgeError(`skeleton.edit 不支持的动作: ${op}`, 'invalid_params');
  }
}

/** 声明式动作应用到当前骨架 dict（返回新 dict；不原地改调用方数据）。 */
function applyOps(base: Record<string, unknown>, ops: readonly SkeletonEditOp[]): Record<string, unknown> {
  const out = deepClone(base);
  const nodes = (isObject(out['nodes']) ? out['nodes'] : {}) as Record<string, unknown>;
  const edges = (isObject(out['edges']) ? out['edges'] : {}) as Record<string, unknown[]>;
  /** 取 from 的边表（不存在/非数组 = 空表；写回统一走 assign）。 */
  const edgeList = (from: string): unknown[] =>
    Array.isArray(edges[from]) ? (edges[from] as unknown[]) : [];
  for (const item of ops) {
    switch (item.op) {
      case 'set_target':
        out['active_target'] = item.target;
        break;
      case 'upsert_node': {
        const spec: Record<string, unknown> = { type: item.type };
        if (item.config !== undefined && item.config !== null) spec['config'] = deepClone(item.config);
        if (item.contract !== undefined && item.contract !== null) spec['contract'] = deepClone(item.contract);
        nodes[item.id] = spec;
        break;
      }
      case 'remove_node': {
        delete nodes[item.id];
        delete edges[item.id];
        for (const [from, list] of Object.entries(edges)) {
          const kept = list.filter(
            (edge) => !(isObject(edge) && edge['target'] === item.id),
          );
          if (kept.length !== list.length) edges[from] = kept;
        }
        break;
      }
      case 'add_edge': {
        const list = edgeList(item.from);
        const hasDuplicate = list.some(
          (edge) =>
            isObject(edge) && edge['target'] === item.to
            && (item.condition === undefined || edge['condition'] === item.condition),
        );
        if (!hasDuplicate) {
          list.push(
            item.condition === undefined
              ? { target: item.to }
              : { target: item.to, condition: item.condition },
          );
          edges[item.from] = list;
        }
        break;
      }
      case 'remove_edge': {
        edges[item.from] = edgeList(item.from).filter(
          (edge) =>
            !(isObject(edge) && edge['target'] === item.to
              && (item.condition === undefined || edge['condition'] === item.condition)),
        );
        break;
      }
      case 'set_exits':
        out['exits'] = [...item.exits];
        break;
    }
  }
  out['nodes'] = nodes;
  out['edges'] = edges;
  return out;
}

/** 最新 checkpoint state 的骨架 dict 投影（无链/无键/损坏 = null）。 */
async function latestSkeletonRaw(storage: Storage, thread_id: string): Promise<Record<string, unknown> | null> {
  const latest = await storage.get_latest_checkpoint(thread_id).catch(() => null);
  if (latest === null) return null;
  const raw = latest.state[THREAD_SKELETON_STATE_KEY];
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return deepClone(raw as Record<string, unknown>);
}


export function buildSkeletonCommands(deps: HostBridgeDeps): Readonly<Record<SkeletonCommand, BridgeHandler>> {
  const sessions = new HostSessionStore(() => deps.runtime.storage as unknown as Storage | null);

  /** skeleton.get：读最新 checkpoint 的 _thread_skeleton 投影 + 当前池校验态。 */
  const get: BridgeHandler = async (raw): Promise<SkeletonGetView> => {
    const params = raw as { thread_id?: unknown } | null;
    if (
      typeof params !== 'object'
      || params === null
      || typeof params.thread_id !== 'string'
      || params.thread_id === ''
    ) {
      throw new BridgeError('skeleton.get 需 params.thread_id', 'invalid_params');
    }
    const thread_id = params.thread_id;
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const rawSkeleton = await latestSkeletonRaw(storage, thread_id);
    if (rawSkeleton === null) {
      return { thread_id, present: false, skeleton: null, valid: false, reasons: ['该线程尚无会话骨架（先跑组装回合建立）'] };
    }
    const check = validate_skeleton_sketch(deps.runtime, rawSkeleton);
    return {
      thread_id,
      present: true,
      skeleton: rawSkeleton,
      valid: check.ok,
      reasons: [...check.reasons],
    };
  };

  /** skeleton.edit：声明式修改 → 校验 → 挂载（唯一写口）→ 草稿待下轮生效。 */
  const edit: BridgeHandler = async (raw): Promise<SkeletonEditView> => {
    const params = raw as SkeletonEditParams | null;
    if (typeof params !== 'object' || params === null || typeof params.thread_id !== 'string' || params.thread_id === '') {
      throw new BridgeError('skeleton.edit 需 params.thread_id', 'invalid_params');
    }
    const thread_id = params.thread_id;
    const dry = params.dry === true;
    if ((params.actions === undefined) === (params.sketch === undefined)) {
      throw new BridgeError('skeleton.edit 需且仅需 actions（增量修改）或 sketch（整份替换）之一', 'invalid_params');
    }
    let ops: SkeletonEditOp[] = [];
    if (params.actions !== undefined) {
      if (!Array.isArray(params.actions)) {
        throw new BridgeError('skeleton.edit actions 须为数组', 'invalid_params');
      }
      ops = params.actions.map((item) => normalizeOp(item));
    }
    const sketchRaw = params.sketch !== undefined ? deepClone(params.sketch) : null;
    if (sketchRaw !== null && !isObject(sketchRaw)) {
      throw new BridgeError('skeleton.edit sketch 须为 dict', 'invalid_params');
    }
    const storage = deps.runtime.storage;
    if (storage === null) {
      throw new BridgeError('运行时存储未装配', 'runtime_unavailable');
    }
    const base = await latestSkeletonRaw(storage, thread_id);
    const sketch: Record<string, unknown> =
      sketchRaw !== null
        ? sketchRaw
        : applyOps(base ?? {}, ops);
    // 会话尺度归属修正：草图 thread_id 恒为操作目标线程（基座来自该线程，替换
    // 形态由调用方携带，强制对齐防错线程落库）。
    sketch['thread_id'] = thread_id;
    if (!isObject(sketch['nodes'])) sketch['nodes'] = {};
    // route:* 出边条件预注册（#8 收敛点：改后骨架含 router_judge 且 route 条件
    // 未注册时，从 config.routes 提取登记；注册失败 = 校验拒绝原因）。
    const routes = pre_register_skeleton_routes(deps.runtime, sketch);
    if (!routes.ok) {
      return { ok: false, mounted: false, reasons: [...routes.reasons], thread_id, dry, skeleton: null };
    }
    const check = validate_skeleton_sketch(deps.runtime, sketch);
    if (!check.ok) {
      return { ok: false, mounted: false, reasons: [...check.reasons], thread_id, dry, skeleton: null };
    }
    if (dry) {
      return { ok: true, mounted: false, reasons: [], thread_id, dry: true, skeleton: sketch };
    }
    const state: Record<string, unknown> = {};
    const mounted = mount_skeleton_to_state(deps.runtime, state, sketch);
    if (!mounted.ok) {
      return { ok: false, mounted: false, reasons: [...mounted.reasons], thread_id, dry: false, skeleton: null };
    }
    const draft = state[THREAD_SKELETON_STATE_KEY];
    await sessions.set_skeleton_draft(
      thread_id,
      isObject(draft) ? (draft as Record<string, unknown>) : null,
    );
    return {
      ok: true,
      mounted: true,
      reasons: [],
      thread_id,
      dry: false,
      skeleton: isObject(draft) ? (draft as Record<string, unknown>) : sketch,
    };
  };

  return {
    'skeleton.get': get,
    'skeleton.edit': edit,
  };
}

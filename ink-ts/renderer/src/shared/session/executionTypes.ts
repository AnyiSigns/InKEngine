/**
 * execution.run 回执镜像契约（显示层消费面，事件/state/展示）。
 *
 * 宿主 bridge execution.run 回执 = run 树投影（runs[]：run_id/parent_run_id/
 * entry_scope/outcome/hops/cost/error）+ 事件带（events[]：run_id/parent_run_id/
 * scope/action/detail）+ 降级摘要 + 汇聚点产物。设备不 import engine 包——本文件
 * 只前向镜像数据形态（eventTypes.ts 同规：真源 = 引擎/桥命令面，此处为展示契约）。
 *
 * 解析纪律：整体形状非法（runs 非数组 / run_id 缺）= null（fail-closed，调用方
 * 不落位）；可缺省字段（cost/detail/error）宽松容忍，未知键忽略（前向兼容）。
 */

/** 轨迹终态词表（引擎 TRAIL_OUTCOMES 前向镜像）。 */
export const EXECUTION_OUTCOMES = ['success', 'failure', 'degraded'] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

/** 通道形态词表（channel_spec 四值前向镜像）。 */
export const CHANNEL_SHAPES = ['delegate', 'fan_out', 'fan_in', 'return'] as const;

/** 提交契约词表（channel_spec 三值前向镜像）。 */
export const CHANNEL_COMMITS = ['full', 'best', 'decision_only'] as const;

/** 白板块类型词表（受控白板五类前向镜像；圆桌形态判定消费 opinion 块）。 */
export const WHITEBOARD_BLOCK_KINDS = ['task', 'opinion', 'board', 'conclusion', 'summary'] as const;

/** 汇聚点产物文本投影优先键（宿主意见/结论块 content 投影同词表）。 */
export const FINAL_PRODUCT_TEXT_KEYS = ['text', 'conclusion', 'answer', 'reply', 'message', 'plan'] as const;

/** run 事件 action 词表（引擎执行循环发射面：route:<kind>/scope_turn/merge/whiteboard_audit）。 */
export const RUN_EVENT_ACTIONS = ['scope_turn', 'merge', 'whiteboard_audit'] as const;

/** 成本度量（引擎 TrailCost 同形；全部可缺省）。 */
export interface ExecutionCost {
  steps?: number;
  cost?: number;
  tokens?: number;
  ms?: number;
}

/** 一次转场（scope A →通道→ scope B；hops 单跳投影）。 */
export interface ExecutionHop {
  from: string;
  to: string;
  shape: string;
  commit?: string;
  count?: number;
}

/** run 记录投影（执行树节点；bridge project_run 回执形态）。 */
export interface ExecutionRunRecord {
  run_id: string;
  parent_run_id: string | null;
  entry_scope: string;
  outcome: ExecutionOutcome;
  hops: ExecutionHop[];
  cost: ExecutionCost;
  error: string | null;
}

/** 事件带条目（run_id/parent_run_id/scope/action 组织为执行树）。 */
export interface ExecutionEvent {
  run_id: string;
  parent_run_id: string | null;
  scope: string;
  action: string;
  detail: Record<string, unknown> | null;
}

/** 轨迹投影行（trails[]：跳数统计面）。 */
export interface ExecutionTrailRow {
  run_id: string;
  entry_scope: string;
  outcome: string;
  hops: number;
}

/** execution.run 回执（web 消费面）。 */
export interface ExecutionReceipt {
  run_id: string;
  /** 回合归属（主线增量回执带 round_id：同线程多轮按轮替换；execution.run
   *  回执无此字段）。 */
  round_id?: string;
  blocked: boolean;
  block_reason: string | null;
  outcome: ExecutionOutcome | null;
  final_product: Record<string, unknown>;
  degraded_summaries: string[];
  runs: ExecutionRunRecord[];
  events: ExecutionEvent[];
  trails: ExecutionTrailRow[];
}

/** execution.run 入参（bridge asParams 校验面同形）。 */
export interface ExecutionRunParams {
  task: string;
  trigger?: string | null;
  entry_scope?: string | null;
  entry_temp_scope?: Record<string, unknown> | null;
  run_id?: string | null;
  pose?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outcomeOf(value: unknown): ExecutionOutcome {
  return (EXECUTION_OUTCOMES as readonly string[]).includes(String(value))
    ? value as ExecutionOutcome
    : 'failure';
}

function costOf(raw: unknown): ExecutionCost {
  const source = isRecord(raw) ? raw : {};
  const cost: ExecutionCost = {};
  for (const key of ['steps', 'cost', 'tokens', 'ms'] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) cost[key] = value;
  }
  return cost;
}

function hopsOf(raw: unknown): ExecutionHop[] {
  if (!Array.isArray(raw)) return [];
  const hops: ExecutionHop[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const from = typeof item.from === 'string' ? item.from : '';
    const to = typeof item.to === 'string' ? item.to : '';
    if (!from || !to) continue;
    hops.push({
      from,
      to,
      shape: typeof item.shape === 'string' ? item.shape : '',
      ...(typeof item.commit === 'string' ? { commit: item.commit } : {}),
      ...(typeof item.count === 'number' && Number.isFinite(item.count) ? { count: item.count } : {}),
    });
  }
  return hops;
}

function runsOf(raw: unknown): ExecutionRunRecord[] | null {
  if (!Array.isArray(raw)) return null;
  const runs: ExecutionRunRecord[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.run_id !== 'string' || item.run_id === '') return null;
    runs.push({
      run_id: item.run_id,
      parent_run_id: typeof item.parent_run_id === 'string' ? item.parent_run_id : null,
      entry_scope: typeof item.entry_scope === 'string' ? item.entry_scope : '',
      outcome: outcomeOf(item.outcome),
      hops: hopsOf(item.hops),
      cost: costOf(item.cost),
      error: typeof item.error === 'string' ? item.error : null,
    });
  }
  return runs;
}

function eventsOf(raw: unknown): ExecutionEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: ExecutionEvent[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.run_id !== 'string') continue;
    events.push({
      run_id: item.run_id,
      parent_run_id: typeof item.parent_run_id === 'string' ? item.parent_run_id : null,
      scope: typeof item.scope === 'string' ? item.scope : '',
      action: typeof item.action === 'string' ? item.action : '',
      detail: isRecord(item.detail) ? item.detail : null,
    });
  }
  return events;
}

/** 回执解析（fail-closed：根键缺失 / runs 形状非法 = null 拒绝落位）。 */
export function parseExecutionReceipt(raw: unknown): ExecutionReceipt | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.run_id !== 'string' || raw.run_id === '') return null;
  const runs = runsOf(raw.runs);
  if (runs === null) return null;
  const finalProduct = isRecord(raw.final_product) ? raw.final_product : {};
  return {
    run_id: raw.run_id,
    round_id: typeof raw.round_id === 'string' ? raw.round_id : undefined,
    blocked: raw.blocked === true,
    block_reason: typeof raw.block_reason === 'string' ? raw.block_reason : null,
    outcome: raw.outcome === undefined || raw.outcome === null ? null : outcomeOf(raw.outcome),
    final_product: finalProduct,
    degraded_summaries: Array.isArray(raw.degraded_summaries)
      ? raw.degraded_summaries.map(String)
      : [],
    runs,
    events: eventsOf(raw.events),
    trails: Array.isArray(raw.trails)
      ? raw.trails.filter(isRecord).map((t) => ({
        run_id: typeof t.run_id === 'string' ? t.run_id : '',
        entry_scope: typeof t.entry_scope === 'string' ? t.entry_scope : '',
        outcome: typeof t.outcome === 'string' ? t.outcome : '',
        hops: typeof t.hops === 'number' && Number.isFinite(t.hops) ? t.hops : 0,
      }))
      : [],
  };
}

/** 汇聚点产物文本投影（契约字段优先；无非空文本 = null 不硬渲染）。 */
export function finalProductText(product: Record<string, unknown>): string | null {
  for (const key of FINAL_PRODUCT_TEXT_KEYS) {
    const value = product[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

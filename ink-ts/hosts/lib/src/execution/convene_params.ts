/**
 * convene 目标解析与参数归一（召集协议的入口校验面，设计）。
 *
 * 职责边界：把 collab_request 工具的模型参数归一为召集主流程（convene.ts）的
 * 结构化输入——召集目标二选一（目录作用域 id / 临时作用域现场定义）、n/mode/
 * contract/rounds/budget 缺省与取值域。校验失败一律抛 ConveneError（执行体归一
 * 为结构化拒绝结果，模型可见、可自我纠正，不击穿回合）。
 *
 * 单一真源：参数 schema 的声明面在 plugins/tools/collab_request/spec.json 与
 * collab_command.ts 定义（防第二真源漂移由测试对齐），本模块是其执行语义面。
 */

import { CHANNEL_COMMIT_BEST, CHANNEL_COMMIT_FULL, parse_temp_scope_def } from '@ink-ts/engine';
import type { ChannelCommit } from '@ink-ts/engine';

/** 召集声明的 n 上限（通道/护栏还会二次封顶；此常量只防畸形参数放大）。 */
export const CONVENE_MAX_N = 32;
/** open 圆桌轮次上限（护栏封顶；成本可控性优先于「永不收敛」）。 */
export const CONVENE_MAX_ROUNDS = 8;

/** 召集校验/闸门失败（执行体归一为结构化拒绝结果，不击穿回合）。 */
export class ConveneError extends Error {
  readonly reason: string;

  constructor(message: string, reason = 'invalid_params') {
    super(message);
    this.name = 'ConveneError';
    this.reason = reason;
  }
}

/** 召集目标（resolve_convene_target 产出；主流程按 source 分流装载路径）。 */
export interface ConveneTarget {
  source: 'directory' | 'temp';
  /** 目录作用域 id（source=directory）。 */
  scope_id: string | null;
  /** 临时作用域定义（source=temp，已 parse 校验）。 */
  temp_def: Record<string, unknown> | null;
  /** 判定/展示引用（目录 id 或 temp:<role>）。 */
  ref: string;
}

/** 归一后的召集参数（normalize_convene_params 产出）。 */
export interface ConveneParams {
  task: string;
  n: number;
  mode: 'blind' | 'open';
  contract: ChannelCommit;
  rounds: number;
  budget: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 目标解析：entity_id（目录 id）优先；scope 字符串 = 目录 id；scope dict = 现场定义。 */
export function resolve_convene_target(args: Record<string, unknown>): ConveneTarget {
  const entity_id = args['entity_id'];
  if (typeof entity_id === 'string' && entity_id.trim() !== '') {
    return { source: 'directory', scope_id: entity_id.trim(), temp_def: null, ref: entity_id.trim() };
  }
  const scope = args['scope'];
  if (typeof scope === 'string' && scope.trim() !== '') {
    return { source: 'directory', scope_id: scope.trim(), temp_def: null, ref: scope.trim() };
  }
  if (isRecord(scope)) {
    let def: unknown;
    try {
      def = parse_temp_scope_def(scope);
    } catch (error) {
      throw new ConveneError(
        `临时作用域定义非法: ${error instanceof Error ? error.message : String(error)}`,
        'temp_scope_invalid',
      );
    }
    const role = (def as { role?: string }).role ?? '';
    return { source: 'temp', scope_id: null, temp_def: scope, ref: `temp:${role}` };
  }
  throw new ConveneError(
    '缺召集目标：entity_id（目录作用域 id）或 scope（目录 id / 临时作用域定义 dict）二选一',
  );
}

/** 参数归一（n/mode/contract/rounds/budget 缺省与取值域；非法显式拒绝）。 */
export function normalize_convene_params(args: Record<string, unknown>): ConveneParams {
  const task = args['task'];
  if (typeof task !== 'string' || task.trim() === '') {
    throw new ConveneError('召集缺 task（子任务描述，非空字符串）');
  }
  const rawN = args['n'] ?? 1;
  if (typeof rawN !== 'number' || !Number.isInteger(rawN) || rawN < 1 || rawN > CONVENE_MAX_N) {
    throw new ConveneError(`n 须为 1..${CONVENE_MAX_N} 的整数`);
  }
  const rawMode = args['mode'] ?? 'blind';
  if (rawMode !== 'blind' && rawMode !== 'open') {
    throw new ConveneError("mode 须为 'blind' | 'open'");
  }
  const rawContract = args['contract'] ?? CHANNEL_COMMIT_FULL;
  if (rawContract !== CHANNEL_COMMIT_FULL && rawContract !== CHANNEL_COMMIT_BEST) {
    throw new ConveneError("contract 须为 'full' | 'best'（召集契约；decision_only 属隔离试跑）");
  }
  const rawRounds = args['rounds'] ?? (rawMode === 'open' ? 2 : 1);
  if (typeof rawRounds !== 'number' || !Number.isInteger(rawRounds) || rawRounds < 1 || rawRounds > CONVENE_MAX_ROUNDS) {
    throw new ConveneError(`rounds 须为 1..${CONVENE_MAX_ROUNDS} 的整数`);
  }
  let budget: number | null = null;
  if (args['budget'] !== undefined && args['budget'] !== null) {
    if (typeof args['budget'] !== 'number' || !Number.isFinite(args['budget']) || args['budget'] < 0) {
      throw new ConveneError('budget 须为非负数');
    }
    budget = args['budget'] as number;
  }
  return { task: task.trim(), n: rawN, mode: rawMode, contract: rawContract, rounds: rawRounds, budget };
}

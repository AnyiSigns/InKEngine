/**
 * RoundSteps 内部原语与 ctx 工厂（拆分主类的内部逻辑层）。
 *
 * 主类 RoundSteps 持有 _steps/_index/_counts/_reply_open 等可变状态，对外
 * 通过 ctx 工厂（buildCardCtx 等）把状态暴露给各子机制模块使用——主类与
 * 子机制模块间通过 ctx 接口解耦（不互相 import 私有方法）。
 */

import type { JsonRecord } from '../json.js';
import { isRecord } from '../json.js';
import {
  COUNTED_KINDS,
  type StepRecord,
} from './round_steps_types.js';
import { STEP_ID_MAX_CHARS } from './round_steps_types.js';
import type { CardCtx } from './round_steps_cards.js';
import type { ReplyCtx } from './round_steps_reply.js';
import type { ToolCtx } from './round_steps_tools.js';
import type { NodeCtx } from './round_steps_nodes.js';
import type { AssemblyCtx } from './round_steps_assembly.js';
import type { MiscCtx } from './round_steps_misc.js';

/** step_id 截断（统一在追加时按口径截断——stream/end/fail 与 start 同一截断）。 */
export function clampStepId(step_id: string): string {
  return step_id.slice(0, STEP_ID_MAX_CHARS);
}

/** RoundSteps 持有状态（主类引用 + 子机制模块通过工厂 ctx 操作）。 */
export interface RoundStepsState {
  readonly steps: StepRecord[];
  readonly index: Map<string, StepRecord>;
  readonly counts: Map<string, number>;
  replyOpen: boolean;
  readonly closeReply: () => void;
  readonly nextCount: (kind: string) => string;
  readonly append: (step_type: string, step_id: string, payload: JsonRecord) => string;
  readonly popLast: () => StepRecord | null;
  readonly update: (step_id: string, patch: JsonRecord) => void;
  readonly stepPayload: (step_id: string) => JsonRecord;
  readonly lastByType: (step_type: string) => StepRecord | null;
  readonly lastStep: () => StepRecord | null;
  readonly toolPending: (tool_call_id: string) => string;
}

/**
 * 构造累积器状态：从种子（未知列表）反推步骤并构建索引/计数。
 *
 * payload 浅拷贝：种子来自 checkpoint 状态，累积期就地改写不得回污原状态。
 */
export function buildState(
  seed: readonly unknown[] | null,
): {
  steps: StepRecord[];
  index: Map<string, StepRecord>;
  counts: Map<string, number>;
  replyOpen: boolean;
} {
  const steps: StepRecord[] = [];
  const index = new Map<string, StepRecord>();
  if (Array.isArray(seed)) {
    for (const raw of seed) {
      if (!isRecord(raw)) continue;
      const stepIdRaw = raw['step_id'];
      if (stepIdRaw === undefined || stepIdRaw === null) continue;
      const stepId = String(stepIdRaw);
      const stepTypeRaw = raw['type'];
      const stepType = stepTypeRaw === undefined || stepTypeRaw === null ? '' : String(stepTypeRaw);
      const payloadRaw = raw['payload'];
      const payload: JsonRecord = isRecord(payloadRaw) ? { ...payloadRaw } : {};
      const record: StepRecord = { step_id: stepId, type: stepType, payload };
      steps.push(record);
      index.set(stepId, record);
    }
  }
  const counts = new Map<string, number>();
  const { replyOpen } = restoreCounts(steps, counts);
  return { steps, index, counts, replyOpen };
}

/**
 * 从种子步骤反推各类计数（续流 step_id 与中断前连续，不重号）。
 *
 * node 步骤的 step_id 由 node_id（可含序号）决定，不占计数。
 * tool 步骤只在「无 tool_call_id 回退计数」形态（tool:<纯数字>）时占计数
 * ——带 id 的工具卡由 tool_call_id 保证唯一。计数取序号最大值而非条数：
 * 中断回合里两种形态可能混存，按最大值续号才不会与种子内已有 tool:<n>
 * 撞号（纯数字 tool_call_id 被误判为序号时同样只是跳号，不会冲突）。
 */
export function restoreCounts(
  steps: readonly StepRecord[],
  counts: Map<string, number>,
): { replyOpen: boolean } {
  let replyOpen = false;
  for (const step of steps) {
    const kind = step.type;
    if (COUNTED_KINDS.has(kind)) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    } else if (kind === 'tool') {
      const sid = step.step_id;
      const suffix = sid.startsWith('tool:') ? sid.slice('tool:'.length) : '';
      if (suffix.length > 0 && /^[0-9]+$/.test(suffix)) {
        const n = parseInt(suffix, 10);
        counts.set('tool', Math.max(counts.get('tool') ?? 0, n));
      }
    } else if (kind === 'reply_token') {
      // reply 计数键固定（REPLY_COUNT_KEY='reply'）
      counts.set('reply', (counts.get('reply') ?? 0) + 1);
      replyOpen = true;
    }
  }
  return { replyOpen };
}

/** 卡片累积 ctx（thinking/plan 流式 + 收尾）。 */
export function buildCardCtx(state: RoundStepsState): CardCtx {
  return {
    steps: state.steps,
    closeReply: state.closeReply,
    nextCount: state.nextCount,
    append: state.append,
    popLast: state.popLast,
  };
}

/** 回复流 ctx（reply_token + setFinalReply）。 */
export function buildReplyCtx(state: RoundStepsState): ReplyCtx {
  return {
    steps: state.steps,
    replyOpen: state.replyOpen,
    closeReply: state.closeReply,
    nextCount: state.nextCount,
    append: state.append,
    lastStep: state.lastStep,
  };
}

/** 工具卡 ctx。 */
export function buildToolCtx(state: RoundStepsState): ToolCtx {
  return {
    steps: state.steps,
    closeReply: state.closeReply,
    nextCount: state.nextCount,
    lastByType: state.lastByType,
    append: state.append,
    lastStep: state.lastStep,
  };
}

/** 节点卡 ctx。 */
export function buildNodeCtx(
  state: RoundStepsState,
  node_labels: ReadonlyMap<string, string>,
): NodeCtx {
  return {
    steps: state.steps,
    index: state.index,
    nodeLabels: node_labels,
    lastByType: state.lastByType,
    closeReply: state.closeReply,
    append: state.append,
    update: state.update,
    stepPayload: state.stepPayload,
  };
}

/** 组装阶段 ctx。 */
export function buildAssemblyCtx(state: RoundStepsState): AssemblyCtx {
  return {
    index: state.index,
    append: state.append,
    update: state.update,
  };
}

/** 杂项 ctx（user/memory/reviewCard/suggestions/error）。 */
export function buildMiscCtx(state: RoundStepsState): MiscCtx {
  return {
    steps: state.steps,
    nextCount: state.nextCount,
    append: state.append,
    lastByType: state.lastByType,
    closeReply: state.closeReply,
    toolPending: state.toolPending,
  };
}

/**
 * 从已构造的 steps/index/counts 装配 RoundStepsState 及其全部内部原语闭包。
 *
 * closeReply 通过 state.replyOpen setter 回写到 state——主类在 reply 流方法
 * 调完后读取 state.replyOpen 同步本类私有字段；其它原语（append/popLast/
 * update/...）共享同一闭包内 steps/index 引用，与 Python 私有方法同构。
 */
export function buildRoundStepsState(
  steps: StepRecord[],
  index: Map<string, StepRecord>,
  counts: Map<string, number>,
  initialReplyOpen: boolean,
): RoundStepsState {
  const state: RoundStepsState = {
    steps,
    index,
    counts,
    replyOpen: initialReplyOpen,
    closeReply: () => {
      state.replyOpen = false;
    },
    nextCount: (kind: string): string => {
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      return String(n);
    },
    append: (step_type: string, step_id: string, payload: JsonRecord): string => {
      const finalId = clampStepId(step_id);
      const existing = index.get(finalId);
      if (existing !== undefined) {
        const cur = isRecord(existing.payload) ? { ...existing.payload } : {};
        existing.payload = { ...cur, ...payload };
        return finalId;
      }
      const record: StepRecord = {
        step_id: finalId,
        type: step_type,
        payload: { ...payload },
      };
      steps.push(record);
      index.set(finalId, record);
      return finalId;
    },
    popLast: (): StepRecord | null => {
      if (steps.length === 0) return null;
      const record = steps.pop()!;
      index.delete(record.step_id);
      return record;
    },
    update: (step_id: string, patch: JsonRecord): void => {
      const record = index.get(step_id);
      if (record === undefined) return;
      const cur = isRecord(record.payload) ? { ...record.payload } : {};
      record.payload = { ...cur, ...patch };
    },
    stepPayload: (step_id: string): JsonRecord => {
      const record = index.get(step_id);
      if (record === undefined) return {};
      const payload = record.payload;
      return isRecord(payload) ? payload : {};
    },
    lastByType: (step_type: string): StepRecord | null => {
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if (step.type === step_type) return step;
      }
      return null;
    },
    lastStep: (): StepRecord | null =>
      steps.length > 0 ? steps[steps.length - 1]! : null,
    toolPending: (tool_call_id: string): string => {
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i]!;
        if (step.type === 'tool' && step.payload['tool_call_id'] === tool_call_id) {
          step.payload = { ...step.payload, status: 'pending' };
          return step.step_id;
        }
      }
      return '';
    },
  };
  return state;
}
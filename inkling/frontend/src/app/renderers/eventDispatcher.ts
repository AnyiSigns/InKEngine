/**
 * 事件分派基座：将 EngineEvent 归约为 MessageEntry 供消息流渲染。
 * R8 覆盖：spawn_start/spawn_end -> 子代理轻卡；simulate_decision/branch_result/swap_branch -> 推演树（波 3 视图）。
 */

import type { EventTypeName } from '@/shared/session/eventTypes';

export interface DispatchedEntry {
  id: string;
  kind: string;
  content: string;
  at: number;
  meta?: Record<string, unknown>;
  renderer: EventTypeName | 'fallback';
}

export function dispatchEvent(evt: { type: string; payload: Record<string, unknown>; at: number }): DispatchedEntry {
  const type = evt.type as EventTypeName;
  const id = `${type}-${evt.at}-${Math.random().toString(36).slice(2, 8)}`;

  if (type === 'reply_token') {
    return { id, kind: 'assistant', content: (evt.payload.text as string) || '', at: evt.at, renderer: 'reply_token' };
  }
  if (type === 'thinking_start' || type === 'thinking_end') {
    return { id, kind: 'thinking', content: (evt.payload.content as string) || '', at: evt.at, meta: evt.payload as Record<string, unknown>, renderer: type };
  }
  if (type === 'tool_start' || type === 'tool_end') {
    return { id, kind: 'tool', content: (evt.payload.output as string) || '', at: evt.at, meta: { ...evt.payload, status: type === 'tool_end' ? (evt.payload.status as string) || 'ok' : 'running' }, renderer: type };
  }
  if (type === 'spawn_start' || type === 'spawn_end') {
    return { id, kind: 'spawn', content: '', at: evt.at, meta: { ...evt.payload, count: (evt.payload.spawns as unknown as Array<unknown>)?.length ?? 1 }, renderer: 'spawn_start' };
  }
  if (type === 'review_card') {
    return { id, kind: 'event', content: '', at: evt.at, meta: { eventKind: 'review', ...evt.payload }, renderer: 'review_card' };
  }
  if (type === 'error') {
    return { id, kind: 'error', content: (evt.payload.message as string) || '未知错误', at: evt.at, meta: evt.payload as Record<string, unknown>, renderer: 'error' };
  }
  if (type === 'end') {
    return { id, kind: 'system', content: '回合结束', at: evt.at, meta: evt.payload as Record<string, unknown>, renderer: 'end' };
  }
  if (type === 'simulate_decision' || type === 'branch_result' || type === 'swap_branch') {
    return { id, kind: 'event', content: (evt.payload.summary as string) || '', at: evt.at, meta: { eventKind: 'simulation', ...evt.payload }, renderer: 'simulate_decision' };
  }
  if (type === 'assembly_candidate') {
    return { id, kind: 'event', content: '', at: evt.at, meta: { eventKind: 'assembly', ...evt.payload }, renderer: 'assembly_candidate' };
  }
  if (type === 'junction_verdict') {
    return { id, kind: 'event', content: '', at: evt.at, meta: { eventKind: 'junction', ...evt.payload }, renderer: 'junction_verdict' };
  }
  if (type === 'node_start') {
    return { id, kind: 'event', content: '', at: evt.at, meta: { eventKind: 'node', ...evt.payload }, renderer: 'node_start' };
  }
  if (type === 'signal_detected' || type === 'distill_outcome' || type === 'gate_verdict' || type === 'evolution_variant') {
    return { id, kind: 'event', content: (evt.payload.summary as string) || '', at: evt.at, meta: { eventKind: type, ...evt.payload }, renderer: type };
  }

  return { id, kind: 'event', content: (evt.payload.summary as string) || evt.type, at: evt.at, meta: evt.payload as Record<string, unknown>, renderer: 'fallback' };
}

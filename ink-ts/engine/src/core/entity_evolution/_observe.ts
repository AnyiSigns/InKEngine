/**
 * 实体演化观察侧（pipeline 私有观察方法段抽出，保持单文件 ≤350 行）：
 * 回合事件流 → 实体关联失败信号。观察状态经结构化接口注入（pipeline 的
 * underscore 字段公开对齐 Python 私有约定），公共面与语义不变——故障隔离
 * 仍在管线 send 外层吞异常，本文件只做纯观察归类。
 */

import type { EngineEvent } from '../events/events.js';
import { SIGNAL_PITFALL } from '../knowledge_signals/_types.js';
import { ExecutionSignal, SignalClassifier } from '../knowledge_signals/signals.js';
import { COLLAB_TOOL_NAME, _MAX_INCUBATING } from './_types.js';
import { _source_from_event } from './_util.js';

/** 观察侧所需管线状态面（结构化接口；pipeline 实例按形状满足）。 */
export interface EntityEvolutionObservationState {
  _classifier: SignalClassifier;
  _entity_signals: Map<string, ExecutionSignal[]>;
  _pending_signal_events: ExecutionSignal[];
  _collab_calls: Map<string, string>;
  collected_total: number;
}

/** 事件 → 实体归因（None = 无实体关联，实体演化不关心）。 */
function _entity_for(
  state: EntityEvolutionObservationState,
  etype: string,
  payload: Record<string, unknown>,
): string | null {
  if (etype === 'tool_end') {
    const call_id = payload['tool_call_id'];
    if (typeof call_id === 'string' && call_id) {
      const mapped = state._collab_calls.get(call_id);
      if (mapped !== undefined) {
        state._collab_calls.delete(call_id);
        return mapped;
      }
      return null;
    }
  }
  const context = payload['context'];
  if (typeof context === 'object' && context !== null && !Array.isArray(context)) {
    const entity_id = (context as Record<string, unknown>)['entity_id'];
    if (typeof entity_id === 'string' && entity_id) return entity_id;
  }
  return null;
}

/** 记忆 collab_request 调用的实体归因（tool_start → tool_end）。 */
function _remember_collab_call(
  state: EntityEvolutionObservationState,
  payload: Record<string, unknown>,
): void {
  if (payload['tool'] !== COLLAB_TOOL_NAME) return;
  const args = payload['args'];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return;
  const entity_id = (args as Record<string, unknown>)['entity_id'];
  if (typeof entity_id !== 'string' || !entity_id) return;
  const call_id = String(payload['tool_call_id'] ?? '');
  if (!call_id) return;
  if (state._collab_calls.size >= _MAX_INCUBATING) {
    const oldest = state._collab_calls.keys().next().value;
    if (oldest !== undefined) state._collab_calls.delete(oldest);
  }
  state._collab_calls.set(call_id, entity_id);
}

/** 按实体入缓冲（有界：超限丢最旧；collected_total 累计 + 待发射队列）。 */
function _buffer_for(
  state: EntityEvolutionObservationState,
  entity_id: string,
  signal: ExecutionSignal,
): void {
  const buffer = state._entity_signals.get(entity_id) ?? [];
  buffer.push(signal);
  if (buffer.length > _MAX_INCUBATING) buffer.shift();
  state._entity_signals.set(entity_id, buffer);
  state.collected_total += 1;
  state._pending_signal_events.push(signal);
}

/** 观察回合事件流（EngineTransport.send 主体；异常由调用方吞）。 */
export async function _observe(
  state: EntityEvolutionObservationState,
  event: EngineEvent,
): Promise<void> {
  const payload = event.payload ?? {};
  if (event.type === 'tool_start') {
    _remember_collab_call(state, payload);
    return;
  }
  const entity_id = _entity_for(state, event.type, payload);
  if (entity_id === null) return;
  if (event.type === 'tool_end' && payload['success'] === false) {
    const message =
      String(payload['message'] || '工具执行失败') ||
      `工具执行失败: ${String(payload['tool'] ?? '')}`;
    const signal = new ExecutionSignal({
      kind: SIGNAL_PITFALL,
      message,
      source: _source_from_event(event),
      context: { entity_id, ...payload },
    });
    _buffer_for(state, entity_id, signal);
    return;
  }
  const signal = state._classifier.classify({
    type: event.type,
    message: payload['message'],
    source: _source_from_event(event),
    context: { entity_id, ...payload },
  });
  if (signal !== null) {
    _buffer_for(state, entity_id, signal);
  }
}

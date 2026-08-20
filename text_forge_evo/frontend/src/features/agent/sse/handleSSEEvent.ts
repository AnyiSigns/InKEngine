/**
 * SSE 事件处理：内置事件类型处理器注册 + 回合分发。
 *
 * 事件处理注册表化：每个事件类型的行为（建卡/更新/收尾）注册为
 * 独立处理器（registerEventHandler），分发查注册表；未注册事件
 * 类型走折叠兜底（写入 unknown 折叠卡，展示原始 JSON——回放不崩，
 * AI 提案的新类型在注册前照常可见）。
 */

import { emitAgentChapterContentRefresh, emitAgentTitle } from '../agentEvents';
import { useAgentStore } from '../agentStore';
import { eventHandler, registerEventHandler } from '../eventRegistry';
import type { SSEHandlerContext } from '../eventRegistry';
import { formatSuggestions } from '../suggestionsFormat';
import { assertNodeEnd, assertReviewCard, assertStepEvent, assertToolEnd } from '@/shared/api/sseGuards';
import type { SSEEvent } from '@/shared/api/types';

/** 回合归属（首个 SSE 事件到达时锁定活动回合；防御依据）。 */
function roundOf(ctx: SSEHandlerContext, event: SSEEvent): string {
  if (event.round_id) {
    ctx.setActiveRoundId(event.round_id);
    return event.round_id;
  }
  return useAgentStore.getState().activeRoundId || '';
}

function stepIdOf(event: SSEEvent): string {
  return event.step_id || '';
}

/** 记忆命中合并语义与后端 RoundSteps.memory_hit 对齐：按 id 合并去重。 */
function mergeMemories(
  existing: Array<{ id: unknown; title: string; snippet: string }> | undefined,
  hits: Array<{ id: unknown; title: string; snippet: string }>,
): Array<{ id: unknown; title: string; snippet: string }> {
  const merged = [...(existing ?? [])];
  for (const hit of hits) {
    if (!merged.some((m) => m.id === hit.id)) merged.push(hit);
  }
  return merged;
}

/**
 * 内置事件处理器注册（模块加载时执行一次）：协议 v2 全部建卡/更新
 * 事件；每条处理器按 (step_id, round_id) 精确 upsert，状态更新不
 * 依赖「最近一张 running 卡」启发式。
 */
function registerBuiltinEventHandlers(): void {
  registerEventHandler('reply_token', (ctx, event) => {
    // 正文流：rAF 批处理后按 (step_id, round_id) 追加到当前正文段
    const token = event.token || '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (token && stepId && roundId) {
      assertStepEvent(event);
      ctx.scheduleToken(stepId, roundId, token);
    }
  });

  registerEventHandler('thinking_start', (ctx, event) => {
    // 思考卡（路由决策推理）：流水线 start/token/end 精确建卡/更新
    ctx.flushTokens();
    ctx.commitStreaming();
    ctx.replyRef.current = '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({ role: 'assistant', type: 'thinking', status: 'running', content: '' }),
      patch: (m) => ({ ...m, status: 'running' as const }),
    });
  });

  registerEventHandler('thinking_token', (ctx, event) => {
    const token = event.token || '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (token && stepId) {
      ctx.upsertStep({
        stepId,
        roundId,
        create: () => ({ role: 'assistant', type: 'thinking', status: 'running', content: token }),
        patch: (m) => ({ ...m, content: (m.content || '') + token }),
      });
    }
  });

  registerEventHandler('thinking_end', (ctx, event) => {
    // 空思考卡不残留（后端空思考不落库，实时同样移除）。
    // 移除必须限定 thinking 类型：step_id 可能命中的是其它卡（防御性校验）。
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    const existing = useAgentStore.getState().messages.find(
      (m) => m.stepId === stepId && m.roundId === roundId,
    );
    if (existing && existing.type === 'thinking' && !(existing.content || '').trim()) {
      useAgentStore.setState((s) => ({
        messages: s.messages.filter(
          (m) => !(m.stepId === stepId && m.roundId === roundId),
        ),
      }));
      return;
    }
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({ role: 'assistant', type: 'thinking', status: 'completed', content: '' }),
      patch: (m) => ({ ...m, status: 'completed' as const }),
    });
  });

  registerEventHandler('plan_start', (ctx, event) => {
    // 规划卡（域监督者）：与思考卡同构
    ctx.flushTokens();
    ctx.commitStreaming();
    ctx.replyRef.current = '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({ role: 'assistant', type: 'plan', status: 'running', content: '' }),
      patch: (m) => ({ ...m, status: 'running' as const }),
    });
  });

  registerEventHandler('plan_token', (ctx, event) => {
    const token = event.token || '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (token && stepId) {
      ctx.upsertStep({
        stepId,
        roundId,
        create: () => ({ role: 'assistant', type: 'plan', status: 'running', content: token }),
        patch: (m) => ({ ...m, content: (m.content || '') + token }),
      });
    }
  });

  registerEventHandler('plan_end', (ctx, event) => {
    // 空规划卡不残留（后端空规划不落库，实时同样移除）。
    // 移除必须限定 plan 类型：step_id 可能命中的是其它卡（防御性校验）。
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    const existing = useAgentStore.getState().messages.find(
      (m) => m.stepId === stepId && m.roundId === roundId,
    );
    if (existing && existing.type === 'plan' && !(existing.content || '').trim()) {
      useAgentStore.setState((s) => ({
        messages: s.messages.filter(
          (m) => !(m.stepId === stepId && m.roundId === roundId),
        ),
      }));
      return;
    }
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({ role: 'assistant', type: 'plan', status: 'completed', content: '' }),
      patch: (m) => ({ ...m, status: 'completed' as const }),
    });
  });

  registerEventHandler('memory_hit', (ctx, event) => {
    // 记忆命中挂所属步骤（后端已把 step_id 指向最近 plan/thinking 卡）；
    // 合并语义与后端 RoundSteps.memory_hit 一致（按 id 去重追加）
    const hits = Array.isArray(event.hits) ? event.hits : [];
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (hits.length > 0 && stepId) {
      ctx.upsertStep({
        stepId,
        roundId,
        create: () => ({ role: 'assistant', type: 'plan', status: 'completed', content: '', memories: hits }),
        patch: (m) =>
          m.type === 'plan' || m.type === 'thinking'
            ? { ...m, memories: mergeMemories(m.memories, hits) }
            : m,
      });
    }
  });

  registerEventHandler('tool_start', (ctx, event) => {
    // 工具卡：正文段在工具边界切段（定型流式气泡）
    ctx.flushTokens();
    ctx.commitStreaming();
    ctx.replyRef.current = '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertStepEvent(event);
    const category = event.category || '';
    const toolCallId = event.tool_call_id || '';
    if (category) ctx.onToolCategory?.(category);
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        type: 'tool',
        category,
        toolCallId,
        toolStatus: 'running',
        content: '',
      }),
      patch: (m) => ({
        ...m,
        ...(m.type === 'tool' ? { category, toolCallId, toolStatus: 'running' as const, toolSuccess: undefined } : {}),
      }),
    });
  });

  registerEventHandler('tool_end', (ctx, event) => {
    // 工具卡收尾：success=false 置 error，使失败语义真正可达
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertToolEnd(event);
    const success = event.success;
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        type: 'tool',
        category: event.category || '',
        toolStatus: success === false ? 'error' : 'done',
        toolSuccess: success,
        content: '',
      }),
      patch: (m) => ({
        ...m,
        toolStatus: (success === false ? 'error' : 'done') as 'done' | 'error',
        ...(success !== undefined ? { toolSuccess: success } : {}),
      }),
    });
  });

  registerEventHandler('node_start', (ctx, event) => {
    // 节点卡：正文段切段；进度内嵌（生成通道按章 N/M）
    ctx.flushTokens();
    ctx.commitStreaming();
    ctx.replyRef.current = '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertStepEvent(event);
    const nodeId = event.node_id || event.label || '';
    const label = event.label || nodeId;
    const progress =
      event.total && event.n
        ? { step: 'write', n: event.n, total: event.total }
        : undefined;
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        type: 'node',
        nodeId,
        label,
        nodeStatus: 'running',
        content: '',
        ...(progress ? { progress } : {}),
      }),
      patch: (m) => ({
        ...m,
        ...(m.type === 'node' ? { nodeStatus: 'running' as const, label, ...(progress ? { progress } : {}) } : {}),
      }),
    });
  });

  registerEventHandler('node_stream', (ctx, event) => {
    // 节点正文 rAF 批处理（按 step_id 归属）
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    const token = event.token || '';
    if (stepId && token) {
      ctx.scheduleNodeOutput(stepId, roundId, token);
    }
  });

  registerEventHandler('node_end', (ctx, event) => {
    ctx.flushNodeOutputs();
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertNodeEnd(event);
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        type: 'node',
        nodeId: event.node_id || '',
        label: event.label || event.node_id || '',
        nodeStatus: 'completed',
        content: '',
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
      }),
      patch: (m) => ({
        ...m,
        ...(m.type === 'node'
          ? {
              nodeStatus: 'completed' as const,
              ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
            }
          : {}),
      }),
    });
  });

  registerEventHandler('node_fail', (ctx, event) => {
    ctx.flushNodeOutputs();
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertNodeEnd(event);
    const reason = event.reason || '';
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        type: 'node',
        nodeId: event.node_id || '',
        label: event.label || event.node_id || '',
        nodeStatus: 'failed',
        reason,
        content: '',
      }),
      patch: (m) => ({
        ...m,
        ...(m.type === 'node' ? { nodeStatus: 'failed' as const, reason } : {}),
      }),
    });
  });

  registerEventHandler('review_card', (ctx, event) => {
    // 审核卡：正文段切段；门控卡到达时把匹配工具卡置 pending
    ctx.flushTokens();
    ctx.commitStreaming();
    ctx.replyRef.current = '';
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (!stepId) return;
    assertReviewCard(event);
    const payload = event as unknown as Record<string, unknown>;
    ctx.setPendingReview(payload);
    ctx.upsertStep({
      stepId,
      roundId,
      create: () => ({
        role: 'assistant',
        content: '',
        type: 'review-card',
        token: JSON.stringify(event),
        live: true,
      }),
    });
    const gatedId = event.tool_call_id || '';
    if (gatedId) {
      useAgentStore.setState((s) => ({
        messages: s.messages.map((m) =>
          m.type === 'tool' && m.roundId === roundId
            && m.toolStatus === 'running'
            && (gatedId ? m.toolCallId === gatedId : true)
            ? { ...m, toolStatus: 'pending' as const }
            : m,
        ),
      }));
    }
  });

  registerEventHandler('suggestions', (ctx, event) => {
    const content = formatSuggestions(event.items);
    const stepId = stepIdOf(event);
    const roundId = roundOf(ctx, event);
    if (content && stepId) {
      ctx.upsertStep({
        stepId,
        roundId,
        create: () => ({ role: 'assistant', type: 'suggestions', content }),
        patch: (m) => ({ ...m, content }),
      });
    }
  });

  registerEventHandler('chapter_written', (_ctx, event) => {
    // 章节落库通知：手稿编辑器按 chapterId 定向刷新
    if (typeof event.chapter_id === 'number') {
      emitAgentChapterContentRefresh(event.chapter_id);
    }
  });

  registerEventHandler('title_update', (_ctx, event) => {
    // 会话标题唯一通道
    if (event.thread_id && event.title) {
      emitAgentTitle(event.thread_id, event.title);
    }
  });

  // 静默信号：不独立建卡（工具卡/正文流已承载其展示）
  registerEventHandler('tool_audit', () => undefined);
  registerEventHandler('end', () => undefined);
}

registerBuiltinEventHandlers();

/** 未注册事件类型：折叠兜底卡（展示原始 JSON，直播 = 回放不崩）。 */
function foldUnknownEvent(ctx: SSEHandlerContext, event: SSEEvent): void {
  const roundId = roundOf(ctx, event);
  const stepId = stepIdOf(event);
  ctx.upsertStep({
    stepId: stepId || `unknown:${event.type}`,
    roundId,
    create: () => ({
      role: 'assistant',
      type: 'unknown',
      content: '',
      token: JSON.stringify(event),
    }),
  });
}

/**
 * SSE 事件处理工厂（协议 v2）：注入 agentStore 写入依赖与回合级 refs，
 * 返回纯事件处理器。分发查事件处理注册表；未注册类型折叠展示。
 */
export function createSSEHandler(ctx: SSEHandlerContext): (event: SSEEvent) => void {
  return (event: SSEEvent): void => {
    // T6 重新生成信号：先于分发短路处理——该事件的 round_id 是目标
    // （旧）回合，若经 roundOf 调用 setActiveRoundId 会把新回合本地消息
    // 回填为旧回合，导致失效区推导错误。
    if (event.type === 'regenerated_from') {
      if (event.round_id) {
        useAgentStore.getState().markInvalidFrom(event.round_id);
      }
      return;
    }
    const handler = eventHandler(event.type);
    if (handler) {
      handler(ctx, event);
      return;
    }
    foldUnknownEvent(ctx, event);
  };
}

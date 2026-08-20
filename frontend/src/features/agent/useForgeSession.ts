/**
 * Forge 对话回合会话钩子：POST /api/chat → SSE 事件流 → agentStore。
 *
 * 会话 = 前端持有 threadId（首回合生成）；回合 = 一次 POST 的 SSE 流。
 * 事件分发复用 remastered 的 createSSEHandler（协议 v2 精确更新语义），
 * end 事件为回合终点（commitStreaming + 关闭流式状态），error 事件
 * 渲染为错误卡（后端兜底 end 收尾，前端不依赖 error 判定回合结束）。
 *
 * 审批决议（resolveReview）：回合挂起（审批卡）后 POST /api/chat/resume
 * 注入决议重入续跑——accept/reject/edit/terminate 与引擎 approval
 * 机制对齐；决议提交后审批卡置只读（审批记录保留，历史不撒谎）。
 */

import { useCallback, useRef } from 'react';

import { readSSE } from '@/shared/api/sse';
import type { SSEEvent } from '@/shared/api/types';

import { useAgentStore } from './agentStore';
import { createSSEHandler } from './sse/handleSSEEvent';
import { useStreamBuffer } from './sse/useStreamBuffer';

export interface UseForgeSessionResult {
  /** 发起一个回合（流式渲染直至 end 事件） */
  sendMessage: (text: string) => Promise<void>;
  /** 审批决议注入（挂起回合重入续跑；决议后卡只读） */
  resolveReview: (decision: string, editedContent?: string, reason?: string) => Promise<void>;
  /** 中止当前回合（abort 请求并复位流式状态） */
  abort: () => void;
}

export function useForgeSession(): UseForgeSessionResult {
  const setStreaming = useAgentStore((s) => s.setStreaming);
  const setThreadId = useAgentStore((s) => s.setThreadId);
  const addMessage = useAgentStore((s) => s.addMessage);
  const commitStreaming = useAgentStore((s) => s.commitStreaming);
  const {
    flushTokens,
    scheduleToken,
    scheduleNodeOutput,
    flushNodeOutputs,
    replyRef,
    resetBuffers,
  } = useStreamBuffer();

  const threadIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /** 消费一个 SSE 流（发送请求 → 事件分发 → 收尾），回合共用路径。 */
  const streamRound = useCallback(
    async (path: string, body: Record<string, unknown>, onError: (message: string) => void) => {
      resetBuffers();
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;
      let ended = false;
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          let detail = `请求失败（${response.status}）`;
          try {
            const data = (await response.json()) as { detail?: unknown };
            if (typeof data.detail === 'string') detail = data.detail;
          } catch {
            // 非 JSON 响应，保留默认文案
          }
          onError(detail);
          ended = true;
          return;
        }
        const handler = createSSEHandler({
          upsertStep: useAgentStore.getState().upsertStep,
          appendReplyToken: useAgentStore.getState().appendReplyToken,
          addMessage: useAgentStore.getState().addMessage,
          setPendingReview: useAgentStore.getState().setPendingReview,
          setActiveRoundId: useAgentStore.getState().setActiveRoundId,
          commitStreaming: useAgentStore.getState().commitStreaming,
          flushTokens,
          scheduleToken,
          scheduleNodeOutput,
          flushNodeOutputs,
          replyRef,
        });
        await readSSE(response, (raw) => {
          const event = raw as unknown as SSEEvent;
          if (event.type === 'end') {
            ended = true;
            commitStreaming();
            setStreaming(false);
            return;
          }
          if (event.type === 'error') {
            addMessage({
              role: 'assistant',
              type: 'error',
              content: String(event.message || '回合执行失败'),
            });
            return;
          }
          handler(event);
        });
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
          commitStreaming();
        } else {
          addMessage({
            role: 'assistant',
            type: 'error',
            content: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        abortRef.current = null;
        if (!ended) {
          commitStreaming();
          setStreaming(false);
        }
      }
    },
    [
      setStreaming,
      addMessage,
      commitStreaming,
      flushTokens,
      scheduleToken,
      scheduleNodeOutput,
      flushNodeOutputs,
      replyRef,
      resetBuffers,
    ],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || abortRef.current) return;
      if (threadIdRef.current === null) {
        threadIdRef.current = crypto.randomUUID();
      }
      const threadId = threadIdRef.current;
      setThreadId(threadId);
      addMessage({ role: 'user', content: message });
      await streamRound('/api/chat', { message, thread_id: threadId }, (detail) => {
        addMessage({ role: 'assistant', type: 'error', content: detail });
      });
    },
    [setThreadId, addMessage, streamRound],
  );

  const resolveReview = useCallback(
    async (decision: string, editedContent?: string, reason?: string) => {
      const threadId = useAgentStore.getState().threadId || threadIdRef.current;
      if (!threadId || abortRef.current) return;
      const body: Record<string, unknown> = { thread_id: threadId, decision };
      if (editedContent !== undefined && editedContent !== '') {
        body.edited_content = editedContent;
      }
      if (reason !== undefined && reason !== '') {
        body.reason = reason;
      }
      await streamRound('/api/chat/resume', body, (detail) => {
        addMessage({ role: 'assistant', type: 'error', content: detail });
      });
      // 决议提交后审批卡置只读（审批记录保留，历史不撒谎）
      useAgentStore.setState((s) => ({
        pendingReview: null,
        messages: s.messages.map((m) =>
          m.type === 'review-card' && m.live !== false ? { ...m, live: false } : m,
        ),
      }));
    },
    [addMessage, streamRound],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { sendMessage, resolveReview, abort };
}

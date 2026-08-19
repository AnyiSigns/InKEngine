/**
 * Forge 对话回合会话钩子：POST /api/chat → SSE 事件流 → agentStore。
 *
 * 会话 = 前端持有 threadId（首回合生成）；回合 = 一次 POST 的 SSE 流。
 * 事件分发复用 remastered 的 createSSEHandler（协议 v2 精确更新语义），
 * end 事件为回合终点（commitStreaming + 关闭流式状态），error 事件
 * 渲染为错误卡（后端兜底 end 收尾，前端不依赖 error 判定回合结束）。
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
      resetBuffers();
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let ended = false;
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, thread_id: threadId }),
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
          addMessage({ role: 'assistant', type: 'error', content: detail });
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
      setThreadId,
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

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { sendMessage, abort };
}

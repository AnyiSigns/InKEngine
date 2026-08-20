
import { useCallback, useEffect, useRef } from 'react';
import { useAgentStore } from '../agentStore';

/**
 * Agent SSE reply_token / node_stream 的 rAF 节流器。
 *
 * token 流攒批一帧内多次 token 再写一次 store，避免每 token 全量
 * set store 导致长消息列表 O(n²) 重渲；node_stream 输出同样 rAF 批处理。
 * 缓冲按 (stepId, roundId) 归属（协议 v2 精确更新语义）。
 */
export function useStreamBuffer() {
  const appendReplyToken = useAgentStore((s) => s.appendReplyToken);
  const upsertStep = useAgentStore((s) => s.upsertStep);

  /** 已提交回复正文（end.reply 与该值比对，相同则跳过冗余写入） */
  const replyRef = useRef('');
  /** 攒批中的未提交 token 与归属（stepId/roundId） */
  const pendingTokenRef = useRef('');
  const pendingStepRef = useRef({ stepId: '', roundId: '' });
  const rafHandleRef = useRef<number | null>(null);
  /** stepId → 攒批中的未提交节点输出（追加语义） */
  const nodeOutputBufferRef = useRef<Record<string, string>>({});
  const nodeStepRef = useRef<Record<string, string>>({});
  const nodeRafRef = useRef<number | null>(null);

  const flushNodeOutputs = useCallback(() => {
    if (nodeRafRef.current !== null) {
      cancelAnimationFrame(nodeRafRef.current);
      nodeRafRef.current = null;
    }
    const buf = nodeOutputBufferRef.current;
    if (Object.keys(buf).length === 0) return;
    nodeOutputBufferRef.current = {};
    const steps = nodeStepRef.current;
    nodeStepRef.current = {};
    for (const [stepId, token] of Object.entries(buf)) {
      const roundId = steps[stepId] || '';
      if (!roundId) continue;
      upsertStep({
        stepId,
        roundId,
        create: () => ({ role: 'assistant', content: '', type: 'node' }),
        patch: (m) => ({ ...m, content: (m.content || '') + token }),
      });
    }
  }, [upsertStep]);

  const scheduleNodeOutput = useCallback(
    (stepId: string, roundId: string, token: string) => {
      nodeOutputBufferRef.current[stepId] =
        (nodeOutputBufferRef.current[stepId] || '') + token;
      nodeStepRef.current[stepId] = roundId;
      if (nodeRafRef.current === null) {
        nodeRafRef.current = requestAnimationFrame(() => {
          nodeRafRef.current = null;
          flushNodeOutputs();
        });
      }
    },
    [flushNodeOutputs],
  );

  const flushTokens = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    const text = pendingTokenRef.current;
    const { stepId, roundId } = pendingStepRef.current;
    pendingTokenRef.current = '';
    pendingStepRef.current = { stepId: '', roundId: '' };
    if (text && stepId && roundId) {
      replyRef.current += text;
      appendReplyToken(stepId, roundId, text);
    }
  }, [appendReplyToken]);

  const scheduleToken = useCallback(
    (stepId: string, roundId: string, token: string) => {
      if (!token) return;
      if (!pendingTokenRef.current) {
        pendingStepRef.current = { stepId, roundId };
      }
      pendingTokenRef.current += token;
      if (rafHandleRef.current === null) {
        rafHandleRef.current = requestAnimationFrame(() => {
          rafHandleRef.current = null;
          const text = pendingTokenRef.current;
          const { stepId: sid, roundId: rid } = pendingStepRef.current;
          pendingTokenRef.current = '';
          if (text && sid && rid) {
            replyRef.current += text;
            appendReplyToken(sid, rid, text);
          }
        });
      }
    },
    [appendReplyToken],
  );

  // abort 用：取消 rAF 并清空 token 缓冲与已提交回复（避免 catch 里 flush 追加新消息）
  const discardTokenBuffer = useCallback(() => {
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    pendingTokenRef.current = '';
    replyRef.current = '';
  }, []);

  // 新回合复位：token + node 缓冲一并清空（旧回合残留的未冲刷 token 一并丢弃）
  const resetBuffers = useCallback(() => {
    pendingTokenRef.current = '';
    replyRef.current = '';
    pendingStepRef.current = { stepId: '', roundId: '' };
    if (rafHandleRef.current !== null) {
      cancelAnimationFrame(rafHandleRef.current);
      rafHandleRef.current = null;
    }
    nodeOutputBufferRef.current = {};
    nodeStepRef.current = {};
    if (nodeRafRef.current !== null) {
      cancelAnimationFrame(nodeRafRef.current);
      nodeRafRef.current = null;
    }
  }, []);

  // 组件卸载时清理 rAF，避免 setState after unmount 告警
  useEffect(() => {
    return () => {
      if (rafHandleRef.current !== null) cancelAnimationFrame(rafHandleRef.current);
      if (nodeRafRef.current !== null) cancelAnimationFrame(nodeRafRef.current);
    };
  }, []);

  return {
    flushTokens,
    scheduleToken,
    flushNodeOutputs,
    scheduleNodeOutput,
    discardTokenBuffer,
    resetBuffers,
    replyRef,
  };
}

/**
 * 会话状态管理：封装 ChannelHub + 事件归约，提供 hook 给产品组件。
 */

import { useSyncExternalStore, useCallback } from 'react';
import { ChannelHub } from '@/shared/session/channelHub';
import {
  submitUserRound,
  toEngineAttachments,
  setStreaming,
  setRoundInflight,
  finalizeThreadStreaming,
  setThreadRoundActive,
  type AttachmentAsset,
} from '@/shared/session/eventIngest';
import type { BackendAdapter, ModelSelection } from '@/shared/backend/backendAdapter';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage } from '@/shared/session/types';
import type { ReviewResolution } from '@/components/review_card';

export interface SessionState {
  activeSessionId: string;
  sessions: Array<{ id: string; title: string; updated_at: number }>;
  entries: InkMessage[];
  streaming: boolean;
  pendingReview: Record<string, unknown> | null;
}

export function createSessionState(hub: ChannelHub, store: SessionStore, _backend: BackendAdapter): SessionState {
  return {
    get activeSessionId() { return hub.getSnapshot().activeSessionId as string || ''; },
    get sessions() { return store.list().map((s) => ({ id: s.id, title: s.title, updated_at: s.lastActiveAt })); },
    get entries() { return hub.getSnapshot().messages || []; },
    get streaming() { return hub.getSnapshot().streaming as boolean || false; },
    get pendingReview() { return hub.getSnapshot().pendingReview as Record<string, unknown> | null || null; },
  };
}

export function useSessionState(hub: ChannelHub, store: SessionStore, backend: BackendAdapter) {
  const state = createSessionState(hub, store, backend);
  return useSyncExternalStore(
    (cb) => {
      // 会话元数据（store）与回合事件态（hub）任一变更都触发重渲，
      // 主链路（消息流/审批卡/任务胶囊/模拟分支）由此实时跟随事件流。
      const unsubStore = store.subscribe(cb);
      const unsubHub = hub.subscribeState(cb);
      return () => {
        unsubStore();
        unsubHub();
      };
    },
    () => state,
    () => state,
  );
}

export function useSessionActions(hub: ChannelHub, store: SessionStore, backend: BackendAdapter) {
  const send = useCallback(
    (
      text: string,
      attachments: AttachmentAsset[] = [],
      mode: 'standard' | 'assembly' = 'standard',
      model?: ModelSelection,
    ) => {
      if (!backend.available) {
        // 无宿主 = 不产生假回复（演示占位路径已移除）；由装配层提示宿主不可用
        return;
      }
      if (hub.getSnapshot().streaming) return;
      const activeId = hub.getSnapshot().activeSessionId as string || store.list()[0]?.id || '';
      if (!activeId) return;
      const roundId = submitUserRound(hub, text, attachments);
      // 回合收尾线程化：定型的是「发起的线程」的消息流，窗口切走后不得
      // 污染当前窗口（commitStreaming 只作用于桶/该线程镜像）
      const finishThread = () => {
        setRoundInflight(false);
        finalizeThreadStreaming(hub, activeId);
        setThreadRoundActive(hub, activeId, false);
        if (hub.getSnapshot().activeSessionId === activeId) {
          setStreaming(hub, false);
        }
      };
      setRoundInflight(true);
      void backend
        .roundSend(activeId, roundId, text, false, toEngineAttachments(attachments), mode, model)
        .then(() => {
          finishThread();
          // 回合收尾刷新会话记录（标题生成/更新时间落库后镜像同步）
          void (store as { reload?: () => Promise<void> }).reload?.();
        })
        .catch(() => finishThread());
    },
    [hub, store, backend],
  );

  const abort = useCallback(() => {
    setRoundInflight(false);
    const roundId = hub.getSnapshot().roundId;
    const threadId = hub.getSnapshot().activeSessionId;
    if (backend.available && roundId) {
      void backend.roundAbort(roundId).catch(() => undefined);
    }
    if (threadId) setThreadRoundActive(hub, threadId, false);
    setStreaming(hub, false);
    hub.setState({ streaming: false, roundId: null });
  }, [hub, backend]);

  /**
   * 审批卡决议续跑：回合内工具审批卡（review_card 事件）决议后，把回合
   * 从引擎 checkpoint 续跑（round_resume 注入真实中断 key）。决议形态
   * accept/reject/terminate 直传壳，edit 携带编辑内容。回合未终态时引擎
   * 会再发新卡（事件流重设 pendingReview），用户逐卡决议直至回复。
   */
  const resolveReview = useCallback(
    (key: string, resolution: ReviewResolution, editedContent?: string, targetThread?: string) => {
      const activeId = hub.getSnapshot().activeSessionId as string || store.list()[0]?.id || '';
      if (!backend.available || !activeId) {
        hub.setState({ pendingReview: null });
        return;
      }
      hub.setState({ pendingReview: null });
      // 决议目标线程 = 卡所属线程（payload.thread_id，卡线程可能已非活动
      // 窗口）；缺省回落当前窗口。引擎 round_resume 以该线程续跑。
      const threadId =
        targetThread && targetThread !== '-' && targetThread !== '' ? targetThread : activeId;
      setThreadRoundActive(hub, threadId, true);
      setRoundInflight(true);
      if (hub.getSnapshot().activeSessionId === threadId) {
        setStreaming(hub, true);
      }
      const finishThread = () => {
        setRoundInflight(false);
        finalizeThreadStreaming(hub, threadId);
        setThreadRoundActive(hub, threadId, false);
        if (hub.getSnapshot().activeSessionId === threadId) {
          setStreaming(hub, false);
        }
      };
      void backend
        .roundResume(threadId, key, resolution, undefined, resolution === 'edit' ? editedContent : undefined)
        .then(() => {
          finishThread();
          // 回合收尾刷新会话记录（与 send 同口径）
          void (store as { reload?: () => Promise<void> }).reload?.();
        })
        .catch(() => finishThread());
    },
    [hub, store, backend],
  );

  return { send, abort, resolveReview };
}

/**
 * 会话状态管理：封装 ChannelHub + 事件归约，提供 hook 给产品组件。
 */

import { useSyncExternalStore, useCallback } from 'react';
import { ChannelHub } from '@/shared/session/channelHub';
import { submitUserMessage, submitUserRound, toEngineAttachments, setStreaming, commitStreaming, type AttachmentAsset } from '@/shared/session/eventIngest';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage } from '@/shared/session/types';

export interface SessionState {
  activeSessionId: string;
  sessions: Array<{ id: string; title: string; updated_at: number }>;
  entries: InkMessage[];
  streaming: boolean;
  pendingReview: Record<string, unknown> | null;
  models?: { profiles: Array<{ id: string; name: string; tier: string; occupancy: number; limit: number; multimodal?: boolean }> };
  authorized: boolean;
}

export function createSessionState(hub: ChannelHub, store: SessionStore, _backend: BackendAdapter): SessionState {
  return {
    get activeSessionId() { return hub.getSnapshot().activeSessionId as string || ''; },
    get sessions() { return store.list().map((s) => ({ id: s.id, title: s.title, updated_at: s.lastActiveAt })); },
    get entries() { return hub.getSnapshot().messages || []; },
    get streaming() { return hub.getSnapshot().streaming as boolean || false; },
    get pendingReview() { return hub.getSnapshot().pendingReview as Record<string, unknown> | null || null; },
    get authorized() { return false; },
    get models() { return undefined; },
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
    (text: string, attachments: AttachmentAsset[] = []) => {
      if (!backend.available) {
        submitUserMessage(hub, text, attachments);
        return;
      }
      if (hub.getSnapshot().streaming) return;
      const activeId = hub.getSnapshot().activeSessionId as string || store.list()[0]?.id || '';
      if (!activeId) return;
      const roundId = submitUserRound(hub, text, attachments);
      const finish = () => {
        commitStreaming(hub);
        setStreaming(hub, false);
      };
      void backend
        .roundSend(activeId, roundId, text, false, toEngineAttachments(attachments))
        .then(() => {
          finish();
          // 回合收尾刷新会话记录（标题生成/更新时间落库后镜像同步）
          void (store as { reload?: () => Promise<void> }).reload?.();
        })
        .catch(() => finish());
    },
    [hub, store, backend],
  );

  const abort = useCallback(() => {
    const roundId = hub.getSnapshot().roundId;
    if (backend.available && roundId) {
      void backend.roundAbort(roundId).catch(() => undefined);
    }
    setStreaming(hub, false);
    hub.setState({ streaming: false, roundId: null });
  }, [hub, backend]);

  return { send, abort };
}

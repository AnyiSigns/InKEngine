/**
 * 会话状态管理：封装 ChannelHub + 事件归约，提供 hook 给产品组件。
 */

import { useSyncExternalStore, useCallback } from 'react';
import { ChannelHub } from '@/shared/session/channelHub';
import { ingestEvent, type AttachmentAsset } from '@/shared/session/eventIngest';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { SessionStore } from '@/shared/session/sessionStore';

export interface SessionState {
  activeSessionId: string;
  sessions: Array<{ id: string; title: string; updated_at: number }>;
  entries: MessageEntry[];
  streaming: boolean;
  pendingReview: Record<string, unknown> | null;
  models?: { profiles: Array<{ id: string; name: string; tier: string; occupancy: number; limit: number; multimodal?: boolean }> };
  authorized: boolean;
}

export interface MessageEntry {
  id: string;
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'event' | 'spawn' | 'system' | 'error';
  content?: string;
  at: number;
  meta?: Record<string, unknown>;
}

export function createSessionState(hub: ChannelHub, store: SessionStore, _backend: BackendAdapter): SessionState {
  return {
    get activeSessionId() { return hub.getSnapshot().activeSessionId as string || ''; },
    get sessions() { return store.list().map((s) => ({ id: s.id, title: s.title, updated_at: s.lastActiveAt })); },
    get entries() { return (hub.getSnapshot().messages as MessageEntry[]) || []; },
    get streaming() { return hub.getSnapshot().streaming as boolean || false; },
    get pendingReview() { return hub.getSnapshot().pendingReview as Record<string, unknown> | null || null; },
    get authorized() { return false; },
    get models() { return undefined; },
  };
}

export function useSessionState(hub: ChannelHub, store: SessionStore, backend: BackendAdapter) {
  const state = createSessionState(hub, store, backend);
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => state,
    () => state,
  );
}

export function useSessionActions(hub: ChannelHub, store: SessionStore, backend: BackendAdapter) {
  const send = useCallback(
    (text: string, attachments: AttachmentAsset[] = []) => {
      if (!backend.available) {
        ingestEvent(hub, { type: 'user_message', payload: { text, attachments }, at: Date.now() });
        return;
      }
      const activeId = hub.getSnapshot().activeSessionId as string || store.list()[0]?.id || '';
      if (!activeId) return;
      const roundId = `round-${Date.now()}`;
      void backend.roundSend(activeId, roundId, text, false, attachments.filter((a) => a.url).map((a) => ({ kind: a.kind, url: a.url!, name: a.name, mime: a.mime }))).catch(() => undefined);
    },
    [hub, store, backend],
  );

  const abort = useCallback(() => {
    hub.setState({ streaming: false, roundId: null });
  }, [hub]);

  return { send, abort };
}

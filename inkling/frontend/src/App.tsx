/**
 * InKling 前端产品面装配：三栏布局 + 消息流 + 输入行。
 */

import { useState } from 'react';
import { TopBar } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { InputBar } from '@/app/input/InputBar';
import { MessageStream } from '@/app/session/MessageStream';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { RoundStep } from '@/shared/session/types';

interface AppProps {
  backend: BackendAdapter;
  hub: ChannelHub;
  sessionStore: SessionStore;
}

export default function App({ backend, hub, sessionStore }: AppProps) {
  const state = useSessionState(hub, sessionStore, backend);
  const { send, abort } = useSessionActions(hub, sessionStore, backend);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [title, setTitle] = useState('新会话');

  const handleBranchFromMessage = (messageId: string, branchLabel: string) => {
    void backend.sessionBranch(state.activeSessionId, 'branch', null).then(() => {
      console.log('分支已创建', branchLabel, messageId);
    }).catch(() => undefined);
  };

  return (
    <div className="ink-app flex h-screen w-full flex-col overflow-hidden">
      <TopBar title={title} unreadCount={0} onTitleChange={setTitle} />
      <div className="flex flex-1 overflow-hidden">
        <LeftRail collapsed={leftCollapsed} onToggle={() => setLeftCollapsed(!leftCollapsed)} authorized={state.authorized} onAddWorkspace={() => {}} />
        <main className="flex flex-1 flex-col overflow-hidden">
          <MessageStream
            entries={state.entries}
            streaming={state.streaming}
            roundSteps={(hub.getSnapshot().roundSteps as RoundStep[]) || []}
            pulseText={state.streaming ? '正在思考…' : undefined}
            pulseColor={state.streaming ? 'approval' : undefined}
            spawnInstances={[]}
            onSpawnSelect={() => {}}
            selectedSpawnIndex={null}
            onSpawnSendInstruction={() => {}}
            spawnStreaming={false}
            onBranchFromMessage={handleBranchFromMessage}
          />
          <InputBar
            disabled={!state.authorized}
            streaming={state.streaming}
            models={state.models}
            routePlan={undefined}
            onSend={send}
            onAbort={abort}
            onOpenSettings={() => {}}
            onAttachments={() => {}}
          />
        </main>
        <RightRail
          collapsed={rightCollapsed}
          onToggle={() => setRightCollapsed(!rightCollapsed)}
          sessions={state.sessions.map((s) => ({ thread_id: s.id, title: s.title, created_at: 0, updated_at: s.updated_at, message_count: 0, current_leaf: null, rename_count: 0 }))}
          activeSessionId={state.activeSessionId}
          branchTrees={{}}
          onBranchFromLeaf={() => {}}
          onSelectSession={(id) => {
            const s = sessionStore.get(id);
            if (s) hub.setState({ activeSessionId: id, messages: s.messages, roundId: null, streaming: false });
          }}
          onCreateSession={() => {
            const pending = sessionStore.create();
            setTimeout(() => {
              const s = sessionStore.get(pending.id);
              if (s) hub.setState({ activeSessionId: pending.id, messages: s.messages, roundId: null, streaming: false });
            }, 0);
          }}
          onRenameSession={(id, newTitle) => sessionStore.rename(id, newTitle)}
          onDeleteSession={(id) => sessionStore.remove(id)}
          onBranchFromMessage={handleBranchFromMessage}
        />
      </div>
    </div>
  );
}

/**
 * InKling 前端产品面装配：三栏布局 + 消息流 + 输入行 + 设置/管理台/机制视图浮窗。
 */

import { useState } from 'react';

import { TopBar } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { InputBar } from '@/app/input/InputBar';
import { MessageStream } from '@/app/session/MessageStream';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import { SettingsFloater } from '@/app/settings/settings_floater';
import { ConsolePanel } from '@/app/console/ConsolePanel';
import { ViewFloater } from '@/app/wiring/ViewFloater';
import { NAV_ENTRIES } from '@/app/wiring/navEntries';
import { TaskCapsule } from '@/app/tasks/TaskCapsule';
import type { TaskCapsuleData } from '@/app/tasks/types';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { RoundStep } from '@/shared/session/types';

interface AppProps {
  backend: BackendAdapter;
  hub: ChannelHub;
  sessionStore: SessionStore;
}

interface RoutePlanPreview {
  chainLabel: string;
  quota: number;
  tier: string;
}

export default function App({ backend, hub, sessionStore }: AppProps) {
  const state = useSessionState(hub, sessionStore, backend);
  const { send, abort } = useSessionActions(hub, sessionStore, backend);

  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(true);
  const [title, setTitle] = useState('新会话');

  const [openPanel, setOpenPanel] = useState<'none' | 'settings' | 'console'>('none');
  const [activeView, setActiveView] = useState<string | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlanPreview | undefined>(undefined);
  // 跨回合长任务数据源接线点：由 task_start/task_update 事件驱动填充，
  // 当前消息流未接回合事件流，故保持空（右栏顶部胶囊仅长任务期间出现）。
  const [task, setTask] = useState<TaskCapsuleData | null>(null);
  // RoundTaskSummary 消费接线点：回合尾由 round 事件携带任务载荷时
  // 以消息流条目渲染（消息流尚未消费回合任务载荷）。

  const handleBranchFromMessage = (messageId: string, branchLabel: string) => {
    void backend.sessionBranch(state.activeSessionId, 'branch', null).then(() => {
      console.log('分支已创建', branchLabel, messageId);
    }).catch(() => undefined);
  };

  const handleRoutePlanPreview = (text: string) => {
    if (!text.trim()) {
      setRoutePlan(undefined);
      return;
    }
    void backend.routePlan(text, 'light')
      .then((r) => {
        setRoutePlan({
          chainLabel: r.chain_id ?? r.kind,
          quota: r.policy.quota_per_round,
          tier: r.policy.tier,
        });
      })
      .catch(() => setRoutePlan(undefined));
  };

  const handleSend = (text: string, attachments: AttachmentAsset[], sendMode: 'standard' | 'assembly') => {
    if (sendMode === 'assembly') {
      void backend.pathSetAssemblerEnabled(true).catch(() => undefined);
    }
    void send(text, attachments);
  };

  const activeNav = NAV_ENTRIES.find((e) => e.key === activeView);

  return (
    <div className="ink-app flex h-screen w-full flex-col overflow-hidden">
      <TopBar title={title} unreadCount={0} onTitleChange={setTitle} onOpenEvolution={() => setActiveView('evolution')} />
      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          collapsed={leftCollapsed}
          onToggle={() => setLeftCollapsed(!leftCollapsed)}
          authorized={state.authorized}
          onAddWorkspace={() => {}}
          navEntries={NAV_ENTRIES}
          onOpenNav={(key) => {
            setOpenPanel('none');
            setActiveView(key);
          }}
          onOpenSettings={() => {
            setActiveView(null);
            setOpenPanel('settings');
          }}
          onOpenConsole={() => {
            setActiveView(null);
            setOpenPanel('console');
          }}
        />
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
            routePlan={routePlan}
            onSend={handleSend}
            onAbort={abort}
            onOpenSettings={() => setOpenPanel('settings')}
            onAttachments={() => {}}
            onRoutePlanPreview={handleRoutePlanPreview}
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
          headerSlot={
            task ? (
              <TaskCapsule
                task={task}
                onCancel={() => {
                  setTask(null);
                }}
                onOpen={() => setOpenPanel('console')}
              />
            ) : null
          }
        />
      </div>

      {openPanel === 'settings' && (
        <SettingsFloater
          open
          onClose={() => setOpenPanel('none')}
          backend={{
            available: backend.available,
            status: backend.status,
            firstRunDismiss: backend.firstRunDismiss,
          }}
        />
      )}

      {openPanel === 'console' && (
        <div className="ink-settings-overlay" data-ui="console_floater_overlay" onClick={() => setOpenPanel('none')}>
          <section
            data-ui="console_floater"
            className="ink-settings-panel"
            style={{ width: '64%', maxWidth: '1080px' }}
            role="dialog"
            aria-label="管理台"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-full flex-col">
              <header className="flex items-center justify-between border-b ink-border px-4 py-3">
                <span className="text-sm font-medium ink-text-base">管理台</span>
                <button
                  type="button"
                  data-ui="console_floater_close"
                  onClick={() => setOpenPanel('none')}
                  className="rounded-lg px-2 py-1 text-[11px] ink-text-muted hover:text-[var(--ink-text-base)]"
                >
                  返回主界面
                </button>
              </header>
              <div className="flex-1 overflow-hidden">
                <ConsolePanel />
              </div>
            </div>
          </section>
        </div>
      )}

      {activeNav && <ViewFloater entry={activeNav} onClose={() => setActiveView(null)} />}
    </div>
  );
}

/**
 * InKling 前端产品面装配：左栏（工作区）+ 主区（页签：对话/轨迹）+ 右栏（会话）。
 *
 * 主界面只保留会话产品面：机制/市场视图与管理台统一收纳在设置「高级」节
 * （开发者模式可见，经 SettingsActions 回调以浮窗打开）；工作区授权走
 * 原生目录选择器 + workspace_authorize 真接线；模型档快照装配层加载后
 * 注入输入胶囊。
 */

import { useEffect, useState } from 'react';

import { TopBar, type MainTab } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { InputBar } from '@/app/input/InputBar';
import { MessageStream } from '@/app/session/MessageStream';
import { TrajectoryView } from '@/app/session/TrajectoryView';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import { SettingsFloater } from '@/app/settings/settings_floater';
import { ViewFloater } from '@/app/wiring/ViewFloater';
import { NAV_ENTRIES } from '@/app/wiring/navEntries';
import { TaskCapsule } from '@/app/tasks/TaskCapsule';
import type { TaskCapsuleData } from '@/app/tasks/types';
import { createTauriInvoker } from '@/shared/backend/tauriBridge';
import type { BackendAdapter, ModelArchiveSnapshot } from '@/shared/backend/backendAdapter';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import type { ChannelHub } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { RoundStep, SimulationBranch } from '@/shared/session/types';

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
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [title, setTitle] = useState('新会话');
  const [tab, setTab] = useState<MainTab>('chat');

  const [openPanel, setOpenPanel] = useState<'none' | 'settings'>('none');
  const [activeView, setActiveView] = useState<string | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlanPreview | undefined>(undefined);
  // 跨回合长任务数据源接线点：由 task_start/task_update 事件驱动填充，
  // 当前消息流未接回合事件流，故保持空（主区输入胶囊上方胶囊仅长任务期间出现）。
  const [task, setTask] = useState<TaskCapsuleData | null>(null);

  // 工作区授权态（真接线：authorizationState 轮询 + workspace_authorize 写）
  const [authorized, setAuthorized] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  // 模型档快照（输入胶囊 chip / 发送门槛）
  const [models, setModels] = useState<ModelArchiveSnapshot | undefined>(undefined);

  useEffect(() => {
    if (!backend.available) return;
    void backend.authorizationState()
      .then((s) => {
        setAuthorized(s.authorized);
        setWorkspaceRoot(s.root);
      })
      .catch(() => undefined);
    void backend.modelArchiveSnapshot()
      .then((snapshot) => setModels(snapshot))
      .catch(() => undefined);
  }, [backend]);

  const handleAddWorkspace = () => {
    const tauri = createTauriInvoker();
    if (!tauri) return;
    void (async () => {
      try {
        const picked = (await tauri.invoke('plugin:dialog|open', {
          options: { directory: true, multiple: false, title: '选择工作区目录' },
        })) as string | null;
        if (!picked) return;
        const result = await backend.workspaceAuthorize(picked);
        setAuthorized(result.authorized);
        setWorkspaceRoot(result.root);
      } catch {
        // 选择器取消或授权失败：保持现状（反馈由各入口三态呈现）
      }
    })();
  };

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

  const openView = (key: string) => {
    setOpenPanel('none');
    setActiveView(key);
  };

  const openSettings = () => {
    setActiveView(null);
    setOpenPanel('settings');
  };

  const activeNav = NAV_ENTRIES.find((e) => e.key === activeView);
  const roundSteps = (hub.getSnapshot().roundSteps as RoundStep[]) || [];
  const simulations = (hub.getSnapshot().simulations as SimulationBranch[]) || [];
  const roundCount = state.entries.filter((e) => e.kind === 'user').length;

  return (
    <div className="ink-app flex h-screen w-full flex-col overflow-hidden">
      <TopBar
        title={title}
        unreadCount={0}
        tab={tab}
        onTabChange={setTab}
        onTitleChange={setTitle}
        onOpenEvolution={() => setActiveView('evolution')}
      />
      <div className="flex flex-1 overflow-hidden">
        <LeftRail
          collapsed={leftCollapsed}
          onToggle={() => setLeftCollapsed(!leftCollapsed)}
          authorized={authorized}
          workspaceRoot={workspaceRoot}
          onAddWorkspace={handleAddWorkspace}
          onOpenSettings={() => {
            setActiveView(null);
            setOpenPanel('settings');
          }}
        />
        <main className="flex flex-1 flex-col overflow-hidden">
          {tab === 'chat' ? (
            <>
              <MessageStream
                entries={state.entries}
                streaming={state.streaming}
                roundSteps={roundSteps}
                pulseText={state.streaming ? '正在思考…' : undefined}
                pulseColor={state.streaming ? 'approval' : undefined}
                simulations={simulations}
                spawnInstances={[]}
                onSpawnSelect={() => {}}
                selectedSpawnIndex={null}
                onSpawnSendInstruction={() => {}}
                spawnStreaming={false}
                onBranchFromMessage={handleBranchFromMessage}
              />
              {task && (
                <div className="mx-auto w-full max-w-3xl px-4 pb-2">
                  <TaskCapsule task={task} onCancel={() => setTask(null)} onOpen={openSettings} />
                </div>
              )}
              <InputBar
                disabled={!authorized}
                streaming={state.streaming}
                models={models}
                routePlan={routePlan}
                roundCount={roundCount}
                stepCount={roundSteps.length}
                onSend={handleSend}
                onAbort={abort}
                onOpenSettings={() => setOpenPanel('settings')}
                onAttachments={() => {}}
                onRoutePlanPreview={handleRoutePlanPreview}
              />
            </>
          ) : (
            <TrajectoryView steps={roundSteps} />
          )}
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

      {openPanel === 'settings' && (
        <SettingsFloater
          open
          onClose={() => setOpenPanel('none')}
          backend={{
            available: backend.available,
            status: backend.status,
            firstRunDismiss: backend.firstRunDismiss,
          }}
          actions={{ onOpenView: openView }}
        />
      )}

      {activeNav && <ViewFloater entry={activeNav} onClose={() => setActiveView(null)} />}
    </div>
  );
}

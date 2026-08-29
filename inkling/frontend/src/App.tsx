/**
 * InKling 前端产品面装配：左栏（工作区）+ 主区（页签：对话/轨迹）+ 右栏（会话）。
 *
 * 布局形态（参考桌面 agent 产品）：左右栏全高贯穿窗口两侧，顶栏不再常驻——
 * 主区顶部悬停触发带滑出磨砂覆盖层承载顶栏（标题/页签/演化徽标），主区
 * 视觉让位于消息流与输入胶囊。
 *
 * 主界面只保留会话产品面：机制/市场视图与管理台统一收纳在设置「高级」节
 * （开发者模式可见，经 SettingsActions 回调以浮窗打开）；工作区授权走
 * 原生目录选择器 + workspace_authorize 真接线；模型档快照装配层加载后
 * 注入输入胶囊。
 */

import { useEffect, useRef, useState } from 'react';

import { TopBar, type MainTab } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { InputBar } from '@/app/input/InputBar';
import { MessageStream } from '@/app/session/MessageStream';
import { EvolutionFeed } from '@/app/session/EvolutionFeed';
import { LedgerView } from '@/app/session/LedgerView';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import { SettingsFloater } from '@/app/settings/settings_floater';
import { ViewFloater } from '@/app/wiring/ViewFloater';
import { NAV_ENTRIES } from '@/app/wiring/navEntries';
import { TaskCapsule } from '@/app/tasks/TaskCapsule';
import type { TaskCapsuleData } from '@/app/tasks/types';
import { ReviewCard, type ReviewResolution } from '@/components/review_card';
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
  // 顶栏自动隐藏：悬停触发带展开，移出延迟收回（避免掠过抖动）
  const [topbarOpen, setTopbarOpen] = useState(false);
  const topbarTimer = useRef<number | null>(null);

  const showTopbar = () => {
    if (topbarTimer.current !== null) {
      window.clearTimeout(topbarTimer.current);
      topbarTimer.current = null;
    }
    setTopbarOpen(true);
  };

  const hideTopbar = () => {
    if (topbarTimer.current !== null) window.clearTimeout(topbarTimer.current);
    topbarTimer.current = window.setTimeout(() => setTopbarOpen(false), 240);
  };

  useEffect(() => () => {
    if (topbarTimer.current !== null) window.clearTimeout(topbarTimer.current);
  }, []);

  const [openPanel, setOpenPanel] = useState<'none' | 'settings'>('none');
  const [activeView, setActiveView] = useState<string | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlanPreview | undefined>(undefined);
  // 跨回合长任务数据源接线点：task_start/task_update/task_done 事件经
  // task_state 子通道归约，胶囊仅在长任务（planActive/步进>0）期间出现。
  const taskState = hub.getSnapshot().taskState;
  const task: TaskCapsuleData | null =
    taskState.planActive || taskState.stepsTotal > 0
      ? {
          goal: taskState.planId ?? '任务',
          status: taskState.planActive ? 'running' : 'completed',
          step: taskState.stepsDone,
          total: taskState.stepsTotal,
          next_step: taskState.subtasks.find((s) => s.status === 'running')?.progress,
        }
      : null;

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
  const roundCount = state.entries.filter((e) => e.kind === 'text' && e.role === 'user').length;

  return (
    <div className="ink-app flex h-screen w-full flex-row overflow-hidden">
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
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* 顶栏自动隐藏：悬停触发带 + 磨砂覆盖层（不推挤主区布局） */}
        <div className="ink-topbar-trigger" onMouseEnter={showTopbar} />
        <div
          className="ink-topbar-veil"
          data-open={topbarOpen || undefined}
          onMouseEnter={showTopbar}
          onMouseLeave={hideTopbar}
        >
          <TopBar
            title={title}
            unreadCount={0}
            tab={tab}
            onTabChange={setTab}
            onTitleChange={setTitle}
          />
        </div>
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
                  <TaskCapsule task={task} onCancel={abort} onOpen={openSettings} />
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
          ) : tab === 'ledger' ? (
            <LedgerView backend={backend} threadId={state.activeSessionId} />
          ) : (
            <EvolutionFeed
              incubation={hub.getSnapshot().incubation}
              patchChain={hub.getSnapshot().patchChain}
            />
          )}
        </main>
      </div>
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

      {activeNav && (
        <ViewFloater
          entry={activeNav}
          onClose={() => setActiveView(null)}
          extraProps={
            activeNav.key === 'sources'
              ? { traces: hub.getSnapshot().sourceTraces }
              : undefined
          }
        />
      )}

      {/* 审批卡：review_card 事件到达即弹（任何视图下），决议走 approval_resolve */}
      {state.pendingReview && (
        <ReviewCard
          bindValue={hub.getLastEvent('review_card')}
          onResolve={(resolution: ReviewResolution, editedContent?: string) => {
            const payload = state.pendingReview as Record<string, unknown>;
            const key = String(payload.key ?? payload.review_key ?? 'review');
            void backend
              .approvalResolve(state.activeSessionId, key, resolution, undefined, editedContent)
              .catch(() => undefined);
            hub.setState({ pendingReview: null });
          }}
        />
      )}
    </div>
  );
}

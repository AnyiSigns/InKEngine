/**
 * InKling 前端产品面装配：左栏（工作区）+ 主区（页签：对话/演化/账本）+ 右栏（会话）。
 *
 * 布局形态（参考桌面 agent 产品）：左右栏全高贯穿窗口两侧，顶栏不再常驻——
 * 主区顶部悬停触发带滑出磨砂覆盖层承载顶栏（标题/页签），主区
 * 视觉让位于消息流与输入胶囊。
 *
 * 主界面只保留会话产品面：机制/市场/管理台视图统一收纳在设置页各节
 * （全部节对用户开放）；工作区授权走原生目录选择器 + workspace_authorize
 * 真接线；模型档快照装配层加载后注入输入胶囊。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { TopBar, type MainTab } from '@/app/shell/TopBar';
import { LeftRail } from '@/app/shell/LeftRail';
import { RightRail } from '@/app/shell/RightRail';
import { InputBar } from '@/app/input/InputBar';
import { MessageStream } from '@/app/session/MessageStream';
import { EvolutionFeed } from '@/app/session/EvolutionFeed';
import { LedgerView } from '@/app/session/LedgerView';
import { TrajectoryView } from '@/app/session/TrajectoryView';
import { TodoView } from '@/app/session/TodoView';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import { SettingsFloater } from '@/app/settings/settings_floater';
import { TaskCapsule } from '@/app/tasks/TaskCapsule';
import type { TaskCapsuleData } from '@/app/tasks/types';
import { ReviewCard, type ReviewResolution } from '@/components/review_card';
import type { BackendAdapter, ModelArchiveSnapshot, SessionBranchTree } from '@/shared/backend/backendAdapter';
import { submitAttachments, type AttachmentAsset } from '@/shared/session/eventIngest';
import type { ChannelHub } from '@/shared/session/channelHub';
import { emptyThreadBucket } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage, SimulationBranch } from '@/shared/session/types';
import type { SpawnInstance } from '@/app/session/SpawnPanel';

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
  const [routePlan, setRoutePlan] = useState<RoutePlanPreview | undefined>(undefined);
  // 跨回合长任务数据源接线点：plan/spawn/tool 事件经 task_state 子通道
  // 归约，胶囊仅在长任务（planActive/步进>0）期间出现。
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

  // 待办清单检测（agent 用 task_manager 建清单后顶栏临时出现「待办」标签）：
  // 消息流每新增条目 + 切换会话时刷新（todo_get 轻量只读；空清单快速返回）
  const [todoState, setTodoState] = useState<{ has: boolean; pending: number }>({ has: false, pending: 0 });
  useEffect(() => {
    if (!backend.available || !state.activeSessionId) return;
    void backend
      .todoGet(state.activeSessionId)
      .then((data) => {
        const entries = data.entries ?? [];
        const pending = entries.filter((e) => !['done', 'cancelled'].includes(e.status)).length;
        setTodoState({ has: entries.length > 0, pending });
      })
      .catch(() => undefined);
  }, [backend, state.activeSessionId, state.entries.length]);

  // 子代理实例清单（由 spawn 消息卡派生；空 = 面板不渲染）。
  // R-6：useMemo 包裹——消息流长列表时避免每次渲染重复 filter/map
  const spawnInstances: SpawnInstance[] = useMemo(
    () =>
      state.entries
        .filter((e): e is Extract<InkMessage, { kind: 'spawn' }> => e.kind === 'spawn')
        .map((e, index) => ({
          index,
          label: e.label || `子代理 ${index + 1}`,
          status: e.status === 'running' ? 'running' : 'completed',
        })),
    [state.entries],
  );
  const [selectedSpawnIndex, setSelectedSpawnIndex] = useState<number | null>(null);

  // 线程分支树（session_tree 真接线；空 = 分支 mini 树不渲染）
  const [branchTrees, setBranchTrees] = useState<Record<string, SessionBranchTree>>({});
  useEffect(() => {
    if (!state.activeSessionId || !backend.available) return;
    void backend
      .sessionTree(state.activeSessionId)
      .then((tree) => setBranchTrees((prev) => ({ ...prev, [state.activeSessionId]: tree })))
      .catch(() => undefined);
  }, [state.activeSessionId, backend]);

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
    void (async () => {
      try {
        const picked = await backend.openDirectoryDialog({ title: '选择工作区目录', directory: true, multiple: false });
        if (!picked || picked.length === 0) return;
        const result = await backend.workspaceAuthorize(picked[0]);
        setAuthorized(result.authorized);
        setWorkspaceRoot(result.root);
      } catch {
        // 选择器取消或授权失败：保持现状（反馈由各入口三态呈现）
      }
    })();
  };

  const handleBranchFromMessage = (_messageId: string, _branchLabel: string) => {
    void backend.sessionBranch(state.activeSessionId, 'branch', null).then(() => {
      // messageId 保留签名供后续 message 级分支使用；当前回落会话级分支
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

  const handleSend = (
    text: string,
    attachments: AttachmentAsset[],
    sendMode: 'standard' | 'assembly',
    model?: import('@/shared/backend/backendAdapter').ModelSelection,
  ) => {
    if (sendMode === 'assembly') {
      void backend.pathSetAssemblerEnabled(true).catch(() => undefined);
    }
    void send(text, attachments, model);
  };

  /** 会话窗口切换：从 perThread 桶恢复该会话的回合状态（演化/推演/来源/轨迹）。 */
  const restoreThread = (id: string, messages: InkMessage[]) => {
    const current = hub.getSnapshot();
    // 先回写当前会话在途消息与回合状态（窗口切换不丢失中途流式内容）
    if (typeof sessionStore.replaceMessages === 'function' && current.activeSessionId) {
      try {
        sessionStore.replaceMessages(current.activeSessionId, current.messages);
      } catch {
        // 回写失败不影响切换
      }
    }
    const bucket = current.perThread[id] ?? emptyThreadBucket();
    hub.setState({
      activeSessionId: id,
      messages,
      roundSteps: bucket.roundSteps ?? [],
      roundId: bucket.roundId ?? null,
      streaming: false,
      simulations: bucket.simulations ?? [],
      incubation: bucket.incubation ?? [],
      sourceTraces: bucket.sourceTraces ?? [],
      patchChain: bucket.patchChain ?? [],
    });
  };

  const openSettings = () => {
    setOpenPanel('settings');
  };

  const roundSteps = hub.getSnapshot().roundSteps ?? [];
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
            onTitleChange={(nextTitle) => {
              setTitle(nextTitle);
              if (state.activeSessionId) sessionStore.rename(state.activeSessionId, nextTitle);
            }}
            hasTodo={todoState.has}
            todoPending={todoState.pending}
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
                spawnInstances={spawnInstances}
                onSpawnSelect={(idx) => setSelectedSpawnIndex(idx)}
                selectedSpawnIndex={selectedSpawnIndex}
                onSpawnSendInstruction={(text) => send(text, [])}
                spawnStreaming={state.streaming}
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
                onAttachments={(assets) => submitAttachments(hub, assets)}
                onRoutePlanPreview={handleRoutePlanPreview}
              />
            </>
          ) : tab === 'ledger' ? (
            <LedgerView backend={backend} threadId={state.activeSessionId} />
          ) : tab === 'trajectory' ? (
            <TrajectoryView steps={roundSteps} />
          ) : tab === 'todo' ? (
            <TodoView backend={backend} threadId={state.activeSessionId} />
          ) : (
            <EvolutionFeed
              incubation={hub.getSnapshot().incubation}
              patchChain={hub.getSnapshot().patchChain}
              backend={backend}
              threadId={state.activeSessionId}
            />
          )}
        </main>
      </div>
      <RightRail
        collapsed={rightCollapsed}
        onToggle={() => setRightCollapsed(!rightCollapsed)}
        sessions={state.sessions.map((s) => ({ thread_id: s.id, title: s.title, created_at: 0, updated_at: s.updated_at, message_count: 0, current_leaf: null, rename_count: 0 }))}
        activeSessionId={state.activeSessionId}
        branchTrees={branchTrees}
        onBranchFromLeaf={(sessionId, leaf) => {
          void backend.sessionBranch(sessionId, 'branch', leaf).catch(() => undefined);
        }}
        onSelectSession={(id) => {
          const s = sessionStore.get(id);
          if (s) restoreThread(id, s.messages);
        }}
        onCreateSession={() => {
          const pending = sessionStore.create();
          restoreThread(pending.id, pending.messages);
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
        />
      )}

      {/* 审批卡：review_card 事件到达即弹（任何视图下），决议走 approval_resolve */}
      {state.pendingReview && (
        <ReviewCard
          bindValue={state.pendingReview ? { type: 'review_card' as const, payload: state.pendingReview, at: Date.now() } : undefined}
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

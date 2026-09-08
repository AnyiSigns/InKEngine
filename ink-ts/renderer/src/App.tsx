// gate: 超限(409 行) - 产品壳组合层（宿主数据/动作装配单一点，布局已让位 ui_spec 直渲）
/**
 * InKling 产品壳宿主：装配会话数据与机制动作 → 注入 UIRenderer（唯一产品渲染
 * 入口），布局结构完全由 plugins ui 布局装配生成物（plugins/ui.generated.json
 * 组件树）表达（不再硬编码三栏/页签 JSX）。
 *
 * canonical 组件（file_tree/session_list/message_list/agent_input/...）经
 * app/rendererAdapters 注册，binding 载荷与宿主 product chrome 在此归一。
 * 会话数据/回合归约仍走 channelHub + sessionStore；审批决议续跑线程化语义
 * 与切会话恢复保持在宿主（机制动作不进布局数据）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { UIRenderer } from '@/renderer/bootRenderer';
import type { UISpec } from '@/renderer/uiSpecTypes';
import { useSessionState, useSessionActions } from '@/app/state/sessionState';
import { setActiveThreadId } from '@/app/state/activeThread';
import type { ProductShellChrome } from '@/app/shell/productView';
import type { BackendAdapter, ModelArchiveSnapshot, SessionBranchTree } from '@/shared/backend/backendAdapter';
import { submitAttachments, messagesFromHistory, type AttachmentAsset } from '@/shared/session/eventIngest';
import type { ChannelHub, ThreadBucket } from '@/shared/session/channelHub';
import { emptyThreadBucket } from '@/shared/session/channelHub';
import type { SessionStore } from '@/shared/session/sessionStore';
import type { InkMessage, SimulationBranch } from '@/shared/session/types';
import type { SpawnInstance } from '../../plugins/ui_features/message_list/faces/ui/SpawnPanel';
import type { TaskCapsuleData } from '../../plugins/ui_features/task_capsule/faces/ui/types';
import type { MainTab, ReviewResolution } from '@/app/shell/shellContracts';

import uiLayout from '../../plugins/ui.generated.json';

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
  const { send, abort, resolveReview } = useSessionActions(hub, sessionStore, backend);

  // 活动会话上下文（审计恢复回退点/后续 per-thread 读面共享）
  useEffect(() => {
    setActiveThreadId(state.activeSessionId);
  }, [state.activeSessionId]);

  const [title, setTitle] = useState('新会话');
  const [tab, setTab] = useState<MainTab>('chat');
  const [openPanel, setOpenPanel] = useState<'none' | 'settings'>('none');
  const [routePlan, setRoutePlan] = useState<RoutePlanPreview | undefined>(undefined);
  const routePlanSeq = useRef(0);
  const routePlanTimer = useRef<number | null>(null);

  // 跨回合长任务数据源接线点：plan/spawn/tool 事件经 task_state 子通道归约，
  // 胶囊仅在长任务期间出现（task_capsule canonical 组件消费）。
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

  // 待办清单检测（rounds.todos 有值 = 顶栏出现「待办」标签）
  const [todoState, setTodoState] = useState<{ has: boolean; pending: number }>({ has: false, pending: 0 });
  useEffect(() => {
    if (!backend.available || !state.activeSessionId) return;
    void backend
      .todoGet(state.activeSessionId)
      .then((data) => {
        const rows = data.todo ?? [];
        const pending = rows.filter((r) => r.status !== 'done' && r.status !== 'cancelled').length;
        setTodoState({ has: rows.length > 0, pending });
      })
      .catch(() => undefined);
  }, [backend, state.activeSessionId, state.entries.length]);

  // 子代理实例清单（由 spawn 消息卡派生；空 = 面板不渲染）
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

  // 线程分支树（session_tree 真接线）
  const [branchTrees, setBranchTrees] = useState<Record<string, SessionBranchTree>>({});
  useEffect(() => {
    if (!state.activeSessionId || !backend.available) return;
    void backend
      .sessionTree(state.activeSessionId)
      .then((tree) => setBranchTrees((prev) => ({ ...prev, [state.activeSessionId]: tree })))
      .catch(() => undefined);
  }, [state.activeSessionId, backend]);

  // 工作区授权态（workspace.state 轮询 + workspace.set 写）
  const [authorized, setAuthorized] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [models, setModels] = useState<ModelArchiveSnapshot | undefined>(undefined);
  const [agentModelId, setAgentModelId] = useState<string | null>(null);
  const reloadModels = useCallback(() => {
    if (!backend.available) return;
    void backend
      .modelArchiveSnapshot()
      .then((snapshot) => setModels(snapshot))
      .catch(() => undefined);
    void backend
      .modelsConfigGet()
      .then((raw) => {
        const rawDoc = (raw ?? {}) as { model_config?: unknown };
        const doc = (rawDoc.model_config ?? rawDoc) as Record<string, unknown>;
        const pick = doc.agent_pick as { model_id?: unknown } | null | undefined;
        setAgentModelId(
          typeof pick === 'object' && pick !== null && typeof pick.model_id === 'string'
            ? pick.model_id
            : null,
        );
      })
      .catch(() => undefined);
  }, [backend]);

  const handleAgentModelSelect = (modelId: string, providerId?: string): void => {
    if (!backend.available || !providerId) return;
    void backend
      .modelsRolePick('agent', providerId, modelId)
      .then(() => reloadModels())
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!backend.available) return;
    void backend
      .authorizationState()
      .then((s) => {
        setAuthorized(s.authorized);
        setWorkspaceRoot(s.root);
      })
      .catch(() => undefined);
    reloadModels();
  }, [backend, reloadModels]);

  const handleAddWorkspace = () => {
    void (async () => {
      try {
        const picked = await backend.openDirectoryDialog({ title: '选择工作区目录', directory: true, multiple: false });
        if (!picked || picked.length === 0) return;
        const result = await backend.workspaceAuthorize(picked[0]);
        setAuthorized(result.authorized);
        setWorkspaceRoot(result.root);
      } catch {
        // 原生目录选择不可用：保持现状（反馈由工作区视图三态呈现）
      }
    })();
  };

  const handleBranchFromMessage = (_messageId: string, _branchLabel: string) => {
    void backend.sessionBranch(state.activeSessionId, 'branch', null).then(() => {
      // messageId 保留签名供后续 message 级分支使用；当前回落会话级分支
    }).catch(() => undefined);
  };

  const handleRoutePlanPreview = (text: string) => {
    if (routePlanTimer.current !== null) {
      window.clearTimeout(routePlanTimer.current);
      routePlanTimer.current = null;
    }
    if (!text.trim()) {
      routePlanSeq.current += 1;
      setRoutePlan(undefined);
      return;
    }
    const seq = routePlanSeq.current + 1;
    routePlanSeq.current = seq;
    routePlanTimer.current = window.setTimeout(() => {
      routePlanTimer.current = null;
      void backend
        .routePlan(text, 'full')
        .then((r) => {
          if (seq !== routePlanSeq.current) return;
          setRoutePlan({
            chainLabel: r.chain_id ?? r.kind,
            quota: r.policy.quota_per_round,
            tier: r.policy.tier,
          });
        })
        .catch(() => {
          if (seq !== routePlanSeq.current) return;
          setRoutePlan(undefined);
        });
    }, 300);
  };

  const handleSend = (
    text: string,
    attachments: AttachmentAsset[],
    model?: import('@/shared/backend/backendAdapter').ModelSelection,
  ) => {
    // 回合恒为组装：发送即从数据组装出本轮执行图（无模式参数，单一发送面）
    void send(text, attachments, model);
  };

  /** 会话窗口切换：从 perThread 桶恢复该会话的回合状态与消息流。 */
  const restoreThread = (id: string, messages: InkMessage[]) => {
    const current = hub.getSnapshot();
    const outId = current.activeSessionId;
    const bucket = current.perThread[id] ?? emptyThreadBucket();
    const effective = bucket.messages.length > 0 ? bucket.messages : messages;
    const perThread: Record<string, ThreadBucket> = {};
    for (const [tid, b] of Object.entries(current.perThread)) {
      const keep = tid === id
        ? { ...b, messages: effective, lastSeenAt: Date.now() }
        : b;
      perThread[tid] = keep;
    }
    if (outId && outId !== id) {
      const outBucket = perThread[outId] ?? emptyThreadBucket();
      perThread[outId] = { ...outBucket, messages: current.messages, taskState: current.taskState, lastSeenAt: Date.now() };
      if (typeof sessionStore.replaceMessages === 'function') {
        try {
          sessionStore.replaceMessages(outId, current.messages);
        } catch {
          // 回写失败不影响切换
        }
      }
    }
    if (typeof sessionStore.replaceMessages === 'function' && effective.length > 0) {
      try {
        sessionStore.replaceMessages(id, effective);
      } catch {
        // 回写失败不影响切换
      }
    }
    hub.setState({
      activeSessionId: id,
      messages: effective,
      taskState: bucket.taskState ?? current.taskState,
      roundSteps: bucket.roundSteps ?? [],
      roundId: bucket.roundId ?? null,
      streaming: bucket.roundActive === true,
      simulations: bucket.simulations ?? [],
      incubation: bucket.incubation ?? [],
      sourceTraces: bucket.sourceTraces ?? [],
      patchChain: bucket.patchChain ?? [],
      perThread,
    });
  };

  const selectSession = (id: string) => {
    const s = sessionStore.get(id);
    const local = s?.messages ?? [];
    if (local.length > 0) {
      restoreThread(id, local);
      return;
    }
    if (!backend.available) {
      restoreThread(id, []);
      return;
    }
    void backend
      .sessionMessages(id)
      .then((rows) => {
        const msgs = messagesFromHistory(rows);
        const cur = sessionStore.get(id);
        if (cur) sessionStore.replaceMessages(id, msgs);
        const snap = hub.getSnapshot();
        if (snap.activeSessionId === id || !snap.activeSessionId) restoreThread(id, msgs);
      })
      .catch(() => {
        const cur = sessionStore.get(id);
        if (!cur || cur.messages.length === 0) restoreThread(id, []);
      });
  };

  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || !backend.available) return;
    if (state.activeSessionId) return;
    const first = sessionStore.list().find((r) => !r.deleted);
    if (!first) return;
    didAutoSelect.current = true;
    selectSession(first.id);
  }, [backend, sessionStore, state.activeSessionId, state.sessions.length]);

  const openSettings = () => {
    setOpenPanel('settings');
  };

  const closeSettings = useCallback(() => {
    setOpenPanel('none');
    reloadModels();
  }, [reloadModels]);

  /** 审批卡决议：从卡负载取 key/thread（负载在 bind 事件或 hub 挂起态），
   *  决议续跑该线程（切走不误伤其它窗口）。 */
  const handleResolveReview = useCallback(
    (resolution: ReviewResolution, editedContent?: string, payload?: Record<string, unknown>) => {
      const data = payload ?? hub.getSnapshot().pendingReview;
      if (!data || typeof data !== 'object') {
        hub.setState({ pendingReview: null });
        return;
      }
      const key = String((data as Record<string, unknown>).key ?? (data as Record<string, unknown>).review_key ?? '');
      if (!key) {
        hub.setState({ pendingReview: null });
        return;
      }
      const thread = (data as Record<string, unknown>).thread_id as string | undefined;
      resolveReview(key, resolution, editedContent, thread);
    },
    [hub, resolveReview],
  );

  const spec = uiLayout as unknown as UISpec;
  const roundSteps = hub.getSnapshot().roundSteps ?? [];
  const simulations = (hub.getSnapshot().simulations as SimulationBranch[]) || [];
  const roundCount = state.entries.filter((e) => e.kind === 'text' && e.role === 'user').length;

  // 装配 product chrome（绑定载荷之外的产品面数据/动作统一经此通道注入）
  const chrome: Record<string, unknown> = {
    backend,
    hub,
    sessionStore,
    activeSessionId: state.activeSessionId,
    title,
    tab,
    streaming: state.streaming,
    entries: state.entries,
    roundSteps,
    simulations,
    incubation: hub.getSnapshot().incubation,
    patchChain: hub.getSnapshot().patchChain,
    pendingReview: state.pendingReview,
    task,
    spawnInstances,
    selectedSpawnIndex,
    sessions: state.sessions.map((s) => ({ thread_id: s.id, title: s.title, updated_at: s.updated_at })),
    branchTrees,
    authorized,
    workspaceRoot,
    models,
    agentModelId,
    routePlan,
    roundCount,
    stepCount: roundSteps.length,
    hasTodo: todoState.has,
    todoPending: todoState.pending,
    settingsOpen: openPanel === 'settings',
    autoApprovableTools: [],
    onTabChange: (next: MainTab) => setTab(next),
    onTitleChange: (nextTitle: string) => {
      setTitle(nextTitle);
      if (state.activeSessionId) sessionStore.rename(state.activeSessionId, nextTitle);
    },
    onOpenSettings: openSettings,
    onCloseSettings: closeSettings,
    onAddWorkspace: handleAddWorkspace,
    onSend: handleSend,
    onAbort: abort,
    onAttachments: (assets: AttachmentAsset[]) => submitAttachments(hub, assets),
    onRoutePlanPreview: handleRoutePlanPreview,
    onAgentModelSelect: handleAgentModelSelect,
    onSpawnSelect: (idx: number) => setSelectedSpawnIndex(idx),
    onSpawnSendInstruction: (text: string) => send(text, []),
    onBranchFromMessage: handleBranchFromMessage,
    onBranchFromLeaf: (sessionId: string, leaf: number) => {
      void backend.sessionBranch(sessionId, 'branch', leaf).catch(() => undefined);
    },
    onSelectSession: (id: string) => selectSession(id),
    onCreateSession: () => {
      const pending = sessionStore.create();
      restoreThread(pending.id, pending.messages);
    },
    onRenameSession: (id: string, titleText: string) => sessionStore.rename(id, titleText),
    onDeleteSession: (id: string) => sessionStore.remove(id),
    onResolveReview: handleResolveReview,
  } as ProductShellChrome;

  return (
    <UIRenderer
      spec={spec}
      hub={hub}
      activeView={tab}
      sessionStore={sessionStore}
      activeSessionId={state.activeSessionId}
      product={chrome}
    />
  );
}

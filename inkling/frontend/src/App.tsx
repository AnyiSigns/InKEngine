/**
 * InKling 前端壳层：组件装配 + 宿主接线（可注入后端适配器）。
 *
 * 三栏布局：
 *   左 = 文件树工作区（可收缩，底部设置入口）
 *   中 = 会话面板（消息流 + 输入，内容居中）
 *   右 = 会话列表（可收缩）
 * 功能入口（演化/推演/来源/管理台/架构/界面树）统一收进设置页。
 *
 * 分层纪律：App 只做装配（注册组件/领域包/通道注入/视图切换/
 * 宿主接线回调），不持有产品逻辑。宿主接口经可注入后端适配器
 * （生产 = Tauri 宿主桥；测试 = mock 后端；浏览器 dev = 夹具路径），
 * 适配器不可用时回落夹具会话（既有行为不崩）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { registerBuiltinComponents } from '@/components';
import type { ViewId } from '@/renderer/uiSpecTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';
import { UIRenderer } from '@/renderer/bootRenderer';
import { loadDomainComponents } from '@/domains/loader';
import { ChannelHub } from '@/shared/session/channelHub';
import { isEventTypeName } from '@/shared/session/eventTypes';
import { runFixtureSession } from '@/shared/session/fixtureScript';
import {
  submitUserMessage,
  ingestEvent,
  setStreaming,
  commitStreaming,
  toEngineAttachments,
  type AttachmentAsset,
} from '@/shared/session/eventIngest';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import type { SessionRecord, SessionStore } from '@/shared/session/sessionStore';
import { RemoteSessionStore, createSessionStoreFrom } from '@/shared/backend/remoteSessionStore';
import { createBackend } from '@/shared/backend/backendAdapter';
import type { BackendAdapter } from '@/shared/backend/backendAdapter';
import { listenHostEvent } from '@/shared/backend/tauriBridge';
import { refreshArtifactManifest } from '@/renderer/artifactLoader.tsx';
import { BackupWizard, backupOpsFrom, type BackupMode } from '@/components/floaters/backup_wizard';
import { FirstRunGuide } from '@/components/floaters/first_run_guide';
import { recoveryOpsFrom } from '@/components/settings_sections/security_trust';
import { logger } from '@/shared/logger';

import uiSpecFixture from './data/ui_spec.fixture.json';
import domainManifestFixture from './domains/contracts.fixture.json';
import inspectSnapshotsFixture from './data/inspect_snapshots.fixture.json';
import sessionRecordsFixture from './data/session_records.fixture.json';
import architectureBaselineFixture from './data/architecture_baseline.fixture.json';
import type { InspectSnapshots } from './shared/session/inspectTypes';
import type { GraphSnapshot } from './shared/session/inspectTypes';

function bootChannelHub(): ChannelHub {
  const snapshots = inspectSnapshotsFixture as unknown as InspectSnapshots;
  return new ChannelHub({
    inspect_graph: snapshots.inspect_graph,
    inspect_rules: snapshots.inspect_rules,
    inspect_knowledge: snapshots.inspect_knowledge,
    inspect_ui: snapshots.inspect_ui,
    inspect_tools: snapshots.inspect_tools,
  });
}

/** 夹具会话存储（无宿主回落形态：内存 + 夹具种子）。 */
function fixtureSessionStore(): SessionStore {
  return new MemorySessionStore(sessionRecordsFixture as unknown as SessionRecord[]);
}

export default function App() {
  const [view, setView] = useState<ViewId>('main');
  const [liveSpec, setLiveSpec] = useState<UISpec>(() => uiSpecFixture as unknown as UISpec);
  const hubRef = useRef<ChannelHub | null>(null);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [backupMode, setBackupMode] = useState<BackupMode | null>(null);
  const [capabilityRecord, setCapabilityRecord] = useState<Record<string, unknown> | null>(null);
  const [autoApprovableTools, setAutoApprovableTools] = useState<string[]>([]);
  const [firstRun, setFirstRun] = useState(false);
  if (!hubRef.current) {
    hubRef.current = bootChannelHub();
  }

  // 宿主适配器（生产 = Tauri 宿主桥；测试 = mock；浏览器 = 不可用）
  const [backend] = useState<BackendAdapter>(() => createBackend());
  const sessionStoreRef = useRef<SessionStore | null>(null);
  if (!sessionStoreRef.current) {
    sessionStoreRef.current = createSessionStoreFrom(backend, fixtureSessionStore);
  }
  const sessionStore = sessionStoreRef.current;

  // 组件装配（幂等）：机制组件 + 领域包（manifest 白名单）
  useMemo(() => {
    registerBuiltinComponents();
    loadDomainComponents(domainManifestFixture as Parameters<typeof loadDomainComponents>[0]);
  }, []);

  // 产物组件清单刷新（挂载后注册表刷新；宿主可用才拉取）
  useEffect(() => {
    void refreshArtifactManifest(backend.available ? backend : null);
  }, [backend]);

  // 宿主就绪时：装配引擎 + 会话列表重载 + 能力档初始化 + 首启引导判定
  useEffect(() => {
    if (!backend.available) return;
    void backend
      .status()
      .then((status) => {
        if (status.first_run) setFirstRun(true);
      })
      .catch(() => undefined);
    void backend
      .engineBoot()
      .then(() => logger.info('app', '引擎装配完成'))
      .catch((err) => logger.warn('app', '引擎装配失败（通知后续回合操作）', { err: String(err) }));
    const store = sessionStore instanceof RemoteSessionStore ? sessionStore : null;
    void store?.reload();
    void backend
      .capabilityGet()
      .then((value) => setCapabilityRecord(value as Record<string, unknown>))
      .catch(() => undefined);
    void backend
      .toolsSnapshot()
      .then(({ tools }) => {
        setAutoApprovableTools(
          tools
            .filter((entry) => entry.auto_approvable)
            .map((entry) => entry.tool),
        );
      })
      .catch(() => undefined);
  }, [backend, sessionStore]);

  // 夹具会话驱动（无宿主演示形态；宿主可用时关闭）
  useEffect(() => {
    if (backend.available) return undefined;
    const stop = runFixtureSession(hubRef.current as ChannelHub, { baseDelayMs: 250 });
    logger.info('app', '夹具会话已启动（演示形态，无宿主环境回落）');
    return stop;
  }, [backend]);

  // 回合事件流式通道：回合内事件实时到达（增量渲染），回合返回体仍保留
  // 全量事件（兼容/回落）；按回合计数去重——返回体只补灌流式未覆盖的尾部。
  const streamedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!backend.available) return undefined;
    let stop: () => void = () => undefined;
    void listenHostEvent<Record<string, unknown>>('inkling://round_event', (payload) => {
      const hub = hubRef.current as ChannelHub;
      const type = typeof payload?.type === 'string' ? payload.type : '';
      if (!type || !isEventTypeName(type)) return;
      const roundId = typeof payload.round_id === 'string' ? payload.round_id : '';
      if (roundId) {
        streamedRef.current[roundId] = (streamedRef.current[roundId] ?? 0) + 1;
      }
      ingestEvent(hub, {
        type,
        payload: (payload.payload ?? {}) as Record<string, unknown>,
        at: Date.now(),
      });
    }).then((unlisten) => {
      stop = unlisten;
    });
    return () => stop();
  }, [backend]);

  const activationRound = (sessionId: string): void => {
    const hub = hubRef.current as ChannelHub;
    const record = sessionStore.get(sessionId);
    hub.setState({ messages: record?.messages ?? [], roundId: null, streaming: false });
    setActiveSessionId(sessionId);
  };

  const activateSession = (sessionId: string): void => {
    sessionStore.touch(sessionId);
    activationRound(sessionId);
  };

  const sendToEngine = useCallback((text: string, attachments: AttachmentAsset[] = []): void => {
    const hub = hubRef.current as ChannelHub;
    if (!backend.available || !activeSessionId) {
      submitUserMessage(hub, text, attachments);
      return;
    }
    const roundId = `round-${Date.now()}`;
    setStreaming(hub, true);
    void backend
      .roundSend(activeSessionId, roundId, text, false, toEngineAttachments(attachments))
      .then((outcome) => {
        const streamed = streamedRef.current[roundId] ?? 0;
        const events = outcome.events ?? [];
        for (const event of events.slice(streamed)) {
          const type = String(event.type ?? '');
          if (isEventTypeName(type)) {
            ingestEvent(hub, { type, payload: (event.payload ?? {}) as Record<string, unknown>, at: Date.now() });
          }
        }
        commitStreaming(hub);
        // 回合后刷新：消息计数 + 首回合标题生成
        void backend.sessionRefresh(activeSessionId).then((record) => {
          if (sessionStore instanceof RemoteSessionStore) sessionStore.applyRemote(record);
        }).catch(() => undefined);
      })
      .catch((err: unknown) => {
        setStreaming(hub, false);
        ingestEvent(hub, { type: 'error', payload: { message: String(err) }, at: Date.now() });
      });
  }, [backend, activeSessionId, sessionStore]);

  const abortRound = useCallback((): void => {
    const hub = hubRef.current as ChannelHub;
    const roundId = (hub.getSnapshot().roundId as string | null) ?? '';
    if (backend.available && roundId) {
      void backend.roundAbort(roundId).catch(() => undefined);
    }
    setStreaming(hub, false);
    hub.setState({ roundId: null });
    logger.info('app', '回合已中止（事件弧关断；可重试/换方向）', { roundId });
  }, [backend]);

  const resolveReview = useCallback(
    (resolution: 'accept' | 'reject' | 'edit' | 'terminate', editedContent?: string): void => {
      const hub = hubRef.current as ChannelHub;
      if (!backend.available || !activeSessionId) {
        hub.setState({ pendingReview: null });
        return;
      }
      const pending = (hub.getSnapshot().pendingReview ?? {}) as Record<string, unknown>;
      const key = typeof pending.key === 'string' && pending.key ? pending.key : null;
      if (!key) {
        hub.setState({ pendingReview: null });
        return;
      }
      const decision = resolution === 'accept' ? 'accept' : resolution === 'reject' ? 'reject' : resolution === 'edit' ? 'edit' : 'accept';
      void backend
        .roundResume(activeSessionId, key, decision, undefined, editedContent)
        .then(() => {
          hub.setState({ pendingReview: null });
          setStreaming(hub, false);
        })
        .catch((err: unknown) => {
          hub.setState({ pendingReview: null });
          ingestEvent(hub, { type: 'error', payload: { message: `审批续跑失败: ${String(err)}` }, at: Date.now() });
        });
    },
    [backend, activeSessionId],
  );

  const resendMessage = (messageId: string, newText: string): void => {
    const hub = hubRef.current as ChannelHub;
    if (!backend.available || !activeSessionId) {
      const snapshot = hub.getSnapshot();
      const messages = snapshot.messages.map((message) =>
        message.id === messageId && message.kind === 'text' ? { ...message, content: newText } : message,
      );
      hub.setState({ ...snapshot, messages });
      return;
    }
    void backend
      .sessionTree(activeSessionId)
      .then((tree) => backend.sessionBranch(activeSessionId, 'branch', tree.current_leaf, newText))
      .then((result) => {
        logger.info('app', '编辑重发已分支（新叶接管续跑）', { messageId, leaf: result.leaf });
      })
      .catch((err: unknown) => ingestEvent(hub, { type: 'error', payload: { message: `分支失败: ${String(err)}` }, at: Date.now() }));
  };

  const branchFromMessage = (messageId: string, branchLabel: string): void => {
    const hub = hubRef.current as ChannelHub;
    if (!backend.available || !activeSessionId) {
      const snapshot = hub.getSnapshot();
      hub.setState({
        ...snapshot,
        sourceTraces: [
          ...snapshot.sourceTraces,
          { id: `trace-b-${Date.now()}`, sourceType: 'evidence', title: `分支已创建：${branchLabel}`, detail: `源自消息 ${messageId}`, createdAt: Date.now() },
        ],
      });
      logger.info('app', '由此分支（夹具态本地留痕；无宿主回落）', { messageId, branchLabel });
      return;
    }
    void backend
      .sessionTree(activeSessionId)
      .then((tree) => backend.sessionBranch(activeSessionId, 'branch', tree.current_leaf, undefined))
      .then((result) => {
        logger.info('app', '由此分支（新叶已生成）', { messageId, branchLabel, leaf: result.leaf });
      })
      .catch((err: unknown) => ingestEvent(hub, { type: 'error', payload: { message: `分支失败: ${String(err)}` }, at: Date.now() }));
  };

  const backupOps = backupOpsFrom(backend);
  const recoveryOps = recoveryOpsFrom(backend);

  const applySettings = useCallback(
    (settings: Record<string, unknown>): void => {
      const capability = (settings.capability ?? {}) as { simulationTier?: string; reasoningProfileId?: string };
      const security = (settings.security ?? {}) as {
        autoApproveTools?: string[];
        autoApproveAllReview?: boolean;
      };
      if (!backend.available) return;
      const record: Record<string, unknown> = {
        simulation_tier: capability.simulationTier ?? 'light',
      };
      if (capability.reasoningProfileId) record.reasoning_profile = capability.reasoningProfileId;
      if (security.autoApproveTools) record.auto_approve_tools = security.autoApproveTools;
      if (security.autoApproveAllReview !== undefined) {
        record.auto_approve_all_review = security.autoApproveAllReview;
      }
      void backend.capabilityPut(record).catch(() => undefined);
    },
    [backend],
  );

  const initialCapability = capabilityRecord
    ? {
        simulationTier: (capabilityRecord.simulation_tier as 'off' | 'light' | 'full' | undefined) ?? undefined,
        reasoningProfileId: (capabilityRecord.reasoning_profile as string | undefined) ?? undefined,
      }
    : undefined;

  const initialAutoApprove = capabilityRecord
    ? {
        tools: Array.isArray(capabilityRecord.auto_approve_tools)
          ? (capabilityRecord.auto_approve_tools as string[])
          : [],
        allReview: capabilityRecord.auto_approve_all_review === true,
      }
    : undefined;

  return (
    // .ink-app 由 index.css 布局：html/body/#root 100% 高度链 + 100% 高度，
    // 文档流满铺，不依赖 100vh/100dvh/position:fixed——任何窗口下底部无杂色带。
    <div className="ink-app">
      <UIRenderer
        spec={liveSpec}
        hub={hubRef.current}
        activeView={view}
        onNavigate={setView}
        onSend={sendToEngine}
        onAbort={abortRound}
        onAttachments={(assets) => {
          logger.info('app', '附件经媒体策略分发后暂存（随发送同行，不单独落位）', { count: assets.length });
        }}
        onResendMessage={resendMessage}
        onBranchFromMessage={branchFromMessage}
        onActivateSession={activateSession}
        onApplyUiSpec={(spec) => {
          setLiveSpec(spec);
          logger.info('app', '界面描述已应用（界面树编辑产物）', { name: spec.name });
        }}
        uiSpec={liveSpec}
        sessionStore={sessionStore}
        activeSessionId={activeSessionId}
        architectureBaseline={architectureBaselineFixture as unknown as GraphSnapshot}
        onResolveReview={resolveReview}
        onOpenBackupWizard={(mode) => setBackupMode(mode)}
        recovery={recoveryOps}
        onApplySettings={applySettings}
        initialCapability={initialCapability}
        initialAutoApprove={initialAutoApprove}
        autoApprovableTools={autoApprovableTools}
        materialImport={backend}
      />
      {backupMode && (
        <BackupWizard mode={backupMode} ops={backupOps} onClose={() => setBackupMode(null)} />
      )}
      {firstRun && (
        <FirstRunGuide backend={backend} onDismissed={() => setFirstRun(false)} />
      )}
    </div>
  );
}

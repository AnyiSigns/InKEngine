/**
 * InKling 前端壳层：组件装配 + 夹具驱动 + UIRenderer 直渲。
 *
 * 三栏布局：
 *   左 = 文件树工作区（可收缩，底部设置入口）
 *   中 = 会话面板（消息流 + 输入，内容居中）
 *   右 = 会话列表（可收缩）
 * 功能入口（演化/推演/来源/管理台/架构/界面树）统一收进设置页。
 *
 * 分层纪律：App 只做装配（注册组件/领域包/通道注入/视图切换/
 * 宿主接线回调），不持有产品逻辑；布局树（ui_spec 夹具）即产品形态，
 * 集成期换 M0 真实数据。所有宿主接口以可注入回调/夹具表达，不接
 * 真实 IPC（桌面壳/Rust 后端就绪后替换接线点）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { registerBuiltinComponents } from '@/components';
import type { ViewId } from '@/renderer/uiSpecTypes';
import type { UISpec } from '@/renderer/uiSpecTypes';
import { UIRenderer } from '@/renderer/bootRenderer';
import { loadDomainComponents } from '@/domains/loader';
import { ChannelHub } from '@/shared/session/channelHub';
import { runFixtureSession } from '@/shared/session/fixtureScript';
import { submitUserMessage, submitAttachments } from '@/shared/session/eventIngest';
import type { AttachmentAsset } from '@/shared/session/eventIngest';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import type { SessionRecord } from '@/shared/session/sessionStore';
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
  const hub = new ChannelHub({
    inspect_graph: snapshots.inspect_graph,
    inspect_rules: snapshots.inspect_rules,
    inspect_knowledge: snapshots.inspect_knowledge,
    inspect_ui: snapshots.inspect_ui,
    inspect_tools: snapshots.inspect_tools,
  });
  return hub;
}

export default function App() {
  const [view, setView] = useState<ViewId>('main');
  const [liveSpec, setLiveSpec] = useState<UISpec>(() => uiSpecFixture as unknown as UISpec);
  const hubRef = useRef<ChannelHub | null>(null);
  const sessionStoreRef = useRef<MemorySessionStore | null>(null);
  const [activeSessionId, setActiveSessionId] = useState('');
  if (!hubRef.current) {
    hubRef.current = bootChannelHub();
  }
  if (!sessionStoreRef.current) {
    sessionStoreRef.current = new MemorySessionStore(sessionRecordsFixture as unknown as SessionRecord[]);
  }
  const sessionStore = sessionStoreRef.current;

  // 组件装配（幂等）：机制组件 + 领域包（manifest 白名单）
  useMemo(() => {
    registerBuiltinComponents();
    loadDomainComponents(domainManifestFixture as Parameters<typeof loadDomainComponents>[0]);
  }, []);

  // 夹具会话驱动（演示形态；集成期替换为真实事件源）
  useEffect(() => {
    const stop = runFixtureSession(hubRef.current as ChannelHub, { baseDelayMs: 250 });
    logger.info('app', '夹具会话已启动（演示形态，集成期换 M0 真实数据）');
    return stop;
  }, []);

  const activateSession = (sessionId: string): void => {
    const record = sessionStore.get(sessionId);
    if (!record) return;
    sessionStore.touch(sessionId);
    setActiveSessionId(sessionId);
    // 切换 = 装入会话消息（夹具记录消息为空时保留现有流，演示不崩）
    if (record.messages.length > 0) {
      hubRef.current?.setState({ messages: record.messages, roundId: null, streaming: false });
    }
  };

  const resendMessage = (messageId: string, newText: string): void => {
    const hub = hubRef.current as ChannelHub;
    const snapshot = hub.getSnapshot();
    const messages = snapshot.messages.map((message) =>
      message.id === messageId && message.kind === 'text' ? { ...message, content: newText } : message,
    );
    hub.setState({ ...snapshot, messages });
    logger.info('app', '消息编辑重发（夹具态本地回执；集成期接引擎回合入口）', { messageId, newText });
  };

  const branchFromMessage = (messageId: string, branchLabel: string): void => {
    const hub = hubRef.current as ChannelHub;
    const snapshot = hub.getSnapshot();
    hub.setState({
      ...snapshot,
      sourceTraces: [
        ...snapshot.sourceTraces,
        { id: `trace-b-${Date.now()}`, sourceType: 'evidence', title: `分支已创建：${branchLabel}`, detail: `源自消息 ${messageId}`, createdAt: Date.now() },
      ],
    });
    logger.info('app', '由此分支（夹具态本地留痕；集成期接引擎 branch 入口）', { messageId, branchLabel });
  };

  return (
    // .ink-app 由 index.css 布局：html/body/#root 100% 高度链 + 100% 高度，
    // 文档流满铺，不依赖 100vh/100dvh/position:fixed——任何窗口下底部无杂色带。
    <div className="ink-app">
      <UIRenderer
        spec={liveSpec}
        hub={hubRef.current}
        activeView={view}
        onNavigate={setView}
        onSend={(text) => {
          submitUserMessage(hubRef.current as ChannelHub, text);
          logger.info('app', '用户输入提交（演示形态本地回执；集成期接引擎回合入口）', { length: text.length });
        }}
        onAttachments={(assets) => {
          submitAttachments(hubRef.current as ChannelHub, assets as AttachmentAsset[]);
          logger.info('app', '附件提交（媒体策略分发后落位）', { count: assets.length });
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
        onResolveReview={(resolution) => {
          const hub = hubRef.current as ChannelHub;
          if (!hub) return;
          hub.setState({ pendingReview: null });
          hub.setState({
            reviewHistory: [
              ...hub.getSnapshot().reviewHistory,
              { id: `r-${Date.now()}`, title: '审批卡决议', verdict: resolution, at: Date.now() },
            ],
          });
          logger.info('app', '审批卡决议（夹具态本地落位，集成期对接 resume 管线）', { resolution });
        }}
      />
    </div>
  );
}

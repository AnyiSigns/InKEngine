/**
 * InKling 前端壳层：组件装配 + 夹具驱动 + UIRenderer 直渲。
 *
 * 三栏布局（DeepSeek harness 参照，全部重写）：
 *   左 = 文件树工作区（可收缩，底部设置入口）
 *   中 = 会话面板（消息流 + 输入，内容居中）
 *   右 = 会话列表（可收缩）
 * 其它功能入口（演化/推演/来源）统一收进设置页；主题黑白跟随系统。
 *
 * 分层纪律：App 只做装配（注册组件/领域包/通道注入/视图切换），
 * 不持有产品逻辑；布局树（ui_spec 夹具）即产品形态，集成期换 M0 真实数据。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { registerBuiltinComponents } from '@/components';
import type { ViewId } from '@/renderer/uiSpecTypes';
import { UIRenderer } from '@/renderer/bootRenderer';
import { loadDomainComponents } from '@/domains/loader';
import { ChannelHub } from '@/shared/session/channelHub';
import { runFixtureSession } from '@/shared/session/fixtureScript';
import { submitUserMessage } from '@/shared/session/eventIngest';
import { logger } from '@/shared/logger';

import uiSpecFixture from './data/ui_spec.fixture.json';
import domainManifestFixture from './domains/contracts.fixture.json';
import inspectSnapshotsFixture from './data/inspect_snapshots.fixture.json';
import type { InspectSnapshots } from './shared/session/inspectTypes';

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
  const hubRef = useRef<ChannelHub | null>(null);
  if (!hubRef.current) {
    hubRef.current = bootChannelHub();
  }

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

  return (
    // .ink-app 由 index.css 布局：html/body/#root 100% 高度链 + 100% 高度，
    // 文档流满铺，不依赖 100vh/100dvh/position:fixed——任何窗口下底部无杂色带。
    <div className="ink-app">
      <UIRenderer
        spec={uiSpecFixture as Parameters<typeof UIRenderer>[0]['spec']}
        hub={hubRef.current}
        activeView={view}
        onNavigate={setView}
        onSend={(text) => {
          submitUserMessage(hubRef.current as ChannelHub, text);
          logger.info('app', '用户输入提交（演示形态本地回执；集成期接引擎回合入口）', { length: text.length });
        }}
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

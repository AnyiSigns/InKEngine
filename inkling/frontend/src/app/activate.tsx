/**
 * 前端激活入口：供壳/测试注入调用，启动 InKling 产品面。
 *
 * 装配顺序：
 *  1. fe2 设置引擎注册各节（registerSettingsSections，含架构 tab）；
 *  2. fe3 市场/工具/OS/工作区/界面组件注册 + 五个 section 归一进设置注册表；
 *  3. 会话层（backend + channelHub + sessionStore）→ App 渲染。
 */

import { createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelHub } from '@/shared/session/channelHub';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import { createSessionStoreFrom } from '@/shared/backend/remoteSessionStore';
import { createBackend } from '@/shared/backend/backendAdapter';
import { listenHostEvent } from '@/shared/backend/tauriBridge';
import { createIngester, toHubEvent, setStreaming, commitStreaming } from '@/shared/session/eventIngest';
import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import { AppBackend } from './backend';
import { registerSettingsSections } from './settings/activate';
import { registerSettingsSection } from './settings/registry';
import { activate as activateWave4, viewRegistrations } from './views/wave4activate';
import { KnowledgePanel } from './knowledge/KnowledgePanel';
import { normalizeWave4Sections } from './wiring/normalizeWave4';
import App from '../App';

export function activate(): void {
  const backend = createBackend();
  const appBackend = new AppBackend({ backend });

  registerSettingsSections();

  const wave4 = activateWave4(appBackend);
  for (const section of normalizeWave4Sections(wave4.sections)) {
    registerSettingsSection(section);
  }

  // 视图组件经 DynamicComponent 渲染时注入 AppBackend（白名单键原样保留，
  // 同名覆盖：装配层闭包提供 backend，组件未声明 backend 的忽略该额外属性）。
  // 已注册组件清单视图自取 components_manifest 并刷新 artifactLoader 注册；
  // MCP 市场挂载动作接真：市场一键挂载（手动挂载，免审批卡）。
  for (const [key, Comp] of Object.entries(viewRegistrations)) {
    const C = Comp as unknown as ComponentType<Record<string, unknown>>;
    const extraProps: Record<string, unknown> = { backend: appBackend };
    if (key === 'mcp_market') {
      extraProps.onMount = (entry: { id: string }) => appBackend.mountMcp(entry.id);
      extraProps.onUnmount = (entry: { id: string }) => appBackend.unmountMcp(entry.id);
    }
    registerComponent(
      key,
      ((props: Record<string, unknown> = {}) => createElement(C, { ...props, ...extraProps })) as PlainComponent,
    );
  }

  registerComponent('knowledge_panel', KnowledgePanel as unknown as PlainComponent);

  const hub = new ChannelHub({});
  const fixtureStore = new MemorySessionStore([]);
  const sessionStore = createSessionStoreFrom(backend, () => fixtureStore);

  // 后端→前端回合事件流接线：宿主桥 round_event → 会话状态归约。
  // 引擎信封（EngineEvent）与前端 HubEvent 形态归一后逐条落位，消息流/
  // 审批卡/任务胶囊/模拟分支全部由此驱动；宿主不可用时订阅为空操作。
  if (backend.available) {
    const ingest = createIngester(hub);
    void listenHostEvent<Record<string, unknown>>('inkling://round_event', (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const event = toHubEvent(raw as Record<string, unknown>);
      // 跨会话事件隔离：真实 thread_id 与当前会话不匹配则跳过
      // （thread_id 缺失或系统值 '-' 不过滤）
      const tid = typeof event.payload.thread_id === 'string' ? event.payload.thread_id : '';
      const activeThread = hub.getSnapshot().activeSessionId;
      if (tid && tid !== '-' && activeThread && tid !== activeThread) return;
      ingest(event);
      if (event.type === 'end') {
        setStreaming(hub, false);
        commitStreaming(hub);
        // 回合结束回写当前会话消息到会话存储（历史落库）
        const snap = hub.getSnapshot();
        const storeThread = snap.activeSessionId;
        if (storeThread && typeof sessionStore.replaceMessages === 'function') {
          try {
            sessionStore.replaceMessages(storeThread, snap.messages);
          } catch {
            // 回写失败不影响实时流
          }
        }
      }
    });
  }

  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('缺少 #root 挂载点');

  createRoot(rootEl).render(
    <App
      backend={backend}
      hub={hub}
      sessionStore={sessionStore}
    />,
  );
}

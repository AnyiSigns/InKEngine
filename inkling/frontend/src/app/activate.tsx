/**
 * 前端激活入口：供壳/测试注入调用，启动 InKling 产品面。
 *
 * 装配顺序：
 *  1. fe2 设置引擎注册 9 节（registerSettingsSections）；
 *  2. fe3 四机制视图注册（activateViews → getRegisteredViews 消费）；
 *  3. fe4 市场/工具/OS/工作区/界面组件注册 + 五个 section 归一进设置注册表；
 *  4. 技能市场组件注册（导航入口消费，键名 skill_market）；
 *  5. 会话层（backend + channelHub + sessionStore）→ App 渲染。
 */

import { createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelHub } from '@/shared/session/channelHub';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import { createSessionStoreFrom } from '@/shared/backend/remoteSessionStore';
import { createBackend } from '@/shared/backend/backendAdapter';
import { registerComponent, type PlainComponent } from '@/renderer/componentRegistry';
import { AppBackend } from './backend';
import { registerSettingsSections } from './settings/activate';
import { registerSettingsSection } from './settings/registry';
import { activate as activateViews } from './views/activate';
import { activate as activateWave4, viewRegistrations } from './views/wave4activate';
import { SkillMarket } from './views/skills/SkillMarket';
import { KnowledgePanel } from './knowledge/KnowledgePanel';
import { normalizeWave4Sections } from './wiring/normalizeWave4';
import App from '../App';

export function activate(): void {
  const backend = createBackend();
  const appBackend = new AppBackend({ backend });

  activateViews();
  registerSettingsSections();

  const wave4 = activateWave4(appBackend);
  for (const section of normalizeWave4Sections(wave4.sections)) {
    registerSettingsSection(section);
  }

  // 视图组件经 DynamicComponent 渲染时注入 AppBackend（白名单键原样保留，
  // 同名覆盖：装配层闭包提供 backend，组件未声明 backend 的忽略该额外属性）。
  // 组件市场挂载动作接真：拉取 components_manifest 并注册产物（artifactLoader）。
  for (const [key, Comp] of Object.entries(viewRegistrations)) {
    const C = Comp as unknown as ComponentType<Record<string, unknown>>;
    const extraProps: Record<string, unknown> = { backend: appBackend };
    if (key === 'component_market') {
      extraProps.onMount = () => {
        void appBackend.refreshComponentManifest();
      };
    }
    registerComponent(
      key,
      ((props: Record<string, unknown> = {}) => createElement(C, { ...props, ...extraProps })) as PlainComponent,
    );
  }

  registerComponent('skill_market', SkillMarket as unknown as PlainComponent);
  registerComponent('knowledge_panel', KnowledgePanel as unknown as PlainComponent);

  const hub = new ChannelHub({});
  const fixtureStore = new MemorySessionStore([]);
  const sessionStore = createSessionStoreFrom(backend, () => fixtureStore);

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

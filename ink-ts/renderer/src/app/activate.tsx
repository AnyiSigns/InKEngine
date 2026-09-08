/**
 * 前端激活入口：供壳/测试注入调用，启动 InKling 产品面。
 *
 * 装配顺序：
 *  1. 出厂基线组件 + 真 ui 面插件注册（pluginFaces.generated.ts：settings 段
 *     面板 / 布局 canonical 叶子含 settings_floater，读派生清单 SETTINGS_SECTIONS）；
 *  2. 会话层（backend + channelHub + sessionStore）→ App 渲染。
 */

import { createRoot } from 'react-dom/client';
import { ChannelHub } from '@/shared/session/channelHub';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import { createSessionStoreFrom } from '@/shared/backend/remoteSessionStore';
import { createBackend } from '@/shared/backend/backendAdapter';
import {
  ROUND_EVENT_TOPIC,
  listenHostEvent,
  resolveServeChannel,
  setServeChannel,
} from '@/shared/backend/transport';
import { registerBuiltinComponents } from '@/components';
import { registerPluginFaces } from './pluginFaces.generated';
import { createIngester, toHubEvent, setStreaming, finalizeThreadStreaming, setThreadRoundActive } from '@/shared/session/eventIngest';
import { AppBackend } from './backend';
import { registerEventRenderers } from './renderers/eventRenderers';
import App from '../App';

export function activate(): void {
  // serve 通道装配：环境配置 VITE_SERVE_URL（+VITE_SERVE_TOKEN）即注入真
  // transport，backendAdapter 与事件订阅共用；无配置保持 stub（available:false）。
  setServeChannel(resolveServeChannel(import.meta.env as Record<string, string | undefined>));

  // 出厂基线组件注册（渲染器白名单基线；wave4 视图/产物清单按同名覆盖接管）
  registerBuiltinComponents();
  // 真 ui 面插件注册（派生视图 pluginFaces.generated.ts：按 spec faces.ui 声明
  // 静态 import 各插件 faces/ui 默认导出 → registerComponent；含布局 canonical
  // 叶子与 settings 段面板插件，阶段 7b 迁移随迁）
  registerPluginFaces();

  const backend = createBackend();
  const appBackend = new AppBackend({ backend });

  // 出厂组件启停同步到渲染器白名单（停用组件渲染占位拒绝；读取失败保持出厂全量）
  void appBackend.syncUiComponentGate();

  // agent 产物事件渲染器（artifact 逃生口共享面；原 wave4activate 内注册）
  registerEventRenderers();

  const hub = new ChannelHub({});
  const fixtureStore = new MemorySessionStore([]);
  const sessionStore = createSessionStoreFrom(backend, () => fixtureStore);

  // serve 通道→前端回合事件流接线：round_event 订阅 → 会话状态归约。
  // 引擎信封（EngineEvent）与前端 HubEvent 形态归一后逐条落位，消息流/
  // 审批卡/任务胶囊/模拟分支全部由此驱动；通道不可用（serve 未就绪，
  // transport stub）时订阅为空操作，测试注入 mock 后端即自驱。
  if (backend.available) {
    const ingest = createIngester(hub);
    void listenHostEvent<Record<string, unknown>>(ROUND_EVENT_TOPIC, (raw) => {
      if (!raw || typeof raw !== 'object') return;
      const event = toHubEvent(raw as Record<string, unknown>);
      // 跨会话事件一律交给 ingest 分桶：ingest 已按 targetThread 正确分桶，
      // 仅 isActive 时镜像到全局窗口；非活跃会话数据只入桶不污染当前窗口。
      ingest(event);
      if (event.type === 'end') {
        // 回合结束收尾按事件自身线程执行（end 事件的 thread_id）：
        // 窗口切走后结束的后台回合只定型并回写其桶/存储，不污染当前窗口
        const rawThread = typeof event.payload.thread_id === 'string' ? event.payload.thread_id : '';
        const snap0 = hub.getSnapshot();
        const threadId = rawThread && rawThread !== '-' ? rawThread : snap0.activeSessionId;
        const bucket0 = snap0.perThread[threadId];
        finalizeThreadStreaming(hub, threadId);
        setThreadRoundActive(hub, threadId, false);
        const snap = hub.getSnapshot();
        const finalMsgs = snap.perThread[threadId]?.messages ?? bucket0?.messages ?? [];
        if (threadId === snap.activeSessionId) setStreaming(hub, false);
        if (finalMsgs.length > 0 && typeof sessionStore.replaceMessages === 'function') {
          try {
            sessionStore.replaceMessages(threadId, finalMsgs);
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

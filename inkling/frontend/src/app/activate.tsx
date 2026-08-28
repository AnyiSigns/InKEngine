/**
 * 前端激活入口：供壳/测试注入调用，启动 InKling 产品面。
 */

import { createRoot } from 'react-dom/client';
import { ChannelHub } from '@/shared/session/channelHub';
import { MemorySessionStore } from '@/shared/session/sessionStore';
import { createSessionStoreFrom } from '@/shared/backend/remoteSessionStore';
import { createBackend } from '@/shared/backend/backendAdapter';
import App from '../App';

export function activate(): void {
  const backend = createBackend();
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

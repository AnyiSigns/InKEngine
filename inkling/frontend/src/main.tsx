import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { initThemeModeAtStartup } from './renderer/themeMode';
import './index.css';

// 首屏前解析主题偏好（index.html 内联脚本已预挂；此处二次确认同步状态）
initThemeModeAtStartup();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('缺少 #root 挂载点');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initThemeModeAtStartup } from './renderer/themeMode';
import './index.css';

import { activate } from './app/activate';

initThemeModeAtStartup();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('缺少 #root 挂载点');

createRoot(rootElement).render(
  <StrictMode>
    <AppWrapper />
  </StrictMode>,
);

function AppWrapper() {
  activate();
  return null;
}

import { initThemeModeAtStartup } from './renderer/themeMode';
import './index.css';

import { activate } from './app/activate';
import { PRODUCT_NAME, PRODUCT_TAGLINE } from './shared/identity';

initThemeModeAtStartup();

// 窗口标题随 manifest 身份（单一事实源；index.html 静态 title 仅作 JS 前回退）。
document.title = `${PRODUCT_NAME} · ${PRODUCT_TAGLINE}`;

// 激活入口统一在模块顶层执行一次：activate() 内部自建 root 渲染 App，
// 不在 render 体内调用（避免 StrictMode 重复 createRoot / 重复订阅）。
activate();

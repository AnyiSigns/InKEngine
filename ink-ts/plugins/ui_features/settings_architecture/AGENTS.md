# settings_architecture（per-plugin AGENTS）

真 ui 面插件（设置面板）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置「架构」段：机制装配实时架构视图（Pool/EdgeEvidence 页签 + 图），经产品壳 architecture live 面呈现。

## 数据从哪进 / 挂载

- 挂载 = 设置面板：不经布局树 $ref——spec data.settings_section 经生成器 settingsSections.generated.ts（住 hosts/web/src/app/settings/）settings 派生清单引用，设置浮层读清单渲染左导航、内容 DynamicComponent name=插件 id（settings_architecture）；真源注册同 pluginFaces.generated.ts。
- 数据：hosts/web 产品壳 app/views/architecture（backend/mockBackend live 面）；ArchitectureView 组合 Pool/EdgeEvidence 页签。私有样式随插件同住 = `faces/ui/architecture.module.css`（CSS Modules 作用域，色值走 --ink-* token），空态组件 EmptyState 自带 `EmptyState.module.css`（hosts/web 资产本地样式），不再裸引全局样式表。
- 只读诊断面；live 后端不可用 = 空态占位。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

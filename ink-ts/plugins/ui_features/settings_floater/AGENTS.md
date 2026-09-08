# settings_floater（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

设置浮层壳（canonical 叶子 + settings 壳）：读派生清单 SETTINGS_SECTIONS 渲染左导航，内容按插件 id 经 DynamicComponent name 渲染（真 ui 面注册表 = pluginFaces.generated.ts）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（settings_floater）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：settingsOpen（显隐）/ onCloseSettings；导航数据 = hosts/web/src/app/settings/settingsSections.generated.ts 派生清单（真源 = 各面板 spec data.settings_section）。
- 面板内容即改即存由各面板自管；本壳只组装导航 + DynamicComponent。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

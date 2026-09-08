# agent_input（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

输入胶条（canonical 叶子）：发送/中止/附件/模型选择/路由预览/子代理指令等，chrome → InputBar props 映射。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（agent_input）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：onSend/onAbort/onAttachments/onAgentModelSelect/onRoutePlanPreview/routePlan/streaming/roundCount 等；附件资产经 shared/upload（fileAsset）。
- bind/本地态：输入态与可发送性组件内自管；发送走 chrome.onSend（回合恒为组装：单一发送面）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

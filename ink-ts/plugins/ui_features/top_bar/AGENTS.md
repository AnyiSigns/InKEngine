# top_bar（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

顶栏（canonical 叶子）：会话标题/待办标签/路由预览/模型选择/中止/分支等产品动作入口，chrome → TopBar props 映射。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（top_bar）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：title/onTitleChange、hasTodo/todoPending、routePlan/onRoutePlanPreview、models/agentModelId/onAgentModelSelect、streaming/onAbort、onBranchFromMessage 等（映射面见 faces/ui/index.tsx）。
- 本地态：下拉/弹层开合等纯 UI 态组件内自管。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

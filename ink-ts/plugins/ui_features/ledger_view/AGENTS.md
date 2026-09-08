# ledger_view（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

台账视图（canonical 叶子）：演化/审计台账浏览（backend；host 不可用 = 禁用态空态）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（ledger_view）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：backend/activeSessionId；读面经 backendAdapter 契约（如 ledger 快照），无宿主 = 空态占位。
- 只读展示，写台账走引擎受控通道（GuardedStorage/EvolutionWriter），不经本视图。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

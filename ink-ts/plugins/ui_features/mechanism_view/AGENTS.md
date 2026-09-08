# mechanism_view（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

机制视图（canonical 叶子）：当前机制装配/端口/契约可视化（backend + threadId）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（mechanism_view）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：backend/activeSessionId（available:false → 空态说明）；图数据经产品壳 architecture live 面（DagRenderer）。
- 展示引擎装配闭集/机制件契约数据，不做写操作。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

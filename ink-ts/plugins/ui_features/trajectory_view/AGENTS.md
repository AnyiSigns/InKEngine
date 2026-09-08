# trajectory_view（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

回合轨迹视图（canonical 叶子）：渲染回合步骤轨迹（state.roundSteps bind + product.roundSteps 回落）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（trajectory_view）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- bind：state.roundSteps（回合步骤流）；chrome 读面：roundId/roundCount/stepCount。
- 纯读回合数据，回退/分支动作由 chrome（onBranchFromLeaf 等）出口。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

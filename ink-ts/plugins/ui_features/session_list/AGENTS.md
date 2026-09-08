# session_list（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

会话右栏（canonical 叶子）：会话列表 + 线程分支 mini，chrome 声明切片 → RightRail props 映射（折叠为本地 UI 态）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（session_list）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：sessions（thread_id/title/updated_at）/activeSessionId、branchTrees（线程分支树）、onSelectSession/onCreateSession/onRenameSession/onDeleteSession/onBranchFromMessage/onBranchFromLeaf。
- 阶段 9b-2 起：以上声明名经 spec faces.ui.access（store/inject 清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props，适配器不读全量 product。
- 本地态：折叠/选中高亮组件内自管。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

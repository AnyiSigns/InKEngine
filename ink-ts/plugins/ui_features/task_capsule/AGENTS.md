# task_capsule（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

跨回合长任务胶囊（canonical 叶子）：chrome.task（plan/spawn/tool 长任务态）缺省 = 空态不渲染。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（task_capsule）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：task（goal/status/step/next_step；由 App 从 task_state 子通道派生）；长任务期出现，结束后自动消失。
- 阶段 9b-2 起：以上接入名经 spec faces.ui.access（store/inject 清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props，适配器不读全量 product。
- 无自身数据拉取；task_state 归约在 hosts/web 壳（App）完成。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

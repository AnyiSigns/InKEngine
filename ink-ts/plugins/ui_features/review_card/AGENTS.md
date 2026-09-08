# review_card（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

审批卡浮层（canonical 叶子）：events.review_card 绑定的审批决议卡，读绑定载荷（bindValue = 卡事件，ev.payload = 卡载荷 + thread 续跑）并触发决议动作（onResolveReview 续跑对应线程）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（review_card）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- 接入面：决议动作 onResolveReview 经 spec faces.ui.access inject（清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props；卡载荷 = events.review_card 绑定（bindValue），不经 product 读面。
- 本地态：卡展开/详情等纯 UI 态组件内自管。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

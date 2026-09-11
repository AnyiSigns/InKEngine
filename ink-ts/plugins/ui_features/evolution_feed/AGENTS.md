# evolution_feed（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

状态页主视图（canonical 叶子）：孵化/补丁动态时间线 + 协作项目录（只读）。
「当前回合图组成」段随 graph.instance 组装图投影退役删除（W7-B）；图形态的
执行观察走执行树（execution.run 回执投影）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（evolution_feed）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- chrome 读面：backend（available:false → 禁用态空态占位）+ activeSessionId；
  组装图实例快照映射（mapInstanceSnapshot/graph.instance）已随退役删除（W7-B）。
- 阶段 9b-2 起：以上接入名经 spec faces.ui.access（store/inject 清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props，适配器不读全量 product。
- 读面经 backendAdapter 契约；无宿主 = 空态不拉假数据。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

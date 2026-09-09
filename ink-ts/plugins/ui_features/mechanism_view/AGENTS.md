# mechanism_view（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

状态页机制读取面（canonical 叶子）：分层卡只读投影——① 回合概览（回合/自动续跑轮/失败/失败率，自动续跑轮独立计数随 metrics 快照字段，缺省「—」待字段）、② 结点池卡（结点注册目录 registry + 治理 + 边证据 + 实体）、④ 机制装配次级小卡组（组装链/指纹缓存）。③ 当前回合图组成清单由 evolution_feed 侧呈现，本组件不重复拉图数据。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（mechanism_view）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿；随 inkling.ui.evolution 直入页面，无 group_card 折叠壳）。
- chrome 读面：backend/activeSessionId（available:false → 空态说明）；读面经 shared BackendAdapter 取 pool/metrics/edge/entities/assemble/cache/path 只读投影。
- 阶段 9b-2 起：以上接入名经 spec faces.ui.access（store/inject 清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props，适配器不读全量 product。
- 展示引擎装配闭集/机制件契约数据，不做写操作。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

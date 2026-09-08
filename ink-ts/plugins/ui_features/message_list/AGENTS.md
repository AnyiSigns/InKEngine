# message_list（per-plugin AGENTS）

真 ui 面插件（canonical 布局叶子）。声明真源 = 本目录 `spec.json`（kind=ui_feature、faces.ui target=web、data.node / data.settings_section）——本文件只写意图/边界，不重复 spec 声明字段。

## 是什么能力

消息流唯一渲染面（canonical 叶子）：会话消息/回合产物消息渲染（bind state.messages + chrome 派生面）。

## 数据从哪进 / 挂载

- 注册名 = 插件 id（message_list）；hosts/web 装配期 pluginFaces.generated.ts 静态 import 本 faces/ui/index.tsx 默认导出并注册进显示设备 componentRegistry；spec 渲染按 data.node.type 命中（canonical 布局叶子，经容器 data.children.$ref 引用，无孤儿）。
- bind：state.messages（会话消息流）；chrome 读面：roundSteps/simulations/incubation/patchChain/spawnInstances/task/streaming/onBranchFromMessage 等按消息类型消费。
- 阶段 9b-2 起：以上接入名经 spec faces.ui.access（store/inject 清单见 spec.json）壳 accessAwareFace 切片注入为顶层 props，适配器不读全量 product。
- 消息类型渲染经显示设备 messageRendererRegistry（agent 产物事件渲染器在 hosts/web 壳装配期注册）。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config plugins/vitest.config.ts`）。
- 别名：`@app/*` = hosts/web 产品壳、`@/*` = renderer/src 显示设备（plugins 与 hosts/web 的 vite/vitest/tsconfig 同构声明）；禁 import engine 包。

# file_tree（per-plugin AGENTS）

canonical 布局叶子真 ui 面样板（布局树左栏）。声明真源 = 本目录 `spec.json`
（kind=ui_feature、faces.ui target=web、data.node.type=file_tree、data.node.props
折叠态语义）——本文件只写意图/边界。

## 是什么能力

产品主壳左栏（工作区授权卡 + 设置入口，折叠态为本地 UI 状态）。装配入口 =
`faces/ui/index.tsx` 默认导出（FileTreeAdapter）：把 hosts/web 注入的
product chrome 映射为 `LeftRail` props——`authorized`/`workspaceRoot`/
`onAddWorkspace`/`onOpenSettings`；折叠态用组件本地 useState 保持。

## 数据从哪进

- 注册名 = 插件 id（file_tree），经 hosts/web 装配期
  `pluginFaces.generated.ts` 静态 import 本默认导出并注册进显示设备
  componentRegistry；spec 渲染时按 `data.node.type` 命中。
- 组件只消费 chrome 载荷与 bind 白名单通道，不自建数据面/不 import engine。
- 同目录 `*.test.tsx` 走 jsdom + RTL（`vitest run --config
  plugins/vitest.config.ts`）。

## 别名与边界

- faces 内 import：`@app/*` = hosts/web 产品壳（productView 类型）、
  `@/*` = renderer/src 设备资产；两别名在 plugins 与 hosts/web 的
  vite/vitest 配置同构声明。
- 不改 spec/布局结构（新增/删除节点改 spec + 父容器 $ref + 重跑生成器，
  禁手改 ui.generated.json）。

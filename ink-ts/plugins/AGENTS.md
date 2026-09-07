# plugins 插件源（AGENTS.md）

本目录是 ink-ts **能力插件统一真源**（声明驱动装载的唯一手改处），对应
PLUGINS.md §1 分发格式与 docs/component_data_endgame.md §三「统一插件源」。

## 目录约定（按 kind 分子目录）

```
plugins/
├─ AGENTS.md            # 本文件：插件源就近权威（手改纪律 + spec 契约）
├─ tools/               # kind='tool' 插件域：一个工具一个目录
│   └─ <tool-name>/     #   目录名 = 工具名（collect_material）
│       ├─ package.json #   npm 包名 = @ink-ts/plugin-<kebab-case>（下划线转连字符）
│       └─ spec.json    #   声明（id/kind='tool'/capability/data.tool = 原工具行）
├─ mcp/                 # kind='mcp' 插件域：一个市场候选 server 一个目录
│   ├─ market.json      #   市场级元数据真源（premounted/mount_policy；禁手改的派生
│   │                   #   manifest 不承载此类全局配置）
│   └─ <server-id>/     #   目录名 = server id（market.<kebab>）
│       ├─ package.json #   npm 包名 = @ink-ts/plugin-market-<kebab>
│       └─ spec.json    #   声明（id/kind='mcp'/capability='external_tool'/data.server）
├─ commands/            # kind='command' 插件域：一个命令方法一个目录
│   └─ <method>/        #   目录名 = 方法名（rounds.send；含点号）
│       ├─ package.json #   npm 包名 = @ink-ts/plugin-<kebab>（点号/下划线转连字符）
│       └─ spec.json    #   声明（id=方法名/kind='command'/capability='host_tool'/
│                        #   data.group=实现域（DOMAIN_TABLE 之一）/data.order=域内序号）
├─ ui_features/         # kind='ui_feature' 插件域：一布局树节点一插件（阶段 3b2）
│   ├─ inkling.ui/      #   装配入口（唯一）：data = name/version/theme + root.$ref
│   ├─ inkling.ui.root/ #   容器节点：data.node（container）+ data.children（$ref 序）
│   ├─ file_tree/       #   组件节点：data.node（component，叶子无 children）
│   └─ ...              #   其余容器/组件节点同上（一节点一插件全平铺）
│       ├─ package.json #   npm 包名 = @ink-ts/plugin-<kebab>（点号/下划线转连字符）
│       └─ spec.json    #   声明（id/kind='ui_feature'/capability='host_tool'/
│                        #   data.node + data.children）
├─ manifest.json        # 派生视图（生成物，禁手改）：plugins 索引 + tools 聚合 +
│                       #   mcp 市场视图 + ui_features 组件白名单；由
│                       #   scripts/sync_plugin_manifest.mjs 生成，--check 强制漂移为红
├─ ui.generated.json    # 派生视图（生成物，禁手改）：产品主壳布局树（装配入口 $ref
│                       #   展开；渲染器 UISpec 同构）；同脚本生成，--check 强制
└─ scripts/
    └─ sync_plugin_manifest.mjs   # 生成器（plugins 真源 → manifest.json +
                                  # host/src/bridge/commands.generated.ts +
                                  # ui.generated.json +
                                  # host/src/bridge/ui_canonical.generated.ts 派生视图）
```

kind 全集（PLUGINS.md §1）为 8 值：`tool | command | ui_feature | endpoint |
recipe | executor | mcp | host`——plugins/ 按 kind 分子目录，其中 `host`
例外住 `hosts/<host>.spec.json`（不进 plugins/）。阶段 3a 已落地 `tools/` 与
`mcp/` 两域；阶段 3b1 落地 `commands/`（66 命令，方法名真源迁移 plugins）；
阶段 3b2 落地 `ui_features/`（25 节点插件 + 装配入口，产品主壳布局真源迁移
plugins，生成物 ui.generated.json 取代 seed_data/ui_spec.json）；其余 kind
目录随对应阶段落位。

## spec.json 契约（真源声明）

每插件一份 spec.json，顶层字段对齐 PLUGINS.md CapabilityComponent 骨架：

```jsonc
{
  "id": "collect_material",        // 注册表键，全局唯一（工具 = 工具名）
  "kind": "tool",                  // 仅 8 kind 之一（host 例外见上）
  "capability": "host_tool",       // core_tool | host_tool | external_tool
  "depends": [],
  "actions": [],
  "data": { "tool": { /* 原工具声明行逐字：name/description/parameters/... */ } }
}
```

- 工具声明行（`data.tool`）为 tools.json 迁入时的**原字段逐字保留**
  （description/parameters/permissions/approval/endpoint/endpoint_config/
  network_policy/meta 不变）；真源唯一化在此，不另设第二份工具目录；
- mcp 候选（`data.server`）同理逐字保留原 mcp_market 条目字段；
- 命令插件（`data.group`/`data.order`）：方法名真源 = spec.id（目录名）；
  `data.group` = 实现域（31 值之一，见生成器 DOMAIN_TABLE——域文件分组，
  如 rounds.todos 实现独立 todos.ts 但其语义属 rounds），`data.order` = 域内
  序号（1..n 连续）；跨域序由生成器 DOMAIN_TABLE 固定清单决定
  （= BRIDGE_METHODS spread 序，夹具逐字比对）；
- ui_feature 插件：一布局树节点一插件。装配入口（唯一，id=inkling.ui）
  `data` = name/version/theme + root.$ref；容器节点 `data.node`（kind=
  container/type + props）+ `data.children`（按序 [{ "$ref": "<插件 id>" }]）；
  组件节点 `data.node`（kind=component/type + props/bind，叶子不带 children）。
  布局树节点内容自 seed_data/ui_spec.json 迁入时逐字保留（props/bind 键序
  不变）；生成器 DFS 沿 $ref 展开重建完整树（ui.generated.json）+ canonical
  组件白名单（ui_canonical.generated.ts / manifest ui_features.components）；
  删节点插件须同步删父容器 children 里的 $ref，孤儿引用 fail-closed；
- faces/impl/locale 不在此阶段出现：data-only 声明插件无独立执行体
  （共享 inkling_exec/inkling_shell 等端点），faces 待阶段 4 挂接真实
  逻辑/ui 脸时随目录补建；
- 本阶段不设每插件 AGENTS.md（data-only 声明以 spec.json 为行为唯一事实
  源，per-plugin AGENTS 留待挂 faces 的插件补建，防行为文案第二份漂移）；
  manifest.json / commands.generated.ts / ui.generated.json /
  ui_canonical.generated.ts 派生视图禁手改，改工具/命令/市场/ui 声明只改
  对应 spec.json。

## 手改与生成纪律

1. **真源唯一**：改工具/命令/市场/ui 声明 → 改对应 `plugins/tools/<name>/spec.json`
   / `plugins/commands/<method>/spec.json` 或 `plugins/mcp/<id>/spec.json` 或
   `plugins/ui_features/<id>/spec.json`；manifest.json 与
   host/src/bridge/commands.generated.ts、plugins/ui.generated.json、
   host/src/bridge/ui_canonical.generated.ts 是生成物，禁手改；
2. **同步派生**：改任一 spec 后重跑
   `node plugins/scripts/sync_plugin_manifest.mjs`（或 `--check` 校验），
   消费方（web dev 夹具 / host mcp.market / tools_os 夹具生成 / self_check
   门禁）经 plugins/manifest.json 取用；host bridge 命令面经
   commands.generated.ts（域实现文件 import type/re-export）取用；web 产品
   主壳经 ui.generated.json 取用；host 配方界面白名单经
   ui_canonical.generated.ts 取用。命令面增删 = 新增/删除
   plugins/commands/<method>/ 目录并同步 CODING.md §9 表 + 重跑生成器；
   ui 布局增删节点 = 新增/删除 plugins/ui_features/<id>/ 目录（删 = 同时删
   父容器 children 的 $ref）+ 同步 web 适配器注册 + 重跑生成器；
3. JSON 纪律：spec/package/manifest 均守 gate json-valid（可 parse、无重复
   键、2 空格缩进），`plugins/` 已入 gate jsonScanDirs；
4. 依赖/卸载/faces 语义（阶段 4）：kind/depends/capability 字段先行就位，
   本阶段不装配运行期装载。

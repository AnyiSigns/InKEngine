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
│   │   ├─ faces/ui/    #   真 ui 面（canonical 叶子/设置面板）：index.tsx 默认
│   │   │               #   导出适配器 + 实现与 *.test.tsx 同住（阶段 7b）
│   │   ├─ package.json #   npm 包名 = @ink-ts/plugin-<kebab>（点号/下划线转连字符）
│   │   └─ spec.json    #   声明（id/kind='ui_feature'/capability='host_tool'/faces.ui + data.node）
├─ endpoints/           # kind='endpoint' 插件域：一个原生执行件一个目录（阶段 6）
│   ├─ exec/            #   exec OS 执行器（data.native.file=exec）
│   ├─ infer/           #   infer 本地嵌入推理（data.native.file=infer）
│   └─ mcp/             #   ink_ts_mcp 内置 MCP server（data.native.file=ink_ts_mcp）
│       ├─ package.json #   npm 包名 = @ink-ts/plugin-<kebab>
│       └─ spec.json    #   声明（id/kind='endpoint'/capability='host_tool'/
│                        #   data.native = { file 二进制文件名, env 覆盖键 }）
├─ manifest.json        # 派生视图（生成物，禁手改）：plugins 索引 + tools 聚合 +
│                       #   mcp 市场视图 + ui_features 组件白名单；由
│                       #   scripts/sync_plugin_manifest.mjs 生成，--check 强制漂移为红
├─ ui.generated.json    # 派生视图（生成物，禁手改）：产品主壳布局树（装配入口 $ref
│                       #   展开；渲染器 UISpec 同构）；同脚本生成，--check 强制
└─ scripts/
    └─ sync_plugin_manifest.mjs   # 生成器（plugins 真源 → manifest.json +
                                  # hosts/lib/src/bridge/commands.generated.ts +
                                  # ui.generated.json +
                                  # hosts/lib/src/bridge/ui_canonical.generated.ts +
                                  # hosts/lib/src/exec/native.generated.ts +
                                  # hosts/web/src/app/pluginFaces.generated.ts +
                                  # hosts/web/src/app/settings/settingsSections.generated.ts 派生视图）
```

kind 全集（PLUGINS.md §1）为 8 值：`tool | command | ui_feature | endpoint |
recipe | executor | mcp | host`——plugins/ 按 kind 分子目录，其中 `host`
例外住 `hosts/<host>.spec.json`（不进 plugins/）。阶段 3a 已落地 `tools/` 与
`mcp/` 两域；阶段 3b1 落地 `commands/`（66 命令，方法名真源迁移 plugins）；
阶段 3b2 落地 `ui_features/`（25 节点插件 + 装配入口，产品主壳布局真源迁移
plugins，生成物 ui.generated.json 取代 seed_data/ui_spec.json）；阶段 6 落地
`endpoints/`（exec/infer/mcp 三件，原生执行件定位声明真源）；阶段 7b 落地
真 ui 面全量真身化：web 前端包更名 renderer/ 后阶段 2 再收敛——产品壳（App/
activate/state/chrome 与插件注册生成物）独立成 `hosts/web/`（@ink-ts/web），
renderer/ 为纯显示设备库（@ink-ts/renderer），ui_features 域扩至 38 插件
（canonical 布局叶子/设置面板/设置浮层真 ui 面 26；ledger_view 随 records/
ledger 移除后曾 36 插件 = 25 真 ui 面（12 叶子 + 13 面板）；B4 权限/插件收敛
把 mcp_market+tools_panel 两设置段合并为 plugins 段，现 148 插件 =
ui_feature 34 + 真 ui 面 24（12 布局叶子 + 12 设置面板，设置段 12），faces/ui
同住实现与测试，renderer 适配层整体退役）；其余 kind 目录随对应阶段落位。

## spec.json 契约（真源声明）

每插件一份 spec.json，顶层字段对齐 PLUGINS.md CapabilityComponent 骨架：

```jsonc
{
  "id": "collect_material",        // 注册表键，全局唯一（工具 = 工具名）
  "kind": "tool",                  // 仅 8 kind 之一（host 例外见上）
  "capability": "host_tool",       // core_tool | host_tool | external_tool
  "depends": [],                   // 可引用插件 id 或机制端口 id（storage_seam/llm_port/exec_envelope/rounds.port）
  "actions": [],
  // 以下为可选全脸字段（阶段 4 schema 能力；内置插件缺省即 data-only——
  // ui_feature 组件叶子/设置面板的真 ui 面例外，声明 faces.ui 即真面插件）：
  // "faces":   { "ui": { "target": "web", "entry": "./faces/ui/index.tsx" } },
  //            { "logic": { "target": "host", "entry": "./faces/logic" } },
  // "contract": { "effects": ["rounds.port"] },
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
- 真 ui 面（阶段 7b 全量真身化）：canonical 布局叶子（组件节点）与设置面板
  插件声明 `faces.ui`（target=web，entry=./faces/ui/index.tsx 相对插件目录），
  实现 = faces/ui/ 下 index.tsx 默认导出（布局叶子经 index 把 product chrome
  映射为组件 props）+ 实现与同目录 *.test.tsx 同住；hosts/web 壳装配经生成物
  pluginFaces.generated.ts（第 6 派生产物）静态 import 各默认导出注册进
  componentRegistry 白名单（注册名 = 插件 id）。设置面板另声明
  `data.settings_section`（key/label/order/icon）——不经布局树引用，经生成器
  settingsSections.generated.ts（第 7 派生产物）settings 派生清单引用，浮层
  读清单渲染左导航、内容 DynamicComponent name=插件 id；可达性统一规则：除
  装配入口外每 ui_feature 插件须被容器 data.children $ref 或
  data.settings_section 二者之一引用（无孤儿、无豁免，verify_unload 与生成器
  同源双保险）；
- endpoint 插件（阶段 6）：一个原生执行件一个目录（exec/infer/mcp；id =
  二进制定位 kind，注册表全局唯一），`data.native` = { file: 二进制文件名,
  env: env 单文件覆盖键 }——真源唯一化在 plugins/endpoints/<id>/spec.json，
  派生视图 hosts/lib/src/exec/native.generated.ts（NATIVE_BINARY_DECLS +
  NativeBinaryKind 类型）由此生成，hosts/lib/src/exec/binary.ts 按声明定位
  （binary.ts 不再手写 env/文件名表）；改端点声明只改 spec.json + 重跑
  生成器；
- faces/impl/locale 物理目录：data-only 声明插件（tools/mcp/commands 与无真面
  ui 容器）无独立执行体（共享 inkling_exec/inkling_shell 等端点）；真 ui 面
  物理目录 = ui_feature 插件 faces/ui/（index.tsx 默认导出 + 同住测试），
  host logic face 物理目录 = faces/logic/（doc_parse）；spec 顶层 **faces 声明
  字段能力**在阶段 4 立好（形状经生成器、引用语义经 verify:unload 强制）；
- 阶段 4 data-only 定案（2026-09-07）后经两轮真面许可收窄：现有内置插件
  （tools/mcp/commands/无真面 ui 容器）仍 **data-only**——共享 exec 端点/共享
  域实现/共享渲染原语，无插件独占实现面，**不填占位 faces/depends/contract**
  （避免第二份平行真相；若加真值，verify_unload 的 data-only 状态引脚会红并
  提示同步文档）。**真面许可**：capability=external_tool 的外部插件；
  verify_unload `REAL_FACE_BUILTINS` 白名单内置（仅 doc_parse——host logic
  face 样板，白名单增删须同步 verify_unload.ts 与本文档）；或 ui_feature
  组件节点（isUiComponent，阶段 7b 起 canonical 叶子/设置面板/浮层的独占 UI
  实现随 faces/ui 同住，属渲染器真 ui 面而非数据层第二真相）；
- 阶段 7a 首真面（2026-09-07）：`tools/doc_parse/` 声明 faces.logic
  （target=host，entry=./faces/logic/index.ts）+ depends=['exec']（原生执行件
  端点插件）；实现（DocService/DocParser 执行体）随插件同住于
  `faces/logic/index.ts` + 同目录 `index.test.ts`，经 `vitest run --root
  plugins` 执行；host 装配期由 `hosts/lib/src/face/loader.ts` 按声明装载（缺插件
  源 = docParse 缺省降级；face 装载/契约不符 = 装配期 fail-closed）；faces
  entry 物理同住（相对路径禁逃逸 + 文件真实存在）由 verify:unload 强制；
- per-plugin AGENTS 政策（细则见 docs/subsystems/plugins.md）：**data-only 声明
  插件（tools/mcp/commands 与无真面 ui 容器）不设 AGENTS.md**——以 spec.json
  为行为唯一事实源，防行为文案第二份漂移；**真面/样板插件必配**——host logic
  face（doc_parse）与真 ui 面插件 25（canonical 布局叶子 12 + 设置面板 13，
  含设置浮层）2026-09-08 全量补建，只写意图/边界/数据从哪进，不重复 spec
  声明字段；
  manifest.json / commands.generated.ts / ui.generated.json /
  ui_canonical.generated.ts / hosts/lib/src/exec/native.generated.ts /
  hosts/web/src/app/pluginFaces.generated.ts /
  hosts/web/src/app/settings/settingsSections.generated.ts 派生视图禁手改，
  改工具/命令/市场/ui/endpoint 声明只改对应 spec.json。
- 真 ui 面私有样式纪律（阶段 9a 起）：faces/ui 可随插件同住 `*.module.css`
  （CSS Modules，构建期作用域哈希隔离——class 名不逃逸、插件互不污染）；
  共享 token/语义类仍经既有 index.css/themeTokens/designTokens 供应，
  **禁硬编码颜色、禁裸引跨包全局样式表**（如 hosts/web 的共享整页 css）；
  跨插件共用的展示资产（如 EmptyState）自带本地 `*.module.css`，不消费方
  各自裸引。类型 = vite/client `*.module.css` 声明（plugin faces 经
  pluginFaces.generated.ts 静态 import 纳入 hosts/web program）；vitest
  css:false 下 module.css 由 stub 承接，测试零感知。
- 真 ui 面接入契约（阶段 9b 起）：faces/ui 可随插件同住可选声明 `access` =
  { store?: string[], inject?: string[] } 显式声明数据接入面（store = 数据/
  服务座位、inject = 宿主动作），**名称一律取自接入词表单一真源**
  `hosts/web/src/app/shell/hostAccessVocab.ts`（ProductShellModel 键 ∪
  ProductShellActions 键，编译期锁 keyof），**禁自由命名、禁数据-only 插件
  占位声明**；JS 形状由生成器 sync_plugin_manifest.mjs 守，语义（仅真 ui 面
  合法 + store/inject 槽位词表命中）由 verify:unload 守；声明全量随 faces
  带进 manifest plugins[] 行。
  **切片注入**：canonical 叶子/设置面板默认导出经
  pluginFaces.generated.ts 注册时套 `accessAwareFace` 包装（真源
  `hosts/web/src/app/shell/accessAwareFace.tsx`）——声明 access 的面由壳按
  声明把 product chrome 切成只含声明名（顶层 props，全量 product 被剥，无
  隐式全量注入；读词表外字段 = undefined），未声明 access 的面原样透传。
  settings_floater 是「面板挂载壳」壳特例：需全量 chrome 作面板切片源，豁免
  不迁（不声明 access）。适配器只消费声明的顶层切片名（禁读 props.product）。
  13 设置面板全量随迁（mcp_market 试点先行；settings_general 无宿主数据需求
  不声明）——面板不再各自自建 AppBackend/BackendAdapter 实例：AppBackend 组
  （tools_panel/workspace_auth/ui_editor_host）store:["appBackend"]，
  BackendAdapter 组（settings_architecture/connect/backup/audit_recovery/
  model/knowledge/memory/insights）store:["backend"]，faces/ui 改消费注入座位
  （组件增可选 backend prop，ops 工厂接共享 adapter；缺注入惰性回退自建，
  壳外挂载/测试不白屏）。外来 UI 插件同一契约三件套 = 自带 faces/ui +
  `*.module.css`（9a）+ spec faces.ui.access 声明接入，装载 seam 走既有
  external_tool 通道。

## 手改与生成纪律

1. **真源唯一**：改工具/命令/市场/ui/endpoint 声明 → 改对应
   `plugins/tools/<name>/spec.json` / `plugins/commands/<method>/spec.json` /
   `plugins/mcp/<id>/spec.json` / `plugins/ui_features/<id>/spec.json` /
   `plugins/endpoints/<id>/spec.json`；manifest.json 与
   hosts/lib/src/bridge/commands.generated.ts、plugins/ui.generated.json、
   hosts/lib/src/bridge/ui_canonical.generated.ts、hosts/lib/src/exec/native.generated.ts、
  hosts/web/src/app/pluginFaces.generated.ts、
  hosts/web/src/app/settings/settingsSections.generated.ts
   是生成物，禁手改；
2. **同步派生**：改任一 spec 后重跑
   `node plugins/scripts/sync_plugin_manifest.mjs`（或 `--check` 校验），
   消费方（hosts/web dev 夹具 / hosts/web mcp 候选夹具 / tools_os 夹具生成 / self_check
   门禁）经 plugins/manifest.json 取用；host bridge 命令面经
   commands.generated.ts（域实现文件 import type/re-export）取用；产品
   主壳经 ui.generated.json 取用；host 配方界面白名单经
   ui_canonical.generated.ts 取用；host 原生执行件定位经
   native.generated.ts 取用（binary.ts 按声明定位）；hosts/web 壳真 ui 面注册经
   pluginFaces.generated.ts 取用；settings 浮层经 settingsSections.generated.ts
   取用。命令面增删 = 新增/删除
   plugins/commands/<method>/ 目录并同步 CODING.md §9 表 + 重跑生成器；
   ui 布局增删节点 = 新增/删除 plugins/ui_features/<id>/ 目录（删 = 同时删
   父容器 children 的 $ref）+ 重跑生成器；新增真 ui 面 = 组件节点/设置面板
   插件声明 faces.ui（entry 相对路径 + faces/ui 内 index.tsx 默认导出与同住
   测试）+ 重跑生成器（hosts/web 注册随 pluginFaces.generated.ts 派生，无手写
   适配器注册面）；
   endpoint 增删 = 新增/删除 plugins/endpoints/<id>/ 目录 + 重跑生成器；
3. JSON 纪律：spec/package/manifest 均守 gate json-valid（可 parse、无重复
   键、2 空格缩进），`plugins/` 已入 gate jsonScanDirs；
4. 全脸声明与卸载纪律（阶段 4）：spec 顶层可声明 `actions`/`depends`/`faces`/
   `contract`（CapabilityComponent 全脸字段，缺省即 data-only）——JSON 形状由
   生成器校验，`depends` 引用解析/插件间环/`faces` 结构/`contract.effects ⊆
   机制端口词表` 由 `verify:unload`（scripts/verify_unload.ts）在 root test 链
   强制；卸载前跑 `tsx plugins/scripts/verify_unload.ts --plan <id>` 看阻断方
   （下游 depends 依赖 / 父容器 $ref）与子树影响面——fail-closed：有活动下游
   依赖即拒卸。运行期装载（external_tool 通道）不在本阶段，随后续阶段落地。

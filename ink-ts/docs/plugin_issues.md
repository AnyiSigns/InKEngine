# ink-ts 插件化文档问题卡（plugin_issues.md）

> 评审问题 + 决策留痕。2026-09-07 首次评审（PLUGINS.md × component_data_endgame.md）
> 收敛的决策项均已裁决并**同步回填两份主文档**；本卡为可追溯记录，不回填实施进度。
> 主契约：`PLUGINS.md`；设计推演/计划：`docs/component_data_endgame.md`。

## 已裁决项（2026-09-07）

| # | 问题 | 决策 | 落点 |
|---|---|---|---|
| 1 | 宿主 spec 份数矛盾：设计 §五「四份」（含 IDE）vs 参考模拟「三份」 | **四份并列 spec**：tauri / cli / web / ide 各一份 `host.spec`（IDE 不再只是 surface 枚举值，拥有独立 spec 文件），`HostFaces.surface` 标识各自宿主身份 | component_data §三/§4.3/§五/参考模拟 §1/§5/终局语、PLUGINS HostFaces.surface |
| 2 | 插件物理布局冲突：PLUGINS `faces/{ui,logic,data}/`+`impl/` 嵌套 vs 设计 §4.1 平铺 ui.tsx/logic.ts | **以 PLUGINS.md 嵌套格式为准**：`spec.json` + `faces/{ui,logic,data}/`（face 目录内含实现 + 同目录 `*.test.ts(x)`）+ `impl/` + `locale/`；测试随 face/impl 同目录并列 | component_data §4.1/§4.3/参考模拟 §3、PLUGINS §1 分发格式 |
| 3 | host.spec 用 `faces.ports/transport/surface/approval`，与 CapabilityComponent `faces={ui,logic,data}` 不匹配 | **kind='host' 保持 CapabilityComponent 身份**，faces 类型用专用 `HostFaces`（ports/transport/surface/approval，surface 四值 tauri/web/cli/ide）；非独立顶层类型 | PLUGINS §1 `FaceUnion`/`HostFaces`、component_data §五/参考模拟 §2/§5 |
| 4 | verify 脚本清单冲突：主 §六第 5 项「文案/token 有源」 vs PLUGINS/参考模拟第 5 项「语义标签端到端」 | **5 项 verify 定版**：domains / io / mount / unload / semantics（语义标签端到端，CODING.md §11）；「文案/token 有源」挪进 checklist（§六 item 3） | component_data §六、PLUGINS §3 已一致 |
| 5 | `docs/subsystems/` 文档数不一致：§4.3 五份（含 exec.md）vs 参考模拟四份 | **五份**：engine / plugins / renderer / host / exec（参考模拟补 exec.md） | component_data §4.3 树 + 参考模拟 §1 树 |
| 6 | `seed_data/event_types.json` 未进任何散源收敛清单 | **属引擎/渲染协议侧事件类型真源，不进 `plugins/`**；web 命令面生成物（`web_command_surface.json`）属派生视图禁手改 | component_data §三 边界注 |
| 7 | 低优遗留：§1.2 伪码 `impl` 字段 vs 规范类型；两树详略/现状目标标注；plugin_issues.md 未落盘 | **低优按推荐一并修订**：§1.2 伪码对齐规范（去 impl、补 id/faces 说明）；§4.3 树标注「目标态」并补 manifest.json/hosts spec；本卡落盘 | component_data §1.2/§4.3、本文件 |
| 8 | §九「插件不含业务逻辑（L5 成立）」主语歧义：整插件不含业务逻辑会误读为插件是死的 | **澄清为分面表述**：业务逻辑在插件 logic face/actions（跑引擎侧，经事件路由执行）；不含业务逻辑的只是渲染器（显示设备）与 ui face（渲染意图数据，不写业务）。文档 §九 措辞改为分面，避免整插件误读 | component_data §九 落地状态表 web 行；本卡 |
| 9 | 阶段 2「命令声明表」样板形态与边界（实施时裁决） | **域文件自声明数组 + 聚合挂载**：各域导出 `*_COMMANDS` 声明元组（方法名唯一真源），工厂 `build<Domain>Commands` 返回 `Readonly<Record<DomainCommand, BridgeHandler>>` 对象（编译期键集合锁死）；`BRIDGE_METHODS` 改为域元组 spread 派生导出（值/顺序不变）；cli legacy_aliases 别名表本阶段不动（随阶段 3+ 迁 plugins 源与 web 旧消费下线再收敛） | component_data §九 阶段 2 落地行 + 现状表命令面行、CODING.md §7/§9、本卡 |
| 10 | 阶段 3a 落地范围（实施时裁决） | **分批**：3a 建 plugins 真源目录 + spec 契约 + manifest 生成器，首批迁 tools（35）与 mcp 市场（5）；ui_spec 布局与 BRIDGE_METHODS 命令名留 3b（性质不同构、一次全迁面太大） | component_data §三 3a 落地注 + §九 3a 行 |
| 11 | 命令名数据化方案（66 命令真源迁 plugins） | **声明移 plugins + 生成 TS 类型**：命令名真源全放 plugins/，生成器仿 engine contracts:generate 产出 TS 常量/类型（generated 禁手改），host 工厂类型从生成物派生——真"数据即源"；命令声明与实现分居两处，改动命令名先跑生成器再 typecheck（3b1 已执行：`commands.generated.ts`） | component_data §九 3b1 落地行；本卡 |
| 15 | 命令插件 spec 表达域归属/导出序 | **spec 带 data.group（实现域 31 值）+ data.order（域内 1..n）**；跨域序由生成器 DOMAIN_TABLE 固定清单决定（= BRIDGE_METHODS spread 序，夹具零漂移）；生成物按 域分组 × order 重建 | component_data §九 3b1 行、plugins/AGENTS.md |
| 16 | 命令生成物落点 + 可插拔语义 | **宿主侧生成物**（hosts/lib/src/bridge/commands.generated.ts，31 域元组 + 域类型）最符合可插拔：删命令目录 → 生成物对应元组少键 → 域工厂 Record 键锁 typecheck 红（实现未同步删即错），编译期强制「声明删 → 实现删」无孤儿；spec 填完整 contract/effects 本阶段无消费方（faces/卸载级联是阶段 4），不填占位字段 | component_data §九 3b1 行、CODING.md §7 |
| 12 | 工具插件划分粒度 | **单工具一插件目录**（用户推翻「builtin-tools 统一包 data.tools[]」）：`plugins/tools/<name>/spec.json` 单行承载，control 单位仍是工具表行 | PLUGINS §2.1 修订、component_data §三/§九 |
| 13 | 内置工具 capability 档位 | **host_tool**（宿主注入；工具行执行经宿主端点 inkling_exec/process_exec 等，非 core 闭集、非 external 装卸） | plugins spec.json capability 字段 |
| 14 | 迁移后旧 seed 处置 + 消费指向 | **删旧真源**（tools.json/mcp_market.json），web/host/fixture 生成/self_check 门禁**一律经 plugins/manifest.json 派生视图取用**（生成物禁手改、--check 强制）；mcp.market seed_dir 语义 = 目录内含 manifest.json | component_data §三/§九、CODING.md §7/§9 |
| 17 | ui_feature 拆粒度（阶段 3b2 实施时裁决） | **一节点一插件全平铺**（用户两轮修正：先按 view 拆、再要求「容器结构也是插件」）：plugins/ui_features/<id>/ 每容器/组件/装配入口各一目录（装配入口唯一含 name/version/theme/root.$ref）；容器 data.children 按序 $ref 子插件 id；生成器 DFS 展开重建完整树 + canonical 组件并集派生；卸载 = 删目录 + 删父 children $ref（引用缺失/成环/孤儿 fail-closed） | component_data §九 3b2 行、PLUGINS §1、plugins/AGENTS |
| 18 | ui_spec 迁 plugins 后消费与白名单（阶段 3b2 定稿） | 过渡态**聚合单文件生成物** plugins/ui.generated.json（渲染器与壳仍消费一棵完整布局树，零改动）+ seed_data/ui_spec.json 删除；canonical 白名单改派生（布局引用组件 type 并集升序 → manifest ui_features.components + hosts/lib/src/bridge/ui_canonical.generated.ts，host recipe 常量改引用）；web 白名单对码测试增强「派生 canonical == 旧侧 inkling manifest renderer_components」；引擎 BOOT_UI_SPEC（boot.panel）不动（boot 资产非产品 chrome）、ui_spec.* 编辑器补丁链（W2 未接线）不属本次 | component_data §三/§九、CODING §7/§10、PLUGINS §1 |
| 19 | 阶段 4（faces/卸载一致性）范围与语义（2026-09-07 定案） | **声明级地基 + verify-unload 静态执法，不引入运行期装载**（用户逐项确认）：① spec 顶层可声明 `actions`/`depends`/`faces`/`contract`（CapabilityComponent 全脸），生成器只守 JSON 形状并携带声明字段入 manifest plugins[] 注册表行；② 新 `verify:unload`（plugins/scripts/verify_unload.ts）：depends 悬空/成环/未登记（插件 id 或机制端口，词表单一真源 engine/src/kernel/registry/ports.ts）= 违规；faces 三脸结构（ui/logic/data × engine\|host\|web）+ `contract.effects ⊆ 词表`；manifest 平价 + data-only 状态引脚 + ui 可达性不变式；`--plan <id>` 输出卸载阻断方（下游 depends / 父容器 $ref）与级联子树，**fail-closed 拒卸**（用户选定）；③ 现有 131 内置插件审计结论 = 全 data-only（共享端点/域实现/渲染原语），**不填占位声明**（防第二份平行真相），schema 能力留外部/多面插件（用户选定方案 1）；④ 插件源**单份共用 tauri/cli/web/ide 四宿主**，不引入 per-host 分支/字段（宿主差异 = host.spec 阶段 5 表达，用户确认） | component_data §七/§九、PLUGINS §1、CODING §7、plugins/AGENTS、`plugins/scripts/verify_unload.ts` |
| 20 | 阶段 6（exec 工具信封声明化）范围与语义（2026-09-07 定案） | **binary.ts 手写约定 → 声明数据**（用户逐项确认）：① 真源 = **plugins 源 kind='endpoint'**（plugins/endpoints/exec·infer·mcp 三目录，spec.data.native = 二进制文件名 file + env 覆盖键；复用既有 spec/verify 体系，插件总数 131→134）；② 产物 = **数据化 + 生成物禁手改**：native.generated.ts（hosts/lib/src/exec，第 5 派生产物）逐字入 verify:plugin-manifest，binary.ts 手写 BINARY_ENV/FILE_BY_KIND 两表删除、按声明定位；probe 逻辑/失败语义非声明部分；③ 失败语义**维持现况：消费方各自定**（dialog/doc 缺二进制降级 unavailable，mcp 装配 fail-closed 报缺；不新增装配级全局必装强制） | component_data §七/§九（阶段 6 落地行）、CODING §7（verify:plugin-manifest 五产物）、plugins/AGENTS.md（endpoints 域）、exec/CONFIG.md §1、本卡 |
| 21 | 阶段 7a（物理单目录/测试同住）范围与语义（2026-09-07 定案） | 用户三卡拍板：① 范围 = **样板真面 + 拆 1 内置示范**（不另造 synthetic 外部样例：doc_parse 本身即真实带 faces.logic 的样板；external_tool 走同一 seam，随首个真实外部插件接入）；② 样板形态 = **最小 logic-face 工具**（faces.logic target=host + entry + 同目录 test + package.json exports 条件导出）；③ 装载 seam = **host 装配期 loader**（读 manifest plugins[] faces.logic.target='host' → 动态 import entry；插件源缺 = 空集降级、face 装载/契约不符 = fail-closed）。doc_parse 从 data-only 升级为首个真面内置（host_tool），与阶段 4「内置全 data-only」定案的冲突经 verify_unload `REAL_FACE_BUILTINS` 白名单**显式豁免（唯一）**；失败语义维持消费方各自定（docParse 缺省 = rounds/material 仅文件名引用） | component_data §七/§九 7a 行、CODING §2.7/§7、plugins/AGENTS.md、`hosts/lib/src/face/loader.ts`+`hosts/lib/src/plugins_fs.ts`、verify_unload.ts、本卡 |
| 22 | 阶段 7b（产品 UI 真身化全量迁移）范围与语义（2026-09-08 定案） | 用户多轮拍板：① 范围 = **全量真身化、不做壳清理**——canonical 布局叶子 / 设置 13 面板 / 设置浮层逐个迁 `plugins/ui_features/<id>/faces/ui/`（真 ui 面 + 同住测试），`web/` 包更名 `renderer/`，渲染器适配层（rendererAdapters）与 settings 手写注册框架整体退役；② 粒度 = **域 feature 包**（学 dsh 域粒度）——设置面板按 feature 细分独立插件（spec `data.settings_section` = key/label/order/icon + `faces.ui`）；③ 挂载 = **数据引用而非布局树**——settings 面板不进布局树 $ref，经第 7 派生产物 `settingsSections.generated.ts` 派生清单引用；设置浮层本身真面化（settings_floater 读派生清单渲染左导航，内容 DynamicComponent name=插件 id）；④ **可达性统一规则**（推翻「settings 面板孤儿豁免」表述）：除装配入口外每 ui_feature 插件须被容器 `data.children.$ref` 或 `data.settings_section` 二者之一引用，无孤儿、无豁免（verify_unload 与生成器同源双保险）；⑤ 面板数据源 = **插件自建共享 AppBackend 单例**（定案 B：serve 未接线时 dev 夹具兜底，不经宿主注入面）；⑥ 面板图标 = 派生清单 icon 字符串在浮层消费侧 lucide 映射（model/未知名回落标签文字 chip）。计数：ui_features 25→38（装配/容器 12 + 真 ui 面 26 = 13 布局叶子 + 13 settings 面板）；真 ui 面注册 = 第 6 派生产物 `pluginFaces.generated.ts` 静态 import（注册名 = 插件 id），白名单放行即该派生视图 | component_data §九 7b 行、PLUGINS §1、CODING §7/§10、plugins/AGENTS.md、`pluginFaces.generated.ts`+`settingsSections.generated.ts`、verify_unload.ts、本卡 |
| 23 | 宿主仓目录收敛 + renderer 职责分层（2026-09-08 定案，方向 B，已全落地） | 用户拍板两阶段：① **目录收敛（A，已落地）**——顶层 `host/`→`hosts/lib/`（@ink-ts/host 装配库）、`cli/`→`hosts/cli/`（@ink-ts/cli 进程实现），四份 `*.spec.json` 平铺 hosts/ 根同住，bootstrap 唯一入口改委托 `hosts/cli`；root workspaces/scripts、gate 扫描目录、verify 链脚本路径、self_check symbols 索引、plugin 生成器目标路径（hosts/lib/src/...）、tsconfig extends（../../tsconfig.base.json）全部改指；② **renderer 职责分层（B，已落地 = 选 A2）**——**新建 `hosts/web/` 产品壳包**（@ink-ts/web）收产品 chrome（App/activate/state/shell/productView/views/backend）+ index.html/main/vite，**renderer 转纯显示库** @ink-ts/renderer（renderer/* + shared/* + components/* + i18n/locales）；共享资产归属 = 显示层留在 renderer、壳面资产（productView/AppBackend/activeThread/views/dag 等）随壳；插件注册生成物 pluginFaces/settingsSections.generated.ts 随壳迁 `hosts/web/src/app/`；别名双根：`@`=renderer/src（设备）、`@app`=hosts/web/src/app（壳，hosts/web 与 plugins vitest 同构映射，插件 faces 的 `@/app/*` import 一律改写为 `@app/*`）；spec.web/tauri entry、workspaces、root test 链、gate lineScan、self_check symbols 索引、生成器目标路径全改指；ui.json 显示设备为路径 2 终局不在本次 | component_data §4.3/§九/参考模拟 §1、CODING §1/§7、PLUGINS §1、plugins/AGENTS.md、hosts/web.spec.json、本卡 |
| 24 | 阶段 8 系统化收口范围与状态（2026-09-08 收口） | 收口 = 系统化三件套 + 全量 CI 红绿（component_data §七 阶段8）：① **契约文档**（Step3 已落地：docs/subsystems 五份 + engine/renderer/hosts AGENTS + per-plugin AGENTS 全量——26 真 ui 面 + doc_parse；data-only 免写）；② **verify 链**（contracts/mechanisms/bridge-mount/plugin-manifest/unload/host-spec + gate 真实扫描并入 root npm test，CI ink-ts job 同链）；③ **checklist**（docs/checklist.md：加插件/加包填空模板 + 检查阶梯 + 文案/token 有源 + 决策留痕同变更）；④ **决策留痕**（本表随变更）；⑤ **覆盖纪律**（目标每插件 100% 门禁、不可达分支写真实理由——当前无全局覆盖率阈值 CI，未达门禁新插件须附覆盖统计+豁免理由，覆盖率门禁启用后回填，属待办）；另留 engine contract-as-data 契约强制化评估（§九 ⚠️，随机制层评估，不在本批） | component_data §六/§七阶段8/§九、docs/checklist.md、CODING §7、本卡 |


## 阶段 2 实施时须现场核对

- 各域命令声明的顺序与 `BRIDGE_METHODS` 原数组分域顺序一致（self_check
  `web_command_surface.json` 夹具逐字比对导出，spread 顺序不可打乱）；
  `rounds.todos` 在独立 todos.ts 实现、声明归 `TODOS_COMMANDS`，聚合须紧随
  `ROUNDS_COMMANDS` 之后保持原序。
  **（2026-09-07 阶段 2 已完成：31 份 `*_COMMANDS` 元组 + `verify:bridge-mount`
  PASS，夹具零漂移，见 §九 落地状态。）**

## 阶段 3a 实施时须现场核对

- 工具行/mcp 条目**逐字迁移**（description/parameters/permissions/approval/
  endpoint_config/network_policy/meta 一字不改），manifest 是派生视图禁手改，
  消费一律经 manifest——若未来增删工具只动 spec.json + 重跑生成器；
- spec.json `data.tool`/`data.server` 单行承载 vs 终局统一包 `data.tools[]`
  的差异属决策 #12（用户拍板单工具目录），PLUGINS §2.1 已同步修订；
- npm 包名禁下划线：`collect_material` → `@ink-ts/plugin-collect-material`
  （连字符）；spec id 仍保工具名原样（下划线），目录名 = 工具名。

## 阶段 3b1 实施时须现场核对

- 命令 spec 的 `data.group` 必须命中生成器 DOMAIN_TABLE（31 值）；`data.order`
  域内 1..n 连续无缺；方法名 = spec.id = 目录名（含点号）——改命令只动
  spec + CODING §9 表 + 重跑生成器；
- 31 个域实现文件只允许 `import type`/re-export `commands.generated.ts`，
  本地声明 `*_COMMANDS` 数组即 `verify:bridge-mount` 违规（方法名真源只在
  plugins）；`rounds.todos` group=todos、紧随 ROUNDS_COMMANDS 保持夹具序；
- CODING §9 命令表曾缺 capability.baseline.get/set、tier.set 三行（63 vs 66），
  本阶段补齐；表行增删须与 plugins/commands 同步。
  **（2026-09-07 阶段 3b1 已完成：66 单命令目录 + commands.generated.ts +
  31 域文件改 import + verify 扩展 PASS，夹具零漂移，见 §九 落地状态。）**

## 阶段 3b2 实施时须现场核对

- ui_features 插件 = 一布局树节点一插件：装配入口唯一（inkling.ui，spec.data
  带 name/version/theme/root.$ref）；容器插件 data.node（container）+ data.children
  按序 `$ref`；组件插件 data.node（component）为叶子；节点内容自迁移前
  seed_data/ui_spec.json **逐字保留**（props/bind 键序不变），生成物与旧 seed
  语义逐字一致（值 + 键序）——已由重生成 diff 核对；
- `verify:plugin-manifest` 现为四产物逐字比对（manifest/commands.generated.ts/
  ui.generated.json/ui_canonical.generated.ts）；canonical 派生 13 项升序 =
  host recipe 旧常量 = 旧侧 inkling/manifest contracts.renderer_components
  （web whitelistGate 对码测试断言相等）；
- 引擎 BOOT_UI_SPEC（boot.panel，adapters/boot）不动：introspection
  snapshot_ui 语义未变，host recipe.ui_spec 仍为引擎 boot 资产。
  **（2026-09-07 阶段 3b2 已完成：25 ui_feature 节点插件 + 装配入口 + 四产物
  生成 + 消费改指 + seed 删除 PASS，见 §九 落地状态。）**

## 阶段 4 实施时须现场核对

- 卸载阻断语义（fail-closed）：ui 组合引用以 `data.children.$ref` 与装配入口
  `data.root.$ref` 为反向边（装配入口是根容器插件的引用方）；叶节点被父容器引用
  = 不可独立卸载，须连同父引用处理——`verify:unload --plan <id>` 在删插件目录前
  先查阻断方与级联子树；
- 装配入口/容器/命令域完整性由生成器先验（`--check` 在 verify:unload 之前），
  verify:unload 只在数据层复述（manifest 平价、ui 可达性、无孤儿）；
- **data-only 状态引脚**：任何 spec 出现非空 actions/depends/faces/contract 即红——
  首份真实声明（外部/多面插件）落地时须同步更新 `verify_unload.ts` 引脚白名单与
  plugins/AGENTS、PLUGINS.md 文档；
- verify:unload 是唯一跨进引擎内部取端口词表（`engine/src/kernel/registry/ports.ts`）
  的开发工具——端口单一真源不自建第二份；
- **（2026-09-07 阶段 4 已完成并提交：schema 全脸字段 + verify:unload PASS（131 插件
  data-only 引脚 + manifest 平价 + ui 可达性全成立），见 §九 落地状态。）**

## 阶段 5 实施时须现场核对

- host.spec 数据（hosts/tauri·cli·web·ide.spec.json）只描述宿主形状与非敏感
  默认：密钥/模型端点不进 spec（走 config/env）；cli 是进程实现库
  （host=kind host 装配），TUI 是 cli 宿主的一个绘制 face，**不作为独立插件
  kind**；web 真实 spec + tauri/ide 占位（implemented=false，装配实现住外部壳仓）；
- verify:host-spec 在 root test 链：四宿主不变式 + HostFaces 词汇（单一真源
  hosts/lib/src/host_spec.ts）+ implemented=true 须带 renderer entry 且文件真实存在。
  **（2026-09-07 阶段 5 已完成并提交：5a cli=host 插件框架/TUI face + 5b-1 四份
  hosts spec + 5b-2 host_spec 装配注入（host_spec_id/surface） + 5b-3 bootstrap
  唯一进程入口，见 §九 落地状态。）**

## 阶段 6 实施时须现场核对

- kind='endpoint' 插件（plugins/endpoints/exec·infer·mcp）是真源：spec.data.native
  （file 二进制文件名 + env 覆盖键）与 exec/CONFIG.md §1 描述、host 按声明装载
  三者一致；mcp 端点文件名为 ink_ts_mcp（≠ 目录 id）；
- 派生视图第 5 产物 = hosts/lib/src/exec/native.generated.ts（NATIVE_BINARY_DECLS +
  NativeBinaryKind 类型），verify:plugin-manifest 逐字比对；binary.ts 禁回退
  手写 BINARY_ENV/FILE_BY_KIND 表（按声明定位），`_types.NativeBinaryKind` 从
  生成物派生（不再是手写三值联合）；
- 插件数 131→134（+3 endpoint；tool 35 + mcp 5 + command 66 + ui_feature 25 +
  endpoint 3），文档数字表述同步；endpoint 插件 data-only（无 actions/depends/
  faces/contract 真值），verify_unload 引脚与 manifest 平价覆盖（KIND_DIRS 已加
  endpoints 域）；
- 失败语义维持现况：dialog/doc 缺二进制降级（unavailable）、mcp 装配 fail-closed
  报缺——阶段 6 不引入装配级「全量必装」；增量装载/运行期装卸随后续阶段。
  **（2026-09-07 阶段 6 已完成并提交，见 §九 落地状态。）**

## 阶段 7a 实施时须现场核对

- doc_parse 升级真面：spec 顶层 `faces.logic`（target=host，entry=
  ./faces/logic/index.ts）+ `depends=['exec']`；实现（DocService）自
  hosts/lib/src/doc/service.ts 迁插件 `faces/logic/index.ts`（@ink-ts/host 公共面
  不再导出 DocService/DEFAULT_DOC_TEXT_CAP——DocParser seam 保留），测试
  `index.test.ts` 随插件同住（`vitest run --root plugins` 执行）；删除旧文件，
  显式 `binary:null` = 未装配（不回落 locate，原 ?? 语义是坑）；
- data-only 引脚真面许可：`REAL_FACE_BUILTINS`（当前唯一 doc_parse）+ 
  capability=external_tool 放行；faces entry 物理同住 = 相对路径禁逃逸 +
  文件真实存在（verify:unload 强制）；白名单增删须同步 verify_unload.ts、
  plugins/AGENTS.md 与决策留痕；
- 装载：plugins_fs（manifest 探测共享，mcp.market 消费改指）+ face loader 装配
  期装载（manifest plugins[] faces.logic.target='host'）；无 manifest =
  docParse undefined 降级（rounds/material 消费面已 optional）；face 装载/契约
  不符 = 装配期 fail-closed（createHost 抛错）；gate lineScanDirs 增真面插件
  faces 目录、CODING §2.7/§7 同步。
  **（2026-09-07 阶段 7a 已完成并提交：doc_parse 首真面 + host logic-face loader
  + 同住测试/门禁/verify 全绿，见 §九 落地状态。）**

## 阶段 7b 实施时须现场核对

- 真 ui 面统一形态：spec `faces.ui` entry = `./faces/ui/index.tsx` 默认导出
  （布局叶子 = 把 product chrome 映射为组件 props 的薄适配器；设置面板 = 直渲
  组件），实现与 `*.test.tsx` 同住 `faces/ui/`；渲染器注册随
  pluginFaces.generated.ts（第 6 派生产物）静态 import 派生（注册名 = 插件
   id），**无 renderer 适配器/手写注册面**——rendererAdapters 与
  settings/registry·activate·types·item_renderer·floater 已删；产品壳
  hosts/web/src/app/activate（阶段 2 起独立仓，前身 renderer/src/app）收敛为
  registerBuiltinComponents + registerPluginFaces + registerEventRenderers；
- settings 浮层读派生清单 SETTINGS_SECTIONS（真源 = 各面板 spec
  data.settings_section，order 升序）；settingsSections.generated.ts 住
  hosts/web/src/app/settings/ 生成目录（阶段 2 前住 renderer/src/app/settings/），
  浮层插件经 `@app/settings/settingsSections.generated` 别名消费；
- 可达性 = 容器 $ref ∪ data.settings_section（无孤儿、无豁免）；图标字符串
  映射在浮层 icons.tsx（lucide，model/未知名回落标签文字 chip）；
- 面板数据直连共享数据面：插件 faces/ui 入口自建 AppBackend 单例（dev 夹具
  兜底）；
- ui_features 计数 38 = 装配/容器 12 + 真 ui 面 26（13 布局叶子 + 13 settings
  面板）；ui 面/设置段增删同步 pluginFaces.generated.ts 与
  settingsSections.generated.ts 重生成（verify:plugin-manifest 七产物逐字比对）。
  **（2026-09-08 阶段 7b 已完成并提交：26 真 ui 面全量真身化 + renderer 适配层/
  settings 原生框架退役 + 第 6/7 派生产物接线，renderer/plugins vitest +
  verify:unload + gate 全绿，见 §九 落地状态。）**

## 宿主仓目录收敛（2026-09-08 决策 #23 Step 1，已落地）

- 拓扑：顶层 `host/`→`hosts/lib/`（@ink-ts/host 装配库）、`cli/`→`hosts/cli/`
  （@ink-ts/cli 进程实现）；四份 `*.spec.json` 平铺 `hosts/` 根与实现同住；
  bootstrap 唯一入口改委托 `hosts/cli`（runCliMain/parseArgs/loadHostSpec 路径
  改指 `hosts/cli`/`hosts/lib`）。
- 引用面全量改指：root workspaces/scripts（`--root hosts/cli|hosts/lib`、
  `hosts/lib/scripts/verify_bridge_mount.ts`）、gate lineScanDirs、self_check
  symbols 消费索引、plugin 生成器目标路径（`hosts/lib/src/...` 第 2/3/5 产物
  + 头注）、hosts/cli.spec.json entry、tsconfig extends 修正为
  `../../tsconfig.base.json`；npm install 重链 workspaces/package-lock。
- 教训：首次在错误 tsconfig（extends 缺失）下跑 `tsc -p` 会以默认选项把 CJS
  产物 emit 进 src 并干扰 vitest 解析（`.js` 优先于 `.ts`）——本次误编译产物已
  清理，tsconfig 修复后再跑 typecheck 无 emit。
  **（验证：hosts/lib/hosts/cli tsc 绿、vitest 绿（cli 77）、gate/verify:host-spec
  PASS、root npm test 全链绿，见 §九 落地状态。）**

## 产品壳分层（2026-09-08 决策 #23 Step 2 = 方向 A2，已落地）

- 拓扑：新建 `hosts/web/` 产品壳包（@ink-ts/web，root workspaces 增员）——
  收 renderer 产品装配面（src/app/、App、main、index.css、index.html、
  .env.local 与 test/app 同迁）；renderer/ 转纯显示设备库 @ink-ts/renderer
  （renderer/* 机制 + shared/* + components/* + i18n/locales，无 index.html/
  main/dev 脚本）。真 ui 面注册/设置派生生成物
  pluginFaces.generated.ts + settingsSections.generated.ts 随壳住
  `hosts/web/src/app/`（生成器目标路径与头注、verify 对码逐字断言随改）。
- 别名双根：`@` = renderer/src（显示设备，hosts/web 的 vite/tsconfig 用
  `../../renderer/src`、plugins vitest 用 `../renderer/src`）；`@app` =
  hosts/web/src/app（产品壳）。插件真 ui 面 import 的产品壳资产
  （productView/shellContracts/AppBackend/activeThread/dag/views/backend 等）
  由 `@/app/*` 全量改写为 `@app/*`；设备资产（shared/renderer/components/i18n）
  维持 `@`。tsconfig paths 与 vite/vitest alias 各包自持（gate 不扫 alias）。
- 迁移教训：renderer/src 比 hosts/web 深一级，宿主包对 renderer 的别名目标须
  `../../renderer/src`（plugins 侧仍 `../renderer/src`）；vite alias 的 find
  不带尾斜杠（`@app`/`@`），否则子路径不匹配；tsc 会把经 pluginFaces 静态
  import 的插件真面全量纳入 hosts/web 类型程序（插件 faces 首次获得工程级
  typecheck，属正面收益）。
- 归属口径（留档）：设备 = 渲染机制 + 显示通用资产；壳 = 产品 chrome + 会话
  数据/动作装配 + 产品视图套件 + 插件注册生成物；shared/identity（manifest
  身份）随壳（`hosts/web/src/identity.ts`）；shared/backend、shared/session
  仍属设备运行时资产（hosts/web 与插件 faces 共用）。
  **（验证：renderer tsc/vitest 174、hosts/web tsc/vitest 39（含随迁
  activate/specShell/dag/eventRenderers/whitelistGate）、plugins vitest 126、
  gate/verify:plugin-manifest/host-spec/unload PASS、vite build 绿、root npm
  test 全链绿，见 §九 落地状态。）**

## 引擎层 AGENTS 用语

设计目标态引擎目录为 `kernel/`（机制契约化后归此，现状 `core/`），故目标态
AGENTS.md 依赖方向统一写 **`kernel→adapters 单向`**（现状落点仍 core，见 §九）；
PLUGINS.md §3 机制件契约化归 `engine/src/kernel/<mechanism>/` 与此一致。

## 阶段 1 实施时须现场核对

- §2.1 机制件清单以概念名列举（gate/audit/patch_chain…），当前 core 实际目录为
  `audit_log/`、`patch/`、approval 等；契约化样板落 `kernel/<mechanism>/` 时按真实代码目录对齐命名，勿照抄概念名建目录。
  **（2026-09-07 阶段 1 已按真实目录完成：33 契约落 `engine/src/kernel/<mechanism>/contract.ts`，id=目录名，见 §九 落地状态。）**

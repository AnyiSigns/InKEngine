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
| 16 | 命令生成物落点 + 可插拔语义 | **宿主侧生成物**（host/src/bridge/commands.generated.ts，31 域元组 + 域类型）最符合可插拔：删命令目录 → 生成物对应元组少键 → 域工厂 Record 键锁 typecheck 红（实现未同步删即错），编译期强制「声明删 → 实现删」无孤儿；spec 填完整 contract/effects 本阶段无消费方（faces/卸载级联是阶段 4），不填占位字段 | component_data §九 3b1 行、CODING.md §7 |
| 12 | 工具插件划分粒度 | **单工具一插件目录**（用户推翻「builtin-tools 统一包 data.tools[]」）：`plugins/tools/<name>/spec.json` 单行承载，control 单位仍是工具表行 | PLUGINS §2.1 修订、component_data §三/§九 |
| 13 | 内置工具 capability 档位 | **host_tool**（宿主注入；工具行执行经宿主端点 inkling_exec/process_exec 等，非 core 闭集、非 external 装卸） | plugins spec.json capability 字段 |
| 14 | 迁移后旧 seed 处置 + 消费指向 | **删旧真源**（tools.json/mcp_market.json），web/host/fixture 生成/self_check 门禁**一律经 plugins/manifest.json 派生视图取用**（生成物禁手改、--check 强制）；mcp.market seed_dir 语义 = 目录内含 manifest.json | component_data §三/§九、CODING.md §7/§9 |
| 17 | ui_feature 拆粒度（阶段 3b2 实施时裁决） | **一节点一插件全平铺**（用户两轮修正：先按 view 拆、再要求「容器结构也是插件」）：plugins/ui_features/<id>/ 每容器/组件/装配入口各一目录（装配入口唯一含 name/version/theme/root.$ref）；容器 data.children 按序 $ref 子插件 id；生成器 DFS 展开重建完整树 + canonical 组件并集派生；卸载 = 删目录 + 删父 children $ref（引用缺失/成环/孤儿 fail-closed） | component_data §九 3b2 行、PLUGINS §1、plugins/AGENTS |
| 18 | ui_spec 迁 plugins 后消费与白名单（阶段 3b2 定稿） | 过渡态**聚合单文件生成物** plugins/ui.generated.json（渲染器与壳仍消费一棵完整布局树，零改动）+ seed_data/ui_spec.json 删除；canonical 白名单改派生（布局引用组件 type 并集升序 → manifest ui_features.components + host/src/bridge/ui_canonical.generated.ts，host recipe 常量改引用）；web 白名单对码测试增强「派生 canonical == 旧侧 inkling manifest renderer_components」；引擎 BOOT_UI_SPEC（boot.panel）不动（boot 资产非产品 chrome）、ui_spec.* 编辑器补丁链（W2 未接线）不属本次 | component_data §三/§九、CODING §7/§10、PLUGINS §1 |
| 19 | 阶段 4（faces/卸载一致性）范围与语义（2026-09-07 定案） | **声明级地基 + verify-unload 静态执法，不引入运行期装载**（用户逐项确认）：① spec 顶层可声明 `actions`/`depends`/`faces`/`contract`（CapabilityComponent 全脸），生成器只守 JSON 形状并携带声明字段入 manifest plugins[] 注册表行；② 新 `verify:unload`（plugins/scripts/verify_unload.ts）：depends 悬空/成环/未登记（插件 id 或机制端口，词表单一真源 engine/src/kernel/registry/ports.ts）= 违规；faces 三脸结构（ui/logic/data × engine\|host\|web）+ `contract.effects ⊆ 词表`；manifest 平价 + data-only 状态引脚 + ui 可达性不变式；`--plan <id>` 输出卸载阻断方（下游 depends / 父容器 $ref）与级联子树，**fail-closed 拒卸**（用户选定）；③ 现有 131 内置插件审计结论 = 全 data-only（共享端点/域实现/渲染原语），**不填占位声明**（防第二份平行真相），schema 能力留外部/多面插件（用户选定方案 1）；④ 插件源**单份共用 tauri/cli/web/ide 四宿主**，不引入 per-host 分支/字段（宿主差异 = host.spec 阶段 5 表达，用户确认） | component_data §七/§九、PLUGINS §1、CODING §7、plugins/AGENTS、`plugins/scripts/verify_unload.ts` |

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

## 引擎层 AGENTS 用语

设计目标态引擎目录为 `kernel/`（机制契约化后归此，现状 `core/`），故目标态
AGENTS.md 依赖方向统一写 **`kernel→adapters 单向`**（现状落点仍 core，见 §九）；
PLUGINS.md §3 机制件契约化归 `engine/src/kernel/<mechanism>/` 与此一致。

## 阶段 1 实施时须现场核对

- §2.1 机制件清单以概念名列举（gate/audit/patch_chain…），当前 core 实际目录为
  `audit_log/`、`patch/`、approval 等；契约化样板落 `kernel/<mechanism>/` 时按真实代码目录对齐命名，勿照抄概念名建目录。
  **（2026-09-07 阶段 1 已按真实目录完成：33 契约落 `engine/src/kernel/<mechanism>/contract.ts`，id=目录名，见 §九 落地状态。）**

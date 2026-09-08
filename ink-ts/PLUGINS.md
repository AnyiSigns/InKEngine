# ink-ts 插件契约（PLUGINS.md）

本文件是 ink-ts **插件化平台**的**统一契约单一事实源**：能力以插件为单位、
插件即数据（声明驱动装载）、统一契约（一个插件 = 一份 spec）、三档能力归谁管、
机制闭集红线为何。内置能力（工具/命令/UI feature）与外部插件**共用同一份契约**——
内置能力 = 内置插件（随平台装配），外部插件 = 市场装载；**引擎机制件不是插件**
（装配期闭集，见 §3），机制件是"装插件的宿主"。凡涉及插件/机制件的代码、评审、
校验以此为准；编码纪律见 `CODING.md`，设计推演与落地状态见
`docs/component_data_endgame.md`。

本文件只定**不变的规则**，不追踪实施进度。

## 1. 统一契约：CapabilityComponent（插件即数据）

一切能力（工具/命令/端点/UI feature/配方/执行体/MCP/宿主）都以**插件**为单位、
按统一契约声明：一个插件 = 一份 `CapabilityComponent` spec，声明其全部脸面；
内置能力与外部插件同契约，装载与执行均由声明驱动，无声明即不装载。

`CapabilityComponent` 只描述**插件**——内置插件、外部插件、宿主插件都属此类型；
**引擎机制件不是插件**，用独立 `MechanismContract` 类型（见 §3）——在类型层
强制区分，不靠文档自觉。

```ts
interface CapabilityComponent {
  id: string;                                          // 注册表键，全局唯一
  kind: 'tool' | 'command' | 'ui_feature' | 'endpoint'  // 仅插件类型（机制件非插件，
      | 'recipe' | 'executor' | 'mcp' | 'host';             // 走 MechanismContract，见 §3）
  contract: {
    inputs?: unknown;
    outputs?: unknown;
    effects: string[];   // 只允许引用已声明端口（storage_seam/llm_port/exec_envelope/rounds.port…）
  };
  data: unknown;         // 数据面：声明数据 / locale / theme token，随插件走
  actions: string[];     // logic face 暴露的命令/操作；命令面从此派生，禁手写数组
  capability: 'core_tool' | 'host_tool' | 'external_tool';   // 见 §2
  depends: string[];     // 依赖插件/机制端口 id，形成 DAG（循环拒绝）
  faces: FaceUnion;      // 同一 id 贯穿所有脸；拆插件 = 面同注销
}

type FaceUnion =
  | { ui?:    { target: 'engine' | 'host' | 'web'; entry: string };
      logic?: { target: 'engine' | 'host' | 'web'; entry: string };
      data?:  { target: 'engine' | 'host' | 'web'; entry: string } }
  | HostFaces;                       // kind='host' 专用面，见下方

interface HostFaces {                // 宿主插件（kind='host'）：不走通用 ui/logic/data 三脸
  ports: unknown;                    // storage 后端 / llm 槽位 / exec 信封 / 审批实现的端口形状
  transport: 'stdio' | 'http+ws' | 'webview';
  surface: 'tauri' | 'web' | 'cli' | 'ide';   // ← 宿主身份全在这（tauri/cli/web/ide 四份 spec）
  approval: unknown;                 // 弹卡 UI / CLI --approve / 策略自动放行
}
```

字段约束：

- `contract.effects` 是 0-IO 白名单：只调声明过的端口，调未声明端口或直接
  IO = 装配期/扫描期拒绝；
- `depends` 可引用**其它插件 id 与机制端口 id**（如 `rounds.port`——机制端口是
  可依赖的契约面，由引擎内核导出）；装配期校验单向 + 完整 + **循环拒绝**；
  卸载某插件时校验下游，有依赖 = 级联禁用或拒绝，不留孤儿；
- 代码实现文件随插件目录走（`spec.json` + 各 face + 测试 + locale 同住）。

**统一分发格式**（一个格式承载所有 kind，host 除外——host 是装配期 spec，见 §2）：
一个 npm 包/目录 = 一个插件 = `spec.json`（统一契约）+ `faces/{ui,logic,data}`（按
kind 取需要的脸；各 face 实现与其 `*.test.ts(x)` 同目录并列）+ `impl/`（JS 执行体 /
MCP config / spawn 声明）+ 测试 + locale。`kind` 只决定三件事：
契约模板、装载路径、需要哪些脸——**不是每类一种新格式**。插件源统一为
`plugins/` 单源（真源）+ 派生视图（manifest/命令面/市场），见
`docs/component_data_endgame.md` §三（宿主 `kind='host'` 例外：不走 npm 包分发，
spec 直接住 `hosts/<host>.spec.json`，faces 用 HostFaces，见 §2）。

命令类（`kind='command'`）落地形态（阶段 3b1 定稿）：`plugins/commands/<method>/`
单命令一目录，spec 的 `data.group` = 实现域（31 值，含 rounds.todos 独立实现
的 todos 组）、`data.order` = 域内序号；方法名真源 = spec.id（目录名）。
host 命令面经派生生成物 `host/src/bridge/commands.generated.ts` 取用
（域命令元组 + 域命令类型，禁手改），域实现文件只 import type/re-export——命令
面从此派生、无手写方法名数组；增删命令 = 增删 plugins/commands 目录 + 重跑
生成器 + 同步 CODING.md §9 命令表。

界面 feature 类（`kind='ui_feature'`）落地形态（阶段 3b2 定稿）：
`plugins/ui_features/<id>/` **一布局树节点一插件**（一节点一插件全平铺）——容器、
组件、装配入口都是同级插件目录。spec 的 `data.node` = 该节点（kind=container|
component，逐字承载 props/bind）；容器插件的 `data.children` = 按序 `$ref`
子插件 id 数组；装配入口（唯一，如 `inkling.ui`）spec 的 `data` = 布局元
（name/version/theme）+ `root.$ref`。生成器 `sync_plugin_manifest.mjs` DFS 沿
$ref 展开重建完整布局树（生成物 `plugins/ui.generated.json`，渲染器消费，
与渲染器 UISpec 同构；引用缺失/成环/孤儿节点插件 fail-closed）并把树内引用
组件 type 并集（升序）派生为 canonical 白名单（生成物
`host/src/bridge/ui_canonical.generated.ts` + manifest `ui_features.components`，
host 配方界面白名单据此装配）。卸某节点 = 删目录 + 删父 `$ref` + 重跑生成器
（组件节点保留 = 真 ui 面随 spec faces.ui 派生注册）——页面/侧栏/页签任一结构
或组件块可整块装卸。

真 ui 面（canonical 布局叶子与设置面板的独占 UI 实现）：组件节点插件声明
`faces.ui`（target='web'，entry=`./faces/ui/index.tsx` 相对插件目录），
`faces/ui/` 内 index.tsx 默认导出（布局叶子 = 把渲染器 product chrome 映射为
组件 props 的薄适配器；设置面板 = 直渲组件）与其 `*.test.ts(x)` 同目录并列。
渲染器装配经派生视图 `pluginFaces.generated.ts` 静态 import 注册进
componentRegistry（注册名 = 插件 id，白名单放行即该视图）——无 renderer 侧
手写适配器/注册表面。

设置面板 = **数据引用挂载，不进布局树**：面板插件另声明 `data.settings_section`
（key/label/order/icon），经第 7 派生视图 `settingsSections.generated.ts`
聚合为设置段清单（order 升序）；设置浮层读清单渲染左导航，内容按插件 id 经
DynamicComponent 渲染。

可达性统一规则（无孤儿、无豁免）：除装配入口外，每 ui_feature 插件须被容器
`data.children.$ref` **或** `data.settings_section` 二者之一引用；卸载一致性由
`verify:unload` 强制（两路引用同源判定，见 CODING.md §7）。

## 2. capability 档位（装卸权限）

`kind` 与 capability 正交：kind 定契约模板/装载路径/需要哪些脸，capability 定
谁拥有/谁能装卸改。宿主（kind='host'）物理住 `hosts/<host>.spec.json`
（tauri/cli/web/ide 四份），capability 归属 `host_tool`，装配期注入。

| 档位 | 生命周期 | 谁能装/卸/改 |
|---|---|---|
| `core_tool`（机制闭集） | 装配期内置、不可装载不可卸载，随引擎版本 | 宿主装配期可换实现；agent/补丁不可改 |
| `host_tool` | 宿主装配期注入 | 宿主 |
| `external_tool` | 运行期可装载/回退（补丁=装，回退=卸） | 用户/宿主经审批；vetting 审 spec + impl（按本契约编写的第三方） |

- 各档共享同一工具表、同一权限模型、同一审计/观察管线；差别只在档位决定
  "谁拥有它、谁可装载、谁可回退"；
- **不做生态专属适配**：我们只定义自己的插件契约，**不做任何外来生态
  （dsh/cordis/cursor…）的专属适配器**（同"LLM 按协议适配、不为厂商适配"原则）。
  外来生态要集成 = 由其作者自行按本契约把能力适配成 `external_tool` 原生插件
  （spec/faces/impl 全按我们的声明交付），我们只 vetting 它交上来的 spec + impl；
- 运行期**替换**能力插件 = 同名覆盖 + **契约兼容**（须满足同一 `contract`，
  否则 vetting 拒绝）；
- `external_tool` 以 npm 包分发（`package.json` + `spec.json` + 各 face）；
  装载 = npm 安装 → vetting → 审批 → 装载 → 运行 → 可回退卸载；
  前端热更新是锁定约束：装/写 npm 包后须实时渲染呈现；
- **插件生命周期 vs 补丁链（两层分开）**：装载/卸载 = 受控动作（审批/审计/回退）；
  插件**产出的数据变更**（theme/tool/知识等）走补丁链——两层分开记录，不混；
- **卸载顺序（固化先停后卸）**：先停子进程/容器，再注销各 face
  （ui/logic/data 三脸或 host 的 HostFaces——无"按钮还在、后端已删"的孤儿）。

### 2.1 工具类插件（分发单位 vs 控制单位，正交）

- 工具声明 = `kind:'tool'` 插件数据；内置工具声明源 = `plugins/tools/<tool-name>/`
  单工具一目录（阶段 3a 定稿：逐工具拆目录而非统一包），spec.json 的
  `data.tool` 逐字承载原工具声明行（name/description/parameters/permissions/
  approval/endpoint/endpoint_config/network_policy/meta），声明源唯一化于
  plugins/，不再有独立 `seed_data/tools.json`；
- **分发单位 = 目录/包**：内置工具每工具一个插件目录（npm 包名
  `@ink-ts/plugin-<kebab>`），`plugins/manifest.json` 派生视图聚合 tools 表行
  供消费（renderer/host/fixture 经 manifest 取用，生成物禁手改）；外部/agent
  自举工具按插件分发（一个插件可带多个工具，MCP server 即此形态——一个
  插件 N 个独立工具行）；
- **控制/检索单位 = 工具表行**：每个 tool id 独立——schema/权限档/启停旗标/审批位/
  向量索引/request_tool 绑定全部 per-tool，与它来自哪个包无关；
- tools tab 与检索动态注册读同一份源 = plugins 聚合铺成的工具表。

## 3. 机制闭集红线

- **机制件**（gate/audit/patch_chain/executor/round_steps/runtime 状态机…）
  不是插件，用独立类型 `MechanismContract`（`contract` + `depends` + `inject`），
  装配期闭集；契约化后归 `engine/src/kernel/<mechanism>/`
  （`contract.ts` 声明端口 + `impl.ts` 纯实现 + boot 密封）；
- **补丁链只能动数据/策略/配方/激活集，永远动不了机制语义**（怎么审计、
  怎么裁决、怎么回退、怎么保证链完整）；
- 机制**可**演化，但只走三条受控通道：
  1. 装配期注入：换机制件实现（同语义）——boot 前，boot 后密封；
  2. 版本演进：加端口 / 换语义——引擎版本（release + 签名）；
  3. 运行期补丁链：只动数据/策略/配方。
  唯一排除：**运行期自指改语义**（agent 会话中直接改自己的裁决/审计/回退规则）；
- 区分**机制件**与**扩展点**：策略槽 / 评分器 / 节点类型 / 配方字段是扩展点
  （数据面，运行期可填），不是机制件——"加机制"的真实诉求九成是填扩展点，
  不碰机制语义；
- 引擎 0-IO：副作用一律经 `contract.effects` 声明过的端口，由宿主在装配期
  注入实现；
- **LLM 多模态视觉感知属机制/端口面，非插件**：视觉理解 = 感知机制件
  （MechanismContract）+ `llm_port` 多模态 content（图像作为输入喂模型），由模型
  档案 `multimodal` 标记决定可用性——不构成插件 kind、不进工具表、不是 agent
  函数调用；需要视觉的插件只触发感知机制，不自己实现视觉；
- **verify 随行**：依赖单向（engine 不反向依赖插件层）、depends 循环拒绝 +
  卸载级联、0-IO 端口白名单、命令面声明即挂载、语义标签端到端断言
  （见 CODING.md §11）——每层 verify 脚本随插件源落地。

---

相关文档：`CODING.md`（编码纪律/§11 端到端评审）。

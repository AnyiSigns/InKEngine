# ink-ts 插件即数据 · 终局形态（设计定稿 + 实施计划）

> 状态：设计定稿（2026-09-07），尚未实施——本文件为终局架构定稿 + 分阶段实施计划；
> 落地现状与设计的差异见文末「落地现状 vs 设计差异」（实施后回填）。
> 范围：ink-ts 全栈（engine / host / web / cli / exec / seed_data）
> 定位：引擎 = 数据权威；插件 = 带全脸的能力数据单元；渲染器 = 显示设备；宿主 = 面插件。

---

## 〇、终局模型（一句话）

> **引擎不是"后端"，是驱动数据的运行时；插件不是"前端/后端/工具"，是带全脸的能力数据单元；渲染器是显示设备，宿主是面插件——没有前后端，只有一份插件源、一个数据权威、一道受控闸。**

心智模型（一个词对一个词）：

| 角色 | 对应 | 可演化性 |
|---|---|---|
| 引擎 | 大脑（0-IO 纯语义核 + 装配闭集 + 受控闸） | 结构经装配期/版本受控演化 |
| 插件 | 手/工具/感官（能力数据，可装卸） | 运行期补丁链装卸/回退 |
| 渲染器 | 显示设备（只渲染，不思考） | 固定，不属于任何插件 |
| 宿主 | 身体接口（面插件 host.spec） | 装配期换 spec |

---

## 一、核心概念

### 1.1 引擎 = 大脑（数据权威）

- 唯一中心运行时：0-IO 纯语义核 + 装配期闭集 + 数据驱动调度器；
- 数据（插件声明 / 事件 / 工具调用 / 配方）流经引擎，引擎按契约路由给插件，插件协作后把结果作为数据回给引擎；
- 引擎驱动的是**数据流动**，不是数据存储——存储是注入端口（`storage_seam`），引擎只做判断不亲自落盘；
- 引擎覆盖 cordis 的全部功能机制（registry / DI / lifecycle / plugin），差异不在"缺机制"，而在**多一道受控闸**。

### 1.2 插件 = 能力数据单元（CapabilityComponent）

每份插件 spec 带全脸：

```
CapabilityComponent {
  id          # 注册表键，全局唯一（同一 id 贯穿所有脸）
  kind        # 仅插件类型：tool | command | ui_feature | endpoint | recipe | executor | mcp | host（机制件非插件，走 MechanismContract；kind='host' 的面为 HostFaces，见 §五）
  contract    # 输入/输出形状、effects 声明（0-IO 白名单，只调声明过的端口）
  data        # 数据面（声明数据/locale/theme token；工具行、MCP 配置随 kind 放声明数据，细则见 PLUGINS.md §2.1）
  actions     # 命令/操作（logic face；命令面从此派生，禁手写数组）
  capability  # core_tool | host_tool | external_tool（与 kind 正交）
  depends     # 依赖声明（形成 DAG，校验单向 + 完整 + 循环拒绝）
  faces       # 通用 { ui: {target, entry}, logic: {target, entry}, data: {...} }；kind='host' 用 HostFaces（见 §五）
}
```

### 1.3 三档 capability（谁拥有生命周期）

| 档位 | 例子 | 生命周期 | 谁能改 |
|---|---|---|---|
| `core_tool`（机制闭集） | 自指/契约工具（introspect / propose / apply / revert） | 装配期内置、不可装载不可卸载，随引擎版本 | 宿主装配期可换实现；agent/补丁不可改 |
| `host_tool` | 宿主注入的执行体、env/工具信封（exec） | 宿主装配期注入 | 宿主 |
| `external_tool` | MCP、agent 写的工具、第三方插件（按本契约编写） | 运行期可装载/回退（补丁=装，回退=卸），vetting fail-closed | 用户/宿主经审批，审计留痕 |

三档共享同一工具表、同一权限模型、同一审计/观察管线；差别只在 `capability` 决定"谁拥有它、谁可装载、谁可回退"。运行期替换能力插件 = 同名覆盖 + 契约兼容（新插件须满足同一 `contract`，否则 vetting 拒绝；`registerComponent`/`artifactLoader` 已支持同名覆盖）。

**装载通道（npm 插件）**：`external_tool` 能力插件以 npm 包分发（`package.json` + `spec.json` + 各 face），装 = npm 安装 → vetting fail-closed → 审批 → 装载 → 运行 → 可回退卸载。前端热更新是锁定约束：agent 写入/安装 npm 包后须能实时渲染呈现。

### 1.4 没有前后端

- **契约层**：不存在两套契约，一份插件契约贯穿它所有脸；
- **物理层（终局形态 A）**：ui face 不是浏览器代码，而是**渲染意图数据**（spec/状态），浏览器/webview 里只剩一个固定的通用渲染器（显示设备，不定义契约、不属于任何插件），按引擎推来的 spec 画出来；
- 卸插件 = 它的 spec 没了 = 它的 ui / logic / data 各脸（通用三脸或 host 的 HostFaces）同时注销，无孤儿界面。

### 1.5 自学习自进化的三层（机制 / 策略数据 / 产物）

判别准则：**「怎么做」= 机制（引擎 core 闭集）；「做什么/学什么」= 策略数据（注入机制）；「变出什么」= 产物（数据）**。

| 层 | 内容 | 归属 | 现状落点 |
|---|---|---|---|
| **机制**（自进化怎么发生） | `self_tools`（propose/apply/revert/propose_domain_manifest/search_tools/request_tool）、`self_application`、补丁链、审批分级、回退、种子沉淀、自学习管线、技能结晶、调参 | 引擎 core，装配闭集（默认开） | `core/self_tools`、`core/self_application`、`core/settle/seed`、`core/growth`、`core/skill_crystal`、`core/tuning` |
| **策略数据**（自进化学什么/评什么/调什么） | 评分阈值、调参目标/权重、知识分类、复用判定 | 数据，注入 core 机制 | `GrowthConfig` / `TunableParams` / 知识集 kind=weight |
| **产物**（自进化变出了什么） | 补丁、知识条目、实体、harness、工具定义 | 数据，宿主/产品层 | 走补丁链 + 受控通道 |

- 自学习族（种子沉淀 / `growth` / `skill_crystal` / `tuning`）**已在引擎 core 实现、默认开**（CODING.md §10），不是"产品侧业务插件"；host 侧仅 `growth.report` 只读报告，不存在宿主手写自进化工具；
- 与 2.2 呼应：机制（怎么进化）锁在闭集，策略数据（学什么）随补丁链演化——"自进化"里，**受控的是方式，开放的是内容**。

---

## 二、机制层与受控通道（"放开机制层"的正确定义）

### 2.1 机制件清单

`engine/src/core/` 内机制件（gate / audit / patch_chain / executor / settle / round_steps / runtime 状态机 …）逐一声明；契约化后归入 `engine/src/kernel/<mechanism>/`（每件 contract.ts + impl.ts）：

```
MechanismContract<Gate> {
  contract { inputs, outputs, effects: [storage_seam, llm_port, exec_envelope, ...] }
  depends
  inject: (deps) => impl   # 端口注入，引擎不直接 new/import 机制件
}
```

机制件从"引擎内部直接 import"改成"注册表 + 端口注入 + boot 密封"（复用 `NodeTypeRegistry` 的 contract-as-data 模式；现状边界：其契约是可选参数，无契约 = 不参与组装、仅可手绘图引用——机制件契约化须把契约升为强制）。

区分「机制件」与「扩展点」：gate / audit / executor 是**机制件**（装配闭集、契约化）；策略槽 / 评分器 / 节点类型 / 配方字段是**扩展点**（数据面，运行期可填）。"运行期加机制"的真实诉求九成是填扩展点——放开机制层 = 把扩展点全部开成注册表端口，让"加策略 / 加评分器 / 加节点类型"不碰机制语义。

### 2.2 三条受控演化通道（机制可演化，只是通道受限）

| 通道 | 能演化什么 | 时点 |
|---|---|---|
| 装配期注入 | 换机制件的**实现**（同语义） | boot 前，boot 后密封 |
| 版本演进 | 加端口 / 换**语义** | 引擎版本（release + 签名） |
| 运行期补丁链 | 只动**数据/策略/配方/激活集** | 运行中 |

**红线**：唯一被排除的是"运行期自指改语义"——agent 在会话中途直接改掉自己的裁决/审计/回退规则。

- 自进化 = 系统确实能演化自己（含机制，经装配期 + 版本）；
- 受控 = 每次演化必须过闸门（签名 / 审批 / 审计 / 可回退），不能是思考中即兴自改。

### 2.3 引擎 0-IO 的端口注入

| 副作用 | 端口（seam） | 注入者 |
|---|---|---|
| 存储/审计写盘 | `storage_seam`（memory / sqlite） | 宿主装配期 |
| LLM/嵌入 | `llm_port`（按协议：openai_compatible / openai_responses / anthropic_messages） | 宿主装配期 |
| OS 执行/网络沙箱 | `exec_envelope`（host/exec 子进程信封） | 宿主装配期 |
| 事件/调度 | 进程内分派，物理传输由 host 注入 | 宿主 |

verify 强制：**插件只调声明过的端口，调了未声明端口或直接 IO = 装配期/扫描期拒绝**——0-IO 从"没发现违规"升级为"结构上不可能违规"。

---

## 三、统一插件源

插件即数据 → 数据源必须单一。分三层：

| 层 | 内容 | 手改？ |
|---|---|---|
| **真源** | 能力插件声明单源：`plugins/`（tools / commands / ui / mcp / 外部插件）；`hosts/<host>.spec.json` 为 kind='host' 宿主 spec（tauri/cli/web/ide 四份，同属能力插件契约） | ✅ 唯一手改处 |
| **生成物** | web 命令面 / 前端插件清单 / CLI 命令面，脚本从真源派生 | ❌ 禁手改 |
| **实现** | `impl.ts` / `*.tsx` / `ui.json`（渲染意图数据），跟插件目录走 | ✅ 代码，非数据源 |

现状散源收敛：`seed_data/tools.json`、`seed_data/ui_spec.json`、`host/src/bridge/index.ts` 的 `BRIDGE_METHODS`、`seed_data/mcp_market.json` → 全部并入一份 `plugins/` 源；`sync_web_command_surface.ts` 从"同步命令面"扩为"从插件源生成所有派生视图"。**例外边界**：`seed_data/event_types.json` 是引擎/渲染协议侧的事件类型真源（引擎发出、渲染器消费），不属于能力插件数据，**不进 `plugins/`**，由引擎 `event_types/` 域继续作为单一事实源；web 命令面生成物（`web_command_surface.json`）属派生视图、禁手改。
**阶段 3a 落地**（2026-09-07）：`plugins/` 真源就位（tools/ 35 工具单目录 + mcp/ 5 市场 server + market.json 全局配置，spec.json 逐字承载原 tools/mcp_market 声明行，含 package.json 连字符包名）；`plugins/manifest.json` 派生视图生成器（`plugins/scripts/sync_plugin_manifest.mjs`，`verify:plugin-manifest` 入 root test 链）聚合 tools 表行 + mcp 市场视图 + 插件索引；web dev 夹具、host mcp.market、tools_os 夹具生成、self_check data 门禁一律经 manifest 取用；`seed_data/tools.json`/`mcp_market.json` 已删（真源唯一化）。ui_spec（布局 spec）与 BRIDGE_METHODS（命令名）未迁，随阶段 3b。

**阶段 3b1 落地**（2026-09-07）：命令名真源迁 plugins——`plugins/commands/<method>/` 66 单命令目录（spec 带 data.group=实现域/data.order=域内序，capability=host_tool，package.json 连字符包名）；生成器扩为双输出（manifest.json + `host/src/bridge/commands.generated.ts`：31 域命令元组 + 域命令类型，DOMAIN_TABLE 固定跨域序 = BRIDGE_METHODS spread 序，夹具零漂移）；31 个 host 域实现文件删本地 `*_COMMANDS` 数组/类型，改 import type + re-export 生成物（编译期键锁不变：删命令 → typecheck 红）；`verify:bridge-mount` 扩展禁域文件本地数组。ui_spec 布局迁移留阶段 3b2。

**阶段 3b2 落地**（2026-09-07）：产品主壳布局真源迁 plugins——`plugins/ui_features/<id>/` **一布局树节点一插件**（用户定案：容器结构也是插件，全平铺）：装配入口 `inkling.ui`（data = name/version/theme + root.$ref）+ 容器/组件节点插件共 25 份（data.node 逐字承载节点 props/bind；容器 data.children 按序 `$ref` 子插件 id）。生成器扩为四输出：DFS 沿 $ref 展开重建完整布局树 → `plugins/ui.generated.json`（与迁移前 seed_data/ui_spec.json 语义逐字一致，web 渲染/dev 夹具取用；引用缺失/成环/孤儿插件 fail-closed），并把布局引用组件 type 并集升序派生 canonical 白名单（manifest `ui_features.components` + `host/src/bridge/ui_canonical.generated.ts`，host 配方界面白名单改由生成物引用——消灭手写 canonical 源）；`seed_data/ui_spec.json` 已删（真源唯一化）。web 消费改指生成物；web gate 白名单对码测试增「派生 canonical == 旧侧 inkling/manifest renderer_components」断言。

工具声明（tools.json）随迁为 `kind:'tool'` 插件数据：内置工具 = 单工具一目录
（`plugins/tools/<name>/spec.json`，`data.tool` 承载工具行，阶段 3a 定稿——
不再用统一包 `data.tools[]` 目录式，见 PLUGINS §2.1 修订），外部/agent 工具按插件
分发；**分发单位 = 目录/包，控制/检索单位 = 工具表行，二者正交**
（细则见 PLUGINS.md §2.1）。

**边界**：声明源统一 ≠ 代码文件统一——统一的是权威，物理文件见下节。

---

## 四、物理单目录（统一物理文件）

### 4.1 目录形态

```
plugins/compose/           # 示例 kind='ui_feature'（逻辑+界面脸）；tool/mcp 类再加 impl/ 与声明数据
├─ spec.json          # 声明（faces/depends/capability；含 data 顶层声明字段）
├─ AGENTS.md          # 该插件权威文档：是什么能力、能碰什么端口、数据从哪进
├─ faces/
│   ├─ ui/
│   │   ├─ ui.tsx          # ui face（终局 = 渲染意图数据 ui.json）
│   │   └─ ui.test.tsx     # ui face 测试（独立文件，与源码同目录并列，非内嵌）
│   ├─ logic/
│   │   ├─ logic.ts        # logic face（命令/动作，纯 TS）
│   │   └─ logic.test.ts   # logic face 测试（独立文件，与源码同目录并列，非内嵌）
│   └─ data/              # data face（按 kind 取需要的脸；声明数据主体在 spec.data）
├─ impl/               # JS 执行体 / MCP config / spawn 声明（随 kind 需要）
└─ locale/zh.json     # 文案跟插件走
```

测试「随插件同住」= 独立的 `.test.ts(x)` 文件与源码**同目录并列**，不是把测试内嵌进插件源码文件——每个 face 的源码旁放一个对应的 `.test` 文件。随阶段 7a 同步修订 CODING.md §2.7 的 `src-test` 纪律（从「测试放包 `test/`」改为「测试放插件目录、源码旁并列」）。

### 4.2 两条路

- **路径 1（过渡，标准 monorepo）**：单目录 + `package.json` `exports` 条件导出（`browser`→`faces/ui`、`node`→`faces/logic`）+ `faces.target`。文件真同住，构建按 target 切。卸载 = 删目录，两个 target 同时不再解析到它。
- **路径 2（终局，形态 A）**：ui face 变成渲染意图数据，插件只住引擎进程或引擎进 worker——真单进程、单目录、零构建分层。自由式复杂 UI 走 `artifactLoader` 逃生口。

推荐：先走路径 1（物理统一就地解决），路径 2 作为终局升级，升级时只把 `ui.tsx` 换成渲染意图数据，目录结构不动。

### 4.3 目录分层（每层权威文档）

对齐 dsh 的 `packages/*/AGENTS.md` + `docs/subsystems/*.md` 分层——**改哪层，先读哪层的权威文档**。以下为**目标态**（阶段 8 后）树；当前落地差异见 §九，与文末参考模拟 §1 为同一目标态（参考模拟仅供推演参照）。

```
ink-ts/
├─ PLUGINS.md               # 插件契约单一事实源（跨层：schema / 三档 / 机制闭集红线）
├─ engine/
│   ├─ AGENTS.md               # 引擎层契约：0-IO / kernel→adapters 单向 / 装配闭集
│   ├─ src/kernel/<mechanism>/ # 机制件：contract.ts + impl.ts + *.test.ts（现状 core/ 契约化后归此）
│   └─ src/adapters/           # IO 真实装（端口实现）
├─ exec/                        # Rust 原生执行后端：exec_envelope 物理实现 + 内嵌推理/文档解析/内置 MCP
│   ├─ CONFIG.md                # 信封行帧协议（对端唯一契约）
│   └─ crates/                  # 子进程二进制：os / doc / dialog / infer / ink_ts_mcp
├─ models/                      # 本地嵌入/推理模型权重资产库（embedder 等插件 spec data 引用，不随插件搬运）
├─ plugins/
│   ├─ AGENTS.md               # 插件层契约：声明即挂载 / faces / depends 单向
│   ├─ <插件名>/
│   │   ├─ spec.json           # 声明数据（机器可读单一事实源）
│   │   ├─ AGENTS.md           # 该插件权威文档：是什么能力、能碰什么端口、数据从哪进
│   │   ├─ faces/{ui,logic,data}/   # 各 face 实现 + 同目录 *.test.ts(x)（ui 终局 = ui.json）
│   │   ├─ impl/               # JS 执行体 / MCP config / spawn 声明（随 kind 需要）
│   │   └─ locale/             # 文案跟插件走
│   └─ manifest.json           # 派生视图（生成物，禁手改；见 §三 生成物行）
├─ renderer/
│   └─ AGENTS.md               # 渲染器契约：显示设备，不定义契约、不写业务
├─ hosts/
│   ├─ AGENTS.md               # 宿主面契约：只换 IO/传输/呈现面，不换机制语义
│   └─ <host>.spec.json        # 宿主 spec（tauri/cli/web/ide 四份；kind='host'，HostFaces 面，见 §五）
├─ bootstrap/                  # 唯一进程入口
├─ docs/
│   ├─ component_data_endgame.md   # 本文档（总纲 + 分阶段计划）
│   ├─ plugin_issues.md            # 问题卡 / 决策留痕
│   └─ subsystems/                 # 各层权威文档（单一事实源）
│       ├─ engine.md
│       ├─ plugins.md
│       ├─ renderer.md
│       ├─ host.md
│       └─ exec.md
```

- `spec.json` 是机器可读声明（数据源），`AGENTS.md` 是人类可读契约（意图/边界），二者同目录；
- 契约文档分两级：每层 `AGENTS.md`（就近）+ `docs/subsystems/*.md`（跨层权威），规则不散在代码注释里。

---

## 五、宿主 = 面插件（换宿主像换插件）

```
host.spec（能力插件 kind='host'；faces 用专用 HostFaces，不走通用 ui/logic/data 三脸）
├─ faces:
│   ├─ ports      storage 后端 / llm 槽位 / exec 信封 / 审批实现
│   ├─ transport  stdio | http+ws | webview bridge
│   ├─ surface    Tauri | 浏览器 Web | CLI/TUI | IDE 嵌入   ← 宿主身份全在这
│   └─ approval   弹卡 UI / CLI --approve / 策略自动放行
└─ contract      承诺给引擎的端口形状（装配前校验兼容）
```

- 引擎和能力插件不认识宿主是谁，只认 `faces` 提供的端口契约；
- 换宿主 = 换 host.spec + 重启装配（`bootstrap` 读 spec → 校验 → 装配 → 跑）；桌面/CLI/Web/IDE 只是四份 host.spec；
- **换宿主是装配期/实例级切换**，不是会话中途热换。

三条边界：宿主是能力插件不是机制（不能换机制语义）；换宿主不能是运行中热换；composition root 缩到只剩一个 bootstrap。

---

## 六、系统化三件套（让插件化"不靠自觉"）

1. **契约文档**（dsh 式分层，见 §4.3）：`PLUGINS.md`（跨层插件契约总则）+ 每层 `AGENTS.md`（engine/plugins/renderer/hosts）+ `docs/subsystems/*.md`，改哪层先读哪层——规则单一事实源，不散在代码注释；
2. **verify 脚本**（每层一个，CI 执法）：
   - 依赖单向（engine 不反向依赖产品层；插件域不 import 数据层实现）；
   - 0-IO 端口校验（只调声明端口）；
   - 命令声明即挂载（命令面从声明生成，无手写数组）；
   - 卸载一致性（depends 级联校验，无孤儿）；
   - 语义标签端到端断言（UI/命令语义标签沿调用链找到执行点，孤儿语义标签按阻塞报，见 CODING.md §11）；
3. **checklist**：插件/包 checklist + 检查阶梯（加插件 = 填空，不自由发挥）+ 文案/token 有源（web 可见文案走 locale，色值走 token）+ 决策留痕同变更；
4. **覆盖纪律**：每插件 100% 覆盖门禁，不可达分支须写真实理由——倒逼插件只收 props、逻辑全在数据层（对齐 dsh 的 100% 覆盖级别单测纪律）。

---

## 七、分阶段实施计划（每步独立可验证、可回退）

| 阶段 | 内容 | 产出 | 验证 |
|---|---|---|---|
| 0 | 契约文档：`PLUGINS.md` 就位（跨层插件契约单一事实源；本文档为设计推演 + 实施计划） | 契约源可被评审/校验引用 | 评审通过 |
| 1 | 放开机制层：机制件清单 + contract + 端口注入 + boot 密封 | 机制件 schema + 密封图 | verify（依赖单向/装配完整/0-IO） |
| 2 | host 命令声明即挂载（消灭 `BRIDGE_METHODS` 手写数组 + 31 个 `build*Handlers`） | 命令声明表 + 自动挂载 | verify（声明即挂载） |
| 3 | 统一插件源（tools/ui_spec/BRIDGE_METHODS/mcp_market 收敛） | 一份 `plugins/` 源 + 派生视图生成器 | 生成物一致性校验 |
| 4 | faces 挂接 + 卸载一致性（plugin_id + depends 级联） | 拆插件 = 各脸同注销 | verify（卸载无孤儿） |
| 5 | 宿主面插件化（host.spec + bootstrap） | multi-host 兑现 | 换 spec 换宿主可复现 |
| 6 | exec 工具信封声明化（替 `host/src/exec/binary.ts` 手动约定） | 信封声明 + 按声明定位 | host 按声明装载 |
| 7a | 物理单目录（路径 1：条件导出）+ 测试随插件同住（修订 CODING.md §2.7） | 单目录插件 | 构建按 target 切 + 卸载一致 |
| 7b | 渲染器退化为显示设备（形态 A：ui face 渲染意图化） | 通用渲染器 + ui.json | 端到端渲染 + 卸载一致 |
| 8 | 系统化收口（每层 verify + checklist + 决策留痕） | 全层执法 | 全量 CI 红绿 |

依赖顺序：0 → 1 → 2 → 3 → 4 → 5 → 6 → 7a → 7b → 8；每阶段独立提交、独立可回退（7a 只动目录拓扑与测试迁移，7b 才换渲染范式——分两步，避免一次动目录 + 渲染 + 测试三件事不可回退）。

取舍注（阶段 2→3）：阶段 2 先在 host 内做命令声明表（验证「声明即挂载」样板、风险最低），阶段 3 再把声明源迁入统一 `plugins/`——一次验证机制、一次搬数据源，避免一次改动同时动「挂载机制」与「数据源拓扑」两件事；若评估后认为统一源优先，可交换 2/3 顺序。

---

## 八、红线清单（成本不在此列，这是"正确性"）

1. **机制内核装配闭集**：补丁动数据/策略/配方，不动机制语义；
2. **受控闸在每道装卸门**：vetting fail-closed + 审批 + 审计 + 可回退；
3. **不做生态专属适配**：我们只定义自己的插件契约，不做 dsh/cordis 等外来生态的专属适配器（同"LLM 按协议适配、不为厂商适配"原则）；外来生态要集成 = 由其作者自行按本契约适配成 `external_tool` 原生插件（spec/faces/impl 全按我们声明），vetting 照常审 spec + impl；
4. **能力层运行期可装卸、机制层走受控演化**：机制可经三通道演化（装配期注入 / 版本演进 / 运行期补丁链动数据），唯独"运行期自指改语义"被排除；装卸边界画在 capability 三档上；
5. **声明源统一、物理文件可两端**：统一的是权威（契约），不是进程；终局形态 A 再统一物理。

---

## 九、落地现状 vs 设计差异

> 实施后逐阶段回填。阶段 0（契约文档）与阶段 1（放开机制层）与阶段 2（命令
> 声明即挂载）已落地（2026-09-07）；阶段 3a（plugins 真源 + 工具/市场迁移）
> 与阶段 3b1（命令面真源迁 plugins）与阶段 3b2（产品主壳布局迁 plugins）
> 已落地（2026-09-07）；阶段 4（faces/卸载一致性，声明级地基 + verify-unload）
> 已落地（2026-09-07）；阶段 5（宿主面插件化，5a+5b-1/2/3）
> 已落地（2026-09-07）；阶段 6（exec 工具信封声明化）已落地（2026-09-07）；
> 阶段 7a（物理单目录路径 1 样板：doc_parse 首个真实 host logic face +
> host 装配期按声明装载 + 测试随插件同住）已落地（2026-09-07）；
> 阶段 7b（产品 UI 真身化全量迁移：canonical 叶子/设置 13 面板/设置浮层全量
> 迁 plugins 真 ui 面 + renderer 适配层与 settings 手写框架退役 + 第 6/7
> 派生视图 pluginFaces.generated.ts / settingsSections.generated.ts 接线）
> 已落地（2026-09-08）。

### 阶段 0–7b 落地状态（逐阶段回填）

| 阶段 | 设计要件 | 落点 | 状态 |
|---|---|---|---|
| 0 | 契约文档 `PLUGINS.md` 单一事实源 | 评审通过；本文件为设计推演 + 实施计划 | ✅ 完成 |
| 1 | 机制件物理归 `kernel/<mechanism>/` | 33 机制迁 `engine/src/kernel/`（Wave1a），import 全量改写 | ✅ 完成 |
| 1 | 机制件契约声明 | 33 份 `engine/src/kernel/<mechanism>/contract.ts`（id=目录名；effects 端口白名单 + value 级 depends） | ✅ 完成 |
| 1 | 契约单一源聚合 | `ALL_MECHANISM_CONTRACTS`（`engine/src/kernel/registry/contracts.ts`），boot/verify/测试共用 | ✅ 完成 |
| 1 | boot 密封 | `_runtime_assemble.ts` boot 装配首步 `seal_mechanism_registry(ALL)` fail-closed（id 唯一/depends 在册/无自环/无循环 + 拓扑序） | ✅ 完成 |
| 1 | C 类收敛（去自造/拆环） | 孤儿流水线清理、builder 沙箱副本 `derived`、self_application 校验器必注入、executor↔path_assembler 环拆（executor 经 `RunOptions.multipath_assembly` seam 消费组装上下文）；密封图归零环 | ✅ 完成 |
| 1 | verify 三键可执行 | `verify:mechanisms`（`engine/scripts/verify_mechanisms.ts`）：依赖单向（密封）+ 装配完整（runtime 闭包 ∪ 自足叶子 = 全量）+ 0-IO（kernel 禁 node 内置/第三方/IO 全局原语）；并入 root `test` 链 | ✅ 完成 |
| 2 | 命令声明即挂载样板 | 66 点分方法名归各域文件 `*_COMMANDS` 声明元组（31 份；`rounds.todos` 独立于 todos.ts 挂 rounds 域）；工厂改名 `build<Domain>Commands`，返回 `Readonly<Record<DomainCommand, BridgeHandler>>` 对象（编译期锁键集合 = 声明，缺/多/拼错即 typecheck 失败）；`BRIDGE_METHODS` 改为各域元组 spread 派生导出（值/顺序不变，self_check fixture 零漂移）；`host/src/bridge/index.ts` 不再含任何手写方法名 | ✅ 完成 |
| 2 | verify（声明即挂载） | `verify:bridge-mount`（`host/scripts/verify_bridge_mount.ts`）：BRIDGE_METHODS 数组体只允许 `*_COMMANDS` spread（禁点分方法名字面量防回退手写）+ spread 常量须已 import；并入 root `test` 链尾 | ✅ 完成 |
| 2 | 消费面适配 | capability store.test 改调 `buildCapabilityCommands` 下标访问；CODING.md §9 纪律注记同步声明驱动语义（§7 门禁表 + 扫描链） | ✅ 完成 |
| 3a | plugins 真源目录 + spec 契约 | `plugins/tools/<name>/` 35 工具单目录 + `plugins/mcp/<id>/` 5 市场 server + `plugins/mcp/market.json` 全局配置；spec.json（id/kind/capability/actions/depends/data.tool|data.server）逐字承载原 tools/mcp_market 声明行；package.json 连字符包名（`@ink-ts/plugin-<kebab>`） | ✅ 完成 |
| 3a | manifest 派生视图生成器 | `plugins/scripts/sync_plugin_manifest.mjs`（plugins 真源 → manifest.json：插件索引 + tools 表行 + mcp 市场视图，id 升序确定性；`--check` 归一逐字比对）；`verify:plugin-manifest` 入 root `test` 链尾 | ✅ 完成 |
| 3a | 消费面统一改指 manifest | web dev 夹具（backend.ts tools/mcp_market）、host `mcp.market`（seed_dir/探测改 plugins/manifest.json）、tools_os 夹具生成（sync_tools_fixtures.mjs）、self_check data 门禁（换源 + manifest --check 自洽）全部经 plugins/manifest.json | ✅ 完成 |
| 3a | 旧源删除 + 注释对齐 | `seed_data/tools.json`、`seed_data/mcp_market.json` 删除；engine mcp registry/self_proposal、host wiring、web types/backendAdapter、CODING.md §7/§9 引用改指 plugins 源 | ✅ 完成 |
| 3b1 | 命令插件源 + 生成 TS 类型 | `plugins/commands/<method>/` 66 单命令目录（spec：id/kind='command'/capability='host_tool'/data.group/data.order）；`host/src/bridge/commands.generated.ts` 生成物（31 域命令元组 + 域命令类型，DOMAIN_TABLE 固定跨域序 = BRIDGE_METHODS spread 序） | ✅ 完成 |
| 3b1 | 31 域实现文件改 import 生成物 | 删本地 `*_COMMANDS` 数组/类型声明，改 `import type` + re-export `commands.generated.ts`；工厂 Record 键锁不变（删命令目录 → 生成物元组少键 → typecheck 红） | ✅ 完成 |
| 3b1 | verify 扩展 | `verify:bridge-mount` 增禁「域文件本地声明 *_COMMANDS 数组」（方法名真源只在 plugins）；`verify:plugin-manifest` 双输出比对（manifest + commands.generated.ts） | ✅ 完成 |
| 3b1 | 夹具零漂移 | BRIDGE_METHODS 值/顺序不变（web_command_surface 夹具逐字一致）；CODING §9 命令表补 capability.baseline.get/set + tier.set（63→66） | ✅ 完成 |
| 3b2 | ui_feature 插件源 + 布局装配 | `plugins/ui_features/<id>/` 一布局树节点一插件（装配入口 inkling.ui + 容器/组件节点共 25 份；data.node 逐字承载 props/bind、容器 data.children 按序 $ref）；生成器 DFS 沿 $ref 展开重建布局 → `plugins/ui.generated.json`（迁移前 seed 布局语义逐字一致） | ✅ 完成 |
| 3b2 | canonical 白名单派生 + 消费改指 | 布局引用组件 type 并集升序 = canonical（manifest `ui_features.components` + `host/src/bridge/ui_canonical.generated.ts`）；host recipe 界面白名单改引用生成物（手写 13 项常量删除）；web App/backend/specShell 改 import `plugins/ui.generated.json`；`seed_data/ui_spec.json` 删除 | ✅ 完成 |
| 4 | 插件全脸 schema + 注册表行 | spec 顶层可声明 `actions`/`depends`/`faces`/`contract`（CapabilityComponent 全脸字段，缺省即 data-only）；生成器 `readSpec` 守 JSON 形状（faces 三脸 ui/logic/data × engine\|host\|web + entry 非空、effects 字符串数组等），manifest `plugins[]` 注册表行携带声明字段（未声明不输出，现有派生视图字节不变） | ✅ 完成 |
| 4 | verify:unload（卸载一致性，fail-closed） | `plugins/scripts/verify_unload.ts`（root test 链尾 `verify:unload`）：depends 悬空/成环/未登记（插件 id ∪ 机制端口词表 `engine/src/kernel/registry/ports.ts` 单一真源）= 违规；faces 结构 + `contract.effects ⊆ 词表`；manifest 平价（派生视图与真源逐一对应）；**data-only 状态引脚**；ui 可达性不变式（除装配入口外每 ui 插件 ≥1 父容器引用，`data.children.$ref` ∪ 入口 `data.root.$ref` 为反向边）；`--plan <id>` 输出卸载阻断方（下游 depends / 父容器）与级联子树 | ✅ 完成 |
| 4 | 卸载语义定案 | 用户定案（2026-09-07）：插件源单份共用 tauri/cli/web/ide 四宿主、不引入 per-host 分支（宿主差异 = host.spec 阶段 5 表达）；卸载 **fail-closed 拒卸**（有活动下游/父容器引用即阻断，先卸下游）；现有 131 内置插件（阶段 6 增 kind='endpoint' 三件 exec/infer/mcp → 134）审计结论 = 全 data-only（共享 exec 端点/共享域实现/共享渲染原语，无插件独占实现面），**不填占位 faces/depends/contract**（防第二份平行真相），schema 能力留外部/多面插件（随阶段 7a 物理单目录/8 收口启用） | ✅ 完成 |
| 3b2 | 生成物一致性 + 对码扩展 | `verify:plugin-manifest` 扩为四产物逐字比对；web gate 白名单对码测试增「派生 canonical == 旧侧 inkling/manifest renderer_components 逐项一致 + 全部可注册」 | ✅ 完成 |
| 5a | cli=host 插件框架 + TUI face | cli 退为**进程实现库**（`cli/src/index.ts` runCliMain 供调度；无自有语义入口），host 装配（kind=host）消费；argv 增 `tui` 形态 → `cli/src/tui/`（types/model/fmt/text/keys/actions/views/controller/tui）非 TTY line-mode 可自测 | ✅ 完成（阶段 5 首子步） |
| 5b-1 | 四份宿主 spec + host_spec loader | `hosts/tauri·cli·web·ide.spec.json`（cli/web implemented=true；tauri/ide implemented=false 占位外部壳仓）；`host/src/host_spec.ts`（findHostsRoot/loadHostSpec/validateHostSpec）+ `verify:host-spec` 入 root test 链 | ✅ 完成 |
| 5b-2 | 装配读 spec 注入 | `HostConfigInput.host_spec_id` → resolve 注入 spec 数据（ResolvedHostConfig + `HostHandle.surface`）；cli host.ts/serve.ts 按 cli.spec（serve 面=web.spec）注入；相关 host 测试 171 项全绿 | ✅ 完成 |
| 5b-3 | bootstrap 唯一进程入口 | `bootstrap/main.ts`（composition root 收敛面）：argv 形态 → 宿主面（stdio/run/tui=cli、serve=web）→ loadHostSpec 校验 implemented → 委托 runCliMain；root dev 脚本改指 bootstrap | ✅ 完成 |
| 6 | exec 工具信封声明化 | 新 kind='endpoint' 插件域 `plugins/endpoints/`（exec/infer/mcp 三件，spec.data.native = file + env）；派生视图第 5 产物 `host/src/exec/native.generated.ts`（NATIVE_BINARY_DECLS + NativeBinaryKind）入 verify:plugin-manifest 逐字比对；`host/src/exec/binary.ts` 手写 BINARY_ENV/FILE_BY_KIND 两表删除、按声明定位（binaryFileName/locateNativeBinary 对外签名不变）；`_types.NativeBinaryKind` 从生成物派生；verify_unload KIND_DIRS 增 endpoints 域；插件数 131→134 数字同步 | ✅ 完成（阶段 6 目标；host 按声明装载，失败语义消费方各自定） |
| 7a | 首真面样板：doc_parse host logic face | 用户拍板：**样板真面 + 拆 1 内置示范 / 最小 logic-face 工具 / host 装配期 loader**。doc_parse 升级为首个真实逻辑脸插件：spec 顶层 `faces.logic`（target=host，entry=./faces/logic/index.ts）+ `depends=['exec']`；package.json exports node 条件导出；执行体（DocService）自 `host/src/doc/service.ts` 迁 `plugins/tools/doc_parse/faces/logic/index.ts`，同目录 `index.test.ts` 同住；verify_unload data-only 引脚改**真面许可**（capability=external_tool 或 `REAL_FACE_BUILTINS` 白名单 doc_parse）+ faces entry 物理同住强制（相对禁逃逸 + 文件存在）；manifest 平价不变（134） | ✅ 完成 |
| 7a | host 装配期 logic-face loader | `host/src/plugins_fs.ts`（plugins/manifest.json 探测共享，mcp.market 改指同源）+ `host/src/face/loader.ts`（读 manifest plugins[] faces.logic.target='host' → 动态 import entry，禁越界；插件源缺 = 空集降级、face 装载失败 = fail-closed）；createHost 按声明装载 doc_parse 注入 bridge deps.docParse（rounds/material 降级语义不变） | ✅ 完成 |
| 7a | 同住纪律 + 链同步 | CODING §2.7 改「包内测试放 test/；插件 faces/impl 测试随插件同住」+ §7 表（真面插件 faces 代码入行数/UTF-8 扫描、data-only 引脚真面许可、verify 链增 `vitest run --root plugins`）；gate config lineScanDirs 增 `plugins/tools/doc_parse/faces`；host/src/doc/service.ts 删除（旧实现真源唯一化） | ✅ 完成 |
| 7b | 前端包更名 + 装配改指 | `web/`→`renderer/`（npm 包 @ink-ts/renderer）：包内目录/别名/消费（gate 扫描目录、self_check、hosts spec、vitest 根）全量改指 renderer，`renderer/` 名 = 纯渲染层（原 frontend→web→renderer 沿革） | ✅ 完成 |
| 7b | 真 ui 面统一形态 | spec 顶层 `faces.ui`（target=web，entry=./faces/ui/index.tsx 相对插件目录）+ package exports；faces/ui/ 内 index.tsx 默认导出（布局叶子 = product chrome→组件 props 薄适配器；面板 = 直渲组件）+ 实现与 `*.test.tsx` 同住；渲染器注册 = 第 6 派生产物 pluginFaces.generated.ts 静态 import（注册名 = 插件 id）；verify_unload 对 ui_feature 组件节点（isUiComponent）放行真面并强制 entry 相对禁逃逸 + 文件存在 | ✅ 完成 |
| 7b | canonical 布局叶子全量真面化 | top_bar/file_tree/session_list/message_list/agent_input/review_card/task_capsule/todo_view/mechanism_view/ledger_view/trajectory_view/evolution_feed/settings_floater 13 布局叶子逐个迁 plugins faces/ui（含 gate 锚点名）；`renderer/src/app/rendererAdapters/`（layoutAdapters + index）整体退役 | ✅ 完成 |
| 7b | settings 面板细拆 + 浮层真面化 | 设置 13 面板按 feature 域细分独立插件（settings_general/model/connect/knowledge/architecture/memory/insights/audit_recovery/backup + wave4 mcp_market/tools_panel/workspace_auth/ui_editor_host，spec `data.settings_section` key/label/order/icon + faces.ui，order 10/20/40/50 wave4 扁平独立段）；settings_floater 真面读第 7 派生产物 SETTINGS_SECTIONS 渲染左导航、内容 DynamicComponent name=插件 id；settings 手写注册框架（registry/activate/types/item_renderer/floater）删除，settingsSections.generated.ts 为唯一壳读源；插件入口自建共享 AppBackend 单例（dev 夹具兜底，定案 B） | ✅ 完成 |
| 7b | 可达性统一规则 | ui 可达性不变式（verify_unload + 生成器同源双保险）= 除装配入口外每 ui_feature 插件须被容器 data.children.$ref 或 data.settings_section 引用，无孤儿、无豁免；设置面板 = 数据引用挂载（派生清单），不占布局树 $ref | ✅ 完成 |
| 7b | 装配面收敛 + 派生视图接线 | renderer app/activate = registerBuiltinComponents + registerPluginFaces + registerEventRenderers；verify:plugin-manifest 扩为七产物（+ pluginFaces.generated.ts + settingsSections.generated.ts）逐字比对；白名单对码/壳直渲/设置段注册测试改随 pluginFaces 注册语义 | ✅ 完成 |

### 已具备的地基（对照现状）

| 设计要件 | 现状落点 | 状态 |
|---|---|---|
| 引擎 contract-as-data | `engine/src/core/registry/registry.ts`（契约+工厂同表） | ⚠️ 边界：契约现为可选参数，无契约 = 不参与组装、仅可手绘图引用；机制件契约化须升为强制（stage2 起评估） |
| 0-IO 端口注入 | `engine/src/adapters/`（storage/llm/mcp + boot） | ✅ 已实现 |
| 装配数据 | `AssemblyRecipe`（engine 定义，经 `@ink-ts/engine` 导出）+ `runtime.boot(host, recipe)`（host 装配使用，`host/src/boot.ts`） | ✅ 已实现 |
| web 纯渲染 L5 | `plugins/ui_features` 布局装配（生成物 `plugins/ui.generated.json`）+ 真 ui 面插件 faces/ui（pluginFaces.generated.ts 静态注册白名单）+ `componentRegistry` 白名单 + `artifactLoader` | ⚠️ 部分：业务逻辑在插件 logic face/actions（跑引擎侧），canonical 叶子/设置 13 面板/设置浮层实现已全量真面化入插件、ui face 不含业务逻辑（L5 成立）；产品 chrome 组合层（App/state/productView 宿主装配面）仍在 renderer 包 |
| 命令面同步 | plugins/commands spec → `commands.generated.ts`（生成物）→ 各域 import/re-export → `BRIDGE_METHODS` spread 派生；`verify:bridge-mount` + `verify:plugin-manifest` | ✅ 声明即挂载（阶段 2 + 3b1 目标；命令名真源已迁 plugins/） |
| 统一插件源 | `plugins/` 真源（tools/ 35 + mcp/ 5 + commands/ 66 + ui_features/ 38 + endpoints/ 3 + market.json）+ 七派生视图生成器（manifest.json / commands.generated.ts / ui.generated.json / ui_canonical.generated.ts / native.generated.ts / pluginFaces.generated.ts / settingsSections.generated.ts）+ `verify:plugin-manifest` | ✅ 阶段 3a+3b1+3b2+6+7b：tools/mcp 市场/命令名/产品主壳布局/原生执行件端点全部收敛，消费（renderer/host/fixtures/data 门禁 + binary.ts 定位）统一经派生视图；canonical 白名单亦派生（布局引用并集）；真 ui 面注册与设置段清单亦派生（第 6/7 产物） |
| 机制件统一 contract + 装配闭集校验 | 33 机制 `engine/src/kernel/<mechanism>/contract.ts` + `registry/registry.ts` 密封校验 + boot 接线 + `verify:mechanisms` | ✅ 完成（本阶段目标） |
| 自进化机制 | `self_tools`/`self_application`/`settle/seed`/`growth`/`skill_crystal`/`tuning`（`kernel/*`，默认开） | ✅ 机制已实现并契约化（无产品侧业务层，见 §1.5） |
| faces / depends / 卸载一致性 | 机制层 depends 已契约化（DAG/闭包校验）；产品层 spec 全脸 schema + 数据级卸载一致性由 `verify:unload` 强制（depends 解析/环、faces 结构、ui 组合/可达性含 settings 派生清单引用、manifest 平价、真面许可引脚） | ✅ 数据层完成（阶段 4）；真面语义完成（7a doc_parse logic 样板经 REAL_FACE_BUILTINS、7b 真 ui 面经 isUiComponent 放行，entry 物理同住强制） |
| 宿主面插件化 | `hosts/*.spec.json`（tauri/cli/web/ide 四份）+ `host/src/host_spec.ts` loader/校验 + `bootstrap/main.ts` 唯一进程入口 + createHost 装配期 spec 注入（`host_spec_id`/`surface`） | ✅ 阶段 5 完成：cli/web 本仓装配、tauri/ide 外部壳仓占位；换 spec 换宿主可复现 |
| 原生二进制定位声明化 | plugins/endpoints 真源（kind='endpoint'：exec/infer/mcp）→ `host/src/exec/native.generated.ts` 派生 → `host/src/exec/binary.ts` 按声明定位 | ✅ 阶段 6 完成：手写 BINARY_ENV/FILE_BY_KIND 表删除；失败语义消费方各自定（dialog/doc 降级、mcp 装配 fail-closed） |
| 物理单目录 + 真面装载 | plugins/\<kind\>/\<id\>/faces/* 物理同住（doc_parse 首个真实 host logic face：faces/logic/index.ts + 同目录 index.test.ts）+ `host/src/face/loader.ts` 装配期按声明装载 logic face + verify 强制 faces entry 存在/禁逃逸与真面许可引脚；真 ui 面（target=web）为渲染器装配期静态注册（pluginFaces.generated.ts import entry） | ✅ 阶段 7a 样板（内置 doc_parse 真面化并拆出示范）+ 阶段 7b 全量真 ui 面（26 = 13 布局叶子 + 13 settings 面板，renderer 适配层退役）；external/multi-face 走同一 seam，待真实外部插件落地 |
| 真 ui 面渲染器注册（产品 UI 真身化） | 渲染器组件注册名 = 插件 id，白名单放行面即派生视图 pluginFaces.generated.ts（静态 import 各 faces/ui 默认导出）；canonical 布局叶子/设置面板/浮层均按 spec faces.ui 声明随插件同住，无 renderer 适配器；设置浮层读派生清单 settingsSections.generated.ts（真源 = data.settings_section）渲染导航，内容 DynamicComponent name=插件 id；ui 可达性 = 容器 $ref ∪ settings 派生清单，无孤儿无豁免 | ✅ 阶段 7b：rendererAdapters 与 settings 手写注册框架退役，设置 13 面板全部真面化 |

# ink-ts 插件即数据 · 终局形态参考模拟

> 状态：参考模拟（2026-09-07），**非落地承诺——以实际实施过程为主**；本文件是按
> `docs/component_data_endgame.md` 计划走完各阶段后的终局状态推演，供实施时作参照，
> 实际落地的目录/schema/流程以实施过程的真实演进与决策为准。
> 范围：ink-ts 全栈终局形态（对应计划阶段 0→8 的产物形态）

---

## 1. 终局目录树

```
ink-ts/
├─ PLUGINS.md                    # 插件契约单一事实源（跨层：schema / 三档 / 机制闭集红线）
├─ engine/
│   ├─ AGENTS.md                    # 0-IO / kernel→adapters 单向 / 装配闭集
│   └─ src/
│       ├─ kernel/                  # 机制件（现状 core/ 契约化后归此）
│       │   ├─ gate/    ├─ audit/   ├─ executor/ ├─ settle/
│       │   ├─ patch_chain/ ├─ round_steps/ ├─ self_tools/
│       │   ├─ growth/  ├─ tuning/  ├─ skill_crystal/
│       │   │   └─ 每个：contract.ts + impl.ts + *.test.ts
│       ├─ adapters/                # storage/llm/mcp 端口实现（DI 装载）
│       ├─ registry.ts              # 装配闭集：boot 组密封图 + 依赖单向校验
│       └─ types.ts                 # 唯一 schema 真源
├─ exec/                            # Rust 原生执行后端（exec_envelope 物理实现 + 内嵌推理/文档解析/内置 MCP）
├─ models/                          # 本地嵌入/推理模型权重资产库（插件 spec data 引用）
├─ plugins/                      # 唯一插件源（真源，手改处）
│   ├─ AGENTS.md
│   ├─ compose/  ├─ settings/  ├─ tool_market/  ├─ review_card/  ├─ ...
│   └─ manifest.json                # 派生视图（生成物，禁手改）
├─ renderer/
│   ├─ AGENTS.md                    # 显示设备：不定义契约、不写业务
│   └─ src/ (通用渲染器：只渲染引擎推来的 ui 意图数据树)
├─ hosts/
│   ├─ AGENTS.md
│   ├─ tauri.spec.json  ├─ cli.spec.json  ├─ web.spec.json  ├─ ide.spec.json
├─ bootstrap/main.ts                # 唯一进程入口
└─ docs/
    ├─ component_data_endgame.md
    ├─ plugin_issues.md
    └─ subsystems/{engine,plugins,renderer,host,exec}.md
```

## 2. 核心 schema（engine/src/types.ts）

```ts
type CapabilityTier = 'core_tool' | 'host_tool' | 'external_tool';
interface FaceRef { target: 'engine' | 'host' | 'web'; entry: string }

interface CapabilityComponent {                       // 仅插件类型（机制件非插件，见 MechanismContract）
  id: string;
  kind: 'tool' | 'command' | 'ui_feature' | 'endpoint'
     | 'recipe' | 'executor' | 'mcp' | 'host';
  contract: { inputs?: unknown; outputs?: unknown; effects: string[] }; // effects = 声明过的端口
  data: unknown;
  actions: string[];                                   // logic face 暴露的命令/操作
  capability: CapabilityTier;
  depends: string[];                                   // DAG，装配期校验单向 + 完整
  faces: { ui?: FaceRef; logic?: FaceRef; data?: FaceRef }
       | HostFaces;                                    // kind='host' 用 HostFaces（host.spec，见 §五）
}

interface HostFaces {                                  // 宿主专用面（kind='host'；port/transport/surface/approval）
  ports: unknown;                                      // storage 后端 / llm 槽位 / exec 信封 / 审批实现
  transport: 'stdio' | 'http+ws' | 'webview';
  surface: 'tauri' | 'web' | 'cli' | 'ide';            // ← 宿主身份全在这（tauri/cli/web/ide 四份 spec）
  approval: unknown;                                   // 弹卡 UI / CLI --approve / 策略自动放行
}

interface MechanismContract<Ports> {                   // 机制件（kernel/）
  contract: { inputs: unknown; outputs: unknown; effects: string[] };
  depends: string[];
  inject: (deps: Ports) => unknown;                    // 端口注入，boot 时调用一次
}
```

## 3. 一个能力插件全貌（plugins/compose/）

**spec.json**（声明数据，机器可读真源）：
```json
{
  "id": "compose",
  "kind": "ui_feature",
  "contract": { "effects": ["rounds.port"] },
  "actions": ["compose.send"],
  "capability": "external_tool",
  "depends": ["rounds.port", "session_store"],
  "faces": {
    "ui":    { "target": "web",  "entry": "./faces/ui" },
    "logic": { "target": "host", "entry": "./faces/logic" }
  }
}
```

**faces/logic/logic.ts**（logic face，纯 TS，只调声明过的 `rounds.port`）：
```ts
export const composeSend = async (deps: { rounds: RoundsPort }, text: string) =>
  deps.rounds.send({ role: 'user', text });   // 组装消息 → 喂引擎回合
```

**faces/ui**（ui face，纯 props，或终局 `ui.json` 渲染意图数据；同目录 `faces/ui/ui.test.tsx` 随源码并列）。

**卸载一致性**：删 `plugins/compose/` → 装配刷新 → `compose.send` 与 ui face 同时注销 → 渲染器不再有输入框 → 无入口发消息；但 `rounds.port`（引擎机制）仍完整——CLI/MCP 照样能 send。

## 4. 一个机制件全貌（engine/src/kernel/gate/）

```ts
// contract.ts —— 端口声明，引擎不 new/import，宿主装配期注入
export interface GatePorts {
  storage: StorageSeam;
  approvalSource: ApprovalSource;
}
// impl.ts —— 纯逻辑，只调契约端口（verify 强制：调了未声明端口 = 拒绝）
export function makeGate(deps: GatePorts): Gate {
  return { assertIdle: () => { /* 纯裁决逻辑 */ } };
}
```

boot 密封后运行期不可改；补丁链只能动数据/策略/配方，动不了 gate 语义。

## 5. host.spec + bootstrap

```ts
// bootstrap/main.ts —— 唯一进程入口（原 host boot + cli main 收敛）
const hostSpec = readHostSpec(argv.surface);       // tauri | cli | web | ide 四选一
const plugins = loadPluginSource();             // 统一插件源 + manifest
const kernel = sealKernel(registry, hostSpec);      // 装配闭集：依赖单向 + 端口齐备校验
const engine = bootEngine(kernel, hostSpec, plugins);   // 0-IO 语义核
startTransport(hostSpec.faces.transport);           // stdio | http+ws | webview
```

换宿主 = 换 `hostSpec` + 重启装配；桌面/CLI/Web/IDE 只是四份 spec。

## 6. 引擎驱动数据（一个完整回合）

```
渲染器点「发送」
  → 数据事件 {type:'compose.send', payload:{text}}       ← 渲染器不直接调后端
  → 引擎路由：查 plugins 源 → compose.actions 命中 → 调 compose.logic（host 进程）
  → compose.logic 组装消息 → 调 rounds.port（引擎机制）
  → 引擎回合：组装图 → 执行 → 产出事件/结果数据
  → 引擎把结果作为 ui 意图数据树 diff 推给渲染器
  → 渲染器（显示设备）画出来
```

## 7. verify 脚本清单（每层一个，CI 执法）

| 脚本 | 断言 |
|---|---|
| `verify-domains` | engine 不反向依赖 plugins/renderer/hosts；kernel→adapters 单向 |
| `verify-io` | 插件/机制件只调声明过的端口（effects 白名单），直接 IO = 拒绝 |
| `verify-mount` | 命令面从声明生成，无手写数组（`BRIDGE_METHODS` 消失） |
| `verify-unload` | depends 级联校验，卸载无孤儿生产方 |
| `verify-semantics` | UI/命令语义标签沿调用链找到执行点（"回合=组装"→ `Runtime.assemble_round`），孤儿语义标签按阻塞报 |

## 8. 收敛对照（阶段 → 终局产物）

| 阶段 | 终局产物 |
|---|---|
| 1 放开机制层 | `kernel/*/contract.ts + impl.ts` + `registry.ts` 密封图 |
| 2 命令声明即挂载 | `BRIDGE_METHODS` 手写数组删除，命令面从 plugins 源派生（3b1 落地：plugins/commands spec → commands.generated.ts → BRIDGE_METHODS） |
| 3 统一插件源 | `plugins/` 真源 + manifest.json/commands.generated.ts/ui.generated.json/ui_canonical.generated.ts 生成物（tools/mcp/commands/ui_spec 收敛；阶段 3a 落 tools+mcp_market，3b1 落命令名，3b2 落 ui_features 布局 + canonical 派生） |
| 4 faces + 卸载一致 | `spec.json` 的 faces/depends + `verify-unload` |
| 5 宿主面 | `hosts/*.spec.json` + `bootstrap/main.ts` |
| 6 exec 信封 | 工具信封声明入 plugins 源，按声明定位（替 `binary.ts`） |
| 7a 物理单目录 | 插件目录内聚 + 测试随插件同住 |
| 7b 形态 A | `ui.tsx` → `ui.json`，renderer 退化为显示设备 |
| 8 系统化收口 | 5 个 verify + 每层 AGENTS.md + checklist |

---

终局一句话：**引擎是"只做判断、不碰 IO、结构受控演化"的语义核；一切能力都是 `plugins/` 里带全脸的数据；渲染器是哑终端；宿主是四份 spec。** 拆一个插件，它的各脸（UI、逻辑、数据三脸，或宿主 HostFaces）一起消失，而引擎的机制分毫不动。

> 本文件为参考推演，实际实施以实施过程的真实演进为准；落地差异回填于
> 同文件上文 §九「落地现状 vs 设计差异」（参考模拟附于 §九 之后，非文末）。

# InKling 产品种子实施计划（开山之作）

> ink_engine 的第二个产品种子，第一个纯 TypeScript/Rust 产品种子。
> 引擎零机制改动。本文档是 seeds/inkling/ 的第一个工件。

## 1. 背景与定位

- **产品身份**：InKling —— 自进化认知伙伴
- **一句话定位**：你用得越多，它越懂你的领域
- **与 DSH 错位**：DSH = 可组合的编码 agent（装插件）；InKling = 可演化的领域智能体（长能力）
- **与 forge 分工**：forge = 自举产品壳（演示引擎吃自己狗粮）；InKling = 领域深度产品（演示引擎让真实产品越用越强）；机制组件可移植复用，身份数据各归各
- **起点领域**：知识/研究孵化（出厂展示领域，非产品边界——其余领域靠 `propose_domain_manifest` 由产品自己长出）
- **冷启动资产**：全新编写（novel 包已删除，无历史包袱）

## 2. 设计公理（已定论，计划内不重议）

1. **机制是引擎**：种子侧机制骨架只剩两件引擎降不掉的——Rust 执行件运行时 + TS 渲染器，外加一个通用 Python 接线件（非产品内容）与一个宿主件（桌面壳：宿主进程 + 执行器注册，非机制、形态资源）
2. **知识是数据**：产品全部内容 = `seed_data/` JSON，单一事实源（TS/Rust 侧维护，Python 只读）
3. **变化是补丁**：种子零自建演化机制，数据演化全走引擎补丁链（propose_patch → 分级审批 → append → 链尾回退）
4. **汇入靠调配**：执行件多源产出回流引擎调配器，种子零自建混合逻辑
5. **机制全覆盖**：引擎八域机制（执行/知识/调配/工具/事件界面/装配生命周期/构建/自指）全部经装配配方注入使用、无未用机制——每个机制对应 InKling 一个真实产品场景，e2e 逐机制断言；引擎内部执行件（安全剥离/日志/状态通道等）随链路自然触发并纳入断言

**图结构演化边界**：AI 可改图拓扑（数据，走 PatchKind.HARNESS），出厂注册两个通用节点类型："工具流水线编排" + "研究编排"（返回 __plan__/__spawn__/__simulate__ 保留键的通用编排节点，经 GraphRegistries 解析建图）。

## 3. 目标与非目标

**目标**
- 完整跑通四律递归应用的产品种子：数据 JSON / Rust 执行件 / TS 前端 / 桌面壳 / Python 接线
- 机制全覆盖：引擎八域机制全部经装配配方注入使用，e2e 逐机制断言
- 出厂自检矩阵全绿（schema + cargo test + MCP 协议 + 装配 e2e）
- 引擎零改动，装配配方全数据注入

**非目标**
- 不在本计划内做第二个领域（起点领域外全靠演化长出）
- 不提炼引擎机制（接线层先放种子侧，第三个种子复用后再议提炼）
- 不做 DSH 互操作适配（双向 MCP 为后续可选加分项，执行件协议兼容即可）
- 不做云端/多用户（本地单用户产品；跨部署迁移由知识集导出/导入覆盖）

## 4. 目录结构（全部新建）

```
seeds/inkling/
  PLAN.md                     # 本计划
  manifest.json               # 身份登记：名称/版本/契约清单/自检矩阵/引擎版本依赖
  seed_data/
    boot_prompt.json          # 自举系统提示词（定稿见 §5.1）
    ui_spec.json              # 布局树（组件/绑定通道/主题 token，墨色系）
    event_types.json          # 事件类型注册表
    graph.json                # 回合图声明（节点/边以注册名引用）
    tools.json                # 声明式工具清单（name/schema/权限/端点）
    rules.json                # 领域规则集（约束/状态转换）
    samples.json              # 样例库（数据↔执行件绑定验证，fixture 全绿非谈判项）
    templates.json            # 模板基线
    knowledge.json            # 冷启动知识条目
    workflow.json             # WorkflowSpec 研究流程约束域（__plan__ 落点）
    signals.json              # 五类信号→蒸馏器映射（孵化入口）
    tiers.json                # 模型双挡位（main/router）配置
    review.json               # 评审/收敛配置（维度/阈值/轮次上限）
    memory.json               # 记忆策略声明（召回策略/失效窗口）
    env.json                  # 环境声明（local/web_bridge/container——容器形态出厂落地）
    mcp_market.json           # MCP 市场目录（名称/来源/端点/凭据需求/风险档，出厂零预挂）
  exec/                       # 机制件一：Rust 执行件（唯一允许的"代码"）
    Cargo.toml                # 零外部依赖
    src/main.rs               # MCP stdio JSON-RPC（initialize/tools/list/tools/call）
    src/executors/            # 领域执行体：谓词/采集/解析/结构化/评分/评审/蒸馏/变异
    tests/                    # cargo test：谓词↔规则/样例/信号/评审数据绑定不漂移
    tests/protocol/           # MCP 协议 conformance（免引擎喂 JSON 行）
  frontend/                   # 机制件二：TS 渲染器 + 组件
    src/renderer/             # UIRenderer 契约实现（JSON 布局 → 组件树）
    src/components/           # 机制通用组件（消息流/审批卡/孵化面板/演化时间线/推演轨迹树/进化工厂面板/来源明细/设置页表单）
    src/domains/              # 领域组件包（按 manifest 清单加载）
    src/shared/
  host/                       # Python 接线件（通用，非产品内容）
    host.py                   # Host 五件套（存储/模型/审批/传输/关停）
    recipe_loader.py          # JSON → AssemblyRecipe（零领域逻辑）
    main.py                   # 入口
  shell/                      # 宿主件：桌面壳（Tauri，Rust 后端 + TS 前端，纯 TS/Rust 栈成立）
    src-tauri/                # 托盘/系统通知/文件挂载授权
    src/executors/            # process_exec 执行器注册（launch_app/open_file/system_query/…，白名单、禁硬编码）
    src/mcp/                  # 设备感知 server 挂载接线
    tests/                    # 执行器注册契约测试（声明↔执行器签名一致 + 权限/沙箱守卫断言，免真实桌面）
  tests/
    schema/                   # seed_data JSON Schema 定义 + 校验
    e2e/                      # 装配闭环 e2e（注入→挂载→回合→推演→孵化→进化→补丁→回退）+ 机制覆盖矩阵
```

根级变更：`seeds/` 目录登记（README「目录即清单」）+ 根 README 仓库构成更新。

## 5. 身份契约（manifest 字段与定稿值）

| 字段 | 值 |
|---|---|
| `id` | `inkling` |
| `name` | InKling（通用名，不携带引擎核心思想） |
| `positioning` | 你用得越多，它越懂你的领域 |
| `domain_boot` | 知识/研究孵化 |
| `version` | 0.1.0 |
| `engine_version_compat` | 按当前 ink_engine pyproject 版本锁定 |
| `theme` | 墨色系：深墨底 `bg.base` #09090b / 纸白字 `text.base` #e4e4e7 / 审批卡 accent 出厂默认朱砂 #f59e0b（跟随主题演化） |
| `contracts` | 执行件 MCP id `inkling_exec`、宿主件 id `inkling_shell`、渲染组件白名单、事件类型清单、工具清单引用 |
| `self_check` | schema / cargo test / MCP protocol / e2e 四项门禁命令 |

### 5.1 boot_prompt.json 定稿

> 你是 InKling——一个自进化认知伙伴。你对用户的领域起初只有隐约的理解，通过观察、检索、校验与孵化，把使用中积累的理解沉淀为可信的知识；每一次变化都经审批、可审计、可回退；你也可以提议接入外部工具/插件来扩展能力，经你确认后生效。用中文简明作答。

### 5.2 展示层设计（ui_spec.json 契约定稿）

三级信息架构（主界面是干活面，深看靠独立视图，配置全进设置——DSH 同构）：

```text
root（theme: ink 墨色系）
├─ 主界面（默认态，机制不常驻）
│   ├─ 顶栏（hairline 分隔）：InKling · 领域名       演化 → 设置 →
│   ├─ 会话列表（窄左栏，可收起）：今日/历史/搜索
│   └─ 对话主区：message_list（流式/思考/工具调用内联一行：工具名·权限判定·结果摘要）
│      + knowledge_row（检索命中/孵化信号内联微卡）+ agent_input（底部一行小字：挡位/模式档提示）
├─ 独立视图（按需打开，机制态 = 发布演示/审计时可见）
│   ├─ 演化：孵化面板（信号→蒸馏→闸门流水）+ 进化工厂（变异/防退化）+ 演化时间线（补丁链）
│   ├─ 推演：simulate_decision 分支对比 + Evaluator 评分 + swap_branch 换选
│   └─ 来源：检索/记忆/证据留痕明细（依据链溯源，可跳到知识条目）
└─ 设置页（改一次很久不变的系统配置）
    ├─ 模型：双挡位（main/router）配置 + fallback
    ├─ 权限与审批：kind → L0/L1/L2 审批表、默认权限档（allow/review/deny）、超时策略
    ├─ 连接：MCP 挂载管理（mcp_market.json 市场 + 手动添加 + 对话式安装记录）+ 环境管理（local/web_bridge/container 声明、运行与销毁）+ 工作区授权（桌面目录挂载点，file_ops 权限分级）
    ├─ 数据与记忆：记忆失效窗口、知识集导出/导入、存储后端与清理
    ├─ 外观：主题 token（墨色系）+ 皮肤试穿再应用（白名单内）
    └─ 关于：版本/engine_version_compat/契约清单
```

审批卡 = 居中弹层（任何视图可弹，朱砂 accent）。机制内容全部内联进消息流/独立视图，主界面不常驻机制面板。

绑定协议：`{"bind": {"channel": "...", "path": "..."}}`——组件数据绑定引擎状态通道/事件流，渲染器订阅变更重渲；绑定路径白名单（`_` 前缀内部通道禁绑，防信息泄漏）。

绑定通道白名单与组件-事件映射：

| 通道 | 绑定内容 | 消费组件 |
|---|---|---|
| `state.*` | 回合状态通道（消息/round_steps） | message_list、来源明细 |
| `events.reply_token` / `thinking_start` | 流式回复 | message_list |
| `events.plan_start` / `spawn_start` / `simulate_decision` | 重规划/子任务/推演 | 推演轨迹树、消息流（内联行） |
| `events.review_card` | 审批卡 | 审批卡容器 |
| `events.*孵化/进化*` | 信号/蒸馏/变异 | 孵化面板 |
| `events.*时间线/补丁*` | 补丁链事件 | 演化时间线 |
| `events.*记忆/调优/vetting*` | 来源留痕 | 来源明细 |
| `events.*device*` | OS 感知/控制留痕 | 消息流（内联行）、来源明细 |
| `inspect_graph` / `inspect_rules` / `inspect_knowledge` / `inspect_ui` / `inspect_tools` | 五元快照 | 演化时间线/孵化面板 |

主题 token 白名单（语义 token，组件一律经 token 取色、不硬编码颜色）：`bg.base` 深墨底 `#09090b` / `text.base` 纸白字 `#e4e4e7` / `accent.approval` 审批卡出厂默认朱砂 `#f59e0b`。强调色纪律：accent 语义槽只出现在审批/决策点（朱砂仅审批卡，且为出厂默认值）；token 值随 PatchKind.THEME 演化/皮肤试穿换色（白名单内），审批卡跟随主题。

### 5.3 OS 认知（出厂范围：宿主件入厂）

设备认知层引擎侧零改动，机制全部复用 §6 M3「工具安全纵深」；宿主件（`shell/` 桌面壳）入厂后「缺宿主件」缺口闭合——感知/控制以数据资产 + 执行器注册接线落地，不新增机制：

- **宿主件**：`shell/` Tauri 桌面壳（Rust 后端 + TS 前端）——托盘/系统通知/文件挂载授权 + `process_exec` 执行器注册（launch_app/open_file/system_query/set_volume/set_brightness/notify/schedule，白名单、禁硬编码、工具声明必须走补丁链演化管线产出）+ 设备感知 server 挂载接线
- **感知类**：`mcp_client` 挂载设备感知 server（屏幕/文件/系统状态）+ 声明式工具（screen_query/file_query/system_query，权限 allow/review）+ 事件类型注册表补 device 事件
- **控制类**：`process_exec` 端点 + `shell/` 注册执行器 + 首次越界操作强制 L2 人工审批
- **安全策略**：权限分级 allow/review/deny + 网络策略 + 沙箱端点——复用 §6 M3「工具安全纵深」，零新增机制

**外部对照（DSH 如何感知 OS）**：DeepSeek Harness（dsh）把 OS 感知做进 harness 自身——插件树内建能力缝（seam）+ 提供器（provider）：`fs/`（文件读写搜索）、`shell/` + `subprocess/`（命令执行/进程树）、`terminal/`（持久 PTY）、`web/`（搜索抓取）、`sandbox/`（Landlock/bwrap/Seatbelt 进程边界，fail-closed）、`permission-presets` + `ctx.approval`（模式档 workspace-write/read-only/full + 批准）。其感知面 = 编码 agent 需要的 OS 面（工作区 + 命令 + 进程 + web），不含设备级认知（屏幕/音量/传感器——社区桌面壳只是托盘壳，不是感知）。机制与引擎等价：fs ≈ `file_ops` 端点 + 文件沙箱（写前快照）；shell/subprocess ≈ `process_exec` + 进程沙箱（白名单/超时 kill）；preset ≈ `approval.py` 分级（allow/review/deny）；approval seam ≈ `interrupt` 挂卡审批；sandbox seam ≈ `sandbox.py`。差别只在分工：DSH 感知面是 harness 代码侧内建插件，InKling 感知面是宿主挂载（MCP/声明式工具/`shell/` 注册执行器）——宿主件入厂后缺口闭合：与 DSH 同构（自带宿主进程 + 桌面壳），但感知面仍走宿主挂载 + 数据长出，机制零新增。

## 6. 里程碑与任务分解

### M0 身份与数据基线

- [ ] 建目录骨架 `seeds/inkling/`
- [ ] `manifest.json`（§5 字段全部落值）
- [ ] `seed_data/boot_prompt.json`（§5.1 定稿）
- [ ] `seed_data/ui_spec.json` 初版：按 §5.2 三级架构（主界面/独立视图/设置页布局树；组件 = message_list/agent_input/审批卡/孵化面板/演化时间线/推演轨迹树/进化工厂面板/来源明细/设置页表单）
- [ ] `seed_data/event_types.json`：reply_token/thinking_start/plan_start/tool_start/review_card/suggestions/error + 孵化事件 + 时间线事件 + 重规划/子任务/推演/记忆召回/调优/vetting/进化事件 + device 事件（感知/控制留痕）
- [ ] `seed_data/graph.json`：入口 → 研究编排节点（返回 __plan__/__spawn__/__simulate__ 保留键）→ 工具流水线编排 → 结束（引用注册表节点类型，HARNESS 可改）
- [ ] `seed_data/tools.json`：起点领域工具声明（与 exec 执行体一一对应；权限分级 allow/review/deny + 网络策略 + 沙箱端点）+ OS 感知/控制工具声明（感知：screen_query/file_query/system_query；控制：launch_app/open_file/set_volume/set_brightness/notify/schedule，与 shell/ 执行器实现对应）+ `propose_mcp_mount` 挂载提案工具（对话式安装入口）+ 文件开发工具声明（file_read/file_write/file_edit，工作区目录沙箱端点 + 权限分级）
- [ ] `seed_data/rules.json` / `samples.json` / `templates.json` / `knowledge.json`：冷启动基线（基础校验规则 + 样例 + 模板 + 知识条目）
- [ ] `seed_data/workflow.json`：研究流程 WorkflowSpec（约束域声明）
- [ ] `seed_data/signals.json`：五类信号（pitfall/user_correction/insight/gap/repeated_root_cause）→ 蒸馏器映射
- [ ] `seed_data/tiers.json`：模型双挡位配置（main/router + 缺省回退）
- [ ] `seed_data/review.json`：评审/收敛配置（维度/阈值/轮次上限/web 验证钩子开关）
- [ ] `seed_data/memory.json`：记忆策略声明（PriorityRecallPolicy + 失效窗口）
- [ ] `seed_data/env.json`：环境声明（local/web_bridge/container——镜像描述 = 数据，含补丁链版本化形态）
- [ ] `seed_data/mcp_market.json`：MCP 市场目录（server 名称/来源/端点/凭据需求/风险档；出厂零预挂，示例含 web 抓取/搜索/文件系统 2-3 项）
- [ ] `tests/schema/`：JSON Schema 定义 + 校验脚本
- **验收**：schema 校验全绿；数据形态与引擎核心类型（AssemblyRecipe 17 字段/EventTypeSpec/KnowledgeEntry/WorkflowSpec）对齐；17 字段对应数据全部就位；ui_spec 布局树骨架与绑定通道清单按 §5.2 定稿；graph.json 节点/边集合与 workflow.json（WorkflowSpec 约束域）一致（防双源漂移）；**起点领域种子密度达标——样例库足以支撑首个 L2 验证通过，无 key 演示路径可跑通一次完整"喂资料 → 研究 → 孵化 → 沉淀"闭环**

### M1 Rust 执行件（可独立于引擎开发验证）

- [ ] `exec/Cargo.toml`：零外部依赖
- [ ] `exec/src/main.rs`：手写 JSON-RPC over stdio（照 `examples/ts_seed_pack/server.mjs` 协议先例）
- [ ] `exec/src/executors/` 首批执行体：采集（文本/URL 取回）、解析（结构化抽取）、校验（规则谓词）、评分（引用质量/交叉验证）、评审（维度打分/阈值判定）、蒸馏（信号→结构化知识）、变异（反思式变体生成）
- [ ] `exec/tests/`：cargo test——谓词与 rules.json/samples.json/signals.json/review.json 数据绑定不漂移
- [ ] `exec/tests/protocol/`：MCP conformance（initialize → tools/list → tools/call，喂 JSON 行，免引擎）
- **验收**：`cargo test` 全绿 + 协议 conformance 全绿（评分/评审/蒸馏/变异产物与数据绑定不漂移）

### M2 TS 前端

- [ ] Vite + React 工程（分层参考 text_forge_evo/frontend：renderer/components/domains/shared）
- [ ] `src/renderer/`：UIRenderer 契约实现，`ui_spec.json` 直渲布局树
- [ ] `src/components/`：机制通用组件——消息流、审批卡（review_card）、孵化面板、演化时间线（补丁链可视化，数据源 = inspect_* 五元工具快照）、推演轨迹树（simulate_decision 分支对比 + swap_branch 换选）、进化工厂面板（变异/防退化展示）、来源明细（检索/记忆/证据来源留痕）
- [ ] `src/domains/`：领域组件包按 manifest 清单加载
- [ ] `shell/` 桌面壳（Tauri：Rust 后端 + TS 前端）：托盘/系统通知/文件挂载授权 + `process_exec` 执行器注册（launch_app/open_file/system_query/set_volume/set_brightness/notify/schedule 七件，白名单、禁硬编码）+ 设备感知 server 挂载接线
- [ ] `shell/tests/`：执行器注册契约测试——工具声明 ↔ 执行器签名一致 + 权限/沙箱守卫断言（免真实桌面）
- **验收**：`ui_spec.json` 直渲（布局树/绑定通道/主题 token 按 §5.2 契约）+ 组件测试通过 + 壳构建通过 + 执行器注册契约全绿

### M3 接线闭环（产品种子成立时刻）

- [ ] `host/host.py`：Host 五件套（存储工厂/模型解析/审批策略/事件传输工厂/关停钩子）
- [ ] `host/recipe_loader.py`：只读 seed_data JSON → `AssemblyRecipe` 17 字段全部落值（seeds/harness_definitions/event_type_specs/ui 三层白名单/tool_wiring/vetting_static_hooks/vetting_l2_hook/approval_levels 全表/retrieval_sources/apply_targets/convergence_provider/on_reverted/graph_recipe）
- [ ] 通用图配方：注册 `tool_pipeline` + `research_orchestrator` 节点类型（经 GraphRegistries 数据形态解析建图）；MCP 挂载 `inkling_exec` → 工具进工具表 → 统一流水线
- [ ] MCP 挂载双入口：①设置页「连接」一键挂载（`mcp_market.json` 目录数据源）②对话式安装——声明式工具 `propose_mcp_mount`（"帮我装个插件 <地址>" → 地址解析 → McpServerConfig 数据推导（市场内落市场配置；Git/npm 推导 stdio 命令如 `npx -y <pkg>`，仅作提案不直接执行）→ vetting 静态钩子核对（清单一致性/命令白名单守卫）→ 审批卡预览（可 edit 改传输/命令，重走校验链）→ L2 批准 → 补丁链挂载可回退）；三传输闭环（http/stdio/in_memory——in_memory 嵌入式 server 工厂供宿主/开发者注入）；出厂零预挂；e2e 各一条 挂载/拒绝/回退/对话安装 用例
- [ ] 执行域装配：`RunOptions` 注入 plan_policy（loose/strict 两档各一用例）/max_plan_steps/plan_workflow（WorkflowSpec 约束域，越域失败断言）+ max_spawns/spawn_concurrency + evaluator（WeightedScorerEvaluator + review.json 打分配置）/branch_mixer/max_simulations/simulate_concurrency + checkpoint_keep 链压缩窗口 + budget（回合预算钩子：超限自动终止断言）+ max_node_retries/error_on_exception（异常策略：重试/跳过/终止三态断言）+ state schema（StateSchema reducer 注册表）
- [ ] 调配域装配：AssemblyConfig 五源统一预算（上下文/知识/工具/记忆/证据）+ 记忆源（MemoryStore + PriorityRecallPolicy + 失效窗口）+ 检索源（Retriever 注册表注入 retrieval_sources，可挂 embedding 向量化，可选 [llm]）+ 上下文融合钩子（失败自动回退断言）+ 域窗口投影/归档摘要
- [ ] 模型层装配：tiers 双挡位按挡位建链（main/router）+ fallback 链
- [ ] 工具安全纵深：权限分级判定（allow/review/deny + 网络策略）+ 文件/进程沙箱（写前快照/超时 kill）+ vetting（静态钩子 + L2 影子运行观察）+ 工具调配器按子任务动态组装（去重/轨迹留痕）+ `shell/` 执行器注册进工具表（走统一流水线 + 审批分级，首次越界强制 L2）+ 审批策略全姿势（单动作/合并卡/策略直过/超时 fail-closed）+ 决议经 interrupt 锚点重入（resume_run 样板）
- [ ] 环境装配：env.json → EnvironmentSpec → 提供器注册（local/web_bridge + `container_provider` **出厂落地**：ensure 幂等/run/destroy 幂等、镜像描述 = 数据走补丁链版本化与回退、安装经沙箱白名单 + 审计链、可销毁重建）+ PatchKind.ENVIRONMENT 补丁演化 + container e2e（声明 → 构建镜像 → 运行 → 销毁；无 Docker 机器显式标记跳过，实现仍出厂）
- [ ] 知识域深度：知识分层晋升（work→project→user 毕业机制，id 跨层稳定）+ 导出/导入可移植（跨部署迁移，与种子文件无关）+ 补丁链分支/rebase/截断用例 + 图指纹随 checkpoint 版本化断言（HARNESS 改图指纹变化/回退还原）
- [ ] 自指全钩子：9 类补丁 kind（ui/theme/tool/rule/knowledge/harness/event_type/environment/artifact）各一条 e2e 用例 + GuardedStorage 旁路写防护 + 审计 append-only + apply_targets 活跃态生效 + convergence_provider 收敛管制 + on_reverted 回退通知
- [ ] 构建管线：artifact 补丁 → builder 白名单沙箱构建 + 内容寻址产物 + 冒烟门禁 → vetting_l2_hook 部署前验证 → 可部署至 container 环境运行（隔离边界，重执行件安全落地的通道）
- [ ] AI 开发模式：工作区挂载点授权（设置页「连接」，file_ops 权限 allow/review + 沙箱写前快照）→ AI 经文件工具在工作区写代码 → 构建循环（写 → 构建 → 冒烟 → 失败信号回流 → 回合再改，经 __plan__/__spawn__ 并行子任务）→ 产物经 vetting 挂载（container/执行件）——e2e：AI 从零在工作区构建一个小型执行件（如迷你游戏原型）并挂载可用、可回退
- [ ] `tests/e2e/`：注入 → 挂载 → 回合（重规划/子任务展开/决策点推演 + swap_branch 换选）→ 孵化（蒸馏 → L1/L2/L3 三层闸门，各层放行/拦截用例 → 进化工厂防退化）→ 补丁（9 类含 HARNESS 改图）→ 回退 全链路 + 断线续流（recovery 锚点/增量重放/状态继承）+ 链压缩（checkpoint_keep 窗口断言）+ 调优（指标聚合/低分降权/参数快照回放）+ 领域长出（propose_domain_manifest 生成第二领域 → 审批 → 独立运行/回退）+ 机制覆盖矩阵
- [ ] 执行深度 e2e：编辑重放（对已结束回合注入修正 → 日志截断 + 分叉重放，历史可追溯）+ 预算钩子超限终止断言 + 异常策略三态 + 生命周期断言（boot 幂等/pause 拒新/stop 排空/引擎重建缓存）+ 知识晋升与导出/导入 + 安全剥离与 trace_id 断言（落库/日志脱敏 + 链路追踪）+ storage 三后端矩阵（memory/sqlite 必跑，postgres 冒烟可选）+ UI 三层白名单断言（未声明组件/绑定通道/主题 token 拒绝渲染，损坏 ui_spec 回落基线）
- **验收**：e2e 全绿（引擎 pytest 环境）+ 机制覆盖矩阵全绿（八域逐机制断言，无未用机制）

### M4 出厂

- [ ] 自检矩阵一键化（单个命令跑四项门禁）
- [ ] 机制覆盖矩阵随 e2e 产物输出（八域逐机制断言清单，出厂可审计）
- [ ] 根级 `seeds/` 登记 + 根 README「仓库构成」更新
- [ ] 发布说明：安装/运行/演示脚本（演示脚本照 `examples/ts_seed_demo.py` 模式，含桌面与 headless 双形态：无头一次性任务照 `dsh --profile headless` 模式）
- [ ] 领域长出演示：`propose_domain_manifest` 生成第二领域（数据组合：harness/视图/工具/规则）→ 分级审批 → 挂载独立运行 → 回退（"走向任何方向"的自指证明）
- [ ] 宿主件演示：桌面壳启动 + OS 感知/控制工具声明 ↔ 执行器注册契约全绿（真实桌面冒烟可选，演示脚本含审批/回退路径）
- [ ] 图可进化 live 验证：用 `.kilo/测试模型配置.txt` 真实模型——模型提案 HARNESS 改图 → 分级审批 → 图指纹变化断言 → 新图可运行 → 回退还原（真实 LLM 证明图拓扑真可演化，非 stub 断言）

## 7. 自检矩阵（出厂门禁）

| 层 | 检查 | 工具 |
|---|---|---|
| 数据 | seed_data 全 schema 校验 | JSON Schema |
| 机制件 | 谓词↔规则数据绑定不漂移 | `cargo test` |
| 执行件协议 | MCP conformance（免引擎） | 协议测试喂 JSON 行 |
| 装配 | 注入→挂载→回合→推演→孵化→进化→补丁→回退 | 引擎 e2e（pytest） |
| 机制覆盖 | 八域逐机制断言（执行/知识/调配/工具/事件界面/装配生命周期/构建/自指） | e2e 覆盖矩阵 + cargo test |
| 执行深度 | 编辑重放/预算护栏/异常策略/生命周期/知识晋升迁移/脱敏追踪 | 引擎 e2e（pytest） |
| 宿主件 | 执行器注册契约（声明↔执行器签名一致 + 权限/沙箱断言） | `shell` cargo test |

分工闭环：引擎闸门验数据，Rust 编译器验机制，样例 fixture 验绑定，覆盖矩阵验机制全用。

## 8. 依赖与风险

| 风险 | 对策 |
|---|---|
| AssemblyRecipe 17 字段白名单（架构门禁） | recipe_loader 只用核心类型与鸭子协议；M3 首日跑架构门禁测试 |
| 手写 MCP 与引擎 mcp_client 兼容性 | ts_seed_pack 已验证同构闭环，协议 conformance 先行 |
| 接线层复用性未知（仅第一版） | 先种子侧，第三个种子复用后评估提炼 |
| 引擎版本漂移 | manifest 锁定 engine_version_compat；e2e 随引擎 pytest 运行 |
| 全覆盖装配复杂度（17 字段 + 八域机制） | 分域增量验收：M3 按执行→调配→工具→自指顺序逐域点亮覆盖矩阵 |
| e2e 确定性（八域链路大量 LLM 调用） | 注入确定性 stub AsyncLLM（按脚本返回）；真实模型 live 评测（含图可进化验证，配置见 `.kilo/测试模型配置.txt`）走 tests/live 单独标记，不入出厂门禁 |
| 桌面壳跨平台构建/签名（Tauri 三平台） | shell 契约测试免真实桌面；三平台打包放 M4 冒烟，Windows 优先 |
| container e2e 依赖 Docker 环境 | 无 Docker 机器显式标记跳过（postgres 冒烟同款策略），provider 实现仍出厂落地 |

## 9. 总验收标准

1. 四律落位可审计：种子目录内除 exec/frontend/host/shell 外无机制代码；seed_data 全 JSON
2. 自检矩阵全绿（四项门禁命令 + 机制覆盖矩阵）
3. 引擎零改动（git diff 仅 seeds/ 与根 README 登记）
4. 演示闭环：冷启动 → 使用 → 孵化 → 可信度可见提升 → 补丁链时间线可看、可审批、可回退
5. 机制覆盖矩阵全绿：引擎八域机制每项在 e2e/cargo test 有明确断言，无未用机制
6. 领域长出闭环：propose_domain_manifest 长出第二领域并可独立运行、可回退——形态/方向演化的自指证明
7. 宿主件闭环：桌面壳挂载 + OS 感知/控制工具以数据 + 执行器注册落地、审批可回退
8. 执行深度闭环：编辑重放/预算护栏/异常策略/生命周期/知识晋升迁移 e2e 全绿——「执行即日志、状态即快照」的可审计性可见
9. 容器闭环：container_provider 出厂落地——声明/构建镜像/运行/销毁 e2e 全绿（无 Docker 环境显式跳过，实现不降级）
10. AI 开发闭环：工作区授权 → AI 文件开发 → 构建循环 → 产物挂载 e2e 全绿（小型执行件/游戏原型从零构建可挂载可用、可回退）

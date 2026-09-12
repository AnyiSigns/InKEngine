# InKling 执行模型设计：执行 × 作用域 × 通道

> 状态：**设计定稿（2026-09-09，当前执行主线）**；§十一/§十二 已于 2026-09-12
> （W1–W8 落地后）逐项回填，数字对码核实。
> 定位：InKling 执行语义的**权威稿**。替代 `agent_session_graph_design.md` 的
> 组装/图生命周期执行语义；旧文档保留为历史与迁移记录（其 §九 含新旧映射）。
> 维护纪律：设计稿定稿带「落地状态」栏；实现与设计差异须同步本文。
> 实验支撑：`ink-ts/live/experiment_river/run_river_v2.ts`（自治导航 + 生成即路由 +
> 直接收敛；kilo-cli gateway 免费模型，`reasoning_effort=low`）。

---

## 一、判定与范围

1. **组装不成立**：每次/每会话"拼一张执行图再执行"没有存在意义——执行是自治的，
   图是持续保留的资产，二者不需要在运行时结合。算法字段搜索只保证"能运行"，
   不保证"结构成立/好用"；模板作为唯一结构来源 = 利用陷阱（多样性死亡）。
2. **执行不需要静态拓扑**：节点可达性由"作用域定义 + 通道条件"动态判定；
   "图/节点/边"只是事后投影（展示/审计/解释）。
3. **本文只收敛执行与组织资产的机制语义**；产品定位语等以 manifest.json 为准。
4. 术语冲突处一律以本文 §九 术语表为准。

---

## 二、三个原语

| 原语 | 定义 | 内容 |
|---|---|---|
| **执行 Execution** | 执行单位（一次会话 / 子任务实例） | 上下文 + 任务 + 产物(载荷) + 作用域 + 轨迹（经过的 scope×channel 序列）；可派生子执行 |
| **作用域 Scope** | 执行身份定义（agent/协作者/子代理） | system prompt / persona / model / 可用能力 / 规则与权限 / 成本档 / 输入输出契约；目录资产，创建/注册（出厂、宿主、agent 自修改）时一次性设定，受控注册（审批/补丁链） |
| **通道 Channel** | 跨作用域/执行间的转场算子 | 形态：委托(1→1)、fan-out(1→N)、fan-in(N→1)、回传；提交契约：全量回传/择优回传/仅回传决策；条件：资格/审批/最大并行/成本池 |

补充约定：

- **汇聚点 = 唯一面向用户的收敛通道**：所有执行的最终产物只在汇聚点合成一次，
  从结构上杜绝"多执行体各答一次"。
- **自治调度 = 生成即路由**：作用域完成本职时在产物上声明"下一步去哪个作用域 /
  过哪条通道 / 收"，路由决策并入产出，不另做判定调用。
- **载荷即契约**：作用域声明消费/产出什么（形态 + schema + 归属），执行载荷按
  契约传递；旧产物不残留。

---

## 三、执行语义

1. **执行生命周期**：从入口作用域开始 → 当前作用域加工（可能调能力/工具）→
   按产物 `__next` 决定下一作用域或收敛 → 到汇聚点 = 会话收尾。会话 checkpoint
   恢复的是执行状态与轨迹，不是"一张图"。
2. **入口路由（取代分诊门）**：新会话选择入口作用域是**局部判定**，不是全局二分，
   不需要预先分类"闲聊 vs 任务"；判定错误由自治导航中途纠正。
3. **跨作用域（取代"可达性"）**：执行必须过通道进入目标作用域入口，不能凭空到
   达任意节点。隔离 = "只能走受控通道"，不是静态墙，也不是全连接。
4. **并行**：fan-out 派 N 路并行子执行（各独立作用域/轨迹/成本），fan-in 按提交契约
   归并。多协作者 = 多路并发子执行占用多个作用域，主执行组织归并。
5. **护栏只兜底**：步数/成本上限、作用域访问资格、审批。主成本控制不靠护栏，
   靠自治"何时收"（实验：寒暄 1 次调用收敛，无需固定流程）。

---

## 四、通道算子

| 维度 | 取值 | 说明 |
|---|---|---|
| 形态 | 委托(1→1) / fan-out(1→N) / fan-in(N→1) / 回传 | 回传 = 子执行结果返回父执行的转场（委托/子代理的返回，1→1 逆通道，是 fan-in 在 N=1 的退化、强调「归还」而非「归并」）；fan-in = 多路子执行归并（N→1，汇聚点与子执行归并的统一形态） |
| 提交契约 | 全量回传 / 择优回传 / 仅回传决策 | 对应旧稿通道名 spawn / 推演 / fork_trial；全/择优回传 = 结果回主执行，fork_trial 结果不回传、仅回传采纳/否决决策 |
| 条件 | 资格 / 审批 / 最大并行数 / 成本池 | 渗透语义：跨作用域转场必须满足条件 |
| 观测 | 通道事件（进入/通过/被拒） | 审计与组织档案数据源 |

**委托与子代理**：委托通道 → 目标作用域入口 → 子执行（独立 scope）→ 归并回传。
**递归/嵌套**：子执行内再 fan-out（委托更深作用域），无上限但受护栏。
**临时协作者**：动态创建**临时作用域**（无稳定身份）+ 通道（委托/召集），见下「临时作用域 vs 目录作用域」。

**临时作用域 vs 目录作用域（结晶前后的委托语义）**：

- 组织类工具（委托/召唤）的 `scope` 参数决定子执行的目标来源，分两类（§7.4.1）：
  - **目录作用域**：填目录里已注册的作用域 ID，后端装载其既有定义（身份/model/提示词/能力/契约），复用资产、有稳定身份可归因。
  - **临时作用域**：现场定义（无稳定身份），动态创建、用完即散，会话内不沉淀。
- 结晶 = 把反复出现的临时协作模式**转正**为目录作用域资产（受控注册/补丁链，§五）；转正后同一协作直接走**目录作用域**，不再现场重造。
- 转正的意义：临时作用域身份每次不同，组织档案无法跨会话归因；只有目录资产才有稳定身份，才能被择优（成败/成本统计 → 短路化/降权/下架，§六）。

**隔离试跑基座（双挂载）**：同一隔离试跑机制的两个用途——

- **① 执行期决策择优**：执行在决策点不确定时，fan-out 候选子执行试跑、择优回传；
  落选轨迹保留但**隔离**（不进主执行）。
- **② 演化采纳前验证闸**：组织资产变更提案落地主执行**之前**先隔离试跑验证（§六），
  试跑胜负不进主执行证据/组织档案（归因保险），过闸才进审批/补丁链。

两用途共用同一基座（子执行 + 独立 checkpoint + 事件/成本隔离），唯一差异是
作用域尺度（决策点局部 vs 组织提案级）与回传目标。这是高影响资产变更（影响所有
未来执行）能安全受控的关键——演化不裸奔上线。

---

## 五、作用域与目录

- 作用域定义 = agent/协作者/子代理的单一真源（persona/model/role/能力/权限/契约），
  存目录资产；受控注册（审批/补丁链/Guard），下架同通道。
- **出厂预置作用域目录（能力素材，非写死拓扑）**：见 §5.1——预置 main/planner/coder/
  critic/searcher/tester 与协作者/子代理；每项都受控注册，随证据择优保留/降权/下架（§六）。
- 作用域 model/persona 覆盖 = 作用域属性天然生效：执行进入该作用域即应用其
  persona/model（旧稿 P5-E 语义并入，无需单独 seam 设计）。

### 5.1 初始形态（出厂）

产品出厂/新实例出生时，预置**作用域目录（能力素材）+ 一张实验验证的默认先验图**，
作为可进化的起点（是起点，不是写死的固定拓扑）：

> 溯源（2026-09-09）：本节**推翻**旧稿 §9.4「初始目录 = 最小（main + 基础能力），
> 不预设 planner/reviewer 等角色链」的定稿——冷启动质量应集中在经实验调优的出厂
> 目录而非"从空摸黑"；预置的是"能力素材 + 验证过的先验"，默认先验图仍可被 §六
> 择优器推翻，故非写死拓扑。

- **作用域目录（能力素材，出厂预置）**：
  - `main` 主持人——入口判定、合成、仲裁、收敛；
  - `planner` 规划——拆任务 + 验收标准；
  - `coder` 编码——写增量 patch；
  - `critic` 审查——对照验收标准审查；
  - `searcher` 检索——代码索引/按需查询（规模化项目的能力素材）；
  - `tester` 测试——跑相关测试验证；
  - `协作者`——多协作者召集（blind 协奏 / open 圆桌，§7.4）的并行意见作用域；
  - `子代理`——委托目标（delegate 1→1）的专门子任务作用域。
- **默认先验图（实验验证的起点，非写死）**：
  - 编码任务：`main → planner → coder×N(fan-out) → critic → main → SINK`；
  - 简单/寒暄：`main` 直答（短路）；
  - 需多方意见：`main → 协作者×N(blind) → fan-in → main 裁决`；
  - 专门子任务：`main → 子代理(delegate) → 回传`。
- **工具**：能力类（bash/web/fs/检索/测试…）+ 组织类（委托/召集/fan-out/审查…）挂载；
  执行语义 = 能力类/组织类分层（§7.1）。
- **护栏/审批**：步数/成本/并行默认档 + 产品既有审批档位（auto/review/deny）。
- **组织档案**：空（从第一次执行开始累积）。

会话初始行为：执行进入 main → 自治调度（生成即路由）——寒暄直接收；编码/多步走
默认先验图；需更专门能力时动态创建临时作用域，反复验证后结晶为正式作用域资产（§六）。

设计理由：① 冷启动质量集中在出厂目录（预置的模型/提示/工具都经实验调优），而非
"从空摸黑"；② 预置的是"能力素材 + 验证过的先验"，不是"臆造且写死的角色链"；③ 默认
图是**可被择优推翻的起点**——择优器（§六）随组织档案对作用域/通道/先验短路、降权、
下架，图持续进化；④ main 是入口作用域，不是"组装产物"。

---

## 六、择优与进化（与 dsh 的分界）

- **择优对象 = 组织决策**：该不该委托 / 并行几路 / 派给哪些作用域 / 归并契约 /
  通道条件——不是图拓扑。
- **组织档案**：轨迹（scope×channel 序列）+ 结果（成败/成本）随事件流落库；
  跨会话对照单元 = 组织模式（scope×channel 组合）。
- **受控进化**：
  - 增/改/下架作用域定义；增/改/封通道条件；
  - 委托策略先验更新；常胜模式**短路化**（沉淀为直达作用域/直连）；
  - 低使用/高失败模式降权或下架（防资产无限膨胀）；
  - **采纳前验证（隔离试跑作安全阀）**：资产变更提案先经隔离试跑验证（§四 隔离试跑 ②），
    过闸才进审批/补丁链；试跑证据不进主执行档案；
  - 全部走审批 + 补丁链 + Guard；孵化（统计结晶）同一条受控通道。

---

## 七、会话内执行：通信、召集、model 控制、事件与展示

> 补充收敛（2026-09-09）：会话内部的运行时组织与控制细节。

### 7.1 形态 = 既有作用域的调度，不是新构造

- **系统提示词属于每个作用域/llm 节点**，且"一开始就设置好"：在节点被创建/注册时
  一次性设定——出厂/宿主创建，或 **agent 自修改添加 llm 节点时由 agent 设置**
   （受控注册/补丁链）。
- 系统提示词构成 = **boot 基线 + 自定义提示词叠加**（boot 不绕过）；该叠加是静态设定，非每轮推理叠加。
- 工作流 / 分级监督 / 协作者等"形态"**不新增系统提示词**：形态 = 执行按先验与
  主持人决策，在既有作用域之间调度出来的组织模式；运行时不为"形态"造提示词，
  跑的就是其构成作用域各自已有的提示词。
- **工具是统一触发协议**：模型能触发的都是 agent 工具（名称 + 参数 + 工具面挑选），
  没有与工具并列的第二套动作。区别在工具注册表内部——工具的执行后端分两类：
  - **能力类**（bash/web/fs/记忆…）：函数后端，结果返回，**留在当前作用域**；
  - **组织类**（委托协作者、召唤子代理、fan-out、审查…）：作用域/通道后端，
    执行体创建子执行、走通道，按归并契约返回（同 dsh 的 subagent=provider 工具）。
  - "收(SINK)" = 直接结束回合给出最终答复，不是工具。
- 协作者/子代理因此是**组织类工具的执行目标**：模型像调工具一样触发它，后端把
  "调用"兑现为"子执行 + 归并契约"，而不是兑现为"发请求等返回的普通函数"。

### 7.2 会话内通信与上下文（受控白板）

- 会话间隔离不变；会话内存在上下文空间，分两类块：**私有块**（默认仅本执行可见）、
  **共享块（白板）**（授权多方读写）。
- 三方通道：

| 通道 | 语义 | 权限 |
|---|---|---|
| 用户 ↔ main | 随时可输入/打断/注入 | 最高优先，不用申请 |
| main ↔ 各作用域 | 分配上下文（谁读哪块/写哪块）、指令、调度、仲裁 | main |
| 作用域 ↔ 作用域 | 受授权的共享块读写或定向频道 | 默认隔离，须授权 |

- **main = 主持人**：分配上下文即决定"谁读哪块、谁写哪块"；它同时看得到用户、
  白板与各执行状态，是唯一适合仲裁的角色。
- **块模型（白板授权）**：

| 块类型 | 默认写者 | 默认读者 | 说明 |
|---|---|---|---|
| 任务块 task | main | 被召集的协作者 | 召集时广播，只读 |
| 意见块 opinion | 各协作者 | 仅自己 + main（blind）；全体（open） | open 模式升级为共享 |
| 白板块 board | 协作者 | 全体 + main | open 圆桌的共享空间 |
| 结论块 conclusion | main | 全体 + 用户 | 归并/裁决产物 |
| 摘要块 summary | main | 用户（前台） | 子执行降级/失败的可见摘要 |

- 授权：召集时由 main 一次性声明「谁读哪块/写哪块」，随召集下发；运行中变更走 main 仲裁。
- 默认隔离：作用域间私有块互不可见，只能经被授权共享块/定向频道通信。
- 审计：每次读写记事件 `scope × block × read|write`，入事件带/组织档案。
- **块 → 物理输入（与既有调配机制的分层衔接）**：白板只定义**可见性授权与块归属**
  （谁能看），不定义**装载**（看多少/怎么装进本次调用）。每次作用域 LLM 调用仍走
  既有输入调配管线（输入调配 + 上下文调配器 ContextMixer + 按模型 cw 的压缩策略）：
  把「被授权块集（按可见性取 task/opinion/board/conclusion 等）+ 该作用域私有上下文」
  作为装配源统一预算分配、加权组装进 prompt——白板不绕过也不复制这套机制，只决定
  它的输入面。
- 协作块是新预算域：多协作者场景下「N 个意见块 + 白板块 + 任务块」需在调配预算分级
  中单列一域（产品侧三分预算先例见 multi_agent_design）；同块集因各作用域所用 model
  的 cw 不同可被裁得不同——压缩/预算随作用域 model 走（§7.5 model 解析链的既有实现
  件：engine 压缩阈值按模型档案 context_window 动态推算）。
- 归并/展示沿用产品侧先例：调配切片不进 messages 通道（调用级临时拼接）=
  §7.6「用户语境不被后台污染、归并只投影产物+摘要」；`scope × block × read|write`
  审计落既有审计/激活留痕通道，不另造。

### 7.3 动态形态与可见性（前后台）

- 形态（直收 / 工作流 / 分级监督 / 星型）默认由先验（档案）决定；会话中可被
  用户输入或中间结果改变，main 仲裁（fan-out 拆/并、加审查闸等），形态是活决策。
- 前台/后台判定与动态升降：
  - 前台：面向用户的最终产物、需要用户输入/审批、用户点名要看；
  - 后台：组织内部执行（规划/干活/协作/审查/并行），默认折叠可展开（scope/状态/成本）；
  - 后台失败/降级 → 归并时前台给摘要，可点入子执行复盘。
- **中断注入**：用户在任意子执行运行时发话 → main 决定"等 / 注入新上下文 / 转向 /
  中止改用"（对应中止/转向的运行时语义）。

### 7.4 多协作者召集：并行协奏 / 圆桌审议

#### 7.4.1 召集协议（组织类工具触发）

- 召集 = main 通过**组织类工具**触发（§7.1：委托协作者/召唤子代理/fan-out），不是第二套动作。
- 召集参数（schema）：`task`（任务描述）、`scope`（目标作用域：目录作用域 或 临时作用域）、`n`（并行数）、`mode`（blind | open）、`contract`（全量回传 | 择优回传）、`rounds`（open 轮次上限）、`budget`（成本池上限）。
- 输出：子执行树 + 归并产物（结论块）。

#### 7.4.2 blind 协奏（默认）

- 时机：任务可并行拆分、防从众、质量不依赖互见。
- 流程：main 写任务块 → fan-out N 协作者并行 → 各读任务块、写**私有意见块**（互不可见）→ fan-in **全量回传** → main 汇总裁决 → 写结论块。
- 隔离：意见块默认私有，同一白板也不互见；仅 main 全可见。

#### 7.4.3 open 圆桌（按需）

- 时机：质量关键、需互相挑战、用户指定。
- 流程：任务块广播 → 白板块共享、意见块升级为共享（互见）→ 协作者并行写、可回应他人 → 轮次上限 R。
- 收敛判据：R 轮内无新实质意见，或结论块被 ≥k 方确认 → 收；不收敛 → main 拍板或降级为"意见摘要 + main 结论"（不再加轮，成本封顶）。

#### 7.4.4 归并契约与裁决

- 契约：全量回传（默认，意见全收）/ 择优回传（只收最优，落选留轨迹隔离）。
- 裁决（main 汇总）：① 去重（语义重复合并）；② 冲突检测（对立结论显式标记）；③ 综合（生成结论块）；④ 冲突仲裁（优先用户/质量信号/先验）。
- 输入契约：意见块按输出契约 schema 校验，不符剔除并记失败。

#### 7.4.5 护栏与成本

- 并行上限 n_max（默认档，可被用户/先验调整）、圆桌轮次上限 R、意见块 schema 校验、成本独立计入各子执行、归并摘要合并到主执行。

#### 7.4.6 事件与展示

- 召集/归并/裁决事件入事件带；执行树显示协作者组卡 / 圆桌审议卡；后台折叠可展开（scope/状态/成本）；子执行失败/降级 → 前台摘要块，可点入复盘。

### 7.5 model 控制面（运行时唯一需要控制的参数）

- **候选空间 = 用户的 model 列表**（可带标签/成本/能力属性）；agent 只在列表内
  选择，不越过用户边界。
- 解析链：**本次指派(agent/主持人) > 择优先验(组织档案) > scope 默认(资产) >
  会话默认**。
- model 分配是择优对象：域×scope 用列表内哪个模型更省更好 → 自动调整分配偏好；
  用户改列表 → 空间变化，agent 重新适配。
- 压缩/预算随作用域 model 走：作用域解析到的模型决定该作用域调用的输入预算与压缩
  阈值（engine 压缩阈值按模型档案 context_window 动态推算）——同一被授权块集在
  不同 cw 的 scope 下可被裁得不同，属预期而非漂移。

### 7.6 事件、state 与展示

- **事件带标识**：`run_id / parent_run_id / scope / action`，组织为**执行树**。
- **state**：私有块 + 授权共享块；每执行 checkpoint 分层；归并只投影"产物（契约校验）
  + 摘要"；用户语境不被后台污染。
- **展示**：前台主执行（用户 / main 产出 / 审批）+ 后台可展开子执行卡（scope/状态/
  成本）。形态差异只影响卡内结构：工作流 = 步骤进度卡；分级监督 = 组织者 + workers
  组；协作者 = 组卡 / 圆桌审议卡。UI = 执行树渲染（折叠/展开/归组）。

---

## 八、图 = 投影

节点/边/图仅为**事后投影**：画出执行走过的作用域与通道，用于展示、审计、解释、
择优观察。一张根图内可有嵌套子区域（作用域组织结构投影），是子结构而非多张平级图。
执行不依赖静态拓扑。

---

## 九、术语表

| 词 | 指代 | 不指代 |
|---|---|---|
| 执行 | 执行单位（会话/子任务），上下文+任务+产物+作用域 | 图、线程骨架 |
| 作用域 | 执行身份定义（persona/model/能力/权限/契约） | 静态结点 |
| 目录作用域 | 目录里已注册的作用域 ID：装载既有定义（身份/model/提示词/能力/契约），复用资产、有稳定身份可归因 | 现场临时定义 |
| 临时作用域 | 现场定义（无稳定身份），动态创建、用完即散，会话内不沉淀 | 目录资产、跨会话归因 |
| 结晶 | 把反复出现的临时协作模式转正为目录作用域资产（受控注册/补丁链） | 会话内临时沉淀 |
| 通道 | 跨作用域/执行转场算子（形态/提交契约/条件） | 静态边 |
| 汇聚点 | 唯一面向用户收敛通道 | 每个执行体各自出口 |
| 轨迹 | 执行经过的 scope×channel 序列 | 图快照 |
| 隔离试跑 | 隔离试跑基座（双挂载）：执行期决策择优（择优回传）+ 演化采纳前验证闸（仅回传决策）；旧稿通道名「推演」= 择优回传 | 普通执行、正式证据 |
| 演化 | 离线受控资产变更（scope/channel/先验/短路/下架），基于主执行组织档案择优 | 隔离试跑（在线/试跑） |
| 组织档案 | 组织模式（scope×channel）统计 | 会话结构档案 |
| 投影 | 轨迹/作用域组织的可视化 | 执行依赖 |
| 组装 | （无此概念） | — |
| spawn | （旧稿通道名 = 全量回传；本稿废弃该词，动态创建临时作用域改称「临时作用域」） | 本稿动作名 |
| 工具 | agent 工具协议（统一触发）；后端分能力类（函数）与组织类（作用域/通道） | 与工具并列的独立动作 |
| 组织类工具 | 委托协作者/召唤子代理/fan-out/审查等：后端创建子执行并按归并契约返回 | 普通能力工具（无身份） |
| 主持人 | main：分配上下文、仲裁形态与前后台、裁决多协作者 | 单一调度算法 |
| 白板 | 会话内授权共享上下文块（多方读写空间；对私有块隔离） | 全局共享 state |
| 形态 | 既有作用域的调度组织模式（工作流/分级监督/星型/直收） | 独立运行时、形态级提示词 |
| 收(SINK) | 直接结束回合给出最终答复（非工具、非作用域、非通道） | 工具、作用域 |
| 先验图（默认先验图） | 出厂预置的 scope×channel 组织先验（实验验证的起点，非写死拓扑；可被 §六 择优器推翻） | 静态执行拓扑、图蓝图 |
| model 空间 | 用户的 model 列表（候选集；agent 只在其中分配） | 任意模型选择 |

---

## 十、实现影响与退役清单

**保留且仍有效**（旧稿已实现机制件不因执行语义变更而失效）：

- 受控通道 / 审批 / 补丁链 / GuardedStorage / 审计；
- 轨迹 / 事件流 / checkpoint（执行状态恢复）；
- 作用域 model/persona 覆盖 seam（engine `resolve_scope_llm` / `recipe.scope_model_llm` 装配接线位，已实现；`model:null` = 继承父作用域/会话默认）——§五「作用域属性天然生效」的实现件；
- guard / hygiene / 自续护栏；
- 隔离试跑基座（子引擎 + 独立 checkpoint 子链 + 事件/证据隔离）与提交契约语义
  （旧稿通道名：spawn=全量回传 / 推演=择优回传 / fork_trial=仅回传决策；§四）；

**退役 / 待重新定位**：

- path_assembler / `_forward_search` / 池候选 / 指纹缓存 / 图组装链路；
- per-session 骨架建图语义与 per-session 图落库；
- "模板目录 / 槽位填充 / 结构发生器"类 P5 对象（`agent_session_graph_design.md` §八）。

**待排期队列（占位，后续细化）**：

**排期边界（2026-09-09）**：第一优先级 = **多智能体协作**（委托/子代理、fan-out/fan-in 归并、多协作者召集 blind/open、白板受控上下文、归并契约）；**分级监督、工作流形态暂缓**（直收/星型保留，星型即 fan-out/fan-in 协作形态）。

| 阶段 | 内容 |
|---|---|
| P5-α | 作用域目录 + 通道条件数据面（受控注册） |
| P5-β | 组织档案 + 择优（scope×channel 统计、委托/并行模式择优） |
| P5-γ | 受控演化接口（增/改/下架作用域、改通道条件、短路化、下架） |
| P5-δ | 执行运行时（作用域装载、通道执行、汇聚点合成、护栏） |

---

## 十一、开放问题（逐项回填，2026-09-12 复核）

1. **已回填**：汇聚点最终产物 = 唯一结构化产物 `final_product`（`execution_runtime/run_result.ts`
   finish_result 汇聚点单点装配，task/attachments/degraded 内部键不进回复文本）；多轮历史
   携带 = `ExecutionRequest.session_context` 宿主摘要受控注入（W8-D 过渡收口：仅 main 根
   run 的 turn 消费、不进 RunState/checkpoint、不进子执行；`bridge/rounds.ts`
   historyTextFromDisplay 末 16 条/每条 ≤400 字/总量 ≤4000 预算宿主裁剪）。
   知识/RAG 记忆通道为后续演进面。
2. **已回填**：载荷按「载荷即契约」传递——fan-in 提交契约（全量/择优，`execution_runtime/fan_in.ts`
   adopted 条目）决定什么带过去；引擎内部键（`__next`/`__amend`/`__board`）经 clean_payload
   剔除防残留；私有块留在原作用域——跨作用域「带过去」的只有被授权白板块（grants 裁决）
   与载荷投影，checkpoint 序列化只随 RunState（`run_checkpoint.ts`）。
3. **已回填**：通道资格/审批 = `execution_runtime/channel_gate.ts`（转场审批 seam 三档姿态
   auto/review/deny + pending 决议 + `channel_approval_key` 掺指纹挂起卡，fail-closed）
   + `guardrails.ts`（步数/成本/并行护栏只兜底，配置面 = §十一#6）+ `run_transition.ts`
   转场段过闸；高影响资产变更另走采纳闸（#4）。
4. **部分回填**：择优信号 = 组织档案轨迹统计（scope×channel/链/模式三键聚合成败/degraded +
   steps/cost/tokens/ms 均值贡献数，`org_archive/org_stats.ts`；ingest 点 = run settle
   `trail_from(record)`，宿主 persist 快照 `org.archive` 普通通道）；成本定价 = 档案 cost
   聚合 + 护栏 max_cost。**未闭合部分 = model 维度信号，归 #11 单独未决**（档案键不含
   model，分配偏好无消费链）。
5. **部分回填（维持待裁断）**：§7.1 工具统一触发协议、能力类/组织类分层已实现（工具面真源
   plugins tools 42 + mcp 5，组织类后端 = host 工具执行体接线）；「作用域能力挂载 vs
   全局工具面挑选」现状 = `ScopeSpec.capabilities` 为声明面（契约校验与 convene 定义摘要
   消费），执行工具面仍按 run 级全局挑选（engine 池种子 + capability 记录），无按 scope
   裁剪工具面的消费代码——裁决保持开放。
6. **已回填（W8-C 参数固化）**：择优评估阈值 11 键（`model_config.org_evolution.evaluate_thresholds`，
   键表单一真源 = 引擎 `ORG_THRESHOLD_CONFIG_KEYS`，缺省 = 现实验值零漂移，非法忽略 +
   ignored 留痕 + 生效档回显）与白板护栏 `max_steps/max_cost/max_parallel`（同节
   `guardrails`，boot 注入装配缺省档）已固化为产品配置面；reasoning_effort 随回合覆写
   下发（W8-A `RoundModelOverride`）。**未成套登记项**（W8-C 报告 §3/§7）：圆桌轮次上限 R
   的装配缺省下发点（引擎 `ConvergenceConfig.rounds_cap` options 已在位）、结晶阈值配置键
   登记（评估函数已收 options）、`spawn_max_depth`。实现：
   `engine/src/core/controlled_evolution/evaluate_options.ts` + `hosts/lib/src/boot.ts`。
7. **已回填（§7.3）**：实现 = 引擎 `execution_runtime/run_loop.ts`（每轮 main 前
   `next_user_input` 消费并入输入 + `user_inject` 事件；`abort_requested` 轮边界
   fail-closed）+ `run_checkpoint.ts`/`run_transition.ts`（挂起卡 + 相位化续跑，已完成
   turn/子执行不重跑）+ 宿主 `bridge/execution.ts`（execution.inject/resume/branch）、
   `bridge/rounds.ts`（运行中 send = 注入 'injected' 回执；回合入口即主线）；转向 =
   注入 + 用户显式指令由 main 消化，不另设机制。
8. **已回填（§7.2）**：实现 = `engine/src/core/whiteboard/**`（授权三元组 + 五类块缺省、
   `amend_grants` 运行中变更走 main 仲裁 W6-close B）+ `execution_runtime/{run_loop,
   amend_runtime,board_runtime}.ts`（view 授权视图穿透装配、`__amend`/`__board` 写路径）
   + `core/context/block_source.ts`（块→物理输入，两预算域 + 按 model cw 裁切）。
9. **已回填（§7.4.6）**：实现 = 白板 summary 块（main 写、用户读）+ 主线回执
   `degraded_summaries`（`bridge/rounds.ts`）+ 执行树前台摘要与点入复盘
   （`renderer/src/shared/session/{executionIngest,executionTree}.ts`、
   `renderer/src/renderer/executionTree.tsx` IssueSummary，W7-E）。
10. **已回填（§7.4.3/7.4.4）**：实现 = `engine/src/core/collab/{adjudication,convergence}.ts`
    （裁决四步 + 冲突仲裁三档 user>quality>prior + 收敛三判据，触顶非共识交 main）+
    `hosts/lib/src/execution/convene.ts`（blind 单轮 / open 轮循环 + judge_round + 席位
    归一投影，W6-C2）。
11. **未决（登记现状，2026-09-12）**：model 分配成本-质量信号。信号源已有一半——档案侧
    有 cost/tokens/steps/成败聚合（`org_stats.ts`），模型侧有 model_archive 能力/清单面
    （`bridge/model_archive.ts` 快照）；**缺口 = 档案聚合键不含 model 维度（scope/pattern/
    chain 三键均无 model），且「域×scope 用列表内哪个模型更省更好 → 自动调整分配偏好」无
    写入/消费链**。§7.5 解析链现状只落三段：本次指派（`round_model`，W8-A 覆写 > 作用域
    资产 model > 会话缺省）→ 缺「择优先验(组织档案)」一环；另 (scope×provider) 归因漂移
    问题（fallback 链换模型 = 转移函数漂移）未解。闭合前置：档案 model 维聚合键 + 分配
    先验下发通道。

---

## 十二、落地状态

> 2026-09-12（W1–W8 全落地后逐项回填，数字对码核实；基线终检 = engine 244 测试文件
> /2592 passed/2 skipped、hosts/lib 42 文件/282 passed/0 failed、机制契约 31 项、
> 插件 146 = command 64 + tool 42 + ui_feature 32 + mcp 5 + endpoint 3；来源：
> vitest 双根 + `verify_mechanisms` + `sync_plugin_manifest --check`，7F 复核复现）。

| 项 | 状态 | 实现落点 / 差异 |
|---|---|---|
| §一 判定与范围 / §九 术语表 | 定稿（非实现项） | 组装路径已随 W7-B 全退役，本文判定与码一致（产品开关表七位、`INK_ROUNDS_ASSEMBLY_FALLBACK` 全链清零） |
| §二 三原语 + 补充约定 | 已实现 | 作用域 = `core/scopes/{scope_spec,scope_directory,scope_priors,prior_overlay}.ts`；通道 = `core/channels/{channel_spec,channel_directory}.ts`；执行 = `core/execution_runtime/runtime_types.ts`（载荷/轨迹/派生子执行）；汇聚点唯一产物 = `run_result.ts` finish_result；生成即路由 = `routing_next.ts`/`route_planner.ts`（产物 `__next` 并入路由决策）；载荷即契约 = `fan_in.ts`（契约归并 + 内部键剔除） |
| §三 执行语义 | 已实现 | `execution_runtime/{execution_runtime,run_loop,run_transition}.ts` 转场循环；会话默认回合入口 = `rounds.send` → execution 主线（W7-A 切换、W7-B 组装删除；run_id=`r:<thread>` 同线程共 `exec:` 链）；轨迹/checkpoint 恢复执行状态非图（`run_checkpoint.ts` 相位化）；并行 fan_out 子 run + fan-in 归并（`run_transition.ts` spawn_children 恢复感知）；护栏兜底 = `guardrails.ts` |
| §四 通道算子 | 已实现 | 委托/fan-out/fan-in/回传词表与转场在 `execution_runtime`；提交契约全量/择优 = `fan_in.ts`（仅回传决策语义随 fork_trial 旧链退役，决策留痕等价物 = `execution.branch` checkpoint 分叉，W8-D）；隔离试跑基座双挂载 = `trial_runner.ts`（执行期择优 + 演化采纳闸 `controlled_evolution/adoption_gate.ts` GATE_MANDATORY 强制先闸，试跑证据不进主档案） |
| §五/§5.1 作用域目录与出厂形态 | 已实现 | 出厂预置作用域种子（main/planner/coder/critic/searcher/tester/协作者/子代理）= `scopes/scope_directory.ts` `default_scope_directory_seeds`；默认先验 = `scope_priors.ts` default 集（`fallback_routing.ts` 消费、可被组织覆写）；受控注册 = 实体注册表 + EvolutionWriter/补丁链（`controlled_evolution/controlled_applier.ts`）；宿主装载冲突序 = 注册表优先→overlay 补缺→retired 过滤（`hosts/lib/src/boot.ts`）；model/persona 覆盖经 `resolve_scope_llm` seam 生效 |
| §六 择优与进化 | 已实现（W6-B/W7-C/W8-C 闭环） | 档案 = `org_archive/org_archive.ts`（settle ingest）+ 宿主快照 `org.archive`；择优四规则 = `pruning.ts` + `pruning_adapter.ts`；两桥命令 = `evolution.crystallize`（临时协作结晶，阈值 5/0.8）/ `evolution.evaluate`（三提案 apply_shortcut/downrank/retire_scope + keep 报告），均「强制隔离试跑闸 → 审批 → 补丁链受控落库 → 回执」；参数固化见 §十一#6；**未闭合** = model 择优（§十一#11 未决） |
| §7.1 形态 = 既有作用域调度 | 已实现 | 无形态级提示词（作用域资产单设 persona，注册/受控通道）；工具统一触发协议 = tools 面 42 工具声明真源 plugins，组织类后端 = host 工具执行体（`collab_request` 召集 + 委托接线）；「收」= 产出 `__next` 收 / final_product，非工具 |
| §7.2 受控白板 | 已实现 | `core/whiteboard/**`（块模型五类 + 授权三元组 fail-closed、`amend_grants` 运行中变更 = main 仲裁 W6-close B）；`execution_runtime/{run_loop,board_runtime}.ts`（view 授权视图穿透装配、审计经 `whiteboard_audit` 事件通道；`__amend`/`__board` 结构化写路径双层 fail-closed）；块→物理输入 = `core/context/block_source.ts`（协作/主持人两预算域、复用既有 ContextMixer 调配管线、按作用域 model cw 裁切——boot 生产闭包 W7-C 接线）；用户↔main 通道 = 会话回合面（rounds.send/注入） |
| §7.3 动态形态与前后台 | 已实现 | 运行中 send = §7.3 注入（'injected' 回执、排队至下一 main 轮，abort = fail-closed 收口）；后台失败/降级 → 前台摘要（summary 块 + degraded_summaries + 执行树 IssueSummary 点入复盘）；前后台 = 执行树卡折叠语义（W7-E/W8A） |
| §7.4 召集 blind/open | 已实现 | `hosts/lib/src/execution/convene.ts / convene_board.ts / convene_params.ts`：blind 单轮协奏 / open 轮循环 + `core/collab/convergence.ts` judge_round（三判据、触顶降级 main 拍板成本封顶）；裁决四步 + 仲裁三档 = `core/collab/adjudication.ts`；席位身份模型与 schema 门禁回退 = W6-C2 决策；席位间共享 board 块自 W8-D 起可由子执行 `__board` 自写；回执扩展 points/conflicts/rejected/convergence 进 `collab_request` |
| §7.5 model 控制面 | 部分实现 | 候选空间 = 用户 model 清单（models.config/role_pick + model_archive）；**解析链现状 = 本次指派（`round_model` 覆写，W8-A，provider/model_id 齐备强制显式失败不静默回落）> 作用域资产 model > 会话缺省——「择优先验(组织档案)」一环未落地（归 §十一#11）**；压缩/预算按作用域 model cw 走 = `block_source.ts` + boot `resolveScopeContextWindow`（缺档案 200k 兜底） |
| §7.6 事件、state 与展示 | 已实现 | 事件带 `run_id/parent_run_id/scope/action` = `run_loop` emit（RunEvent）；W8-A 实时转发（onEvent → JSONL FileEventsTransport + round_transports 观察链 → ws 增量执行树，同轮 round_id 就地替换）；展示 = 执行树（`renderer/{shared/session/execution*,renderer/executionTree.tsx}`，协作者组卡/圆桌审议卡）；state checkpoint 分层 = `exec:<run_id>` 子链；用户语境不被后台污染 = 归并只投影产物+摘要（回执投影） |
| §八 图 = 投影 | 语义已实现（旧形态已换源） | 组装图快照子面随 W7-B 退役（introspection snapshot_graph/graph.instance/renderer graphInstanceSnapshot/evolution_feed 图组成段）；轨迹投影现役形态 = 执行树（回执/事件流）；将来图形态审计从组织档案/RunEvent 新建，不复旧件（plugin_issues #38） |
| §十 实现影响与退役清单 | 已全落地 | 「保留且仍有效」清单在位（受控通道/审批/补丁链全家、checkpoint/轨迹、`resolve_scope_llm`、隔离试跑基座；edge_evidence 链路与 skill_crystal 容器 = W7-B §4 保留+标注）；「退役清单」执行完毕（path_assembler/_forward_search/池候选治理/指纹缓存/per-session 骨架/图组装链路，D 32+ 文件；契约 34→31、插件 159→144、开关表 9→7）；P5-α~δ 队列全部排完（W1–W5） |
| §十一 开放问题 | 已逐条回填 | 共 11 项见正文（2026-09-12）：#1/2/3/6/7/8/9/10 已回填并指向实现文件；#4 择优信号部分（model 维归 #11）、#5 维持待裁断；**#11 model 成本-质量信号 = 唯一未决项**（现状与闭合前置已登记） |

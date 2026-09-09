# InKling 图类型体系 + 池状态 + 「状态」页 + 会话级骨架 设计稿

> 状态：**设计定稿（2026-09-08），P1-P3 已实现，P4-A（engine 核心）已实现
> （2026-09-09），P4-B（host/工具面/UI/推演接线）待排期**。
> 实现以本文件为准，各阶段回填文末「落地状态」栏；实现与设计差异须同步
> 本文件（维护纪律：设计稿定稿带「落地状态」栏，参照
> `inkling/docs/multi_agent_design.md`）。
> 范围：ink-ts 全链路——engine 数据面（结点/边/agent 类型体系 + 废除 base +
> 会话级骨架与自进化续跑）+ 池状态读口（host bridge）→ renderer/hosts/web →
> plugins UI「状态」页。
> 定位：机制语义（组装/治理）不变，收敛「池/类型/图」口径；每层改动只增
> 可选字段、向后兼容，其它页面保持现状。

---

## 〇、背景与问题

现状四处语义混淆（详实代码依据）：

1. **两个「池」**：组装选图 = 结点类型注册表（`contract_pool` 遍历运行时
   `NodeTypeRegistry`，`kernel/path_assembler/_assembler_cache.ts:106-114`）；
   UI「结点池」卡却只投影池治理登记器（`pool_governance.log`，
   `hosts/lib/src/bridge/pool.ts`）——一个“有什么”，一个“治理流水”，
   造成“有图却池空”误读。
2. **游离池外的 base 图模板**：`pool_seed.domains[].graph`
   （`core/nodes/pool_seed.ts:42-55`）是独立整图数据面且不受池治理管辖，
   违背“回合恒组装、池只放构件”。
3. **类型维度缺失/隐式**：结点类别/终态无显式字段（`config.role='terminal'`
   字符串，`core/nodes/constants.ts:31`）；边无统一 kind（`Edge{target,
   condition?}` `core/graph/graph_types.ts:76` + 2 内置条件名
   `constants.ts:15-16` + 证据层 `policy` 三处分散）；实体无 role
   （`EntitySpec={id,label,persona,model,meta}`，`core/entities/entities.ts:47`）。
4. **UI 信息架构混乱**：主区「演化」页签不副实；「最近回合执行图」DAG 价值低
   且游离（`plugins/ui_features/evolution_feed/faces/ui/EvolutionFeed.tsx:167-196`）；
   机制监控被包成折叠壳（`plugins/ui_features/inkling.ui.mechanisms/spec.json`
   `group_card collapsed`）嵌套进演化页；MechanismView 七卡平铺无层次、无
   “目录态/激活态/当前回合图组成”。

---

## 一、大设计（语义收敛）

1. **一个池、两类构件**：池 = 结点（含 agent 节点）+ 边 的唯一集合。
   “结点/边/实体”三分取消——实体收敛为 `agent` 类结点（见 §二）。
2. **组装只从池选**：候选源 = 池 + 技能/证据/域输入源；图永远是“从池选+拼”
   的组装产物，无独立图模板数据面。
3. **废除 base 图模板**：移除 `pool_seed.domains[].graph` 与 `base_graphs`
   兜底 seam；无输入源最小可行回合 = 从池选**可自终止终态结点**（单节点）。
   池不变式：池内恒有 ≥1 个 active 终态候选，池治理**永不移除最后一个**。
4. **池状态 = 状态视图 + 治理行为**：治理机制不改名；「结点池」面板 = 用户
   观察面（目录态 / 激活态）+ 治理记录，三层同卡。
5. **组装 = 不确定性（定义）**：在**合法连通 + 契约可喂 + 终态可达**的约束下，
   同一目标存在多条由**可区分实例**组成的候选链，选哪条由证据分 / 探索预算 /
   LLM 草稿共同决定——**不确定的是选哪条，不是能不能乱拼**。
   - 组装的真实度不来自结点数量或排列自由，而来自 **契约分化 × 顺序编排**；
   - 实例须彼此**可区分**（不同 kind / 不同契约输出面 / 不同用途描述）才有信息
     量——契约同构、谁能替换谁的多个实例，组合空间再大也只是同一件事换壳
     （噪声，非组装）；
   - 顺序编排的合法性由契约门约束，选哪条的不确定性由证据/探索/草稿承载。

---

## 二、类型体系定稿

### 2.1 结点 kind（6 类）

`llm`（LLM/计算决策，与纯计算并作一类；config 含系统提示词）/
`tool`（确定性工具执行，感知=工具族）/ `router`（图节点，**占一个执行步骤**，
模糊/复杂判断选走向）/ `entry` / `end`（终态）/ `agent`（实体收敛，子图型：
config 含 persona/model/role）。

语义边界（定案）：**条件边 = 确定性规则连接（属图拓扑，不占执行步）；
router = 图节点（占执行步，模糊判断）——两者分开。**

### 2.2 边 kind（3 类）

`standard`（顺序）/ `conditional`（确定性 predicate 条件边）/ `loop`（回边：
目标为上游/自身，重复至退出条件）。`loop` 显式化便于回环识别与轮次预算。
边另带治理属性轴（policy：策略/统计）——不发明第三套。

### 2.3 实例信息模型

结点实例字段：`type`/`label`/`description`/`kind`/`contract`/`config_defaults`
（llm 含 system_prompt）/`flags`（终态/可回环）/`origin`（seed/host/agent/
governance）/`status`（active/archived/disabled）/`version`。

边实例字段：`from`/`to`/`kind`/`condition`（conditional/loop）/`description`/
`evidence`（policy/成功·失败计数/最近使用）。

agent 结点特殊点：`kind=agent`，config 携带 `persona/model/role`；执行 = 展开
内部子回路（子图仍为结点+边，不引入第三类构件）。

### 2.4 实体 → agent 结点

| 现状 | 目标 |
|---|---|
| `EntitySpec` 池外第三类（协作者目录） | 实体 = `agent` 类结点（子图型） |
| collab_request 召唤物化子图 | 召唤 = 挂 `agent` 结点并展开内部回路 |
| 无 `role` | `EntitySpec.role`（默认 `collaborator`，可演化） |

---

## 三、「状态」页 UI

- 主区「演化」页签改「状态」（文案层；内部 view id 保持 `evolution` 防大面积 rename）；
- 「最近回合执行图」DAG 废弃 → 「当前回合图组成」成分清单；
- 「机制监控」折叠壳拆掉，读取面直接入页；
- **⑤ 演化沉淀（孵化/补丁时间线 + 协作者目录）本次不做**。

布局：**① 回合概览**（回合 N·失败 M·失败率 X + 本回合激活 结点 a/边 b/实体 c）
**② 结点池**（结点注册总数 · 治理登记/判定/死结点候选 · 边证据边数/策略边 ·
实体注册 X/配额 200）**③ 当前回合图组成**（执行过结点清单 type+运行态；走过的
边 src→dst；召唤的 agent / 未召唤）**④ 机制装配**（组装链/契约门/canary/最近
候选；指纹缓存条目/查询/写库）。

---

## 四、现状 vs 设计差异

| 项 | 现状 | 目标 | 阶段 |
|---|---|---|---|
| 结点类型键 | llm_decider/tool_pipeline/vision_perceive | 键保留，加 kind/描述元数据 | P1 |
| 结点类别/终态 | 隐式 role='terminal' | 显式 kind + flags.terminal | P1 |
| 边类型 | Edge{target,condition?}+2 条件名+policy | kind：standard/conditional/loop | P1 |
| 实体 | 无 role | 收敛 agent + role | P1 |
| base 图模板 | pool_seed.domains[].graph | **废除** | P2 |
| 组装兜底 | base_graphs seam | 从池选终态候选 | P2 |
| 池读面 | 只有治理流水 | 目录态（注册总数）+ 治理态 | P3 |
| 演化页签 | 「演化」 | 「状态」 | P3 |
| DAG 执行图 | EvolutionFeed DAG | 图成分清单 | P3 |
| 机制监控嵌套 | inkling.ui.mechanisms 壳 | 拆壳直入页面 | P3 |
| 池目录只读口 | 无 | pool.snapshot.registry 段 | P3 |

---

## 五、全链路实施蓝图（每层改动明细，实现以此为准）

### P1 —— 引擎类型建模（engine 侧；只增可选字段，旧数据可反序列化）

**改动文件与语义（一律向后兼容：新增字段可选，缺省按旧语义回落）：**

1. `engine/src/core/node_registry/types.ts`
   `NodeRegistrationInit`/`NodeRegistration` 增可选：`kind?: string`（§2.1 六类）、
   `label?: string`、`description?: string`、`flags?: { terminal?: boolean;
   loop?: boolean }`。`to_dict()` 有值才输出；`from_dict()` 缺省不填。status/
   provenance 语义不变。
2. `engine/src/core/nodes/constants.ts`
   导出 kind 常量族（`NODE_KIND_LLM/TOOL/ROUTER/ENTRY/END/AGENT`）+ 内置类型
   的元数据表：`{type: llm_decider, kind: NODE_KIND_LLM, label: 'LLM 决策',
   description: '单节点内完成模型流式 + 工具回合', flags:{terminal:true}}`、
   `{type: tool_pipeline, kind: NODE_KIND_TOOL, label: '工具流水线',
   description: '消费 state.pending 工具清单；role=terminal 为终态',
   flags:{}}`。`vision_perceive` 元数据表项
   `{kind: NODE_KIND_TOOL, label:'视觉感知', description:'截图→结构化描述'}`。
3. `engine/src/core/nodes/pool_seed.ts` + `kernel/runtime/_runtime_node_registry.ts:38-49`
   种子声明与 `_seed_registration` 携带 kind/label/description/flags（登记行入池）。
4. `engine/src/core/graph/graph_types.ts` + `core/graph/graph.ts` + `graph_serialize.ts`
   `Edge` 增可选 `kind?: 'standard'|'conditional'|'loop'`。推断：`add_edge`→standard，
   `add_conditional_edge*`→conditional；显式 `add_loop_edge`/kind=loop（回边）时
   `to_dict()` 才输出 `kind:'loop'`（standard/conditional 由既有字段推导，
   **不回填序列化**，防破坏 graph digest 与既有测试/fixtures）。
5. `engine/src/core/entities/entities.ts`
   `EntitySpec` 增 `role`（默认 `'collaborator'`），`from_dict/to_dict` 可选。
6. gated docs：改动触及数据面/注册/实体语义后，同步
   `ink-ts/docs/subsystems/engine.md` 与 `component_data_endgame.md` 相关段
   （若描述“结点注册行字段/实体字段/边序列化”），并跑仓库根
   `tsx gate/src/check.ts` 确认无 gated 漂移。

**验收**：`vitest run --root engine`、`tsc -p engine/tsconfig.json`、
`node engine/scripts/verify_generated.mjs`、`tsx engine/scripts/verify_mechanisms.ts`；
新增/同步测试：node_registry 序列化往返（新字段可选）、graph 边 kind 推断与
loop 序列化、EntitySpec role 往返、_seed_registration 携带元数据。

### P2 —— 废除 base（engine 机制；依赖 P1 已完成）

1. `engine/src/core/nodes/pool_seed.ts`
   移除 `EngineDomainSeed`/`domains` 与 `_chat_base_graph()`；`EnginePoolSeed`
   只留 `enabled` + `node_types`。删除相应导出并在引用处收敛
   （`_runtime_assemble.ts`、`_runtime_node_registry.ts`、index 重导出、文档）。
2. `engine/src/kernel/runtime/_runtime_mechanisms.ts:390-407`
   `base_graphs` 兜底 seam 移除/改语义：无算法/技能/证据候选时的候选 = 组装器
   从 `contract_pool` 选一个 `flags.terminal=true` 的 active 类型生成单节点图
   （entry=exit=该节点，0 边）。不可从池取得终态候选 = 显式“无候选”结果
   （诚实空态，不臆造图）。
3. `engine/src/kernel/pool_governance/pool_governance.ts` / 相关 rules
   池不变式：死结点淘汰不得移除**最后一个 active 终态候选**
   （即池内 terminal 候选 ≤1 时该候选不判死）。
4. `kernel/path_assembler/*`、`_runtime_rounds.ts` 与相关 runtime/assembler 测试
   收敛 base 引用（凡断言 base 兜底/图模板处改为“从池选终态”语义）。
5. gated docs 同步（`engine.md` 池种子/base/兜底段）并跑 `tsx gate/src/check.ts`。

**验收**：`vitest run --root engine`（全量含架构门禁）、`tsc`；重点跑
`kernel/runtime`、`kernel/path_assembler`、`runtime_feedback_loop` 等原 base
相关测试改后语义；无 “base graph/engine.chat 模板” 残留字符串（grep 校验）。

### P3 —— 池状态读口 + 「状态」页 UI（hosts/renderer/plugins；可与 P1 并行）

依赖：engine `runtime.node_registrations()` **已存在**
（`_runtime_node_registry.ts:191`，返回 `NodeRegistration[]`）——P3 不阻塞于 P1/P2。

1. `hosts/lib/src/bridge/pool.ts`：`pool.snapshot` 响应增 `registry` 段
   `{available, total_count, active_count, types:[{type_name,status,provenance,
   executor}]}`（读 `runtime.node_registrations()`；无 = available:false）。
   **注：本文件的 registryView 已写入，实现者复查/补测试即可。**
   同步 `hosts/lib/test/bridge/*`（或对应 pool 命令测试）断言新字段。
2. `renderer/src/shared/backend/backendAdapter.ts`：`poolSnapshot()` 返回类型/
   投影处补 registry 段字段（若有本地类型定义）。`renderer/test/shared/backend/
   backendAdapter.observability.test.ts` 若对 snapshot 全等断言则同步。
3. `hosts/web/src/app/views/architecture/backend.ts`：`PoolSnapshotData` 补
   `registry` 段类型；`mockBackend.ts` poolData 补样例字段。
4. 插件布局/spec：
   - `plugins/ui_features/inkling.ui.evolution/spec.json`：children 去掉
     `inkling.ui.mechanisms` $ref，改直引 `mechanism_view`；
   - **删除** `plugins/ui_features/inkling.ui.mechanisms/` 整目录（拆壳）；
     删除前 `tsx plugins/scripts/verify_unload.ts --plan inkling.ui.mechanisms`
     确认无阻断；mechanism_view 已被 evolution children 引用 = 无孤儿；
   - `renderer/src/locales/zh.json` + `en.json`：`topbar.tab.evolution` 文案
     → 「状态」/「State」；
   - 重跑 `node plugins/scripts/sync_plugin_manifest.mjs`（spec 增删后生成器）。
5. UI 组件：
   - `plugins/ui_features/evolution_feed/faces/ui/EvolutionFeed.tsx`：删除
     DagRenderer/instance DAG 区块（约 167-196），改为 **「当前回合图组成」**
     清单：执行过结点（label/type + 运行态徽标 success/failed）、边
     （`src → dst`）、召唤 agent（无 = “本回合未召唤协作者”）。空态文案更新。
     同步同目录 `evolutionFeed.test.tsx` 断言（删 DAG 断言、加图组成断言）。
   - `plugins/ui_features/mechanism_view/faces/ui/MechanismView.tsx`：重组为
     §3 四区块层次（①概览横条 + 本回合激活、②结点池卡[含**结点注册总数**
     行 ← pool.snapshot.registry.active_count/total_count]、治理行、边证据、
     实体、③图组成（并入 evolution_feed 即可，卡片职责不重复拉取）、④机制
     小卡）。注意 component 间不重复拉取图数据（图组成在 evolution_feed 侧）。
     卡片名称保留「结点池」。
6. 测试/验收：`vitest run --root hosts/lib`、`vitest run --root hosts/web`、
   `vitest run --config plugins/vitest.config.ts`（evolution_feed/相关）、
   `tsc -p`（各包）、`tsx hosts/verify_host_spec.ts`、
   `tsx plugins/scripts/verify_unload.ts`（孤儿扫描）、
   `node plugins/scripts/sync_plugin_manifest.mjs --check`。

### 顺序与并行建议

- **P1 与 P3 无文件重叠**（P1=engine core；P3=hosts/renderer/plugins），可并行；
- **P2 依赖 P1 语义**（同动 pool_seed/组装器），在 P1 完成后执行，可与 P3 并行；
- **P4 依赖 P1/P2**（需登记行 kind/flags、组装兜底语义已就绪）与 P3（读口），后置；
- 每阶段各自跑验收命令，不跨阶段合并提交；各阶段独立 commit/PR 语义清晰。

---

## 五-b、P4 —— 会话级骨架 + 自进化续跑（设计定稿，待实现）

> 背景（对话定案 2026-09-08）：默认执行模型从「每轮回合级组装、即装即弃」
> 升级为「会话级骨架」。动因：(a) 回合级图无连续性载体，自修改没有可作用的
> 固定对象；(b) 复杂/多回合会话需要一张持续的图承载任务推进；(c) 自修改工具
> 诞生于「无组装时代」，在组装架构下语义需要更新。P4 不推翻 P1-P3 的机制，
> 只把「图」从回合尺度提升到会话尺度，并补齐进化→执行的自续缺口。

### 4.0 定位

- **会话级骨架 = thread 级执行结构**（可视作 plan/todos 的结构化升级）：
  会话开始（首轮）建立，回合沿骨架推进/扩展，不再每轮整图重建；
- 骨架是数据，可演进；**持久的是资产/池/统计（跨会话），会话级骨架承载
  会话期连续性，回合执行沿当前骨架走**——自修改定位因此不变（改资产+骨架，
  供下一轮/下一会话）。
- 骨架为空/首轮等不满足时，回落既有回合级单轮组装（兼容旧链路，防断链）。

### 4.1 会话级骨架的三个能力

| 能力 | 语义 | 现成原型 |
|---|---|---|
| **可走** | 回合沿骨架当前目标/入口推进（图内执行态游标） | 现有回合执行 + graph.instance |
| **可写** | 受控修改面：agent 声明式改骨架（目标/增删节点/边/召唤谁）→ 经组装器**局部重校验**（契约/可达/终态）后挂载；执行体只能来自池（宿主/内置/包），防运行时任意代码 | plan 任务结构编辑 + 补丁链受控写 |
| **可分** | 不确定转向先 fork 推演（simulation/spawn 对准会话骨架），验证后再决定主线迁移/替换 | simulation/spawn |

### 4.2 自修改工具语义更新（原「无组装时代」语义退役）

- **双写**：a) 会话内生效 = 对当前骨架的声明式修改（不手写执行体）；b) 跨会话
  沉淀 = 验证过的结构走补丁链入资产层（技能先验/边先验/实体变更）。
- agent 提案的永远是**声明与接口**（契约/目标/人设），执行体绑定由宿主/内置/
  包供应——「执行体只能来自池」不变。
- **进化即留存（不变量）**：会话内任何进化产物（新类型/新实体/新技能/新边
  先验/规则）**必须经受控通道持久化**（补丁链/GuardedStorage/EvolutionWriter）
  落资产层——不存在“专属本会话的临时资产”。会话内生效只是“持久产物立即被
  本会话引用”；会话/线程结束不丢失进化。会话级**骨架/游标/当前执行态**才是
  会话尺度数据（随 thread checkpoint 恢复），进化产物永远不是。

### 4.3 类型 / 边 / agent 的诞生边界（会话级下）

| 新增物 | 产生方式 | 审批 |
|---|---|---|
| 新实例/新边实例（组合池内类型） | 实例化 + 契约匹配自动成边 | 无（组装器校验） |
| 召唤已有 agent | 实体目录实例化进骨架 | 无 |
| **新类型 / 新 agent** | 缺口 → 声明式提案（契约/输入输出/人设）→ 闸门+审批 → 入池/实体目录 | **需**（宿主 vetting） |

### 4.4 热生效缺口 → 回合结束自动续回合（自进化续跑）

- **缺口**：进化发生在回合内、当前图已定，改完须等用户拉起新回合才生效 →
  「进化→继续执行」循环被用户手动打断。
- **方案**：回合结束状态带「已进化 + 续跑意图」→ 引擎自动发起下一轮组装
  （新资产已入池 → 新图立即可用，热生效成立）。复用既有**审批卡决议后续跑**
  语义（host `resolveReview` 续跑线程）。
- **护栏**（防自进化 runaway）：仅 agent **显式声明“要继续”**才续；单次用户
  输入触发的**自续链上限（≤N 回合）** + 总预算闸，超限即停、回落用户。

### 4.5 落地蓝图（P4 涉及层，待排期实现）

1. engine：thread 级骨架数据形态（会话级图 + 当前目标/游标）、回合结束
   「续跑意图」状态机与自续上限护栏、骨架修改的局部重校验入口（复用组装器
   契约门/canary，agent 改动不绕开校验）。
2. host/自修改工具面：面向会话骨架的声明式动作（改目标/结构/召唤）落地；
   进化采纳 → 回合结束自动续回合（复用 rounds 续跑通道）。
3. simulation/fork 对准会话骨架（可分能力接线）。
4. 与现状并存：骨架空/不满足时回落回合级组装；gated docs + 测试同步。

**验收（届时）**：engine `vitest run --root engine` + tsc；host/rounds 续跑
测试；骨架模式与回落模式双链路测试；gate 扫描。

### 4.6 P4.x 实现队列（对话 2026-09-09 追加）

**P4.1 —— 组装反路径锁定 / 探索预算**（已实现 2026-09-09）
问题：单节点终态兜底（`llm_decider`）每轮解出 reply 若被当作“强化信号”，
会形成确认偏误/exploration 死锁——未来组装必是它，新节点/新链永远无机会
被试用。既有机制（`cache_epsilon` 缓存抽样、cold-start `exploration_mode`、
边证据降级/顶替）只缓解缓存层，未覆盖兜底强化与无证据候选试用。
落地摘要：兜底零强化落在沉淀侧（FingerprintSettleHook 对 0 边单节点兜底
图不固化缓存，`skip_single_node` 可关）；无样本候选试用与连续顶选反垄断
落在组装候选层（`exploration_budget` 构造选项：candidate_trial_enabled/
candidate_trial_epsilon/CANDIDATE_TRIAL_MIN_SAMPLES、anti_monopoly_enabled/
anti_monopoly_window、recent_tops 跨轮窗口——运行时会话统计面，内存轻量，
可挂后续会话态持久通道）；缺省全关保守档（开启会以概率/确定性改变候选序，
破坏既有确定性断言，故默认关闭 + 显式配置开启）。接线核查结论与逐条行为
差异见对应实现批次报告。
实现三件套：
1. **兜底零强化**：单节点终态兜底命中不写正向 evidence、不固缓存（成功仅因
   “无更好”，不是“这条路好”）；
2. **无证据候选试用通道**：cold-start 探索须把**无样本候选**纳入试用池
   （而非永远被 evidence 分压过），试用结果落证据形成真实学习；
3. **连续顶选反垄断**：N 轮内同一指纹连续顶选且存在可覆盖目标但分低的次优
   候选时，周期性强制试用次优（候选层多样性预算，不只缓存层 epsilon）。
附接线核查：既有 `cache_epsilon`/`is_exploration_mode`/`cold_start_index`
是否已接“证据写入侧”（探索样本不污染统计、兜底样本不强化）。

**P4.2 —— 池种子多样化 / 内置执行体实现（范围已定 2026-09-09：方案 A + llm 统一继承）**
设计出的结点/边类型**不实现 = 没有**——补真实可执行的内置构件：
1. **P4.2a 内置结点执行体**：按 §2.1 六 kind 补真实执行体与契约（当前仅
   llm_decider/tool_pipeline/vision_perceive 有执行体；缺 router 判断结点等），
   entry/end 显式化语义与 loop 边执行语义验证；相应出厂池种子扩充（多结点/
   多边，含验证用链），用于验证组装与提供选择多样性。
   - **P4.2a-1（已实现 2026-09-09）**：router_judge 内置执行体（类型键
     `router_judge`、kind=router、元数据 label「路由判断」、非终态）+ 单次无
     工具 LLM 判断把目标 key 写入状态键 `_route_to`（未命中候选 = 显式空走向
     不猜测）+ `route:<key>` 条件边族注册面 + 出厂池种子扩充 + 「router →
     [llm_decider | tool_pipeline(terminal)]」验证用链（组装/分支执行断言）。
      无模型 = 空走向诚实收尾不崩溃；entry/end 核对结论：不造空执行体（entry =
      图入口字段、end = graph exits + tool_pipeline role=terminal 终态语义）。
      落地细节与六 kind 执行体分布见对应实现批次报告。
    - **P4.2a-2（已实现 2026-09-09）**：loop 回边与多目标 conditional 边执行
      语义验证 + 护栏核对（不改执行推进代码、不加机制件——核对结论：executor
      沿边推进只按条件存在性判定（静态边直取 / 条件边按声明序首个为真），边
      kind 是数据层标注不参与走向；显式 kind=loop 回边到祖先/自身经同一机制
      重复执行上游，失控回路由既有 RunOptions.max_cycle 逐节点访问护栏兜底，
      预算内合法回环不受误伤）。新增测试固化：kind=loop 回边到祖先重复执行至
      退出条件走退出边、失控回边回路按 max_cycle 截止（error 不挂死）、单节点
      自环条件驱动退出；多目标 conditional「仅命中走对应目标、全未命中走
      缺省/停」以 route:<key> 与 llm.pending_* 两条件族各覆盖一例。
    - **P4.2a-4（已实现 2026-09-09）**：agent 子图型执行体 + 实体目录收敛 +
      作用域 model 接线（批4：#9；承接 P4.2a-2「agent 留待后续批次」）。落地：
      kind=agent 引擎内置执行体（executor=agent，`agent` 类型元数据 + 登记路径
      register_agent_node_type）；图内 agent 结点 config 携带 `entity_id`，执行 =
      从实体目录取 EntitySpec（resolve_entity seam）→ 展开内部子回路——子作用域
      = 单 llm 结点回路（scope_type 缺省 llm_decider），persona 作该 scope 的
      system_prompt 自定义层（boot 基线在前语义不绕过），reply/消息经子作用域
      回流并入父状态（复用 run_subgraph 内联子图通道；与 spawn 的关系 = 同一
      子图展开基座的两个开关，agent 走同步单分支/全回流档，取舍见实现报告）；
      作用域 model override：实体 model 非 null = seams.resolve_scope_llm 解析
      （装配注入 scope_model_llm 接线位，引擎缺省 null = 不 override，引用实体
      model 而解析不可用 = 显式失败），model:null = 沿用父作用域/会话默认；
      递归深度护栏复用 spawn_depth/spawn_max_depth。出厂池不带具体实体 agent
      实例（实体目录即 agent 实例源；出厂实体清单与 live 场景验证留后续）。
    - **P4.2a-3（已实现 2026-09-09）**：出厂池实例多样化——按 §一.5
      「组装 = 不确定性」定义，实例须**可区分**（不同 kind / 不同契约输出面 /
      不同用途描述）才构成真实候选信息量；**不做**「同一执行体内核换 config 造
      N 条」的换壳多样性（契约同构、可互相替换 = 无信息量噪声）。落地形态：
      同类内核多条实例仅当 config 分化能体现为契约输出/用途差异才入池；结点
      实例按契约分化多条、边实例按 src→dst 语义 + condition/policy 差异多条、
      agent 实例按 persona/role 区分多条。随后以 live 多会话多回合观察验证：
      每轮图由哪些可区分实例与边组成、随目标变化而非恒同构。
      **机制前提（代码核实 2026-09-09）**：llm_decider 契约 input_schema=null、
      输出只落 reply（llm_decider.ts:220-231）——同类 llm 串链无字段对接，后写
      覆盖前写。要支撑 llm_planner → llm_reviewer → llm_main 的真字段链，需
      engine 机制增强：a) llm 内核 config 化字段 I/O（read_fields 并入提示、
      output_field 落非 reply 键，缺省 reply）；b) **实例级契约随 config 派生**
      （现 NodeContract 为类型级静态，组装契约喂给面按实例契约区分候选）。
      此两点是 P4.2a-3 实现的核心前提。
2. **P4.2b llm 结点系统提示词补位（定稿 2026-09-09；已实现 2026-09-09）**：llm
   结点（出厂/宿主创建/进化创建的所有 llm 类内核）的 system = **boot 系统提示
   词 + 自定义系统提示词，拼接成一份 system 消息**（boot 恒在前、不可变基线；
   自定义在后、用户/agent 可改）。
   - boot 只读基线放引擎装配 seam（`EngineNodeSeams`/box 增 boot 提示词，装配端注入
     `BOOT_SYSTEM_PROMPT`，core 零领域词不直接 import adapters/boot）；
   - **boot 不再进知识条目**（`build_boot_seed_entries` 的 boot_prompt 种子注入退役；
     kind 兼容保留与否实现时定并测）；
   - 用户/agent 修改对象 = 自定义 system_prompt（节点 config，可随补丁链演化），
     boot 不可由 agent 改；
   - 检索式知识注入形态可保留兜底（靠模型自觉），但不再是 boot 的唯一通道。

---

## 六、兼容约束与不变量

1. 所有新字段可选，旧登记行/旧图数据可正常反序列化并回落旧语义；
2. 图序列化仅 loop 显式加 `kind`，不改变既有 standard/conditional 序列化
   （防 graph digest/测试/fixtures 漂移）；
3. 实体收敛 agent 前，注册表与 collab 召唤链路继续可用（新旧并存）；
4. UI 无宿主/空读面沿用 degraded/available 空态约定，不白屏；
5. 池不变式：终态候选 ≤1 时不可被治理淘汰。
6. **进化即留存**：会话内进化产物必须经受控通道持久化落资产层，不存在
   “专属本会话的临时资产”；会话尺度数据仅限骨架/游标/执行态。
7. 执行体只能来自池（宿主/内置/包绑定），运行时（含会话骨架修改）不引入
   任意代码执行。

---

## 七、口径决议记录

1. 池只放结点+边；实体 = agent 类结点（子图型）。
2. 结点 kind：llm/tool/router/entry/end/agent；llm 与计算并作；llm 节点含系统提示词。
3. 边 kind：standard/conditional/loop；**条件边=确定性规则（拓扑连接）；router=图
   节点（占执行步、模糊判断）**——分开。
4. 具体结点/边必带描述与信息（实例层字段 §2.3）。
5. 「结点池」卡名保留；面板=目录态+激活态+治理记录。
6. 「状态」页=①概览+②结点池+③图组成+④机制装配；⑤演化沉淀 UI 本次不做。
7. base 废除；无输入源兜底=从池选终态候选；池恒留终态不变式。
8. UI 不展开类型详情前，结点池只展示结点注册总数。
9. 默认走**会话级骨架**（正常会话也走会话级）；回合沿骨架推进/扩展，不再每轮整图重建。
10. 自修改工具语义更新：**双写**（会话内声明式改骨架 + 补丁链沉淀）；原「无组装时代」语义退役。
11. 类型/agent 诞生：会话内组合新增（实例/边/召唤已有实体）自由；**新类型走缺口 → 声明式提案 → 审批 → 入池**；执行体来源受控（宿主/内置/包）。
12. 进化热生效缺口 → 回合结束带「续跑意图」**自动续回合**；护栏 = 显式续跑意图 + 自续链上限/预算闸。
13. 会话级骨架具备**可写**（受控修改 + 局部重校验）与**可分**（推演 fork）两能力；骨架空时回落回合级组装。
14. 组装**反路径锁定**：兜底零强化 + 无证据候选强制试用（探索预算）+ 连续顶选反垄断触发（P4.1）。
15. 出厂池种子**多样化**扩充（方案 A：实现六 kind 内置执行体），用于验证组装与选择多样性（P4.2a）。
16. llm 结点 system = **boot（恒在只读基线）+ 自定义（用户/agent 可改）拼接成一份**；
    boot 不再进知识条目；必带工具默认继承已实现（seams 注入集 immutable∪baseline∪thread）。

---

## 落地状态

| 设计项 | 状态 | 备注 |
|---|---|---|
| §一/§二 设计收敛 | 定稿 | — |
| §五 P1 引擎类型建模 | 已实现 | 结点登记行 kind/label/description/flags + 类型元数据表、edge kind、EntitySpec.role（2026-09-09） |
| §五 P2 废除 base | 已实现 | pool_seed 废除 domains/base 模板、组装兜底改从池选终态候选出单节点图、池治理终态不变式保护（2026-09-09） |
| §五 P3 读口 + 状态页 | 已实现 | pool.snapshot.registry 目录段 + 「状态」页（标签文案/图组成清单/拆壳直入/MechanismView 分层卡）+ 全链路测试同步（2026-09-09） |
| §五-b P4 会话级骨架 + 自进化续跑 | 部分实现 | P4-A engine 核心已实现：会话级骨架数据形态（thread 级图引用池内类型 + entry/exits/active_target/status，随 checkpoint state 落库恢复）+ 回合模型升级（首轮/骨架缺失/失效走组装建立、有效骨架沿骨架推进）+ 回合结束自续跑状态机与护栏（显式续跑意图 + auto_continue_limit 钳制）+ 骨架局部重校验入口（Runtime.validate_skeleton）+ 进化即留存强制面与测试（2026-09-09）； P4-B-1 host 侧接线已实现（2026-09-09）：产品配方默认开会话级骨架（thread_skeleton_enabled=true）+ 自续护栏（auto_continue_limit=3，PRODUCT_SESSION_DEFAULTS 可显式关调）、apply_patch 落地 → 回合 state 续跑意图（make_product_self_executor，_round_continuation={reason:'evolved'}）、validate_skeleton host 可调封装与挂载接线点（validate_skeleton_sketch / mount_skeleton_to_state）+ 测试；P4-B-2 已实现（2026-09-09）：骨架声明式 bridge 命令面（skeleton.get/skeleton.edit，经 validate+mount 唯一写口 + 草稿下一轮消费）+ auto 轮 UI 观察（graph.instance.auto_round/continuation_reason → 状态页「自动续跑」徽标）+ rounds.fork_trial（骨架 fork 到新线程试跑 1 轮，主线不动）+ fork 消息基线复制已实现（engine 公开投影 seam project_history_baseline：checkpoint 存储态消息链 → user/assistant 文本链 + 链首 system，tool 产物不重放；hosts fork_trial 注入试跑首轮前，试跑上下文完整）+ live 冒烟（run_live 5/5，真实 LLM）；agent 工具包面已实现（2026-09-09，批3 #1）：plugins/tools 新增三个 session_command 族 agent 工具声明（skeleton.inspect/skeleton.update/rounds.trial，映射 skeleton.get/edit、rounds.fork_trial 既有命令实现）+ hosts/lib session_command 执行接线（宿主注册自定义端点 + 声明式定义/执行体，web_search 同通道）+ route:* 出边条件预注册收敛（#8：skeleton.edit/mount 前从 router config.routes 预注册走向条件，注册失败=校验拒绝原因）；auto 独立计数留待后续批次 |
| §4.6 P4.1 组装反路径锁定 / 探索预算 | 已实现 | 兜底零强化（单节点终态兜底不固化指纹缓存）+ 无证据候选试用通道 + 连续顶选反垄断 + 接线核查（2026-09-09） |
| §4.6 P4.2 池种子多样化 | 已实现 | P4.2a-1（内置结点执行体首件 router_judge + 出厂池种子扩充 + 验证用链）已实现（2026-09-09）；P4.2a-2（loop 回边 + 多目标 conditional 边执行语义验证与护栏核对，测试固化于 executor_loop_edges / conditional_edge_branch）已实现（2026-09-09）；P4.2b（llm 结点 system 补位：boot+自定义拼一份；boot 退出知识条目）已实现（2026-09-09，见对应实现批次报告） |
| §4.6 P4.2a-3 出厂池可区分实例 + 字段 I/O + 实例契约派生 | 已实现 | llm 内核 config 化字段 I/O（output_field/read_fields + 保留键写护栏 + 只读投影）；实例级契约随 config 派生（derive_instance_contract，零漂移）；出厂池可区分实例（llm_planner/llm_reviewer/llm_main/router_plan_judge，executor 解耦 engine:llm_decider/router_judge，实例键独立）；出厂边先验 default_engine_seed_edges + 装配入口（recipe.seed_edges_enabled 缺省关）；组装候选图按实例 config 绑定执行体（instance_configs）；（2026-09-09，见 P4.2a-3 实现批次报告） |
| §4.6 P4.2a-4 agent 子图型执行体 + 实体收敛 + 作用域 model 接线 | 已实现 | kind=agent 内置执行体（executor=agent + 元数据 + register_agent_node_type 登记路径）；agent 结点 config 引用 entity_id → 实体目录取 EntitySpec → 沿当前图内联展开内部子回路（子作用域 llm/工具回合至收口，结果并入父状态；复用 run_subgraph 内联子图通道）；persona 作 scope system 自定义层（boot 基线在前）；per-scope llm override（resolve_scope_llm seam / recipe.scope_model_llm 装配接线位；model:null = 沿用父作用域/会话默认；解析缺失 = 显式失败）；递归深度护栏复用 spawn 护栏参数；（2026-09-09，批4：#9，见 P4.2a-4 实现批次报告） |

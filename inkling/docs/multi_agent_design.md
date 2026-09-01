# InKling 多 Agent 动态协作 设计稿

> 状态：设计定稿（2026-08-30），P1-P5 已全部实现（P4 实体层含前端闭环，
> P5 实体演化收口）——本文件为设计定稿 + 实施记录；落地现状与设计的
> 差异见文末「落地现状 vs 设计差异」。
> 范围：模型层 / 实体层 / 执行层 / 上下文层
> 定位：产品层（宿主）设计，机制全部复用 `ink_engine.core` 既有原语，core 仅增最小通用件。

---

## 〇、设计基线（对齐项目原则）

1. 机制通用、策略可插：机制在 core（零领域词），领域策略归宿主。
2. 一切皆数据：实体/路径/规则/知识/模型档案皆为数据，演化走补丁链。
3. 确定性编排 + 自主执行单元：确定性路由 + 自主 agent 节点。
4. 显式化 / 事件即协议：用户看全量（事件流），模型看精选（消息流）。
5. fail-closed：路由越界/窗口未知一律回落安全兜底。
6. 主打动态：默认单 agent，不固定团队；协作者按需召唤。

---

## 一、模型层

### 1.1 模型档案（单份、全动态、按模型）

`model_archive.sqlite`：每模型一条档案 `{model_id → context_window / multimodal / metadata / discovered_at}`。

- **来源**：提供方 `/models` 探测（`HttpModelsFetcher` + `parse_models_response`），解析
  `context_window`/`context_length`/`multimodal`；档案缺失按模型 id 兜底推断多模态、窗口归 200k。
- **单份权威**：所有通道（agent、协作者、内部 router/audit）共用这一份档案，全动态探测刷新。
- **唯一用户参数**：上下文压缩占比（默认 80%），不暴露具体 token 数。

### 1.2 窗口参数 = 按模型档案（废弃档位推断）

**任何 LLM 调用**的窗口相关参数，一律取自「该调用所用模型」的档案 `context_window`，
不做档位推断（`infer_compression_tier` 按 model_id 字符串猜档的路径废弃）。

| 参数 | 公式 | 示例（250k / 32k 小模型） |
|---|---|---|
| 压缩触发阈值 | `0.8 × cw`（档案有）；无档案 → `0.8 × 200_000` | 200k / 25.6k |
| 工具结果截断 | `0.05 × cw`，下限 4000 | 12.5k / 4000（下限） |
| 调配总预算 | 按 cw 分级分配（context/knowledge/tools/memory/evidence） | 随窗口缩放 |

- 小模型也按自己的档案条目取窗口，不因「档位」虚高；
- 档位只决定「哪个通道用哪个模型」，**不决定窗口参数**。

### 1.3 模型来源与绑定

- **提供方（厂商）**：apikey/base_url 配置 → `/models` 拉模型列表 → 模型目录；
- **agent/主模型**：对话输入框从已配置厂商直接选具体模型，**无默认、无档位**；
- **内部通道模型**：router（路由判定/蒸馏）、audit（评审收敛/L3 终审/vetting 影子）绑定内部模型，窗口同样按各自档案取；
- **协作者模型**：`{provider, model_id}` 引用，从模型目录解析（不受任何档位限制）。

### 1.4 模型节（设置页内，非主页面）

```
设置页「模型」节
├─ 全局策略区：上下文压缩占比  ████░░░░░░  80%   ← 唯一用户模型参数旋钮
├─ 提供方列表区：厂商卡片(状态点+编辑/删除)
│   ├─ DeepSeek ●        [编辑][删除]
│   ├─ moonshotai-cn ●   [编辑][删除]
│   └─ [+添加提供方][+添加自定义提供方]   ← 弹悬浮窗(apikey/base_url)
└─ 内部通道绑定：router/audit 模型（下拉勾选可编辑，留空回落主模型；
   main 不是设置项——由对话输入框携带模型，选什么跑什么）
```

- **首次进入 = 空态引导**：空态页「填入各提供方的 API 密钥即可使用其模型」+ 主按钮
  「+添加提供方」，配置完进入正常形态（非打断式弹窗）。

---

## 二、实体层（协作者）

### 2.1 EntitySpec（数据形态，EventTypeSpec 同构）

```json
{
  "id": "security_reviewer",
  "label": "安全评审",
  "persona": "你是安全评审专家…（独立系统提示词，不共用）",
  "model": { "provider": "moonshotai-cn", "model_id": "kimi-k2" },
  "meta": {}
}
```

- **无 tools 字段**：所有实体共享常驻必带集（`BASELINE_TOOL_NAMES` → collect_specs →
  每回合 tools）+ `search_tools`/`request_tool` 检索动态注册；`tool_pipeline` 权限门禁不变；
- 身份 = `id`（注册表键，唯一校验）+ `label`（展示名，`Message.name` 用）。

#### 2.1.1 身份的协议映射（name 不是模型引导机制）

协议现实（已核实）：

| 协议 | 逐消息 name | 说明 |
|---|---|---|
| OpenAI 兼容 | ✅ 支持 | `user`/`assistant` 消息可带 `name` |
| Anthropic | ❌ 无 | 消息对象仅 `{role, content}`；`metadata.user_id` 是顶层滥用检测字段，非发言身份 |
| Gemini | ❌ 无 | `Content` 仅 `{role, parts}`，role ∈ {user, model} |

设计结论：
- `Message.name` 是**引擎/前端/留痕数据**（进 checkpoint/事件/UI 渲染），不是模型引导机制；
- **模型侧「谁在说话」统一走每轮注入**（全协议通）：per-entity persona + 参与者清单/当前发言人
  （见 §4.1 L3 调配切片）——Anthropic/Gemini 上协作同样成立，不依赖 name；
- 适配器映射：`to_openai_dict` 输出 name（协议原生精度）；anthropic/gemini 适配器忽略该字段
  （协议结构性不支持，非设计取舍）；
- 前端发言人标签从 `Message.name`（事件/消息数据）渲染，与协议无关。

### 2.2 生命周期（复用既有机制）

| 阶段 | 机制 |
|---|---|
| 注册 | 实体注册表 + 补丁链版本化 |
| 创建/修改 | `propose_patch(kind=entity)` → 审批卡 → `apply_patch` → 注册表生效 |
| 演化 | `inspect_entities`（第 6 内省工具）→ 失败信号驱动变异 → 三层验证闸门 → 严格更优才替换 → 晋升（工作/项目/用户级） |
| 回退 | `revert_patch`（链尾单步） |
| 知识 | **单份共享** `KnowledgeSet`（工作/项目/用户三级，晋升 = namespace 迁移），所有实体读写同一份；专属经验靠来源留痕 + 可信度分级标签区分，不分割知识库 |

### 2.3 动态召唤（不固定团队）

- 默认单 agent（`graph.json` 现形态不变）；
- 主 agent 判断需协作者 → 调 `collab_request` 工具（声明式，执行体由宿主注入）→
  执行体把 EntitySpec 物化为 spawn specs（复用 `spawn_group_specs`/`assembly_candidate_specs`）；
- 路由校验 fail-closed：未注册实体 / 未声明边 / 超上限 → 拒绝回退主 agent；
- 权限门禁/审批/审计/观察继承 tool_pipeline（`collab_request` 挂 review 档 = 用户对话里弹卡确认）。

---

## 三、执行层（结点池 / 边 / 图）

### 3.1 实体 = 嵌套子图（结点池引用 + 内部边）

```
实体「security_reviewer」（entities.json 条目）
└─ subgraph_recipe = Graph 数据：
     nodes:  { intent_parse→pool, file_read→pool, review_material→pool, ... }  ← 引用结点池
     edges:  { intent_parse→file_read, file_read→review_material, ... }          ← 内部边数据
     entry / exits
```

- **结点池**：`registry`（声明式工具 + 自指工具 + MCP 工具 + agent 节点类型，`pool_governance` 治理）；
- **契约**：食谱引用结点类型名 == 工具名（`assembly_candidate_specs` 断言，未登记 = fail-closed）；
- **运行**：物化为 spawn 实例（`{thread}:spawn:{i}` 独立子链 + 事件落父链 + `graph_path` 归属）——
  实体运行 = 一条路径实例。

### 3.2 回合图（对话面）

- `graph.json`：`assembly_orchestrator → tool_pipeline ⇄ llm_decider → end`（默认单 agent 不变）；
- **三条路径（研究/开发/运维）已是「结点+边」数据**：`workflow.json` 三链 + `path_seeds.json`
  组装种子；agent = 选路径 + 执行 + 判断换路径/收口；
- 组装（PathAssembler）候选 = 图数据，可含实体子图；推演（simulate）分支比较「带不带协作者」；
- **进化学习只作用于数据**：路径/规则/知识/实体目录全部走补丁链。

### 3.3 机制复用清单

| 需求 | 复用机制 |
|---|---|
| 并行 | `spawn` / `fan_out`（隔离上下文并行，事件落父链） |
| 轮流/接力 | 共享消息流 + 每实体 persona 注入（顺序发言，消息流 append-only 串行） |
| 选择/评审 | `PathAssembler` 候选 + `review` / `score` 打分 + 收敛 |
| 权限/审批 | `tool_pipeline`（权限门禁→沙箱→挂卡→审计→观察） |
| 断线续流 | checkpoint 版本链 + 增量重放 |

---

## 四、上下文层（防膨胀）

### 4.1 三层分离

```
L1 事件流   全量 append-only（工具调用/事件/评审卡）→ UI/审计/回放，永不进 LLM
L2 对话消息流 LLM 可见收口：用户输入 + 主 agent 回复 + 实体成果摘要
            （continue_chain=True 续接；超 0.8×cw 摘要压缩）
L3 调配切片  每轮新鲜注入：知识命中/记忆召回/证据/上下文（预算分级，超预算裁剪）
```

- **共享 = 对话级**（L2 收口）；**实体工作细节 = 隔离**（spawn 子链 + L1 事件流）；
- **每轮 LLM 调用** = `[system/persona] + ...历史链(L2) + user(本轮输入 + 【本轮调配】L3)`；
  L3 调配切片内含「参与者清单 + 当前发言人」——模型侧身份引导，全协议通（§2.1.1）；
- **工具结果三通道可达**：活跃实体 LLM 回填（动态截断 0.05×cw）/ 事件流全量留痕 /
  子链 checkpoint 可回放；`result` 通道随 spawn overlay 回流父状态。

### 4.2 窗口参数全按模型档案（见 1.2）

压缩阈值、工具截断、调配预算都与「该调用模型」的真实 cw 挂钩，小模型不虚高；
上下文膨胀被结构性地挡在 LLM 上下文之外（事件流不混入消息流、实体工作隔离、历史压缩、调配预算上界）。

---

## 五、落地清单（分层）

| 层 | 改动 |
|---|---|
| **core**（机制） | `Message.name`（可选字段+序列化；`to_openai_dict` 输出，anthropic/gemini 忽略——协议无此字段，模型侧身份走每轮注入的参与者清单，见 §2.1.1）；`EntitySpec`（EventTypeSpec 同构：注册表+补丁链）；`PatchKind.ENTITY`；`inspect_entities`（上 SELF_TOOL_CONTRACT）；窗口参数改「按模型档案」：删 `infer_compression_tier`，`resolve_compression_min_chars` 兜底 200k、比例可调，新增 `resolve_tool_result_max_chars` |
| **宿主**（inkling_host） | `seed_data/entities.json` + loader + schema；`collab_request` 执行体（EntitySpec→spawn specs）；`graph_recipe.py` `restore_messages` 每轮注入调配块 + 工具截断按模型动态；模型选择接线（输入框从厂商选、`{provider,model_id}` 解析） |
| **前端** | 设置页「模型」节（全局压缩占比 + 提供方列表 + 内部通道绑定）；添加/编辑厂商悬浮窗；首次空态引导；`MessageStream` 按 `Message.name` 渲染发言人标签 |
| **新增种子** | `entities.json`（协作者目录，进 boot 装载） |

---

## 六、设计闭环（端到端一例）

1. 用户首次进入 → 空态引导添加提供方（如 DeepSeek）→ `/models` 拉取模型档案（deepseek-chat 窗口 200k）；
2. 对话输入框选 `deepseek-chat` 为 agent 模型；窗口参数按档案（压缩 160k、工具截断 10k）；
3. 用户任务 → `llm_decider` 判断需协作者 → `collab_request`（弹卡确认）→ 执行体物化
   `security_reviewer`（provider=moonshotai-cn）→ spawn 展开；
4. 协作者按自己模型档案取窗口，在隔离子链干活，工具结果回填自己（截断按 kimi-k2 档案），
   成果摘要回共享流；
5. 主 agent 汇总收口；事件全量落 L1 时间线可见；
6. 失败信号 → 蒸馏/实体变异 → 三层闸门 → 实体演化；成功经验进单份知识库，全员受益。

---

## 七、协作者设计：缺点与堵塞及解决

### 7.1 缺点 → 解决

| # | 缺点 | 解决 |
|---|---|---|
| 1 | Level 1 只是「隔离子任务」协作（spawn：并行干活+成果回流），非「同 thread 轮流发言」 | 双模式明确：**Level 1 = spawn 隔离**（P4 落地，零新机制）；**Level 2 = 共享流轮流发言**（agent_decider 节点 + 路由边，`graph.json` 数据承载，列为后续增量）——先落 Level 1，Level 2 是数据拓扑问题不是机制问题 |
| 2 | 上下文打包成本：主 agent→协作者打包不全→盲干 | 定义 **`collab_request` 最小打包契约**（见 §7.2 #6）：`{entity_id, task, context_refs[], constraints}`；`task` 必填，`context_refs` 引用 L2 消息 id（执行体取摘要随 spawn 入口状态注入），缺省不打包全量——信息保真与成本由执行体按契约裁剪 |
| 3 | 成本/配额无感知 | 护栏数据驱动：`collab_request` 挂 review 档弹卡时展示「协作者 × 预估调用上限」；per-entity `max_tool_rounds`（复用 llm_decider 护栏）+ 回合级 `max_collabs_per_round`（graph.json config）；前端召唤卡显示配额 |
| 4 | 模型侧身份靠注入（Anthropic/Gemini 弱于 OpenAI 原生 name） | 已接受并定稿（§2.1.1）：参与者清单 + 当前发言人作为 L3 调配切片**必带项**，全协议统一强度；name 只作 OpenAI 协议原生精度与前端渲染 |

### 7.2 堵塞 → 解决

| # | 堵塞 | 解决 |
|---|---|---|
| 1 | 前端基线不稳 | 前端已重做完成（2026-08-28）；实施顺序机制侧先行（P1/P3 core+host），前端改动（P2/P4）排后，逐期接 |
| 2 | EntitySpec 过架构门禁 | EntitySpec 数据形态入 core 时同步登记 `_RECIPE_TYPE_WHITELIST`；实施跑 `test_architecture_gate` 实测（entity/agent 非创作领域词，预期可过） |
| 3 | 模型档案覆盖率低（多数厂商不返回 context_window） | **本期不解**，档案缺失走 200k 兜底（§1.2）；后续补「厂商声明表/常见模型白名单」补齐档案 |
| 4 | 调配块进消息流的语义（与 add_messages 去重冲突） | **调配块不进 messages 通道**：它是「调用级临时拼接」——节点每次调用时由 `[system] + 历史链(L2) + user(本轮输入+调配块)` 现构，不持久化进 `messages`；checkpoint 与 continue_chain 只承载 L2 收口，零冲突、无去重负担 |
| 5 | 总预算三分耦合（历史+调配+工具结果可超窗口） | 定义**本轮输入总预算 = 0.8×cw**，三分上限：历史链 ≤ 50% 总预算（超限压缩折叠）、调配切片 ≤ 25%、工具结果累积 ≤ 15%、余量 10%；裁剪按此分级，优先级 = 调配切片 > 工具结果 > 历史（历史可压缩，前两者不可丢） |
| 6 | 协作打包规格未定 | 定稿 `collab_request` 契约：`{entity_id, task, context_refs[], constraints{max_tool_rounds?, output_shape?}}`；执行体物化 spawn 入口状态 = `{task, context_refs 摘要, entity.persona}`；缺省约束按 EntitySpec.meta |

---

## 八、实施计划

| 期 | 内容 | 落点 | 依赖 |
|---|---|---|---|
| **P1 引擎机制（✅ 已实现）** | `Message.name`（+序列化+openai 输出）；窗口参数按模型档案：`resolve_compression_min_chars` 兜底 40000→200k、ratio 参数化、删 `infer_compression_tier` 推断路径；新增 `resolve_tool_result_max_chars`（0.05×cw，下限 4000）；工具截断动态化（事件+消息流两处） | `core/llm/messages.py`、`core/context.py`、host `graph_recipe.py`、`host.py` | 无 |
| **P2 上下文调配修复（✅ 已实现）** | `restore_messages` 每轮开篇注入调配块：回合开篇消息 id = `round_input:{base_round}`（剥离 `-resume-*` 后缀防中断重入重复注入），add_messages 按 id 去重——跨回合新输入可达、调配切片每轮新鲜、工具循环续接不重复；参与者清单随实体层（P4）接入 | `graph_recipe.py` llm_decider `restore_messages` | P1 |
| **P3 模型层接线（✅ 全部落地，含多提供方 schema、协议全名与多卡编辑 UI）** | **P3-A 压缩占比旋钮**（ratio 参数 + `compression_percent` 落盘驱动）；**P3-B 按模型引用解析**（`resolve_model_llm` 提供方数组匹配 + collab `EntitySpec.model` 节点级覆盖）；**P3-C 前端契约修复**（`ModelArchiveSnapshot` 消费真实 `archives`，无档位）；**P3-D 回合级选模型**（Rust `RoundRequest.model` → Python `_round_model_override` holder 换入/恢复 → 输入框携带 `{model_id}`）；**档位链热更新**（`model.reload` 重建 tier_chains + 孵化/评审链）；**空态引导**（「填入各提供方的 API 密钥即可使用其模型」+「+添加提供方」）；**多提供方 schema**：`model_connection.json` 统一 `providers[]` 形态（Rust `project_flat_connection`/`read_connection_providers`/逐提供方嵌套深合并写 + Python host 三处读取 + 前端 model_section 读写 providers + probe 带 provider_id；旧 flat 迁移投影兼容）；**多卡编辑 UI**：提供方列表（多卡切换/添加/删除 + 主档模型摘要），vendor/custom_provider_id 随写随存忠实回显，厂商切换 adapter/label 跟随而 provider_id 稳定；**适配器协议全名**：`openai_compatible`（chat completions）/`openai_responses`（Responses，新适配器 `core/llm/openai_response.py`）/`anthropic_messages`（Messages），旧简称注册为兼容别名零迁移，前端厂商预设同步 + 增 OpenAI Responses 选项 | core + host + Rust + 前端 | P1-P2 |
| **P4 实体层（core ✅ + host ✅ + 生命周期 ✅ + 前端 ✅）** | core：`EntitySpec`+`EntityRegistry`+`PatchKind.ENTITY`+`inspect_entities`+守卫集合 `entities:`；host：`entities.json`+loader+schema+登记（22 件）+`EndpointType.COLLAB_REQUEST`+`collab_request` 工具（review 档）+ 宿主执行体（EntitySpec→协作者子图→ctx.spawn）+ 实体专属模型（`EntitySpec.model`→`resolve_model_llm`→llm_decider 节点级覆盖）+ 发言人身份（`config.name`→reply_token 事件 `name`→assistant 消息 `Message.name`）；**生命周期闭环**：`patch_path` ENTITY 分支（集补丁链 `entities/<id>`）+ `EntityApplyTarget`（落链即注册+save）+ `_restore_set_state` 重启恢复分支；**前端**：`InkTextMessage`/`InkStreamingMessage` 加 `name`，`ingestEvent` reply_token 透传 `payload.name`，`MessageStream.AssistantText` 渲染发言人标签 chip（协作者显示、主 agent 缺省无）——propose→审批→apply→注册表→召唤→发言人时间线全通 | core/host + 前端 | P1-P3 |
| **P5 演化收口（✅ 已实现）** | 实体演化闭环：`core/entity_evolution.py`（`EntityEvolutionPipeline`：tool_start 记忆 collab_request 调用参数 → tool_end 失败归因实体 → 按实体缓冲 → 回合收尾确定性变异（失败信号蒸馏为 persona「已知教训」块，教训指纹去重防膨胀）→ 三层闸门（L1 声明合法+教训增量注入扫描 / L2 结构一致 / L3 教训覆盖严格更优，复用 `KnowledgeGate`）→ `EvolutionWriter` kind="entity" 落位（补丁链+审计）+ `EntityRegistry.replace`；晋升 = 变异后连续 N 回合零归因失败 → 工作/项目/用户级（复用知识层级语义）；事件侧 signal_detected/distill_outcome/gate_verdict/entity_mutated/entity_promoted；Runtime 装配 ⑤c + settle/transports/emit 接线）；端到端验证：core 全绿（含 test_entity_evolution 12 件） | `core/entity_evolution.py` + `runtime.py` + `EntityRegistry.replace` | P4 |

---

## 附：改动点索引（现状文件锚点）

> 行号锚点随代码演进漂移，此处为「现状文件锚点」；以代码为准。

| 现状 | 位置 | 改动 |
|---|---|---|
| `TOOL_RESULT_MAX_CHARS = TOOL_RESULT_MAX_CHARS_FLOOR` | `inkling/.../inkling_host/graph_recipe.py:88` | 已改为按模型解析（`resolve_tool_result_max_chars`，0.05×cw，下限 4000） |
| `graph_recipe.py` 截断消费点 | 同上 | 改用解析值 |
| `infer_compression_tier` 字符串推断 | `ink_engine/core/context.py` | 已废弃删除，改按模型档案 |
| `COMPRESSION_DEFAULT_CONTEXT_WINDOW = 200_000` | `ink_engine/core/context.py:615` | 兜底 200k；`resolve_compression_min_chars`（:624）按档案取窗口 |
| `COMPRESSION_CONTEXT_WINDOW_RATIO = 0.8` | `ink_engine/core/context.py:614` | 可调项（全局占比，用户唯一旋钮） |
| `PatchKind` 10 类 | `ink_engine/core/self_proposal.py:42` | 加第 10 类 `entity` |
| `continue_chain=True` 回合入口 | `inkling/.../bridge.py` | 保留（历史连续性），调配每轮注入切片 |
| `restore_messages` 链空才注入调配 | `inkling/.../inkling_host/graph_recipe.py` | 已改为每轮注入「本轮调配」块（P2 落地） |

---

## 落地现状 vs 设计差异

P1-P5 全部实现后，与设计稿的现状差异（读者勿按旧路径理解）：

- **「模型 tab（主页面）」→ 设置页「模型」节**：模型管理不再是主界面
  tab，位于设置页注册表驱动浮层（key=`model`）；主区页签为 对话/演化/
  账本/轨迹/待办。
- **内部通道绑定可编辑**：router/audit 模型在模型节下拉勾选（可编辑，
  留空回落主模型）；main 不是设置页配置项——对话输入框直接携带所选
  模型（无默认、无档位）。
- **窗口参数**：`infer_compression_tier` 已删除；`resolve_compression_min_chars`
  （兜底 200k）、`resolve_tool_result_max_chars`（0.05×cw 下限 4000）
  为现行入口（`ink_engine/core/context.py`）。
- **实体层全闭环**：`entities.json` 出厂 3 条目（主 Agent + security_reviewer
  + research_analyst）、`collab_request` 工具（review 档弹卡）、发言人标签、
  实体演化（P5）——见 `mechanism_coverage_matrix.md` 十一节。
- **Level 2 协作（共享流轮流发言）**仍列为后续增量（数据拓扑问题，非
  机制问题），当前为 Level 1（spawn 隔离）。

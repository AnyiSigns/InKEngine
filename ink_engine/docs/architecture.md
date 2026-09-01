# InkEngine 架构总览

本文档描述引擎的层次边界、机制与数据的划分、主要数据流与纪律性约束。
配套阅读：`concepts.md`（概念体系）、`extensions.md`（扩展点目录）、
`hosts.md`（宿主接入）、`security.md`（安全模型）。

## 定位

InkEngine 是可嵌入的**受控自进化运行时**：进程内中间层——位于宿主
应用之下、OS 之上，宿主（web/CLI/桌面/stdio）嵌入引擎并实现五件套嵌入
契约；引擎不依赖任何应用框架、也不直接触碰平台细节（零平台依赖，隔离在
宿主适配侧）。
引擎只提供**执行机制**与**运行时身份**（Host 嵌入契约 + 装配数据 +
生命周期），不约束策略；web/CLI/桌面/stdio 皆为宿主之一，web 只是
宿主形态之一，不是引擎的绑定形态。「受控」= 一切演化经审批、可审计、
可回退，孵化/变异过三层闸门，运行时骨架不可被补丁链修改。

```
┌────────────────────────────────────────────────────┐
│  宿主（可替换）：InKling 智能体 / stdio / web / CLI …│
│  - Host 五件套（存储/LLM/审批/传输/关停）            │
│  - AssemblyRecipe 装配配方（全部数据）               │
│  - 策略注入（规则集/打分器/蒸馏器/审批表/预算）       │
├────────────────────────────────────────────────────┤
│  Runtime：进程级装配与生命周期（不可演化骨架成员）     │
│  状态机 + 在途 run 登记 + 引擎重建缓存               │
├────────────────────────────────────────────────────┤
│  Engine：单次 run 执行                              │
│  图执行/checkpoint 版本链/事件流/interrupt/         │
│  __plan__/__spawn__/__simulate__/多径/调配/预算/收敛 │
├────────────────────────────────────────────────────┤
│  机制原语：存储三后端/补丁链/规则引擎/知识集/闸门/    │
│  沙箱/权限/审批/自指演化/实体协作者/成长管线/         │
│  LLM 适配器/MCP 客户端/边证据/指纹缓存               │
└────────────────────────────────────────────────────┘
  领域深度归宿主产品层（产品自写规则数据 + 谓词 + 样例库，
  经知识集注入/装配配方直注）；机制层只带通用种子与 boot 自举基线。
```

## 分层原则

1. **机制层零领域内容**：`core/` 内不得出现领域词（架构门禁 13 词扫描，
   含注释与字符串）；领域校验语义 = 产品自写规则数据 + 注册谓词，
   谓词不注册 = 规则无法执行。
2. **机制层零宿主绑定**：`core/` 内不得出现宿主框架字样（fastapi/
   starlette/uvicorn/flask/django/text_forge_evo，大小写不敏感防绕行）；
   装配与执行只依赖注入式契约（Storage/LLM/Transport/InterruptPolicy）。
3. **机制通用、策略可插**：机制在内核（唯一 seam），策略在宿主/领域层
   注入——评审策略/调配策略/评估策略/调参策略全部可替换。
4. **一切皆数据**：图/计划/harness/工具/规则/知识/参数/分支/事件类型/
   界面描述/实体皆为可序列化数据；一切演化皆为补丁链（append-only、
   可回退、可分支、可审计）。
5. **装配动作是机制，装配决策是数据**：AssemblyRecipe 字段注解必须是
   核心类型或鸭子协议（架构门禁 29 项白名单文本级检查），宿主类型不得
   进入配方；换壳 = 换配方，机制层不感知宿主形态。

## 两个执行主体：Engine 与 Runtime

| | Engine | Runtime |
|---|---|---|
| 粒度 | 单次 run 执行 | 进程级装配产物与生命周期 |
| 职责 | 图执行/事件流/checkpoint/重规划/推演/spawn | boot/rebuild/pause/resume/stop |
| 状态 | 每次 run 独立（checkpoint 落存储） | 状态机 uninitialized→running→paused→stopped |
| 重建 | — | 配置/工具表变更才重建（缓存键 = 模型身份 + 存储身份 + 工具结构身份） |
| 入口 | `run()` 流式 / `ainvoke()` | `Runtime().boot(host, recipe)` 后取 `runtime.engine` |

Host 五件套（归属宿主：后端/路径/进程锁/配置/密钥/传输形态）：
`create_storage()` / `resolve_llm()` / `interrupt_policy()` /
`build_transport()` / `close()`。

AssemblyRecipe 22 字段（全部数据注入，见 `hosts.md` 字段表）：
set_id / seeds / harness_definitions / event_type_specs / entity_specs /
ui_spec / ui_allowed_channels / ui_allowed_components /
ui_allowed_theme_tokens / tool_wiring / vetting_static_hooks /
vetting_l2_hook / approval_levels / retrieval_sources / apply_targets /
graph_recipe / on_reverted / convergence_provider / run_options /
compress_policy / verify_retry_limit / emit_timeline_events。

## 单次 run 的数据流

```
用户输入
  → run(thread_id) 恢复解析（断线续流：快照 + 事件增量重放；或编辑重放截断分支）
  → 预算检查 → ctx.assemble（输入调配：上下文/知识/工具/记忆/证据，激活留痕）
  → 节点执行（reducer 合并增量；__plan__/__spawn__/__simulate__ 保留键不进状态）
  → interrupt 挂起？（InterruptState 随 checkpoint 持久化，注入后重入）
  → spawn/simulate 展开（独立子链 {thread}:spawn:{i} / {thread}:simulate:{i}，
    事件统一父链，落选分支保留轨迹树引用）
  → 终止判定（reply/stop/budget/error/cancelled）→ 链级 rebase 窗口压缩
  → checkpoint 写入（版本链 append，乐观锁防并发写冲突）
  → 事件流推送（transports；负载对齐前端协议，敏感键剥离）
```

## 演化闭环

- **知识**：轨迹 → 信号感知（五类）→ 蒸馏（复用优先）→ 三层验证闸门
  （L1 准入 / L2 样例全绿 / L3 目标筛选）→ 落库（补丁链 append）→
  分层晋升（工作→项目→用户）→ 进化工厂（失败率优先 + 反思式变异，
  变异体再过闸门防退化）。引擎侧 `GrowthPipeline` 自承载该闭环（默认开）。
- **实体**：失败信号归因协作者 → 确定性变异（教训指纹去重）→ 三层
  闸门 → 严格更优替换 → 晋升；写经 `EvolutionWriter`（补丁链 + 审计）。
- **自指（引擎形态）**：inspect_* 观察 → propose_patch 提案（10 类补丁
  kind，复用既有校验器）→ apply_patch 应用（分级审批 L0/L1/L2 + 补丁链
  append + GuardedStorage 旁路写拦截 + 审计）→ revert_patch 回退
  （链尾单步，存储层强制）；ConvergenceHook 前置收敛管制防重复提案。
- **调优**：回合指标聚合 → 低分反馈降权/失败率驱动机制参数调整 →
  参数快照随评估记录落库（历史推演可回放，标尺不动）。

## 安全纵深（详见 security.md）

工具调用不裸奔：`权限门禁（默认拒绝）→ 沙箱守卫（逃逸检测/写前快照）
→ 挂卡审批（超时 fail-closed）→ 执行 → 审计 → 观察`。
外部代码（工具/跨语言执行件）经 vetting 闸门（清单校验 + 静态钩子 +
影子运行观察模式，结果恒 untrusted）。敏感键在落库/出网/日志三出口
统一剥离。

## 架构门禁（tests/test_architecture_gate.py）

随 pytest 执行的本地门禁，防机制层腐化：

1. **领域中立**：core/ 零领域词（13 词，大小写敏感，含注释与字符串）；
2. **宿主中立**：core/ 零宿主框架字样（6 词，大小写不敏感）；
3. **配方白名单**：AssemblyRecipe 字段注解类型 ∈ 29 项核心类型/鸭子协议
   白名单（文本级检查，类体缺失即「门禁失守」）；
4. **装配字段对照**：装配字段清单与 runtime.py 声明逐一对应（新增/改名/
   删除字段须同步登记，防「文档-源码漂移」）。

门禁当前为本地命令（仓库未接入 CI 编排），是重写引擎时不可降级的
纪律基线。

## 边界（引擎不做）

- 不含业务逻辑（路由/域专才/门控分级配置在宿主业务层注册挂载）；
- 评审/评估/调参策略在使用方注入，引擎只规定协议形态与验证闸门；
- 声明式工具不生成执行代码（执行体经 executor 钩子注册）；
- 不做通用进程管理器（进程型工具以受限沙箱形态进内核）；
- 不做 MCP 服务器与外部生态实现（引擎经 mcp_client 消费 MCP 生态）；
- 不做多 worker 分布式执行（单进程 asyncio，部署层负责扩展）。

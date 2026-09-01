# InkEngine 墨引擎

可嵌入的**受控自进化运行时**（Controlled Self-Evolving Runtime）：进程内
中间层——位于宿主应用之下、OS 之上，宿主（web/CLI/桌面/stdio）嵌入引擎
并实现五件套嵌入契约，引擎不依赖任何应用框架、也不直接触碰平台细节
（托盘/沙箱实现/安装器等隔离在宿主适配侧）。引擎只提供执行机制与
运行时身份（Host 嵌入契约 + 装配数据 + 生命周期），不约束策略；web
只是宿主形态之一，不是引擎的绑定形态。当前宿主生态：InKling 受控自进化
智能体（inkling/）+ stdio 最小宿主。领域深度归宿主产品层：领域规则/
样例/谓词由产品自写并成对维护，机制层零领域内容。

「受控」是引擎的信任承诺：一切演化（图/规则/知识/工具/界面/事件类型/
环境/产物/实体/参数）都是补丁链数据，**每次变化经审批（分级 L0/L1/L2）、
可审计（append-only）、可回退（链尾单步）**；孵化与变异过三层验证闸门；
权限门禁/沙箱/审批/旁路写全环节 fail-closed；收敛管制防重复提案。
运行时骨架本身不可被补丁链修改（补丁链不能补丁自己）。

**核心思想：机制是引擎，知识是数据，变化是补丁，汇入靠调配。**
引擎只保留不可降维的机制骨架（图执行/补丁链/调配器/推演/验证闸门/
沙箱/审批/运行时装配与生命周期等），其余一切（图/计划/harness/工具/
规则/知识/参数/分支/装配配方）皆为数据；一切演化皆为补丁链
（append-only、可回退、可分支、可审计）；一切多源汇入（上下文/知识/
工具/记忆/证据）皆经调配器（加权、预算、组装、留痕）。

## 包结构

- `ink_engine.core`：纯机制引擎内核——图执行/checkpoint 版本链/事件流/
  interrupt/存储/补丁链/LLM/安全剥离/沙箱与审批/自指演化/实体协作者/
  成长孵化/运行时装配与生命周期（唯一 seam，API 即协议）；
- `ink_engine.seeds`：种子机制——通用种子恒注（机制基线）+ boot 自举
  种子（随带引导数据，装配配方直注）；
- `examples/`：可独立运行的示例（stdio_host 为最小非 web 宿主，
  另有调配/审批/沙箱/MCP 生态实验演示）；
- `docs/`：文档集（概念/扩展点/架构/宿主接入/安全模型/证据仲裁等）；
- `tests/`：测试（默认 2065 项，全量 2380 项，含性能门禁与架构门禁）。

## 安装

```bash
# 引擎零业务依赖；可选驱动与层
pip install -e .             # 内核（纯标准库）
pip install -e ".[sqlite]"   # sqlite 存储后端
pip install -e ".[postgres]" # postgres 存储后端
pip install -e ".[llm]"      # LLM 层（AsyncLLM/厂商适配，httpx）
pip install -e ".[mcp]"      # MCP 客户端会话（mcp SDK，惰性导入）
pip install -e ".[test]"     # 测试与 lint 依赖（pytest/ruff）
```

## 模块总览（ink_engine.core）

| 模块 | 职责 |
|---|---|
| `graph.py` / `executor.py` | 图定义 DSL + 执行循环（checkpoint 版本链/恢复重放/interrupt 注入/预算钩子/异常策略/编辑重放）；图 = 可序列化数据（round-trip + 指纹版本）；`Engine`/`RunOptions`（checkpoint_keep/plan_workflow/预算/护栏/装配） |
| `plan.py` / `spawn.py` / `simulation.py` | 运行时重规划（`__plan__` 下一跳编排，随 checkpoint 版本化）；子任务展开（`__spawn__`，独立子链 + 数据形态子图）；决策点推演-回溯-换选（`__simulate__` 分支独立子链 + Evaluator 评估 + BranchMixer 择优 + 轨迹树引用） |
| `multipath.py` / `path_assembler.py` / `fanout.py` | 多径执行与汇流裁决（Junction 汇聚 + 边证据写回）；路径/候选组装（只读规划/canary 试跑/候选选择，路径组装运行时）；`fan_out` 并发发散原语 |
| `edge_evidence.py` / `settle.py` / `fingerprint_cache.py` / `source_grading.py` | 边证据存储与纯算法评分（p̂·w_n·d(t)·τ，信任档晋级）；回合收尾 settle 钩子链（证据/失败审计/指纹/提案/策略边复审/池治理）；装配指纹缓存（上下文指纹 + 漂移失效）；来源可信度分级（web/dialog/model/user 单一事实源） |
| `rules.py` / `scoring.py` / `schema_validator.py` | 规则 DSL（约束/状态转换 + 内置谓词 + 样例库机制）；加权打分器（维度+权重+阈值）；Schema 声明校验（L1 准入机制件） |
| `knowledge_set.py` / `knowledge_signals.py` / `knowledge_gate.py` / `evolution.py` | 知识集封装（条目/补丁链演化/分层晋升/可移植/检索/注入适配）；五类信号感知与蒸馏（复用优先于生成）；三层验证闸门（L1 准入/L2 样例/L3 目标筛选）；进化工厂（反思式变异/防退化） |
| `skill_crystal.py` / `pool_governance.py` / `audit_log.py` / `ledger.py` | 技能结晶（SkillStore 命名缓存条目 + 可重建 sqlite 存储 + settle 自动结晶）；结点池治理（容量/驱逐/合并/预算规则，只注册）；append-only 审计（emit_audit）；回合账本合并（on-demand 廉价 LLM） |
| `memory.py` / `memory_extract.py` / `perception.py` / `bridge.py` | 记忆策略原语（MemoryStore/召回策略/非破坏性失效）；无缝记忆提取与冲突仲裁（账本 → 条目）；感知节点（视觉理解 + 双通道交叉验证 + 截图导出档位）；宿主接线桥（op channel：agent 可调 op 映射既有引擎管线） |
| `tuning.py` | 自适应调优（回合指标聚合/参数快照/低分反馈降权/L2 回归） |
| `assembly.py` / `context.py` | 输入调配管线（多源统一预算/激活留痕/一键开关）；上下文调配器（源元数据/预算分配/加权组装/融合钩子/域窗口投影与归档摘要） |
| `state.py` / `patch_chain.py` | 状态通道 + reducer 注册表；内容型补丁链（append/replace/delete + assemble/rebase/branch/truncate） |
| `events.py` / `event_types.py` | 事件信封（协议版本化 + 传输接口化 + 轨迹树 parent_step_id）；事件类型注册表（类型 = 数据，schema 校验 + 宽松发射折叠 + system 标记） |
| `ui_schema.py` | 界面描述数据原语（布局树 + 组件/绑定通道/主题 token 三层白名单 + UIRenderer 契约） |
| `storage.py` / `chain_rebase.py` | 通用存储服务（checkpoint 版本链/事件日志/结构化记录，内存/sqlite/postgres 三后端）；checkpoint 版本链压缩（窗口化有界化，rebase 非破坏性） |
| `recovery.py` | 断线续流恢复（恢复锚点收集/图版本指纹校验/状态通道继承/重放纪律） |
| `harness.py` / `declarative_tools.py` / `tool_orchestrator.py` | harness 声明式定义/注册表/补丁链仓库（版本回退可取旧图）；声明式工具（name/description/参数 schema + 强制权限 + 端点受限，执行体经 executor 钩子注册）；工具调配（确定性评分/跨工具去重/轨迹留痕） |
| `tool_pipeline.py` / `permissions.py` / `sandbox.py` | 工具执行流水线（提取→门禁→沙箱→守卫→分发→审计→观察）；权限门禁（默认拒绝/判定三路 allow/review/deny/网络策略）；文件/进程沙箱（逃逸检测/写前快照/超时 kill/禁 shell） |
| `tool_vetting.py` / `mcp_client.py` | 工具可信度闸门（清单校验/静态钩子/影子运行观察模式）；MCP 会话管理（http/stdio/in_memory 三传输，工具转换纯函数，vetting 仅放行 verified，按 server 粒度权限路由） |
| `builder.py` / `environments.py` | 构建管线（白名单沙箱 + 内容寻址产物 + 冒烟门禁）；环境管理（环境 = 数据，提供器 = 机制：local/web_bridge，安装/运行经沙箱白名单 + 审计链） |
| `interrupt.py` / `approval.py` / `review_card.py` | interrupt 挂起/注入重入（弹卡审批一等能力）；挂卡审批标准姿势（单动作/合并卡/策略直过/超时 fail-closed）；四类审批卡数据模型 + 门控分级注册表 |
| `registry.py` / `workflow.py` | 节点/边类型注册表（数据形态解析建图）；WorkflowSpec 声明式工作流 → 图转换（可执行的计划空间） |
| `security.py` / `logging.py` | 敏感信息剥离（组件化判定：精确集合 ∪ 后缀启发式 ∪ 末段凭据词 ∪ camelCase 边界，递归置空保留键，落库/出网/日志同规格）；结构化 JSON 日志 + trace_id 链路追踪 |
| `introspection.py` / `self_tools.py` / `tool_index.py` | 自指层观察原语（六个 inspect_* 元工具：图/规则/知识/界面/工具表/实体目录 JSON 快照，只读流水线 + 权限门禁 + 敏感键剥离）；自指层演化原语（6 契约元工具：propose_patch/apply_patch/revert_patch/propose_domain_manifest/search_tools/request_tool，随机制层走补丁链演化）；工具向量索引（动态注册检索，支撑 search_tools/request_tool） |
| `self_proposal.py` / `self_application.py` / `evolution_writer.py` | 自指层提案协议（10 类补丁 kind：ui/theme/tool/rule/knowledge/harness/event_type/environment/artifact/entity，复用既有校验器）；应用管线（分级审批 L0/L1/L2 + 补丁链 append + 审计 append-only + GuardedStorage 旁路写防护 + 链尾回退）；统一演化资产写协议（补丁链 append + 机制豁免活写 + 审计，harness/event_type/entity/memory/edge_tier/runtime_config 各写器） |
| `entities.py` / `entity_evolution.py` | 实体（协作者）注册表与数据形态（EntitySpec，`entities:<set_id>`）；实体演化闭环（失败信号 → 确定性变异 → 三层闸门 → 严格更优替换 → 晋升） |
| `growth.py` / `verifier.py` | 成长管线（GrowthPipeline：回合事件 → 信号缓冲 → 按需蒸馏 → 三层闸门 → 知识集落位，引擎自承载的孵化闭环）；输出验证器（VTM `__verify__` 门 + verify_retry_limit 违规驱动重做） |
| `runtime.py` | 运行时装配与生命周期（不可演化骨架成员）：Host 嵌入契约（存储工厂/模型解析/审批策略/传输工厂/关停钩子五件套）+ AssemblyRecipe 装配数据（22 字段，全核心类型白名单）+ Runtime 状态机（uninitialized→running→paused→stopped + 在途 run 登记 + 审批决议重入样板 + 引擎重建缓存） |
| `state_machine.py` / `tiers.py` | 通用状态机原语（转换 = 补丁，append-only 推导）；模型分层挡位（router/tool/main/audit 配置解析/按挡位建链/调用统计钩子） |
| `seeds.py` / `seeds/boot` | 通用种子恒注（模板 + 权重基线）；boot 自举种子（系统提示词/界面基线/事件类型/自举 harness/元工具契约清单，装配配方直注） |
| `llm/` | AsyncLLM 统一协议 + 自写 SSE 流式解析（零第三方 SDK，reasoning_content 透传）+ 内置协议适配器（`openai_compatible` 规范名/`openai_responses`/`anthropic_messages`/`gemini` + openai/deepseek/zhipu/moonshot/ollama 厂商别名）+ 工具 schema 转换 + fallback 链（重试/退避/备用切换/认证 fail-closed/取消穿透）+ 压缩/用量守卫 + embedding 接口（可选 extra `[llm]`） |

领域深度归宿主产品层：领域规则集/样例库/谓词由产品自写并成对维护
（样例库 fixture 全绿 = 新规则落库的非谈判项），以知识条目直接注入
（`seed_knowledge_set`）或经装配配方 `seeds` 直注；引擎只提供种子
机制（通用种子恒注 + boot 自举），零领域内容。

## 快速开始

```python
import asyncio
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.storage import create_storage

async def main():
    async def start(ctx):
        return {"count": 1}

    async def end(ctx):
        return {"count": ctx.state.get("count", 0) + 1}

    g = Graph(name="demo", entry="start")
    g.add_node("start", start)
    g.add_node("end", end)
    g.add_edge("start", "end")
    g.add_exit("end")

    engine = Engine(g, options=RunOptions(storage=create_storage("memory://")))
    events = []
    async for event in engine.run({}, thread_id="demo"):
        events.append(event)
    # 最终状态在 checkpoint（storage.get_latest_checkpoint("demo")）

asyncio.run(main())
```

这是最小 Engine 演示（单次 run）；完整宿主嵌入见下文 Runtime 契约。

## 更多示例

`python examples/novel_demo.py`（图执行/事件流/interrupt/补丁链）、
`python examples/context_mixer_demo.py`（调配器多源融合，零 LLM）、
`python examples/approval_demo.py`（挂卡审批标准姿势：单动作/合并卡/
策略直过）、`python examples/sandbox_demo.py`（文件/进程沙箱 +
工具流水线 + 审计）、`python examples/stdio_host.py`（最小非 web 宿主：
Runtime 三步挂载 + stdin 回合 + 终端决议回流，需 INK_LLM_* 环境变量）、
`python -X utf8 examples/ts_seed_demo.py`（MCP 生态演示：
Python 引擎 + TypeScript 执行件——JSON 知识条目注入 + MCP server
挂载调用，需 node）、`python -X utf8 examples/market_seed_demo.py`
（Cordis 插件市场挂载实验：市场取数 → apply_patch 写知识集，需 node）、
`python -X utf8 examples/mcp_real_demo.py`（真实第三方 MCP server
挂载：官方 server-everything，需 npm install）。

## 宿主嵌入（Runtime：引擎作为系统级运行时的嵌入契约）

嵌入引擎不再需要复制宿主装配配方——三步挂载（五件套 + 配方 + boot）：

```python
from ink_engine.core.runtime import AssemblyRecipe, Runtime, ToolWiring
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs

class MyHost:  # Host 五件套（归属宿主：后端/路径/进程锁/配置/密钥/传输形态）
    async def create_storage(self) -> Storage: ...      # 存储工厂（sqlite/内存/…）
    async def resolve_llm(self) -> AsyncLLM | None: ... # 模型解析（配置/密钥归宿主）
    def interrupt_policy(self) -> InterruptPolicy: ...  # 审批策略（直过/超时表）
    def build_transport(self) -> EngineTransport: ...   # 传输工厂（SSE 桥/JSON 行）
    async def close(self) -> None: ...                  # 关停钩子（资源回收）

recipe = AssemblyRecipe(          # 装配决策全部数据化（可校验可替换）
    set_id="default",
    seeds=[("boot", build_boot_seed_entries)],
    harness_definitions=[boot_harness_definition()],
    event_type_specs=list(BOOT_EVENT_TYPES),
    ui_spec=BOOT_UI_SPEC,
    ui_allowed_components=frozenset({...}),        # 界面三层白名单
    ui_allowed_theme_tokens=frozenset({...}),
    tool_wiring=ToolWiring(self_specs=self_tool_specs,
                           self_executor_factory=make_self_executor,
                           self_operation_of=operation_of),
    approval_levels={PatchKind.THEME: ApprovalLevel.L0},
    graph_recipe=lambda ctx: build_chat_graph(ctx.llm, ctx.tool_pipeline, ctx.tool_specs),
    # …vetting 钩子/检索源/apply 目标/收敛钩子/回退钩子按需注入
)

runtime = await Runtime().boot(MyHost(), recipe)   # 装配（幂等）
ticket = runtime.begin_run()                       # 回合登记（pause 拒新、stop 排空）
result = await runtime.engine.ainvoke({...}, transports=[host.build_transport()])
runtime.end_run(ticket)
await runtime.resume_run(thread_id, {"decision": "accept"})  # 审批决议重入样板
await runtime.stop()                               # 拒新 → 排空 → 关 MCP → 关存储 → 宿主钩子
```

契约要点：

- **Host 五件套**：存储工厂/模型解析/审批策略/事件传输工厂/关停钩子。
  决议回流通道不在协议内（web 的 resume 端点、stdio 的 stdin 循环是
  宿主自己的请求入口），Runtime 提供 `resume_run` 样板（挂起卡 → 锚点
  → 注入重入）两宿主共用；
- **AssemblyRecipe 是数据**（22 字段）：图配方/种子/harness/事件类型/
  实体规格/界面基线（spec + 通道/组件/主题白名单）/工具三路分发（内省/
  自指/声明式）/vetting 钩子/分级审批表/检索源/apply 目标/收敛钩子/
  回退钩子/run_options 覆盖/压缩策略/输出验证重试上限/时间线事件开关
  全部数据注入——换壳 = 换配方，机制层不感知宿主形态；配方字段类型
  只允许核心类型与鸭子协议（架构门禁白名单强制，宿主类型不得进入配方）；
- **Runtime 与 Engine 分工**：Engine = 单次 run 执行；Runtime = 进程级
  装配产物与生命周期（boot/pause/resume/stop + 在途 run 登记 + 引擎
  重建缓存——配置/工具表变更才重建，缓存键 = 模型身份 + 存储身份 +
  工具结构身份）；
- **自指元工具已内核化**：6 契约演化工具随机制层走补丁链演化，stdio
  等新宿主直接复用；宿主扩展（如种子沉淀）经 `SelfToolContext` 钩子接入；
- **外部生态只经 MCP 消费**：MCP server（含 Cursor 风格插件经标准
  MCP 服务器包装）以 `McpServerConfig` 挂载，工具进工具表走统一流水线；
  纯 Cordis 风格 TypeScript 插件需 MCP 适配包装后才能加载。

## 核心概念

- **执行即日志，状态即快照**：事件流 = append-only 执行事件日志；
  checkpoint = 快照；恢复/断线续流 = 快照 + 增量日志重放；
  编辑重放 = 日志截断 + 新分支。
- **补丁链**：变化 = 补丁（append-only），状态 = 基础 + 补丁链，
  取用 = 组装（full/base_only/partial），压缩 = 压扁（rebase，非破坏性）。
- **图即数据**：图 = 可序列化声明数据（节点/边以注册名引用），
  指纹版本随 checkpoint 落库——拓扑成为 LLM 可改写的输入；
  harness 仓库按补丁链版本承载图定义，回退可取旧图。
- **运行时重规划**：节点返回 `__plan__` 下一跳编排清单（节点序列/
  并行组/条件/spawn 项），引擎执行一段后重规划；计划随 checkpoint
  版本化——回溯决策点时计划与状态一起回到当时版本。
- **决策点推演**：关键决策点返回 `__simulate__` 分支清单，引擎将各
  分支作为独立子链推演（落选分支保留为轨迹树引用，可回溯换选），
  评估协议打分后择优提交主线（单选或跨分支组装，来源留痕）。
- **核声明式化**：校验/评审语义 = 数据（规则集/加权打分配置/Schema
  声明），执行机制 = 注册谓词 + 引擎；新知识必须过三层验证闸门
  （形式/安全准入 → 完整样例 → 目标筛选）才允许落库。
- **知识集孵化**：知识 = 补丁链数据（append-only 可回退），信号感知
  蒸馏沉淀新规则（复用优先于生成），进化工厂反思式变异防退化，
  工作→项目→用户分层晋升，导出/导入可移植。
- **种子基线**：通用种子恒注（默认模板 + 调参权重，最小可用空壳，
  幂等、只读基线）+ boot 自举种子（系统提示词/界面/事件类型/harness，
  装配配方直注）——机制基线随引擎，领域深度归宿主产品，随使用继续
  成长（知识集孵化）。
- **工作流约束域**：`WorkflowSpec` = 用户预编排的「可执行的计划空间」
  （节点/边集合）；`__plan__` 须落在工作流约束域内（宽松域自由选序 /
  严格序按工作流边序执行，RunOptions.plan_workflow 注入）。
- **自适应调优**：回合指标聚合（失败率/评审分/收敛轮数）+ 低分反馈
  降权 + 参数快照随评估记录落库——调参不改变历史推演的可回放性。
- **interrupt**：节点内 `await ctx.interrupt(key, payload)` 声明中断点，
  引擎持久化中断状态并挂起；外部注入值后从该节点重入（弹卡审批）。
- **事件即协议**：节点 `ctx.emit(type, payload)` 产出事件流，负载直接
  对齐前端协议（step_id/round_id/parent_step_id），无框架事件中间层；
  事件类型本身 = 数据（EventTypeSpec 注册表，schema 校验 + 宽松发射）。
- **界面即数据**：界面描述 = 布局树数据（组件/绑定通道/主题 token
  三层白名单），随装配配方注入，前端同名渲染组件消费。
- **输入调配管线**：每次 LLM 调用前多源统一调配（上下文+知识+工具+
  记忆+证据），统一预算分级分配 + 激活模式留痕 + 一键开关回退旧路径；
  确定性层零 LLM 调用，融合钩子按需升级（失败自动回退）。
- **运行时身份**：Runtime = 进程级装配与生命周期（Host 五件套嵌入
  契约 + 装配配方数据 + 状态机 + 在途 run 登记 + 审批决议重入样板）——
  web/CLI/桌面/stdio 皆为宿主之一，嵌入门槛从「复制装配样板」降到
  「五件套 + 配方三步挂载」；装配动作是机制（不可被补丁链修改），
  装配决策是数据（宿主可换）。
- **自指演化**：观察（inspect_* 六元工具）→ 提案（propose_patch 10 类
  补丁，含 entity）→ 应用（分级审批 L0/L1/L2 + 补丁链 append + 审计）→
  回退（链尾回退）——引擎自身形态随机制层走补丁链演化，不随宿主壳漂移；
  GuardedStorage 拦截演化资产直写，旁路写 fail-closed；收敛管制钩子
  防重复提案（冷却/冻结显式拒绝）。
- **实体协作者**：EntitySpec 数据形态（注册表 + 补丁链版本化，`entities:`
  守卫集合）——多 agent 协作是受控自进化的组成部分：默认单 agent，
  `collab_request` 按需召唤，实体沿失败信号变异、过三层闸门、严格更优
  才替换（entity_evolution），主 agent 不固定团队。
- **成长管线（孵化）**：GrowthPipeline 引擎自承载——回合事件 → 信号
  分类（五类）→ 按需蒸馏 → 三层验证闸门 → 知识集落位，默认开、
  后台静默沉淀；技能结晶/结点池治理随回合收尾 settle 钩子自动执行。
- **工具安全纵深**：权限门禁（默认拒绝）→ 沙箱守卫（逃逸检测/写前
  快照）→ 挂卡审批 → 执行 → 审计 → 观察，全环节机制化装配；声明式
  工具强制权限声明、端点受限（http_fetch/process_exec/file_ops/mcp/
  web_search/collab_request/task_manager 七内置 + 注册表扩展）；出网
  走网络策略沙箱（unlisted_policy deny=硬拒 / review=审批即网关，
  流水线默认 review）；外部工具经 vetting 闸门（清单/静态钩子/影子
  运行）后才进工具表。
- **测试时专才化**：生成 → 评审 → 校验 → 收敛（不微调权重），
  web 验证钩子按需触发。

详见 `docs/concepts.md`（概念体系）、`docs/extensions.md`（扩展点目录）、
`docs/architecture.md`（架构）、`docs/hosts.md`（宿主接入）、
`docs/api.md`（公开 API 速查）、`docs/security.md`（安全模型）、
`docs/evidence_arbitration.md`（记忆整合仲裁）。

## 测试与质量门禁

```bash
pytest                     # 单测全绿（默认 2065 项；含架构门禁，排除性能门禁与 live）
pytest -m benchmark        # 性能门禁断言（checkpoint 写入/事件吞吐/补丁组装/压扁，6 项）
pytest --benchmark-only -m benchmark  # 精确基准统计（pytest-benchmark）
POSTGRES_TEST_URL=... pytest -m postgres  # 真实 postgres 后端冒烟（3 项）
ruff check .               # lint（E/F/W/I/UP/B/C4/SIM/RUF 规则集）
```

全量共 2380 项（默认 2065 项 + 性能门禁 6 项 + live 309 项；live 需
`INKENGINE_LIVE_*` 环境变量）。

验收基准：checkpoint 写入 <10ms、事件流吞吐 ≥500 事件/s、
100 补丁组装 <5ms、rebase <10ms（本地实测：0.94ms / 千级 eps / 90µs）。

架构门禁（tests/test_architecture_gate.py，随 pytest 执行）：机制层
core/ 零领域词（13 个词含注释与字符串）、零宿主框架字样（6 个词，
大小写不敏感防绕行）、AssemblyRecipe 注解类型白名单（29 项文本级
检查）、装配字段清单与源码声明逐一对应。门禁当前为本地命令，仓库
未接入 CI 编排（无 .github 配置）。

## 运维说明

- **存储 schema 不迁移**：引擎表结构随版本演进，既有库升级后启动期
  自检会给出明确指令——删除库/表后重启（`DROP TABLE checkpoints,
  event_log, records;` 或删除 db 文件），历史数据不保留（引擎定位：
  不承诺存量数据兼容）。
- **日志**：引擎遵循标准 logging 语义（不抢占宿主日志体系）；需要
  开箱即用的 JSON 日志时由宿主显式调用 `configure_engine_logging()`
  （examples/ 已调用）；trace_id 经 contextvars 贯穿单次 run 全链路。
- **凭据**：敏感键（api_key/token/secret/password 等）在落库/出网/
  日志三处统一剥离（置空保留键结构），LLM 配置与 MCP 会话的
  headers/env 不出现在 repr 中。

## 边界（引擎不做）

- 不含业务逻辑（路由/域专才/门控分级配置在宿主业务层注册挂载；
  沙箱/审批为机制原语，规则与策略配置属业务层）；
- 评审/评估/调参策略在使用方注入（规则集/打分器/蒸馏器/变异策略由
  使用方提供，引擎只规定协议形态与验证闸门）；
- 声明式工具不生成执行代码（只声明 name/description + 参数 schema +
  权限 + 端点类型，执行体经 executor 钩子注册，重路径边界不变）；
- 不做通用进程管理器（进程型工具以受限沙箱形态进内核：白名单 +
  超时 kill/退出码/输出截断/环境清理，默认拒绝兜底）；
- 不做 MCP 服务器与外部生态实现（引擎经 mcp_client 消费 MCP 生态；
  纯 Cordis 风格 TypeScript 插件需 MCP 适配包装）；
- 不做多 worker 分布式执行（单进程 asyncio，部署层负责扩展）。

## License

MIT（见 LICENSE；pyproject license 字段同标）。

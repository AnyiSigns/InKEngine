# InkEngine 墨引擎（engine-core + seeds）

可嵌入的自进化运行时（Self-Evolving Runtime）：位于库之上、OS 之下的
中间层——引擎只提供执行机制与运行时身份（Host 嵌入契约 + 装配数据 +
生命周期），不约束策略；web/CLI/桌面/stdio 皆为宿主之一（web 只是
宿主形态之一，不是引擎的绑定形态）。当前宿主领域：小说生成平台。

**核心思想：机制是引擎，知识是数据，变化是补丁，汇入靠调配。**
引擎只保留不可降维的机制骨架（图执行/补丁链/调配器/推演/验证闸门/
沙箱/审批/运行时装配与生命周期等），其余一切（图/计划/harness/工具/
规则/知识/参数/分支/装配配方）皆为数据；一切演化皆为补丁链
（append-only、可回退、可分支、可审计）；一切多源汇入（上下文/知识/
工具/记忆/证据）皆经调配器（加权、预算、组装、留痕）。

- `ink_engine.core`（engine-core）：纯机制引擎内核——图执行/checkpoint/事件流/
  interrupt/存储/补丁链/LLM/安全剥离/沙箱与审批原语/运行时装配与生命周期
  （唯一 seam，API 即协议）；
- `ink_engine.seeds`（领域种子仓库）：随引擎发布的数据资产（通用种子 +
  领域种子，如 `seeds/novel`）——规则集/样例库/schema 基座/默认编排模板，
  按需注入用户集，导入即自注册（插拔形态）；
- `examples/`：可独立运行的示例（TextForge 为完整参考实现，stdio_host
  为最小非 web 宿主）；
- `docs/`：概念文档（concepts.md）+ 扩展点文档（extensions.md）。

## 安装

```bash
# 引擎零业务依赖；可选存储后端驱动
pip install -e .            # 内核（纯标准库）
pip install -e ".[sqlite]"  # sqlite 存储后端
pip install -e ".[postgres]"  # postgres 存储后端
pip install -e ".[llm]"     # LLM 层（AsyncLLM/厂商适配，httpx）
pip install -e ".[test]"    # 测试与 lint 依赖（pytest/ruff）
```

## 模块总览

### 内核（ink_engine.core）

| 模块 | 职责 |
|---|---|
| `graph.py` / `executor.py` | 图定义 DSL + 执行循环（checkpoint 版本链/恢复重放/interrupt 注入/预算钩子/异常策略）；图 = 可序列化数据（round-trip + 指纹版本） |
| `plan.py` / `spawn.py` | 运行时重规划（`__plan__` 保留键：下一跳编排，随 checkpoint 版本化）；子任务展开（`__spawn__`，独立子链 + 数据形态子图） |
| `simulation.py` | 决策点推演-回溯-换选（`__simulate__` 保留键：分支独立子链 + 评估协议 + 择优调配 + 轨迹树引用） |
| `rules.py` / `scoring.py` / `schema_validator.py` | 规则 DSL（声明式校验/状态转换规则 + 样例库机制）；加权打分器（维度+权重+阈值配置）；Schema 声明校验（L1 准入机制件） |
| `knowledge_set.py` / `knowledge_signals.py` / `knowledge_gate.py` / `evolution.py` | 知识集封装（条目/补丁链演化/分层晋升/可移植/检索/注入适配）；信号感知与蒸馏；三层验证闸门（L1 准入/L2 样例/L3 目标筛选）；进化工厂（反思式变异/防退化） |
| `tuning.py` | 自适应调优（回合指标聚合/参数快照/低分反馈降权） |
| `assembly.py` / `context.py` | **输入调配管线（多源统一预算/激活留痕/一键开关）**；上下文调配器（源元数据/预算分配/加权组装/融合钩子） |
| `state.py` / `patch_chain.py` | 状态通道 + reducer 注册表；内容型补丁链（append/replace/delete + assemble/rebase/branch） |
| `events.py` | 事件信封（协议版本化 + 传输接口化，负载对齐前端协议，增量演进） |
| `storage.py` / `chain_rebase.py` | 通用存储服务（checkpoint/事件/records，内存/sqlite/postgres）；checkpoint 版本链压缩（窗口化有界化） |
| `recovery.py` | 断线续流恢复（恢复锚点收集/图版本指纹校验/状态通道继承） |
| `harness.py` / `declarative_tools.py` / `tool_orchestrator.py` | harness 声明式定义/注册表/补丁链仓库；声明式工具创建（端点受限 + 强制权限）；工具编排 |
| `interrupt.py` / `approval.py` | interrupt 挂起/注入重入（弹卡审批一等能力）；工具调用前挂卡审批标准姿势 |
| `permissions.py` / `sandbox.py` / `tool_pipeline.py` | 工具执行环境：权限门禁（默认拒绝）+ fs/进程沙箱 + 执行流水线 |
| `fanout.py` / `budget.py` | 发散并行原语（部分失败剔除）；执行预算钩子（步骤/轮数上限由业务注册策略） |
| `registry.py` / `workflow.py` | 节点/边注册表（业务自定义节点）；WorkflowSpec→Graph 转换 |
| `security.py` / `logging.py` | 敏感信息剥离；结构化 JSON 日志 + trace_id 链路追踪 |
| `introspection.py` | 自指层观察原语（内省服务 + inspect_* 元工具：图/规则/知识/界面/工具表 JSON 快照，只读流水线 + 权限门禁 + 敏感键剥离） |
| `self_tools.py` | 自指层演化原语（4 契约元工具：propose_patch/apply_patch/revert_patch/propose_domain_manifest——引擎能力，随机制层走补丁链演化、不随宿主壳漂移；宿主扩展经 SelfToolContext 钩子接入） |
| `runtime.py` | **运行时装配与生命周期（不可演化骨架成员）**：Host 嵌入契约（存储工厂/模型解析/审批策略/传输工厂/关停钩子五件套）+ AssemblyRecipe 装配数据 + Runtime 状态机（uninitialized→running→paused→stopped + 在途 run 登记 + 审批决议重入样板）；Engine = 单次 run 执行，Runtime = 进程级装配产物与生命周期 |
| `state_machine.py` / `memory.py` / `tiers.py` | 通用状态机原语；记忆策略原语（MemoryStore 协议/召回策略/存储后端）；模型分层挡位（挡位配置解析/按挡位建链/调用统计钩子） |
| `llm/` | AsyncLLM + OpenAI 兼容适配器 + 工具 schema + fallback 链 + embedding |

### 通用机制件（core 平级模块，原共享组件包并入）

| 模块 | 职责 |
|---|---|
| `round_steps.py` | 回合步骤协议（step_id 累积/重放，断线续流种子） |
| `review_card.py` | 四类审批卡数据模型 + 门控分级注册表 |
| `context.py`（域窗口投影段） | 域上下文窗口投影/归档摘要 |
| `review.py` | 测试时专才化评审-收敛原语（评审器/收敛策略/web 验证钩子） |

### 领域种子仓库（ink_engine.seeds，随引擎发布的数据资产）

| 包 | 内容 |
|---|---|
| `seeds/novel/` | novel 领域种子（第一个领域种子，未来平行扩展）：规则集 10 条封装为规则条目 + 样例库 14 用例 + schema 基座（知识条目/世界观视图口径）+ 默认编排模板（图定义数据）；导入即自注册，`seed_user_set(domain="novel")` 按名注入用户集 |
| `seeds/__init__.py` | 种子机制转发（通用种子注入 + 领域种子注册契约） |

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

更多示例：`python examples/novel_demo.py`（图执行/事件流/interrupt/补丁链）、
`python examples/context_mixer_demo.py`（调配器多源融合）、
`python examples/stdio_host.py`（最小非 web 宿主：Runtime 三步挂载 +
stdin 回合 + 终端决议回流）。

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
    seeds=[("boot", build_boot_seed_entries)],
    harness_definitions=[boot_harness_definition()],
    event_type_specs=list(BOOT_EVENT_TYPES),
    tool_wiring=ToolWiring(self_specs=self_tool_specs,
                           self_executor_factory=make_self_executor,
                           self_operation_of=operation_of),
    approval_levels={PatchKind.THEME: ApprovalLevel.L0},
    graph_recipe=lambda ctx: build_chat_graph(ctx.llm, ctx.tool_pipeline, ctx.tool_specs),
    # …检索源/apply 目标/vetting/收敛钩子按需注入
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
- **AssemblyRecipe 是数据**：图配方/种子/harness/事件类型/界面基线/
  工具三路分发/vetting/分级审批表/检索源/apply 目标全部数据注入——
  换壳 = 换配方，机制层不感知宿主形态；配方字段类型只允许核心类型
  与鸭子协议（架构门禁白名单强制，宿主类型不得进入配方）；
- **Runtime 与 Engine 分工**：Engine = 单次 run 执行；Runtime = 进程级
  装配产物与生命周期（boot/rebuild/pause/resume/stop + 在途 run 登记 +
  引擎重建缓存——配置/工具表变更才重建）；
- **自指元工具已内核化**：4 契约演化工具（propose_patch/apply_patch/
  revert_patch/propose_domain_manifest）随机制层走补丁链演化，stdio
  等新宿主直接复用，无需自带元工具实现；宿主扩展（如种子沉淀）经
  `SelfToolContext` 钩子接入。

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
  蒸馏沉淀新规则，进化工厂反思式变异防退化，工作→项目→用户分层
  晋升，导出/导入可移植，相似任务检索复用优先于生成。
- **领域种子**：引擎随带数据资产（`seeds/novel`：规则集/样例库/schema
  基座/默认编排模板），初始化注入用户集（幂等、只读基线），随使用
  继续成长——领域深度交给孵化机制，机制层零领域内容。
- **工作流约束域**：`WorkflowSpec` = 用户预编排的「可执行的计划空间」
  （节点/边集合）；`__plan__` 须落在工作流约束域内（宽松域自由选序 /
  严格序按工作流边序执行，RunOptions.plan_workflow 注入）。
- **自适应调优**：回合指标聚合（失败率/评审分/收敛轮数）+ 低分反馈
  降权 + 参数快照随评估记录落库——调参不改变历史推演的可回放性。
- **interrupt**：节点内 `await ctx.interrupt(key, payload)` 声明中断点，
  引擎持久化中断状态并挂起；外部注入值后从该节点重入（弹卡审批）。
- **事件即协议**：节点 `ctx.emit(type, payload)` 产出事件流，负载直接
  对齐前端协议（step_id/round_id/parent_step_id），无框架事件中间层。
- **输入调配管线**：每次 LLM 调用前多源统一调配（上下文+知识+工具+
  记忆+证据），统一预算分级分配 + 激活模式留痕 + 一键开关回退旧路径；
  确定性层零 LLM 调用，融合钩子按需升级（失败自动回退）。
- **运行时身份**：Runtime = 进程级装配与生命周期（Host 五件套嵌入契约 +
  装配配方数据 + 状态机 + 在途 run 登记 + 审批决议重入样板）——web/
  CLI/桌面/stdio 皆为宿主之一，嵌入门槛从「复制装配样板」降到「五件套
  + 配方三步挂载」；装配动作是机制（不可被补丁链修改），装配决策是
  数据（宿主可换）。
- **测试时专才化**：生成 → 评审 → 校验 → 收敛（不微调权重），
  web 验证钩子按需触发。

详见 `docs/concepts.md`（概念体系）与 `docs/extensions.md`（扩展点目录）。

## 测试

```bash
pytest                     # 单测全绿（性能门禁/精确基准默认排除，防 CI 抖动误报）
pytest -m benchmark        # 性能门禁断言（checkpoint 写入/事件吞吐/补丁组装/压扁）
pytest --benchmark-only -m benchmark  # 精确基准统计（pytest-benchmark）
POSTGRES_TEST_URL=... pytest -m postgres  # 真实 postgres 后端冒烟
```

验收基准：checkpoint 写入 <10ms、事件流吞吐 ≥500 事件/s、
100 补丁组装 <5ms、rebase <10ms（本地实测：0.94ms / 千级 eps / 90µs）。

## 运维说明

- **存储 schema 不迁移**：引擎表结构随版本演进，既有库升级后启动期自检会给出
  明确指令——删除库/表后重启（`DROP TABLE checkpoints, event_log, records;`
  或删除 db 文件），历史数据不保留（引擎定位：不承诺存量数据兼容）。
- **日志**：引擎遵循标准 logging 语义（不抢占宿主日志体系）；需要开箱即用的
  JSON 日志时由宿主显式调用 `configure_engine_logging()`（examples/ 已调用）。

## 边界（引擎不做）

- 不含业务逻辑（路由/域专才/门控分级配置在 TextForge 业务层注册挂载；
  沙箱/审批为机制原语，规则与策略配置属业务层）；
- 评审/评估/调参策略在用户集注入（规则集/打分器/蒸馏器/变异策略由
  使用方提供，引擎只规定协议形态与验证闸门）；
- 声明式工具不生成执行代码（只声明 name/description + 参数 schema +
  权限 + 端点类型，执行体经 executor 钩子注册，重路径边界不变）；
- 不做通用进程管理器与 MCP（进程型工具以受限沙箱形态进内核：
  超时 kill/退出码/输出截断/环境清理，默认拒绝兜底）；
- 不做多 worker 分布式执行（单进程 asyncio，部署层负责扩展）。

## License

MIT（见 LICENSE；pyproject license 字段同标；拆独立仓库时随带）。

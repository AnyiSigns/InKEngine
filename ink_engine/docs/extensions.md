# InkEngine 扩展点文档（接口与扩展点目录）

引擎的设计承诺：**机制在内核，策略在领域/业务层**——新增能力像「插拔 U 盘」
而不是「拆炸弹」。本文档列出全部扩展点：**谁定义 / 谁实现 / 谁消费**。

## 扩展点总览

| 扩展点 | 定义（引擎） | 实现（复用者/宿主） | 消费（引擎） |
|---|---|---|---|
| 自定义节点/边 | `graph.Node`/`NodeRegistry`/`EdgeRegistry` | 注册节点/边函数 | 执行循环按名取节点/条件判定 |
| 执行预算策略 | `budget.BudgetPolicy` | 注册策略类 | 节点边界检查终止 |
| LLM 厂商适配器 | `llm.registry` | `register_adapter` 注册适配器类 | 配置 adapter 字段驱动选择 |
| 模型 fallback 链 | `llm.fallback.ModelChain`/`tiers.build_tier_chain` | 配置备用模型列表/挡位 | 瞬时故障重试/切换 |
| 存储后端 | `storage.Storage` | 实现协议（memory/sqlite/postgres） | 全部持久化通道 |
| 事件传输 | `events`（EngineTransport） | 实现传输 | 事件流产出 |
| 记忆存储/召回 | `memory.MemoryStore`/`MemoryRecallPolicy` | 实现协议 | 记忆通道读写/召回 |
| 建图注册表 | `registry.GraphRegistries` | 注册节点/边类型（数据形态解析） | 图定义数据重建/计划条件解析 |
| harness 定义/仓库 | `harness.HarnessRegistry`/`HarnessRepository` | 注册/保存定义（图数据 + 工具清单） | 能力路由/建图/版本回退 |
| 声明式工具 | `declarative_tools`/`tool_pipeline` | 声明工具定义 + 端点执行体注册 | 全流水线执行（门禁→沙箱→守卫→审批→审计） |
| 端点类型 | `declarative_tools.EndpointTypeRegistry`/`EndpointTypeSpec` | 注册自定义端点类型（动作域/配置必填键/契约输出形态/提取与失败原因钩子/沙箱守卫接线） | 判定目标推导/守卫自动接线/契约生成 |
| 工具可信度闸门 | `tool_vetting.ToolVetting` | 提供 ToolManifest/静态钩子/影子运行 | 外部工具导入过滤 |
| MCP 外部生态 | `mcp_client.McpClientManager`/`McpServerConfig` | 提供 server 配置（http/stdio/in_memory） | 工具导入/调用/会话生命周期 |
| 计划编排 | `plan.Plan` | 节点返回 `__plan__` 清单 | 执行一段后重规划 |
| 推演评估 | `simulation.Evaluator`/`BranchMixer` | 注入评估器与调配策略 | 分支择优提交主线 |
| 规则 DSL | `rules.RuleTypeRegistry`/`RuleEngine` | 注册谓词 + 规则集数据 | 声明式校验/状态转换执行 |
| 样例库 | `rules.FixtureSet` | 规则集自带 fixtures | 验证闸门 L2 非谈判项 |
| 加权打分 | `scoring.WeightedScorer`/`ScoringConfig` | 配置维度+权重+阈值 | 评审打分/校验判定 |
| Schema 校验 | `schema_validator.SchemaSpec`/`SchemaValidator` | 声明字段约束 | L1 准入/条目标签化 |
| 知识集 | `knowledge_set.KnowledgeSet` | 种子注入/演化补丁链 | 检索/晋升/可移植/注入 |
| 信号感知/蒸馏 | `knowledge_signals.Distiller` | 实现蒸馏器（确定性或 LLM） | 轨迹 → 结构化知识 |
| 验证闸门 | `knowledge_gate.KnowledgeGate`（L2 执行器可注入） | 注入 L2 领域执行器/人工审核 | L1→L2→L3 三层收口 |
| 进化工厂 | `evolution.MutationStrategy` | 注入变异策略 | 反思式变异 + 防退化 |
| 自适应调优 | `tuning.MetaTuner` | 配置调参策略 | 权重/阈值/机制参数调整 |
| 输入调配 | `assembly.InputAssembler`/`AssemblyConfig` | 配置预算占比/开关；节点经 `ctx.assemble` 调用 | 多源统一调配 + 激活留痕 |
| 上下文调配 | `context.BudgetAllocator`/`FusionHook` | 换分配策略/注册融合钩子 | `ContextMixer` 装配 |
| 压缩策略 | `context.CompressionPolicy` | 换策略类（默认 ThresholdCompressionPolicy） | 组装时降级选择 |
| 事件类型数据化 | `event_types.EventTypeSpec`/`EventTypeRegistry` | 注册事件类型（schema/renderer/system） | 发射校验/前端渲染接线 |
| 界面描述数据化 | `ui_schema.UISpec`/`UISchemaValidator` | 声明布局树（三层白名单） | UIRenderer 契约渲染 |
| 自指演化 | `self_proposal`/`self_application` | 宿主扩展经 `SelfToolContext` 钩子 + apply 目标注册 | 提案校验/分级审批/补丁链/审计/回退 |
| 实体协作者 | `entities.EntityRegistry`/`EntitySpec` | 声明实体规格（`entity_specs` 配方直注） | 注册/召唤/演化/替换/晋升 |
| 实体演化 | `entity_evolution.EntityEvolutionPipeline` | —（引擎自承载） | 失败信号变异 → 闸门 → 严格更优替换 |
| 成长管线 | `growth.GrowthPipeline`/`GrowthConfig` | 配置启用/蒸馏器（可注入） | 信号→蒸馏→闸门→知识集落位（默认开） |
| 输出验证 | `verifier.OutputVerifier` | 注入验证器 + `verify_retry_limit` | 节点输出违规驱动重做 |
| 工具检索 | `tool_index.ToolVectorIndex` | 注入 embedder/向量库 | `search_tools`/`request_tool` 动态注册 |
| 领域校验语义 | 产品侧规则数据 + 谓词 | 注入领域状态视图（JSON 数据）+ 可选 LLM 钩子 | 写时校验（规则集 + 注册谓词） |
| 门控分级/卡模型 | `core.review_card` | 注册表 + 校验器 | 卡回路 |
| 工具权限声明 | `core.permissions.PermissionGate` | `ToolSpec.permissions` + `default_policy`（宿主配置） | 流水线调用前判定 |
| 网络策略 | `core.permissions.NetworkPolicy` | 白名单域名（宿主配置） | 权限判定 |
| 沙箱守卫 | `core.sandbox.FileSandbox`/`ProcessSandbox` | 装配 `ToolPipeline.sandboxes` | `validate` 校验 |
| 工具执行流水线 | `core.tool_pipeline.ToolPipeline` | extractor/guards/executor/audit 钩子 | 全环节装配执行 |
| 审批决议策略 | `core.approval.InterruptPolicy` | 换策略类（`DefaultInterruptPolicy`） | `approve_before_execute`/`approve_batch` |
| 环境提供器 | `environments.EnvironmentProvider` | 实现提供器（local/web_bridge） | 环境安装/运行/审计 |
| 构建管线 | `builder.Builder`/`BuildSpec` | 提供构建命令（沙箱白名单内） | 产物构建/冒烟/验证 |
| 运行时装配 | `runtime.Host`/`AssemblyRecipe` | 五件套 + 装配配方数据 | Runtime 生命周期/引擎重建 |

## 1. 自定义节点/边（图执行）

```python
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.registry import NodeRegistry

async def my_node(ctx):
    await ctx.emit("my_event", {"v": 1}, step_id="m:1")
    return {"count": ctx.state.get("count", 0) + 1}

# 方式一：图构建时注册（按名引用）
g = Graph(name="g", entry="my_node", node_registry=NodeRegistry())
g.register_node("my_node", my_node)

# 方式二：直接挂节点函数
g2 = Graph(name="g2", entry="start")
g2.add_node("start", my_node)
```

节点约定：`async (ctx) -> PartialState | None`，无状态副作用（返回增量，
引擎统一 checkpoint）；异常处理策略（重试 N 次/跳过/终止）经运行期配置。

## 2. LLM 厂商适配器

```python
from ink_engine.core.llm.base import AsyncLLM
from ink_engine.core.llm.registry import register_adapter

class MyVendorLLM(AsyncLLM):  # 实现 ainvoke/astream
    ...

register_adapter("my_vendor", MyVendorLLM)  # 配置 {"adapter": "my_vendor"} 驱动选择
```

内置：`openai_compatible`（协议全名，规范名）+ openai/deepseek/zhipu/
moonshot/ollama 厂商别名（同指 OpenAI 兼容类）；原生协议厂商各配独立
适配器——`openai_responses`（Responses）/`anthropic_messages`（Messages）/
`gemini`；旧简称 `openai_compat`/`openai_response`/`anthropic` 注册为兼容
别名（既有配置零迁移）；DashScope 走 openai_compatible 的
compatible-mode 端点（改 base_url，不入 chat 注册表；embeddings 注册表
另含 dashscope）。
未知适配器显式报错（不静默回退，防配错白跑）；适配器构造惰性（缺
httpx 时才提示）。流式增量统一为 `LLMChunk`（token/reasoning_token/
tool_calls_delta/finish_reason/usage），厂商差异收敛在适配器内。

## 3. 存储/传输后端

```python
from ink_engine.core.storage import Storage, create_storage

# 内置三后端：memory:// / sqlite:///path / postgresql://user:pass@host/db
storage = create_storage("sqlite:///./demo.db")

# 自定义后端：实现 Storage 协议
# （get_checkpoint/put_checkpoint/chain_index/append_event/events_after/
#   put_record/list_records/trim_events/delete_checkpoints/…）
class MyStorage(Storage): ...
storage = MyStorage(...)
```

checkpoint 版本链/事件日志/结构化记录（含具名集合 harness/env_audit/
event_types）统一走同一存储服务；敏感键写入前剥离；并发写保护
（原子链尾校验 + 乐观锁）。事件传输接口化（EngineTransport，
事件流 = AsyncGenerator）。

## 4. 记忆策略

```python
from ink_engine.core.memory import MemoryQuery, StorageBackedMemoryStore

store = StorageBackedMemoryStore(storage)          # 默认实现
entries = await store.query(MemoryQuery(namespace="book:1", kind="style"))
recalled = PriorityRecallPolicy().recall(entries, limit=2)  # 换策略 = 换类
```

分层语义（工作/卷级/风格）由宿主经 namespace/kind 区分；删除走
非破坏性失效语义（forget = 标记失效，记录仍可追溯）。

## 5. 评审-收敛

```python
from ink_engine.core.review import (
    ConvergenceResult, MaxRoundsConvergencePolicy,
)

# 评审器/再生成器由使用方实现协议（core.review 的 Reviewer/Regenerator），
# 或按领域语义在用户集内以规则/打分器数据承接；评审循环由使用方驱动：
reviews = [await reviewer.review(candidates, context)]     # Reviewer 协议
policy = MaxRoundsConvergencePolicy(threshold=0.75, beam=2, max_rounds=2)
while not (decision := policy.decide(reviews, round_no=round_no)).converged:
    if decision.regenerate_indexes:  # 未达标 → 取 beam 再生成
        candidates = [await regenerator.regenerate(candidates[i], context)
                      for i in decision.regenerate_indexes]
        reviews = [await reviewer.review(candidates, context)]
result = ConvergenceResult(candidates, decision.converged)
```

web 验证钩子（评审存疑声明时触发，宿主实现 `WebVerifier`）。
评审器/再生成器失败返回中性分/原候选（fail-open），不阻断主流程。

## 6. 规则 DSL 与样例库

```python
from ink_engine.core.rules import RuleEngine, RuleSet, RuleTypeRegistry

registry = RuleTypeRegistry()

def pred_forbid(target, config, context):
    # 谓词 = 注册函数：target 为按 target_path 提取的检查对象
    if target == config.get("forbid"):
        return [{"message": f"禁止值命中: {target}"}]
    return []

registry.register("forbid_value", pred_forbid)

rule_set = RuleSet.parse(
    {"name": "demo", "rules": [{
        "id": "r1", "kind": "rule", "predicate": "forbid_value",
        "target_path": "value", "config": {"forbid": "bad"},
    }]},
    registry=registry,
)
result = RuleEngine(registry).evaluate(rule_set, {"value": "bad"})
```

样例库（每个规则集自带，新规则必须先让 fixture 全绿才允许落库）：

```python
from ink_engine.core.rules import FixtureCase, FixtureSet, assert_fixtures_pass

fixtures = FixtureSet(name="demo", cases=(
    FixtureCase(id="pass1", data={"value": "ok"}, expected_pass=True),
    FixtureCase(id="fail1", data={"value": "bad"}, expected_pass=False,
                expected_kinds=("rule",)),
))
assert_fixtures_pass(rule_set, fixtures)  # 非谈判项：全绿才可通过
```

## 7. 决策点推演（评估器 + 调配策略）

```python
from ink_engine.core.simulation import (
    Evaluation, Evaluator, SimulateSpec,
)

class MyEvaluator:
    """分支评估器：实现 Evaluator 协议（评审策略在用户集，如加权打分器）。"""
    async def evaluate(self, branch: SimulateSpec, overlay: dict) -> Evaluation:
        return Evaluation(score=0.8, passed=True, note="demo")

engine = Engine(graph, options=RunOptions(
    evaluator=MyEvaluator(),          # 节点返回 __simulate__ 时的分支评估器
    branch_mixer=MyMixer(),           # 可选：跨分支组装策略（默认单选最高分）
    max_simulations=8,                # 分支数护栏（成本）
))
```

## 8. 知识集与验证闸门

```python
from ink_engine.core.knowledge_gate import (
    GateL2FixtureExecutor, KnowledgeGate,
)
from ink_engine.core.knowledge_set import (
    KnowledgeEntry, KnowledgeSet, seed_knowledge_set,
)
from ink_engine.core.schema_validator import SchemaSpec

gate = KnowledgeGate(l2_executor=GateL2FixtureExecutor(registry=my_registry))
l1, l2, l3 = await gate.check(
    entry, schema=my_schema, fixtures=my_fixtures,
    old_metrics={"accuracy": 0.8},   # L3：不差于旧版才保留
)
```

L2 执行器可替换为领域执行器（沙箱内跑完整样例）；人工审核层可注入
（默认弹卡可关）作为 L3 之上的可选人工关。

## 9. 上下文调配器

```python
from ink_engine.core.context import ContextAssembler, ContextMixer, ContextSource
from ink_engine.core.context import FusionRegistry, WeightedBudgetAllocator

sources = [
    ContextSource(type="doc", content="第3章摘要...", weight=1.0, relevance=0.9),
    ContextSource(type="memory", content="先抑后扬", weight=0.7, relevance=0.6, ttl=86400),
]

mixer = ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))
result = await mixer.mix(sources)          # 确定性组装（零 LLM 调用）
print(result.text, result.included, result.dropped)  # 留痕可审计

registry = FusionRegistry()
registry.register("deep_fusion", MyFusionHook())      # LLM 调酒师（按需）
mixer.attach_fusion(registry.get("deep_fusion"), instruction="深度融合")
result = await mixer.mix(sources)          # 融合失败自动回退确定性组装
```

预算分配策略接口 `BudgetAllocator` 可替换（默认 WeightedBudgetAllocator：
高权重全保留/中权重截断/低权重丢弃，确定性零成本）。行为开关
（新旧装配一键切换）为宿主配置职责。

## 10. 输入调配管线

```python
from ink_engine.core.assembly import (
    AssemblyConfig, InputAssembler, SOURCE_CONTEXT, SOURCE_KNOWLEDGE,
)
from ink_engine.core.context import ContextSource

# 装配配置（统一预算 + 分级占比 + 行为开关）
config = AssemblyConfig(
    total_budget=8000,            # 一次调用的总预算
    context_ratio=0.5,            # 对话/回合上下文 50-70%
    knowledge_ratio=0.3,          # 知识注入 20-40%
    tool_ratio=0.1,               # 工具定义 5-10%
    enabled=True,                 # 一键开关：False = 回退旧装配路径
)
assembler = InputAssembler(config)

# 节点内经 ctx.assemble 统一调配（执行器接线入口）：
async def plan(ctx):
    result = await ctx.assemble(
        [
            ContextSource(type=SOURCE_CONTEXT, content="对话历史...", weight=1.0),
            ContextSource(type=SOURCE_KNOWLEDGE, content="知识条目...",
                          weight=0.8, meta={"entry_id": "k-1"}),
        ],
        total_budget=8000,
        version_snapshot={"rules": "v3"},   # 知识/规则版本快照（留痕可重建）
    )
    return {"prompt": result.text}
# 激活记录（源/权重/预算/版本快照）随 input_assembly 事件落执行日志
```

## 11. 领域校验语义（产品自写规则数据）

领域深度归宿主产品层：领域校验语义 = 规则数据（`Rule` 条目，随知识集
补丁链版本化）+ 领域谓词（注册进 `RuleTypeRegistry`）+ 样例库（fixture
全绿为新规则落库的非谈判项，L2 评估基线）。产品侧以「规则集 + 谓词 +
样例库」三件成对维护：

```python
from ink_engine.core.rules import RuleEngine, RuleSet, RuleTypeRegistry
from ink_engine.core.knowledge_set import KnowledgeSet, seed_knowledge_set
from ink_engine.core.knowledge_set import KnowledgeEntry, KIND_RULE, SOURCE_MODEL

# 1) 领域谓词注册（产品实现，注册进规则注册表）
def pred_gap(target, config, context): ...      # 如：信息差校验
registry = RuleTypeRegistry()
registry.register("knowledge_gap", pred_gap)

# 2) 领域规则 = 数据（规则条目注入知识集，可随补丁链演化/回退）
entries = [
    KnowledgeEntry(
        id="seed.product.rule.knowledge_gap", kind=KIND_RULE,
        data={"rule": {"id": "knowledge_gap", "kind": "rule",
                       "predicate": "knowledge_gap", "target_path": "knowledge"}},
        source=SOURCE_MODEL, credibility=0.9,
    ),
]
seed_knowledge_set(ks, entries)   # 注入（幂等）

# 3) 样例库（fixture 全绿才允许新规则落库，非谈判项）
fixtures = FixtureSet(name="product", cases=(...))
assert_fixtures_pass(rule_set, fixtures)
```

规则数据与谓词执行件绑定：`RuleSet.parse` 建期拒绝未知谓词（不静默），
L1 最小功能测试要求规则可加载——谓词不注册 = 规则无法执行。领域状态
运行时（提取/应用/演进）由产品按领域语义实现，引擎只承载「规则数据 +
注册谓词 + 校验入口」机制。

## 12. 钩子与策略接口汇总

- **写时预检钩子**：声明式规则集 + LLM 判定，注册制；默认 fail-open，
  关键场景可配置 fail-closed；
- **执行预算钩子**：GROUP_STEP_CAPS/tool_round_limit/字符预算为
  声明式配置（全局/书籍级），策略抛 BudgetExceededError 终止；
- **门控分级注册表**：L1/L2/L3 + 用户可配置 overrides，
  `gating_tier_of` 用户覆盖 > 注册表 > L2 默认；
- **融合钩子**：LLM「调酒师」按需触发（不默认），失败回退确定性组装；
- **推演评估器/调配策略**：`simulation.Evaluator`/`BranchMixer` 协议可注入
  （评审策略在用户集，引擎只规定评估产出形态）；
- **蒸馏器/变异策略**：`knowledge_signals.Distiller`/`evolution.MutationStrategy`
  可注入（确定性基线实现零 LLM，LLM 蒸馏为可选扩展）；
- **调参策略**：`tuning.MetaTuner` 参数与阈值可配置，权重随卡回路反馈
  自动调整；
- **压缩策略**：`context.CompressionPolicy` 可替换（默认双阈值触发）。

## 13. 工具执行环境（沙箱 + 权限门禁 + 挂卡审批）

工具权限与安全环节全部机制化装配（`core/permissions.py`/`core/sandbox.py`/
`core/tool_pipeline.py`/`core/approval.py`），宿主声明工具权限与参数语义
即可接入。规则与策略配置（白名单命令、直过名单、门控分级 overrides）属
业务层，由宿主构造时注入。

**权限声明**（`ToolSpec.permissions`，`core/llm/tools.py`）：

```python
from ink_engine.core.llm.tools import ToolSpec

spec = ToolSpec(
    name="write_file",
    description="写入草稿文件",
    permissions=("filesystem:write:/book/**",),   # 未声明权限的工具默认拒绝
)
```

**流水线装配**（`ToolPipeline`：门禁 → 沙箱 → 守卫 → 执行 → 审计 → 观察）：

```python
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.sandbox import FileSandbox, ProcessSandbox
from ink_engine.core.tool_pipeline import ToolPipeline

pipeline = ToolPipeline(
    gate=PermissionGate(review_tier=lambda tool: tool == "write_file"),
    extractor=lambda spec, args: ("write", str(args["path"])),  # 宿主声明参数语义
    sandboxes=(FileSandbox("/data/book"),),                      # 逐个 validate
    guards=(duplicate_write_guard,),                             # 抛异常即拒绝
    executor=my_tool_executor,            # (ctx, spec, args, approval) -> 文本
    audit=my_audit_hook,                  # 缺省经 ctx.emit 发 tool_audit 事件
    max_result_chars=100_000,             # 结果截断 + 溢出标记
)
result = await pipeline.execute(ctx, spec, {"path": "ch1.md"})
# result.decision: allow/deny/review 决议/error；output 为截断后文本
```

**挂卡审批**（`approve_before_execute`/`approve_batch`，gate 卡标准包装）：

```python
from ink_engine.core.approval import (
    DECISION_ACCEPT, DefaultInterruptPolicy, approve_batch, approve_before_execute,
)

decision = await approve_before_execute(
    ctx, "gate", {"tool": "write_file", "summary": "写入卷1内容"},
    policy=DefaultInterruptPolicy(auto_approve_tools=frozenset({"list_dir"})),
)
# 决议: accept/edit/reject/terminate/auto；宿主按决议执行/跳过/终止

decisions = await approve_batch(ctx, "batch_gate", [action1, action2])  # 合并卡
```

**自定义决议策略**：实现 `InterruptPolicy` 协议（`should_approve` 返回
False = 直过，`timeout_for` 给出审批窗口）；超时后重入一律 reject
（`source=expired`）、非法注入回落 reject（`source=invalid`），
fail-closed 兜底；挂起卡随 interrupt checkpoint 持久化，与执行中
cancel 语义互不干扰。

**声明式工具**（`core/declarative_tools.py`，端点受限 + 权限强制）：

```python
from ink_engine.core.declarative_tools import (
    DeclarativeToolSpec, DeclarativeToolExecutors, EndpointType,
    build_declarative_pipeline, endpoint_operation, make_http_fetch_executor,
)

spec = DeclarativeToolSpec(
    name="fetch_docs",
    description="受控抓取文档（域名白名单内）",
    parameters={"type": "object", "properties": {"url": {"type": "string"}}},
    permissions=("network:connect:*.example.com",),   # 权限强制非空（建表期）
    endpoint=EndpointType.HTTP_FETCH,
    endpoint_config={},              # http_fetch 无需额外声明
    meta={"source": "host"},
)
executors = DeclarativeToolExecutors()
executors.register_definition(spec)
executors.register(EndpointType.HTTP_FETCH, make_http_fetch_executor())  # 或自写

pipeline = build_declarative_pipeline(executors)  # 自动接线 NetworkPolicy 沙箱
result = await pipeline.execute(ctx, spec.to_spec(), {"url": "https://x.example.com/a"})
```

端点类型与定义期必填：`http_fetch`（域名白名单经 NetworkPolicySandbox）、
`process_exec`（须声明 allowlist，ProcessSandbox 白名单）、`file_ops`
（须声明 root，FileSandbox 根目录）、`mcp`（须声明 server_id，见 16 节）。
判定目标 `endpoint_operation(endpoint, args, config)` 返回
`(operation, target)`，无法判定返回 None → 流水线 fail-closed 拒绝；
**判定一律按定义声明的权限**（调用方 spec 不参与，封「伪造宽松权限」窗口）。

**端点类型注册表**（`EndpointTypeRegistry`，谓词注册表同哲学）：端点类型
集合不再封闭——内置 7 种（http_fetch/process_exec/file_ops/mcp/web_search/
collab_request/task_manager）为引擎默认；宿主自定义端点经注册表条目登记：

```python
from ink_engine.core.declarative_tools import (
    EndpointTypeRegistry, EndpointTypeSpec, DeclarativeToolSpec,
    DeclarativeToolExecutors, build_declarative_pipeline,
)
from ink_engine.core.schema_validator import FIELD_ARRAY, SchemaField

endpoint_registry.register(EndpointTypeSpec(
    name="database_query",                    # 注册键 = 工具声明 endpoint 引用
    actions=("query",),                       # 判定动作域
    config_requirements=("engine",),          # 定义期必填配置键（缺失即拒绝）
    output_fields=(SchemaField(name="rows", required=True, kind=FIELD_ARRAY),),
    extractor=lambda args, config: (("query", args["table"]) if args.get("table") else None),
    failure_reason=lambda args, config: None if args.get("table") else "table 参数缺失",
    sandbox_ops=("query",),                   # 需沙箱守卫的操作（空 = 无本地沙箱）
    sandbox_builder=lambda definition: MyDbSandbox(...),  # 守卫构造器
))
spec = DeclarativeToolSpec(
    name="db_query", description="数据库查询", parameters={...},
    permissions=("database:query:*",), endpoint="database_query",
    endpoint_config={"engine": "sqlite"},
)
```

安全语义：**注册 = 装配期代码动作，不是 agent 可写数据**（agent 只能引用已
注册端点创建工具，不能注册端点——`PatchKind` 不新增端点注册类型）；注册表
没有「跳过流水线环节」开关，自定义端点与内置端点同等走门禁 → 沙箱 → 守卫
→ 审批 → 审计；`sandbox_ops` 非空而 `sandbox_builder` 缺失 = 注册即拒绝
（一致性校验）；未注册端点 = 工具定义期拒绝 + 分发处 fail-closed。壳侧 Rust
对自定义端点宽容载入（`Endpoint::Unknown` 透传不接线守卫，守卫语义由引擎
侧注册表承担）。

## 14. 领域知识数据化（产品侧契约）

领域深度归宿主产品层，产品以「规则数据 + 谓词 + 样例库」三件成对维护
（见第 11 节）。数据化契约要点：

- **规则条目**（kind=rule，`data.rule` 与规则 DSL 声明同构）注入知识集
  （`seed_knowledge_set`，幂等）——校验语义 = 数据，可随补丁链版本化/
  回退/导出导入，可被孵化机制演化（信号蒸馏 → 三层闸门 → 落库）；
- **样例库**（fixture 全绿 = 新规则落库的非谈判项，L2 评估基线）——
  与规则数据成对维护，数据改动不破坏契约（建期解析 + 样例可加载）；
- **schema 基座**（L1 准入与视图校验口径）与**默认编排模板**（图定义
  数据）按产品需要声明；
- **谓词注册**：`RuleTypeRegistry.register`（产品实现），谓词不注册 =
  规则无法执行（`RuleSet.parse` 建期拒绝未知谓词，不静默）。

**语言无关形态**（MCP 生态实验 `examples/ts_seed_pack/` +
`examples/ts_seed_demo.py`）：知识条目为纯 JSON 数据，执行件以 MCP
server 形态跨语言交付——TypeScript/JavaScript 零依赖手写 JSON-RPC
over stdio（`server.mjs`），引擎经 `McpServerConfig`（stdio 传输）挂载，
工具进工具表走统一流水线（权限 `mcp:call:<id>` 与端点判定匹配默认
放行 + 审计留痕）。Python 是引擎的实现语言，契约（JSON 数据形态 +
MCP 协议）语言无关——Rust/TS 等任意语言均可交付「数据 JSON + MCP
执行件」形态的领域能力。

## 15. 自指演化扩展点（观察 → 提案 → 应用 → 回退）

引擎形态 = 补丁链数据，宿主不须自带元工具实现；扩展点：

```python
from ink_engine.core.self_tools import (
    SelfToolContext, make_self_executor, operation_of, self_tool_specs,
)
from ink_engine.core.self_application import (
    ApprovalLevel, ApplyTarget, SelfApplicationPipeline,
)

# 1) 元工具契约：6 契约工具 + 6 观察工具随机制层走补丁链（无需宿主实现）
# 2) 宿主扩展钩子（如种子沉淀）：
class MyHarvestHook:
    async def __call__(self, ctx: SelfToolContext, payload: dict) -> dict: ...

# 3) apply 目标（活跃态应用钩子）：
class MyApplyTarget(ApplyTarget):
    async def apply(self, kind, payload): ...      # 重启装配恢复语义由宿主负责
    async def revert(self, kind, patch_id): ...

recipe = AssemblyRecipe(
    tool_wiring=ToolWiring(
        self_specs=self_tool_specs,
        self_executor_factory=make_self_executor,
        self_operation_of=operation_of,
    ),
    approval_levels={                       # 分级审批表（L0 直过/L1 弹卡/L2 沙箱）
        PatchKind.THEME: ApprovalLevel.L0,
        PatchKind.TOOL: ApprovalLevel.L1,
        PatchKind.ARTIFACT: ApprovalLevel.L2,
    },
    apply_targets={"knowledge": my_apply_target},
    vetting_l2_hook=my_l2_vetting_hook,     # L2 沙箱验证钩子（无则 L2 fail-closed）
    on_reverted=my_revert_hook,             # 回退通知
    convergence_provider=my_convergence,    # apply_patch 前置收敛闸门（Protocol 钩子）
)
```

要点：10 类补丁 kind（ui/theme/tool/rule/knowledge/harness/event_type/
environment/artifact/entity）复用既有校验器；GuardedStorage 拦截演化资产
集合（含 `entities:` 守卫）直写（旁路写 fail-closed）；回退仅链尾单步
（存储层强制）；审计 append-only（`set_audit` 集合）。

## 16. MCP 外部生态挂载

```python
from ink_engine.core.mcp_client import McpClientManager, McpServerConfig, McpTransport
from ink_engine.core.tool_vetting import ToolSource

manager = McpClientManager()
config = McpServerConfig(
    id="ts_seed",                          # 路由密钥 + 权限域 mcp:call:<id>
    transport=McpTransport.STDIO,
    command="node",
    args=("examples/ts_seed_pack/server.mjs",),
    source=ToolSource.AI_GENERATED,        # vetting 来源标记
)
await manager.connect(config)
tools = await manager.import_tools(
    "ts_seed", source=config.source, vetting=my_vetting,
)  # vetting 仅放行 VERIFIED；REVIEW/REJECTED 不导入（fail-closed）
```

- 三传输形态：`http`（Streamable HTTP + headers）/ `stdio`（command +
  args + env）/ `in_memory`（测试注入 server_factory）；
- 工具权限统一 `mcp:call:<server_id>`（按 server 粒度管控，约定优于
  配置）；工具转换纯函数（inputSchema 规范化，无 SDK 依赖）；
- 会话生命周期：connect 重连清理/并发串行化/close_all 优雅回收/
  register_session 防覆盖；跨 server 工具名冲突防静默改路由；
- headers/env repr 遮蔽（凭据不进日志）；call_tool 超时与远端 isError
  包装为结构化失败；未连接/缺 server_id 分发 fail-closed。

## 17. 运行时装配扩展点（Host 契约 + 配方）

完整宿主接入见 `hosts.md`；扩展点速查：

| 配方字段 | 注入内容 |
|---|---|
| `seeds` | 种子提供器列表 `(domain, provider)`（boot/domain_a/…） |
| `harness_definitions` | harness 定义（图数据 + 工具清单） |
| `event_type_specs` | 事件类型（前端渲染接线） |
| `entity_specs` | 实体规格（协作者目录，进 EntityRegistry） |
| `ui_spec` / `ui_allowed_channels` / `ui_allowed_components` / `ui_allowed_theme_tokens` | 界面布局树 + 三层白名单 |
| `tool_wiring` | 工具三路分发（内省/自指/声明式） |
| `vetting_static_hooks` / `vetting_l2_hook` | 外部工具 vetting 钩子 |
| `approval_levels` | 补丁分级审批表（PatchKind → ApprovalLevel） |
| `retrieval_sources` | 检索源工厂（`Callable[[Any], Retriever]`） |
| `apply_targets` | 补丁活跃态应用目标（`dict[PatchKind, Callable[[Any], ApplyTarget]]`） |
| `graph_recipe` | 图配方（装配期以 ctx 编译为可执行图） |
| `on_reverted` / `convergence_provider` | 回退通知 / apply 前置收敛闸门 |
| `run_options` | RunOptions 覆盖（装配期并入运行时选项） |
| `compress_policy` | 上下文压缩策略（CompressionPolicy） |
| `verify_retry_limit` | 输出验证重试上限（VTM 门） |
| `emit_timeline_events` | 时间线事件发射开关 |

## 扩展纪律

1. 新增能力优先走扩展点（注册/接口/配置），不改引擎核心；
2. 高风险的**行为级改动**默认带配置开关 + 新旧路径并存，一键回退；
3. 事件协议演进：payload 增量加字段不破坏（step_id/round_id/parent_step_id
   语义长期稳定）；
4. 数据/配置 schema 演进：加字段带默认值兼容，废弃字段告警不硬删；
5. 领域知识数据化形态（规则条目 + 样例库 + 谓词）由产品成对维护，
   独立版本化；产品壳各目录物理独立、可单独发布；
6. 机制层改动须过架构门禁（领域词/宿主词零出现、配方注解白名单），
   并保持样例闸门（fixture 全绿）与 fail-closed 兜底不变式。

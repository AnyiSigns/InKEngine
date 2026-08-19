# InkEngine 扩展点文档（接口与扩展点目录）

引擎的设计承诺：**机制在内核，策略在领域/业务层**——新增能力像「插拔 U 盘」
而不是「拆炸弹」。本文档列出全部扩展点：**谁定义 / 谁实现 / 谁消费**。

## 扩展点总览

| 扩展点 | 定义（引擎） | 实现（复用者/宿主） | 消费（引擎） |
|---|---|---|---|
| 自定义节点 | `graph.Node`/`NodeRegistry` | 注册节点函数/类 | 执行循环按名取节点 |
| 自定义边 | `graph.Edge`/`EdgeRegistry` | 注册边函数 | 执行循环条件边判定 |
| 执行预算策略 | `budget.BudgetPolicy` | 注册策略类 | 节点边界检查终止 |
| LLM 厂商适配器 | `llm.registry` | `register_adapter` 注册适配器类 | 配置 adapter 字段驱动选择 |
| 模型 fallback 链 | `llm.fallback.ModelChain` | 配置备用模型列表 | 瞬时故障重试/切换 |
| 存储后端 | `storage.Storage` | 实现协议（memory/sqlite/postgres） | 全部持久化通道 |
| 事件传输 | `events`（EngineTransport） | 实现传输 | 事件流产出 |
| 记忆存储/召回 | `memory.MemoryStore`/`MemoryRecallPolicy` | 实现协议 | 记忆通道读写/召回 |
| 建图注册表 | `registry.GraphRegistries`（NodeTypeRegistry + EdgeRegistry） | 注册节点/边类型（数据形态解析） | 图定义数据重建/计划条件解析 |
| harness 定义/仓库 | `harness.HarnessRegistry`/`HarnessRepository` | 注册/保存定义（图数据 + 工具清单） | 能力路由/建图/版本回退 |
| 声明式工具 | `declarative_tools`/`tool_pipeline` | 声明工具定义 + 端点执行体注册 | 全流水线执行（门禁→沙箱→守卫→审批→审计） |
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
| 世界状态校验 | `seeds.novel.ruleset.check_world_state_rules` | 注入世界状态视图（JSON 数据）+ 可选 LLM 钩子 | 写时校验（规则集 + 领域谓词） |
| 门控分级/卡模型 | `core.review_card` | 注册表 + 校验器 | 卡回路 |
| 工具权限声明 | `core.permissions.PermissionGate` | `ToolSpec.permissions` + `default_policy`（宿主配置） | 流水线调用前判定 |
| 网络策略 | `core.permissions.NetworkPolicy` | 白名单域名（宿主配置） | 权限判定 |
| 沙箱守卫 | `core.sandbox.FileSandbox`/`ProcessSandbox` | 装配 `ToolPipeline.sandboxes` | `validate` 校验 |
| 工具执行流水线 | `core.tool_pipeline.ToolPipeline` | extractor/guards/executor/audit 钩子 | 全环节装配执行 |
| 审批决议策略 | `core.approval.InterruptPolicy` | 换策略类（`DefaultInterruptPolicy`） | `approve_before_execute`/`approve_batch` |

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

内置：`openai_compat`（规范名）+ openai/deepseek/zhipu/moonshot/ollama 别名
（同指 OpenAI 兼容类）；DashScope 走 compatible-mode 端点。未知适配器
显式报错（不静默回退，防配错白跑）。

## 3. 存储/传输后端

```python
from ink_engine.core.storage import Storage, create_storage

# 内置三后端：memory:// / sqlite:///path / postgresql://user:pass@host/db
storage = create_storage("sqlite:///./demo.db")

# 自定义后端：实现 Storage 协议（get/put/append/list_records/checkpoint 系列）
class MyStorage(Storage): ...
storage = MyStorage(...)
```

checkpoint/执行事件日志/records/补丁链/审批卡五通道统一走同一存储服务；
事件传输接口化（EngineTransport，事件流 = AsyncGenerator）。

## 4. 记忆策略

```python
from ink_engine.core.memory import MemoryQuery, StorageBackedMemoryStore

store = StorageBackedMemoryStore(storage)          # 默认实现
entries = await store.query(MemoryQuery(namespace="book:1", kind="style"))
recalled = PriorityRecallPolicy().recall(entries, limit=2)  # 换策略 = 换类
```

分层语义（工作/书级/风格）由宿主经 namespace/kind 区分；删除走
非破坏性失效语义（forget = 标记失效，记录仍可追溯）。

## 5. 评审-收敛

```python
from ink_engine.core.review import MaxRoundsConvergencePolicy

# 评审器/再生成器由使用方实现协议（core.review 的 Reviewer/Regenerator），
# 或按领域语义在用户集内以规则/打分器数据承接
result = await run_review_convergence(
    candidates,
    reviewer=MyReviewer(llm=...),     # 实现 Reviewer 协议
    regenerator=MyRegenerator(llm=...),  # 实现 Regenerator 协议
    policy=MaxRoundsConvergencePolicy(threshold=0.75, beam=2, max_rounds=2),
    web_verifier=MyWebVerifier(),  # 评审存疑声明时触发（博查等宿主实现）
)
```

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
    ContextSource(type="chapter", content="第3章摘要...", weight=1.0, relevance=0.9),
    ContextSource(type="memory", content="先抑后扬", weight=0.7, relevance=0.6, ttl=86400),
]

mixer = ContextMixer(assembler=ContextAssembler(default_budget_chars=4000))
result = await mixer.mix(sources)          # 确定性组装（零 LLM 调用）
print(result.text, result.included, result.dropped)  # 留痕可审计

registry = FusionRegistry()
registry.register("novel_fusion", MyFusionHook())   # LLM 调酒师（按需）
mixer.attach_fusion(registry.get("novel_fusion"), instruction="深度融合")
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

## 11. 世界状态写时校验（领域种子）

```python
from ink_engine.seeds.novel import novel_seed_registry, novel_seed_fixtures
from ink_engine.seeds.novel.ruleset import check_world_state_rules

# 世界状态 = JSON 兼容视图（与样例库用例同构）；校验语义 = 规则集数据
issues = await check_world_state_rules(
    world_view,                  # dict：characters/knowledge/events/causal_links/foreshadowings
    text=chapter_text,
    character_id="c1",
    fact_ids=["f_secret"],       # 信息差输入
    at_chapter=5,
)
# 新规则落库前必须过样例库（novel_seed_fixtures 全绿，非谈判项）
```

领域谓词注册表随种子发布（`novel_seed_registry()`）；世界状态运行时
（提取/应用/涟漪）由使用方按领域语义实现或经知识集规则承接，引擎
只承载「规则数据 + 注册谓词 + 校验入口」。

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
    description="写入小说正文文件",
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
    ctx, "gate", {"tool": "write_file", "summary": "写入卷1正文"},
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

## 扩展纪律

1. 新增能力优先走扩展点（注册/接口/配置），不改引擎核心；
2. 高风险的**行为级改动**默认带配置开关 + 新旧路径并存，一键回退；
3. 事件协议演进：payload 增量加字段不破坏（step_id/round_id/parent_step_id
   语义长期稳定）；
4. 数据/配置 schema 演进：加字段带默认值兼容，废弃字段告警不硬删；
5. 领域包独立 semver 版本；各包目录物理独立、可单独发布
   （pyproject 多包布局，搬目录零重构）。

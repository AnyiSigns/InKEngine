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
| 域窗口归属 | `components.domain_window.GroupResolver` | 注入 group_of 函数 | 投影/归档 |
| 评审-收敛 | `components.review.Reviewer`/`Regenerator`/`WebVerifier` | 实现协议（小说实现 `NovelReviewer`/`NovelRegenerator` 在 `novel_harness.review`） | `run_review_convergence` 循环 |
| 收敛策略 | `components.review.ConvergencePolicy` | 换策略类 | 循环决策 |
| 上下文调配 | `context.BudgetAllocator`/`FusionHook` | 换分配策略/注册融合钩子 | `ContextMixer` 装配 |
| 世界状态提取 | `novel_harness.world_state.StateChangeExtractor` | 实现协议（默认 LLM 版） | 状态更新应用 |
| 写时校验 | `novel_harness.world_state.FingerprintVerifier` | 实现协议（默认跳过） | `run_world_precheck` |
| 门控分级/卡模型 | `components.review_card` | 注册表 + 校验器 | 卡回路 |
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

## 5. 评审-收敛（D9）

```python
from ink_engine.components.review import MaxRoundsConvergencePolicy
from ink_engine.novel_harness.review import (
    NovelReviewer, NovelRegenerator, run_review_convergence,
)

result = await run_review_convergence(
    candidates,
    reviewer=NovelReviewer(llm=...),
    regenerator=NovelRegenerator(llm=...),
    policy=MaxRoundsConvergencePolicy(threshold=0.75, beam=2, max_rounds=2),
    web_verifier=MyWebVerifier(),  # 评审存疑声明时触发（博查等宿主实现）
)
```

评审器/再生成器失败返回中性分/原候选（fail-open），不阻断主流程。

## 6. 上下文调配器（D7）

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

## 7. 世界状态层（D8）

```python
from ink_engine.novel_harness.world_state import (
    LLMStateChangeExtractor, WorldState, run_world_precheck,
)

world = WorldState()                                   # 纯内存模型
extractor = LLMStateChangeExtractor(llm=...)           # 换提取器 = 实现协议
changes = await extractor.extract(text, world=world)   # best-effort
apply_state_changes(world, changes, at_chapter=3)

issues = run_world_precheck(world, text, verifier=MyFingerprintVerifier())  # fail-open
hits = scan_ripple(world, field="age")                 # 涟漪扫描
branch = branch_world_state(world, at_chapter=3)       # What-if 分支
```

落库边界：WorldState 为纯内存模型，`to_dict()` 输出 JSON 兼容 dict 供宿主
持久化；SQLAlchemy 落库与 derived_sync 派生同步由宿主承接（零宿主依赖）。

## 8. 钩子与策略接口汇总

- **写时预检钩子**（D6）：确定性规则 + LLM 判定，注册制；默认 fail-open，
  关键场景可配置 fail-closed；
- **执行预算钩子**（E1）：GROUP_STEP_CAPS/tool_round_limit/字符预算为
  声明式配置（全局/书籍级），策略抛 BudgetExceededError 终止；
- **门控分级注册表**（D3）：L1/L2/L3 + 用户可配置 overrides，
  `gating_tier_of` 用户覆盖 > 注册表 > L2 默认；
- **融合钩子**（D7）：LLM「调酒师」按需触发（不默认），失败回退确定性组装。

## 9. 工具执行环境（沙箱 + 权限门禁 + 挂卡审批）

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

**挂卡审批**（`approve_before_execute`/`approve_batch`，D3 gate 卡标准包装）：

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
3. 事件协议演进：payload 增量加字段不破坏（step_id/round_id 语义长期稳定）；
4. 数据/配置 schema 演进：加字段带默认值兼容，废弃字段告警不硬删；
5. 领域包独立 semver 版本；各包目录物理独立、可单独发布
   （pyproject 多包布局，搬目录零重构）。

# InkEngine 墨引擎（engine-core + engine-components + engine-novel-harness）

TextForge 自研小说生成引擎，替代 langchain/langgraph 依赖。
以 TextForge 为基底、零反向依赖的独立 Python 包：引擎只提供执行机制，
不约束策略；机制在内核，策略在领域/业务层。

- `ink_engine.core`（engine-core）：纯机制引擎内核——图执行/checkpoint/事件流/
  interrupt/存储/补丁链/LLM/安全剥离/沙箱与审批原语（唯一 seam，API 即协议）；
- `ink_engine.components`（engine-components）：共享组件包——回合步骤 /
  审批卡 / 域窗口 / 评审收敛，harness 组件库，可组合可替换；
- `ink_engine.novel_harness`（engine-novel-harness）：叙事领域包——
  叙事语义 + 评审-收敛 + 上下文源构建器，随引擎发布的参考 harness；
- `examples/`：可独立运行的示例（TextForge 为完整参考实现）；
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
| `graph.py` / `executor.py` | 图定义 DSL + 执行循环（checkpoint 版本链/恢复重放/interrupt 注入/预算钩子/异常策略） |
| `state.py` / `patch_chain.py` | 状态通道 + reducer 注册表；内容型补丁链（append/replace/delete + assemble/rebase/branch） |
| `events.py` | 事件信封（协议版本化 + 传输接口化，负载对齐前端协议 v2） |
| `storage.py` | 通用存储服务（checkpoint/执行事件日志/structured records，内存/sqlite/postgres） |
| `interrupt.py` | interrupt 挂起/注入重入（弹卡审批一等能力） |
| `approval.py` | 工具调用前挂卡审批标准姿势（approve_before_execute/approve_batch，包装） |
| `permissions.py` / `sandbox.py` / `tool_pipeline.py` | 工具执行环境：权限门禁（默认拒绝）+ fs/进程沙箱 + 执行流水线 |
| `fanout.py` | 发散并行原语（部分失败剔除） |
| `budget.py` | 执行预算钩子（步骤/轮数上限由业务注册策略） |
| `registry.py` | 节点/边注册表（业务自定义节点，引擎不封闭） |
| `security.py` / `logging.py` | 敏感信息剥离；结构化 JSON 日志 + trace_id 链路追踪 |
| `state_machine.py` | 通用状态机原语（core 侧：状态/事件/转换/日志） |
| `memory.py` | 记忆策略原语（MemoryStore 协议/召回策略/存储后端实现） |
| `tiers.py` | 模型分层挡位（挡位配置解析/按挡位建链/调用统计钩子） |
| `context.py` | **上下文调配器（源元数据/预算分配/加权组装/融合钩子/行为开关支撑）** |
| `llm/` | AsyncLLM + OpenAI 兼容适配器 + 工具 schema + fallback 链 + embedding |

### 共享组件包（ink_engine.components，harness 组件库）

| 模块 | 职责 |
|---|---|
| `round_steps.py` | 回合步骤协议（step_id 累积/重放，断线续流种子） |
| `review_card.py` | 四类审批卡数据模型 + 门控分级注册表 |
| `domain_window.py` | 域上下文窗口投影/归档摘要 |
| `review.py` | 测试时专才化评审-收敛原语（评审器/收敛策略/web 验证钩子） |

### 叙事领域包（ink_engine.novel_harness，随引擎发布的参考 harness）

| 模块 | 职责 |
|---|---|
| `narrative_state.py` | 叙事状态定义（伏笔 set→advancing→resolved/stalled 纯函数） |
| `world_state.py` | 世界状态层（角色状态机/知识矩阵/因果链/伏笔矩阵 + 校验 + 涟漪扫描 + What-if 分支） |
| `candidate_mix.py` | 候选段落级混合（进阶：跨候选取段落组装 + 来源留痕） |
| `review.py` | 小说评审-收敛循环（段落级评审 + 再生成 + web 验证注入） |
| `context_sources.py` | **上下文调配器源构建器（章节/角色/正文/支线/记忆/风格/反馈/世界状态 → ContextSource）** |

> 旧路径 `ink_engine.domain_novel` 保留为兼容别名（re-export），新代码请使用
> `ink_engine.components` / `ink_engine.novel_harness`。

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
`python examples/context_mixer_demo.py`（调配器多源融合）。

## 核心概念

- **执行即日志，状态即快照**：事件流 = append-only 执行事件日志；
  checkpoint = 快照；恢复/断线续流 = 快照 + 增量日志重放；
  编辑重放 = 日志截断 + 新分支。
- **补丁链**：变化 = 补丁（append-only），状态 = 基础 + 补丁链，
  取用 = 组装（full/base_only/partial），压缩 = 压扁（rebase，非破坏性）。
- **interrupt**：节点内 `await ctx.interrupt(key, payload)` 声明中断点，
  引擎持久化中断状态并挂起；外部注入值后从该节点重入（弹卡审批）。
- **事件即协议**：节点 `ctx.emit(type, payload)` 产出事件流，负载直接
  对齐前端协议 v2（step_id/round_id），无框架事件中间层。
- **上下文调配器**：多源上下文（章节/记忆/角色/世界状态…）按
  预算加权融合——确定性层零 LLM 调用，融合钩子按需升级（失败自动回退）。
- **世界状态层**：创作关键状态显式化（角色状态机/知识矩阵/因果链/
  伏笔矩阵），写时校验 + 涟漪扫描 + What-if 分支。
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
- 不做通用进程管理器与 MCP（进程型工具以受限沙箱形态进内核：
  超时 kill/退出码/输出截断/环境清理，默认拒绝兜底）；
- 不做多 worker 分布式执行（单进程 asyncio，部署层负责扩展）。

## License

MIT（见 LICENSE；pyproject license 字段同标；拆独立仓库时随带）。

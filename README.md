# InkEngine 墨引擎内核（engine-core）

TextForge 自研小说生成引擎内核（v4 计划 E1），替代 langchain/langgraph 依赖。
以 TextForge 为基底、零反向依赖的独立 Python 包：引擎只提供执行机制，
不约束策略；机制在内核，策略在领域/业务层。

## 安装

```bash
# 引擎零业务依赖；可选存储后端驱动
pip install -e .            # 内核（纯标准库）
pip install -e ".[sqlite]"  # sqlite 存储后端
pip install -e ".[postgres]"  # postgres 存储后端
```

## 模块总览

| 模块 | 职责 |
|---|---|
| `graph.py` | 图定义 DSL（节点/边/条件边/嵌套图/图路径/终止信号） |
| `executor.py` | 执行循环（checkpoint 版本链/恢复重放/interrupt 注入/预算钩子/异常策略） |
| `state.py` | 状态通道 + 字段级 reducer 注册表（累积型/内容型/合并型/覆盖型） |
| `patch_chain.py` | 内容型补丁链（append/replace/delete + assemble/rebase/branch） |
| `events.py` | 事件信封（协议版本化 + 传输接口化，负载对齐前端协议 v2） |
| `storage.py` | 通用存储服务（checkpoint/执行事件日志/structured records，内存/sqlite/postgres） |
| `interrupt.py` | interrupt 挂起/注入重入（弹卡审批一等能力） |
| `fanout.py` | 发散并行原语（部分失败剔除） |
| `budget.py` | 执行预算钩子（步骤/轮数上限由业务注册策略） |
| `registry.py` | 节点/边注册表（业务自定义节点，引擎不封闭） |
| `security.py` | 敏感信息剥离（checkpoint 永不落 api_key） |

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

## 测试

```bash
pytest                     # 单测全绿（性能门禁/精确基准默认排除，防 CI 抖动误报）
pytest -m benchmark        # E1 性能门禁断言（checkpoint 写入/事件吞吐/补丁组装/压扁）
pytest --benchmark-only -m benchmark  # 精确基准统计（pytest-benchmark）
POSTGRES_TEST_URL=... pytest -m postgres  # 真实 postgres 后端冒烟
```

E1 验收基准：checkpoint 写入 <10ms、事件流吞吐 ≥500 事件/s、
100 补丁组装 <5ms、rebase <10ms（本地实测：0.94ms / 千级 eps / 90µs）。

## 运维说明

- **存储 schema 不迁移**：引擎表结构随版本演进，既有库升级后启动期自检会给出
  明确指令——删除库/表后重启（`DROP TABLE checkpoints, event_log, records;`
  或删除 db 文件），历史数据不保留（引擎定位：不承诺存量数据兼容）。
- **日志**：引擎遵循标准 logging 语义（不抢占宿主日志体系）；需要开箱即用的
  JSON 日志时由宿主显式调用 `configure_engine_logging()`（examples/ 已调用）。

## 边界（引擎不做）

- 不含业务逻辑（路由/域专才/门控分级在 TextForge 业务层注册挂载）；
- 不做通用 agent 能力（MCP/进程型工具/权限引擎等）；
- 不做多 worker 分布式执行（单进程 asyncio，部署层负责扩展）。

## License

MIT（引擎随 TextForge 仓库发布；拆独立仓库时随带 LICENSE）。

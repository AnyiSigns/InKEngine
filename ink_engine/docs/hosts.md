# InkEngine 宿主接入指南

引擎作为**可嵌入的受控自进化运行时**交付：宿主 = 任何「实现 Host
五件套 + 提供 AssemblyRecipe 配方」的进程形态——web 服务、CLI、桌面
应用、stdio 进程皆为宿主之一（web 只是形态之一，不是绑定形态）。
当前参考宿主：InKling 受控自进化智能体（inkling/，Tauri 桌面壳 +
嵌入式 Python 引擎桥）与 stdio_host（examples/stdio_host.py，最小
非 web 宿主）。

## 三步挂载

嵌入引擎不再需要复制宿主装配配方：

```python
from ink_engine.core.runtime import AssemblyRecipe, Runtime, ToolWiring
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs

class MyHost:  # Host 五件套（归属宿主：后端/路径/进程锁/配置/密钥/传输形态）
    async def create_storage(self) -> Storage: ...      # 存储工厂（sqlite/内存/…）
    async def resolve_llm(self) -> AsyncLLM | None: ... # 模型解析（配置/密钥归宿主）
    def interrupt_policy(self) -> InterruptPolicy: ...  # 审批策略（直过/超时表）
    def build_transport(self) -> EngineTransport: ...   # 传输工厂（SSE 桥/JSON 行）
    async def close(self) -> None: ...                  # 关停钩子（资源回收）

recipe = AssemblyRecipe(
    set_id="default",
    seeds=[("boot", build_boot_seed_entries)],          # 种子按名注入
    harness_definitions=[boot_harness_definition()],
    event_type_specs=list(BOOT_EVENT_TYPES),
    entity_specs=[...],                                 # 协作者目录（可选）
    ui_spec=BOOT_UI_SPEC,                                # 界面布局树数据
    ui_allowed_channels=("state", "events.reply_token"),
    ui_allowed_components=("message_list", "agent_input"),
    ui_allowed_theme_tokens=("bg", "fg", "accent"),
    tool_wiring=ToolWiring(
        self_specs=self_tool_specs,                      # 工具三路分发（内省/自指/声明式）
        self_executor_factory=make_self_executor,
        self_operation_of=operation_of,
    ),
    approval_levels={PatchKind.THEME: ApprovalLevel.L0}, # 补丁分级审批表
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

## Host 五件套契约

| 方法 | 返回 | 职责 |
|---|---|---|
| `create_storage()` | `Storage` | 持久化工厂（memory/sqlite/postgres/自定义）——后端/路径/进程锁归宿主 |
| `resolve_llm()` | `AsyncLLM \| None` | 模型解析——配置/密钥/挡位归宿主（None = 无模型，装配仍可成功） |
| `interrupt_policy()` | `InterruptPolicy` | 审批策略——直过名单/超时窗口/门控分级 |
| `build_transport()` | `EngineTransport` | 事件传输工厂——SSE 桥/JSON 行/内存收集 |
| `close()` | `None` | 关停钩子——资源回收（存储/会话/进程） |

关键语义：

- 决议回流通道**不在协议内**：web 的 resume 端点、stdio 的 stdin 循环
  是宿主自己的请求入口；Runtime 提供 `resume_run` 样板（挂起卡 → 锚点
  → 注入重入）两宿主共用；
- Host 实例方法可能被并发调用（多次 ainvoke），宿主实现须线程/协程安全；
- `close()` 在 Runtime.stop 的收尾序列中最后调用（顺序：拒新 → 排空
  → 关 MCP → 关存储 → 宿主钩子）。

## AssemblyRecipe 22 字段

装配决策全部数据化（可校验、可替换）；字段注解类型只允许核心类型与
鸭子协议（架构门禁白名单强制，宿主类型不得进入配方）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `set_id` | `str` | 装配集标识（命名空间/路由） |
| `seeds` | `list[tuple[str, SeedProvider]]` | 种子提供器（boot 自举种子等，配方直注） |
| `harness_definitions` | `list[HarnessDefinition]` | harness 能力包（图数据 + 工具清单） |
| `event_type_specs` | `list[EventTypeSpec]` | 事件类型（schema/renderer/system） |
| `entity_specs` | `list[EntitySpec]` | 实体基线（协作者目录，进 EntityRegistry） |
| `ui_spec` | `dict \| None` | 界面布局树数据 |
| `ui_allowed_channels` | `tuple[str, ...]` | 界面绑定通道白名单（默认仅 `state`） |
| `ui_allowed_components` | `tuple[str, ...]` | 界面组件白名单 |
| `ui_allowed_theme_tokens` | `tuple[str, ...]` | 主题 token 白名单 |
| `tool_wiring` | `ToolWiring \| None` | 工具三路分发（内省/自指/声明式 executor 接线） |
| `vetting_static_hooks` | `list[StaticHook] \| None` | 外部工具 vetting 静态钩子 |
| `vetting_l2_hook` | `Callable \| None` | L2 沙箱验证钩子（无则 L2 fail-closed） |
| `approval_levels` | `dict[PatchKind, ApprovalLevel]` | 补丁分级审批表（L0 直过/L1 弹卡/L2 沙箱） |
| `retrieval_sources` | `list[Callable[[Any], Retriever]]` | 检索源工厂（接收装配产物返回 Retriever） |
| `apply_targets` | `dict[PatchKind, Callable[[Any], ApplyTarget]]` | 补丁活跃态应用目标工厂 |
| `graph_recipe` | `Callable[[GraphRecipeContext], Graph] \| None` | 图配方（装配期编译为可执行图） |
| `on_reverted` | `Callable \| None` | 补丁回退通知钩子 |
| `convergence_provider` | `Callable[[], ConvergenceHook \| None] \| None` | apply_patch 前置收敛闸门（依赖倒置） |
| `run_options` | `RunOptions \| None` | 执行域选项覆盖（字段级并入装配默认） |
| `compress_policy` | `CompressionPolicy \| None` | 回合内上下文压缩策略（默认 ThresholdCompressionPolicy） |
| `verify_retry_limit` | `int` | VTM 输出验证重做上限（0 = 不启用验证器） |
| `emit_timeline_events` | `bool` | 组装时间线事件开关（UX 指标：user_msg → 组装 → 执行） |

## Runtime 生命周期

```
uninitialized ──boot(幂等)──▶ running ◀──resume── paused
                                 │  ▲                │
                                 │  │                │ pause
                                 ▼  └────────────────┘
                               stop（幂等，拒新→排空→关 MCP→关存储→宿主 close）
```

- `begin_run()`/`end_run(ticket)`：在途 run 登记——pause 拒新不打断
  在途、stop 排空在途后才关停；
- `rebuild_engine()`：引擎重建（缓存键 = 模型身份 + 存储身份 + 工具
  结构身份——配置/工具表变更才重建，避免无谓重建）；
- `resume_run(thread_id, inject)`：审批决议重入样板（挂起卡 → 锚点 →
  `ainvoke(resume_from, inject)`）；
- 装配动作是机制（不可被补丁链修改），装配决策是数据（宿主可换）。

## 事件传输（EngineTransport）

```python
from ink_engine.core.events import EngineEvent

class JsonLinesTransport:  # stdio_host 形态
    async def send(self, event: EngineEvent) -> None:
        line = json.dumps(event.to_dict(), ensure_ascii=False)
        self._stdout.write(line + "\n")
        await self._stdout.drain()
```

- 引擎侧只有 `send(event)` 一个接口；SSE 桥 = 把事件转 SSE 帧后经
  HTTP 连接推送（Forge 形态）；CollectorTransport = 内存收集（测试）；
- `EngineEvent` 字段：type/payload/step_id/parent_step_id/round_id/node/
  graph_path/seq/trace_id/thread_id/version（协议版本化，from_dict 校验）；
- 负载直接对齐前端协议（step_id/round_id/parent_step_id 语义长期稳定），
  无框架事件中间层；事件类型 = 数据（EventTypeSpec 注册表驱动前端渲染）。

## 工具三路分发（ToolWiring）

| 路 | 来源 | 说明 |
|---|---|---|
| 内省 | `introspection_tool_specs` + `make_introspection_executor` | 六个 inspect_* 只读观察元工具 |
| 自指 | `self_tool_specs` + `make_self_executor` + `operation_of` | 6 契约演化元工具（propose_patch/apply_patch/revert_patch/propose_domain_manifest/search_tools/request_tool，随机制层走补丁链） |
| 声明式 | `DeclarativeToolExecutors`（宿主注册端点执行体） | 业务工具（端点受限 + 强制权限） |

三路统一进工具表，走同一 `ToolPipeline`（门禁→沙箱→守卫→审批→审计→
观察）；`operation_of` 是统一提取器判定来源（防领域生成器被误拒）。

## MCP 挂载

```python
from ink_engine.core.mcp_client import McpClientManager, McpServerConfig, McpTransport

manager = McpClientManager()
config = McpServerConfig(
    id="ts_seed", transport=McpTransport.STDIO,
    command="node", args=("examples/ts_seed_pack/server.mjs",),
)
await manager.connect(config)
await manager.import_tools("ts_seed", source=config.source, vetting=my_vetting)
runtime.rebuild_engine()          # 工具表变更 → 重建引擎使工具当回合可用
```

外部生态只经 MCP 消费（插件市场、跨语言种子执行件、第三方 server）；
工具权限统一 `mcp:call:<server_id>`，进工具表走统一流水线。

## 宿主接入检查清单

1. 五件套齐备且方法签名与协议一致；
2. 配方字段全部为核心类型/鸭子协议（架构门禁白名单）；
3. 领域知识（规则/样例/谓词）由产品自写并经配方 `seeds` 或
   `seed_knowledge_set` 注入（样例库 fixture 全绿为非谈判项）；
4. 事件传输实现 `send()` 且处理背压/断连；
5. LLM 配置与密钥归宿主（引擎不持有）；
6. 审批策略与补丁分级审批表符合产品预期；
7. 工具执行体经 executor 钩子注册，重路径边界不变；
8. stop 序列：拒绝新 run → 排空在途 → 关 MCP → 关存储 → 宿主 close；
9. 传输层与 resume 端点形态一致（web=resume 端点，stdio=stdin 循环）。

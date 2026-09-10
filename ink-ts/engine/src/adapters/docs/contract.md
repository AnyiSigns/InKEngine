# adapters 域（契约文档）

**路径**：`engine/src/adapters/` · **层**：L3 引擎 IO 真实现 · **验证**：
`vitest run --root engine`（`test/adapters/**`、`test/e2e/**`）+ `tsc -p engine/tsconfig.json`

## 定位

kernel/core 以 seam（接口）声明一切副作用（存储/LLM/网络/进程/时间/随机），
本域承载这些端口的可选真实实现，经 DI 由宿主装配注入、可整体替换。属
engine 包而非宿主——宿主只「选哪个适配、读配置、注入 seam」，不实现厂商
适配与存储驱动（CODING §1）。

## 目录语义

- `boot/`：自举引导数据资产（系统提示词/初始 UI/事件类型/自举 harness/
  元工具清单），宿主配方直注。
- `llm/`：LLM 协议适配器（openai_compatible / openai_responses /
  anthropic_messages），自写 fetch 传输 + SSE 解析，零厂商 SDK；注册表
  按配置选择（`create_llm`），协议名 + 厂商别名 + 兼容别名。
- `mcp/`：MCP client 全套（配置/内置注册表/convert/三传输/RPC 通道/会话/
  进程监督/管理器/fs seam/结果收敛），自写 JSON-RPC，零第三方 SDK。
- `storage/`：core `Storage` seam 的 memory/sqlite 后端 + `create_storage`
  连接串工厂；三通道（checkpoint 版本链/事件日志/records）+ 快照恢复。
- `_lock.ts`：AsyncLock 基础面（mcp 与 storage 共用，收敛单文件）。

## 对外契约面

`src/index.ts`「3. adapters 工厂面」组：boot 种子导出、`export * from
adapters/storage`（工厂 + 两后端）、llm registry 四函数（create_llm/
register_adapter/adapter_names/get_adapter_class）、mcp 全量（SpawnSeam
与 kernel/sandbox 同名冲突 → 别名 McpSpawnSeam 导出）。

## 数据形态 / Seam

- 存储三通道记录形态（CheckpointRecord/ChainLink/EngineEvent/JsonRecord）
  真源在 core；本域只实现 async seam，不新增第二套语义枚举。
- LLM：AsyncLLM/LLMConfig/LLMChunk 契约在 `kernel/llm`；本域给协议适配。
- MCP：声明式工具定义/执行体注册表在 `core/declarative_tools`；vetting
  契约（ToolSource/VettingVerdict/FsSeam）在 `kernel/tool_vetting`。

## 边界（不做）

- 不实现机制语义（审批/补丁链/审计/闸门/沙箱判定归 engine core）；
- 不感知宿主/产品（无 tauri/electron/react/inkling 词汇）；
- postgres 后端未移植（工厂显式报错）；Gemini 适配器未迁移。

## 不变式

- 依赖单向：adapters 只 import core/kernel 的公共面与 seam；禁反向 import
  `core/**/_*.ts`、`kernel/**/_*.ts`（例外须目标文件头标注「跨域契约模块」）。
- 序列化契约三后端同口径（严格/宽松判定收敛 `_serialize.ts` 单实现），
  杜绝「内存后端静默通过、切库即错」。
- 超时/帧上限/凭据遮蔽 fail-closed：MCP 帧上限 16 MiB、连接 30s/调用 60s、
  McpServerConfig to_dict 缺省 `[REDACTED]`。

## 装配与消费

宿主（hosts/lib）装配期：`create_storage(conn)` → 注入 Storage seam；
`create_llm(config)` → 注入模型链；`McpClientManager` + 
`register_mcp_executor(executors, manager)` → 声明式工具 mcp 端点；
boot 种子 → AssemblyRecipe 直注。web/renderer 不静态 import 本域
（运行时经 cli serve 通道）。

## 测试

`test/adapters/llm/`（协议/流式/重试/空闲超时）、`test/adapters/mcp/`
（配置/转换/注册表/三传输/监督/管理器）、`test/adapters/storage/`
（memory/sqlite/快照/分页）、`test/adapters/boot/`、`test/e2e/`。

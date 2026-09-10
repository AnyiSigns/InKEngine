# adapters/（IO 端口真实装）

L3 引擎的 IO 真实现层：kernel/core 以 seam（接口）声明副作用边界，本层承载
存储 / LLM 协议 / MCP client / 引导种子的可选实现，经 DI 由宿主装配注入，
可整体替换。本层允许 `node:*` 与驱动必需的第三方依赖；禁止反向 import
`core/**/_*.ts`、`kernel/**/_*.ts`（公共 seam 例外须在目标文件头标注
「跨域契约模块」）。

## 文件
- `_lock.ts` — 进程内异步互斥锁（AsyncLock，镜像 asyncio.Lock）：
  mcp/supervised 会话串行化与 storage/_base 内存后端读写串行化共用的
  基础面（`run` / `acquire_run` 两种调用面语义一致）。

## 子目录
- `boot/` — 自举引导数据资产（系统提示词 / 初始 UI / 事件类型 / 自举
  harness / 元工具清单），宿主配方直注消费。
- `llm/` — LLM 协议适配器（openai_compatible / openai_responses /
  anthropic_messages），自写 fetch 传输 + SSE 解析，零厂商 SDK；
  协议注册表按配置选择。
- `mcp/` — MCP client（配置 / 内置 server 注册表 / 三传输 / 会话与
  进程监督 / 连接管理器），自写 JSON-RPC，零第三方 SDK。
- `storage/` — 存储后端（memory / sqlite）+ `create_storage` 连接串工厂，
  实现 core `Storage` async seam 三通道。

## 依赖方向
- 上游（import）：core/kernel 的 seam 契约与数据形态——`core/storage`、
  `core/events`、`core/errors`、`core/json`、`core/security`、
  `core/declarative_tools`、`core/event_types`、`core/harness`、
  `core/knowledge_set`、`core/schema`、`kernel/llm`、`kernel/tool_vetting`、
  `kernel/interrupt`。
- 下游（被消费）：`src/index.ts` 公共面（adapters 工厂面分组）；
  `hosts/lib`、`hosts/cli` 经公共面取用；引擎内机制层不 import 本层
  （kernel → adapters 单向依赖目标态）。测试在 `engine/test/adapters/`
  与 `engine/test/e2e/`。

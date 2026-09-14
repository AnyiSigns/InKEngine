# mcp_client 端口提供方（kind=ports）

端口实装位：exec_envelope（MCP 客户端 stdio/进程 IO 实装位，评审 2026-09-14
裁决）。声明真源 = 本目录 `spec.json`（kind=ports、faces.logic target=host、
data.port.implemented=exec_envelope）；实现随插件同住于 `faces/logic/`
（config/registry 配置与内置 server 注册、convert/_result 声明转换、_framing/
_rpc_channel 帧协议与消息通道、stdio/http/memory 三传输、session/supervised
会话与 stdio 进程监督、manager 连接管理与执行器注册），同住测试
`faces/logic/*.test.ts` 经 `vitest run --root plugins` 执行。

## 数据从哪进 / 能碰什么端口

- 装载：hosts/lib 装配层按 manifest「ports」段动态 import 默认导出工厂，
  产出 { McpClientManager, register_mcp_executor, ... } 注入引擎 seam（与旧
  `@ink-ts/engine` 的 McpClientManager 同一语义 slot）。
- 依赖：exec_envelope 端口（stdio/进程 IO 实装位）；FsSeam/FileOps 经
  dock/ports/exec 契约取型、node:fs/os/path 实现（create_node_fs_seam 观察模式
  seam）。
- 边界：只做 MCP 客户端与 stdio/HTTP/内存传输，不做市场治理（市场候选声明
  在 `plugins/mcp/*`，kind='mcp'）；`plugins/ports/mcp_client` 与 `plugins/mcp`、
  `endpoints/mcp`（原生服务器二进制）职责分工不同，勿混读（PLUGINS.md §2.2bis
  二义说明）。
- 失败语义：RpcError/McpConnectionLost/RpcTimeout/TaskCancelled 结构化错误族，
  连接丢失 is_connection_lost 判定，超时/边界 fail-closed。

## 与引擎的关系

适配器下沉前 engine/src/adapters/mcp（S2 整目录迁出）；引擎公共面停供
McpClientManager、StdioMcpTransport、register_mcp_executor 等符号，仓库从
公共面经 exec_envelope 取型（SpawnSeam/FileOps/EngineEvent 等契约）。
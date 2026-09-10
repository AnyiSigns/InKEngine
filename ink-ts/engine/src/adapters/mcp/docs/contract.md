# adapters/mcp — MCP client（契约文档）

> 就近导航：本目录 `README.md` · 层权威：
> `docs/subsystems/engine.md` + `engine/AGENTS.md` · 移植源：
> Python `ink_engine/core/mcp_client.py`

## 定位

自写 MCP 客户端（零第三方 SDK）：server 连接配置、内置注册表、三种传输
（stdio / Streamable HTTP / 内存端口）、JSON-RPC 消息通道、会话句柄与
stdio 进程监督、连接管理器与声明式工具分发执行器。导入工具必经 vetting
闸门，未放行不进入工具表（fail-closed）。

## 文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `index.ts` | 公开面（镜像 Python `__all__` + 传输级内部形态） |
| `config.ts` | McpServerConfig / StdioRestartPolicy：凭据遮蔽（repr + to_dict 缺省 `[REDACTED]`）、from_dict fail-closed、http url 仅 http/https |
| `registry.ts` | 内置 server 注册表（inkling_exec/inkling_shell → ink_ts_mcp 二进制）：权威字段锁定，仅环境连接位可注入；未知 id 返 null |
| `convert.ts` | 工具 → 声明式定义（缺 name 拒绝、权限 `mcp:call:<server_id>`）、vetting 清单、探针参数派生（只取带默认值可选参数） |
| `_types.ts` | McpToolRecord/McpCallResult（2.x/1.x 双字段兼容）、McpJsonRpcMessage、McpMessagePort、RawMcpSession、SpawnedMcpProcess/SpawnSeam、AsyncQueue |
| `_errors.ts` | McpToolImportError/RpcError/McpConnectionLost/RpcTimeout/TaskCancelled + is_business_error/is_connection_lost 分类判据 |
| `_framing.ts` | Content-Length / JSON Lines 双分帧（读自适应、写按配置）、帧上限 16 MiB fail-closed、超时常量（连接 30s/调用 60s）、ByteReader/read_messages、握手常量（协议 2025-03-26） |
| `_rpc_channel.ts` | RpcChannel：id 配对挂起表、server→client 应答（ping/roots/list，未知 -32601）、通知忽略、断流收敛挂起表、create_message_duplex_pair 成对端口 |
| `stdio_transport.ts` | 自写 stdio 传输：spawn（windowsHide、shell:false）+ 握手 + 双工分帧（响应 JSON Lines 时写侧同步切换）+ stderr 结构化日志转发 + 确定性关闭；create_node_spawn_seam 默认 seam |
| `http_transport.ts` / `_http_io.ts` | Streamable HTTP：每请求一 POST、mcp-session-id 会话头、202 Location 拉流（限 http/https）、响应体字节上界、IdleAbort 空闲中止、SSE data 切分 |
| `memory_transport.ts` | 内存传输：宿主注入 ServerFactory 消息端口，与 stdio 共用 RpcChannel |
| `session.ts` | McpSessionHandle 抽象 + SdkSession：按配置开真实会话；业务结论收敛（is_error/JSON-RPC error → 「MCP 工具执行失败」文案，连接层异常透传） |
| `supervised.ts` | SupervisedStdioSession：崩溃探测 + 按策略拉起；拉起成功不重试原调用（防非幂等副作用），断流类重试一次；连续重试耗尽达阈值熔断 fail-closed；业务错误/取消穿透 |
| `manager.ts` | McpClientManager：会话生命周期 + import_tools（vetting 必经，仅 VERIFIED）+ 影子观察证据 + dispatch 按 server_id 路由（未连接拒绝）+ register_mcp_executor |
| `_fs_seam.ts` | FsSeam 的 node:fs 真实装（供 ToolVetting.shadow_run 写虚拟化） |
| `_result.ts` | 结果文本收敛：is_error 双字段、content dict/对象双形态、非文本项标注类型、DEFAULT_MAX_RESULT_CHARS 截断 |

## 对外契约面

公共面 `src/index.ts` MCP 组全量导出（含 type SpawnSeam as McpSpawnSeam
别名——与 kernel/sandbox 的 SpawnSeam 撞名，按语义保留 core 名）。

关键调用面：
- `McpClientManager.connect(config) / connect_builtin(server_id, overrides)
  / disconnect / close_all / register_session / list_servers / imported_tools`；
- `import_tools(server_id, {source?, vetting?, signature?, shadow_workdir?})`
  → DeclarativeToolSpec[]（协议违规工具逐项跳过不击穿整次导入）；
- `register_mcp_executor(executors, manager)`：把 EndpointType.MCP 执行体
  注册进 `core/declarative_tools` 执行体注册表（宿主装配时调用一次）；
- `builtin_mcp_server_config(server_id, overrides)`：overrides 仅允许连接
  参数键，权威字段改写与未知键抛 GraphDefinitionError。

## 数据形态

- McpServerConfig：id/transport(http|stdio|in_memory)/url/headers/command/
  args/env/source/signature/restart_policy/stdio_framing/server_factory
  （非序列化字段）；`to_dict({redact_credentials})` 缺省遮蔽、false 供
  配置往返还原重连。
- StdioRestartPolicy：max_retries 缺省 2、backoff 缺省 1.0s、
  circuit_break_threshold 缺省 3（负数/阈值 <1 拒绝）。
- DeclarativeToolSpec 映射：name/description/input_schema 原样、
  endpoint=mcp、endpoint_config={server_id}、permissions=[`mcp:call:<sid>`]、
  meta.mcp_server。

## Seam 与 IO 边界

- SpawnSeam：默认 node:child_process.spawn；测试注入内存流对假进程零进程
  验证协议。
- FetchLike：默认 globalThis.fetch；注入假实现零网络。
- McpMessagePort + ServerFactory：in_memory 传输的消息级双工端口
  （create_message_duplex_pair 构造成对端口）。
- FsSeam：观察探针的工作目录副本/清理（node:fs 同步后端）。
- 超时/上限 fail-closed：CONNECT_TIMEOUT 30s、CALL_TIMEOUT 60s、
  MAX_STDIO_FRAME_BYTES 16 MiB（读侧帧、stderr 无行终止残段同口径）。

## 错误语义与监督

- 业务错误（server 受理后 is_error/JSON-RPC error）不触发拉起、不谎报
  崩溃；连接断流（子进程退出/EOF/管道破裂）→ 拉起 + 重试一次原操作
  （stdio 仅承载确定性纯函数工具）；TaskCancelled 原样穿透。
- 熔断：连续「重试耗尽」计分，达 circuit_break_threshold 打开后拒绝调用
  直到重连；拉起成功清零。

## 装配与消费

宿主装配：内置 server 经 `connect_builtin` + 环境连接位注入（hosts/lib
定位 ink_ts_mcp 二进制后以 command/args 覆盖）；导入的声明式工具并入工具
表（vetting 观察：VERIFIED 后并入 shadow_run 探针，证据经
`shadow_evidence(server_id?)` 查询，恒 untrusted）；`register_mcp_executor`
把 dispatch 接入声明式工具流水线。

## 不变式与门禁

- 会话按 server_id 路由：未挂载的 server 不可被调用（dispatch fail-closed）。
- 观察探针绝不臆造必填参数（宁可在远端诚实失败，不产生不可控副作用）。
- 超限标注：stdio_transport.ts（385 行）/ http_transport.ts（381 行）按
  gate 规则头注豁免（状态机单段不可拆）。

## 测试

`test/adapters/mcp/`：config（序列化/遮蔽/from_dict）、convert、registry
（锁定字段）、stdio（分帧/握手/调用）、stdio_supervision（崩溃拉起）、
stdio_stderr_bound（残段上界）、supervised（熔断/业务穿透）、http_transport
（SSE/202/超时）、memory_transport（echo 全链路）、manager（导入/vetting/
分发）、共享桩 _helpers.ts。

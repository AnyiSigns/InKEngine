# mcp/（MCP client）

自写 MCP 客户端（镜像 Python `mcp_client.py`，零第三方 SDK）：连接配置与
内置 server 注册表、三种传输（stdio / Streamable HTTP / 内存端口）、JSON-RPC
消息通道、会话句柄与 stdio 进程监督、连接管理器与声明式工具分发执行器。

## 文件
- `index.ts` — 公开面（镜像 Python `__all__` + 传输级内部形态）。
- `config.ts` — `McpServerConfig`（可持久化连接配置）/`StdioRestartPolicy`
  （重启策略，保守缺省）；to_dict 缺省遮蔽凭据（`[REDACTED]`）；from_dict
  fail-closed；http url 仅接受 http/https。
- `registry.ts` — 内置 server 注册表（`inkling_exec` / `inkling_shell`，由
  `ink_ts_mcp` 原生二进制承载，Content-Length 分帧）：权威字段（id/transport/
  source/signature）不可被宿主覆盖，仅环境连接位可注入；未知 server_id 返
  回 null（fail-closed）。
- `convert.ts` — MCP 工具 → 声明式工具定义（缺 name 拒绝；权限统一
  `mcp:call:<server_id>`）；vetting 清单构造；观察探针参数派生（只取带
  默认值的可选参数，不臆造必填字段）。
- `_types.ts` — 内部形态：McpToolRecord/McpCallResult（2.x input_schema 与
  1.x inputSchema 双字段兼容）、JSON-RPC 消息、McpMessagePort（内存双工
  端口）、RawMcpSession（传输级会话能力）、SpawnSeam（spawn seam，测试注入
  假进程）、AsyncQueue。
- `_errors.ts` — 错误体系与分类判据：McpToolImportError（导入失败，继承
  GraphDefinitionError）/RpcError（JSON-RPC error）/McpConnectionLost
  （断流）/RpcTimeout/TaskCancelled（取消语义分置）；is_business_error /
  is_connection_lost 决定监督句柄是否拉起重试。
- `_framing.ts` — stdio 帧协议：Content-Length 与 JSON Lines 双形态（读侧
  自适应、写侧按配置）；帧上限 MAX_STDIO_FRAME_BYTES（16 MiB，超限
  fail-closed 断开）；连接/调用超时（CONNECT_TIMEOUT 30s / CALL_TIMEOUT 60s）；
  ByteReader + read_messages 解码循环；MCP initialize 握手常量。
- `_rpc_channel.ts` — JSON-RPC 消息通道：请求按自增 id 配对挂起表；
  server→client 请求应答 ping/roots/list（未知方法 -32601）；通知忽略；
  读侧 EOF/异常 → 挂起表全部以连接断流失败；`create_message_duplex_pair`
  供内存传输/测试构造成对端口。
- `stdio_transport.ts` — 自写 stdio 传输：node:child_process spawn（
  windowsHide，shell:false）+ initialize 握手 + 双工分帧 + stderr 结构化
  日志行转发（无行终止残段有上界，超限断开）+ 确定性关闭（kill/收尾有界
  等待）；`create_node_spawn_seam` 为默认 seam 实现。
- `http_transport.ts` + `_http_io.ts` — Streamable HTTP 传输：每请求一个
  POST（initialize/tools/list/tools/call/ping），响应单条 JSON 或 SSE 流；
  mcp-session-id 会话头回带；202 Accepted 按 Location 拉流（仅 http/https
  scheme）；响应体读取带字节上界（边读边计数超限即 cancel）；请求级空闲
  中止（IdleAbort）。
- `memory_transport.ts` — 内存传输：宿主注入 `ServerFactory`（消息级端口
  工厂），会话驱动与 stdio 共用 RpcChannel；内嵌 server/测试桩零网络。
- `session.ts` — 会话句柄：McpSessionHandle 抽象能力面（list_tools/
  call_tool/aclose）；SdkSession 按配置打开真实会话并收敛业务结论——
  JSON-RPC 业务拒绝与 is_error → 「MCP 工具执行失败」明确文案（不当作
  进程崩溃传播）；连接层异常透传交监督句柄。
- `supervised.ts` — stdio 进程监督句柄：调用失败视为进程崩溃，按重启策略
  拉起（max_retries 缺省 2、backoff 缺省 1s）；拉起成功不重试原调用（防非
  幂等副作用），连接断流类重试一次；连续「重试耗尽」达阈值（缺省 3）熔断
  打开（fail-closed 拒绝调用直到重连）；业务错误/取消原样穿透。
- `manager.ts` — `McpClientManager`：会话生命周期（connect 断旧重建、
  stdio 自动包监督、close_all 幂等）+ 工具导入（必经 vetting 闸门，仅
  VERIFIED 进入工具表）+ 观察模式影子探针（证据累积可查）+ `dispatch`
  （按 endpoint_config.server_id 路由会话，未连接 fail-closed）；
  `register_mcp_executor` 把分发执行器注册进声明式执行体注册表。
- `_fs_seam.ts` — 观察模式文件系统 seam（node:fs 真实装，供
  ToolVetting.shadow_run 写虚拟化：mkdtemp/rmtree/rglob/快照尺寸等）。
- `_result.ts` — 调用结果文本收敛：is_error/isError 双字段、content 项
  dict/对象双形态、非文本项标注类型不静默丢弃、按
  tool_pipeline.DEFAULT_MAX_RESULT_CHARS 截断。

## 依赖
- 上游：`core/errors`、`core/json`、`core/declarative_tools`（端点类型与
  声明式定义/执行体注册表）、`kernel/tool_vetting`（ToolSource/
  VettingVerdict/ToolManifest/FsSeam）、`kernel/tool_pipeline`
  （DEFAULT_MAX_RESULT_CHARS）、`adapters/_lock`。
- 下游：`src/index.ts`（MCP 组导出；SpawnSeam 与 kernel/sandbox 同名冲突
  按语义别名 McpSpawnSeam 导出）；`test/adapters/mcp/`（配置/转换/注册表/
  三传输/监督/管理器全覆盖）。

# ink-ts 原生机制件配置与线协议规范（exec/CONFIG.md）

`exec/` workspace 承载四个 Rust crate：`ink_ts_exec`（OS 执行器子进程，
信封驱动零声明表执行）、`ink_ts_infer`（本地嵌入推理子进程，granite-97m
ONNX）、`ink_ts_mcp`（内置 MCP server 二进制 `ink_ts_mcp`，exec/shell 双
profile，宿主装配内置 MCP server 的 stdio 承载件）、`ink_ts_rpc`（共享的
stdio JSON-RPC 行帧底座）。本文件是这些原生机制件的**环境变量/二进制输出/
线协议单一事实源**，也是 Rust 侧与 TS 传输侧（`host/src/exec/*`、
`host/src/mcp/*`）的共同基线——两侧实现或改协议时先看本文件。

## 1. 二进制产物与定位

- 输出约定：`cargo build` 落 `exec/target/{debug,release}/exec(.exe)`、
  `infer(.exe)` 与 `ink_ts_mcp(.exe)`（workspace `exec/Cargo.toml` 头注 +
  TS 侧 `host/src/exec/binary.ts` 同口径）。
- 定位优先序（TS 侧 `locateNativeBinary`；kind = exec/infer/mcp，mcp 的
  二进制名为 `ink_ts_mcp`）：
  1. `INK_EXEC_BINARY` / `INK_INFER_BINARY` / `INK_MCP_BINARY`（单文件显式覆盖）；
  2. `INK_NATIVE_DIR` 目录内 `exec(.exe)` / `infer(.exe)` / `ink_ts_mcp(.exe)`；
  3. `CARGO_TARGET_DIR/{debug,release}/`（构建重定向布局）；
  4. 自当前工作树向上探测 `ink-ts/exec/target/{debug,release}/`。
- `default-members = exec + rpc`：日常 `cargo test/build` 不触发 infer 的
  ort/tokenizers 重型构建；infer 与 mcp-server（依赖 infer 做 embed）用
  `-p ink_ts_infer -p ink_ts_mcp` 单独构建。

## 2. 环境变量全集

### 2.1 exec 会话（exec crate 消费；host spawn 期注入）

| 变量 | 消费方 | 语义 |
|---|---|---|
| `INK_EXEC_SESSION_KEY` | `exec`（`SESSION_KEY_ENV`）+ host `ExecClient` | 信封签名 HMAC-SHA256 的会话密钥（spawn 时随机 32B hex 注入）。启动期读一次；缺失 = 除 `ping` 外全部 fail-closed（无密钥无法复核签名） |

### 2.2 infer 嵌入（infer embedder 消费；`INK_EMBEDDING_*` 全集）

解析优先级（`resolve_plan`，懒解析一次即缓存）：远端
（`INK_EMBEDDING_BASE_URL` + `INK_EMBEDDING_MODEL` 配齐）→ 本地显式跳过 →
本地 ONNX 模型（目录存在且校验通过）→ 确定性保底向量（永不明返回空）。

| 变量 | 语义 |
|---|---|
| `INK_EMBEDDING_BASE_URL` | 远端 OpenAI 兼容 API 根（配齐 `…MODEL` 才走远端） |
| `INK_EMBEDDING_MODEL` | 远端模型标识 |
| `INK_EMBEDDING_ADAPTER` | 远端适配器注册名（缺省 `openai_compat`） |
| `INK_EMBEDDING_API_KEY` | 远端密钥（Bearer；本地/免鉴权端点可省） |
| `INK_EMBEDDING_REQUEST_TIMEOUT` | 远端单请求超时秒数（缺省 60） |
| `INK_EMBEDDING_LOCAL` | `off/0/false/no/skip/disable` = 显式跳过本地模型，直达确定性保底 |
| `INK_EMBEDDING_MODEL_DIR` | 本地模型目录覆盖（缺省相对 CWD：`inkling/models/granite-97m`；host spawn 时显式注入对齐资产实际落位） |

### 2.3 宿主运行配置（非原生件专属，pointer 不另立）

宿主运行目录/存储/审批的 `INK_*` 覆盖键（`INK_DATA_DIR` / `INK_EVENTS_DIR` /
`INK_SEED_DIR` / `INK_ATTACHMENT_DIR` / `INK_STORAGE_URI` /
`INK_AUTO_APPROVE` / `INK_ROUND_DOC_TEXT_CAP`）以 `host/src/config.ts`
`ENV_KEYS` 为单一事实源，本文不复制。

### 2.4 mcp 内置 server（ink_ts_mcp 消费；host mcp 装配期经 spawn env 注入）

| 变量 | 消费方 | 语义 |
|---|---|---|
| `INK_MCP_ROOT` | `mcp-server`（启动期读一次） | 路径类/进程工具的沙箱根（绝对路径）。未配置 = file_read/file_list/file_write/doc_parse/process_exec 全部拒绝（fail-closed）；进程工具 cwd 缺省 = 根。embed 不经此根（模型目录走 §2.2 `INK_EMBEDDING_*`） |
| `INK_MCP_PROCESS_ALLOW` | `mcp-server`（启动期读一次） | 进程工具命令白名单（逗号/分号分隔命令名）。未配置 = process_exec 拒绝（fail-closed；与 exec 信封 allowlist 为空 = 无放行命令同构） |
| `INK_MCP_BINARY` | host `binary.ts` | `ink_ts_mcp` 单文件覆盖定位键（见 §1；mcp 二进制文件名为 `ink_ts_mcp`） |

## 3. 线协议（stdio JSON-RPC 行帧）

> 本节只覆盖 exec/infer 共享的行帧协议；**内置 MCP server（ink_ts_mcp）
> 不在此行帧内**——它实现 MCP stdio 协议（Content-Length 分帧写、读侧自
> 适应 Content-Length/JSON Lines），见 §6。

共同基线：Rust 实现 = `crates/rpc/src/frame.rs`（限长行读取）+ `server.rs`
（服务主循环）；TS 对偶实现 = `host/src/exec/transport.ts`
（`StdioProcessSession` 读行按 `\n` 切分、stderr 有界尾部）。两侧改动须
保持下列语义一致。

- **行帧**：stdin 每行一条 JSON-RPC 2.0 消息，`\n` 结尾；stdout 每行一条
  响应；stderr 是结构化诊断 JSON 行（`code.rs`/`log_line` 形态，TS 侧不入
  协议）。
- **限长**：单行上限 16 MiB（`frame.rs MAX_LINE_BYTES`）；超限行回结构化
  `-32700` 错误并把余量排空到行尾（保持流对齐，服务继续可用）。
- **EOF 语义**：客户端关闭 stdin = 优雅退出 0；stdout 写入失败（客户端
  消亡）= 退出 1。空行跳过。
- **通知**：无 `id` 成员 = notification，不响应（规范语义）。`notifications/*`
  前缀无特殊处理——未知方法一律回 `-32601`（exec/infer 均如此，无死分支）。
- **批量**：JSON 数组消息（batch）不受支持，回 `-32600`。
- **错误码**：JSON-RPC 2.0 标准码 + 执行错误 `-32000`（携带 `data.reason`
  供调用方机器归因，消息只回通用/结构化文案）。
- **方法面**：
  - exec：`ping`（健康探测，无密钥亦可）；`exec.call`（params =
    `{ body, signature }`：body = 信封 JSON 紧凑文本，signature =
    HMAC-SHA256(会话密钥, body) 十六进制；验签通过才解析执行）。
  - infer：`ping`；`infer.plan`（来源/维度/降级原因，懒触发不载模型）；
    `infer.embed`（`{ texts: string[] }` → `{ source, dim, note, vectors }`；
    source ∈ `local_infer`（本地 ONNX 推理，R2 归一）| `remote` |
    `deterministic`）。

## 4. 授权信封（exec.call 载体）

信封字段（Rust `crates/exec/src/envelope.rs` 与 TS
`host/src/exec/envelope.ts`/`_types.ts` 对偶，签名覆盖紧凑文本原文字节）：

`version / id / tool / op / args / endpoint / roots / allowlist / cwd / env /
timeout_secs / max_chars / nonce / issued_at / decision{approved,by,trace_id}`

- op 端点归属（exec 侧机械表，`guard.rs`）：`process→os`、`file→file`、
  `doc→file`、`dialog→dialog`。
- **http 出网 op 已删除**（2026-09 收敛）：exec 不再有 `http`/`network`
  能力，信封不再含 `allow_domains`。TS 侧（`host/src/exec/envelope.ts`
  `hostAllowed`/`parseUrlHost`/`gateCoverage` http 分支、`os.run` op 白名单）
  的 http 残留由宿主批次清理；exec 侧 serde 忽略未知字段，两批时序不互相
  阻塞。

## 5. infer 信任模型（仅宿主可达的本地计算件）

- infer 子进程**无任何监听 socket**，不对外暴露服务；唯一通道 = 宿主
  spawn 的 stdin/stdout stdio 管道。信任根是 spawn 路径本身——宿主不得把
  该进程管道转交给不受信任方（与 exec 的「只信任验签信封」是两套边界：
  exec 靠签名收口，infer 靠「仅宿主可达」收口）。
- infer 进程无本地持久化、无台账；出网只发生在显式配置远端
  `INK_EMBEDDING_BASE_URL` 之后（OpenAI 兼容 `/embeddings`），本地模型
  加载只读 `INK_EMBEDDING_MODEL_DIR` 目录。
- 降级承诺：模型缺失/内核不满足/远端不可用一律落到确定性保底向量
  （非空、单位 L2 归一、同文同向量），来源与原因经 `infer.plan` /
  `infer.embed` 的 `source/dim/note` 可观测；进程不 panic 不 abort。

## 6. 内置 MCP server（ink_ts_mcp）

ink-ts 产物内的原生 MCP server 二进制（`exec/target/{debug,release}/
ink_ts_mcp(.exe)`），使 host MCP 装配段能真正连接缺省内置 server（R1：
消除「无二进制 fail-closed」）。调用形态 = `ink_ts_mcp <exec|shell>`；
传输 = MCP stdio 协议：写 Content-Length 分帧、读侧自适应 Content-Length
/ JSON Lines（与宿主自写 MCP 客户端同健壮性，`_framing.ts` 对偶）。方法面
= `initialize` / `notifications/initialized` / `ping` / `tools/list` /
`tools/call`；工具调用在握手 + initialized 通知到位前一律拒绝。

- **profile 与工具集**：
  - `exec`（对应内置 server inkling_exec）：`file_read` / `file_list` /
    `file_write` / `doc_parse` / `process_exec`——执行复用 exec ops
    （in-process 调用 lib 层，不另写执行逻辑）：路径根内解析、`..`/
    符号链接拒绝、命令白名单、env 面形状、尺寸/超时上界全走 exec 既有
    语义（信封 roots = `INK_MCP_ROOT`、allowlist = `INK_MCP_PROCESS_ALLOW`）。
  - `shell`（对应内置 server inkling_shell）：exec 工具集 + `embed`
    （本地文本嵌入，经 infer crate in-process 嵌入面；`INK_EMBEDDING_*`
    路由与保底语义与 infer 一致）。
- **安全边界（与 exec 同构 fail-closed）**：进程注入 env 仅放行 `INK_*`
  与基础平台键（PATH 等）、禁覆写密钥样键名（KEY/TOKEN/SECRET/PASSWORD/
  CREDENTIAL）；路径类工具在 `INK_MCP_ROOT` 未配置时整体拒绝；进程命令
  不在 `INK_MCP_PROCESS_ALLOW` 内拒绝。工具守门/执行失败以 MCP 工具结果
  `isError=true` 承载（文本含机器可读 reason）；协议级违规（未初始化/
  未知方法/未知工具）回 JSON-RPC 错误（`data.reason`）。
- 接入：host `host/src/mcp/assembly.ts`（`BUILTIN_MCP_PROFILES` =
  inkling_exec→exec / inkling_shell→shell；`resolveBuiltinOverrides` 定位
  `ink_ts_mcp` + profile 参数 + content_length 分帧注入 connect overrides）；
  engine 内置注册表（`engine/src/adapters/mcp/registry.ts`）两内置 server
  均为 STDIO + content_length 分帧。
- 信任边界与 infer 同构：无监听 socket、无本地持久化台账；唯一通道 = 宿主
  spawn 的 stdio 管道，宿主不得转交不受信方。

## 7. 相关锚点

- Rust：`exec/crates/rpc/src/{frame,server}.rs`、`exec/crates/exec/src/
  {protocol,envelope,guard}.rs`、`exec/crates/infer/src/{protocol,embedder}.rs`、
  `exec/crates/mcp-server/src/{frame,profile,server}.rs`
- TS：`host/src/exec/{transport,binary,envelope,client,session,_types}.ts`
  （host/src 只读侧；改动归宿主批次）、`host/src/mcp/assembly.ts`、
  `engine/src/adapters/mcp/{registry,stdio_transport,_framing}.ts`

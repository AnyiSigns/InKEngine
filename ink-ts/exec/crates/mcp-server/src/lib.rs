//! 内置 MCP server（stdio）：exec/shell 双 profile 的宿主侧机制件。
//!
//! 二进制名 `ink_ts_mcp`；调用形态 `ink_ts_mcp exec|shell`。定位：
//! 宿主（host/src/mcp/assembly.ts）在 spawn 内置 MCP server 时以该二进制
//! 为 command、profile 为参数，按 exec/infer 同款环境约定注入沙箱根
//! （`INK_MCP_ROOT`）与进程命令白名单（`INK_MCP_PROCESS_ALLOW`）。
//!
//! 传输 = MCP stdio 协议（Content-Length 分帧写、读侧自适应 JSON
//! Lines/Content-Length，与宿主自写 MCP 客户端同健壮性）；方法面 =
//! `initialize` / `notifications/initialized` / `ping` / `tools/list` /
//! `tools/call`。
//!
//! 工具执行**不另写执行逻辑**：file/process/doc 直接 in-process 复用
//! exec crate 的 ops（信封约束语义原样保留：路径根内解析、符号链接/`..`
//! 拒绝、env 面形状校验、命令白名单、尺寸/超时上界——机械守门零裁决）；
//! shell profile 的 embed 复用 infer crate 的嵌入面。信任边界 = spawn
//! 路径本身（与 infer 同构：仅宿主可达，stdin/stdout 管道不转交不受信方）。
//!
//! fail-closed 面：路径类/进程工具在 `INK_MCP_ROOT` 未配置时整体拒绝；
//! 工具调用在 initialize 握手 + notifications/initialized 前全部拒绝；
//! 进程命令不在 `INK_MCP_PROCESS_ALLOW` 内拒绝；进程 env 仅放行
//! `INK_*`/基础平台键并禁覆写密钥样键名。

pub mod frame;
pub mod profile;
pub mod server;

pub use profile::Profile;
pub use server::McpServer;

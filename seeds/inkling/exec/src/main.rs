//! InKling 执行件入口：MCP stdio server。
//!
//! stdin 是 MCP 客户端（引擎 mcp_client）发来的 JSON-RPC 行，stdout 是
//! 响应行，stderr 是结构化日志通道（trace 语义：请求 id 透传/耗时/成败）。
//! 退出语义：EOF（客户端关闭 stdio）= 优雅退出 0；stdout 写入失败（客户
//! 端消亡）= 退出 1。

use std::io::{BufReader, BufWriter};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let code = inkling_exec::protocol::run_server(&mut reader, &mut writer);
    std::process::exit(code);
}

//! infer 入口：stdio JSON-RPC 服务（granite-97m 本地嵌入推理）。
//!
//! stdin 是宿主（host embedder infer client）发来的 JSON-RPC 行，stdout 是
//! 响应行，stderr 是结构化诊断。退出语义：EOF（客户端关闭 stdio）= 优雅
//! 退出 0；stdout 写入失败（客户端消亡）= 退出 1。模型加载保持懒加载
//! （首次 embed/plan 才解析计划与装载）；环境覆盖（INK_EMBEDDING_*）与
//! 确定性保底语义全在 embedder 模块内。

use std::io::{BufReader, BufWriter};

fn main() {
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .init();
    let ctx = ink_ts_infer::protocol::InferContext::from_env();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut handler = |line: &str| ink_ts_infer::protocol::handle_line(line, &ctx);
    let code = ink_ts_rpc::server::run_server(&mut reader, &mut writer, &mut handler);
    std::process::exit(code);
}

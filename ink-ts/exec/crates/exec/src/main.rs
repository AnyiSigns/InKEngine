//! exec 入口：stdio JSON-RPC 服务（信封驱动零声明表执行）。
//!
//! stdin 是宿主（host exec client）发来的 JSON-RPC 行，stdout 是响应行，
//! stderr 是结构化诊断。退出语义：EOF（客户端关闭 stdio）= 优雅退出 0；
//! stdout 写入失败（客户端消亡）= 退出 1。会话密钥经
//! [`ink_ts_exec::SESSION_KEY_ENV`] 环境注入（宿主 spawn 期随机生成）；
//! 缺失密钥 = 除 ping 外全部 fail-closed（无密钥无法复核签名）。

use std::io::{BufReader, BufWriter};

fn main() {
    let executor = ink_ts_exec::Executor::from_env();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let mut handler = |line: &str| ink_ts_exec::protocol::handle_line(line, &executor);
    let code = ink_ts_rpc::server::run_server(&mut reader, &mut writer, &mut handler);
    std::process::exit(code);
}

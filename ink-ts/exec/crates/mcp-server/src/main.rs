//! ink_ts_mcp 入口：MCP stdio server（exec/shell 双 profile）。
//!
//! 调用形态：`ink_ts_mcp exec` / `ink_ts_mcp shell`。stdin/stdout 承载
//! MCP stdio 帧（Content-Length 分帧；读侧自适应 JSON Lines），stderr 是
//! 结构化诊断（沿用 rpc log_line 形态）。退出语义：EOF（客户端关闭 stdio）
//! = 优雅退出 0；stdout 写入失败 = 退出 1；Content-Length 声明超上界 =
//! 退出 1（流不可对齐，fail-closed，宿主监督拉起）。
//!
//! 沙箱配置来自环境：`INK_MCP_ROOT`（路径根）与 `INK_MCP_PROCESS_ALLOW`
//! （进程命令白名单），启动期读取一次；缺省 = 对应工具面 fail-closed。

use std::io::{BufReader, BufWriter, Write};

use ink_ts_mcp::frame::{encode_frame, read_frame, FrameOversize};
use ink_ts_mcp::profile::Profile;
use ink_ts_mcp::server::{handle_line, McpServer};
use ink_ts_rpc::code::{error_response, log_line, PARSE_ERROR};

fn usage() -> String {
    format!(
        "用法: {} <exec|shell>\n  exec  = file/process/doc 工具集（INK_MCP_ROOT 沙箱）\n  shell = exec 工具集 + embed 工具（infer 本地嵌入）",
        std::env::args()
            .next()
            .as_deref()
            .unwrap_or("ink_ts_mcp")
    )
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(raw) = args.first() else {
        eprintln!("{}", usage());
        std::process::exit(2);
    };
    let Some(profile) = Profile::parse(raw) else {
        eprintln!("未知 profile: {raw}\n{}", usage());
        std::process::exit(2);
    };
    let mut server = McpServer::from_env(profile);
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let code = run(&mut reader, &mut writer, &mut server);
    std::process::exit(code);
}

fn run<R: std::io::BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    server: &mut McpServer,
) -> i32 {
    loop {
        match read_frame(input) {
            Ok(None) => {
                // EOF = 客户端关闭 stdio：优雅退出
                if output.flush().is_err() {
                    eprintln!("stdout 写入失败");
                    return 1;
                }
                return 0;
            }
            Ok(Some(Err(FrameOversize::Line))) => {
                // 超限行已排空余量：回结构化错误，服务继续可用
                let message = "单帧超过 16 MiB 字节上限，拒绝解析".to_string();
                log_line(
                    "mcp",
                    "error",
                    "",
                    &serde_json::Value::Null,
                    0,
                    Some(&message),
                );
                if write_frame(
                    output,
                    &error_response(&serde_json::Value::Null, PARSE_ERROR, message, None)
                        .to_string(),
                )
                .is_err()
                {
                    eprintln!("stdout 写入失败");
                    return 1;
                }
            }
            Ok(Some(Ok(body))) => {
                let trimmed = String::from_utf8_lossy(&body).trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(response) = handle_line(server, &trimmed) {
                    if write_frame(output, &response).is_err() {
                        eprintln!("stdout 写入失败");
                        return 1;
                    }
                }
            }
            Err(err) => {
                // Content-Length 声明超上界等不可恢复帧错误：fail-closed 退出
                log_line(
                    "mcp",
                    "error",
                    "",
                    &serde_json::Value::Null,
                    0,
                    Some(&err.to_string()),
                );
                return 1;
            }
        }
    }
}

/// 写一帧（Content-Length 分帧；写失败 = 客户端消亡）。
fn write_frame<W: Write>(output: &mut W, payload: &str) -> std::io::Result<()> {
    output.write_all(&encode_frame(payload))?;
    output.flush()
}

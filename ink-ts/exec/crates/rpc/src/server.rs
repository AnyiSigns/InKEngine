//! 服务主循环：stdin 逐行 → handler 出响应行 → stdout。
//!
//! 内容分派（handle_line）由各 crate 提供；本模块只管传输健壮性：
//! - EOF（客户端关闭 stdio）= 优雅退出 0；stdout 写入失败 = 退出 1；
//! - 超限行回结构化 -32700 错误并排空余下（保持流对齐），服务继续可用；
//! - 空行跳过；超限行大缓冲一次性释放（不留高水位）。

use std::io::{BufRead, Write};

use serde_json::Value;

use super::code::{PARSE_ERROR, error_response, log_line};
use super::frame::{MAX_LINE_BYTES, drain_to_line_end, read_bounded_line};

/// 处理函数：输入一行请求文本，返回要写往 stdout 的响应行（None = 通知）。
pub type LineHandler<'a> = &'a mut dyn FnMut(&str) -> Option<String>;

/// 服务主循环（内容分派委托 handler；EOF 优雅退出 0，写失败退出 1）。
pub fn run_server<R: BufRead, W: Write>(
    input: &mut R,
    output: &mut W,
    handler: LineHandler<'_>,
) -> i32 {
    let mut line: Vec<u8> = Vec::with_capacity(256);
    loop {
        line.clear();
        let read = read_bounded_line(input, &mut line, MAX_LINE_BYTES + 1);
        match read {
            Ok(0) => {
                // EOF = 客户端关闭 stdio：优雅退出
                if let Err(e) = output.flush() {
                    eprintln!("stdout 写入失败: {e}");
                    return 1;
                }
                return 0;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("stdin 读取失败: {e}");
                return 1;
            }
        }
        if line.len() > MAX_LINE_BYTES {
            // E8：超限行不回静默跳过——客户端会悬挂；回结构化 -32700 错误
            // 并排空本行余量到行尾
            let message = format!("单行超过 {} 字节上限，拒绝解析", MAX_LINE_BYTES);
            log_line(
                "rpc",
                "error",
                "",
                &Value::Null,
                0,
                Some(&message),
            );
            let resp = error_response(&Value::Null, PARSE_ERROR, message, None);
            if let Err(e) = writeln!(output, "{}", resp) {
                eprintln!("stdout 写入失败: {e}");
                return 1;
            }
            let _ = output.flush();
            if let Err(e) = drain_to_line_end(input) {
                eprintln!("stdin 读取失败: {e}");
                return 1;
            }
            // 收缩超限缓冲（大行分配一次性释放）
            line.clear();
            line.shrink_to_fit();
            continue;
        }
        if line.capacity() > MAX_LINE_BYTES {
            line.clear();
            line.shrink_to_fit();
        }
        // 缓冲里是 UTF-8（协议面），lossy 兜底不 panic
        let trimmed = std::str::from_utf8(&line).unwrap_or("").trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(response) = handler(trimmed) {
            if let Err(e) = writeln!(output, "{}", response) {
                eprintln!("stdout 写入失败: {e}");
                return 1;
            }
            let _ = output.flush();
        }
    }
}

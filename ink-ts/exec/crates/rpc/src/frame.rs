//! stdin 行帧读取：限长读取 + 超限行排空（分块消费不落内存）。
//!
//! 任何路径都不把整行无界读入内存：fill_buf 分段消费，超限即停（不等待
//! 行尾）；超限行余量按块排空到行尾，保持流对齐不吞下一行（防内存轰炸，
//! 与 inkling/exec 同款加固）。

use std::io::BufRead;

/// 单行输入长度上限（16 MiB）：超限行拒绝解析并回结构化错误。
pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 限长行读取：追加到 buf（Vec<u8>，调用方负责 clear），至多 limit 字节
/// 或到行尾（含 \n）。返回已读字节数（0 = EOF）。
pub fn read_bounded_line<R: BufRead>(
    input: &mut R,
    buf: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        if total >= limit {
            break;
        }
        // 借用作用域化：chunk 借用结束（consume 前）再消费
        let (take, ended_with_newline) = {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                break; // EOF
            }
            let take = chunk
                .iter()
                .position(|&b| b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(chunk.len())
                .min(limit - total);
            if take == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..take]);
            (take, chunk[take - 1] == b'\n')
        };
        input.consume(take);
        total += take;
        if ended_with_newline {
            break; // 完整行结束
        }
    }
    Ok(total)
}

/// 排空到行尾（超限行余量，分块消费不落内存）。
pub fn drain_to_line_end<R: BufRead>(input: &mut R) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let (take, ended_with_newline) = {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                break; // EOF
            }
            let take = chunk
                .iter()
                .position(|&b| b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(chunk.len());
            (take, chunk[take - 1] == b'\n')
        };
        input.consume(take);
        total += take;
        if ended_with_newline {
            break;
        }
    }
    Ok(total)
}

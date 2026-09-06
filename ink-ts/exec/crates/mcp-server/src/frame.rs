//! MCP stdio 分帧（读侧自适应 / 写侧 Content-Length）。
//!
//! 与宿主自写 MCP 客户端（engine/src/adapters/mcp/_framing.ts）对偶：
//! - 写侧恒用标准 Content-Length 分帧（LSP 风格 `Content-Length: N\r\n\r\n`
//!   + body）——对外 client 均按此收发；
//! - 读侧自适应两种形态：行首 `Content-Length:` = 按声明长度读 body；
//!   否则整行即一条 JSON-RPC 消息（json_lines 兼容形态，容错未显式配置
//!   分帧的旧 client）。
//! - 单帧上界 `MAX_FRAME_BYTES`（与 TS 侧同口径 16 MiB）：行读取按块增量
//!   收集，超上界排空余量到行尾（内存有界、流保持对齐）；Content-Length
//!   声明超上界 = 无法对齐流 → 致命错误（调用方 fail-closed 退出，宿主监督
//!   拉起），不按声明值分配缓冲。

use std::io::{BufRead, Error as IoError, ErrorKind, Result as IoResult};

/// 单帧上界（字节；与 TS `MAX_STDIO_FRAME_BYTES` 对偶）。
pub const MAX_FRAME_BYTES: u64 = 16 * 1024 * 1024;

/// 单帧解码结果（Err = 超限行已排空余量，调用方回结构化错误后继续）。
pub type DecodedFrame = Result<Vec<u8>, FrameOversize>;

/// 编码 Content-Length 帧（LSP 风格）。
pub fn encode_frame(payload: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 64);
    out.extend_from_slice(format!("Content-Length: {}\r\n\r\n", payload.len()).as_bytes());
    out.extend_from_slice(payload.as_bytes());
    out
}

/// 单行读取结果（行读取带增量上界：超上界 = 已把余量排空，流仍对齐）。
enum LineRead {
    /// 行数据（已去 CR/LF 行尾；不含空行哨兵）。
    Data(Vec<u8>),
    /// 行超上界（余量已排空；调用方回结构化错误后继续）。
    TooLong,
    /// EOF（无任何字节）。
    Eof,
}

/// 增量读取一行（分块收集，内存上界 = `MAX_FRAME_BYTES`；超上界把行余量
/// 排空到行尾，不整行驻留内存）。空行返回 Data(空)。
fn take_line<R: BufRead>(input: &mut R) -> IoResult<LineRead> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        // 块内只做只读判定与复制，fill_buf 借用随块结束释放后再 consume
        let (consume, newline, overflow) = {
            let buf = input.fill_buf()?;
            if buf.is_empty() {
                if out.is_empty() {
                    return Ok(LineRead::Eof);
                }
                trim_line_end(&mut out);
                return Ok(LineRead::Data(out));
            }
            let cap = (MAX_FRAME_BYTES as usize).saturating_sub(out.len());
            match buf.iter().position(|&b| b == b'\n') {
                Some(pos) => {
                    let seg = &buf[..=pos];
                    if seg.len() > cap {
                        out.extend_from_slice(&seg[..cap]);
                        (seg.len(), true, true)
                    } else {
                        out.extend_from_slice(seg);
                        (seg.len(), true, false)
                    }
                }
                None => {
                    let take = buf.len().min(cap);
                    out.extend_from_slice(&buf[..take]);
                    (buf.len(), false, take < buf.len())
                }
            }
        };
        input.consume(consume);
        if newline {
            if overflow {
                out.clear();
                return Ok(LineRead::TooLong);
            }
            trim_line_end(&mut out);
            return Ok(LineRead::Data(out));
        }
        if overflow {
            drain_to_line_end(input)?;
            out.clear();
            return Ok(LineRead::TooLong);
        }
    }
}

/// 排空当前行余量到行尾（分块丢弃，内存有界）。
fn drain_to_line_end<R: BufRead>(input: &mut R) -> IoResult<()> {
    loop {
        let (consume, newline) = {
            let buf = input.fill_buf()?;
            if buf.is_empty() {
                return Ok(());
            }
            match buf.iter().position(|&b| b == b'\n') {
                Some(pos) => (pos + 1, true),
                None => (buf.len(), false),
            }
        };
        input.consume(consume);
        if newline {
            return Ok(());
        }
    }
}

/// 去掉行尾 `\r` / `\n`（与 TS `strip_line_ending` 对偶）。
fn trim_line_end(line: &mut Vec<u8>) {
    while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
        line.pop();
    }
}

/// 解析帧头行 Content-Length（非法形态 = None；TS `parse_content_length` 对偶）。
fn parse_content_length(header: &[u8]) -> Option<u64> {
    let text = String::from_utf8_lossy(header).trim().to_ascii_lowercase();
    let value = text.strip_prefix("content-length:")?.trim();
    if value.is_empty() {
        return Some(0);
    }
    value.parse::<u64>().ok()
}

/// 帧头形态判定（行首即 `Content-Length:`）。
fn is_content_length_header(line: &[u8]) -> bool {
    let prefix = b"content-length:";
    line.len() >= prefix.len() && line[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// 读取下一帧：返回消息字节（None = EOF）。`FrameOversize::Line` 已排空余量，
/// 调用方回结构化错误后继续；Content-Length 声明超上界 = 致命 `Err`
/// （流不可对齐，fail-closed 退出由调用方决定）。
pub fn read_frame<R: BufRead>(input: &mut R) -> IoResult<Option<DecodedFrame>> {
    loop {
        match take_line(input)? {
            LineRead::Eof => return Ok(None),
            LineRead::TooLong => return Ok(Some(Err(FrameOversize::Line))),
            LineRead::Data(line) if line.is_empty() => continue,
            LineRead::Data(first) if is_content_length_header(&first) => {
                let mut declared = parse_content_length(&first);
                // 头部继续读到空行（可含多行头/续行 Content-Length）
                loop {
                    match take_line(input)? {
                        LineRead::Eof => return Ok(None),
                        LineRead::TooLong => return Ok(Some(Err(FrameOversize::Line))),
                        LineRead::Data(header) if header.is_empty() => break,
                        LineRead::Data(header) => {
                            if is_content_length_header(&header) {
                                declared = parse_content_length(&header);
                            }
                        }
                    }
                }
                let Some(length) = declared else {
                    return Ok(Some(Ok(Vec::new())));
                };
                if length > MAX_FRAME_BYTES {
                    return Err(IoError::new(
                        ErrorKind::InvalidData,
                        format!("Content-Length 声明超上界: {length} > {MAX_FRAME_BYTES} 字节"),
                    ));
                }
                let mut body = vec![0u8; length as usize];
                input.read_exact(&mut body)?;
                return Ok(Some(Ok(body)));
            }
            LineRead::Data(line) => {
                // JSON Lines：整行即一条消息
                return Ok(Some(Ok(line)));
            }
        }
    }
}

/// 帧读取的拒绝形态（超限行已排空余量，流仍对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameOversize {
    /// 行超上界（json_lines / 帧头）。
    Line,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(bytes: &[u8]) -> (Vec<Option<DecodedFrame>>, Option<IoError>) {
        let mut reader = Cursor::new(bytes);
        let mut out = Vec::new();
        let mut fatal = None;
        loop {
            match read_frame(&mut reader) {
                Ok(None) => break,
                Ok(Some(item)) => out.push(Some(item)),
                Err(err) => {
                    fatal = Some(err);
                    break;
                }
            }
        }
        (out, fatal)
    }

    fn message(text: &str) -> Option<DecodedFrame> {
        Some(Ok(text.as_bytes().to_vec()))
    }

    #[test]
    fn content_length_frame_roundtrip() {
        let payload = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let frame = encode_frame(payload);
        assert!(frame.starts_with(b"Content-Length: "));
        let (items, fatal) = read_all(&frame);
        assert!(fatal.is_none());
        assert_eq!(items, vec![message(payload)]);
    }

    #[test]
    fn adaptive_read_accepts_json_lines() {
        let payload = r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#;
        let line = format!("{payload}\n");
        let (items, fatal) = read_all(line.as_bytes());
        assert!(fatal.is_none());
        assert_eq!(items, vec![message(payload)]);
    }

    #[test]
    fn blank_lines_are_skipped() {
        let payload = r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#;
        let bytes = format!("\n\n{payload}\n");
        let (items, fatal) = read_all(bytes.as_bytes());
        assert!(fatal.is_none());
        assert_eq!(items, vec![message(payload)]);
    }

    #[test]
    fn content_length_headers_may_carry_extra_lines() {
        let payload = r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#;
        let mut bytes = format!(
            "Content-Length: {}\r\nX-Extra: ignored\r\nContent-Length: {}\r\n\r\n",
            payload.len(),
            payload.len()
        )
        .into_bytes();
        bytes.extend_from_slice(payload.as_bytes());
        let (items, fatal) = read_all(&bytes);
        assert!(fatal.is_none());
        assert_eq!(items, vec![message(payload)]);
    }

    #[test]
    fn oversized_line_is_reported_and_stream_recovers() {
        let huge = vec![b'x'; MAX_FRAME_BYTES as usize + 100];
        let mut bytes = huge.clone();
        bytes.extend_from_slice(b"\n");
        let payload = r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#;
        bytes.extend_from_slice(format!("{payload}\n").as_bytes());
        let (items, fatal) = read_all(&bytes);
        assert!(fatal.is_none());
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], Some(Err(FrameOversize::Line)));
        assert_eq!(items[1], message(payload));
    }

    #[test]
    fn oversized_content_length_is_fatal() {
        let bytes = format!("Content-Length: {}\r\n\r\n", MAX_FRAME_BYTES + 1).into_bytes();
        let (items, fatal) = read_all(&bytes);
        assert!(items.is_empty());
        let err = fatal.expect("超上界声明须致命");
        assert!(err.to_string().contains("超上界"));
    }

    #[test]
    fn truncated_body_is_eof_error() {
        let payload = r#"{"jsonrpc":"2.0","id":6,"method":"ping"}"#;
        let mut bytes = encode_frame(payload);
        bytes.truncate(bytes.len() - 3);
        let mut reader = Cursor::new(bytes);
        let result = read_frame(&mut reader);
        assert!(result.is_err());
    }
}

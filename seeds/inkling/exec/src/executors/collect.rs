//! 采集执行体：文本直取 / URL 取回（大小上限保护 + 超时 + 重定向上限）。
//!
//! URL 取回是零依赖约束下的最小 HTTP/1.1 客户端：只支持 http:// 明文
//! （TLS 需要密码学实现，零依赖执行件不内置——https 场景由宿主侧
//! web_bridge 代理取回后经本工具或 inkling_parse 注入文本，见 env.json
//! 的 local/web_bridge 环境分工）。实现要点：大小上限在读取循环里强制
//! （超限截断并标记，不爆内存）、读取超时防止挂死、重定向跟随有上限
//! （防循环）、响应头有独立上限（防头轰炸）。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use crate::json::{object_from_pairs, Value};
use crate::tool::{integer_schema, string_schema, ToolError, ToolErrorKind};

/// 出厂默认大小上限（1 MiB）：采集是给解析/蒸馏用的原始素材，超出即截断。
const DEFAULT_MAX_BYTES: usize = 1024 * 1024;
/// 出厂默认读取超时（毫秒）。
const DEFAULT_TIMEOUT_MS: u64 = 5000;
/// 出厂默认重定向跟随上限（防重定向循环）。
const DEFAULT_MAX_REDIRECTS: usize = 3;
/// 响应头总大小上限（64 KiB，防头轰炸）。
const MAX_HEADER_BYTES: usize = 64 * 1024;

pub fn schema() -> Value {
    crate::tool::schema_of(
        vec![
            (
                "source",
                object_from_pairs(vec![
                    ("type", Value::String("string".to_string())),
                    (
                        "enum",
                        Value::Array(vec![
                            Value::String("text".to_string()),
                            Value::String("url".to_string()),
                        ]),
                    ),
                    ("description", Value::String("采集源类型".to_string())),
                ]),
            ),
            ("text", string_schema("source=text 时的直取文本")),
            (
                "url",
                string_schema("source=url 时的取回地址（仅 http://）"),
            ),
            (
                "max_bytes",
                integer_schema("大小上限保护（默认 1 MiB，超出截断并标记）"),
            ),
            ("timeout_ms", integer_schema("读取超时毫秒（默认 5000）")),
            ("max_redirects", integer_schema("重定向跟随上限（默认 3）")),
        ],
        vec!["source"],
    )
}

// -- URL 结构 ------------------------------------------------------------

struct ParsedUrl {
    host: String,
    port: u16,
    path_and_query: String,
}

/// 最小 URL 解析：scheme://host[:port][/path...]；只接受 http scheme，
/// 其余（含 https）返回 Err（https 由宿主 web_bridge 代理，见模块文档）。
fn parse_url(raw: &str) -> Result<ParsedUrl, String> {
    let rest = raw.strip_prefix("http://").ok_or_else(|| {
        "仅支持 http:// 取回；https 需宿主 web_bridge 代理（零依赖执行件不含 TLS）".to_string()
    })?;
    if rest.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => {
            let port: u16 = p.parse().map_err(|_| format!("端口非法: {}", p))?;
            (h.to_string(), port)
        }
        _ => (authority.to_string(), 80),
    };
    if host.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    Ok(ParsedUrl {
        host,
        port,
        path_and_query: path_and_query.to_string(),
    })
}

// -- 最小 HTTP/1.1 客户端 --------------------------------------------------

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    truncated: bool,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// 从 TCP 流读取响应：先读头（上限内），再按 Content-Length / chunked /
/// EOF 三种形态读体，全程受 max_bytes 上限约束（超限截断并标记）。
/// 头阶段用裸读（一次 read 可能把体也读进来，超读部分留在 header_buf 的
/// rest 段）；体阶段把 rest 与剩余流串联（Cursor::chain）后统一经
/// BufReader 读取——超读字节先进 rest、后进缓冲，任何边界都不丢失。
fn read_response(stream: TcpStream, max_bytes: usize) -> Result<HttpResponse, String> {
    let mut raw = stream;
    let mut header_buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        if header_buf.len() > MAX_HEADER_BYTES {
            return Err("响应头超过上限（疑似头轰炸）".to_string());
        }
        if let Some(end) = find_double_crlf(&header_buf) {
            let header_bytes = &header_buf[..end];
            let rest = &header_buf[end + 4..];
            let text =
                std::str::from_utf8(header_bytes).map_err(|_| "响应头非合法 UTF-8".to_string())?;
            let (status, headers) = parse_status_and_headers(text)?;
            let mut body = Vec::with_capacity(rest.len() + 256);
            let mut truncated = false;
            if status == 204 {
                return Ok(HttpResponse {
                    status,
                    headers,
                    body,
                    truncated,
                });
            }
            let mut reader = BufReader::new(std::io::Cursor::new(rest.to_vec()).chain(raw));
            let chunked = headers.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("Transfer-Encoding")
                    && v.to_ascii_lowercase().contains("chunked")
            });
            if chunked {
                read_chunked_body(&mut reader, &mut body, max_bytes, &mut truncated)?;
            } else {
                let content_length = headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("Content-Length"))
                    .and_then(|(_, v)| v.trim().parse::<usize>().ok());
                match content_length {
                    Some(total) => {
                        while body.len() < total {
                            if body.len() >= max_bytes {
                                truncated = true;
                                break;
                            }
                            // 只读所需字节数（slice 上限 = 余量）：读多会
                            // 把后续内容吞出缓冲而丢失
                            let mut chunk = [0u8; 8192];
                            let want = (total - body.len()).min(chunk.len());
                            let n = read_or_timeout(&mut reader, &mut chunk[..want])?;
                            if n == 0 {
                                break; // 对端提前断开（Content-Length 不可信时容忍）
                            }
                            body.extend_from_slice(&chunk[..n]);
                        }
                        if body.len() > max_bytes {
                            body.truncate(max_bytes);
                            truncated = true;
                        }
                    }
                    None => {
                        // 无长度声明：读到 EOF（Connection: close 语义）
                        let mut chunk = [0u8; 8192];
                        loop {
                            let n = read_or_timeout(&mut reader, &mut chunk)?;
                            if n == 0 {
                                break;
                            }
                            if body.len() + n > max_bytes {
                                let take = max_bytes - body.len();
                                body.extend_from_slice(&chunk[..take]);
                                truncated = true;
                                break;
                            }
                            body.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
            return Ok(HttpResponse {
                status,
                headers,
                body,
                truncated,
            });
        }
        let mut chunk = [0u8; 4096];
        let n = read_or_timeout(&mut raw, &mut chunk)?;
        if n == 0 {
            return Err("连接在对头结束前断开".to_string());
        }
        header_buf.extend_from_slice(&chunk[..n]);
    }
}

fn find_double_crlf(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_status_and_headers(text: &str) -> Result<(u16, Vec<(String, String)>), String> {
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| "响应状态行畸形".to_string())?
        .parse()
        .map_err(|_| "响应状态码非法".to_string())?;
    let headers = lines
        .filter(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    Ok((status, headers))
}

/// chunked 传输解码（逐块读取，受 max_bytes 上限约束；0 块后跳尾部）。
fn read_chunked_body<R: BufRead>(
    reader: &mut R,
    body: &mut Vec<u8>,
    max_bytes: usize,
    truncated: &mut bool,
) -> Result<(), String> {
    loop {
        let size_line = read_line(reader)?;
        let size =
            usize::from_str_radix(size_line.trim().split(';').next().unwrap_or("").trim(), 16)
                .map_err(|_| "chunk 长度行畸形".to_string())?;
        if size == 0 {
            // 结束块：跳过 trailer 到空行
            loop {
                let line = read_line(reader)?;
                if line.is_empty() {
                    break;
                }
            }
            return Ok(());
        }
        let mut remaining = size;
        while remaining > 0 {
            if body.len() >= max_bytes {
                *truncated = true;
                // 截断后仍需排空当前 chunk 余量以保持流对齐（同样按需读）
                let mut skip = [0u8; 4096];
                while remaining > 0 {
                    let want = remaining.min(skip.len());
                    let n = read_or_timeout(reader, &mut skip[..want])?;
                    if n == 0 {
                        return Err("chunk 在读取中途断开".to_string());
                    }
                    remaining -= n;
                }
                let _ = read_line(reader)?; // 块尾 CRLF
                break;
            }
            let mut chunk = [0u8; 8192];
            let want = remaining.min(max_bytes - body.len()).min(chunk.len());
            let n = read_or_timeout(reader, &mut chunk[..want])?;
            if n == 0 {
                return Err("chunk 在读取中途断开".to_string());
            }
            body.extend_from_slice(&chunk[..n]);
            remaining -= n;
        }
        let _ = read_line(reader)?; // 块尾 CRLF
    }
}

/// 读一行（到 \n，剥 \r）——chunked 长度行与 trailer 用；只消费到行尾，
/// 行后的字节留在 BufReader 缓冲里（二进制体内容不因读行而丢失）。
fn read_line<R: BufRead>(reader: &mut R) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let n = read_or_timeout(reader, &mut byte)?;
        if n == 0 {
            return Err("读取行时连接断开".to_string());
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() < 1024 {
            line.push(byte[0]);
        }
    }
    let text = String::from_utf8_lossy(&line);
    Ok(text.trim_end_matches('\r').to_string())
}

/// 带超时语义的读取：超时/断连归一为可读错误（不 panic 不挂死）。
fn read_or_timeout<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<usize, String> {
    match reader.read(buf) {
        Ok(n) => Ok(n),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Err("读取超时".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => Err("读取超时".to_string()),
        Err(e) => Err(format!("读取失败: {}", e)),
    }
}

/// 相对重定向解析：Location 以 / 开头 = 同源路径，完整 URL = 直接取。
fn resolve_redirect(base: &ParsedUrl, location: &str) -> Result<String, String> {
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if location.starts_with('/') {
        return Ok(format!("http://{}:{}{}", base.host, base.port, location));
    }
    Err("重定向 Location 无法解析（仅支持绝对 URL 或站内路径）".to_string())
}

fn http_get(
    url: &str,
    timeout_ms: u64,
    max_bytes: usize,
    max_redirects: usize,
) -> Result<HttpResponse, String> {
    let parsed = parse_url(url)?;
    let mut current = (url.to_string(), parsed);
    for _ in 0..=max_redirects {
        let mut stream = TcpStream::connect((current.1.host.as_str(), current.1.port))
            .map_err(|e| format!("连接 {} 失败: {}", current.0, e))?;
        stream
            .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
            .map_err(|e| format!("设置读取超时失败: {}", e))?;
        let request = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: inkling_exec/0.1.0\r\nAccept: */*\r\n\r\n",
            current.1.path_and_query, current.1.host
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|e| format!("发送请求失败: {}", e))?;
        let response = read_response(stream, max_bytes)?;
        if (300..400).contains(&response.status) {
            let location = response
                .header("Location")
                .ok_or_else(|| format!("重定向 {} 缺 Location 头", response.status))?;
            let next = resolve_redirect(&current.1, location)?;
            let next_parsed = parse_url(&next)?;
            current = (next, next_parsed);
            continue;
        }
        return Ok(response);
    }
    Err(format!("重定向超过上限（{} 次）", max_redirects))
}

// -- 工具入口 ------------------------------------------------------------

/// inkling_collect：参数 {source, text?, url?, max_bytes?, timeout_ms?, max_redirects?}。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let source = args.get_str("source").ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::InvalidParams,
            "缺 source（text/url）".to_string(),
        )
    })?;
    let max_bytes = args
        .get_i64("max_bytes")
        .unwrap_or(DEFAULT_MAX_BYTES as i64)
        .max(1) as usize;
    match source {
        "text" => {
            let text = args.get_str("text").ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "source=text 缺 text".to_string(),
                )
            })?;
            let bytes = text.len();
            let truncated = bytes > max_bytes;
            let content = if truncated {
                // 截断按字节边界（UTF-8 安全：只截在合法边界上）
                cut_utf8(text, max_bytes).to_string()
            } else {
                text.to_string()
            };
            Ok(object_from_pairs(vec![
                ("ok", Value::Bool(true)),
                ("source", Value::String("text".to_string())),
                ("chars", Value::Number(content.chars().count() as f64)),
                ("bytes", Value::Number(content.len() as f64)),
                ("truncated", Value::Bool(truncated)),
                ("content", Value::String(content)),
            ]))
        }
        "url" => {
            let url = args
                .get_str("url")
                .filter(|u| !u.is_empty())
                .ok_or_else(|| {
                    ToolError::new(
                        ToolErrorKind::InvalidParams,
                        "source=url 缺 url".to_string(),
                    )
                })?;
            let timeout_ms = args
                .get_i64("timeout_ms")
                .unwrap_or(DEFAULT_TIMEOUT_MS as i64)
                .max(1) as u64;
            let max_redirects = args
                .get_i64("max_redirects")
                .unwrap_or(DEFAULT_MAX_REDIRECTS as i64)
                .max(0) as usize;
            let response = http_get(url, timeout_ms, max_bytes, max_redirects)
                .map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;
            let content = String::from_utf8_lossy(&response.body).to_string();
            Ok(object_from_pairs(vec![
                ("ok", Value::Bool(true)),
                ("source", Value::String("url".to_string())),
                ("url", Value::String(url.to_string())),
                ("status", Value::Number(response.status as f64)),
                (
                    "content_type",
                    Value::String(response.header("Content-Type").unwrap_or("").to_string()),
                ),
                ("bytes", Value::Number(response.body.len() as f64)),
                ("truncated", Value::Bool(response.truncated)),
                ("content", Value::String(content)),
            ]))
        }
        other => Err(ToolError::new(
            ToolErrorKind::InvalidParams,
            format!("未知采集源: {}（仅 text/url）", other),
        )),
    }
}

/// 按字节上限截断且不切断 UTF-8 字符（只保留完整字符前缀）。
fn cut_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        let url = parse_url("http://example.com/a/b?q=1").unwrap();
        assert_eq!(url.host, "example.com");
        assert_eq!(url.port, 80);
        assert_eq!(url.path_and_query, "/a/b?q=1");
        let url = parse_url("http://127.0.0.1:8080").unwrap();
        assert_eq!(url.host, "127.0.0.1");
        assert_eq!(url.port, 8080);
        assert!(parse_url("https://example.com").is_err());
        assert!(parse_url("ftp://example.com").is_err());
    }

    #[test]
    fn cuts_utf8_boundary() {
        let text = "中文测试文本";
        let cut = cut_utf8(text, 7);
        assert_eq!(cut, "中文");
        assert!(cut.len() <= 7);
    }
}

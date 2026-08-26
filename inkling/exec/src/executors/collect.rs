//! 采集执行体：文本直取 / URL 取回（决议 9：exec 侧禁直接出网）。
//!
//! URL 取回经宿主 web_bridge 代理（域名白名单 + 禁重定向 + 截断 + 超时
//! 整体收口，SSRF/CRLF 注入/挂死问题一并由代理层关闭），本执行体不再
//! 内置任何 HTTP 客户端——TcpStream 直连路径已删除，任何 URL 采集调用
//! 在代理契约未接线前 fail-closed 返回结构化错误（绝不退化为直连）。
//! exec 保留文本直取路径（纯本地计算，无出网面）。

use crate::json::{object_from_pairs, Value};
use crate::tool::{integer_schema, string_schema, ToolError, ToolErrorKind};

/// 出厂默认大小上限（1 MiB）：采集是给解析/蒸馏用的原始素材，超出即截断。
const DEFAULT_MAX_BYTES: usize = 1024 * 1024;

/// 工具参数形态 = seed_data/tools.json 声明形态（决议 1：seed 为真源）：
/// {url, text, max_bytes}——url/text 二选一（客户端无需感知内部 source）。
pub fn schema() -> Value {
    crate::tool::schema_of(
        vec![
            (
                "url",
                string_schema("待取回的 URL（经宿主 web_bridge 代理取回，与 text 二选一）"),
            ),
            (
                "text",
                string_schema("直接粘贴的文本内容（与 url 二选一）"),
            ),
            (
                "max_bytes",
                integer_schema("大小上限保护（默认 1 MiB，超出截断并标记）"),
            ),
        ],
        Vec::<&str>::new(),
    )
}

// -- URL 结构（仅校验，不出网） -------------------------------------------

struct ParsedUrl {
    host: String,
    path_and_query: String,
}

/// 最小 URL 解析：scheme://host[/path...]；只接受 http/https scheme，
/// 两者都转交宿主 web_bridge 代理取回。host/path 含控制字符（\r\n\0）
/// 或空格一律拒绝（E5 同源防线：不干净的 URL 不得进入代理通道）。
fn parse_url(raw: &str) -> Result<ParsedUrl, String> {
    let rest = if let Some(rest) = raw.strip_prefix("http://") {
        rest
    } else if let Some(rest) = raw.strip_prefix("https://") {
        rest
    } else {
        return Err("仅支持 http(s):// 取回（经宿主 web_bridge 代理）".to_string());
    };
    if rest.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let host = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => h,
        _ => authority,
    };
    if host.is_empty() {
        return Err("URL 缺少主机名".to_string());
    }
    for ch in host.chars().chain(path_and_query.chars()) {
        if ch.is_control() || ch == ' ' {
            return Err("URL 含控制字符或空白（拒绝）".to_string());
        }
    }
    Ok(ParsedUrl {
        host: host.to_string(),
        path_and_query: path_and_query.to_string(),
    })
}

// -- 宿主 web_bridge 代理取回（决议 9） ------------------------------------

/// URL 取回结果（代理契约的返回形态）。
struct HttpFetchOutcome {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    truncated: bool,
}

/// 宿主 web_bridge 代理取回封装。
///
/// 契约点（TODO(契约待 E-P7 定稿)：宿主代理契约以引擎侧 E-P7 后的
/// mcp_client.py 为准，届时本封装按契约实现真实调用，最小假设如下：
/// - 入参：url、max_bytes（截断上限）；超时由代理侧整体收口，客户端不可控；
/// - 策略：域名白名单（tools.json network_policy.allow_domains）、禁重定向、
///   截断、超时全部由宿主代理执行（exec 侧不再持有任何出网能力）；
/// - 返回：{status, content_type, body, truncated} 同形态（与旧 HTTP 客户端
///   产物对齐，下游消费不变）。
///
/// 契约未定稿前 fail-closed：一律返回结构化错误，绝不退化为直连。
fn host_proxy_fetch(_url: &str, _max_bytes: usize) -> Result<HttpFetchOutcome, String> {
    // TODO(契约待 E-P7 定稿)：宿主代理契约定稿后此处替换为真实代理调用。
    Err(
        "URL 取回需宿主 web_bridge 代理（域名白名单/禁重定向/截断/超时整体收口）；代理契约待引擎侧 E-P7 定稿，当前 fail-closed 拒绝"
            .to_string(),
    )
}

// -- 工具入口 ------------------------------------------------------------

/// collect_material：参数 {url?, text?, max_bytes?}——url/text 二选一
/// （工具声明形态，内部适配为 source 语义）。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let max_bytes = args
        .get_i64("max_bytes")
        .unwrap_or(DEFAULT_MAX_BYTES as i64)
        .max(1) as usize;

    // 参数适配（决议 1）：声明形态 {url, text} → 内部 {source, text}
    let url = args.get_str("url").filter(|u| !u.is_empty());
    let text = args.get_str("text").filter(|t| !t.is_empty());
    if url.is_some() && text.is_some() {
        return Err(ToolError::new(
            ToolErrorKind::InvalidParams,
            "url 与 text 二选一（一次调用只采一个来源）".to_string(),
        ));
    }
    if let Some(url) = url {
        let parsed = parse_url(url).map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;
        return fetch_via_proxy(&parsed, url, max_bytes);
    }
    if let Some(text) = text {
        let bytes = text.len();
        let truncated = bytes > max_bytes;
        let content = if truncated {
            // 截断按字节边界（UTF-8 安全：只截在合法边界上）
            cut_utf8(text, max_bytes).to_string()
        } else {
            text.to_string()
        };
        return Ok(object_from_pairs(vec![
            ("ok", Value::Bool(true)),
            ("source", Value::String("text".to_string())),
            ("chars", Value::Number(content.chars().count() as f64)),
            ("bytes", Value::Number(content.len() as f64)),
            ("truncated", Value::Bool(truncated)),
            ("content", Value::String(content)),
        ]));
    }
    Err(ToolError::new(
        ToolErrorKind::InvalidParams,
        "url 与 text 至少其一（一次调用只采一个来源）".to_string(),
    ))
}

/// URL 采集：校验通过后转交宿主 web_bridge 代理（禁直连，fail-closed）。
fn fetch_via_proxy(
    parsed: &ParsedUrl,
    raw_url: &str,
    max_bytes: usize,
) -> Result<Value, ToolError> {
    // 主机/路径进错误指引（契约落地后走 allow_domains 白名单校验即用此段）
    let location = format!("{}:{}", parsed.host, parsed.path_and_query);
    let response = host_proxy_fetch(raw_url, max_bytes)
        .map_err(|e| ToolError::new(ToolErrorKind::ToolError, format!("{}（{}）", e, location)))?;
    let content = String::from_utf8_lossy(&response.body).to_string();
    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("source", Value::String("url".to_string())),
        ("url", Value::String(raw_url.to_string())),
        ("status", Value::Number(response.status as f64)),
        (
            "content_type",
            Value::String(response.content_type),
        ),
        ("bytes", Value::Number(response.body.len() as f64)),
        ("truncated", Value::Bool(response.truncated)),
        ("content", Value::String(content)),
    ]))
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
    fn parses_urls_and_rejects_dirty_input() {
        let url = parse_url("http://example.com/a/b?q=1").unwrap();
        assert_eq!(url.host, "example.com");
        assert_eq!(url.path_and_query, "/a/b?q=1");
        let url = parse_url("https://example.com").unwrap();
        assert_eq!(url.host, "example.com");
        assert!(parse_url("ftp://example.com").is_err());
        // E5 同源防线：控制字符/空白注入拒绝
        assert!(parse_url("http://exa\r\nmple.com/").is_err());
        assert!(parse_url("http://example.com/\r\nX-Injected: 1").is_err());
        assert!(parse_url("http://exa mple.com/").is_err());
        assert!(parse_url("http://example.com/a b").is_err());
        assert!(parse_url("http:///nohost").is_err());
    }

    #[test]
    fn cuts_utf8_boundary() {
        let text = "中文测试文本";
        let cut = cut_utf8(text, 7);
        assert_eq!(cut, "中文");
        assert!(cut.len() <= 7);
    }

    #[test]
    fn url_mode_fails_closed_without_proxy() {
        // 决议 9：代理契约未接线前 url 采集 fail-closed（结构化错误，
        // 不直连、不静默降级）
        let args = crate::json::parse(r#"{"url": "http://example.com/doc"}"#).unwrap();
        let err = run(&args).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::ToolError);
        assert!(err.message.contains("web_bridge"), "错误: {}", err.message);
        let args = crate::json::parse(r#"{"url": "https://example.com/doc"}"#).unwrap();
        let err = run(&args).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::ToolError);
        assert!(err.message.contains("web_bridge"), "错误: {}", err.message);
    }

    #[test]
    fn url_text_mutually_exclusive() {
        let args = crate::json::parse(r#"{"url": "http://a.b/", "text": "x"}"#).unwrap();
        let err = run(&args).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::InvalidParams);
        let args = crate::json::parse(r#"{}"#).unwrap();
        let err = run(&args).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::InvalidParams);
    }
}

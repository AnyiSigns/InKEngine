//! http 物理执行体（network 端点）：GET 出网抓取——scheme/域名白名单机械
//! 守门 + 不跟随重定向（防域名白名单被重定向绕过）+ 响应体大小上界。
//!
//! 零裁决红线：本模块不判断「该不该出网」（host 裁决），只机械复核
//! 「url 的域名是否命中信封 allow_domains」——allow_domains 为空即无放行
//! 面（fail-closed），`*` 只可由 host 显式放进信封。

use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::redirect::Policy;
use serde_json::{Value as JsonValue, json};

use super::super::envelope::{Deny, Envelope, HTTP_BODY_BYTES_MAX};

/// URL 长度上界（字符；防信封被超长目标轰炸）。
const URL_MAX_CHARS: usize = 2048;

/// 域名白名单命中（host 侧折叠后的 allow_domains；小写比较）：
/// `*` 通配全部；`*.example.com` 匹配后缀域；其余精确匹配。
pub fn host_allowed(patterns: &[String], host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    patterns.iter().any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        pattern == "*" || pattern == host || {
            if let Some(suffix) = pattern.strip_prefix('*') {
                // 通配形态须带前导点（`*.example.com` → `.example.com`），
                // 且 host 长度须大于后缀（apex 域 example.com 不命中子域通配）
                suffix.starts_with('.')
                    && host.len() > suffix.len()
                    && host.ends_with(suffix)
            } else {
                false
            }
        }
    })
}

/// 解析出 URL 的目标 host（小写）；非法形态一律 Err（fail-closed）。
fn parse_url_host(raw: &str) -> Result<(String, String), Deny> {
    let raw = raw.trim();
    if raw.is_empty() || raw.chars().count() > URL_MAX_CHARS {
        return Err(Deny::new("url", "url 非法或超长"));
    }
    let (scheme, rest) = raw
        .split_once("://")
        .ok_or_else(|| Deny::new("scheme", "url 缺 scheme://（须 http/https）"))?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(Deny::new("scheme", format!("仅支持 http/https 出网: {scheme}://")));
    }
    if rest.is_empty() {
        return Err(Deny::new("url", "url 缺 host"));
    }
    if rest.contains('[') {
        return Err(Deny::new("url", "IPv6 字面量 host 不受支持"));
    }
    let authority = rest
        .find(['/', '?', '#'])
        .map(|index| &rest[..index])
        .unwrap_or(rest);
    if authority.contains('@') {
        return Err(Deny::new("url", "url 含用户信息（userinfo）拒绝"));
    }
    let host = authority
        .split(':')
        .next()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| Deny::new("url", "url host 为空"))?;
    Ok((scheme, host.to_ascii_lowercase()))
}

/// 物理执行体入口（守门 → GET）。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "http 的 args 须为对象"))?;
    let url = args
        .get("url")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| Deny::new("params", "http 缺 url（须为字符串）"))?;
    let (_, host) = parse_url_host(url)?;
    if envelope.allow_domains.is_empty() {
        return Err(Deny::new(
            "domain",
            "信封 allow_domains 为空（无放行域名，fail-closed）",
        ));
    }
    if !host_allowed(&envelope.allow_domains, &host) {
        return Err(Deny::new(
            "domain",
            format!("域名不在信封白名单内（越权）: {host}"),
        ));
    }
    let outcome = fetch_get(url, envelope.timeout_secs as u64, envelope.max_chars as usize)?;
    Ok(json!({
        "status": outcome.status,
        "content_type": outcome.content_type,
        "body": outcome.body,
        "truncated": outcome.truncated,
    }))
}

/// GET 抓取结果。
struct HttpOutcome {
    status: u16,
    content_type: Option<String>,
    body: String,
    truncated: bool,
}

/// 单次 GET：不跟随重定向 + 超时 + 响应体按上界截断带标记。
fn fetch_get(url: &str, timeout_secs: u64, max_chars: usize) -> Result<HttpOutcome, Deny> {
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(timeout_secs.max(1)))
        .build()
        .map_err(|err| Deny::new("execution", format!("http client 构建失败: {err}")))?;
    let response = client
        .get(url)
        .send()
        .map_err(|err| Deny::new("execution", format!("http 请求失败: {err}")))?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let mut bytes = Vec::new();
    let read_cap = HTTP_BODY_BYTES_MAX.max(max_chars * 4);
    let mut reader = response.take(read_cap as u64 + 1);
    use std::io::Read;
    let _ = reader.read_to_end(&mut bytes);
    let truncated = bytes.len() as u64 > read_cap as u64;
    if truncated {
        bytes.truncate(read_cap);
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let body = truncate_chars(&text, max_chars);
    Ok(HttpOutcome {
        status,
        content_type,
        body,
        truncated: truncated || text.chars().count() > max_chars,
    })
}

/// 字符截断（带标记）。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut head: String = text.chars().take(max_chars).collect();
    head.push_str("…（已截断）");
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn envelope_with(url: &str, domains: Vec<String>, timeout: i64) -> Envelope {
        Envelope {
            version: 1,
            id: "op-http".into(),
            tool: "fetch".into(),
            op: "http".into(),
            args: json!({ "url": url }),
            endpoint: "network".into(),
            roots: vec![],
            allowlist: vec![],
            allow_domains: domains,
            cwd: None,
            env: None,
            timeout_secs: timeout,
            max_chars: 4096,
            nonce: "n".into(),
            issued_at: 1,
            decision: super::super::super::envelope::Decision {
                approved: true,
                by: "test".into(),
                trace_id: None,
            },
        }
    }

    #[test]
    fn host_matching_exact_wildcard_and_suffix() {
        assert!(host_allowed(&["example.com".into()], "example.com"));
        assert!(!host_allowed(&["example.com".into()], "www.example.com"));
        assert!(host_allowed(&["*.example.com".into()], "www.example.com"));
        assert!(!host_allowed(&["*.example.com".into()], "example.com"));
        assert!(!host_allowed(&["*.example.com".into()], "notexample.com"));
        assert!(host_allowed(&["*".into()], "anything.else"));
        assert!(host_allowed(&["EXAMPLE.com".into()], "example.COM"));
        assert!(!host_allowed(&[], "example.com"), "空白名单 = 全拒");
    }

    #[test]
    fn url_parsing_validates_scheme_and_userinfo() {
        let ok = parse_url_host("https://raw.githubusercontent.com/a/b").unwrap();
        assert_eq!(ok.0, "https");
        assert_eq!(ok.1, "raw.githubusercontent.com");
        let ftp = parse_url_host("ftp://example.com/x").unwrap_err();
        assert_eq!(ftp.reason, "scheme");
        let creds = parse_url_host("https://user:pass@example.com/x").unwrap_err();
        assert_eq!(creds.reason, "url");
        let port = parse_url_host("http://127.0.0.1:8080/").unwrap();
        assert_eq!(port.1, "127.0.0.1");
    }

    #[test]
    fn non_allowlisted_domain_is_refused() {
        let env = envelope_with("https://evil.example/path", vec!["good.example".into()], 5);
        let deny = run(&env).expect_err("白名单外域名须拒绝");
        assert_eq!(deny.reason, "domain");
    }

    #[test]
    fn empty_domains_is_fail_closed() {
        let env = envelope_with("https://example.com/", vec![], 5);
        let deny = run(&env).expect_err("空 allow_domains 须拒绝");
        assert_eq!(deny.reason, "domain");
    }

    /// 本地桩服务 GET 实跑（不入外网；验证物理执行体可用 + 状态/正文透传）。
    #[test]
    fn local_server_fetch_succeeds() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf).unwrap();
            let body = "local-http-ok 中文";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        let env = envelope_with(
            &format!("http://127.0.0.1:{port}/probe"),
            vec!["127.0.0.1".into()],
            10,
        );
        let value = run(&env).expect("本地抓取成功");
        assert_eq!(value["status"], 200);
        assert!(value["body"].as_str().unwrap().contains("local-http-ok"));
        assert_eq!(value["truncated"], false);
        handle.join().unwrap();
    }
}

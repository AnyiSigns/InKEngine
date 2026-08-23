//! web_search 域：联网搜索工具——本地聚合源（多引擎抓取聚合，免费
//! 无 key）默认；用户自配厂商 key（Exa/parallel/bocha 任一）降级到
//! 厂商源；域名白名单网络策略（与 fetch_web 同款语义）；失败结构化
//! 可重试。
//!
//! - **本地聚合源**：DuckDuckGo/Bing 的免费 HTML 结果页源码抓取，
//!   多引擎结果合并去重（无 key、无配额，匿名可用）；
//! - **厂商降级**：搜索 key 配置（设置页数据驱动：exa/parallel/bocha
//!   任一 key 存在即降级，优先序 exa → parallel → bocha；全无 =
//!   本地聚合源）；
//! - **域名策略**：allow_domains 与 fetch_web 同款——非空白名单时
//!   逐结果过滤域名，越域结果丢弃（数据驱动，装配/TOOL 补丁补齐）；
//! - **失败结构化**：超时/网络/HTTP/解析分型 + retryable 标记，
//!   可重试错误按退避重发，不静默重放也不静默吞错。
//!
//! 依赖纪律：本模块不直接调用其它域模块；网络策略数据（tools.json
//! web_search 条目的 network_policy 白名单）由装配侧喂入。

use std::time::Duration;

use serde_json::Value as JsonValue;

/// 聚合源抓取超时（秒）。
pub const SEARCH_TIMEOUT_SECS: u64 = 12;

/// 聚合源 UA（HTML 源码抓取的必要头）。
pub const SEARCH_USER_AGENT: &str = "Mozilla/5.0 (InKling; metasearch-aggregate)";

/// 缺省返回条数。
pub const DEFAULT_LIMIT: usize = 5;

/// 厂商源 URL（设置页 key 绑定后的默认端点；数据驱动可换基址）。
pub const VENDOR_URL_EXA: &str = "https://api.exa.ai/search";
pub const VENDOR_URL_PARALLEL: &str = "https://api.parallel.ai/v1/search";
pub const VENDOR_URL_BOCHA: &str = "https://api.bochaai.com/v1/web-search";

/// 单条搜索结果（聚合/厂商共用的产物形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

/// 搜索结果响应（items + 截断标记 + 耗时）。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchResponse {
    pub items: Vec<SearchItem>,
    pub truncated: bool,
    pub took_ms: u64,
}

/// 失败分型（结构化可重试：错误类别 + 是否可重试 + 消息）。
#[derive(Debug, Clone, PartialEq)]
pub struct SearchError {
    pub kind: SearchErrorKind,
    pub retryable: bool,
    pub message: String,
}

/// 错误类别（枚举形态，防魔法字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchErrorKind {
    Timeout,
    Network,
    Http(u16),
    Parse,
    Policy,
    NoKey,
}

impl SearchError {
    pub fn new(kind: SearchErrorKind, message: impl Into<String>) -> Self {
        let retryable = matches!(
            kind,
            SearchErrorKind::Timeout
                | SearchErrorKind::Network
                | SearchErrorKind::Http(429) | SearchErrorKind::Http(500..=599)
        );
        Self {
            kind,
            retryable,
            message: message.into(),
        }
    }

    pub fn kind_label(&self) -> String {
        match self.kind {
            SearchErrorKind::Timeout => "timeout".to_string(),
            SearchErrorKind::Network => "network".to_string(),
            SearchErrorKind::Http(code) => format!("http_{code}"),
            SearchErrorKind::Parse => "parse".to_string(),
            SearchErrorKind::Policy => "policy".to_string(),
            SearchErrorKind::NoKey => "no_key".to_string(),
        }
    }
}

/// 搜索 key 配置（设置页数据驱动形态；任一存在即厂商降级）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchKeys {
    pub exa: Option<String>,
    pub parallel: Option<String>,
    pub bocha: Option<String>,
}

impl SearchKeys {
    pub fn any(&self) -> bool {
        self.exa.is_some() || self.parallel.is_some() || self.bocha.is_some()
    }
}

/// 解析搜索 key 配置（兼容 `search` / `search_keys` 两种键形态）。
pub fn parse_search_keys(config: &JsonValue) -> SearchKeys {
    let empty = JsonValue::Object(Default::default());
    let section = config
        .get("search")
        .or_else(|| config.get("search_keys"))
        .unwrap_or(&empty);
    let key_of = |name: &str| -> Option<String> {
        section
            .get(name)
            .or_else(|| section.get(&format!("{name}_key")))
            .and_then(JsonValue::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    };
    SearchKeys {
        exa: key_of("exa"),
        parallel: key_of("parallel"),
        bocha: key_of("bocha"),
    }
}

/// 搜索源形态（本地聚合 / 厂商）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderKind {
    LocalAggregate,
    Vendor(&'static str),
}

/// 厂商选择优先序：exa → parallel → bocha（任一 key 存在即降级）。
pub fn resolve_provider(keys: &SearchKeys) -> ProviderKind {
    if keys.exa.is_some() {
        ProviderKind::Vendor("exa")
    } else if keys.parallel.is_some() {
        ProviderKind::Vendor("parallel")
    } else if keys.bocha.is_some() {
        ProviderKind::Vendor("bocha")
    } else {
        ProviderKind::LocalAggregate
    }
}

/// 域名白名单过滤（allow_domains 为空 = 不限制；非空 = 越域丢弃）。
pub fn filter_by_allow_domains(
    items: &[SearchItem],
    allow_domains: &[String],
) -> Vec<SearchItem> {
    if allow_domains.is_empty() {
        return items.to_vec();
    }
    items
        .iter()
        .filter(|item| {
            host_of(&item.url)
                .map(|host| {
                    allow_domains
                        .iter()
                        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
                })
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

/// URL → 主机名（解析失败 = None）。
pub fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
}

// ── 结果解析（纯函数，可单测）──

/// 结果 URL 归一化（聚合源链接形态 → 可访问 URL；uddg 跳转解码）。
fn normalize_url(raw: &str) -> String {
    let cleaned = raw.trim();
    if cleaned.is_empty() {
        return String::new();
    }
    let absolute = match cleaned.strip_prefix("//") {
        Some(rest) => format!("https://{rest}"),
        None => cleaned.to_string(),
    };
    if !absolute.starts_with("http://") && !absolute.starts_with("https://") {
        return absolute;
    }
    if let Ok(parsed) = url::Url::parse(&absolute) {
        for (key, value) in parsed.query_pairs() {
            if key == "uddg" {
                return value.to_string();
            }
        }
    }
    absolute
}

fn strip_html_tag(text: &str) -> String {
    let mut result = String::new();
    for part in text.split('<') {
        let segment = part.split('>').next().unwrap_or("");
        result.push_str(segment);
    }
    result.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
}

/// DuckDuckGo HTML 结果页解析（result__a 结果行形态；选择器子集，
/// 供本地聚合源的无 key 抓取解析）。
pub fn parse_ddg_html(html: &str) -> Vec<SearchItem> {
    let pattern = r#"<a class="result__a" href="([^"]+)">(.*?)</a>"#;
    let anchor_re = regex::Regex::new(pattern).expect("DDG 结果行模式合法");
    anchor_re
        .captures_iter(html)
        .map(|capture| {
            let url = capture
                .get(1)
                .map(|m| normalize_url(m.as_str()))
                .unwrap_or_default();
            let title = capture
                .get(2)
                .map(|m| strip_html_tag(m.as_str()).trim().to_string())
                .unwrap_or_default();
            SearchItem {
                title,
                url,
                snippet: String::new(),
                source: "duckduckgo".to_string(),
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

/// DuckDuckGo 结果摘要补全（result__snippet 行；按文档序与结果行
/// 一一对应，不进行跨行配对）。
pub fn fill_ddg_snippets(items: &mut [SearchItem], html: &str) {
    let pattern = r#"<a class="result__snippet" href="([^"]+)">(.*?)</a>"#;
    let snippet_re = regex::Regex::new(pattern).expect("DDG 摘要行模式合法");
    let snippets: Vec<String> = snippet_re
        .captures_iter(html)
        .map(|capture| {
            let text = capture
                .get(2)
                .map(|m| strip_html_tag(m.as_str()).trim().to_string())
                .unwrap_or_default();
            let text = text
                .chars()
                .take(160)
                .collect::<String>();
            text
        })
        .collect();
    for (item, snippet) in items.iter_mut().zip(snippets) {
        item.snippet = snippet;
    }
}

/// Bing HTML 结果页解析（b_algo 块形态；标题/摘要行在块内配对）。
pub fn parse_bing_html(html: &str) -> Vec<SearchItem> {
    let pattern = r#"(?s)<li class="b_algo".*?<h2><a href="([^"]+)">(.*?)</a>.*?<p class="b_lineclamp[^"]*">(.*?)</p>"#;
    let block_re = regex::Regex::new(pattern).expect("Bing 块模式合法");
    block_re
        .captures_iter(html)
        .map(|capture| {
            let url = capture
                .get(1)
                .map(|m| normalize_url(m.as_str()))
                .unwrap_or_default();
            let title = capture
                .get(2)
                .map(|m| strip_html_tag(m.as_str()).trim().to_string())
                .unwrap_or_default();
            let snippet = capture
                .get(3)
                .map(|m| strip_html_tag(m.as_str()).trim().to_string())
                .unwrap_or_default();
            SearchItem {
                title,
                url,
                snippet,
                source: "bing".to_string(),
            }
        })
        .filter(|item| !item.url.is_empty())
        .collect()
}

/// 通用条目抽取（厂商 JSON 的 results 清单形态）。
fn extract_items(json: &JsonValue) -> Vec<SearchItem> {
    let mut items = Vec::new();
    let mut candidate: Option<&JsonValue> = json
        .get("results")
        .or_else(|| json.get("data").and_then(|d| d.get("results")))
        .or_else(|| json.get("data").and_then(|d| d.get("webPages")).and_then(|w| w.get("value")));
    if candidate.is_none() {
        candidate = json.get("data").and_then(|d| d.get("webPages")).and_then(|w| w.get("results"));
    }
    let Some(list) = candidate.and_then(JsonValue::as_array) else {
        return items;
    };
    for entry in list {
        let title = entry
            .get("title")
            .or_else(|| entry.get("name"))
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        let url = entry
            .get("url")
            .or_else(|| entry.get("link"))
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        let snippet = entry
            .get("snippet")
            .or_else(|| entry.get("text"))
            .or_else(|| entry.get("content"))
            .and_then(JsonValue::as_str)
            .unwrap_or_default();
        if url.is_empty() {
            continue;
        }
        items.push(SearchItem {
            title: title.to_string(),
            url: url.to_string(),
            snippet: snippet.to_string(),
            source: "vendor".to_string(),
        });
    }
    items
}

/// Exa 厂商 JSON 解析（results 清单形态）。
pub fn parse_exa_json(json: &JsonValue) -> Result<Vec<SearchItem>, SearchError> {
    if json.get("results").is_none() {
        return Err(SearchError::new(
            SearchErrorKind::Parse,
            "Exa 响应缺 results 清单",
        ));
    }
    Ok(extract_items(json))
}

/// Parallel 厂商 JSON 解析（results 清单形态）。
pub fn parse_parallel_json(json: &JsonValue) -> Result<Vec<SearchItem>, SearchError> {
    if json.get("results").is_none() && json.get("data").is_none() {
        return Err(SearchError::new(
            SearchErrorKind::Parse,
            "Parallel 响应缺 results 清单",
        ));
    }
    Ok(extract_items(json))
}

/// Bocha 厂商 JSON 解析（data.webPages.value 形态）。
pub fn parse_bocha_json(json: &JsonValue) -> Result<Vec<SearchItem>, SearchError> {
    let value = json
        .get("data")
        .and_then(|d| d.get("webPages"))
        .and_then(|w| w.get("value"));
    if value.is_none() {
        return Err(SearchError::new(
            SearchErrorKind::Parse,
            "Bocha 响应缺 data.webPages.value",
        ));
    }
    Ok(extract_items(json))
}

// ── 抓取（网络动作；测试以解析函数 + 假响应器覆盖）──

/// 搜索引擎源端点（本地聚合的抓取目标清单）。
const AGGREGATE_ENDPOINTS: [(&str, &str); 2] = [
    ("duckduckgo", "https://html.duckduckgo.com/html/?q={query}"),
    ("bing", "https://www.bing.com/search?q={query}&count={limit}"),
];

/// 本地聚合抓取（逐引擎执行，合并去重）。
///
/// 单引擎失败 = 其它引擎照常（聚合语义）；全部失败 = 结构化错误
/// （首个失败原因，可重试标记取首个可重试标记）。
pub async fn fetch_aggregate(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<SearchResponse, SearchError> {
    let mut items: Vec<SearchItem> = Vec::new();
    let mut failures: Vec<SearchError> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let started = std::time::Instant::now();
    for (engine, template) in AGGREGATE_ENDPOINTS {
        let url = template
            .replace("{query}", &urlencode(query))
            .replace("{limit}", &limit.to_string());
        match fetch_engine_raw(client, url.as_str(), engine).await {
            Ok(html) => {
                let parsed = match engine {
                    "duckduckgo" => {
                        let mut parsed = parse_ddg_html(&html);
                        fill_ddg_snippets(&mut parsed, &html);
                        parsed
                    }
                    _ => parse_bing_html(&html),
                };
                for item in parsed {
                    if seen.insert(item.url.clone()) {
                        items.push(item);
                    }
                }
            }
            Err(err) => failures.push(err),
        }
    }
    if items.is_empty() {
        let first = failures
            .into_iter()
            .next()
            .unwrap_or_else(|| SearchError::new(SearchErrorKind::Parse, "聚合源无结果可解析"));
        let retryable = first.retryable;
        return Err(SearchError {
            kind: first.kind,
            retryable,
            message: format!("聚合源全部失败: {}", first.message),
        });
    }
    let truncated = items.len() > limit;
    items.truncate(limit);
    Ok(SearchResponse {
        items,
        truncated,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

fn urlencode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// 单引擎原始页取回（带超时与 UA；返回 HTML 文本）。
async fn fetch_engine_raw(
    client: &reqwest::Client,
    url: &str,
    engine: &str,
) -> Result<String, SearchError> {
    let response = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, SEARCH_USER_AGENT)
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) if err.is_timeout() => {
            return Err(SearchError::new(SearchErrorKind::Timeout, format!("{engine} 抓取超时")));
        }
        Err(err) => {
            return Err(SearchError::new(
                SearchErrorKind::Network,
                format!("{engine} 抓取失败: {err}"),
            ));
        }
    };
    let status = response.status();
    if !status.is_success() {
        return Err(SearchError::new(
            SearchErrorKind::Http(status.as_u16()),
            format!("{engine} HTTP {}", status.as_u16()),
        ));
    }
    response
        .text()
        .await
        .map_err(|err| SearchError::new(SearchErrorKind::Network, format!("{engine} 响应读取失败: {err}")))
}

/// 厂商抓取（POST JSON；key 缺失 = 结构化 NoKey，不静默回落聚合）。
pub async fn fetch_vendor(
    client: &reqwest::Client,
    provider: &str,
    api_key: &str,
    query: &str,
    limit: usize,
) -> Result<SearchResponse, SearchError> {
    if api_key.trim().is_empty() {
        return Err(SearchError::new(
            SearchErrorKind::NoKey,
            format!("{provider} 未配置搜索 key"),
        ));
    }
    let (endpoint, body) = vendor_request(provider, query, limit);
    let response = match client
        .post(endpoint)
        .bearer_auth(api_key)
        .header("x-api-key", api_key)
        .json(&body)
        .timeout(Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) if err.is_timeout() => {
            return Err(SearchError::new(SearchErrorKind::Timeout, format!("{provider} 请求超时")));
        }
        Err(err) => {
            return Err(SearchError::new(
                SearchErrorKind::Network,
                format!("{provider} 请求失败: {err}"),
            ));
        }
    };
    let status = response.status();
    if !status.is_success() {
        return Err(SearchError::new(
            SearchErrorKind::Http(status.as_u16()),
            format!("{provider} HTTP {}", status.as_u16()),
        ));
    }
    let raw: JsonValue = response
        .json()
        .await
        .map_err(|err| SearchError::new(SearchErrorKind::Parse, format!("{provider} 响应非 JSON: {err}")))?;
    let mut items = match provider {
        "exa" => parse_exa_json(&raw)?,
        "parallel" => parse_parallel_json(&raw)?,
        "bocha" => parse_bocha_json(&raw)?,
        other => {
            return Err(SearchError::new(
                SearchErrorKind::Policy,
                format!("未知厂商源: {other}"),
            ));
        }
    };
    for item in items.iter_mut() {
        item.source = provider.to_string();
    }
    let truncated = items.len() > limit;
    items.truncate(limit);
    Ok(SearchResponse {
        items,
        truncated,
        took_ms: 0,
    })
}

/// 厂商请求形态（端点 + body；provider 驱动）。
fn vendor_request(provider: &str, query: &str, limit: usize) -> (&'static str, JsonValue) {
    match provider {
        "exa" => (
            VENDOR_URL_EXA,
            serde_json::json!({"query": query, "numResults": limit, "contents": {"text": true}}),
        ),
        "parallel" => (
            VENDOR_URL_PARALLEL,
            serde_json::json!({"query": query, "max_results": limit}),
        ),
        _ => (
            VENDOR_URL_BOCHA,
            serde_json::json!({"query": query, "summary": true, "count": limit}),
        ),
    }
}

/// 搜索编排：源选择（本地聚合 / 厂商）→ 抓取 → 域名白名单过滤。
pub async fn search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    allow_domains: &[String],
    keys: &SearchKeys,
) -> Result<SearchResponse, SearchError> {
    if query.trim().is_empty() {
        return Err(SearchError::new(SearchErrorKind::Policy, "查询语句为空"));
    }
    let limit = limit.clamp(1, 20);
    let response = match resolve_provider(keys) {
        ProviderKind::Vendor(provider) => {
            let key = match provider {
                "exa" => keys.exa.as_deref().unwrap_or(""),
                "parallel" => keys.parallel.as_deref().unwrap_or(""),
                _ => keys.bocha.as_deref().unwrap_or(""),
            };
            fetch_vendor(client, provider, key, query, limit).await?
        }
        ProviderKind::LocalAggregate => fetch_aggregate(client, query, limit).await?,
    };
    let items = filter_by_allow_domains(&response.items, allow_domains);
    let truncated = response.truncated || items.len() < response.items.len();
    Ok(SearchResponse {
        items,
        truncated,
        took_ms: response.took_ms,
    })
}

/// 可重试搜索（退避重发；不可重试错误直接失败）。
pub async fn search_with_retry(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    allow_domains: &[String],
    keys: &SearchKeys,
    attempts: u32,
    retry_delay: Duration,
) -> Result<SearchResponse, SearchError> {
    let mut last: Option<SearchError> = None;
    for attempt in 0..attempts.max(1) {
        match search(client, query, limit, allow_domains, keys).await {
            Ok(response) => return Ok(response),
            Err(err) => {
                if !err.retryable || attempt + 1 >= attempts.max(1) {
                    last = Some(err);
                    break;
                }
                last = Some(err);
                tokio::time::sleep(retry_delay.saturating_mul(attempt.saturating_add(1))).await;
            }
        }
    }
    Err(last.unwrap_or_else(|| SearchError::new(SearchErrorKind::Network, "重试耗尽")))
}

/// 限长工具（供外部按 tools.json max 截断声明校验）——本模块最大
/// 条数上限（tools.json web_search limit 1-20 同源）。
pub fn limit_clamp(limit: usize) -> usize {
    limit.clamp(1, 20)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    fn seed_file(name: &str) -> JsonValue {
        let path = repo_root().join("inkling").join("seed_data").join(name);
        let text = std::fs::read_to_string(path).expect("seed 文件读取失败");
        serde_json::from_str(&text).expect("seed 文件 JSON 非法")
    }

    #[test]
    fn search_key_config_parses_any_of_three_vendors() {
        let cfg = serde_json::json!({
            "search": {"exa": "key-1", "parallel": "key-2"}
        });
        let keys = parse_search_keys(&cfg);
        assert_eq!(keys.exa.as_deref(), Some("key-1"));
        assert_eq!(keys.parallel.as_deref(), Some("key-2"));
        assert!(keys.any());
        assert_eq!(resolve_provider(&keys), ProviderKind::Vendor("exa"));
        let bocha_only = parse_search_keys(&serde_json::json!({"search_keys": {"bocha": "k"}}));
        assert_eq!(resolve_provider(&bocha_only), ProviderKind::Vendor("bocha"));
        let none = parse_search_keys(&serde_json::json!({}));
        assert_eq!(resolve_provider(&none), ProviderKind::LocalAggregate);
    }

    #[test]
    fn aggregate_html_parsers_extract_results() {
        let ddg = r#"<html><body>
            <a class="result__a" href="https://example.com/a">Example 论文 A</a>
            <a class="result__snippet" href="https://example.com/a">摘要 A 内容</a>
            <a class="result__a" href="//html.duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F123&rut=zz">arXiv 摘要页</a>
        </body></html>"#;
        let mut items = parse_ddg_html(ddg);
        fill_ddg_snippets(&mut items, ddg);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://example.com/a");
        assert_eq!(items[0].snippet, "摘要 A 内容");
        assert_eq!(items[1].url, "https://arxiv.org/abs/123", "uddg 链接解码");
        let bing = r#"<li class="b_algo"><h2><a href="https://example.org/b">Bing 命中</a></h2><p class="b_lineclamp2">摘要 B</p></li>"#;
        let bing_items = parse_bing_html(bing);
        assert_eq!(bing_items.len(), 1);
        assert_eq!(bing_items[0].url, "https://example.org/b");
        assert_eq!(bing_items[0].snippet, "摘要 B");
    }

    #[test]
    fn vendor_json_parsers_cover_shapes() {
        let exa = serde_json::json!({
            "results": [
                {"title": "标题一", "url": "https://a.example/a", "text": "摘要一"},
                {"title": "标题二", "url": "https://b.example/b"}
            ]
        });
        let items = parse_exa_json(&exa).expect("Exa 解析成功");
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].snippet, "");
        let parallel = serde_json::json!({
            "results": [{"title": "并行命中", "url": "https://c.example/c", "content": "内容"}]
        });
        let items = parse_parallel_json(&parallel).expect("Parallel 解析成功");
        assert_eq!(items[0].snippet, "内容");
        let bocha = serde_json::json!({
            "data": {"webPages": {"value": [{"name": "博查命中", "url": "https://d.example/d", "snippet": "博查摘要"}]}}
        });
        let items = parse_bocha_json(&bocha).expect("Bocha 解析成功");
        assert_eq!(items[0].title, "博查命中");
        let bad = serde_json::json!({ "error": "boom" });
        assert!(parse_bocha_json(&bad).is_err());
        assert_eq!(parse_exa_json(&serde_json::json!({})).unwrap_err().kind, SearchErrorKind::Parse);
    }

    #[test]
    fn domain_whitelist_filters_and_relaxes_when_empty() {
        let items = vec![
            SearchItem { title: "A".into(), url: "https://arxiv.org/abs/1".into(), snippet: "".into(), source: "s".into() },
            SearchItem { title: "B".into(), url: "https://example.com/x".into(), snippet: "".into(), source: "s".into() },
        ];
        let filtered = filter_by_allow_domains(&items, &["arxiv.org".to_string()]);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].url, "https://arxiv.org/abs/1");
        let all = filter_by_allow_domains(&items, &[]);
        assert_eq!(all.len(), 2, "空白名单不限制");
        let subdomain = filter_by_allow_domains(&items, &["arxiv.org".to_string()]);
        assert_eq!(subdomain.len(), 1);
        assert_eq!(host_of("https://www.arxiv.org/x").as_deref(), Some("www.arxiv.org"));
    }

    #[test]
    fn error_retryable_classification() {
        assert!(SearchError::new(SearchErrorKind::Timeout, "t").retryable);
        assert!(SearchError::new(SearchErrorKind::Network, "n").retryable);
        assert!(SearchError::new(SearchErrorKind::Http(503), "s").retryable);
        assert!(SearchError::new(SearchErrorKind::Http(429), "r").retryable);
        assert!(!SearchError::new(SearchErrorKind::Http(403), "f").retryable);
        assert!(!SearchError::new(SearchErrorKind::Parse, "p").retryable);
        assert!(!SearchError::new(SearchErrorKind::Policy, "v").retryable);
        assert!(!SearchError::new(SearchErrorKind::NoKey, "k").retryable);
    }

    #[test]
    fn vendor_request_shapes_and_query_validation() {
        let (endpoint, body) = vendor_request("exa", "研究", 5);
        assert_eq!(endpoint, VENDOR_URL_EXA);
        assert_eq!(body["numResults"], 5);
        let (endpoint, _) = vendor_request("bocha", "研究", 5);
        assert_eq!(endpoint, VENDOR_URL_BOCHA);
        assert_eq!(limit_clamp(999), 20);
        assert_eq!(limit_clamp(0), 1);
    }

    #[test]
    fn retry_exhaustion_reports_last_error() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(async {
            // 不可重试错误（空查询 = Policy）直接失败，不触发重发
            let client = reqwest::Client::new();
            let keys = SearchKeys::default();
            search_with_retry(&client, "", 5, &[], &keys, 3, Duration::from_millis(0)).await
        });
        let err = result.unwrap_err();
        assert_eq!(err.kind, SearchErrorKind::Policy);
        assert!(!err.retryable);
    }

    #[test]
    fn seed_tools_web_search_declares_network_family() {
        let tools = seed_file("tools.json");
        let spec = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "web_search")
            .expect("web_search 工具存在");
        assert_eq!(spec["meta"]["domain"], "network");
    }
}

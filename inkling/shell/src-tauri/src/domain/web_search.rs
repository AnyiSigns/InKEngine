//! web_search 域：联网搜索工具——本地聚合源（多引擎抓取聚合，免费
//! 无 key）默认；用户自配厂商 key（Exa/parallel/bocha 任一）降级到
//! 厂商源；域名白名单网络策略（与 fetch 工具同款语义）；失败结构化
//! 可重试。
//!
//! - **本地聚合源**：DuckDuckGo/Bing 的免费 HTML 结果页源码抓取，
//!   多引擎结果合并去重（无 key、无配额，匿名可用）；
//! - **厂商降级**：搜索 key 配置（设置页数据驱动：exa/parallel/bocha
//!   任一 key 存在即降级，优先序 exa → parallel → bocha；全无 =
//!   本地聚合源）；
//! - **域名策略**：allow_domains 与 fetch 同款——非空白名单时
//!   逐结果过滤域名，越域结果丢弃（数据驱动，装配/TOOL 补丁补齐）；
//! - **失败结构化**：超时/网络/HTTP/解析分型 + retryable 标记，
//!   可重试错误按退避重发，不静默重放也不静默吞错。
//!
//! 依赖纪律：本模块不直接调用其它域模块；网络策略数据（tools.json
//! web_search 条目的 network_policy 白名单）由装配侧喂入。

use std::path::Path;
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
            // DPAPI 加密形态还原（壳侧落盘保护；未加密旧值原样透传）
            .map(|s| crate::domain::crypto::restore_secret(s))
    };
    SearchKeys {
        exa: key_of("exa"),
        parallel: key_of("parallel"),
        bocha: key_of("bocha"),
    }
}

/// 搜索 key 配置文件名（数据目录）。
const SEARCH_KEYS_FILE: &str = "search_keys.json";

/// 归一化搜索 key 配置 → 运行期形态（parse_search_keys 同源读取面）。
///
/// 兼容两类入参（S3 通道统一：records 通道废弃，设置档文件 = 单一权威，
/// 运行期 `read_search_keys` 每次调用读同一文件——保存即生效）：
/// - 设置表单形态 ``{search_key, search_provider}`` → ``{search: {provider: key}}``
///   （provider 归一为 exa/parallel/bocha 裸名，key 空 = 空节 = 本地聚合）；
/// - 已嵌套运行期形态 ``{search: {...}}``/``{search_keys: {...}}`` → 透传
///   并归一节内 provider 键（``exa_key`` 后缀剔除为 ``exa``），防形态漂移。
pub fn normalize_search_key_config(config: &JsonValue) -> JsonValue {
    let empty = JsonValue::Object(Default::default());
    let runtime_section = config
        .get("search")
        .or_else(|| config.get("search_keys"))
        .unwrap_or(&empty);
    let mut section = serde_json::Map::new();
    if let Some(obj) = runtime_section.as_object() {
        for (key, value) in obj {
            let bare = key.strip_suffix("_key").unwrap_or(key);
            if matches!(bare, "exa" | "parallel" | "bocha") {
                section.insert(bare.to_string(), value.clone());
            }
        }
    }
    if section.is_empty() {
        // 未识别嵌套形态：按设置表单字段投影
        let key = config
            .get("search_key")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let provider = config
            .get("search_provider")
            .and_then(JsonValue::as_str)
            .unwrap_or("exa");
        let bare = if matches!(provider, "parallel" | "bocha") {
            provider
        } else {
            "exa"
        };
        if !key.is_empty() {
            section.insert(bare.to_string(), JsonValue::String(key));
        }
    }
    JsonValue::Object(serde_json::Map::from_iter([(
        "search".to_string(),
        JsonValue::Object(section),
    )]))
}

/// 设置档落盘（唯一权威通道：data_dir/search_keys.json；保存即运行期
/// 生效——运行期按文件读取，不再写 engine records，避免双通道断链）。
/// 落盘前 provider 密钥经 DPAPI 保护（打码占位值幂等透传）。
///
/// 写盘纪律（R3）：密钥加密（`protect_secret_checked`）失败 / 目录创建
/// 失败 / 序列化失败 / 写盘失败 = Err，不落盘（不留明文、不留半态文件）；
/// 落盘经临时文件 + rename 原子替换，杜绝读到写一半的 JSON。
pub fn write_search_keys(data_dir: &Path, config: &JsonValue) -> Result<JsonValue, String> {
    let mut stored = normalize_search_key_config(config);
    if let Some(search) = stored.get_mut("search") {
        if let Some(section) = search.as_object_mut() {
            for value in section.values_mut() {
                if let JsonValue::String(key) = value {
                    *key = crate::domain::crypto::protect_secret_checked(key)
                        .map_err(|err| format!("搜索 key 加密失败（{err}）"))?;
                }
            }
        }
    }
    std::fs::create_dir_all(data_dir)
        .map_err(|err| format!("搜索 key 目录创建失败 {}: {err}", data_dir.display()))?;
    let path = data_dir.join(SEARCH_KEYS_FILE);
    let text = serde_json::to_string_pretty(&stored)
        .map_err(|err| format!("搜索 key 序列化失败: {err}"))?;
    let tmp = data_dir.join(format!(
        "{SEARCH_KEYS_FILE}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, text)
        .map_err(|err| format!("搜索 key 临时写入失败 {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|err| format!("搜索 key 原子替换失败 {}: {err}", path.display()))?;
    Ok(stored)
}

/// 从设置档读取搜索 key（缺文件回落空配置；解析失败留痕后回落空配置，
/// 不静默吞坏档）。
pub fn read_search_keys(data_dir: &Path) -> SearchKeys {
    let path = data_dir.join(SEARCH_KEYS_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<JsonValue>(&text) {
            Ok(value) => return parse_search_keys(&value),
            Err(err) => {
                tracing::warn!(target: "web_search", error = %err, path = %path.display(), "搜索 key 配置解析失败，回落默认");
            }
        }
    }
    SearchKeys::default()
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
///
/// 脆弱性标注（FB22）：依赖 HTML 类名子串匹配（`result__a`）——DDG
/// 页面微调即解析失效，属已知降级面（聚合源整体失败 = 结构化可重试
/// 错误，不静默返回空结果）。选择器按「类名包含」放宽匹配，容忍
/// 附加 class 修饰（`class="result__a result__a--ext"` 等）。
pub fn parse_ddg_html(html: &str) -> Vec<SearchItem> {
    let pattern = r#"<a class="[^"]*result__a[^"]*" href="([^"]+)">(.*?)</a>"#;
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

/// DuckDuckGo 结果摘要补全（result__snippet 行；以归一化 url 为键配对，
/// 不依赖文档序——顺序不一致/缺行时不错配，FB8）。
pub fn fill_ddg_snippets(items: &mut [SearchItem], html: &str) {
    let pattern = r#"<a class="[^"]*result__snippet[^"]*" href="([^"]+)">(.*?)</a>"#;
    let snippet_re = regex::Regex::new(pattern).expect("DDG 摘要行模式合法");
    let mut by_url: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for capture in snippet_re.captures_iter(html) {
        let url = capture
            .get(1)
            .map(|m| normalize_url(m.as_str()))
            .unwrap_or_default();
        if url.is_empty() {
            continue;
        }
        let text = capture
            .get(2)
            .map(|m| strip_html_tag(m.as_str()).trim().to_string())
            .unwrap_or_default();
        let text: String = text.chars().take(160).collect();
        by_url.insert(url, text);
    }
    for item in items.iter_mut() {
        if let Some(snippet) = by_url.get(&item.url) {
            item.snippet = snippet.clone();
        }
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

/// 厂商鉴权头选择（单一头，FB7）：按厂商官方契约取用——
/// exa = `x-api-key`（文档首选）；parallel/bocha = `Authorization: Bearer`。
/// 双头发送会被厂商拒绝（未知鉴权头/重复凭证），不得同发。
fn vendor_auth_header(provider: &str) -> &'static str {
    match provider {
        "exa" => "x-api-key",
        _ => "bearer",
    }
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
    let started = std::time::Instant::now();
    let (endpoint, body) = vendor_request(provider, query, limit);
    let mut request = client.post(endpoint).json(&body);
    match vendor_auth_header(provider) {
        "x-api-key" => {
            request = request.header("x-api-key", api_key);
        }
        _ => {
            request = request.bearer_auth(api_key);
        }
    }
    let response = match request
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
        took_ms: started.elapsed().as_millis() as u64,
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

/// 工具调用参数 → 结构化结果 JSON（执行体形态：查询/限条/域名 →
/// 结果清单或结构化失败；失败分型 + retryable 标记供提示可重试）。
///
/// keys 由装配/设置侧注入（SearchKeys 数据形态；缺省 = 本地聚合源）。
pub async fn search_tool(
    client: &reqwest::Client,
    args: &JsonValue,
    keys: &SearchKeys,
) -> String {
    let query = args.get("query").and_then(JsonValue::as_str).unwrap_or("");
    let limit = args
        .get("limit")
        .and_then(JsonValue::as_u64)
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_LIMIT);
    let domains: Vec<String> = args
        .get("domains")
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    match search_with_retry(
        client,
        query,
        limit,
        &domains,
        keys,
        2,
        Duration::from_millis(300),
    )
    .await
    {
        Ok(response) => serde_json::json!({
            "ok": true,
            "items": response
                .items
                .iter()
                .map(|item| serde_json::json!({
                    "title": item.title,
                    "url": item.url,
                    "snippet": item.snippet,
                    "source": item.source,
                }))
                .collect::<Vec<_>>(),
            "truncated": response.truncated,
            "took_ms": response.took_ms,
        })
        .to_string(),
        Err(err) => serde_json::json!({
            "ok": false,
            "status": err.kind_label(),
            "retryable": err.retryable,
            "error": err.message,
        })
        .to_string(),
    }
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
    fn normalize_search_key_projects_settings_form_to_runtime_shape() {
        // S3：设置表单形态（前端 {search_key, search_provider}）→ 运行期
        // 形态 {search: {provider: key}}——parse_search_keys 可读。
        let out = normalize_search_key_config(&serde_json::json!({
            "search_key": "sk-exa",
            "search_provider": "exa",
        }));
        assert_eq!(out["search"]["exa"], "sk-exa");
        assert!(out["search"].get("parallel").is_none());
        let bocha = normalize_search_key_config(&serde_json::json!({
            "search_key": "sk-bocha",
            "search_provider": "bocha",
        }));
        assert_eq!(bocha["search"]["bocha"], "sk-bocha");
        // 空 key = 空节（回落本地聚合）
        let empty = normalize_search_key_config(&serde_json::json!({
            "search_key": "",
            "search_provider": "exa",
        }));
        assert_eq!(empty["search"].as_object().map(|o| o.len()), Some(0));
    }

    #[test]
    fn normalize_search_key_passthrough_runtime_shape_and_rekeys_suffix() {
        // 已嵌套运行期形态透传；exa_key 后缀归并为裸名 exa（防形态漂移）。
        let nested = normalize_search_key_config(&serde_json::json!({
            "search": { "exa": "k1", "bocha_key": "k2" },
        }));
        assert_eq!(nested["search"]["exa"], "k1");
        assert_eq!(nested["search"]["bocha"], "k2");
        assert!(nested["search"].get("bocha_key").is_none());
        let old = normalize_search_key_config(&serde_json::json!({
            "search_keys": { "parallel": "pk" },
        }));
        assert_eq!(old["search"]["parallel"], "pk", "search_keys 节同样归一");
    }

    #[test]
    fn write_search_keys_then_read_makes_save_effective() {
        // S3：保存 → 运行期同源文件可读（设置页保存的搜索 key 真实生效）。
        let dir = std::env::temp_dir().join(format!("ink_search_keys_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        write_search_keys(
            &dir,
            &serde_json::json!({ "search_key": "sk-rt", "search_provider": "parallel" }),
        )
        .expect("保存成功");
        let keys = read_search_keys(&dir);
        assert_eq!(keys.parallel.as_deref(), Some("sk-rt"), "保存即运行期可读");
        assert_eq!(resolve_provider(&keys), ProviderKind::Vendor("parallel"));
        // 覆盖写入（换 provider）不残留旧厂商 key
        write_search_keys(
            &dir,
            &serde_json::json!({ "search_key": "sk-2", "search_provider": "exa" }),
        )
        .expect("覆盖保存成功");
        let keys = read_search_keys(&dir);
        assert_eq!(keys.exa.as_deref(), Some("sk-2"));
        assert!(keys.parallel.is_none(), "换提供方后旧 key 不残留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn aggregate_html_parsers_extract_results() {
        let ddg = r#"<html><body>
            <a class="result__a" href="https://example.com/a">Example 论文 A</a>
            <a class="result__snippet" href="https://example.com/a">摘要 A 内容</a>
            <a class="result__a result__a--ext" href="//html.duckduckgo.com/l/?uddg=https%3A%2F%2Farxiv.org%2Fabs%2F123&rut=zz">arXiv 摘要页</a>
        </body></html>"#;
        let mut items = parse_ddg_html(ddg);
        fill_ddg_snippets(&mut items, ddg);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].url, "https://example.com/a");
        assert_eq!(items[0].snippet, "摘要 A 内容");
        assert_eq!(items[1].url, "https://arxiv.org/abs/123", "uddg 链接解码");
        assert_eq!(items[1].snippet, "", "无摘要行 = 空摘要");
        // FB8：摘要按归一化 url 配对——文档序颠倒也不错配
        let shuffled = r#"<html><body>
            <a class="result__snippet" href="https://example.com/a">摘要 A 内容</a>
            <a class="result__a" href="https://example.com/a">Example 论文 A</a>
        </body></html>"#;
        let mut items = parse_ddg_html(shuffled);
        fill_ddg_snippets(&mut items, shuffled);
        assert_eq!(items[0].snippet, "摘要 A 内容", "url 键配对不依赖文档序");
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
    fn vendor_auth_header_is_single_per_provider() {
        // FB7：单一鉴权头——exa 走 x-api-key，其余厂商走 Bearer（不同发）
        assert_eq!(vendor_auth_header("exa"), "x-api-key");
        assert_eq!(vendor_auth_header("parallel"), "bearer");
        assert_eq!(vendor_auth_header("bocha"), "bearer");
        assert_eq!(vendor_auth_header("unknown"), "bearer", "未知厂商按 Bearer 兜底");
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
    fn search_tool_formats_structured_result() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(async {
            let client = reqwest::Client::new();
            // 空查询 = Policy 失败：结构化 JSON（ok=false/status/retryable/error）
            search_tool(
                &client,
                &serde_json::json!({"query": "", "limit": 5, "domains": []}),
                &SearchKeys::default(),
            )
            .await
        });
        let parsed: JsonValue = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["ok"], false);
        assert_eq!(parsed["status"], "policy");
        assert_eq!(parsed["retryable"], false);
        assert!(parsed["error"].as_str().unwrap().contains("查询语句为空"));
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

    #[test]
    fn read_search_keys_falls_back_on_corrupt_file() {
        // R3：解析失败不静默空配置误导——warn 留痕后回落默认（行为保持）。
        let dir = std::env::temp_dir().join(format!("ink_search_keys_bad_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(SEARCH_KEYS_FILE), "{ not-json").unwrap();
        let keys = read_search_keys(&dir);
        assert_eq!(keys, SearchKeys::default(), "坏档回落默认空配置");
        assert_eq!(resolve_provider(&keys), ProviderKind::LocalAggregate);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn write_search_keys_fails_closed_when_encryption_fails() {
        // R3：密钥加密失败 = Err 中止保存，原文件不被覆盖（不留明文）。
        let dir = std::env::temp_dir().join(format!("ink_search_keys_fc_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        write_search_keys(
            &dir,
            &serde_json::json!({ "search_key": "sk-old", "search_provider": "exa" }),
        )
        .expect("基线保存成功");
        let before = std::fs::read_to_string(dir.join(SEARCH_KEYS_FILE)).unwrap();
        crate::domain::crypto::force_dpapi_protect_failure(true);
        let outcome = write_search_keys(
            &dir,
            &serde_json::json!({ "search_key": "sk-new", "search_provider": "bocha" }),
        );
        crate::domain::crypto::force_dpapi_protect_failure(false);
        assert!(outcome.is_err(), "加密失败应 Err（中止保存）");
        assert!(outcome.unwrap_err().contains("加密失败"), "Err 须带加密原因");
        let after = std::fs::read_to_string(dir.join(SEARCH_KEYS_FILE)).unwrap();
        assert_eq!(before, after, "加密失败不得覆盖原文件");
        assert!(!after.contains("sk-new"), "新明文不得出现在落盘配置（实际: {after}）");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! 模型档案域：自动探测 + 持久化 + 上下文窗口/多模态能力标记。
//!
//! 责任边界（壳侧为主，引擎零改动）：
//! - 档案表（model_id / context_window / multimodal / 元数据 / 探测时间）
//!   走壳侧既有 rusqlite 存储（派生可重建，不入引擎库）；
//! - 自动探测主路径：连接配置（base_url/key）保存/变更时 GET
//!   `{base_url}/models`（OpenAI 兼容），解析清单与元数据写入档案；
//! - 降级路径：探测失败（自建端点/本地 Ollama/非 JSON/缺字段）→ 按
//!   模型档位缺省窗口（main 128k / router 32k，数据驱动）+ 未知多模态
//!   回落，不崩溃；
//! - 多模态三态：响应 `multimodal` 字段优先；缺失按已知清单/档位推断；
//!   仍缺失 = unknown(null)。
//!
//! 可测性：网络层经 `ModelsFetcher` 性状注入替身（HTTP 可替身），纯解析
//! 与存储逻辑零网络依赖单测。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value as JsonValue;

use super::common::{now_epoch, DomainError};

/// 探测默认超时（秒；端点无响应及时 fail-closed，不挂起前端）。
pub const PROBE_TIMEOUT_SECS: u64 = 20;

/// 缺省上下文窗口（数据驱动，按 tiers.json 的 main/router 档位形态）：
/// - 主挡位（内容生成）= 大上下文 128k；
/// - 路由挡位（轻量决策）= 小上下文 32k；
/// - 未声明档 = 回落 32k（保守，避免误给过大窗口导致 OOM）。
pub const DEFAULT_CONTEXT_WINDOW_MAIN: u64 = 128 * 1024;
pub const DEFAULT_CONTEXT_WINDOW_ROUTER: u64 = 32 * 1024;
pub const DEFAULT_CONTEXT_WINDOW_OTHER: u64 = 32 * 1024;

/// 已知多模态模型 id 子串（保守推断；命中 = 多模态）。
///
/// 仅作「缺字段时的推断」而非权威：响应显式 `multimodal` 字段永远优先。
const KNOWN_MULTIMODAL: [&str; 6] = [
    "gpt-4o",
    "gpt-4-vision",
    "claude-3",
    "gemini",
    "vision",
    "qwen-vl",
];

/// 已知纯文本模型 id 子串（命中 = 非多模态，推断优先于 unknown）。
const KNOWN_TEXT_ONLY: [&str; 5] = [
    "embedding",
    "instruct",
    "tts",
    "whisper",
    "rerank",
];

/// 多模态能力三态（unknown = 供应商未声明、无法推断）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Multimodal {
    True,
    False,
    Unknown,
}

impl Multimodal {
    /// 落 JSON 形态：显式 true/false，unknown = null（前端按「未知」渲染）。
    pub fn to_json(&self) -> JsonValue {
        match self {
            Multimodal::True => JsonValue::Bool(true),
            Multimodal::False => JsonValue::Bool(false),
            Multimodal::Unknown => JsonValue::Null,
        }
    }

    /// 存储形态：文本 'true'/'false'/'unknown'（显式、可读、可索引）。
    fn to_storage(&self) -> &'static str {
        match self {
            Multimodal::True => "true",
            Multimodal::False => "false",
            Multimodal::Unknown => "unknown",
        }
    }

    fn from_storage(text: &str) -> Self {
        match text {
            "true" => Multimodal::True,
            "false" => Multimodal::False,
            _ => Multimodal::Unknown,
        }
    }
}

/// 单条模型档案（持久化 + 探测回写的数据形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct ModelArchive {
    pub model_id: String,
    /// 上下文窗口（token）；None = 供应商未提供（未知）。
    pub context_window: Option<u64>,
    pub multimodal: Multimodal,
    /// 供应商原始元数据（响应条目原样留存，供前端/后续推断复用）。
    pub metadata: JsonValue,
    /// 探测/回写时间（epoch 秒）。
    pub discovered_at: f64,
}

impl ModelArchive {
    /// 落 JSON 形态（snapshot 命令回传结构）。
    pub fn to_json(&self) -> JsonValue {
        serde_json::json!({
            "model_id": self.model_id,
            "context_window": self.context_window,
            "multimodal": self.multimodal.to_json(),
            "metadata": self.metadata,
            "discovered_at": self.discovered_at,
        })
    }
}

/// 探测宣告的模型（降级/补录用：档位决定缺省窗口）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredModel {
    pub tier: String,
    pub model_id: String,
}

/// 探测错误（网络/HTTP/响应结构）；不直接抛出——降级路径结构化消化。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    Network(String),
    Http(u16),
    InvalidResponse(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Network(msg) => write!(f, "模型端点网络失败: {msg}"),
            ProbeError::Http(code) => write!(f, "模型端点 HTTP {code}"),
            ProbeError::InvalidResponse(msg) => write!(f, "模型清单响应非法: {msg}"),
        }
    }
}

/// 刷新结果（探测成功 / 降级回落；含结构化降级原因，不崩溃）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshReport {
    /// 探测模式：Success = 端点清单写入；Fallback = 降级缺省回落。
    pub mode: RefreshMode,
    /// 探测到的模型数（Success 模式 = 端点清单条数）。
    pub probed: usize,
    /// 实际落库档案数。
    pub stored: usize,
    /// 降级原因（Success 模式 = None）。
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshMode {
    Success,
    Fallback,
}

/// 归一化模型清单端点 URL：`base_url` 去尾斜杠 + `/models`。
///
/// 兼容 `http://host`、`http://host/`、`http://host/v1` 三种形态，
/// 统一产出 `http://host/v1/models`。
pub fn normalize_models_url(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/models".to_string();
    }
    format!("{trimmed}/models")
}

/// 按档位取缺省上下文窗口（数据驱动：main 128k / router 32k / 其他 32k）。
pub fn default_context_window(tier: &str) -> u64 {
    match tier {
        "main" => DEFAULT_CONTEXT_WINDOW_MAIN,
        "router" => DEFAULT_CONTEXT_WINDOW_ROUTER,
        _ => DEFAULT_CONTEXT_WINDOW_OTHER,
    }
}

/// 按模型 id 推断多模态能力（响应缺字段时的兜底推断）。
///
/// 命中已知多模态子串 → True；命中纯文本子串 → False；
/// 均不命中 → Unknown（不臆断）。
pub fn infer_multimodal(model_id: &str) -> Multimodal {
    let id = model_id.to_lowercase();
    for token in KNOWN_MULTIMODAL {
        if id.contains(token) {
            return Multimodal::True;
        }
    }
    for token in KNOWN_TEXT_ONLY {
        if id.contains(token) {
            return Multimodal::False;
        }
    }
    Multimodal::Unknown
}

/// 构建降级档案（探测失败/非 JSON/缺字段时按档位回落）。
///
/// - 上下文窗口：档位缺省（main 128k / router 32k）；
/// - 多模态：unknown（降级不臆断能力）；
/// - metadata：仅留来源标记（档位 + 降级原因），便于前端区分。
pub fn build_fallback_archive(
    model: &DeclaredModel,
    discovered_at: f64,
    reason: Option<&str>,
) -> ModelArchive {
    let mut metadata = serde_json::json!({
        "tier": model.tier,
        "source": "fallback",
    });
    if let Some(reason) = reason {
        metadata["reason"] = JsonValue::String(reason.to_string());
    }
    ModelArchive {
        model_id: model.model_id.clone(),
        context_window: Some(default_context_window(&model.tier)),
        multimodal: Multimodal::Unknown,
        metadata,
        discovered_at,
    }
}

/// 解析 OpenAI 兼容 `/models` 响应（纯函数，可单测、可注入替身）。
///
/// 形态：`{ "data": [ { "id": "...", "context_window"?: N,
/// "context_length"?: N, "multimodal"?: bool, ...metadata } ] }`。
/// - 顶层缺 `data` 数组 → `InvalidResponse`（结构化降级入口）；
/// - 单条缺 `id` → 跳过（容错，不整批失败）；
/// - `context_window`/`context_length` 任一存在即用；
/// - `multimodal` 显式优先，缺失按 id 推断。
pub fn parse_models_response(payload: &JsonValue) -> Result<Vec<ModelArchive>, ProbeError> {
    let data = payload
        .get("data")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| ProbeError::InvalidResponse("响应缺 data 数组".to_string()))?;
    let mut archives = Vec::with_capacity(data.len());
    for item in data {
        let model_id = match item.get("id").and_then(JsonValue::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => continue, // 缺 id 跳过，不整批失败
        };
        let context_window = item
            .get("context_window")
            .and_then(JsonValue::as_u64)
            .or_else(|| item.get("context_length").and_then(JsonValue::as_u64));
        let multimodal = match item.get("multimodal").and_then(JsonValue::as_bool) {
            Some(flag) => {
                if flag {
                    Multimodal::True
                } else {
                    Multimodal::False
                }
            }
            None => infer_multimodal(&model_id),
        };
        let mut metadata = item.clone();
        // 落库元数据去重 id（主键已单列），保留其余供应商字段
        if let Some(obj) = metadata.as_object_mut() {
            obj.remove("id");
        }
        archives.push(ModelArchive {
            model_id,
            context_window,
            multimodal,
            metadata,
            discovered_at: now_epoch(),
        });
    }
    Ok(archives)
}

/// 连接配置变更判定（端点/密钥任一变化 = 触发重探测）。
///
/// 纯函数：prev = 上一次生效配置（None = 首配，必探测）。
pub fn config_changed(
    prev_base_url: Option<&str>,
    prev_api_key: Option<&str>,
    new_base_url: &str,
    new_api_key: &str,
) -> bool {
    match (prev_base_url, prev_api_key) {
        (None, None) => true,
        _ => {
            let url_changed = prev_base_url.unwrap_or("") != new_base_url;
            let key_changed = prev_api_key.unwrap_or("") != new_api_key;
            url_changed || key_changed
        }
    }
}

/// 模型清单抓取性状（网络层可注入替身，测试不触真实端点）。
#[allow(async_fn_in_trait)]
pub trait ModelsFetcher {
    /// 抓取 `{base_url}/models` 的原始响应文本。
    async fn fetch_models(&self, base_url: &str, api_key: &str) -> Result<String, ProbeError>;
}

/// HTTP 抓取实现（reqwest + rustls-tls；生产路径使用）。
pub struct HttpModelsFetcher {
    client: reqwest::Client,
}

impl HttpModelsFetcher {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for HttpModelsFetcher {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelsFetcher for HttpModelsFetcher {
    async fn fetch_models(&self, base_url: &str, api_key: &str) -> Result<String, ProbeError> {
        let url = normalize_models_url(base_url);
        let mut builder = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(PROBE_TIMEOUT_SECS));
        if !api_key.trim().is_empty() {
            builder = builder.bearer_auth(api_key);
        }
        let response = builder.send().await.map_err(|err| {
            if err.is_timeout() {
                // H8：降级原因不含请求 URL——探测端点属宿主内部信息，
                // reason 经 models_refresh 回传前端会泄露内网拓扑
                ProbeError::Network("模型端点超时".to_string())
            } else {
                ProbeError::Network("模型端点连接失败".to_string())
            }
        })?;
        if !response.status().is_success() {
            return Err(ProbeError::Http(response.status().as_u16()));
        }
        response
            .text()
            .await
            .map_err(|_| ProbeError::Network("模型响应读取失败".to_string()))
    }
}

/// 探测 + 回写（降级不崩溃：失败/非 JSON/缺字段 → 按档位缺省回落）。
///
/// - 成功：解析清单逐条 upsert，返回 Success 报告；
/// - 失败/非法：对宣告模型补录降级档案（缺省窗口 + unknown 多模态），
///   返回 Fallback 报告（reason 带结构化降级原因）。
pub async fn refresh_archives<F: ModelsFetcher + ?Sized>(
    store: &mut ModelArchiveStore,
    fetcher: &F,
    base_url: &str,
    api_key: &str,
    declared: &[DeclaredModel],
) -> Result<RefreshReport, DomainError> {
    let fetched = fetcher.fetch_models(base_url, api_key).await;
    match fetched {
        Ok(text) => {
            let payload: JsonValue = match serde_json::from_str(&text) {
                Ok(value) => value,
                Err(err) => {
                    return Ok(fallback_report(store, declared, &format!("非 JSON 响应: {err}")))
                }
            };
            match parse_models_response(&payload) {
                Ok(archives) => {
                    let probed = archives.len();
                    let stored = store.upsert_many(&archives)?;
                    Ok(RefreshReport {
                        mode: RefreshMode::Success,
                        probed,
                        stored,
                        reason: None,
                    })
                }
                Err(err) => Ok(fallback_report(store, declared, &err.to_string())),
            }
        }
        Err(err) => Ok(fallback_report(store, declared, &err.to_string())),
    }
}

/// 降级回写（不崩溃）：对宣告模型补录缺省档案。
fn fallback_report(
    store: &mut ModelArchiveStore,
    declared: &[DeclaredModel],
    reason: &str,
) -> RefreshReport {
    let now = now_epoch();
    let mut stored = 0usize;
    for model in declared {
        let archive = build_fallback_archive(model, now, Some(reason));
        if store.upsert(&archive).is_ok() {
            stored += 1;
        }
    }
    RefreshReport {
        mode: RefreshMode::Fallback,
        probed: 0,
        stored,
        reason: Some(reason.to_string()),
    }
}

/// 模型档案存储（rusqlite；派生数据，可由探测历史重建）。
pub struct ModelArchiveStore {
    conn: Connection,
    path: Option<PathBuf>,
}

impl ModelArchiveStore {
    /// 打开（或新建）指定路径的档案库文件；父目录不存在时创建。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DomainError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DomainError::Storage(format!("档案库目录创建失败 {}: {e}", parent.display()))
            })?;
        }
        let conn = Connection::open(path)
            .map_err(|e| DomainError::Storage(format!("档案库打开失败 {}: {e}", path.display())))?;
        let store = Self::prepare(conn)?;
        Ok(Self {
            conn: store,
            path: Some(path.to_path_buf()),
        })
    }

    /// 数据目录下的档案库（`<dir>/model_archive.sqlite`）。
    pub fn open_in_data_dir(dir: impl AsRef<Path>) -> Result<Self, DomainError> {
        Self::open(dir.as_ref().join(MODEL_ARCHIVE_DB_NAME))
    }

    /// 内存态档案库（测试/临时批次用，零落盘）。
    pub fn open_in_memory() -> Result<Self, DomainError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| DomainError::Storage(format!("内存档案库创建失败: {e}")))?;
        let conn = Self::prepare(conn)?;
        Ok(Self { conn, path: None })
    }

    fn prepare(conn: Connection) -> Result<Connection, DomainError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS model_archive (
                model_id       TEXT PRIMARY KEY,
                context_window INTEGER,
                multimodal     TEXT NOT NULL,
                metadata       TEXT NOT NULL,
                discovered_at  REAL NOT NULL
            )",
            [],
        )
        .map_err(|e| DomainError::Storage(format!("档案表初始化失败: {e}")))?;
        Ok(conn)
    }

    /// 当前库文件路径（内存态为 None）。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 写入/覆盖一条档案（model_id 主键，语义幂等）。
    pub fn upsert(&mut self, archive: &ModelArchive) -> Result<(), DomainError> {
        let metadata = serde_json::to_string(&archive.metadata)
            .map_err(|e| DomainError::InvalidData(format!("档案元数据序列化失败: {e}")))?;
        self.conn
            .execute(
                "INSERT INTO model_archive (model_id, context_window, multimodal, metadata, discovered_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(model_id) DO UPDATE SET
                     context_window = excluded.context_window,
                     multimodal     = excluded.multimodal,
                     metadata       = excluded.metadata,
                     discovered_at  = excluded.discovered_at",
                params![
                    archive.model_id,
                    archive.context_window.map(|v| v as i64),
                    archive.multimodal.to_storage(),
                    metadata,
                    archive.discovered_at,
                ],
            )
            .map_err(|e| DomainError::Storage(format!("档案写入失败 ({}): {e}", archive.model_id)))?;
        Ok(())
    }

    /// 批量写入（同连接顺序写；逐条失败即停，返回已成功条数）。
    pub fn upsert_many(&mut self, archives: &[ModelArchive]) -> Result<usize, DomainError> {
        let mut count = 0usize;
        for archive in archives {
            self.upsert(archive)?;
            count += 1;
        }
        Ok(count)
    }

    /// 读取单条档案（不存在 = None）。
    pub fn get(&self, model_id: &str) -> Result<Option<ModelArchive>, DomainError> {
        let row = self
            .conn
            .query_row(
                "SELECT model_id, context_window, multimodal, metadata, discovered_at
                 FROM model_archive WHERE model_id = ?1",
                params![model_id],
                |row| {
                    let mid: String = row.get(0)?;
                    let ctx: Option<i64> = row.get(1)?;
                    let mm: String = row.get(2)?;
                    let meta: String = row.get(3)?;
                    let disc: f64 = row.get(4)?;
                    Ok((mid, ctx, mm, meta, disc))
                },
            )
            .optional()
            .map_err(|e| DomainError::Storage(format!("档案读取失败 ({model_id}): {e}")))?;
        Ok(row.map(|(mid, ctx, mm, meta, disc)| ModelArchive {
            model_id: mid,
            context_window: ctx.map(|v| v as u64),
            multimodal: Multimodal::from_storage(&mm),
            metadata: serde_json::from_str(&meta).unwrap_or(JsonValue::Null),
            discovered_at: disc,
        }))
    }

    /// 枚举全部档案（按 model_id 字典序，确定性）。
    pub fn list(&self) -> Result<Vec<ModelArchive>, DomainError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT model_id, context_window, multimodal, metadata, discovered_at
                 FROM model_archive ORDER BY model_id",
            )
            .map_err(|e| DomainError::Storage(format!("档案枚举准备失败: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                let mid: String = row.get(0)?;
                let ctx: Option<i64> = row.get(1)?;
                let mm: String = row.get(2)?;
                let meta: String = row.get(3)?;
                let disc: f64 = row.get(4)?;
                Ok((mid, ctx, mm, meta, disc))
            })
            .map_err(|e| DomainError::Storage(format!("档案枚举失败: {e}")))?;
        let mut archives = Vec::new();
        for row in rows {
            let (mid, ctx, mm, meta, disc) = row
                .map_err(|e| DomainError::Storage(format!("档案行读取失败: {e}")))?;
            archives.push(ModelArchive {
                model_id: mid,
                context_window: ctx.map(|v| v as u64),
                multimodal: Multimodal::from_storage(&mm),
                metadata: serde_json::from_str(&meta).unwrap_or(JsonValue::Null),
                discovered_at: disc,
            });
        }
        Ok(archives)
    }
}

/// 档案库文件名（放在数据目录下，随导出传入）。
pub const MODEL_ARCHIVE_DB_NAME: &str = "model_archive.sqlite";

/// 连接配置文件名（base_url / api_key 持久化；供下次探测 / 真实模型注入回落）。
const MODEL_CONNECTION_FILE: &str = "model_connection.json";

/// 读取模型连接配置（缺文件/解析失败回落空对象）。
pub fn read_model_connection(data_dir: &Path) -> JsonValue {
    let path = data_dir.join(MODEL_CONNECTION_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
            return value;
        }
    }
    JsonValue::Object(Default::default())
}

/// 写入模型连接配置（覆盖写入）。
pub fn write_model_connection(data_dir: &Path, config: &JsonValue) -> JsonValue {
    let path = data_dir.join(MODEL_CONNECTION_FILE);
    let _ = std::fs::create_dir_all(data_dir);
    if let Ok(text) = serde_json::to_string_pretty(config) {
        let _ = std::fs::write(&path, text);
    }
    config.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(model_id: &str, ctx: Option<u64>, mm: Multimodal) -> ModelArchive {
        ModelArchive {
            model_id: model_id.to_string(),
            context_window: ctx,
            multimodal: mm,
            metadata: serde_json::json!({ "note": "seed" }),
            discovered_at: 1.0,
        }
    }

    #[test]
    fn normalize_models_url_handles_trailing_slash_and_v1() {
        assert_eq!(normalize_models_url("http://x"), "http://x/models");
        assert_eq!(normalize_models_url("http://x/"), "http://x/models");
        assert_eq!(normalize_models_url("http://x/v1"), "http://x/v1/models");
        assert_eq!(normalize_models_url(""), "/models");
    }

    #[test]
    fn default_context_window_follows_tier() {
        assert_eq!(default_context_window("main"), DEFAULT_CONTEXT_WINDOW_MAIN);
        assert_eq!(default_context_window("router"), DEFAULT_CONTEXT_WINDOW_ROUTER);
        assert_eq!(default_context_window("audit"), DEFAULT_CONTEXT_WINDOW_OTHER);
    }

    #[test]
    fn multimodal_three_state_inference() {
        assert_eq!(infer_multimodal("x"), Multimodal::Unknown);
        assert_eq!(infer_multimodal("gpt-4o-mini"), Multimodal::True);
        assert_eq!(infer_multimodal("claude-3-sonnet"), Multimodal::True);
        assert_eq!(infer_multimodal("text-embedding-3"), Multimodal::False);
        assert_eq!(infer_multimodal("whisper-1"), Multimodal::False);
        assert_eq!(infer_multimodal("mystery-model-7b"), Multimodal::Unknown);
    }

    #[test]
    fn parse_models_response_reads_window_and_multimodal() {
        let payload = serde_json::json!({
            "data": [
                {
                    "id": "gpt-4o",
                    "context_window": 128000,
                    "multimodal": true,
                    "owned_by": "openai",
                },
                {
                    "id": "text-embedding-3",
                    "context_length": 8192,
                },
                {
                    "id": "unknown-model",
                },
                {
                    "no_id": true,
                },
            ]
        });
        let archives = parse_models_response(&payload).expect("解析应成功");
        assert_eq!(archives.len(), 3, "缺 id 条目应跳过");
        let gpt = &archives[0];
        assert_eq!(gpt.model_id, "gpt-4o");
        assert_eq!(gpt.context_window, Some(128000));
        assert_eq!(gpt.multimodal, Multimodal::True);
        assert!(gpt.metadata.get("owned_by").is_some(), "供应商字段保留");
        let emb = &archives[1];
        assert_eq!(emb.context_window, Some(8192), "context_length 兼容");
        assert_eq!(emb.multimodal, Multimodal::False, "推断为纯文本");
        let unk = &archives[2];
        assert_eq!(unk.multimodal, Multimodal::Unknown, "无信息 = unknown");
        assert_eq!(unk.context_window, None);
    }

    #[test]
    fn parse_models_response_missing_data_is_structured_error() {
        let bad = serde_json::json!({ "object": "list" });
        let err = parse_models_response(&bad).unwrap_err();
        assert!(matches!(err, ProbeError::InvalidResponse(_)));
    }

    #[test]
    fn config_changed_triggers_on_url_or_key() {
        assert!(config_changed(None, None, "http://a", "k"));
        assert!(config_changed(Some("http://a"), Some("k"), "http://b", "k"));
        assert!(config_changed(Some("http://a"), Some("k"), "http://a", "kk"));
        assert!(!config_changed(Some("http://a"), Some("k"), "http://a", "k"));
    }

    #[test]
    fn store_roundtrip_persists_and_rereads() {
        let mut store = ModelArchiveStore::open_in_memory().unwrap();
        let a = archive("model-a", Some(32000), Multimodal::False);
        store.upsert(&a).unwrap();
        let got = store.get("model-a").unwrap().expect("应读回");
        assert_eq!(got, a);
        let missing = store.get("nope").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn store_upsert_is_idempotent_and_lists_sorted() {
        let mut store = ModelArchiveStore::open_in_memory().unwrap();
        store.upsert(&archive("z", Some(1), Multimodal::True)).unwrap();
        store.upsert(&archive("a", None, Multimodal::Unknown)).unwrap();
        store.upsert(&archive("a", Some(64), Multimodal::False)).unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].model_id, "a");
        assert_eq!(list[0].context_window, Some(64));
        assert_eq!(list[1].model_id, "z");
        assert_eq!(list[1].multimodal, Multimodal::True);
    }

    #[test]
    fn fallback_archive_uses_tier_window_and_unknown_multimodal() {
        let main = DeclaredModel { tier: "main".into(), model_id: "m-main".into() };
        let router = DeclaredModel { tier: "router".into(), model_id: "m-router".into() };
        let a = build_fallback_archive(&main, 2.0, Some("探测失败"));
        let b = build_fallback_archive(&router, 2.0, Some("探测失败"));
        assert_eq!(a.context_window, Some(DEFAULT_CONTEXT_WINDOW_MAIN));
        assert_eq!(b.context_window, Some(DEFAULT_CONTEXT_WINDOW_ROUTER));
        assert_eq!(a.multimodal, Multimodal::Unknown);
        assert_eq!(a.metadata["source"], "fallback");
        assert_eq!(a.metadata["reason"], "探测失败");
    }

    struct StubFetcher {
        result: Result<String, ProbeError>,
    }

    impl ModelsFetcher for StubFetcher {
        async fn fetch_models(&self, _base_url: &str, _api_key: &str) -> Result<String, ProbeError> {
            self.result.clone()
        }
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn refresh_success_writes_probed_archives() {
        let rt = runtime();
        rt.block_on(async {
            let mut store = ModelArchiveStore::open_in_memory().unwrap();
            let payload = serde_json::json!({
                "data": [
                    { "id": "gpt-4o", "context_window": 128000, "multimodal": true },
                    { "id": "mystery", "context_window": 32000 },
                ]
            });
            let fetcher = StubFetcher { result: Ok(payload.to_string()) };
            let declared = vec![
                DeclaredModel { tier: "main".into(), model_id: "gpt-4o".into() },
            ];
            let report = refresh_archives(&mut store, &fetcher, "http://x", "k", &declared)
                .await
                .unwrap();
            assert_eq!(report.mode, RefreshMode::Success);
            assert_eq!(report.probed, 2);
            assert_eq!(report.stored, 2);
            assert!(report.reason.is_none());
            let gpt = store.get("gpt-4o").unwrap().unwrap();
            assert_eq!(gpt.context_window, Some(128000));
            assert_eq!(gpt.multimodal, Multimodal::True);
            let mystery = store.get("mystery").unwrap().unwrap();
            assert_eq!(mystery.multimodal, Multimodal::Unknown);
        });
    }

    #[test]
    fn refresh_failure_falls_back_to_default_tier_window() {
        let rt = runtime();
        rt.block_on(async {
            let mut store = ModelArchiveStore::open_in_memory().unwrap();
            let fetcher = StubFetcher {
                result: Err(ProbeError::Network("连接拒绝".into())),
            };
            let declared = vec![
                DeclaredModel { tier: "main".into(), model_id: "m-main".into() },
                DeclaredModel { tier: "router".into(), model_id: "m-router".into() },
            ];
            let report = refresh_archives(&mut store, &fetcher, "http://x", "k", &declared)
                .await
                .unwrap();
            assert_eq!(report.mode, RefreshMode::Fallback);
            assert_eq!(report.stored, 2);
            assert!(report.reason.is_some());
            let main = store.get("m-main").unwrap().unwrap();
            assert_eq!(main.context_window, Some(DEFAULT_CONTEXT_WINDOW_MAIN));
            assert_eq!(main.multimodal, Multimodal::Unknown);
            let router = store.get("m-router").unwrap().unwrap();
            assert_eq!(router.context_window, Some(DEFAULT_CONTEXT_WINDOW_ROUTER));
        });
    }

    #[test]
    fn refresh_invalid_response_structured_fallback() {
        let rt = runtime();
        rt.block_on(async {
            let mut store = ModelArchiveStore::open_in_memory().unwrap();
            let fetcher = StubFetcher { result: Ok("not-json".to_string()) };
            let declared = vec![DeclaredModel { tier: "main".into(), model_id: "m-main".into() }];
            let report = refresh_archives(&mut store, &fetcher, "http://x", "k", &declared)
                .await
                .unwrap();
            assert_eq!(report.mode, RefreshMode::Fallback);
            assert!(report.reason.as_ref().unwrap().contains("非 JSON"));
            let fetcher2 = StubFetcher {
                result: Ok(serde_json::json!({ "ok": false }).to_string()),
            };
            let report2 = refresh_archives(&mut store, &fetcher2, "http://x", "k", &declared)
                .await
                .unwrap();
            assert_eq!(report2.mode, RefreshMode::Fallback);
            assert!(report2.reason.as_ref().unwrap().contains("data 数组"));
        });
    }

    #[test]
    fn refresh_reprobe_triggers_on_config_change() {
        struct CountingFetcher {
            calls: std::cell::Cell<usize>,
            payload: String,
        }
        impl ModelsFetcher for CountingFetcher {
            async fn fetch_models(&self, _b: &str, _k: &str) -> Result<String, ProbeError> {
                let n = self.calls.get() + 1;
                self.calls.set(n);
                Ok(self.payload.clone())
            }
        }
        let rt = runtime();
        rt.block_on(async {
            let mut store = ModelArchiveStore::open_in_memory().unwrap();
            let payload = serde_json::json!({ "data": [ { "id": "a" } ] }).to_string();
            let fetcher = CountingFetcher { calls: std::cell::Cell::new(0), payload };
            let declared = vec![DeclaredModel { tier: "main".into(), model_id: "a".into() }];
            let _ = refresh_archives(&mut store, &fetcher, "http://x", "k1", &declared).await.unwrap();
            let _ = refresh_archives(&mut store, &fetcher, "http://x", "k2", &declared).await.unwrap();
            assert_eq!(fetcher.calls.get(), 2, "配置变更应触发两次重探测");
        });
    }
}

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

    /// 批量删除（按 model_id；不存在静默跳过）。返回实际删除条数。
    pub fn delete_many(&mut self, model_ids: &[String]) -> Result<usize, DomainError> {
        let mut removed = 0usize;
        for model_id in model_ids {
            let n = self
                .conn
                .execute("DELETE FROM model_archive WHERE model_id = ?1", params![model_id])
                .map_err(|e| DomainError::Storage(format!("档案删除失败 ({model_id}): {e}")))?;
            removed += n;
        }
        Ok(removed)
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
///
/// 读取即还原：``dpapi:`` 前缀的 api_key 解密回明文（引擎/探测消费点
/// 拿真实 key；回传前端处另行打码）。
pub fn read_model_connection(data_dir: &Path) -> JsonValue {
    let path = data_dir.join(MODEL_CONNECTION_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(mut value) = serde_json::from_str::<JsonValue>(&text) {
            transform_provider_keys(&mut value, |key| {
                crate::domain::crypto::restore_secret(key)
            });
            return value;
        }
    }
    JsonValue::Object(Default::default())
}

/// 逐提供方变换 api_key 字段（读还原 / 写加密两侧共用遍历）。
fn transform_provider_keys(value: &mut JsonValue, mut transform: impl FnMut(&str) -> String) {
    if let JsonValue::Object(map) = value {
        if let Some(JsonValue::Array(providers)) = map.get_mut("providers") {
            for provider in providers.iter_mut() {
                if let JsonValue::Object(pmap) = provider {
                    if let Some(JsonValue::String(key)) = pmap.get_mut("api_key") {
                        *key = transform(key);
                    }
                }
            }
        } else if let Some(JsonValue::String(key)) = map.get_mut("api_key") {
            *key = transform(key);
        }
    }
}

/// 连接配置文件形态：`providers` 数组（多提供方，唯一权威）或旧 flat 形态。
///
/// flat 只在迁移期出现（旧版本落盘）：任一写入都会把 flat 投影合并进
/// providers 数组落盘，读取方经 :func:`read_connection_providers` 归一化，
/// 不感知形态差异。
fn project_flat_connection(obj: &serde_json::Map<String, JsonValue>) -> JsonValue {
    let vendor = obj.get("vendor").and_then(JsonValue::as_str).unwrap_or("");
    let provider_id_field = obj
        .get("provider_id")
        .and_then(JsonValue::as_str)
        .unwrap_or("openai_compatible");
    let is_custom = vendor == "__custom__";
    // 自定义厂商：provider_id 字段 = 用户提供商标识（适配器 key）；
    // 预设厂商：provider_id 字段 = 适配器、vendor = 预设 id。
    let provider_id = if is_custom {
        provider_id_field
    } else if !vendor.is_empty() {
        vendor
    } else {
        provider_id_field
    };
    let mut provider = serde_json::Map::new();
    provider.insert(
        "provider_id".to_string(),
        JsonValue::String(provider_id.to_string()),
    );
    provider.insert(
        "label".to_string(),
        JsonValue::String(provider_id.to_string()),
    );
    provider.insert(
        "adapter".to_string(),
        JsonValue::String(provider_id_field.to_string()),
    );
    for (flat_key, target) in [
        ("base_url", "base_url"),
        ("api_key", "api_key"),
        ("context_window", "context_window"),
        ("compression_percent", "compression_percent"),
    ] {
        if let Some(v) = obj.get(flat_key) {
            provider.insert(target.to_string(), v.clone());
        }
    }
    let mut model_ids = serde_json::Map::new();
    for (tier, key) in [
        ("main", "main_model_id"),
        ("router", "router_model_id"),
        ("audit", "audit_model_id"),
    ] {
        if let Some(id) = obj
            .get(key)
            .and_then(JsonValue::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            model_ids.insert(tier.to_string(), JsonValue::String(id.to_string()));
        }
    }
    if !model_ids.is_empty() {
        provider.insert("model_ids".to_string(), JsonValue::Object(model_ids));
    }
    JsonValue::Object(provider)
}

/// 读取连接配置的提供方数组（单一权威形态：缺文件 = 空；flat 归一化投影）。
pub fn read_connection_providers(data_dir: &Path) -> Vec<JsonValue> {
    match read_model_connection(data_dir) {
        JsonValue::Object(obj) => {
            if let Some(JsonValue::Array(list)) = obj.get("providers") {
                list.clone()
            } else if !obj.is_empty() {
                vec![project_flat_connection(&obj)]
            } else {
                vec![]
            }
        }
        _ => vec![],
    }
}

/// 提供方浅合并（缺省字段沿用已存值：api_key 未重填则保留；
/// 嵌套对象递归深合并——model_ids 逐档位保留未写入的档位）。
fn merge_provider(base: &JsonValue, incoming: &JsonValue) -> JsonValue {
    let mut merged = match base {
        JsonValue::Object(obj) => obj.clone(),
        _ => serde_json::Map::new(),
    };
    if let JsonValue::Object(obj) = incoming {
        for (k, v) in obj {
            match (merged.get(k), v) {
                (Some(JsonValue::Object(existing)), JsonValue::Object(next)) => {
                    let mut nested = existing.clone();
                    for (nk, nv) in next {
                        nested.insert(nk.clone(), nv.clone());
                    }
                    merged.insert(k.clone(), JsonValue::Object(nested));
                }
                _ => {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
    }
    JsonValue::Object(merged)
}

/// 写入模型连接配置（providers 数组形态；按 provider_id 逐提供方浅合并）。
///
/// 合并语义确保逐档保存（仅带本档字段）不会清空既有字段——典型如
/// `api_key`：设置页各档编辑仅在重填密钥时带 `api_key`，否则沿用已存值；
/// 探测回写（`models_refresh`）同样只带 base_url/api_key，须保留已存
/// 的 main/router/audit model_id。覆盖写入会丢失这些字段，故此处按
/// provider_id 做逐提供方浅合并。入参为旧 flat 形态时投影进 providers[0]
/// （迁移期兼容；落盘即新形态）。
///
/// `replace_table`（整表替换）：前端整表保存/删除提供方时打开——入参
/// providers 数组是**权威全量**，缺席的既有提供方被删除（含其 DPAPI
/// 密文一并清除），在场提供方仍按浅合并补缺省字段（api_key 未重填
/// 沿用已存值）。探测回写等单提供方增量写保持合并（false）。
///
/// 写盘纪律（R2）：api_key 加密（`protect_secret_checked`）任一失败 /
/// 目录创建失败 / 序列化失败 / 写盘失败 = Err，不落盘（不留明文、不留
/// 半态文件）；落盘经临时文件 + rename 原子替换，杜绝读到写一半的 JSON。
pub fn write_model_connection(data_dir: &Path, config: &JsonValue) -> Result<JsonValue, String> {
    write_model_connection_mode(data_dir, config, false)
}

/// 整表替换形态的写入口（前端整表保存/删除提供方；缺席提供方落删）。
pub fn write_model_connection_replace(data_dir: &Path, config: &JsonValue) -> Result<JsonValue, String> {
    write_model_connection_mode(data_dir, config, true)
}

fn write_model_connection_mode(
    data_dir: &Path,
    config: &JsonValue,
    replace_table: bool,
) -> Result<JsonValue, String> {
    let path = data_dir.join(MODEL_CONNECTION_FILE);
    std::fs::create_dir_all(data_dir)
        .map_err(|err| format!("连接配置目录创建失败 {}: {err}", data_dir.display()))?;
    // 入参非对象（异常形态）直接原样透传，不合并不落盘。
    let JsonValue::Object(incoming) = config else {
        return Ok(config.clone());
    };
    let incoming_providers = match incoming.get("providers") {
        Some(JsonValue::Array(list)) => list.clone(),
        _ => vec![project_flat_connection(incoming)],
    };
    let previous = read_connection_providers(data_dir);
    let mut merged: Vec<JsonValue> = if replace_table {
        // 整表替换：缺席既有提供方删除（含其加密 api_key 密文清除——
        // 删除即不回写密文，重启不复活）。在场提供方经下方浅合并保留
        // 未重填字段（api_key 未带 = 沿用已存值）。
        vec![]
    } else {
        previous.clone()
    };
    for incoming_provider in &incoming_providers {
        let pid = incoming_provider
            .get("provider_id")
            .and_then(JsonValue::as_str)
            .unwrap_or("default");
        if replace_table {
            // 整表替换：在场提供方与其既有存储副本浅合并（api_key 未带 =
            // 沿用已存值、model_ids 未带 = 保留已存档位）；前一次合并结果
            // 不回写（缺席删除语义由下方 removed_model_ids 判定，基于入参
            // 全集而非本循环增量）。
            match previous.iter().position(|p| {
                p.get("provider_id").and_then(JsonValue::as_str) == Some(pid)
            }) {
                Some(idx) => merged.push(merge_provider(&previous[idx], incoming_provider)),
                None => merged.push(incoming_provider.clone()),
            }
            continue;
        }
        match merged.iter().position(|p| {
            p.get("provider_id").and_then(JsonValue::as_str) == Some(pid)
        }) {
            Some(idx) => {
                merged[idx] = merge_provider(&merged[idx], incoming_provider);
            }
            None => merged.push(incoming_provider.clone()),
        }
    }
    // 整表替换 = 删除语义生效：被删除提供方的档案一并清理（档案/候选
    // 按当前连接过滤，删除端点后旧模型不留在候选与档案库中）。
    let mut removed_model_ids: Vec<String> = Vec::new();
    if replace_table {
        let incoming_ids: std::collections::HashSet<String> = incoming_providers
            .iter()
            .filter_map(|p| p.get("provider_id").and_then(JsonValue::as_str))
            .map(str::to_string)
            .collect();
        let removed_providers: Vec<&JsonValue> = previous
            .iter()
            .filter(|p| {
                let pid = p.get("provider_id").and_then(JsonValue::as_str).unwrap_or("default");
                !incoming_ids.contains(pid)
            })
            .collect();
        if !removed_providers.is_empty() {
            // R4：先取「仍在场提供方」（merged 中保留的全部 providers）
            // 的 models 引用集合；两提供方共享同一 model_id 时，删除其一
            // 不得清掉在场方仍引用的档案——removed 与在场集合差集后才删。
            let mut present_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
            for provider in &merged {
                if let Some(list) = provider.get("models").and_then(JsonValue::as_array) {
                    for item in list {
                        if let Some(id) = item.as_str() {
                            present_ids.insert(id.to_string());
                        }
                    }
                }
            }
            removed_model_ids = removed_providers
                .iter()
                .flat_map(|p| {
                    p.get("models")
                        .and_then(JsonValue::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| m.as_str().map(str::to_string))
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                })
                .filter(|id| !present_ids.contains(id))
                .collect();
        }
    }
    let out = JsonValue::Object(serde_json::Map::from_iter([(
        "providers".to_string(),
        JsonValue::Array(merged),
    )]));
    // 落盘前加密 api_key（DPAPI；打码占位/已加密值幂等跳过）——明文
    // 不再落盘（Windows 无 DPAPI 保护的历史形态迁移：读侧识别 dpapi:
    // 前缀还原，旧明文值照常可读）。任一提供方加密失败 = Err 中止保存
    // （不落盘、不留半态），杜绝「加密失败静默落明文」。
    let mut out = out;
    try_encrypt_provider_keys(&mut out)?;
    let text = serde_json::to_string_pretty(&out)
        .map_err(|err| format!("连接配置序列化失败: {err}"))?;
    let tmp = data_dir.join(format!(
        "{MODEL_CONNECTION_FILE}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, text)
        .map_err(|err| format!("连接配置临时写入失败 {}: {err}", tmp.display()))?;
    std::fs::rename(&tmp, &path)
        .map_err(|err| format!("连接配置原子替换失败 {}: {err}", path.display()))?;
    // 档案联动清理在配置落盘成功后才执行（失败不删档，状态自洽）。
    if !removed_model_ids.is_empty() {
        if let Ok(mut store) = ModelArchiveStore::open_in_data_dir(data_dir) {
            if let Err(err) = store.delete_many(&removed_model_ids) {
                tracing::warn!(target: "model_archive", error = %err, "删除提供方档案清理失败（忽略）");
            }
        }
    }
    Ok(out)
}

/// 逐提供方加密 api_key（fail-closed 版：任一失败 = Err，调用方不落盘）。
fn try_encrypt_provider_keys(value: &mut JsonValue) -> Result<(), String> {
    if let JsonValue::Object(map) = value {
        match map.get_mut("providers").and_then(JsonValue::as_array_mut) {
            Some(providers) => {
                for provider in providers.iter_mut() {
                    if let JsonValue::Object(pmap) = provider {
                        if let Some(JsonValue::String(key)) = pmap.get_mut("api_key") {
                            *key = crate::domain::crypto::protect_secret_checked(key)
                                .map_err(|err| format!("api_key 加密失败（{err}）"))?;
                        }
                    }
                }
            }
            None => {
                if let Some(JsonValue::String(key)) = map.get_mut("api_key") {
                    *key = crate::domain::crypto::protect_secret_checked(key)
                        .map_err(|err| format!("api_key 加密失败（{err}）"))?;
                }
            }
        }
    }
    Ok(())
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
    fn write_model_connection_merges_preserving_omitted_fields() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_merge_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 首写带全量字段（含 api_key）。
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [{
                    "provider_id": "openai",
                    "adapter": "openai_compat",
                    "base_url": "http://a/v1",
                    "api_key": "sk-secret",
                    "model_ids": { "main": "m1", "router": "r1" },
                }],
            }),
        )
        .expect("首写成功");
        // 逐档保存：仅带本档字段，且未重填 api_key。
        let merged = write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [{
                    "provider_id": "openai",
                    "base_url": "http://b/v1",
                    "model_ids": { "audit": "a1" },
                }],
            }),
        )
        .expect("逐档保存成功");
        let providers = merged["providers"].as_array().expect("providers 数组");
        assert_eq!(providers.len(), 1);
        let p = &providers[0];
        assert_eq!(p["base_url"], "http://b/v1");
        assert!(
            p["api_key"]
                .as_str()
                .unwrap_or("")
                .starts_with(crate::domain::crypto::DPAPI_PREFIX),
            "api_key 落盘须为 DPAPI 加密形态（明文不落盘）"
        );
        assert_eq!(p["model_ids"]["main"], "m1", "未写入的 model_id 须保留");
        assert_eq!(p["model_ids"]["router"], "r1");
        assert_eq!(p["model_ids"]["audit"], "a1", "新字段须写入");
        // 读侧还原：加密 → 明文（缺省 api_key 须沿用已存值）
        let roundtrip = read_model_connection(&dir);
        assert_eq!(
            roundtrip["providers"][0]["api_key"], "sk-secret",
            "读侧还原 api_key 须为明文"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_model_connection_merges_preserving_model_ids_on_base_url_only() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_merge2_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // models_refresh 回写：先带 main/router/audit model_id + base_url/api_key。
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [{
                    "provider_id": "openai",
                    "base_url": "http://a/v1",
                    "api_key": "sk-secret",
                    "model_ids": { "main": "m1", "router": "r1", "audit": "a1" },
                }],
            }),
        )
        .expect("首写成功");
        // 后续仅更新连接端点（不带 model_id）：已存档位 model_id 须保留，
        // 否则 resolve_llm 二次回落会丢主档而退化为空配置。
        let merged = write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [{ "provider_id": "openai", "base_url": "http://b/v1" }],
            }),
        )
        .expect("端点更新成功");
        let p = &merged["providers"][0];
        assert_eq!(p["base_url"], "http://b/v1");
        assert_eq!(p["model_ids"]["main"], "m1", "base_url-only 保存不得清空 model_id");
        assert_eq!(p["model_ids"]["router"], "r1");
        assert_eq!(p["model_ids"]["audit"], "a1");
        // api_key 加密落盘；读侧还原明文
        assert!(
            p["api_key"]
                .as_str()
                .unwrap_or("")
                .starts_with(crate::domain::crypto::DPAPI_PREFIX),
            "api_key 落盘须为 DPAPI 加密形态"
        );
        let roundtrip = read_model_connection(&dir);
        assert_eq!(roundtrip["providers"][0]["api_key"], "sk-secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_model_connection_migrates_flat_to_providers() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_flat_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 旧 flat 形态写入 → 落盘为 providers 形态（迁移期兼容）。
        let out = write_model_connection(
            &dir,
            &serde_json::json!({
                "vendor": "moonshot",
                "provider_id": "openai_compat",
                "base_url": "http://m/v1",
                "api_key": "sk-m",
                "main_model_id": "kimi",
                "audit_model_id": "kimi-lite",
            }),
        )
        .expect("flat 写入成功");
        assert!(out.get("providers").is_some(), "flat 写入应落成 providers 形态");
        let p = &out["providers"][0];
        assert_eq!(p["provider_id"], "moonshot");
        assert_eq!(p["adapter"], "openai_compat");
        assert_eq!(p["base_url"], "http://m/v1");
        assert_eq!(p["model_ids"]["main"], "kimi");
        assert_eq!(p["model_ids"]["audit"], "kimi-lite");
        // 读取方归一化：read_connection_providers 直接返回数组
        let providers = read_connection_providers(&dir);
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0]["provider_id"], "moonshot");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_connection_providers_projects_legacy_flat_file() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_legacy_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join(MODEL_CONNECTION_FILE),
            serde_json::to_string_pretty(&serde_json::json!({
                "vendor": "__custom__",
                "provider_id": "my_llm",
                "base_url": "http://c/v1",
                "main_model_id": "cm",
            }))
            .expect("序列化"),
        )
        .expect("写文件");
        let providers = read_connection_providers(&dir);
        assert_eq!(providers.len(), 1, "旧 flat 文件应投影为单提供方");
        assert_eq!(providers[0]["provider_id"], "my_llm");
        assert_eq!(providers[0]["adapter"], "my_llm");
        assert_eq!(providers[0]["model_ids"]["main"], "cm");
        // 无文件 → 空数组
        let empty = std::env::temp_dir().join(format!("ink_model_conn_none_{}", std::process::id()));
        assert!(read_connection_providers(&empty).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
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

    // ── 批 5：整表替换删除语义 + 档案联动清理 ──

    #[test]
    fn replace_table_removes_absent_provider_and_its_secret() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_replace_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 双提供方基线。
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1", "api_key": "sk-a", "models": ["gpt-4o"] },
                    { "provider_id": "moonshot", "base_url": "http://m/v1", "api_key": "sk-m", "models": ["kimi"] },
                ],
            }),
        )
        .expect("基线写入成功");
        // 整表替换：只保留 openai → moonshot（含其加密 api_key 密文）应删除。
        let out = write_model_connection_replace(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v2", "api_key": "" },
                ],
            }),
        )
        .expect("整表替换成功");
        let providers = out["providers"].as_array().expect("providers 数组");
        assert_eq!(providers.len(), 1, "缺席提供方应被删除");
        assert_eq!(providers[0]["provider_id"], "openai");
        assert_eq!(providers[0]["base_url"], "http://a/v2");
        // 重启（重读文件）不复活：moonshot 与其密文不存在于落盘配置。
        let roundtrip = read_model_connection(&dir);
        let providers = roundtrip["providers"].as_array().expect("providers 数组");
        assert_eq!(providers.len(), 1, "删除必须持久化（重启不复活）");
        assert!(!roundtrip.to_string().contains("sk-m"), "被删除提供方密文不得残留");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_table_purges_removed_provider_archives() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_purge_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 档案库预置两提供方的模型档案。
        {
            let mut store = ModelArchiveStore::open_in_data_dir(&dir).unwrap();
            store.upsert_many(&[
                archive("gpt-4o", Some(128000), Multimodal::True),
                archive("kimi", Some(64000), Multimodal::False),
            ]).unwrap();
        }
        // 双提供方配置（各自 models 清单）。
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1", "api_key": "sk-a", "models": ["gpt-4o"] },
                    { "provider_id": "moonshot", "base_url": "http://m/v1", "api_key": "sk-m", "models": ["kimi"] },
                ],
            }),
        )
        .expect("基线写入成功");
        // 整表替换删除 moonshot → 其模型档案联动清理。
        write_model_connection_replace(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1" },
                ],
            }),
        )
        .expect("整表替换成功");
        let store = ModelArchiveStore::open_in_data_dir(&dir).unwrap();
        let remaining = store.list().unwrap();
        assert_eq!(remaining.len(), 1, "被删提供方档案应联动清理");
        assert_eq!(remaining[0].model_id, "gpt-4o");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_table_keeps_existing_provider_when_field_omitted() {
        let dir = std::env::temp_dir().join(format!("ink_model_conn_replace_keep_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1", "api_key": "sk-a", "model_ids": { "router": "r1" } },
                ],
            }),
        )
        .expect("基线写入成功");
        // 前端整表保存：仍带 openai，未重填 api_key/model_ids → 沿用已存值。
        let out = write_model_connection_replace(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v2" },
                ],
            }),
        )
        .expect("整表替换成功");
        let p = &out["providers"][0];
        assert_eq!(p["base_url"], "http://a/v2");
        assert_eq!(p["model_ids"]["router"], "r1", "在场提供方未重填字段沿用已存值");
        let roundtrip = read_model_connection(&dir);
        assert_eq!(roundtrip["providers"][0]["api_key"], "sk-a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_many_only_removes_named_model_ids() {
        let mut store = ModelArchiveStore::open_in_memory().unwrap();
        store.upsert_many(&[
            archive("a", None, Multimodal::Unknown),
            archive("b", None, Multimodal::Unknown),
        ]).unwrap();
        let removed = store.delete_many(&["a".to_string(), "missing".to_string()]).unwrap();
        assert_eq!(removed, 1, "存在的删除，缺失的静默跳过");
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].model_id, "b");
    }

    #[test]
    fn replace_table_keeps_shared_model_id_archive_when_one_provider_removed() {
        // R4：两提供方共享 model_id gpt-4o（openai 与 proxy 均引用），
        // 整表替换删除 proxy → gpt-4o 仍在场（openai）引用，档案不得删除。
        let dir = std::env::temp_dir().join(format!("ink_model_conn_shared_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        {
            let mut store = ModelArchiveStore::open_in_data_dir(&dir).unwrap();
            store.upsert_many(&[
                archive("gpt-4o", Some(128000), Multimodal::True),
                archive("kimi", Some(64000), Multimodal::False),
            ]).unwrap();
        }
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1", "api_key": "sk-a", "models": ["gpt-4o"] },
                    { "provider_id": "proxy", "base_url": "http://p/v1", "api_key": "sk-p", "models": ["gpt-4o", "kimi"] },
                ],
            }),
        )
        .expect("基线写入成功");
        // 删除 proxy：gpt-4o 仍由 openai 引用 → 保留；kimi 无在场引用 → 清掉。
        write_model_connection_replace(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1" },
                ],
            }),
        )
        .expect("整表替换成功");
        let store = ModelArchiveStore::open_in_data_dir(&dir).unwrap();
        let remaining = store.list().unwrap();
        let ids: Vec<&str> = remaining.iter().map(|a| a.model_id.as_str()).collect();
        assert!(
            ids.contains(&"gpt-4o"),
            "共享 model_id 由在场提供方引用，档案须保留（实际 {ids:?}）"
        );
        assert!(
            !ids.contains(&"kimi"),
            "无在场提供方引用的档案应联动清理（实际 {ids:?}）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn write_connection_fails_closed_when_api_key_encryption_fails() {
        // R2：api_key 加密失败 = Err 中止保存，原文件不被覆盖（不留明文）。
        let dir = std::env::temp_dir().join(format!("ink_model_conn_fc_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        write_model_connection(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://a/v1", "api_key": "sk-a" },
                ],
            }),
        )
        .expect("基线写入成功");
        let before = std::fs::read_to_string(dir.join(MODEL_CONNECTION_FILE)).unwrap();
        crate::domain::crypto::force_dpapi_protect_failure(true);
        let outcome = write_model_connection_replace(
            &dir,
            &serde_json::json!({
                "providers": [
                    { "provider_id": "openai", "base_url": "http://b/v1", "api_key": "sk-new" },
                ],
            }),
        );
        crate::domain::crypto::force_dpapi_protect_failure(false);
        assert!(outcome.is_err(), "加密失败应 Err（中止保存）");
        assert!(outcome.unwrap_err().contains("加密失败"), "Err 须带加密原因");
        let after = std::fs::read_to_string(dir.join(MODEL_CONNECTION_FILE)).unwrap();
        assert_eq!(before, after, "加密失败不得覆盖原文件（不留半态/明文）");
        assert!(
            !after.contains("sk-new"),
            "新明文不得出现在落盘配置（实际: {after}）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

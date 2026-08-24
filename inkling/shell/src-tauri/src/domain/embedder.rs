//! 本地嵌入器域：granite-97m 本地 ONNX 嵌入 + 远端/降级语义的协议同位件。
//!
//! 定位：检索链路的文本 → 向量入口，与桥层 `RustEmbedder` 同构
//! （`aembed_query` / `aembed_documents` / `aclose`），本模块是纯 Rust
//! 库逻辑、不依赖引擎 op 通道——桥层后续可把它作为真实推理实现包装，
//! 协议形态不变。
//!
//! 模型规格：`inkling/models/granite-97m/`（ModernBERT 系，CLS 池化，
//! hidden_size=384 —— 词表 18 万、Q8 量化 ONNX 约 98MB）：
//! - `model_quint8_avx2.onnx`：量化 ONNX 图（该文件为 AVX2 变体；
//!   需要换机/torch 等特定内核时的部署形态由宿主决定，本模块按
//!   目录内这份文件名探测）；
//! - `tokenizer.json`：ModernBERT BPE 分词器（transformers 4.56 导出）；
//! - `config.json` / `1_Pooling_config.json`：hidden_size=384 与
//!   pooling_mode_cls_token=true 的机器可读声明（共振载入时从此读维度，
//!   池化锚点 bos_token_id 也从此读——ModernBERT 的 bos 是
//!   `<|startoftext|>`，token id 179934，与 BERT「[CLS]=1」假设不同，
//!   不得硬编码）。
//!
//! 真实推理链路（懒加载单体，首次检索才载入）：tokenizer encode →
//! ONNX 会话跑 hidden_state → 按 `config.json` 的 bos_token_id 取该位置
//! 行（CLS 池化）→ L2 归一 → 384 维向量。推理经 ONNX Runtime 自身线程
//! 池异步执行（`run_async`），不阻塞 tokio 运行时；会话串行互斥。
//!
//! 环境变量显式覆盖（读于首次检索的解析期，模拟远端或跳过本地）：
//! - `INK_EMBEDDING_BASE_URL` + `INK_EMBEDDING_MODEL`：配齐即走远端
//!   OpenAI 兼容 `/embeddings` 端点（宿主自建/网关形态）；
//! - `INK_EMBEDDING_ADAPTER`（默认 openai_compat）/ `INK_EMBEDDING_API_KEY` /
//!   `INK_EMBEDDING_REQUEST_TIMEOUT`（秒，默认 60）；
//! - `INK_EMBEDDING_LOCAL=off`（或 0/false/no/skip/disable）：显式跳过
//!   本地模型，直达确定性保底向量；
//! - `INK_EMBEDDING_MODEL_DIR`：模型目录覆盖（默认相对当前目录
//!   `inkling/models/granite-97m`）。
//!
//! 降级回退（永不明返回空向量）：加载失败（目录缺失/配置不可读/维度
//! 断言不一致/ONNX 文件缺失/分词器或会话加载失败/推理异常）→ 确定性
//! 向量保底（语义同桥层 fake_vector：FNV-1a + sin 散射，经 L2 归一），
//! 来源与原因经 [`EmbedderPlan`] 与 [`LocalOnnxEmbedder::note`] 可观测
//! （结构化错误，不 panic）。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use super::common::DomainError;

/// 模型目录默认位置（相对进程当前目录；可用 `INK_EMBEDDING_MODEL_DIR` 覆盖）。
pub const GRANITE_MODEL_DIR_DEFAULT: &str = "inkling/models/granite-97m";

/// 模型维度（`config.json` hidden_size=384，池化声明 CLS；写码断言至此）。
pub const GRANITE_97M_DIM: usize = 384;

/// 本地 ONNX 图文件名（Q8 量化 AVX2 变体）。
pub const LOCAL_ONNX_FILE: &str = "model_quint8_avx2.onnx";

/// 本地分词器文件名（ModernBERT BPE）。
pub const LOCAL_TOKENIZER_FILE: &str = "tokenizer.json";

/// 本地模型配置文件名（维度/池化锚点机器可读声明）。
pub const LOCAL_MODEL_CONFIG_FILE: &str = "config.json";

/// 远端适配器注册名默认值（与引擎注册表口径一致）。
pub const REMOTE_ADAPTER_DEFAULT: &str = "openai_compat";

/// 远端调用超时默认值（秒）。
pub const REMOTE_TIMEOUT_DEFAULT_SECS: f64 = 60.0;

/// 单条输入最大序列长度（ModernBERT 训练序列长；超出截断——分词器
/// 自身截断上限 32768 属理论值，推理实用档取 2048，防超长输入拖慢）。
pub const MAX_SEQUENCE_LEN: usize = 2048;

/// ONNX 会话 intra-op 线程数（异步推理在会话线程池执行，须多于 1）。
const SESSION_INTRA_THREADS: usize = 2;

/// 模型输出名优先序（sentence-transformers 导出形态名；按名取 hidden
/// state 输出，避免依赖输出顺序——无命中时取首个输出）。
const HIDDEN_STATE_OUTPUT_PRIORITY: [&str; 3] =
    ["last_hidden_state", "hidden_states", "output"];

/// 嵌入来源（计划解析结果；向量产出按此路由）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedSource {
    /// 本地 ONNX 模型（真实推理；加载/推理失败时以确定性向量保底）。
    LocalOnnx,
    /// 远端 OpenAI 兼容端点。
    Remote,
    /// 确定性保底向量（无模型/显式跳过）。
    Deterministic,
}

/// 远端端点描述（OpenAI 兼容 `/embeddings`）。
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteEndpoint {
    /// API 根地址（如 `https://.../v1`）。
    pub base_url: String,
    /// 模型标识（远端接受模型名）。
    pub model_id: String,
    /// 适配器注册名（兼容引擎注册表语义）。
    pub adapter: String,
    /// API 密钥（可空——本地/免鉴权端点）。
    pub api_key: Option<String>,
    /// 单请求超时。
    pub timeout: Duration,
}

/// 嵌入计划：来源 + 维度 + 可观测原因（降级时记录为什么）。
#[derive(Debug, Clone, PartialEq)]
pub struct EmbedderPlan {
    pub source: EmbedSource,
    pub dim: usize,
    /// 降级/覆盖原因（无异常时 None）。
    pub note: Option<String>,
    /// 远端形态（source == Remote 时必有）。
    pub remote: Option<RemoteEndpoint>,
}

impl EmbedderPlan {
    fn deterministic(dim: usize, note: impl Into<String>) -> Self {
        Self {
            source: EmbedSource::Deterministic,
            dim,
            note: Some(note.into()),
            remote: None,
        }
    }
}

/// 环境变量读取（默认经由 `std::env::var`；注入形态供纯函数测试）。
pub fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// 解析嵌入计划（纯函数：环境经 lookup 注入，模型检查只读文件系统）。
///
/// 覆盖优先级：远端（BASE_URL+MODEL 配齐）→ 本地显式跳过 → 本地模型
/// （存在且校验通过）→ 确定性保底。任何一步失败都带原因落到保底。
pub fn resolve_plan<L>(lookup: L, model_dir: &Path, default_dim: usize) -> EmbedderPlan
where
    L: Fn(&str) -> Option<String>,
{
    let base_url = lookup("INK_EMBEDDING_BASE_URL")
        .filter(|v| !v.is_empty())
        .or_else(|| None);
    let model_id = lookup("INK_EMBEDDING_MODEL").filter(|v| !v.is_empty());
    if let (Some(base), Some(model)) = (base_url, model_id) {
        let timeout_secs = lookup("INK_EMBEDDING_REQUEST_TIMEOUT")
            .filter(|v| !v.is_empty())
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(REMOTE_TIMEOUT_DEFAULT_SECS);
        let api_key = lookup("INK_EMBEDDING_API_KEY").filter(|v| !v.is_empty());
        return EmbedderPlan {
            source: EmbedSource::Remote,
            dim: default_dim,
            note: None,
            remote: Some(RemoteEndpoint {
                base_url: base,
                model_id: model,
                adapter: lookup("INK_EMBEDDING_ADAPTER")
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| REMOTE_ADAPTER_DEFAULT.to_string()),
                api_key,
                timeout: Duration::from_secs_f64(timeout_secs),
            }),
        };
    }

    let local_skip = lookup("INK_EMBEDDING_LOCAL")
        .filter(|v| !v.is_empty())
        .is_some_and(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "off" | "0" | "false" | "no" | "skip" | "disable"
            )
        });
    if local_skip {
        return EmbedderPlan::deterministic(
            default_dim,
            "本地嵌入被 INK_EMBEDDING_LOCAL 显式跳过（确定性保底）",
        );
    }

    if !model_dir.is_dir() {
        return EmbedderPlan::deterministic(
            default_dim,
            format!("模型目录不存在: {}", model_dir.display()),
        );
    }

    // 维度从模型配置断言（本地模型信息是权威：缺失/不一致不得静默猜测）
    let dim = match read_model_config(model_dir) {
        Ok(config) if config.hidden_size == GRANITE_97M_DIM => config.hidden_size,
        Ok(config) => {
            return EmbedderPlan::deterministic(
                default_dim,
                format!(
                    "模型维度 {} 与预期 {} 不一致（配置文件声明）",
                    config.hidden_size, GRANITE_97M_DIM
                ),
            );
        }
        Err(reason) => {
            return EmbedderPlan::deterministic(default_dim, reason);
        }
    };
    for file in [LOCAL_ONNX_FILE, LOCAL_TOKENIZER_FILE] {
        if !model_dir.join(file).is_file() {
            return EmbedderPlan::deterministic(
                default_dim,
                format!("模型文件缺失: {}（缺 {file}）", model_dir.display()),
            );
        }
    }

    EmbedderPlan {
        source: EmbedSource::LocalOnnx,
        dim,
        note: None,
        remote: None,
    }
}

/// 模型配置的机器可读声明（维度 + 池化锚点；从 `config.json` 读取）。
struct ModelConfig {
    hidden_size: usize,
    /// bos token id（ModernBERT 的 `<|startoftext|>`；CLS 池化的取行位置）。
    bos_token_id: u32,
}

/// 从 `config.json` 读取模型配置（现代 BERT 配置形态的声明）。
fn read_model_config(model_dir: &Path) -> Result<ModelConfig, String> {
    let config = model_dir.join(LOCAL_MODEL_CONFIG_FILE);
    let raw = std::fs::read_to_string(&config)
        .map_err(|e| format!("模型配置读取失败 ({}): {e}", config.display()))?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("模型配置解析失败 ({}): {e}", config.display()))?;
    let hidden_size = value
        .get("hidden_size")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .ok_or_else(|| format!("模型配置缺 hidden_size 字段 ({}): {raw}", config.display()))?;
    let bos_token_id = value
        .get("bos_token_id")
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .ok_or_else(|| format!("模型配置缺 bos_token_id 字段 ({}): {raw}", config.display()))?;
    Ok(ModelConfig {
        hidden_size,
        bos_token_id,
    })
}

/// 确定性向量（桥层 fake_vector 语义：FNV-1a 种子 + sin 散射），
/// 输出前做 L2 归一——与真实嵌入同形态（单位球面上可比余弦）。
pub fn deterministic_vector(text: &str, dim: usize) -> Vec<f64> {
    let mut state: u64 = 0x811c9dc5;
    for byte in text.bytes() {
        state ^= u64::from(byte);
        state = state.wrapping_mul(0x0100_0193);
    }
    let mut vector: Vec<f64> = (0..dim)
        .map(|i| {
            let x = state as f64 + (i as f64) * 12.9898;
            (x.sin() * 43758.5453).fract()
        })
        .collect();
    l2_normalize(&mut vector);
    vector
}

/// L2 归一（零向量原样保留，防除零）。
pub fn l2_normalize(vector: &mut [f64]) {
    let norm = vector.iter().map(|v| v * v).sum::<f64>().sqrt();
    if norm > 1e-12 {
        for value in vector.iter_mut() {
            *value /= norm;
        }
    }
}

// ── 本地真实推理运行时（ort + tokenizers；懒加载单例）──

/// 本地推理运行时：分词器 + ONNX 会话 + 维度/池化锚点。
///
/// 会话经 tokio Mutex 串行（`run_async` 需要独占访问，单实例推理本就
/// 串行；跨 await 持有 guard 要求其 Send——推理 future 经异步桥
/// 注入引擎侧执行，须满足跨线程传递约束）。本结构由
/// [`LocalOnnxEmbedder`] 的 OnceLock 懒装载：成功装载一次即常驻；
/// 装载失败记录原因，此后以确定性向量保底（不重试装载）。
struct LocalRuntime {
    tokenizer: tokenizers::Tokenizer,
    session: tokio::sync::Mutex<ort::session::Session>,
    dim: usize,
    bos_token_id: u32,
}

/// 装载本地推理运行时：配置断言 → 分词器解析 → ONNX 会话提交。
/// 任何一步失败返回带原因的 Err（调用方落确定性保底，不 panic）。
fn load_local_runtime(model_dir: &Path) -> Result<LocalRuntime, String> {
    let config = read_model_config(model_dir)?;
    if config.hidden_size != GRANITE_97M_DIM {
        return Err(format!(
            "模型维度 {} 与预期 {} 不一致（配置文件声明）",
            config.hidden_size, GRANITE_97M_DIM
        ));
    }
    let tokenizer_path = model_dir.join(LOCAL_TOKENIZER_FILE);
    let tokenizer = tokenizers::Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("分词器加载失败 ({}): {e}", tokenizer_path.display()))?;
    let session = ort::session::Session::builder()
        .map_err(|e| format!("ONNX 会话构建器初始化失败: {e}"))?
        .with_intra_threads(SESSION_INTRA_THREADS)
        .map_err(|e| format!("ONNX 会话线程配置失败: {e}"))?
        .commit_from_file(model_dir.join(LOCAL_ONNX_FILE))
        .map_err(|e| format!("ONNX 会话提交失败 ({}): {e}", model_dir.join(LOCAL_ONNX_FILE).display()))?;
    Ok(LocalRuntime {
        tokenizer,
        session: tokio::sync::Mutex::new(session),
        dim: config.hidden_size,
        bos_token_id: config.bos_token_id,
    })
}

/// 会话输出名 → hidden state 输出下标（按声明优先序；无命中取首个）。
fn select_hidden_state_output(session: &ort::session::Session) -> usize {
    HIDDEN_STATE_OUTPUT_PRIORITY
        .iter()
        .filter_map(|name| session.outputs.iter().position(|o| &o.name == name))
        .next()
        .unwrap_or(0)
}

/// 单条文本 → 向量（真实推理：分词 → ONNX 编码 → CLS 行 → L2 归一）。
///
/// CLS 池化取「token id == config bos_token_id 的首个位置」行——ModernBERT
/// 的 bos 是 `<|startoftext|>`（179934），由分词器模板加在序列首，按 id
/// 定位不依赖「[CLS]=1」式硬编码；找不到时取首位置（bos 恒为序列首）。
/// 推理经会话线程池异步执行，不阻塞 tokio 运行时。
async fn infer_vector(runtime: &LocalRuntime, text: &str) -> Result<Vec<f64>, String> {
    let encoding = runtime
        .tokenizer
        .encode(text, true)
        .map_err(|e| format!("分词失败: {e}"))?;
    let mut ids: Vec<i64> = encoding.get_ids().iter().map(|&id| id as i64).collect();
    let mut mask: Vec<i64> = encoding
        .get_attention_mask()
        .iter()
        .map(|&m| m as i64)
        .collect();
    if ids.len() > MAX_SEQUENCE_LEN {
        ids.truncate(MAX_SEQUENCE_LEN);
        mask.truncate(MAX_SEQUENCE_LEN);
    }
    let seq_len = ids.len();
    if seq_len == 0 {
        return Err("分词结果为空".to_string());
    }

    let input_ids = ort::value::Tensor::from_array(([1usize, seq_len], ids.clone()))
        .map_err(|e| format!("输入张量构建失败: {e}"))?;
    let attention_mask = ort::value::Tensor::from_array(([1usize, seq_len], mask))
        .map_err(|e| format!("注意力掩码张量构建失败: {e}"))?;
    let inputs = ort::inputs! {
        "input_ids" => input_ids,
        "attention_mask" => attention_mask,
    };
    let run_options = ort::session::run_options::RunOptions::new()
        .map_err(|e| format!("ONNX 运行选项创建失败: {e}"))?;

    // 会话持锁跨 await（run_async 的 future 借用会话本体，guard 须在
    // 等待结束后才释——tokio guard 为 Send，推理 future 可跨线程传递，
    // 见结构注释）
    let mut session = runtime.session.lock().await;
    let output_idx = select_hidden_state_output(&session);
    let outputs = session
        .run_async(inputs, &run_options)
        .map_err(|e| format!("ONNX 推理启动失败: {e}"))?
        .await
        .map_err(|e| format!("ONNX 推理失败: {e}"))?;
    if outputs.len() <= output_idx {
        return Err(format!("模型输出缺 {} 号输出（共 {})", output_idx, outputs.len()));
    }
    let (shape, data) = outputs[output_idx]
        .try_extract_tensor::<f32>()
        .map_err(|e| format!("模型输出提取失败: {e}"))?;
    let dims: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
    let hidden_dim = dims.last().copied().unwrap_or(0);
    let row_count = dims.iter().rev().nth(1).copied().unwrap_or(0);
    if hidden_dim != runtime.dim || row_count != seq_len {
        return Err(format!(
            "模型输出形态不符: {dims:?}（期望 [1, {seq_len}, {}]）",
            runtime.dim
        ));
    }

    let bos_pos = ids
        .iter()
        .position(|&id| id as u32 == runtime.bos_token_id)
        .unwrap_or(0);
    let start = bos_pos * runtime.dim;
    let mut vector: Vec<f64> = data[start..start + runtime.dim]
        .iter()
        .map(|&v| v as f64)
        .collect();
    l2_normalize(&mut vector);
    Ok(vector)
}

/// 本地嵌入器：懒加载单体——首次检索才解析计划（环境覆盖 + 文件检查），
/// 此后结果固定（OnceLock）；本地推理运行时同样首次需要时才装载
/// （OnceLock<Result>：失败原因可观测，不 panic 不重试）。
pub struct LocalOnnxEmbedder {
    model_dir: PathBuf,
    default_dim: usize,
    plan: OnceLock<EmbedderPlan>,
    runtime: OnceLock<Result<LocalRuntime, String>>,
    client: Mutex<Option<reqwest::Client>>,
}

impl Default for LocalOnnxEmbedder {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalOnnxEmbedder {
    /// 默认构造：模型目录 = `INK_EMBEDDING_MODEL_DIR`（缺省相对 CWD 的
    /// 出厂路径），维度 384。计划解析保持懒加载（首次检索才做）。
    pub fn new() -> Self {
        let model_dir = std::env::var("INK_EMBEDDING_MODEL_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(GRANITE_MODEL_DIR_DEFAULT));
        Self::with_model_dir_and_dim(model_dir, GRANITE_97M_DIM)
    }

    /// 指定模型目录构造（默认维度 384）。
    pub fn with_model_dir(model_dir: impl Into<PathBuf>) -> Self {
        Self::with_model_dir_and_dim(model_dir, GRANITE_97M_DIM)
    }

    /// 显式计划构造（测试/宿主预解析后注入：计划即权威，跳过懒解析）。
    pub fn with_plan(plan: EmbedderPlan) -> Self {
        let cell = OnceLock::new();
        let _ = cell.set(plan);
        Self {
            model_dir: PathBuf::from(GRANITE_MODEL_DIR_DEFAULT),
            default_dim: GRANITE_97M_DIM,
            plan: cell,
            runtime: OnceLock::new(),
            client: Mutex::new(None),
        }
    }

    fn with_model_dir_and_dim(model_dir: impl Into<PathBuf>, default_dim: usize) -> Self {
        Self {
            model_dir: model_dir.into(),
            default_dim,
            plan: OnceLock::new(),
            runtime: OnceLock::new(),
            client: Mutex::new(None),
        }
    }

    /// 计划（触发懒解析并缓存；后续环境变化不再影响）。
    pub fn plan(&self) -> &EmbedderPlan {
        self.plan
            .get_or_init(|| resolve_plan(env_lookup, &self.model_dir, self.default_dim))
    }

    /// 计划是否已解析（懒加载状态可观测）。
    pub fn resolved(&self) -> bool {
        self.plan.get().is_some()
    }

    /// 当前来源。
    pub fn source(&self) -> EmbedSource {
        self.plan().source
    }

    /// 当前维度（LocalOnnx 时为模型配置声明的 384）。
    pub fn dim(&self) -> usize {
        self.plan().dim
    }

    /// 降级原因（计划 note；本地推理运行时装载失败时返回该失败原因）。
    pub fn note(&self) -> Option<&str> {
        if let Some(runtime) = self.runtime.get() {
            if let Err(reason) = runtime {
                return Some(reason);
            }
        }
        self.plan().note.as_deref()
    }

    /// 本地推理运行时（懒装载并缓存；失败原因经 [`Self::note`] 可观测）。
    fn runtime(&self) -> Result<&LocalRuntime, String> {
        self.runtime
            .get_or_init(|| load_local_runtime(&self.model_dir))
            .as_ref()
            .map_err(Clone::clone)
    }

    /// 单条文本 → 向量（协议同位件 aembed_query）。
    pub async fn aembed_query(&self, text: &str) -> Result<Vec<f64>, DomainError> {
        let plan = self.plan();
        match plan.source {
            EmbedSource::Remote => {
                let vectors = self.remote_embed(vec![text.to_string()]).await?;
                vectors
                    .into_iter()
                    .next()
                    .ok_or_else(|| DomainError::External("远端 embedding 未返回向量".to_string()))
            }
            _ => Ok(self.local_or_deterministic(plan, text).await),
        }
    }

    /// 文本列表 → 向量列表（协议同位件 aembed_documents，顺序与输入一致）。
    pub async fn aembed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f64>>, DomainError> {
        let plan = self.plan();
        match plan.source {
            EmbedSource::Remote => self.remote_embed(texts.to_vec()).await,
            _ => {
                let mut vectors = Vec::with_capacity(texts.len());
                for text in texts {
                    vectors.push(self.local_or_deterministic(plan, text).await);
                }
                Ok(vectors)
            }
        }
    }

    /// 关闭（幂等）：释放远端 client 连接池；本地/保底路径无事可做。
    pub async fn aclose(&self) -> Result<(), DomainError> {
        *self.client.lock().unwrap() = None;
        Ok(())
    }

    /// 本地嵌入（真实推理优先）：运行时可用走 ONNX；装载失败/推理异常
    /// 一律落确定性保底（结构化原因经 [`Self::note`] 可观测，不 panic）。
    async fn local_or_deterministic(&self, plan: &EmbedderPlan, text: &str) -> Vec<f64> {
        if plan.source == EmbedSource::LocalOnnx {
            if let Ok(runtime) = self.runtime() {
                if let Ok(vector) = infer_vector(runtime, text).await {
                    return vector;
                }
            }
        }
        deterministic_vector(text, plan.dim)
    }

    fn client(&self) -> Result<reqwest::Client, DomainError> {
        let plan = self.plan();
        let remote = plan.remote.as_ref().ok_or_else(|| {
            DomainError::Other("远端 client 仅在远端计划下可用（计划未含 remote）".to_string())
        })?;
        let mut guard = self.client.lock().unwrap();
        if let Some(client) = guard.as_ref() {
            return Ok(client.clone());
        }
        let client = reqwest::Client::builder()
            .timeout(remote.timeout)
            .build()
            .map_err(|e| DomainError::External(format!("远端嵌入 client 构建失败: {e}")))?;
        *guard = Some(client.clone());
        Ok(client)
    }

    /// 远端 OpenAI 兼容 `/embeddings` 单请求（批量则输入数组，按 index 还原顺序）。
    async fn remote_embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f64>>, DomainError> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let plan = self.plan();
        let remote = plan.remote.as_ref().ok_or_else(|| {
            DomainError::Other("远端计划不含端点信息（不应到达）".to_string())
        })?;
        let input: serde_json::Value = if texts.len() == 1 {
            serde_json::Value::String(texts[0].clone())
        } else {
            serde_json::Value::Array(
                texts.into_iter().map(serde_json::Value::String).collect(),
            )
        };
        let body = serde_json::json!({ "model": remote.model_id, "input": input });
        let endpoint = format!("{}/embeddings", remote.base_url.trim_end_matches('/'));
        let mut request = self.client()?.post(&endpoint).json(&body);
        if let Some(key) = &remote.api_key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .map_err(|e| DomainError::External(format!("远端 embedding 请求失败: {e}")))?;
        if !response.status().is_success() {
            return Err(DomainError::External(format!(
                "远端 embedding 返回 {}（endpoint: {endpoint}）",
                response.status()
            )));
        }
        let payload: serde_json::Value = response
            .json()
            .await
            .map_err(|e| DomainError::External(format!("远端 embedding 响应解析失败: {e}")))?;
        coerce_remote_vectors(&payload, plan.dim)
    }
}

/// 远端响应 → 向量列表（data 数组按 index 排序；逐项做 L2 归一保持单位球面）。
fn coerce_remote_vectors(
    payload: &serde_json::Value,
    expected_dim: usize,
) -> Result<Vec<Vec<f64>>, DomainError> {
    let data = payload
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| DomainError::External("远端 embedding 响应缺 data 数组".to_string()))?;
    let mut indexed: Vec<(usize, Vec<f64>)> = Vec::new();
    for item in data {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let index = obj
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(indexed.len());
        let embedding = obj
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or_else(|| DomainError::External("远端 embedding 响应缺 embedding 数组".to_string()))?;
        let floats: Vec<f64> = embedding
            .iter()
            .map(|v| v.as_f64())
            .collect::<Option<Vec<f64>>>()
            .ok_or_else(|| DomainError::External("远端 embedding 含非数值元素".to_string()))?;
        if !floats.is_empty() && floats.len() != expected_dim {
            return Err(DomainError::External(format!(
                "远端 embedding 维度 {} 与预期 {} 不符",
                floats.len(),
                expected_dim
            )));
        }
        indexed.push((index, floats));
    }
    indexed.sort_by_key(|(index, _)| *index);
    for (_, vector) in indexed.iter_mut() {
        l2_normalize(vector);
    }
    Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    /// 测试用临时目录（Drop 时整体清理）。
    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("inkling-embedder-{label}-{}", Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 写入一个「配置齐全」的模型目录（config.json 声明 384 维 + 占位
    /// onnx/tokenizer 文件——文件存在性通过计划校验，但内容不是合法
    /// 模型：加载阶段必然失败，用于装载失败降级断言）。
    fn write_fake_model_dir(dir: &Path, hidden_size: usize) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(LOCAL_MODEL_CONFIG_FILE),
            format!(
                r#"{{"hidden_size": {hidden_size}, "bos_token_id": 179934, "model_type": "modernbert"}}"#
            ),
        )
        .unwrap();
        std::fs::write(dir.join(LOCAL_ONNX_FILE), b"onnx-placeholder").unwrap();
        std::fs::write(dir.join(LOCAL_TOKENIZER_FILE), b"tokenizer-placeholder").unwrap();
    }

    /// 真实模型目录（工作区缺模型时静默跳过——本地资产，非外部 key，
    /// 模型文件存在于工作区即可直接跑）。
    fn real_model_dir() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../inkling/models/granite-97m");
        dir.is_dir().then_some(dir)
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    /// 测试用 tokio 多线程运行时（真实推理经 ONNX 线程池异步执行）。
    fn tokio_rt() -> tokio::runtime::Runtime {
        tokio::runtime::Runtime::new().unwrap()
    }

    #[test]
    fn deterministic_vectors_are_stable_and_unit_norm() {
        let plan = EmbedderPlan::deterministic(384, "测试保底");
        let embedder = LocalOnnxEmbedder::with_plan(plan);
        let v1 = tokio_rt().block_on(embedder.aembed_query("测试输入")).unwrap();
        assert_eq!(v1.len(), 384);
        let norm: f64 = v1.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6, "输出须为单位向量, norm={norm}");

        // 同文再生 = 同向量（保底确定性）；异文 = 向量不同
        let v2 = deterministic_vector("测试输入", 384);
        assert_eq!(v1, v2);
        let v3 = deterministic_vector("另一段输入", 384);
        assert_ne!(v1, v3);
    }

    #[test]
    fn local_model_present_resolves_to_384_dim() {
        let dir = TestDir::new("local");
        write_fake_model_dir(dir.path(), GRANITE_97M_DIM);
        let plan = resolve_plan(no_env, dir.path(), GRANITE_97M_DIM);
        assert_eq!(plan.source, EmbedSource::LocalOnnx);
        assert_eq!(plan.dim, GRANITE_97M_DIM);
        // 计划期无降级原因（真实推理已接线；装载失败在运行时阶段观测）
        assert!(plan.note.is_none());

        let embedder = LocalOnnxEmbedder::with_plan(plan);
        let vectors = tokio_rt()
            .block_on(embedder.aembed_documents(&["a".to_string(), "b".to_string()]))
            .unwrap();
        assert_eq!(vectors.len(), 2);
        assert!(vectors.iter().all(|v| v.len() == GRANITE_97M_DIM));
    }

    #[test]
    fn corrupt_runtime_falls_back_deterministic_with_note() {
        // 计划通过（文件齐备/维度一致）但加载必然失败（占位文件非合法
        // 模型）→ 推理落确定性保底，失败原因经 note 可观测
        let dir = TestDir::new("corrupt");
        write_fake_model_dir(dir.path(), GRANITE_97M_DIM);
        let embedder = LocalOnnxEmbedder::with_model_dir(dir.path());
        assert_eq!(embedder.source(), EmbedSource::LocalOnnx);
        let v = tokio_rt().block_on(embedder.aembed_query("测试输入")).unwrap();
        assert_eq!(v, deterministic_vector("测试输入", GRANITE_97M_DIM));
        let note = embedder.note().expect("装载失败原因应可观测");
        assert!(note.contains("分词器") || note.contains("ONNX"), "note={note}");
    }

    #[test]
    fn model_dim_mismatch_falls_back_to_deterministic() {
        let dir = TestDir::new("mismatch");
        write_fake_model_dir(dir.path(), 512);
        let plan = resolve_plan(no_env, dir.path(), GRANITE_97M_DIM);
        assert_eq!(plan.source, EmbedSource::Deterministic);
        assert!(plan.note.as_deref().unwrap().contains("维度 512"));
    }

    #[test]
    fn missing_model_dir_falls_back_with_reason() {
        let dir = TestDir::new("missing");
        let plan = resolve_plan(no_env, &dir.path().join("nope"), 384);
        assert_eq!(plan.source, EmbedSource::Deterministic);
        assert!(plan.note.as_deref().unwrap().contains("目录不存在"));
    }

    #[test]
    fn remote_env_override_takes_priority() {
        let lookup = |key: &str| match key {
            "INK_EMBEDDING_BASE_URL" => Some("http://embed.local/v1".to_string()),
            "INK_EMBEDDING_MODEL" => Some("text-embedding-3-small".to_string()),
            "INK_EMBEDDING_API_KEY" => Some("sekret".to_string()),
            "INK_EMBEDDING_REQUEST_TIMEOUT" => Some("12".to_string()),
            _ => None,
        };
        let plan = resolve_plan(lookup, Path::new("nonexistent-model-dir"), 384);
        assert_eq!(plan.source, EmbedSource::Remote);
        let remote = plan.remote.as_ref().expect("远端端点存在");
        assert_eq!(remote.model_id, "text-embedding-3-small");
        assert_eq!(remote.adapter, REMOTE_ADAPTER_DEFAULT);
        assert_eq!(remote.api_key.as_deref(), Some("sekret"));
        assert_eq!(remote.timeout, Duration::from_secs(12));
    }

    #[test]
    fn local_skip_env_forces_deterministic() {
        let lookup = |key: &str| match key {
            "INK_EMBEDDING_LOCAL" => Some("off".to_string()),
            _ => None,
        };
        let dir = TestDir::new("skip");
        write_fake_model_dir(dir.path(), GRANITE_97M_DIM);
        let plan = resolve_plan(lookup, dir.path(), 384);
        assert_eq!(plan.source, EmbedSource::Deterministic);
        assert!(plan.note.as_deref().unwrap().contains("显式跳过"));
    }

    #[test]
    fn half_configured_remote_ignored() {
        let lookup = |key: &str| match key {
            "INK_EMBEDDING_BASE_URL" => Some("http://embed.local/v1".to_string()),
            _ => None,
        };
        let dir = TestDir::new("half");
        write_fake_model_dir(dir.path(), GRANITE_97M_DIM);
        // 只配 base_url 不配 model：远端不生效，落到本地模型路径
        let plan = resolve_plan(lookup, dir.path(), 384);
        assert_eq!(plan.source, EmbedSource::LocalOnnx);
    }

    #[tokio::test]
    async fn plan_resolves_lazily_and_cache_is_stable() {
        let embedder = LocalOnnxEmbedder::new();
        assert!(!embedder.resolved(), "首次检索前不应解析计划");
        let _ = embedder.plan();
        assert!(embedder.resolved(), "首次求值后应已解析并缓存");
        assert_eq!(embedder.dim(), GRANITE_97M_DIM);
    }

    #[tokio::test]
    async fn aclose_is_idempotent() {
        let plan = EmbedderPlan::deterministic(128, "保底");
        let embedder = LocalOnnxEmbedder::with_plan(plan);
        embedder.aclose().await.unwrap();
        embedder.aclose().await.unwrap();
        let vectors = embedder
            .aembed_documents(&["x".to_string(), "y".to_string()])
            .await
            .unwrap();
        assert_eq!(vectors.len(), 2);
        assert!(vectors.iter().all(|v| v.len() == 128));
    }

    /// 出厂模型目录实测（工作区缺模型时静默跳过；本测试在 main 检出
    /// 的真实 `inkling/models/granite-97m` 上验证约定文件名与 dimension）。
    #[test]
    fn real_granite_model_dir_detected_with_expected_files() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../inkling/models/granite-97m");
        if !dir.is_dir() {
            return;
        }
        assert!(dir.join(LOCAL_ONNX_FILE).is_file());
        assert!(dir.join(LOCAL_TOKENIZER_FILE).is_file());
        let plan = resolve_plan(no_env, &dir, 384);
        assert_eq!(plan.source, EmbedSource::LocalOnnx);
        assert_eq!(plan.dim, GRANITE_97M_DIM);
    }

    // ── 真实模型推理测试（模型文件存在于工作区即可直接跑）──

    #[test]
    fn real_onnx_embeds_384_dim_unit_norm() {
        let Some(dir) = real_model_dir() else { return; };
        let embedder = LocalOnnxEmbedder::with_model_dir(dir);
        assert_eq!(embedder.source(), EmbedSource::LocalOnnx);
        assert!(embedder.note().is_none(), "计划期不应有降级原因");
        let vector = tokio_rt().block_on(embedder.aembed_query("写一个函数计算斐波那契数列")).unwrap();
        assert_eq!(vector.len(), GRANITE_97M_DIM, "真实推理维度 = 模型配置 384");
        let norm: f64 = vector.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6, "输出须为单位向量, norm={norm}");
    }

    #[test]
    fn real_onnx_similar_texts_cosine_above_dissimilar() {
        let Some(dir) = real_model_dir() else { return; };
        let embedder = LocalOnnxEmbedder::with_model_dir(dir);
        let rt = tokio_rt();
        let similar_a = rt.block_on(embedder.aembed_query("写一个函数计算斐波那契数列")).unwrap();
        let similar_b = rt.block_on(embedder.aembed_query("实现一个计算斐波那契数列的函数")).unwrap();
        let dissimilar = rt.block_on(embedder.aembed_query("今天天气怎么样")).unwrap();
        let cosine = |a: &[f64], b: &[f64]| a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f64>();
        let similar = cosine(&similar_a, &similar_b);
        let unrelated = cosine(&similar_a, &dissimilar);
        assert!(
            similar > unrelated,
            "相似文本余弦应高于不相似文本（similar={similar:.3}, unrelated={unrelated:.3}）"
        );
        // 语义锚点：同义改写应显著高于无关文本（真实模型下此差距稳定）
        assert!(similar > 0.8, "同义改写余弦应显著（{similar:.3}）");
        assert!(unrelated < 0.9, "无关文本余弦不应虚高（{unrelated:.3}）");
    }

    #[test]
    fn real_onnx_is_deterministic_across_calls() {
        let Some(dir) = real_model_dir() else { return; };
        let embedder = LocalOnnxEmbedder::with_model_dir(dir);
        let rt = tokio_rt();
        let first = rt.block_on(embedder.aembed_query("同一段输入")).unwrap();
        let second = rt.block_on(embedder.aembed_query("同一段输入")).unwrap();
        assert_eq!(first, second, "同一模型同文应产出同一向量");
        assert_ne!(first, deterministic_vector("同一段输入", GRANITE_97M_DIM), "真实向量应不同于保底向量");
    }

    #[test]
    fn real_onnx_long_text_truncates_to_max_sequence() {
        let Some(dir) = real_model_dir() else { return; };
        let embedder = LocalOnnxEmbedder::with_model_dir(dir);
        let long = "长文本".repeat(MAX_SEQUENCE_LEN * 2);
        let vector = tokio_rt().block_on(embedder.aembed_query(&long)).unwrap();
        assert_eq!(vector.len(), GRANITE_97M_DIM);
        let norm: f64 = vector.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }
}

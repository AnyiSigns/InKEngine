//! 授权信封（host 已裁决签发的执行授权形态）。
//!
//! 信封是「host 裁决结果」的机器可读表达：工具名/参数/物理 op/端点归属/
//! 路径根与动态挂载根/命令白名单/出网域名白名单/尺寸与超时上界全部随
//! 请求下发，exec 侧只复核不另读策略。签名覆盖 body 原文（见 hmac.rs），
//! 本模块只负责反序列化与上界常量（机械约束的边界在 guard/ops 校验）。

use serde::Deserialize;
use serde_json::Value as JsonValue;

/// 信封版本（当前 = 1；未来破坏性变更升版本号）。
pub const ENVELOPE_VERSION: i64 = 1;

/// 进程执行超时上界（秒；与旧壳 shell_exec 声明一致，agent 可控时长的上界）。
pub const TIMEOUT_SECS_MAX: i64 = 3600;
/// 进程执行超时下界（秒；0/负值无意义，拒绝）。
pub const TIMEOUT_SECS_MIN: i64 = 1;
/// 输出截断字符上界（max_chars；防超大输出撑爆结果通道，防 host 误配）。
pub const MAX_CHARS_MAX: usize = 1 << 20;
/// 输出截断字符下界。
pub const MAX_CHARS_MIN: usize = 64;
/// 文件工具读大小上界（字节；只读整文件的安全上限，超限拒绝）。
pub const FILE_READ_BYTES_MAX: u64 = 1 << 20;
/// 文件目录列举条目上界（防巨型目录撑爆响应）。
pub const FILE_LIST_ENTRIES_MAX: usize = 10_000;
/// 显式 env 注入条数上界。
pub const ENV_ENTRIES_MAX: usize = 64;
/// 环境变量键长度上界。
pub const ENV_KEY_MAX_CHARS: usize = 128;
/// 环境变量值长度上界。
pub const ENV_VALUE_MAX_CHARS: usize = 4096;
/// http 请求体读取上界（字节；与文件读同量级）。
pub const HTTP_BODY_BYTES_MAX: usize = 1 << 20;
/// 信封内文本字段（id/nonce/tool 等）长度上界。
pub const TEXT_FIELD_MAX_CHARS: usize = 256;

/// 信封字段拒绝（机械约束；reason 分类供调用方归因）。
#[derive(Debug, Clone)]
pub struct Deny {
    pub reason: &'static str,
    pub message: String,
}

impl Deny {
    pub fn new(reason: &'static str, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }
}

/// 裁决元信息（host 审批/自动放行的留痕；exec 只要求 approved=true，
/// 不做审批判定——签名即授权，approved=false 的信封属漂移拒绝）。
#[derive(Debug, Clone, Deserialize)]
pub struct Decision {
    pub approved: bool,
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub trace_id: Option<String>,
}

/// 信封本体（签名覆盖的 JSON 文本的反序列化形态）。
#[derive(Debug, Clone, Deserialize)]
pub struct Envelope {
    pub version: i64,
    pub id: String,
    pub tool: String,
    pub op: String,
    pub args: JsonValue,
    pub endpoint: String,
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default)]
    pub allowlist: Vec<String>,
    #[serde(default)]
    pub allow_domains: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Option<JsonValue>,
    pub timeout_secs: i64,
    pub max_chars: i64,
    pub nonce: String,
    pub issued_at: i64,
    pub decision: Decision,
}

/// 信封结构校验（版本/文本字段形态/裁决已批准/上界），
/// 通过后各 op 的守门继续做参数形状与归属校验。
pub fn validate(envelope: &Envelope) -> Result<(), Deny> {
    if envelope.version != ENVELOPE_VERSION {
        return Err(Deny::new(
            "version",
            format!("信封版本 {} 不受支持（当前 {ENVELOPE_VERSION}）", envelope.version),
        ));
    }
    if !envelope.decision.approved {
        return Err(Deny::new(
            "decision",
            "信封裁决未批准（host 只签发 approved 信封；其余属漂移拒绝）",
        ));
    }
    if envelope.tool.trim().is_empty() {
        return Err(Deny::new("params", "信封缺工具名 tool"));
    }
    if envelope.op.trim().is_empty() {
        return Err(Deny::new("params", "信封缺物理 op"));
    }
    if envelope.endpoint.trim().is_empty() {
        return Err(Deny::new("params", "信封缺端点名 endpoint"));
    }
    if !envelope.args.is_object() {
        return Err(Deny::new("params", "args 须为对象"));
    }
    for (field, value) in [
        ("id", &envelope.id),
        ("nonce", &envelope.nonce),
        ("tool", &envelope.tool),
        ("endpoint", &envelope.endpoint),
    ] {
        if value.chars().count() > TEXT_FIELD_MAX_CHARS {
            return Err(Deny::new(
                "size",
                format!("信封字段 {field} 超长（≤{TEXT_FIELD_MAX_CHARS}）"),
            ));
        }
    }
    let timeout = envelope.timeout_secs;
    if timeout < TIMEOUT_SECS_MIN || timeout > TIMEOUT_SECS_MAX {
        return Err(Deny::new(
            "timeout",
            format!("timeout_secs 越界: {timeout}（允许 {TIMEOUT_SECS_MIN}–{TIMEOUT_SECS_MAX}）"),
        ));
    }
    let max_chars = envelope.max_chars;
    if max_chars < MAX_CHARS_MIN as i64 || max_chars > MAX_CHARS_MAX as i64 {
        return Err(Deny::new(
            "size",
            format!("max_chars 越界: {max_chars}（允许 {MAX_CHARS_MIN}–{MAX_CHARS_MAX}）"),
        ));
    }
    if envelope.roots.len() > 32 {
        return Err(Deny::new("size", "roots 数量超限（≤32）"));
    }
    if envelope.allowlist.len() > 64 || envelope.allow_domains.len() > 64 {
        return Err(Deny::new("size", "allowlist/allow_domains 数量超限（≤64）"));
    }
    Ok(())
}

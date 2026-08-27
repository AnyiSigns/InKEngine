//! 工具安全纵深域：三档门禁 / 声明式沙箱代理 / 工作区授权 / 影子 vetting。
//!
//! 引擎零改动铁律下，工具安全纵深在宿主侧落地：
//!
//! - **三档权限分级判定**：tools.json 的 approval（allow/review/deny）→
//!   [`TieredGate`]——allow 直过 / review 弹卡审批 / deny 默认拒绝
//!   （deny 档无条件拒绝，与权限命中与否无关）；
//! - **声明式沙箱代理**：[`DeclarativeSandboxProxy`] 按调用时定义现取守卫——
//!   http_fetch 经 network_policy.allow_domains 域名白名单、process_exec 经
//!   命令白名单、file_ops 经工作区根目录 + 授权门；非声明式工具（内省/
//!   自指/MCP 挂载）不误伤（守卫只对声明式端点生效）；
//! - **文件工具沙箱**：[`WorkspaceGuard`] 工作区授权 → 根目录占位符替换 →
//!   越界路径/符号链接逃逸/大小上限全部拒绝（fail-closed）；
//! - **网络策略**：allow_domains 在端点执行时核对（沙箱层先行判定，
//!   执行体二次核对，越域拒绝）；
//! - **vetting L2 影子运行**：[`ShadowVettingStore`] 记录导入期工具清单
//!   （不真执行），TOOL 补丁（MCP 端点类）落链前比对，不一致拒绝挂载；
//! - **shell 执行器进工具表**：进程端点分发（执行器注册表插拔，stub
//!   注入免真实桌面）——OS 命令调度的唯一权威点在引擎宿主侧注册表
//!   （security_domain.py），壳侧经回调桥转发，不再维护平行影子表。
//!
//! 安全判定与域装配模块化：新工具/新端点 = 注册新守卫/执行器，不动机制
//! 代码。所有拒绝路径携带错误码（[`ErrorCode`]）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；与引擎的交互经
//! [`crate::engine::host::call_engine_op`] / `call_engine_op_async`
//! 操作通道与 [`crate::engine::bridge::register_callback`] 回调桥
//! （薄包装在 engine/py/bridge.py），装配编排发生在 [`super::boot`]。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use serde_json::Value as JsonValue;

use super::common::{
    resolve_non_strict, DomainError, WORKSPACE_ROOT_PLACEHOLDER, DEFAULT_MAX_READ_BYTES,
    DEFAULT_MAX_WRITE_BYTES,
};
use crate::engine::bridge::register_callback;
use crate::engine::host::{call_engine_op, call_engine_op_async};

// ── 结构化错误码（拒绝路径统一携带，防魔法字符串）──

/// 安全拒绝/降级路径的结构化错误码（日志与结果文本共用）。
///
/// 对偶文件：`engine/py/inkling_host/security_domain.py`（S12：Rust 侧为
/// 拒绝路径错误码的权威源，Python 侧经批 6e 收敛引用；值变更须双侧
/// 同步）。
pub struct ErrorCode;

impl ErrorCode {
    pub const PERMISSION_DENIED: &str = "SEC_001"; // deny 档/权限未命中，默认拒绝
    pub const SANDBOX_OUT_OF_ROOT: &str = "SEC_002"; // 文件路径越出工作区根
    pub const SANDBOX_SYMLINK_ESCAPE: &str = "SEC_003"; // 符号链接逃逸出工作区根
    pub const SANDBOX_SIZE_LIMIT: &str = "SEC_004"; // 读/写超过大小上限
    pub const SANDBOX_UNAUTHORIZED: &str = "SEC_005"; // 工作区未授权
    pub const NETWORK_DOMAIN_BLOCKED: &str = "SEC_006"; // 目标域名不在白名单
    pub const PROCESS_NOT_ALLOWLISTED: &str = "SEC_007"; // 命令不在端点白名单
    pub const VETTING_SHADOW_MISMATCH: &str = "SEC_008"; // 影子清单比对不一致
    pub const COMMAND_ENUM_MISMATCH: &str = "SEC_009"; // 固定枚举参数与工具名不符
    pub const NETWORK_REDIRECT_BLOCKED: &str = "SEC_010"; // http_fetch 拒绝跟随重定向
    pub const NETWORK_SIZE_LIMIT: &str = "SEC_011"; // http_fetch 响应体超过上限
}

/// 权限判定档位（权限命中 × 门控分级后的产出）。
pub const ALLOW: &str = "allow";
pub const REVIEW: &str = "review";
pub const DENY: &str = "deny";

// ── 沙箱违规（守卫拒绝的统一异常形态）──

/// 沙箱守卫拒绝（消息为产品可读的拒绝原因；结果文本与日志共用）。
#[derive(Debug, Clone)]
pub struct SandboxViolation(pub String);

impl std::fmt::Display for SandboxViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SandboxViolation {}

// ── 声明式权限规则（fnmatch 语义移植；与引擎判定的分域语义一致）──

/// 解析后的权限规则（`domain:action:pattern` 三段式，action 可省略为 *）。
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRule {
    pub domain: String,
    pub action: String,
    pub pattern: String,
}

/// 声明式权限串 → 规则（缺省 action 为 *）。
///
/// 形态：`domain:action:pattern` 或 `domain:pattern`；未知域不拒绝
/// （宿主自定义域经同一 fnmatch 匹配），误写由匹配自然失效。
pub fn parse_permission(spec: &str) -> Result<PermissionRule, String> {
    let mut parts = spec.splitn(3, ':');
    let domain = parts.next().unwrap_or("").to_string();
    let second = parts.next().map(str::to_string);
    let third = parts.next().map(str::to_string);
    let rule = match (second, third) {
        (Some(second), None) => PermissionRule {
            domain,
            action: "*".to_string(),
            pattern: second,
        },
        (Some(second), Some(pattern)) => PermissionRule {
            domain,
            action: second,
            pattern,
        },
        (None, _) => {
            return Err(format!(
                "权限声明须为 domain[:action]:pattern 形态: {spec:?}"
            ));
        }
    };
    if rule.domain.is_empty() || rule.pattern.is_empty() {
        return Err(format!("权限声明的 domain/pattern 不能为空: {spec:?}"));
    }
    Ok(rule)
}

/// 通配匹配（CPython fnmatch.translate 的移植：`*` 跨任意字符、
/// `?` 单字符、`[seq]` 字符类、`[!seq]` 取反；文本按整串匹配）。
pub fn fn_match(pattern: &str, text: &str) -> bool {
    let translated = translate_pattern(pattern);
    let anchored = format!("^(?:{translated})\\z");
    regex::Regex::new(&anchored)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

/// fnmatch.translate 移植：模式 → 正则正文（start-anchor/end-anchor 由调用方包裹）。
fn translate_pattern(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut res = String::new();
    while i < n {
        let c = chars[i];
        i += 1;
        match c {
            '*' => res.push_str(".*"),
            '?' => res.push('.'),
            '[' => {
                let mut j = i;
                if j < n && chars[j] == '!' {
                    j += 1;
                }
                if j < n && chars[j] == ']' {
                    j += 1;
                }
                while j < n && chars[j] != ']' {
                    j += 1;
                }
                if j >= n {
                    res.push_str("\\[");
                } else {
                    let mut stuff: String = chars[i..j].iter().collect();
                    if stuff.starts_with('!') {
                        stuff = format!("^{}", &stuff[1..]);
                    } else if stuff.starts_with('^') {
                        stuff = format!("\\{stuff}");
                    }
                    res.push('[');
                    res.push_str(&stuff);
                    res.push(']');
                    i = j + 1;
                }
            }
            other => res.push_str(&regex::escape(&other.to_string())),
        }
    }
    res
}

/// 网络域匹配：`*.example.com` 匹配主域及其任意子域；其余走通配匹配。
pub fn network_matches(pattern: &str, host: &str) -> bool {
    if let Some(bare) = pattern.strip_prefix("*.") {
        return host == bare || host.ends_with(&format!(".{bare}"));
    }
    fn_match(pattern, host)
}

/// 规则 × 单次判定的匹配（分域语义；network 为域名后缀匹配，其余通配）。
pub fn rule_matches(rule: &PermissionRule, operation: &str, target: &str) -> bool {
    if !fn_match(&rule.action, operation) {
        return false;
    }
    if rule.domain == "network" {
        return network_matches(&rule.pattern, target);
    }
    if rule.domain == "filesystem" {
        // 路径统一转正斜杠后通配；含 `..` 段的路径一律拒绝——通配的
        // `*`/`**` 跨路径分隔符匹配，`/book/**` 可放行 `../../etc/passwd`，
        // 权限层必须先守住路径边界（越界归一到沙箱/调用方再判等于放行穿越）。
        let target_norm = target.replace('\\', "/");
        let pattern_norm = rule.pattern.replace('\\', "/");
        if target_norm.split('/').any(|seg| seg == "..") {
            return false;
        }
        return pattern_any(&pattern_norm, &target_norm);
    }
    // 已知域与宿主自定义域：同样走通配（机制不给自定义域额外语义）
    pattern_any(&rule.pattern, target)
}

fn pattern_any(pattern: &str, target: &str) -> bool {
    if pattern.contains('|') {
        pattern.split('|').any(|part| fn_match(part, target))
    } else {
        fn_match(pattern, target)
    }
}

// ── 三档权限分级门禁 ──

/// 单次判定的结果（宿主按 decision 执行/审批/拒绝）。
#[derive(Debug, Clone)]
pub struct GateResult {
    pub decision: String,
    pub tool: String,
    pub operation: String,
    pub target: String,
    pub reason: String,
}

impl GateResult {
    fn new(decision: &str, tool: &str, operation: &str, target: &str, reason: impl Into<String>) -> Self {
        Self {
            decision: decision.to_string(),
            tool: tool.to_string(),
            operation: operation.to_string(),
            target: target.to_string(),
            reason: reason.into(),
        }
    }

    pub fn is_allow(&self) -> bool {
        self.decision == ALLOW
    }
}

/// 门控分级（写操作确认策略：L1 直落库 / L2 弹卡 / L3 破坏类预留）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatingTier {
    L1,
    L2,
    L3,
}

impl GatingTier {
    pub fn from_value(value: &str) -> Option<Self> {
        match value {
            "l1" => Some(Self::L1),
            "l2" => Some(Self::L2),
            "l3" => Some(Self::L3),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::L1 => "l1",
            Self::L2 => "l2",
            Self::L3 => "l3",
        }
    }
}

/// 解析单工具的生效门控挡位（pure 判定，可单测）。
///
/// 优先级：用户覆盖（overrides，白名单校验）> 注册表 L1/L3 > L2 默认
/// （未登记写操作默认保守弹卡——新增写工具不弹卡即门控绕过）。
pub fn gating_tier_of(
    tool: &str,
    overrides: &HashMap<String, String>,
    registry: &HashMap<String, String>,
) -> GatingTier {
    if let Some(override_value) = overrides.get(tool) {
        if let Some(tier) = GatingTier::from_value(override_value) {
            return tier;
        }
    }
    if let Some(tier) = registry.get(tool) {
        if let Some(parsed) = GatingTier::from_value(tier) {
            return parsed;
        }
    }
    GatingTier::L2
}

/// tools.json approval 三档 → 引擎门禁的宿主接线形态。
///
/// 判定链：deny 档无条件拒绝 → 权限命中判定（按定义声明权限，调用方
/// spec 权限不参与——防伪造宽松权限窗口）→ 命中且 review 档 = 弹卡
/// 审批 / allow 档 = 直过 / 未命中 = 默认拒绝（fail-closed）。未在档位
/// 表的工具（挂载/补丁新增）= 按声明权限直过（档位表是出厂契约）。
#[derive(Debug, Clone)]
pub struct TieredGate {
    tiers: HashMap<String, String>,
    overrides: HashMap<String, String>,
    gating_registry: HashMap<String, String>,
    default_policy: String,
}

impl TieredGate {
    /// 出厂档位表 + 宿主覆盖 + 默认策略装配门禁。
    pub fn new(
        tiers: HashMap<String, String>,
        default_policy: &str,
        overrides: HashMap<String, String>,
    ) -> Self {
        // allow 档 = L1（直落库，事后留痕）/ review 档 = L2（弹卡审批）
        let mut gating_registry = HashMap::new();
        for (tool, tier) in &tiers {
            let gating = if tier == REVIEW {
                GatingTier::L2.as_str()
            } else if tier == ALLOW {
                GatingTier::L1.as_str()
            } else {
                continue; // deny 档不登记（无条件拒绝，无门控分级）
            };
            gating_registry.insert(tool.clone(), gating.to_string());
        }
        Self {
            tiers,
            overrides,
            gating_registry,
            default_policy: default_policy.to_string(),
        }
    }

    /// 弹卡判定：未登记工具（不在档位表亦无覆盖）= 保持出厂直过语义。
    pub fn review_needed(&self, tool: &str) -> bool {
        if !self.tiers.contains_key(tool) && !self.overrides.contains_key(tool) {
            return false;
        }
        gating_tier_of(tool, &self.overrides, &self.gating_registry) == GatingTier::L2
    }

    /// 判定一次工具调用：权限声明命中 × 门控分级 → allow / review / deny。
    ///
    /// `definitions` 为声明式定义登记表（可选）：按下工具时现取，
    /// 库内定义的权限才是判定的权威来源（调用方传参不参与）。
    pub fn check(
        &self,
        tool: &str,
        operation: &str,
        target: &str,
        permissions: &[String],
        definitions: Option<&HashMap<String, DeclarativeSpec>>,
    ) -> GateResult {
        if self.tiers.get(tool).map(|t| t == DENY).unwrap_or(false) {
            return GateResult::new(
                DENY,
                tool,
                operation,
                target,
                format!(
                    "出厂 deny 档工具默认拒绝（权限变更须经补丁链审批转正）（{}）",
                    ErrorCode::PERMISSION_DENIED
                ),
            );
        }
        let mut effective: Vec<String> = permissions.to_vec();
        if let Some(defs) = definitions {
            if let Some(definition) = defs.get(tool) {
                effective = definition.permissions.clone();
                // 文件工具根目录占位符未解析（工作区未授权）：权限模式
                // 无法命中，给出明确拒绝原因（fail-closed + 可操作指引）
                if definition.endpoint == Endpoint::FileOps {
                    let root = definition
                        .endpoint_config
                        .get("root")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if root.contains(WORKSPACE_ROOT_PLACEHOLDER) {
                        return GateResult::new(
                            DENY,
                            tool,
                            operation,
                            target,
                            format!(
                                "工作区未授权（请先在设置页「连接」完成工作区授权确认）（{}）",
                                ErrorCode::SANDBOX_UNAUTHORIZED
                            ),
                        );
                    }
                }
            }
        }
        let hit = effective.iter().any(|spec| {
            parse_permission(spec)
                .map(|rule| rule_matches(&rule, operation, target))
                .unwrap_or(false)
        });
        if !hit {
            return match self.default_policy.as_str() {
                ALLOW => GateResult::new(
                    ALLOW,
                    tool,
                    operation,
                    target,
                    "未声明权限（宿主放宽为放行）",
                ),
                REVIEW => GateResult::new(
                    REVIEW,
                    tool,
                    operation,
                    target,
                    "未声明权限（宿主放宽为审批）",
                ),
                _ => {
                    let reason = if effective.is_empty() {
                        format!(
                            "未声明权限或权限未命中，默认拒绝（{}）",
                            ErrorCode::PERMISSION_DENIED
                        )
                    } else {
                        format!(
                            "权限未命中: {target:?}（{}）",
                            ErrorCode::PERMISSION_DENIED
                        )
                    };
                    GateResult::new(DENY, tool, operation, target, reason)
                }
            };
        }
        if self.review_needed(tool) {
            return GateResult::new(REVIEW, tool, operation, target, "门控分级需审批");
        }
        GateResult::new(ALLOW, tool, operation, target, "")
    }
}

// ── 声明式工具定义（数据形态：tools.json 条目）──

/// 声明式工具端点类型（分发/守卫接线的依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    HttpFetch,
    ProcessExec,
    FileOps,
    Mcp,
    WebSearch,
}

impl Endpoint {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "http_fetch" => Ok(Self::HttpFetch),
            "process_exec" => Ok(Self::ProcessExec),
            "file_ops" => Ok(Self::FileOps),
            "mcp" => Ok(Self::Mcp),
            "web_search" => Ok(Self::WebSearch),
            other => Err(DomainError::InvalidData(format!("工具端点类型非法: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::HttpFetch => "http_fetch",
            Self::ProcessExec => "process_exec",
            Self::FileOps => "file_ops",
            Self::Mcp => "mcp",
            Self::WebSearch => "web_search",
        }
    }
}

/// 声明式工具定义（数据形态，随工具表持久化；守卫语义 = 定义即权威）。
#[derive(Debug, Clone, PartialEq)]
pub struct DeclarativeSpec {
    pub name: String,
    pub description: String,
    pub parameters: JsonValue,
    pub permissions: Vec<String>,
    pub endpoint: Endpoint,
    pub endpoint_config: HashMap<String, JsonValue>,
    pub meta: HashMap<String, JsonValue>,
}

impl DeclarativeSpec {
    /// 从 tools.json 条目反序列化（顶层 network_policy 折叠进 meta——
    /// 装配路径存在顶层/折叠两种承载形态，守卫统一按 meta 取，防漂移）。
    pub fn from_dict(data: &JsonValue) -> Result<Self, DomainError> {
        let obj = data
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("工具声明须为对象".to_string()))?;
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DomainError::InvalidData("工具声明缺 name".to_string()))?;
        let endpoint_raw = obj
            .get("endpoint")
            .and_then(|v| v.as_str())
            .unwrap_or("http_fetch");
        let endpoint = Endpoint::parse(endpoint_raw)?;
        let mut meta: HashMap<String, JsonValue> = obj
            .get("meta")
            .filter(|v| v.is_object())
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        if !meta.contains_key("network_policy") {
            if let Some(policy) = obj.get("network_policy") {
                if policy.is_object() {
                    meta.insert("network_policy".to_string(), policy.clone());
                }
            }
        }
        Ok(Self {
            name: name.to_string(),
            description: obj
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            parameters: obj
                .get("parameters")
                .cloned()
                .unwrap_or(JsonValue::Object(Default::default())),
            permissions: string_list(obj.get("permissions")),
            endpoint,
            endpoint_config: string_value_map(obj.get("endpoint_config")),
            meta,
        })
    }

    /// 序列化为工具声明数据（注册/持久化共用形态）。
    pub fn to_dict(&self) -> JsonValue {
        let mut obj = serde_json::Map::new();
        obj.insert("name".to_string(), JsonValue::String(self.name.clone()));
        obj.insert(
            "description".to_string(),
            JsonValue::String(self.description.clone()),
        );
        obj.insert("parameters".to_string(), self.parameters.clone());
        obj.insert(
            "permissions".to_string(),
            JsonValue::Array(self.permissions.iter().map(|p| JsonValue::String(p.clone())).collect()),
        );
        obj.insert("endpoint".to_string(), JsonValue::String(self.endpoint.as_str().to_string()));
        obj.insert(
            "endpoint_config".to_string(),
            JsonValue::Object(self.endpoint_config.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        );
        obj.insert(
            "meta".to_string(),
            JsonValue::Object(self.meta.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        );
        if let Some(policy) = self.meta.get("network_policy") {
            obj.insert("network_policy".to_string(), policy.clone());
        }
        JsonValue::Object(obj)
    }

    /// 工具声明的大小上限（meta.sandbox_limits 数据驱动；缺项/非法回落缺省值）。
    pub fn size_limit(&self, key: &str, default: u64) -> u64 {
        size_limit(&self.meta, key, default)
    }

    /// 网络域白名单（折叠后的 meta.network_policy.allow_domains）。
    pub fn allow_domains(&self) -> Vec<String> {
        self.meta
            .get("network_policy")
            .and_then(|v| v.get("allow_domains"))
            .map(string_list_from)
            .unwrap_or_default()
    }
}

/// 工具声明的大小上限（sandbox_limits 数据驱动；缺项回落缺省值）。
pub fn size_limit(meta: &HashMap<String, JsonValue>, key: &str, default: u64) -> u64 {
    meta.get("sandbox_limits")
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_f64())
        .filter(|value| *value > 0.0)
        .map(|value| value as u64)
        .unwrap_or(default)
}

/// 权限模式占位符替换（路径统一正斜杠，与 rule_matches 归一一致）。
pub fn substitute_root(pattern: &str, root: &str) -> String {
    pattern.replace(WORKSPACE_ROOT_PLACEHOLDER, &root.replace('\\', "/"))
}

fn string_list(value: Option<&JsonValue>) -> Vec<String> {
    value.map(string_list_from).unwrap_or_default()
}

fn string_list_from(value: &JsonValue) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn string_value_map(value: Option<&JsonValue>) -> HashMap<String, JsonValue> {
    value
        .filter(|v| v.is_object())
        .and_then(|v| v.as_object())
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

// ── 工作区授权门与文件沙箱守卫 ──

#[derive(Default)]
struct WorkspaceState {
    root: Option<PathBuf>,
    authorized: bool,
}

/// 工作区授权门（文件工具沙箱的根目录权威来源）。
///
/// 未授权 = 占位符未解析 = 任何文件操作拒绝（fail-closed）；授权后
/// 根目录解析（越界/符号链接逃逸拒绝），大小上限按调用时声明在守卫
/// 期核对。授权态经 Arc 共享（域装配与沙箱代理同持一份，授权即生效）。
#[derive(Clone, Default)]
pub struct WorkspaceGuard {
    state: Arc<RwLock<WorkspaceState>>,
}

impl WorkspaceGuard {
    pub fn authorized(&self) -> bool {
        self.state.read().unwrap().authorized
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.state.read().unwrap().root.clone()
    }

    /// 授权根目录（幂等：重复授权同根 = 保持；换根 = 覆盖）。
    pub fn authorize(&self, root: &Path) {
        let mut state = self.state.write().unwrap();
        state.root = Some(resolve_non_strict(root));
        state.authorized = true;
    }

    /// 撤销授权（文件工具回到未授权拒绝态）。
    pub fn revoke(&self) {
        let mut state = self.state.write().unwrap();
        state.root = None;
        state.authorized = false;
    }

    /// 文件操作守卫：授权门 + 根目录边界 + 符号链接逃逸 + 大小上限。
    ///
    /// 返回解析后的绝对路径（执行参数回写，执行对象 = 校验对象）。
    pub fn validate_file(
        &self,
        operation: &str,
        target: &str,
        max_bytes: Option<u64>,
    ) -> Result<String, SandboxViolation> {
        let state = self.state.read().unwrap();
        if !state.authorized {
            return Err(SandboxViolation(format!(
                "工作区未授权（请先在设置页「连接」完成工作区授权确认）（{}）",
                ErrorCode::SANDBOX_UNAUTHORIZED
            )));
        }
        let root = state.root.clone().unwrap_or_default();
        let requested = Path::new(target);
        let candidate = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            root.join(requested)
        };
        // 解析（跟随符号链接；不存在的路径按词法解析，父目录已存在的部分
        // 仍会跟随链接）→ 前缀校验：链接指向根外的目标经解析越界即拒绝。
        // 返回解析后的 canonical 路径供 IO 使用（执行对象 = 校验对象）。
        let resolved = resolve_non_strict(&candidate);
        if !resolved.starts_with(&root) {
            // 错误码分层：词法即在根外 = 越界（SEC_002）；词法在根内但解析
            // 越界 = 符号链接逃逸（SEC_003）——审计可按码聚合归因。
            let code = if candidate.starts_with(&root) {
                ErrorCode::SANDBOX_SYMLINK_ESCAPE
            } else {
                ErrorCode::SANDBOX_OUT_OF_ROOT
            };
            return Err(SandboxViolation(format!("路径越界: {target}（{code}）")));
        }
        if operation == "read" {
            if let Some(limit) = max_bytes {
                let size = std::fs::metadata(&resolved)
                    .map(|meta| meta.len())
                    .unwrap_or(0);
                if size > limit {
                    return Err(SandboxViolation(format!(
                        "文件大小超限: {size} > {limit} 字节（{}）",
                        ErrorCode::SANDBOX_SIZE_LIMIT
                    )));
                }
            }
        }
        Ok(resolved.to_string_lossy().into_owned())
    }
}

// ── 声明式沙箱代理（按调用时定义现取守卫）──

/// 声明式工具沙箱守卫（网络/进程/文件三类端点按定义现取守卫）。
///
/// 守卫域覆盖 exec / 文件操作 / connect；但只在调用工具确为声明式
/// 定义时才判定——内省/自指/MCP 挂载工具无本地沙箱语义（会话/装配
/// 边界），不误伤。
pub struct DeclarativeSandboxProxy {
    workspace: WorkspaceGuard,
}

impl DeclarativeSandboxProxy {
    pub fn new(workspace: WorkspaceGuard) -> Self {
        Self { workspace }
    }

    pub fn guards_operation(&self, operation: &str) -> bool {
        operation == "exec"
            || matches!(operation, "read" | "write" | "delete" | "edit" | "search" | "search_paths")
            || operation == "connect"
    }

    /// 按调用工具反查定义并执行对应端点守卫；返回回写参数（解析后目标）。
    pub fn validate(
        &self,
        operation: &str,
        target: &str,
        tool: &str,
        definitions: &HashMap<String, DeclarativeSpec>,
    ) -> Result<String, SandboxViolation> {
        let Some(definition) = definitions.get(tool) else {
            return Ok(target.to_string()); // 非声明式工具无本地沙箱语义
        };
        match definition.endpoint {
            Endpoint::ProcessExec if operation == "exec" => {
                // 端点级守卫 = 命令白名单成员判定（执行体是宿主分发而非
                // 子进程 spawn，PATH 语义归实际执行通道注入）
                let allowlist: Vec<String> = definition
                    .endpoint_config
                    .get("allowlist")
                    .map(string_list_from)
                    .unwrap_or_default();
                if !allowlist.iter().any(|allowed| allowed == target) {
                    return Err(SandboxViolation(format!(
                        "命令不在端点白名单: {target:?}（{}）",
                        ErrorCode::PROCESS_NOT_ALLOWLISTED
                    )));
                }
                Ok(target.to_string())
            }
            Endpoint::FileOps if matches!(operation, "read" | "write" | "delete" | "edit" | "search" | "search_paths") => {
                // 检索操作只读不取整文件：仅解析边界，不做单文件大小上限
                let max_bytes = match operation {
                    "read" => Some(
                        definition.size_limit("max_read_bytes", DEFAULT_MAX_READ_BYTES)
                    ),
                    "write" | "edit" => Some(
                        definition.size_limit("max_write_bytes", DEFAULT_MAX_WRITE_BYTES)
                    ),
                    _ => None,
                };
                self.workspace
                    .validate_file(operation, target, max_bytes)
            }
            Endpoint::HttpFetch if operation == "connect" => {
                let domains = definition.allow_domains();
                if !domains.iter().any(|pattern| network_matches(pattern, target)) {
                    return Err(SandboxViolation(format!(
                        "域名不在白名单: {target}（{}）",
                        ErrorCode::NETWORK_DOMAIN_BLOCKED
                    )));
                }
                Ok(target.to_string())
            }
            // mcp 端点：会话级边界（挂载 vetting + 审批链），无本地沙箱判定
            _ => Ok(target.to_string()),
        }
    }
}

// ── http_fetch 端点执行体 ──

/// 取回实现注入形态（定义 + 调用参数 → 取回文本；可注入 stub 免真实出网）。
pub type FetchFn = Box<dyn Fn(&DeclarativeSpec, &JsonValue) -> Result<String, String> + Send + Sync>;

/// http_fetch 端点执行体（网络策略二次核对 + 可选取回实现）。
///
/// 执行体不自行决定出网：域名白名单在沙箱层先行判定，执行体按定义
/// 声明（meta.network_policy）再次核对（纵深防御），越域 = 结构化
/// 失败（NETWORK_DOMAIN_BLOCKED）。取回实现可注入（端到端用 stub
/// 免真实出网；缺省 = reqwest 受控取回）。返回 JSON 结果文本。
pub async fn execute_http_fetch(
    definition: &DeclarativeSpec,
    args: &JsonValue,
    fetch: Option<&FetchFn>,
    max_chars: usize,
) -> String {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let host = url_host(url);
    let domains = definition.allow_domains();
    let allowed = host
        .as_deref()
        .map(|host| domains.iter().any(|pattern| network_matches(pattern, host)))
        .unwrap_or(false);
    if !allowed {
        return serde_json::json!({
            "ok": false,
            "status": "network_domain_blocked",
            "error": format!("域名不在网络策略白名单: {host:?}（越域拒绝）（{}）", ErrorCode::NETWORK_DOMAIN_BLOCKED),
        })
        .to_string();
    }
    if let Some(fetch) = fetch {
        let text = fetch(definition, args).unwrap_or_else(|err| format!("取回失败: {err}"));
        return truncate_chars(&text, max_chars);
    }
    fetch_with_reqwest(url, max_chars).await
}

/// URL 主机提取（仅 http/https 可出网；凭据/非标准协议的 host 一律拒绝）。
fn url_host(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    parsed.host_str().map(|h| h.to_string())
}

/// 响应体字节读取上限（max_chars × UTF-8 最大字节/字符 + 换行/状态行余量；
/// 超上限即结构化 size_limit，防超大响应占满内存）。
fn fetch_byte_cap(max_chars: usize) -> usize {
    max_chars * 4 + 4096
}

async fn fetch_with_reqwest(url: &str, max_chars: usize) -> String {
    let client_req = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        // 禁跟随重定向：白名单只校验初始 host，30x 跳任意域即越域
        // （与 Python security_domain.py 的 follow_redirects=False 同口径）
        .redirect(reqwest::redirect::Policy::none())
        .build();
    let client = match client_req {
        Ok(client) => client,
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "status": "fetch_failed",
                "error": "http_fetch 客户端构造失败（网络栈不可用）",
            })
            .to_string();
        }
    };
    let mut response = match client.get(url).send().await {
        Ok(response) => response,
        Err(_) => {
            return serde_json::json!({
                "ok": false,
                "status": "fetch_failed",
                "error": "http_fetch 取回失败（网络不可达或域名解析失败）",
            })
            .to_string();
        }
    };
    let status = response.status();
    // 重定向按拒绝处理（Policy::none 下 30x 原样返回）：逐跳校验的等价
    // fail-closed——不跟随即不存在跳转后的白名单复核面
    if status.is_redirection() {
        return serde_json::json!({
            "ok": false,
            "status": "redirect_blocked",
            "error": format!("http_fetch 拒绝跟随重定向: HTTP {status}（{}）", ErrorCode::NETWORK_REDIRECT_BLOCKED),
        })
        .to_string();
    }
    // 响应体上限：Content-Length 预检 + 流式限长读取（不整块读入）
    let byte_cap = fetch_byte_cap(max_chars);
    if let Some(len) = response.content_length() {
        if len > byte_cap as u64 {
            return serde_json::json!({
                "ok": false,
                "status": "size_limit",
                "error": format!("http_fetch 响应超上限: {len} > {byte_cap} 字节（{}）", ErrorCode::NETWORK_SIZE_LIMIT),
            })
            .to_string();
        }
    }
    let mut body: Vec<u8> = Vec::new();
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                return serde_json::json!({
                    "ok": false,
                    "status": "fetch_failed",
                    "error": "http_fetch 响应体读取中断",
                })
                .to_string();
            }
        };
        if body.len() + chunk.len() > byte_cap {
            return serde_json::json!({
                "ok": false,
                "status": "size_limit",
                "error": format!("http_fetch 响应超上限（流式截断）（{}）", ErrorCode::NETWORK_SIZE_LIMIT),
            })
            .to_string();
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body);
    format!("HTTP {status}\n{}", truncate_chars(&text, max_chars))
}

// ── file_ops 端点执行体 ──

/// 文件工具大小上限（声明 sandbox_limits 数据驱动的执行期形态）。
#[derive(Debug, Clone, Copy, Default)]
pub struct SizeLimits {
    pub max_read: u64,
    pub max_write: u64,
}

impl SizeLimits {
    pub fn from_definition(definition: &DeclarativeSpec) -> Self {
        Self {
            max_read: definition.size_limit("max_read_bytes", DEFAULT_MAX_READ_BYTES),
            max_write: definition.size_limit("max_write_bytes", DEFAULT_MAX_WRITE_BYTES),
        }
    }
}

/// file_ops 端点执行体（工作区读/写/编辑，写前快照可回退）。
///
/// 执行体不做路径边界判定（沙箱层已先行解析，执行参数 = 校验后的
/// 绝对路径）；本层核对大小上限（声明 sandbox_limits，纵深防御）并
/// 实现写前快照（写/编辑前记录原内容，可回退）。未注册工作区/文件
/// 缺失 = 结构化失败文本（不崩溃）。返回 JSON 结果文本。
#[derive(Default)]
pub struct FileOpsExecutor {
    snapshots: HashMap<PathBuf, Vec<u8>>,
}

impl FileOpsExecutor {
    /// 回退一次写操作（快照存在 = 还原原内容；缺失 = False）。
    pub fn rollback(&mut self, path: &Path) -> bool {
        let Some(snapshot) = self.snapshots.remove(&path.to_path_buf()) else {
            return false;
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(path, snapshot).is_ok()
    }

    /// 执行一次文件操作（参数形态：operation/path/content/old_text/new_text；
    /// 检索操作另读 pattern/glob/include/max_results/root）。
    pub fn call(&mut self, args: &JsonValue, limits: &SizeLimits) -> String {
        let operation = args.get("operation").and_then(|v| v.as_str()).unwrap_or("");
        let path_text = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        match operation {
            "read" => self.read(path_text, limits),
            "search" => self.search(args, limits),
            "search_paths" => self.search_paths(args),
            "edit" => {
                let old_text = args.get("old_text").and_then(|v| v.as_str()).unwrap_or("");
                let new_text = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
                self.edit(path_text, old_text, new_text, limits.max_write)
            }
            "write" => {
                if args.get("old_text").is_some() {
                    let old_text = args.get("old_text").and_then(|v| v.as_str()).unwrap_or("");
                    let new_text = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
                    self.edit(path_text, old_text, new_text, limits.max_write)
                } else {
                    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let bytes = content.len();
                    if bytes as u64 > limits.max_write {
                        return serde_json::json!({
                            "ok": false,
                            "status": "size_limit",
                            "error": format!("写入超限: {bytes} > {} 字节（{}）", limits.max_write, ErrorCode::SANDBOX_SIZE_LIMIT),
                        })
                        .to_string();
                    }
                    self.write(path_text, content)
                }
            }
            other => serde_json::json!({
                "ok": false,
                "status": "invalid_operation",
                "error": format!("不支持的文件操作: {other:?}"),
            })
            .to_string(),
        }
    }

    /// grep：工作区文本内容检索（正则 + 路径 glob 过滤 + 类型过滤 + 超限
    /// 截断；只读，结果 = 命中文件/行号/摘要）。检索根取参数 root
    /// （沙箱已先行解析，防御归一）。
    fn search(&self, args: &JsonValue, limits: &SizeLimits) -> String {
        let root = PathBuf::from(
            args.get("root").and_then(|v| v.as_str()).unwrap_or(""),
        );
        if !root.is_dir() {
            return serde_json::json!({
                "ok": false,
                "status": "no_root",
                "error": format!("检索根不可用: {}", root.display()),
            })
            .to_string();
        }
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        if pattern.is_empty() {
            return serde_json::json!({
                "ok": false,
                "status": "missing_pattern",
                "error": "检索正则不能为空",
            })
            .to_string();
        }
        let regex = match regex::Regex::new(pattern) {
            Ok(regex) => regex,
            Err(err) => {
                return serde_json::json!({
                    "ok": false,
                    "status": "invalid_pattern",
                    "error": format!("检索正则非法: {err}"),
                })
                .to_string();
            }
        };
        let glob_pattern = args.get("glob").and_then(|v| v.as_str()).unwrap_or("");
        let include = args.get("include").and_then(|v| v.as_str()).unwrap_or("");
        let max_results = args
            .get("max_results")
            .and_then(JsonValue::as_u64)
            .map(|n| n as usize)
            .unwrap_or(100)
            .clamp(1, 1000);
        let mut matches: Vec<JsonValue> = Vec::new();
        let mut truncated = false;
        let mut stack: Vec<PathBuf> = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            if truncated {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut names: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            names.sort();
            let mut subdirs: Vec<PathBuf> = Vec::new();
            for path in names {
                if path.is_dir() {
                    subdirs.push(path);
                    continue;
                }
                if matches.len() >= max_results {
                    truncated = true;
                    break;
                }
                let rel = path
                    .strip_prefix(&root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if !glob_pattern.is_empty() && !fn_match(glob_pattern, &rel) {
                    continue;
                }
                if !include.is_empty() && !include_matches(include, &path) {
                    continue;
                }
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                if meta.len() > limits.max_read {
                    continue; // 超限文件跳过（检索域受大小上限约束）
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Some(hit) = regex.find(&text) else {
                    continue;
                };
                let line = text[..hit.start()].matches('\n').count() + 1;
                let line_start = text[..hit.start()].rfind('\n').map(|i| i + 1).unwrap_or(0);
                let line_end = text[hit.start()..]
                    .find('\n')
                    .map(|i| hit.start() + i)
                    .unwrap_or(text.len());
                let snippet: String = text[line_start..line_end]
                    .trim()
                    .chars()
                    .take(200)
                    .collect();
                matches.push(serde_json::json!({
                    "path": rel,
                    "line": line,
                    "snippet": snippet,
                }));
            }
            stack.extend(subdirs);
        }
        if matches.len() >= max_results {
            truncated = true;
        }
        serde_json::json!({
            "ok": true,
            "matches": matches,
            "truncated": truncated,
            "total": matches.len(),
        })
        .to_string()
    }

    /// glob：工作区路径检索（递归匹配；pattern 相对检索起点匹配，支持
    /// ``**`` 跨目录；只列路径不读内容）。
    fn search_paths(&self, args: &JsonValue) -> String {
        let root = PathBuf::from(
            args.get("root").and_then(|v| v.as_str()).unwrap_or(""),
        );
        if !root.is_dir() {
            return serde_json::json!({
                "ok": false,
                "status": "no_root",
                "error": format!("检索根不可用: {}", root.display()),
            })
            .to_string();
        }
        let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
        if pattern.is_empty() {
            return serde_json::json!({
                "ok": false,
                "status": "missing_pattern",
                "error": "路径模式不能为空",
            })
            .to_string();
        }
        let base = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .map(|p| if p.is_absolute() { p } else { root.join(p) })
            .unwrap_or_else(|| root.clone());
        if !base.starts_with(&root) {
            return serde_json::json!({
                "ok": false,
                "status": "out_of_root",
                "error": format!("检索起点越界: {}", base.display()),
            })
            .to_string();
        }
        let max_results = args
            .get("max_results")
            .and_then(JsonValue::as_u64)
            .map(|n| n as usize)
            .unwrap_or(100)
            .clamp(1, 1000);
        let pattern_norm = pattern.replace('\\', "/");
        let mut paths: Vec<String> = Vec::new();
        let mut truncated = false;
        let mut stack: Vec<PathBuf> = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            if truncated {
                break;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut names: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            names.sort();
            for path in names {
                if paths.len() >= max_results {
                    truncated = true;
                    break;
                }
                let rel = path
                    .strip_prefix(&base)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_default();
                if !rel.is_empty() && glob_match(&pattern_norm, &rel) {
                    paths.push(path.to_string_lossy().into_owned());
                }
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
        if paths.len() >= max_results {
            truncated = true;
        }
        serde_json::json!({
            "ok": true,
            "paths": paths,
            "truncated": truncated,
            "total": paths.len(),
        })
        .to_string()
    }

    fn read(&self, path_text: &str, limits: &SizeLimits) -> String {
        let path = Path::new(path_text);
        let metadata = match std::fs::metadata(path) {
            Ok(meta) => meta,
            Err(_) => {
                return serde_json::json!({
                    "ok": false,
                    "status": "not_found",
                    "error": format!("文件不存在或不可读: {path_text}"),
                })
                .to_string();
            }
        };
        if metadata.is_dir() {
            return serde_json::json!({
                "ok": false,
                "status": "is_directory",
                "error": format!("目标是目录: {path_text}"),
            })
            .to_string();
        }
        let size = metadata.len();
        if size > limits.max_read {
            return serde_json::json!({
                "ok": false,
                "status": "size_limit",
                "error": format!("文件超限: {size} > {} 字节（{}）", limits.max_read, ErrorCode::SANDBOX_SIZE_LIMIT),
            })
            .to_string();
        }
        match std::fs::read_to_string(path) {
            Ok(content) => serde_json::json!({
                "ok": true,
                "path": path_text,
                "bytes": size,
                "content": content,
            })
            .to_string(),
            Err(err) => serde_json::json!({
                "ok": false,
                "status": "not_found",
                "error": format!("读取失败: {err}"),
            })
            .to_string(),
        }
    }

    fn write(&mut self, path_text: &str, content: &str) -> String {
        let path = PathBuf::from(path_text);
        if path.is_file() {
            if let Ok(original) = std::fs::read(&path) {
                self.snapshots.insert(path.clone(), original);
            }
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(&path, content) {
            Ok(()) => serde_json::json!({
                "ok": true,
                "path": path_text,
                "bytes": content.len(),
                "snapshot": self.snapshots.contains_key(&path),
            })
            .to_string(),
            Err(err) => serde_json::json!({
                "ok": false,
                "status": "not_found",
                "error": format!("写入失败: {err}"),
            })
            .to_string(),
        }
    }

    fn edit(&mut self, path_text: &str, old_text: &str, new_text: &str, max_write: u64) -> String {
        let path = PathBuf::from(path_text);
        let original = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => {
                return serde_json::json!({
                    "ok": false,
                    "status": "not_found",
                    "error": format!("读取失败: {err}"),
                })
                .to_string();
            }
        };
        if old_text.is_empty() || !original.contains(old_text) {
            return serde_json::json!({
                "ok": false,
                "status": "old_text_not_found",
                "error": "待替换原文不存在（编辑目标未命中）",
            })
            .to_string();
        }
        let updated = original.replacen(old_text, new_text, 1);
        let bytes = updated.len();
        if bytes as u64 > max_write {
            return serde_json::json!({
                "ok": false,
                "status": "size_limit",
                "error": format!("编辑结果超限: {bytes} > {max_write} 字节（{}）", ErrorCode::SANDBOX_SIZE_LIMIT),
            })
            .to_string();
        }
        self.snapshots.insert(path.clone(), original.into_bytes());
        if std::fs::write(&path, &updated).is_err() {
            return serde_json::json!({
                "ok": false,
                "status": "not_found",
                "error": format!("写入失败: {path_text}"),
            })
            .to_string();
        }
        serde_json::json!({
            "ok": true,
            "path": path_text,
            "bytes": bytes,
            "snapshot": true,
        })
        .to_string()
    }
}

// ── process_exec 分发前判定（command 固定枚举与 deny 档纵深防御）──

/// process_exec 分发前判定：命令枚举不符 / deny 档 = 结构化拒绝 JSON；
/// 通过 = 交执行器分发（本地守卫拒绝仅为纵深防御，门禁已先行拒绝）。
pub fn resolve_process_exec(
    name: &str,
    command: &str,
    tiers: &HashMap<String, String>,
) -> Result<(), JsonValue> {
    if command != name {
        return Err(serde_json::json!({
            "ok": false,
            "status": "command_enum_mismatch",
            "error": format!("command 固定枚举不符: {command:?}（期望 {name:?}）（{}）", ErrorCode::COMMAND_ENUM_MISMATCH),
        }));
    }
    if tiers.get(name).map(|t| t == DENY).unwrap_or(false) {
        return Err(serde_json::json!({
            "ok": false,
            "status": "deny_tier",
            "error": format!("出厂 deny 档工具默认拒绝（须经补丁链审批转正）（{}）", ErrorCode::PERMISSION_DENIED),
        }));
    }
    Ok(())
}

// ── 影子 vetting（挂载工具清单一致性核对，不真执行）──

/// 挂载影子记录（导入期工具清单；L2 钩子的比对依据）。
///
/// 影子 = 连接 server 后 tools/list 的清单快照（不执行任何工具调用）；
/// TOOL 补丁落链前把声明的工具名/参数必填项与影子清单比对，不一致 =
/// 挂载拒绝（防改头换面/声明与实现漂移）。
#[derive(Clone, Default)]
pub struct ShadowVettingStore {
    records: Arc<Mutex<HashMap<String, HashMap<String, JsonValue>>>>,
}

impl ShadowVettingStore {
    /// 记录一个 server 的影子清单（工具名 → 参数 schema）。
    pub fn record(&self, server_id: &str, specs: Vec<(String, JsonValue)>) {
        let mut record = HashMap::new();
        for (name, parameters) in specs {
            record.insert(name, serde_json::json!({ "parameters": parameters }));
        }
        self.records
            .lock()
            .unwrap()
            .insert(server_id.to_string(), record);
    }

    /// 影子清单中的工具名列表（挂载后工具表核对入口）。
    pub fn server_tools(&self, server_id: &str) -> Vec<String> {
        self.records
            .lock()
            .unwrap()
            .get(server_id)
            .map(|record| record.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 声明工具 vs 影子清单（输出比对）：违规清单，空 = 一致。
    ///
    /// `declared` 为声明补丁的 parameters schema（required 数组与影子
    /// properties 键比对——声明必填项须能在影子中证明存在）。
    pub fn check_tool(
        &self,
        server_id: &str,
        name: &str,
        declared: Option<&JsonValue>,
    ) -> Vec<String> {
        let guard = self.records.lock().unwrap();
        let Some(record) = guard.get(server_id) else {
            return vec!["server 无影子记录（导入期工具清单缺失，无法核对）".to_string()];
        };
        let Some(actual) = record.get(name) else {
            return vec![format!("工具 {name:?} 不在影子清单（server 实际未暴露该工具）")];
        };
        if let Some(declared) = declared {
            let declared_required: Vec<String> = declared
                .get("required")
                .map(string_list_from)
                .unwrap_or_default();
            if !declared_required.is_empty() {
                let actual_props: HashSet<String> = actual
                    .get("parameters")
                    .and_then(|v| v.get("properties"))
                    .map(|props| {
                        props
                            .as_object()
                            .map(|m| m.keys().cloned().collect())
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();
                let missing: Vec<&String> = declared_required
                    .iter()
                    .filter(|required| !actual_props.contains(*required))
                    .collect();
                if !missing.is_empty() {
                    let names = missing
                        .iter()
                        .map(|s| format!("{s:?}"))
                        .collect::<Vec<_>>()
                        .join(", ");
                    return vec![format!("参数必填项与影子清单不符: [{names}]")];
                }
            }
        }
        Vec::new()
    }
}

/// L2 验证钩子的内层判定器（非 MCP 工具补丁的追加门禁）。
pub type VettingInner = Box<dyn Fn(&JsonValue) -> Vec<String> + Send + Sync>;

/// L2 验证钩子（TOOL 补丁部署前门禁）+ 影子登记器。
///
/// 钩子语义（fail-closed）：MCP 端点工具补丁须满足——server 已通过
/// 挂载 vetting（登记放行）且声明与影子清单一致；未登记/不一致 =
/// 拒绝落链。非 MCP 工具补丁交给 inner（缺省放行，交由审批分级）。
/// 登记器由挂载服务在 vetting 通过后调用（vetting → 审批 → L2 的
/// 顺序在机制上被强制执行）。
pub struct SecurityL2Vetting {
    shadow: ShadowVettingStore,
    vetted: Arc<Mutex<HashSet<String>>>,
    inner: Option<VettingInner>,
}

impl SecurityL2Vetting {
    pub fn new(shadow: ShadowVettingStore, inner: Option<VettingInner>) -> Self {
        Self {
            shadow,
            vetted: Arc::new(Mutex::new(HashSet::new())),
            inner,
        }
    }

    /// vetting 通过后登记放行（登记影子清单：不执行任何工具调用）。
    pub fn mark_vetted(&self, server_id: &str, specs: Option<Vec<(String, JsonValue)>>) {
        self.vetted.lock().unwrap().insert(server_id.to_string());
        if let Some(specs) = specs {
            self.shadow.record(server_id, specs);
        }
    }

    pub fn is_vetted(&self, server_id: &str) -> bool {
        self.vetted.lock().unwrap().contains(server_id)
    }

    /// 部署前门禁判定（proposal 的 kind 与 payload 为判据；违规清单空 = 放行）。
    pub fn check(&self, proposal_kind: &str, payload: &JsonValue) -> Vec<String> {
        if proposal_kind != "tool" {
            return self.inner.as_ref().map(|f| f(payload)).unwrap_or_default();
        }
        if payload.get("endpoint").and_then(|v| v.as_str()) != Some("mcp") {
            return self.inner.as_ref().map(|f| f(payload)).unwrap_or_default();
        }
        let server_id = payload
            .get("endpoint_config")
            .and_then(|v| v.get("server_id"))
            .and_then(|v| v.as_str());
        match server_id {
            Some(id) if self.is_vetted(id) => {
                let violations = self.shadow.check_tool(
                    id,
                    payload
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    payload.get("parameters"),
                );
                if violations.is_empty() {
                    Vec::new()
                } else {
                    vec![format!("影子运行核对未通过: {}", violations.join("；"))]
                }
            }
            Some(id) => vec![format!("MCP 挂载未经 vetting 核对（server 未登记放行: {id:?}）")],
            None => vec!["MCP 工具补丁缺 server_id（无法核对挂载 vetting）".to_string()],
        }
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        let mut head = text.to_string();
        head.truncate(max);
        head
    }
}

/// 文件类型过滤匹配（include 语义：``.py`` 按后缀、``*.py``/``py`` 按
/// fnmatch 通配——与 Python 宿主执行体同口径）。
fn include_matches(include: &str, path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    if include.starts_with('.') {
        return name.ends_with(include);
    }
    let pattern = if include.starts_with('*') || include.contains('.') {
        include.to_string()
    } else {
        format!("*{include}")
    };
    fn_match(&pattern, &name)
}

/// glob 路径匹配（``**`` 跨目录分隔符；无 ``**`` 时与 fn_match 等价）。
///
/// ``**`` 段之间复用 fnmatch 通配翻译（``*``/``?``/``[seq]``）；
/// ``**/`` 前缀为可选段（``**/*.rs`` 同时匹配基址下的 ``main.rs`` 与
/// 任意深度的 ``sub/lib.rs``）。
fn glob_match(pattern: &str, text: &str) -> bool {
    if !pattern.contains("**") {
        return fn_match(pattern, text);
    }
    let mut regex = String::from("^(?:");
    let mut parts = pattern.split("**");
    if let Some(first) = parts.next() {
        regex.push_str(&translate_pattern(first));
    }
    for part in parts {
        if let Some(rest) = part.strip_prefix('/') {
            regex.push_str("(?:.*/)?");
            regex.push_str(&translate_pattern(rest));
        } else {
            regex.push_str(".*");
            regex.push_str(&translate_pattern(part));
        }
    }
    regex.push_str(")\\z");
    regex::Regex::new(&regex)
        .map(|re| re.is_match(text))
        .unwrap_or(false)
}

// ── 域装配门面 ──

/// 工具安全纵深装配（boot 期创建，挂到宿主对象供运行期取用）。
///
/// 持有：三档门禁 + 沙箱代理 + 工作区门 + 影子存储 + 文件工具定义数据源。
/// `load_definitions` 从引擎操作通道现取声明式定义登记表（boot 调用后，
/// 新挂载工具同样被代理现取守卫——懒解析接线）；`apply_to_runtime` 把
/// 安全流水线替换进 runtime（引擎装配点不动，只换宿主侧流水线实例——
/// 图配方每次建图实时取流水线持有者，替换后下一回合生效），装配点经
/// op 通道挂接。
pub struct SecurityDomain {
    pub tiers: HashMap<String, String>,
    pub workspace: WorkspaceGuard,
    pub shadow: ShadowVettingStore,
    file_tool_defs: Vec<DeclarativeSpec>,
}

impl SecurityDomain {
    /// 从 tools.json 装载数据（档位表 + 文件工具定义数据源）。
    pub fn from_tool_data(tool_data: &JsonValue) -> Result<Self, DomainError> {
        let tools = tool_data
            .get("tools")
            .and_then(|v| v.as_array())
            .ok_or_else(|| DomainError::InvalidData("tools.json 缺 tools 数组".to_string()))?;
        let mut tiers = HashMap::new();
        let mut file_tool_defs = Vec::new();
        for tool in tools {
            let name = tool
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or_else(|| DomainError::InvalidData("工具条目缺 name".to_string()))?;
            let approval = tool
                .get("approval")
                .and_then(|v| v.as_str())
                .unwrap_or(ALLOW)
                .to_string();
            tiers.insert(name.to_string(), approval);
            if tool.get("endpoint").and_then(|v| v.as_str()) == Some("file_ops") {
                file_tool_defs.push(DeclarativeSpec::from_dict(tool)?);
            }
        }
        Ok(Self {
            tiers,
            workspace: WorkspaceGuard::default(),
            shadow: ShadowVettingStore::default(),
            file_tool_defs,
        })
    }

    /// 文件工具定义列表（授权重注册的数据源）。
    pub fn file_tool_defs(&self) -> &[DeclarativeSpec] {
        &self.file_tool_defs
    }

    /// 从引擎操作通道现取声明式定义登记表（apply 时装配门禁/沙箱）。
    pub async fn load_definitions(&self) -> Result<HashMap<String, DeclarativeSpec>, String> {
        let specs = call_engine_op("engine.collect_specs", JsonValue::Object(Default::default()))?;
        parse_engine_specs(&specs)
    }

    /// 门禁装配形态（档位表 + 现取定义登记表 → 三档门禁；纯装配可测）。
    pub fn assemble_gate(
        &self,
        overrides: HashMap<String, String>,
    ) -> TieredGate {
        TieredGate::new(self.tiers.clone(), DENY, overrides)
    }

    /// 沙箱代理装配形态（与域共享同一工作区授权态）。
    pub fn assemble_sandbox(&self) -> DeclarativeSandboxProxy {
        DeclarativeSandboxProxy::new(self.workspace.clone())
    }

    /// 文件工具重注册（授权根替换占位符；撤销 = 回到占位符拒绝态）。
    ///
    /// 定义与工具表同步更新，权限模式随根目录替换
    /// （`${workspace_root}/**` → 实际根），未授权 = 占位符保留
    /// （沙箱守卫在调用时拒绝）。注册经引擎操作通道（薄包装：
    /// declarative_register_definition / tool_registry_put /
    /// introspection_refresh_tool_sources——均已具备）。
    pub async fn reregister_file_tools(&self, root: Option<&Path>) -> Result<(), String> {
        let specs = self.rebuilt_file_specs(root);
        for spec in &specs {
            let spec_json = spec.to_dict();
            call_engine_op(
                "engine.declarative_register_definition",
                serde_json::json!({ "spec": spec_json }),
            )?;
            call_engine_op("engine.tool_registry_put", serde_json::json!({ "spec": spec_json }))?;
        }
        call_engine_op(
            "engine.introspection_refresh_tool_sources",
            JsonValue::Object(Default::default()),
        )?;
        Ok(())
    }

    /// 文件工具重注册的数据形态（授权根替换占位符；纯数据变换可测）。
    pub fn rebuilt_file_specs(&self, root: Option<&Path>) -> Vec<DeclarativeSpec> {
        let resolved_root = match root {
            Some(root) => root.to_string_lossy().into_owned(),
            None => WORKSPACE_ROOT_PLACEHOLDER.to_string(),
        };
        self.file_tool_defs
            .iter()
            .map(|spec| {
                let mut rebuilt = spec.clone();
                rebuilt.permissions = spec
                    .permissions
                    .iter()
                    .map(|p| substitute_root(p, &resolved_root))
                    .collect();
                if spec.endpoint == Endpoint::FileOps {
                    if let Some(config) = rebuilt.endpoint_config.get_mut("root") {
                        *config = JsonValue::String(resolved_root.clone());
                    } else {
                        rebuilt
                            .endpoint_config
                            .insert("root".to_string(), JsonValue::String(resolved_root.clone()));
                    }
                }
                rebuilt
            })
            .collect()
    }

    /// 把安全流水线替换进运行时（gate + 沙箱代理；机制环节沿用引擎）。
    ///
    /// 回调先行：三个安全判定回调（sandbox_validate / guards_operation /
    /// gating_tier）必须先于流水线安装注册——引擎侧流水线安装点
    /// （pipeline.install_security_pipeline）直接消费这些回调做判定，
    /// 回调未注册 = 安装失败（fail-closed，不装半截流水线）。回调闭包
    /// 捕获本域的克隆数据（档位表/工作区态），'static 跨调用保持，
    /// 重复注册同名 = 覆盖（幂等，重装配无害）。
    pub async fn apply_to_runtime(&self) -> Result<(), String> {
        let proxy = self.assemble_sandbox();
        let tiers = self.tiers.clone();
        register_callback(
            "security.sandbox_validate",
            Box::new(move |payload: String| -> PyResult<String> {
                let args: JsonValue =
                    serde_json::from_str(&payload).map_err(|err| PyValueError::new_err(err.to_string()))?;
                let tool = args.get("tool").and_then(JsonValue::as_str).unwrap_or("");
                let operation = args
                    .get("operation")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                let target = args.get("target").and_then(JsonValue::as_str).unwrap_or("");
                // 档位判定先行：出厂 deny 档工具无条件拒绝（与权限命中与否无关）
                if tiers.get(tool).map(|t| t == DENY).unwrap_or(false) {
                    return Ok(serde_json::json!({
                        "pass": false,
                        "reason": "出厂 deny 档工具默认拒绝（权限变更须经补丁链审批转正）",
                    })
                    .to_string());
                }
                // 声明式定义现取（引擎工具清单同步通道）：取不到 = 按空登记表
                // 处理——非声明式工具无本地沙箱语义，交给门禁层判定
                let definitions = call_engine_op(
                    "engine.collect_specs",
                    JsonValue::Object(Default::default()),
                )
                .ok()
                .and_then(|specs| parse_engine_specs(&specs).ok())
                .unwrap_or_default();
                match proxy.validate(operation, target, tool, &definitions) {
                    // 通过时回传解析后的 canonical 目标（校验对象 = 执行对象：
                    // 下游 IO 按解析路径落位，符号链接 TOCTOU 面收敛）
                    Ok(resolved) => Ok(serde_json::json!({
                        "pass": true,
                        "reason": "",
                        "target": resolved,
                    })
                    .to_string()),
                    Err(violation) => Ok(serde_json::json!({
                        "pass": false,
                        "reason": violation.0,
                    })
                    .to_string()),
                }
            }),
        )
        .map_err(|err| format!("安全回调注册失败（sandbox_validate）: {err}"))?;

        let proxy = self.assemble_sandbox();
        register_callback(
            "security.guards_operation",
            Box::new(move |payload: String| -> PyResult<String> {
                let args: JsonValue =
                    serde_json::from_str(&payload).map_err(|err| PyValueError::new_err(err.to_string()))?;
                let operation = args
                    .get("operation")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                Ok(serde_json::json!({ "guarded": proxy.guards_operation(operation) }).to_string())
            }),
        )
        .map_err(|err| format!("安全回调注册失败（guards_operation）: {err}"))?;

        let tiers = self.tiers.clone();
        register_callback(
            "security.gating_tier",
            Box::new(move |payload: String| -> PyResult<String> {
                let args: JsonValue =
                    serde_json::from_str(&payload).map_err(|err| PyValueError::new_err(err.to_string()))?;
                let tool = args.get("tool").and_then(JsonValue::as_str).unwrap_or("");
                // 档位表语义：review 档 = 弹卡审批，allow/deny = 不弹卡
                let review = tiers.get(tool).map(|t| t == REVIEW).unwrap_or(false);
                Ok(serde_json::json!({ "review": review }).to_string())
            }),
        )
        .map_err(|err| format!("安全回调注册失败（gating_tier）: {err}"))?;

        call_engine_op(
            "pipeline.install_security_pipeline",
            JsonValue::Object(Default::default()),
        )?;
        Ok(())
    }
}

/// 引擎工具清单 → 声明式定义登记表（携带端点声明的条目才是声明式定义，
/// 引擎 ToolSpec 无端点字段）。
fn parse_engine_specs(specs: &JsonValue) -> Result<HashMap<String, DeclarativeSpec>, String> {
    let items = specs
        .as_array()
        .ok_or_else(|| "引擎工具清单不可解析（须为数组）".to_string())?;
    let mut definitions = HashMap::new();
    for item in items {
        if item.get("endpoint").is_none() {
            continue;
        }
        if let Ok(spec) = DeclarativeSpec::from_dict(item) {
            definitions.insert(spec.name.clone(), spec);
        }
    }
    Ok(definitions)
}

// ── 工作区授权器（授权确认卡形态的持久化/生效导流）──

/// 工作区授权记录集合与键（storage 恢复路径的统一契约）。
pub const AUTH_COLLECTION: &str = "workspace_auth";
pub const AUTH_KEY: &str = "authorized_root";

/// 授权记录构造（root 为空串 = 撤销墓碑；Storage 协议无删除原语，
/// 空 root 即未授权态，load 按空值回落）。
pub fn authorization_record(
    root: Option<&Path>,
    reason: &str,
    decision: &str,
    granted_at: f64,
    revoked: bool,
) -> JsonValue {
    match root {
        Some(root) => serde_json::json!({
            "root": root.to_string_lossy(),
            "granted_at": granted_at,
            "reason": reason,
            "decision": decision,
        }),
        None => serde_json::json!({
            "root": "",
            "revoked": revoked,
            "revoked_at": granted_at,
            "reason": reason,
            "decision": decision,
        }),
    }
}

/// 从 storage 恢复授权态（重启后文件工具立即回到生效根）。
///
/// 记录读取经引擎操作通道（engine.records_get 已注册）；根目录有效时
/// 执行 authorize + 文件工具重注册 + 引擎重建（下一回合生效）。
///
/// 授权确认卡（review 档语义）流程由宿主交互层经审批卡发起
/// （approval.gate_card_request 已注册：卡请求 + 决议注入两步形态），
/// 记录/生效导流在本模块。
pub async fn load_authorization(security: &SecurityDomain) -> Result<Option<String>, String> {
    let record = call_engine_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": AUTH_COLLECTION, "key": AUTH_KEY }),
    )
    .await?;
    let root = record
        .get("root")
        .and_then(|v| v.as_str())
        .filter(|root| !root.is_empty())
        .map(|root| root.to_string());
    if let Some(root) = &root {
        if Path::new(root).is_dir() {
            security.workspace.authorize(Path::new(root));
            security.reregister_file_tools(Some(Path::new(root))).await?;
            call_engine_op_async("engine.rebuild", JsonValue::Object(Default::default())).await?;
        }
    }
    Ok(root)
}

/// 授权结果持久化（经引擎操作通道 engine.records_put——薄包装已注册）。
pub async fn persist_authorization(record: JsonValue) -> Result<(), String> {
    call_engine_op_async(
        "engine.records_put",
        serde_json::json!({
            "collection": AUTH_COLLECTION,
            "key": AUTH_KEY,
            "data": record,
        }),
    )
    .await?;
    Ok(())
}

// ── 结构化判定留痕 ──

/// 结构化记录一次权限/沙箱判定（当前经 stderr 输出；宿主 logger 接线
/// 时替换出口——消息形态与引擎日志字段粒度一致）。
pub fn log_decision(
    tool: &str,
    decision: &str,
    operation: &str,
    target: &str,
    error_code: Option<&str>,
    reason: &str,
) {
    let mut detail = format!(
        "tool={tool} op={operation} target={} -> {decision}",
        truncate_chars(target, 200)
    );
    if let Some(code) = error_code {
        detail.push_str(&format!(" code={code}"));
    }
    if !reason.is_empty() {
        detail.push_str(&format!(" reason={}", truncate_chars(reason, 300)));
    }
    eprintln!("security_decision {detail}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkling-sec-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn spec_of(name: &str, endpoint: &str, config: JsonValue, permissions: Vec<&str>) -> DeclarativeSpec {
        DeclarativeSpec::from_dict(&json!({
            "name": name,
            "description": format!("{name} 测试定义"),
            "parameters": {"type": "object"},
            "permissions": permissions,
            "endpoint": endpoint,
            "endpoint_config": config,
            "meta": {
                "sandbox_limits": {"max_read_bytes": 1024, "max_write_bytes": 1024},
                "network_policy": {"allow_domains": ["arxiv.org"]},
            },
        }))
        .unwrap()
    }

    // ── 通配与权限规则 ──

    #[test]
    fn fn_match_crosses_separators_and_question_mark() {
        assert!(fn_match("C:/ws/**", "C:/ws/a/b.txt"));
        assert!(fn_match("*.rs", "main.rs"));
        assert!(!fn_match("*.rs", "main.rs.bak"));
        assert!(fn_match("/book/?", "/book/a"));
        assert!(!fn_match("/book/??", "/book/a"));
        assert!(fn_match("[abc]x", "bx"));
        assert!(!fn_match("[!abc]x", "bx"));
        assert!(fn_match("", ""));
        assert!(!fn_match("abc", "abcdef"));
    }

    #[test]
    fn parse_permission_two_part_defaults_action_star() {
        let rule = parse_permission("network:*.github.com").unwrap();
        assert_eq!(rule.domain, "network");
        assert_eq!(rule.action, "*");
        assert_eq!(rule.pattern, "*.github.com");
        let three = parse_permission("filesystem:read:/book/**").unwrap();
        assert_eq!(three.domain, "filesystem");
        assert_eq!(three.action, "read");
        assert_eq!(three.pattern, "/book/**");
    }

    #[test]
    fn network_matches_suffix_and_glob() {
        assert!(network_matches("*.arxiv.org", "arxiv.org"));
        assert!(network_matches("*.arxiv.org", "www.arxiv.org"));
        assert!(!network_matches("*.arxiv.org", "evil.com"));
        assert!(network_matches("arxiv.org", "arxiv.org"));
        assert!(!network_matches("arxiv.org", "sub.arxiv.org"));
        assert!(network_matches("*", "any-host"));
    }

    #[test]
    fn rule_matches_filesystem_denies_dotdot() {
        let rule = parse_permission("filesystem:read:C:/ws/**").unwrap();
        assert!(rule_matches(&rule, "read", "C:/ws/note.txt"));
        // `..` 段一律拒绝（防 `**` 跨界匹配放行穿越）
        assert!(!rule_matches(&rule, "read", "C:/ws/../outside.txt"));
        assert!(!rule_matches(&rule, "write", "C:/ws/note.txt"));
    }

    #[test]
    fn rule_matches_pipe_pattern_any() {
        let rule = parse_permission("process:exec:notify|notify_alt").unwrap();
        assert!(rule_matches(&rule, "exec", "notify"));
        assert!(rule_matches(&rule, "exec", "notify_alt"));
        assert!(!rule_matches(&rule, "exec", "evil"));
    }

    // ── 三档门禁 ──

    #[test]
    fn gate_deny_tier_unconditional() {
        let mut tiers = HashMap::new();
        tiers.insert("shell_exec".to_string(), DENY.to_string());
        let gate = TieredGate::new(tiers, DENY, HashMap::new());
        // deny 档无条件拒绝：权限命中与否无关（档位表先于权限判定）
        let result = gate.check(
            "shell_exec",
            "exec",
            "shell_exec",
            &["process:exec:shell_exec".to_string()],
            None,
        );
        assert_eq!(result.decision, DENY);
        assert!(result.reason.contains("deny 档"));
    }

    #[test]
    fn gate_allow_tier_passes_on_hit() {
        let mut tiers = HashMap::new();
        tiers.insert("notify".to_string(), ALLOW.to_string());
        let gate = TieredGate::new(tiers, DENY, HashMap::new());
        let result = gate.check(
            "notify",
            "exec",
            "notify",
            &["process:exec:notify".to_string()],
            None,
        );
        assert!(result.is_allow());
        assert!(!gate.review_needed("notify")); // allow 档 = L1 直落库
    }

    #[test]
    fn gate_review_tier_requires_review_that_override_can_lower() {
        let mut tiers = HashMap::new();
        tiers.insert("launch_app".to_string(), REVIEW.to_string());
        let gate = TieredGate::new(tiers.clone(), DENY, HashMap::new());
        let result = gate.check(
            "launch_app",
            "exec",
            "launch_app",
            &["process:exec:launch_app".to_string()],
            None,
        );
        assert_eq!(result.decision, REVIEW);
        assert!(gate.review_needed("launch_app"));

        let mut overrides = HashMap::new();
        overrides.insert("launch_app".to_string(), "l1".to_string());
        let lowered = TieredGate::new(tiers, DENY, overrides);
        assert!(!lowered.review_needed("launch_app"));
        assert!(lowered
            .check("launch_app", "exec", "launch_app", &["process:exec:launch_app".to_string()], None)
            .is_allow());
    }

    #[test]
    fn gate_untiered_tools_pass_by_declaration() {
        // 出厂契约：挂载/补丁新增工具不在档位表 = 按声明权限直过
        let gate = TieredGate::new(HashMap::new(), DENY, HashMap::new());
        assert!(!gate.review_needed("echo_mcp_tool"));
        let result = gate.check(
            "echo_mcp_tool",
            "exec",
            "echo",
            &["process:exec:echo".to_string()],
            None,
        );
        assert!(result.is_allow());
    }

    #[test]
    fn gate_miss_denies_with_actionable_reason() {
        let mut tiers = HashMap::new();
        tiers.insert("fetch".to_string(), REVIEW.to_string());
        let gate = TieredGate::new(tiers, DENY, HashMap::new());
        let miss = gate.check(
            "fetch",
            "connect",
            "evil.example.com",
            &["network:connect:arxiv.org".to_string()],
            None,
        );
        assert_eq!(miss.decision, DENY);
        assert!(miss.reason.contains("权限未命中"));

        let empty = gate.check("fetch", "connect", "evil.example.com", &[], None);
        assert!(empty.reason.contains("默认拒绝"));
    }

    #[test]
    fn gate_file_ops_placeholder_denies_unauthorized() {
        let mut tiers = HashMap::new();
        tiers.insert("file_read".to_string(), ALLOW.to_string());
        let gate = TieredGate::new(tiers, DENY, HashMap::new());
        let mut definitions = HashMap::new();
        definitions.insert(
            "file_read".to_string(),
            DeclarativeSpec::from_dict(&json!({
                "name": "file_read",
                "description": "读文件",
                "parameters": {"type": "object"},
                "permissions": ["filesystem:read:${workspace_root}/**"],
                "endpoint": "file_ops",
                "endpoint_config": {"root": "${workspace_root}"},
                "meta": {},
            }))
            .unwrap(),
        );
        let result = gate.check(
            "file_read",
            "read",
            "anything",
            &["filesystem:read:${workspace_root}/**".to_string()],
            Some(&definitions),
        );
        assert_eq!(result.decision, DENY);
        assert!(result.reason.contains("工作区未授权"));
    }

    #[test]
    fn gate_definition_permissions_are_authoritative() {
        let mut tiers = HashMap::new();
        tiers.insert("fetch".to_string(), REVIEW.to_string());
        let gate = TieredGate::new(tiers, DENY, HashMap::new());
        let mut definitions = HashMap::new();
        definitions.insert(
            "fetch".to_string(),
            spec_of("fetch", "http_fetch", json!({"method": "GET"}), vec!["network:connect:arxiv.org"]),
        );
        // 调用方伪造宽松权限（network:connect:*）+ 定义权限只允许 arxiv.org
        let rogue = gate.check(
            "fetch",
            "connect",
            "evil.example.com",
            &["network:connect:*".to_string()],
            Some(&definitions),
        );
        assert_eq!(rogue.decision, DENY, "定义权限应覆盖调用方 spec 权限");
        let inside = gate.check(
            "fetch",
            "connect",
            "arxiv.org",
            &["network:connect:*".to_string()],
            Some(&definitions),
        );
        assert_eq!(inside.decision, REVIEW); // 命中定义权限 → review 档需审批
    }

    // ── 工作区守卫与沙箱代理 ──

    #[test]
    fn workspace_authorize_revoke_is_idempotent() {
        let guard = WorkspaceGuard::default();
        let ws = scratch("auth");
        let _keep = Scratch(ws.clone());
        guard.authorize(&ws);
        assert!(guard.authorized());
        let root = guard.root().unwrap();
        assert_eq!(root, resolve_non_strict(&ws), "授权根 = 解析后的权威路径");
        guard.authorize(&ws); // 幂等
        assert_eq!(guard.root().unwrap(), root);
        guard.revoke();
        assert!(!guard.authorized());
        assert!(guard.root().is_none());
    }

    #[test]
    fn workspace_validate_file_bounds_and_size() {
        let guard = WorkspaceGuard::default();
        let ws = scratch("bounds");
        let _keep = Scratch(ws.clone());
        std::fs::write(ws.join("inside.txt"), "墨引擎").unwrap();
        std::fs::write(ws.parent().unwrap().join("outside.txt"), "越界").unwrap();

        // 未授权拒绝（fail-closed）
        let denied = guard.validate_file("read", "x", None).unwrap_err();
        assert!(denied.0.contains("工作区未授权"));

        guard.authorize(&ws);
        let resolved = guard.validate_file("read", "inside.txt", None).unwrap();
        assert!(resolved.contains("inside.txt"));

        // 越界路径拒绝
        let outside = ws.parent().unwrap().join("outside.txt");
        assert!(guard.validate_file("read", &outside.to_string_lossy(), None).is_err());
        let traverse = format!("{}/../outside.txt", ws.to_string_lossy());
        assert!(guard.validate_file("read", &traverse, None).is_err());

        // 大小上限（read 时核对；文件 5 字节 > 4 上限 → 拒绝）
        let small = guard.validate_file("read", "inside.txt", Some(4)).unwrap_err();
        assert!(small.0.contains("SEC_004"), "错误码缺失: {}", small.0);
        let ok = guard.validate_file("read", "inside.txt", Some(64)).unwrap();
        assert!(!ok.is_empty());
    }

    #[test]
    fn workspace_symlink_escape_rejected() {
        let guard = WorkspaceGuard::default();
        let ws = scratch("symlink");
        let _keep = Scratch(ws.clone());
        let outside = ws.parent().unwrap().join("target-outside.txt");
        std::fs::write(&outside, "outside").unwrap();
        let link = ws.join("escape.txt");
        #[cfg(unix)]
        {
            if std::os::unix::fs::symlink(&outside, &link).is_err() {
                return; // 环境不允许建符号链接：跳过（等价于 e2e 的 skipif）
            }
        }
        #[cfg(windows)]
        {
            if std::os::windows::fs::symlink_file(&outside, &link).is_err() {
                return; // 需管理员/开发者模式：跳过
            }
        }
        guard.authorize(&ws);
        let result = guard.validate_file("read", &link.to_string_lossy(), None);
        assert!(result.is_err(), "符号链接逃逸应拒绝");
    }

    #[test]
    fn sandbox_proxy_dispatch_by_endpoint_type() {
        let guard = WorkspaceGuard::default();
        let proxy = DeclarativeSandboxProxy::new(guard.clone());

        // 非声明式工具（内省/自指/挂载语义）= 无本地沙箱判定
        assert_eq!(proxy.validate("exec", "echo", "introspect", &HashMap::new()).unwrap(), "echo");

        let mut definitions = HashMap::new();
        definitions.insert(
            "notify".to_string(),
            spec_of("notify", "process_exec", json!({"allowlist": ["notify"]}), vec![]),
        );
        definitions.insert(
            "fetch".to_string(),
            spec_of("fetch", "http_fetch", json!({"method": "GET"}), vec![]),
        );
        definitions.insert(
            "file_read".to_string(),
            spec_of("file_read", "file_ops", json!({"root": "${workspace_root}"}), vec![]),
        );
        assert!(proxy.validate("exec", "notify", "notify", &definitions).is_ok());
        let blocked = proxy.validate("exec", "evil", "notify", &definitions).unwrap_err();
        assert!(blocked.0.contains("SEC_007"), "错误码缺失: {}", blocked.0);
        assert!(proxy.validate("connect", "arxiv.org", "fetch", &definitions).is_ok());
        assert!(proxy.validate("connect", "evil.example.com", "fetch", &definitions).is_err());
        // 文件工具 + 未授权工作区 → 拒绝
        let unauth = proxy.validate("read", "note.txt", "file_read", &definitions).unwrap_err();
        assert!(unauth.0.contains("工作区未授权"));
    }

    #[test]
    fn sandbox_proxy_file_ops_after_authorization() {
        let ws = scratch("proxy-file");
        let _keep = Scratch(ws.clone());
        let guard = WorkspaceGuard::default();
        guard.authorize(&ws);
        let proxy = DeclarativeSandboxProxy::new(guard);
        let mut definitions = HashMap::new();
        definitions.insert(
            "file_write".to_string(),
            spec_of("file_write", "file_ops", json!({"root": ws.to_string_lossy()}), vec![]),
        );
        let ok = proxy
            .validate("write", "note.txt", "file_write", &definitions)
            .unwrap();
        assert!(ok.contains("note.txt"));
    }

    // ── process_exec 解析与守卫 ──

    #[test]
    fn resolve_process_exec_enum_mismatch_and_deny() {
        let mut tiers = HashMap::new();
        tiers.insert("launch_app".to_string(), REVIEW.to_string());
        tiers.insert("shell_exec".to_string(), DENY.to_string());
        let mismatch = resolve_process_exec("launch_app", "evil_command", &tiers).unwrap_err();
        assert_eq!(mismatch["status"], "command_enum_mismatch");
        let deny = resolve_process_exec("shell_exec", "shell_exec", &tiers).unwrap_err();
        assert_eq!(deny["status"], "deny_tier");
        assert!(resolve_process_exec("launch_app", "launch_app", &tiers).is_ok());
    }

    // ── 文件执行体 ──

    #[test]
    fn file_ops_executor_write_read_edit_rollback() {
        let ws = scratch("executor");
        let _keep = Scratch(ws.clone());
        let path = ws.join("note.txt");
        let limits = SizeLimits { max_read: 4096, max_write: 4096 };
        let mut executor = FileOpsExecutor::default();

        let written = executor.call(
            &json!({"operation": "write", "path": path.to_string_lossy(), "content": "墨引擎笔记"}),
            &limits,
        );
        assert!(serde_json::from_str::<JsonValue>(&written).unwrap()["ok"].as_bool().unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "墨引擎笔记");

        let read_back = executor.call(
            &json!({"operation": "read", "path": path.to_string_lossy()}),
            &limits,
        );
        let parsed: JsonValue = serde_json::from_str(&read_back).unwrap();
        assert_eq!(parsed["content"], "墨引擎笔记");

        let edited = executor.call(
            &json!({"operation": "write", "path": path.to_string_lossy(),
                    "old_text": "墨引擎", "new_text": "打字机"}),
            &limits,
        );
        assert!(serde_json::from_str::<JsonValue>(&edited).unwrap()["ok"].as_bool().unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "打字机笔记");

        // 编辑目标未命中
        let missed = executor.call(
            &json!({"operation": "write", "path": path.to_string_lossy(),
                    "old_text": "不存在", "new_text": "x"}),
            &limits,
        );
        assert_eq!(serde_json::from_str::<JsonValue>(&missed).unwrap()["status"], "old_text_not_found");

        // 写前快照可回退（两次写快照分别记录，回退弹栈）
        let rolled = executor.rollback(&path);
        assert!(rolled);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "墨引擎笔记");
    }

    #[test]
    fn file_ops_executor_limits_and_errors() {
        let ws = scratch("executor-limits");
        let _keep = Scratch(ws.clone());
        let path = ws.join("big.txt");
        let limits = SizeLimits { max_read: 10, max_write: 10 };
        let mut executor = FileOpsExecutor::default();

        let over = executor.call(
            &json!({"operation": "write", "path": path.to_string_lossy(), "content": "x".repeat(64)}),
            &limits,
        );
        let parsed: JsonValue = serde_json::from_str(&over).unwrap();
        assert_eq!(parsed["status"], "size_limit");
        assert!(!path.exists(), "超限不落盘");

        std::fs::write(&path, "hello world this is long enough").unwrap();
        let read_over = executor.call(&json!({"operation": "read", "path": path.to_string_lossy()}), &limits);
        assert_eq!(serde_json::from_str::<JsonValue>(&read_over).unwrap()["status"], "size_limit");

        let missing = executor.call(&json!({"operation": "read", "path": ws.join("ghost.txt").to_string_lossy()}), &limits);
        assert_eq!(serde_json::from_str::<JsonValue>(&missing).unwrap()["status"], "not_found");

        let invalid = executor.call(&json!({"operation": "chmod", "path": "x"}), &limits);
        assert_eq!(serde_json::from_str::<JsonValue>(&invalid).unwrap()["status"], "invalid_operation");
    }

    #[test]
    fn file_ops_executor_search_and_search_paths() {
        let ws = scratch("executor-search");
        let _keep = Scratch(ws.clone());
        std::fs::create_dir_all(ws.join("src").join("sub")).unwrap();
        std::fs::write(ws.join("src").join("main.rs"), "fn main() { println!(\"墨引擎\"); }").unwrap();
        std::fs::write(ws.join("src").join("sub").join("lib.rs"), "// 墨引擎注释\npub fn lib() {}").unwrap();
        std::fs::write(ws.join("src").join("notes.txt"), "plain text").unwrap();
        let limits = SizeLimits { max_read: DEFAULT_MAX_READ_BYTES, max_write: DEFAULT_MAX_WRITE_BYTES };
        let mut executor = FileOpsExecutor::default();

        // grep：正则 + 路径 glob 过滤 + 行号/摘要
        let searched = executor.call(
            &json!({"operation": "search", "root": ws.to_string_lossy(), "pattern": "墨引擎", "glob": "**/*.rs"}),
            &limits,
        );
        let parsed: JsonValue = serde_json::from_str(&searched).unwrap();
        assert_eq!(parsed["ok"], true);
        let matches = parsed["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 2);
        assert_eq!(matches[0]["path"], "src/main.rs");
        assert_eq!(matches[0]["line"], 1);
        assert!(matches[0]["snippet"].as_str().unwrap().contains("墨引擎"));

        // include 类型过滤（.txt 后缀语义）
        let typed = executor.call(
            &json!({"operation": "search", "root": ws.to_string_lossy(), "pattern": "plain", "include": ".txt"}),
            &limits,
        );
        let typed_parsed: JsonValue = serde_json::from_str(&typed).unwrap();
        assert_eq!(typed_parsed["matches"].as_array().unwrap().len(), 1);

        // 非法正则结构化失败
        let invalid = executor.call(
            &json!({"operation": "search", "root": ws.to_string_lossy(), "pattern": "("}),
            &limits,
        );
        assert_eq!(serde_json::from_str::<JsonValue>(&invalid).unwrap()["status"], "invalid_pattern");

        // glob：** 跨目录递归匹配；只列路径不读内容
        let globbed = executor.call(
            &json!({"operation": "search_paths", "root": ws.to_string_lossy(), "pattern": "**/*.rs"}),
            &limits,
        );
        let globbed_parsed: JsonValue = serde_json::from_str(&globbed).unwrap();
        assert_eq!(globbed_parsed["ok"], true);
        let paths = globbed_parsed["paths"].as_array().unwrap();
        assert_eq!(paths.len(), 2);
        assert!(paths.iter().any(|p| p.as_str().unwrap().ends_with("main.rs")));
        assert!(paths.iter().any(|p| p.as_str().unwrap().ends_with("lib.rs")));
        // 检索起点收敛（path 子目录）
        let narrowed = executor.call(
            &json!({"operation": "search_paths", "root": ws.to_string_lossy(),
                    "path": ws.join("src").to_string_lossy(), "pattern": "**/*.rs"}),
            &limits,
        );
        let narrowed_parsed: JsonValue = serde_json::from_str(&narrowed).unwrap();
        assert_eq!(narrowed_parsed["paths"].as_array().unwrap().len(), 2);
    }

    // ── http_fetch 执行体 ──

    #[tokio::test]
    async fn http_fetch_executor_network_policy_second_layer() {
        let mut definition = spec_of("fetch", "http_fetch", json!({"method": "GET"}), vec![]);
        // 定义级网络策略（折叠进 meta 的形态）
        definition.meta.insert(
            "network_policy".to_string(),
            json!({"allow_domains": ["arxiv.org"]}),
        );
        let fetch: FetchFn = Box::new(|_def, args| {
            Ok(format!("stub-fetch:{}", args.get("url").and_then(|v| v.as_str()).unwrap_or("")))
        });
        let inside = execute_http_fetch(&definition, &json!({"url": "https://arxiv.org/abs/2401.12345"}), Some(&fetch), 1000).await;
        assert!(inside.contains("stub-fetch:"), "界内域名应放行: {inside}");
        let outside = execute_http_fetch(&definition, &json!({"url": "https://evil.example/x"}), Some(&fetch), 1000).await;
        let parsed: JsonValue = serde_json::from_str(&outside).unwrap();
        assert_eq!(parsed["status"], "network_domain_blocked");
        // 非 http/https 协议无法判定目标 → 拒绝
        let weird = execute_http_fetch(&definition, &json!({"url": "file:///etc/passwd"}), Some(&fetch), 1000).await;
        assert_eq!(serde_json::from_str::<JsonValue>(&weird).unwrap()["status"], "network_domain_blocked");
    }

    #[test]
    fn spec_from_dict_folds_top_level_network_policy() {
        let spec = DeclarativeSpec::from_dict(&json!({
            "name": "web_search",
            "description": "联网搜索",
            "parameters": {"type": "object"},
            "permissions": ["network:connect:*"],
            "endpoint": "http_fetch",
            "endpoint_config": {"method": "GET"},
            "meta": {"domain": "network"},
            "network_policy": {"allow_domains": []},
        }))
        .unwrap();
        assert!(spec.allow_domains().is_empty());
        assert!(spec.meta.contains_key("network_policy"));
    }

    // ── 影子 vetting ──

    #[test]
    fn shadow_vetting_store_mismatch_detection() {
        let shadow = ShadowVettingStore::default();
        shadow.record(
            "test.echo",
            vec![(
                "echo".to_string(),
                json!({"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}),
            )],
        );
        assert_eq!(shadow.server_tools("test.echo"), vec!["echo".to_string()]);

        // 无影子记录
        let no_record = shadow.check_tool("svc.other", "echo", None);
        assert_eq!(no_record.len(), 1);
        assert!(no_record[0].contains("无影子记录"));

        // 幽灵工具（server 实际未暴露）
        let ghost = shadow.check_tool("test.echo", "ghost_tool", None);
        assert_eq!(ghost.len(), 1);
        assert!(ghost[0].contains("不在影子清单"));

        // 必填项漂移
        let mismatch = shadow.check_tool(
            "test.echo",
            "echo",
            Some(&json!({"type": "object", "properties": {}, "required": ["ghost_param"]})),
        );
        assert_eq!(mismatch.len(), 1);
        assert!(mismatch[0].contains("参数必填项"));

        // 一致声明 = 放行
        let consistent = shadow.check_tool(
            "test.echo",
            "echo",
            Some(&json!({"type": "object", "properties": {}, "required": ["message"]})),
        );
        assert!(consistent.is_empty());
    }

    #[test]
    fn l2_vetting_hook_fail_closed_chain() {
        let shadow = ShadowVettingStore::default();
        let hook = SecurityL2Vetting::new(shadow.clone(), None);

        // 非 TOOL 补丁：交内层（缺省放行）
        assert!(hook.check("environment", &json!({"name": "env"})).is_empty());

        // MCP 工具补丁：未过 vetting = 拒绝（fail-closed）
        let payload = json!({
            "name": "echo", "endpoint": "mcp",
            "endpoint_config": {"server_id": "test.echo"},
            "parameters": {"type": "object"},
        });
        let unvetted = hook.check("tool", &payload);
        assert_eq!(unvetted.len(), 1);
        assert!(unvetted[0].contains("vetting"));

        // 登记放行 + 影子清单一致 = 放行
        hook.mark_vetted(
            "test.echo",
            Some(vec![("echo".to_string(), json!({"type": "object", "properties": {"message": {"type": "string"}}}))]),
        );
        assert!(hook.is_vetted("test.echo"));
        assert!(hook.check("tool", &payload).is_empty());

        // 声明与影子不一致 = 拒绝
        let drifted = json!({
            "name": "echo", "endpoint": "mcp",
            "endpoint_config": {"server_id": "test.echo"},
            "parameters": {"type": "object", "properties": {}, "required": ["ghost"]},
        });
        let mismatch = hook.check("tool", &drifted);
        assert_eq!(mismatch.len(), 1);
        assert!(mismatch[0].contains("影子运行核对未通过"));
    }

    #[test]
    fn l2_vetting_hook_inner_passthrough() {
        let inner: VettingInner =
            Box::new(|payload| vec![format!("inner rejected: {}", payload.get("name").and_then(|v| v.as_str()).unwrap_or(""))]);
        let hook = SecurityL2Vetting::new(ShadowVettingStore::default(), Some(inner));
        let result = hook.check("rule", &json!({"name": "r1"}));
        assert_eq!(result, vec!["inner rejected: r1".to_string()]);
    }

    // ── 域装配形态 ──

    #[test]
    fn security_domain_from_tool_data_builds_tiers_and_file_defs() {
        let data = json!({"tools": [
            {"name": "notify", "approval": "allow", "endpoint": "process_exec"},
            {"name": "file_read", "approval": "allow", "endpoint": "file_ops",
             "endpoint_config": {"root": "${workspace_root}"}, "permissions": ["filesystem:read:${workspace_root}/**"],
             "meta": {}},
            {"name": "file_write", "approval": "review", "endpoint": "file_ops",
             "endpoint_config": {"root": "${workspace_root}"}, "permissions": ["filesystem:write:${workspace_root}/**"],
             "meta": {}},
        ]});
        let domain = SecurityDomain::from_tool_data(&data).unwrap();
        assert_eq!(domain.tiers.get("notify").unwrap(), ALLOW);
        assert_eq!(domain.tiers.get("file_write").unwrap(), REVIEW);
        assert_eq!(domain.file_tool_defs().len(), 2);
        // 授权重注册：占位符 → 实际根
        let ws = scratch("domain-rereg");
        let _keep = Scratch(ws.clone());
        let rebuilt = domain.rebuilt_file_specs(Some(&ws));
        assert_eq!(rebuilt[0].permissions[0], format!("filesystem:read:{}/**", ws.to_string_lossy().replace('\\', "/")));
        assert_eq!(rebuilt[0].endpoint_config.get("root").unwrap().as_str().unwrap(), ws.to_string_lossy().as_ref());
        // 撤销 = 占位符保留
        let revoked = domain.rebuilt_file_specs(None);
        assert!(revoked[0].permissions[0].contains("${workspace_root}"));
        assert!(revoked[0].endpoint_config.get("root").unwrap().as_str().unwrap().contains("workspace_root"));
    }

    #[test]
    fn apply_to_runtime_fails_closed_without_engine() {
        // 无引擎环境（回调桥未装配）：回调注册即结构化失败——不返回占位
        // 文案、不静默假装流水线已安装（fail-closed 可测）
        let _serial = crate::engine::host::bridge_guard();
        let data = json!({"tools": [
            {"name": "notify", "approval": "allow", "endpoint": "process_exec"},
        ]});
        let domain = SecurityDomain::from_tool_data(&data).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(domain.apply_to_runtime());
        assert!(err.is_err());
        let message = err.unwrap_err();
        assert!(!message.contains("需 op"), "接线后不再返回占位文案: {message}");
        assert!(message.contains("回调注册失败"), "失败点应定位在回调注册: {message}");
    }

    #[test]
    fn authorization_record_shapes_authorize_and_tombstone() {
        let granted = authorization_record(Some(Path::new("C:/ws")), "理由", "allow", 123.0, false);
        assert_eq!(granted["root"], "C:/ws");
        assert_eq!(granted["decision"], "allow");
        let tombstone = authorization_record(None, "撤销", "allow", 124.0, true);
        assert_eq!(tombstone["root"], "");
        assert_eq!(tombstone["revoked"], true);
        assert!(tombstone["revoked_at"].as_f64().is_some());
    }

    #[test]
    fn gate_result_shapes() {
        let result = GateResult::new(ALLOW, "t1", "exec", "echo", "");
        assert!(result.is_allow());
        assert_eq!(result.tool, "t1");
    }
}

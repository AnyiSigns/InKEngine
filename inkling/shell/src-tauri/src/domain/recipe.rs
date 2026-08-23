//! 装配配方域：seed_data 只读装载与配方数据映射。
//!
//! 本模块是纯数据映射层——所有产品语义都住在 JSON 数据里，这里只做
//! 形态转换：
//! - 17 个数据文件装载（`load_seed_data`），缺文件/坏 JSON 显式报错，
//!   不静默跳过；
//! - 配方各字段逐字段落值，每个字段都有明确的数据来源与推导规则
//!   （各 `map_*` 函数文档）；
//! - 挂载类工具 → 审批分级、界面三层白名单、检索召回上限等映射以
//!   数据为准，缺省值都写在数据里，映射规则可审计。
//!
//! 「怎么装配引擎 = 数据」：宿主换壳 = 换配方，机制层不感知宿主形态。
//! 运行时装配交互（钩子接线、引擎桥调用）由装配侧负责，本模块只产出
//! 装配所需的数据形态。

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::path::PathBuf;

use serde_json::{json, Map as JsonMap, Value as JsonValue};

use super::common::{DomainError, SEED_DATA_FILES};

/// 域名种子注入清单名（稳定键，供幂等注入与回退锚点）。
pub const DOMAIN_SEED_NAME: &str = "inkling.domain";

/// 挂载类工具名：外部能力接入须人工审批（知识集工具规则条目同源）。
const MOUNT_TOOL_NAME: &str = "propose_mcp_mount";

/// 内省五元工具名（与引擎内省工具清单同源，防魔法字符串漂移）。
const INSPECT_TOOL_NAMES: [&str; 5] = [
    "inspect_graph",
    "inspect_rules",
    "inspect_knowledge",
    "inspect_ui",
    "inspect_tools",
];

/// 挂载工具升级后的 TOOL 补丁审批档位（外部能力接入 = 高风险形态）。
const TOOL_APPROVAL_LEVEL_L2: &str = "L2";

/// 用户集 id 缺省值（manifest 无身份登记时的回落键）。
const DEFAULT_SET_ID: &str = "inkling";

/// 记忆召回上限缺省值（memory.json recall.default_limit 缺省时）。
const DEFAULT_RECALL_LIMIT: usize = 8;

/// seed_data 目录的只读装载产物（文件名 → 解析后的 JSON 值）。
#[derive(Debug, Clone)]
pub struct SeedDataBundle {
    /// 产品根目录（seed_data/ 与 manifest.json 的所在目录）。
    pub root: PathBuf,
    /// 文件名 → JSON 数据（装载时逐文件校验，缺文件/坏 JSON 显式报错）。
    pub data: HashMap<String, JsonValue>,
}

impl SeedDataBundle {
    /// 取单个数据文件的解析结果（装载产物内必存在）。
    pub fn file(&self, name: &str) -> &JsonValue {
        self.data
            .get(name)
            .expect("装载产物缺文件（load_seed_data 已校验）")
    }
}

/// 装载 seed_data 目录（缺文件/坏 JSON 显式报错，不静默跳过）。
pub fn load_seed_data(root: &Path) -> Result<SeedDataBundle, DomainError> {
    let seed_dir = root.join("seed_data");
    let mut data = HashMap::with_capacity(SEED_DATA_FILES.len());
    for name in SEED_DATA_FILES {
        let path = seed_dir.join(name);
        let text = std::fs::read_to_string(&path).map_err(|_| {
            DomainError::InvalidData(format!("seed_data 缺文件: {}", path.display()))
        })?;
        let value: JsonValue = serde_json::from_str(&text).map_err(|err| {
            DomainError::InvalidData(format!("seed_data 文件非法 JSON: {} ({err})", path.display()))
        })?;
        data.insert(name.to_string(), value);
    }
    Ok(SeedDataBundle {
        root: root.to_path_buf(),
        data,
    })
}

/// 读产品根 manifest.json（身份登记与契约清单）。
fn load_manifest(bundle: &SeedDataBundle) -> Result<JsonValue, DomainError> {
    let path = bundle.root.join("manifest.json");
    let text = std::fs::read_to_string(&path).map_err(|_| {
        DomainError::InvalidData(format!("manifest.json 缺失: {}", path.display()))
    })?;
    serde_json::from_str(&text).map_err(|err| {
        DomainError::InvalidData(format!("manifest.json 非法 JSON ({err})"))
    })
}

// ── 界面三层白名单映射 ──

/// 递归收集 ui_spec 布局树中的绑定通道（bind.channel）。
fn walk_bind_channels(node: &JsonValue, out: &mut Vec<String>) {
    let obj = node.as_object();
    if let Some(obj) = obj {
        if let Some(bind) = obj.get("bind").and_then(JsonValue::as_object) {
            if let Some(channel) = bind.get("channel").and_then(JsonValue::as_str) {
                out.push(channel.to_string());
            }
        }
        if let Some(children) = obj.get("children").and_then(JsonValue::as_array) {
            for child in children {
                walk_bind_channels(child, out);
            }
        }
    }
}

/// 界面绑定通道白名单（三层白名单之一，校验器与渲染器同源）。
///
/// 推导规则 = 三源并集（缺一不可，防绑定遗漏被静默拒绝）：
/// 1. ui_spec 布局树实际使用的 bind.channel；
/// 2. event_types.json 全部事件名（以 `events.<name>` 形态放行——
///    事件流绑定通道按注册表放行，未注册事件名不进入白名单）；
/// 3. 内省五元快照通道（inspect_*，与引擎内省工具名同源）。
pub fn map_ui_allowed_channels(bundle: &SeedDataBundle) -> Vec<String> {
    let mut channels: Vec<String> = Vec::new();
    let ui_spec = bundle.file("ui_spec.json");
    if let Some(root) = ui_spec.get("root") {
        walk_bind_channels(root, &mut channels);
    }
    let events = bundle.file("event_types.json");
    if let Some(list) = events.get("events").and_then(JsonValue::as_array) {
        for spec in list {
            if let Some(name) = spec.get("name").and_then(JsonValue::as_str) {
                channels.push(format!("events.{name}"));
            }
        }
    }
    channels.extend(INSPECT_TOOL_NAMES.iter().map(|name| name.to_string()));
    channels.sort();
    channels.dedup();
    channels
}

/// 界面组件白名单（manifest 契约清单 = 出厂渲染组件集合）。
pub fn map_ui_allowed_components(bundle: &SeedDataBundle) -> Result<Vec<String>, DomainError> {
    let manifest = load_manifest(bundle)?;
    let list = manifest
        .get("contracts")
        .and_then(|c| c.get("renderer_components"))
        .and_then(JsonValue::as_array)
        .ok_or_else(|| DomainError::InvalidData("manifest 缺 contracts.renderer_components".into()))?;
    let mut names = Vec::with_capacity(list.len());
    for item in list {
        names.push(
            item.as_str()
                .ok_or_else(|| DomainError::InvalidData("渲染组件名须为字符串".into()))?
                .to_string(),
        );
    }
    Ok(names)
}

/// 主题 token 白名单（ui_spec.theme 的全部语义键，组件经 token 取色）。
pub fn map_ui_allowed_theme_tokens(bundle: &SeedDataBundle) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let theme = bundle.file("ui_spec.json").get("theme");
    if let Some(map) = theme.and_then(JsonValue::as_object) {
        tokens.extend(map.keys().cloned());
    }
    tokens.sort();
    tokens
}

// ── 事件类型 / harness / 种子映射 ──

/// 事件类型基线（装配期登记 + 集内演化类型加载的数据形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct EventTypeSpec {
    pub name: String,
    pub schema: Option<JsonValue>,
    pub renderer: String,
    pub system: bool,
    pub meta: JsonValue,
}

impl EventTypeSpec {
    /// 转为引擎 op 通道可消费的 JSON 形态（与事件类型声明构造同构）。
    pub fn to_json(&self) -> JsonValue {
        let mut data = JsonMap::new();
        data.insert("name".into(), json!(self.name));
        data.insert("system".into(), json!(self.system));
        if let Some(schema) = &self.schema {
            data.insert("schema".into(), schema.clone());
        }
        if !self.renderer.is_empty() {
            data.insert("renderer".into(), json!(self.renderer));
        }
        if !self.meta.is_null() {
            data.insert("meta".into(), self.meta.clone());
        }
        JsonValue::Object(data)
    }
}

/// 事件类型基线映射（name/schema/renderer/system/meta 与声明字段对齐）。
pub fn map_event_type_specs(bundle: &SeedDataBundle) -> Vec<EventTypeSpec> {
    let mut specs: Vec<EventTypeSpec> = Vec::new();
    let events = bundle.file("event_types.json");
    if let Some(list) = events.get("events").and_then(JsonValue::as_array) {
        for raw in list {
            if let Some(name) = raw.get("name").and_then(JsonValue::as_str) {
                let schema = raw.get("schema").and_then(JsonValue::as_object).cloned();
                specs.push(EventTypeSpec {
                    name: name.to_string(),
                    schema: schema.map(JsonValue::Object),
                    renderer: raw
                        .get("renderer")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("")
                        .to_string(),
                    system: raw.get("system").and_then(JsonValue::as_bool).unwrap_or(false),
                    meta: raw
                        .get("meta")
                        .cloned()
                        .filter(|v| v.is_object())
                        .unwrap_or_else(|| json!({})),
                });
            }
        }
    }
    specs
}

/// 自举 harness 定义（领域工具清单数据形态，注册 + 仓库落库）。
///
/// harness 的工具清单 = tools.json 全文（声明式工具定义数据），
/// 与「工具声明必须走补丁链演化管线产出」的约束同源。
#[derive(Debug, Clone, PartialEq)]
pub struct HarnessDefinitionData {
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub tools: Vec<JsonValue>,
    pub meta: JsonValue,
}

/// harness 定义映射：领域工具清单 = tools.json 的 tools 数组原样承载。
pub fn map_harness_definitions(bundle: &SeedDataBundle) -> Vec<HarnessDefinitionData> {
    let tools = bundle
        .file("tools.json")
        .get("tools")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    vec![HarnessDefinitionData {
        name: "inkling.research".to_string(),
        description: "知识/研究孵化领域 harness（数据形态：领域工具清单 + 领域基线）".to_string(),
        keywords: vec![
            "research".to_string(),
            "knowledge".to_string(),
            "incubation".to_string(),
        ],
        tools,
        meta: json!({ "domain_boot": "知识/研究孵化" }),
    }]
}

/// 知识条目直注形态（字段名与知识条目契约对齐）。
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeEntry {
    pub id: String,
    pub level: String,
    pub kind: String,
    pub data: JsonValue,
    pub source: String,
    pub credibility: f64,
    pub title: String,
    pub tags: Vec<String>,
}

/// seed_data 知识条目/模板条目的直注形态（字段名与知识条目契约对齐）。
fn entry_from_data(raw: &JsonValue) -> Result<KnowledgeEntry, DomainError> {
    let id = raw
        .get("id")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DomainError::InvalidData("知识条目缺 id（字符串）".into()))?
        .to_string();
    let level = raw
        .get("level")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DomainError::InvalidData(format!("知识条目 {id} 缺 level（字符串）")))?
        .to_string();
    let kind = raw
        .get("kind")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DomainError::InvalidData(format!("知识条目 {id} 缺 kind（字符串）")))?
        .to_string();
    Ok(KnowledgeEntry {
        id,
        level,
        kind,
        data: raw
            .get("data")
            .cloned()
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({})),
        source: raw
            .get("source")
            .and_then(JsonValue::as_str)
            .unwrap_or("model")
            .to_string(),
        credibility: raw
            .get("credibility")
            .and_then(JsonValue::as_f64)
            .unwrap_or(0.9),
        title: raw
            .get("title")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string(),
        tags: raw
            .get("tags")
            .and_then(JsonValue::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// 领域种子注入清单（seed_knowledge_set 幂等跳过已存在条目）。
///
/// 数据来源：knowledge.json（规则/权重/工具规则条目）+ templates.json
/// （编排模板条目）。rules.json 的谓词规则不进知识集——谓词实现是
/// 执行件，知识集只承载可序列化的声明数据（执行件不进知识集）。
#[derive(Debug, Clone, PartialEq)]
pub struct SeedProvider {
    pub name: String,
    pub entries: Vec<KnowledgeEntry>,
}

/// 配方 seeds 直注清单（通用基线由引擎恒注，这里只挂领域种子）。
pub fn map_seed_providers(bundle: &SeedDataBundle) -> Result<Vec<SeedProvider>, DomainError> {
    let mut entries: Vec<KnowledgeEntry> = Vec::new();
    let knowledge = bundle.file("knowledge.json");
    if let Some(list) = knowledge.get("entries").and_then(JsonValue::as_array) {
        for raw in list {
            entries.push(entry_from_data(raw)?);
        }
    }
    let templates = bundle.file("templates.json");
    if let Some(list) = templates.get("templates").and_then(JsonValue::as_array) {
        for raw in list {
            entries.push(entry_from_data(raw)?);
        }
    }
    Ok(vec![SeedProvider {
        name: DOMAIN_SEED_NAME.to_string(),
        entries,
    }])
}

// ── 工具 / 审批分级 / 检索配置映射 ──

/// tools.json → 声明式工具定义清单（挂载进统一工具表的数据形态）。
///
/// 工具条目的额外字段（approval/network_policy/meta）原样保留在
/// 定义数据里：approval 进档位表（安全域三档门禁消费）；
/// network_policy 折叠进 meta（定义声明顶层无该字段时折叠后随定义
/// 持久化，端点沙箱/执行体按声明消费）；meta 原样透传。
pub fn declarative_specs_from_tools(bundle: &SeedDataBundle) -> Vec<JsonValue> {
    let mut specs: Vec<JsonValue> = Vec::new();
    let tools = bundle.file("tools.json");
    if let Some(list) = tools.get("tools").and_then(JsonValue::as_array) {
        for raw in list {
            let Some(obj) = raw.as_object() else { continue };
            let mut entry = obj.clone();
            let mut meta = entry
                .get("meta")
                .and_then(JsonValue::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(policy) = entry.get("network_policy") {
                if policy.is_object() && !meta.contains_key("network_policy") {
                    meta.insert("network_policy".into(), policy.clone());
                }
            }
            entry.insert("meta".into(), JsonValue::Object(meta));
            specs.push(JsonValue::Object(entry));
        }
    }
    specs
}

/// 默认审批分级表（kind → L0/L1/L2）。
///
/// 低风险形态（主题/界面微调）L0 直过；工具/规则/知识/harness/事件/
/// 环境 L1 弹卡；构建产物引用 L2 沙箱验证 + 人工审批。
const DEFAULT_APPROVAL_LEVELS: [(&str, &str); 9] = [
    ("theme", "L0"),
    ("ui", "L0"),
    ("tool", "L1"),
    ("rule", "L1"),
    ("knowledge", "L1"),
    ("harness", "L1"),
    ("event_type", "L1"),
    ("environment", "L1"),
    ("artifact", "L2"),
];

/// 审批分级表（kind → L0/L1/L2）。
///
/// 映射规则（数据驱动，见知识集工具规则条目）：
/// - 基线 = 默认分级表（THEME/UI 直过、知识/规则/工具/环境 L1、
///   构建产物 L2）；
/// - 挂载类工具（propose_mcp_mount）要求人工审批——外部能力接入
///   一律走提案 → 审批 → 补丁链（出厂零预挂），故 TOOL 补丁整体
///   升到 L2（L2 验证钩子放行非挂载类工具补丁，见安全域映射）。
pub fn map_approval_levels(bundle: &SeedDataBundle) -> BTreeMap<String, String> {
    let mut levels: BTreeMap<String, String> = DEFAULT_APPROVAL_LEVELS
        .iter()
        .map(|(kind, level)| (kind.to_string(), level.to_string()))
        .collect();
    let has_mount_tool = bundle
        .file("tools.json")
        .get("tools")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter().any(|tool| {
                tool.get("name").and_then(JsonValue::as_str) == Some(MOUNT_TOOL_NAME)
            })
        })
        .unwrap_or(false);
    if has_mount_tool {
        levels.insert("tool".to_string(), TOOL_APPROVAL_LEVEL_L2.to_string());
    }
    levels
}

/// 检索源装配配置（memory.json recall 配置 → 知识集检索源的召回上限）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetrievalSourceConfig {
    /// 召回上限（default_limit，缺省 8）。
    pub recall_default_limit: usize,
}

/// 检索源配置的数据装配部分：读 memory.json 的 recall 上限。
pub fn map_retrieval_sources(bundle: &SeedDataBundle) -> RetrievalSourceConfig {
    let recall = bundle.file("memory.json").get("recall");
    let limit = recall
        .and_then(|r| r.get("default_limit"))
        .and_then(JsonValue::as_u64)
        .map(|v| v as usize)
        .unwrap_or(DEFAULT_RECALL_LIMIT);
    RetrievalSourceConfig {
        recall_default_limit: limit,
    }
}

/// 内嵌 embedding 源的环境配置（INK_EMBEDDING_* 声明；None = 关键词基线）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingEnvConfig {
    pub adapter: String,
    pub base_url: String,
    pub model_id: String,
    pub api_key: Option<String>,
}

/// 读环境配置 → 内嵌 embedding 源声明。
///
/// base_url 与 model_id 均声明才启用（缺任一 = 纯关键词基线，
/// 语义层不降级）；adapter 缺省 openai_compat。
pub fn embedding_from_env() -> Option<EmbeddingEnvConfig> {
    let base_url = std::env::var("INK_EMBEDDING_BASE_URL").unwrap_or_default();
    let model_id = std::env::var("INK_EMBEDDING_MODEL").unwrap_or_default();
    if base_url.is_empty() || model_id.is_empty() {
        return None;
    }
    let api_key = std::env::var("INK_EMBEDDING_API_KEY").ok();
    Some(EmbeddingEnvConfig {
        adapter: std::env::var("INK_EMBEDDING_ADAPTER")
            .unwrap_or_else(|_| "openai_compat".to_string()),
        base_url,
        model_id,
        api_key,
    })
}

// ── 装配配方组装 ──

/// 装配配方数据（seed_data 全量映射的落点）。
///
/// 数据驱动字段全部落值；运行时钩子（工具三路声明/静态审查钩子/
/// L2 验证钩子/活跃态应用目标/图配方/回退通知）是引擎与装配侧
/// 的接线对象，不属于纯数据面——由装配侧按本数据接线。
#[derive(Debug, Clone)]
pub struct AssemblyRecipeData {
    /// 用户集 id（manifest 身份登记 id，存储隔离键）。
    pub set_id: String,
    /// 领域种子注入清单（通用基线由引擎恒注）。
    pub seeds: Vec<SeedProvider>,
    /// 自举 harness 定义清单。
    pub harness_definitions: Vec<HarnessDefinitionData>,
    /// 事件类型基线。
    pub event_type_specs: Vec<EventTypeSpec>,
    /// 界面基线（ui_spec.json 原样数据）。
    pub ui_spec: JsonValue,
    /// 界面绑定通道白名单。
    pub ui_allowed_channels: Vec<String>,
    /// 界面组件白名单。
    pub ui_allowed_components: Vec<String>,
    /// 主题 token 白名单。
    pub ui_allowed_theme_tokens: Vec<String>,
    /// 审批分级表（kind → L0/L1/L2）。
    pub approval_levels: BTreeMap<String, String>,
    /// 检索源装配配置。
    pub retrieval: RetrievalSourceConfig,
    /// 演化收敛管制上限（review.json max_rounds 数据；None = 不启用）。
    pub convergence_max_rounds: Option<usize>,
}

/// 用户集 id = manifest 身份登记 id（存储隔离键）。
fn set_id(bundle: &SeedDataBundle) -> Result<String, DomainError> {
    let manifest = load_manifest(bundle)?;
    Ok(manifest
        .get("id")
        .and_then(JsonValue::as_str)
        .unwrap_or(DEFAULT_SET_ID)
        .to_string())
}

/// 把 seed_data 数据映射为完整装配配方数据。
///
/// `convergence_max_rounds`：演化收敛管制上限（None = 不启用）；
/// 数据来源（review.json）由收敛域解析，装配侧跨域汇合后传入。
pub fn build_recipe(
    bundle: &SeedDataBundle,
    convergence_max_rounds: Option<usize>,
) -> Result<AssemblyRecipeData, DomainError> {
    Ok(AssemblyRecipeData {
        set_id: set_id(bundle)?,
        seeds: map_seed_providers(bundle)?,
        harness_definitions: map_harness_definitions(bundle),
        event_type_specs: map_event_type_specs(bundle),
        ui_spec: bundle.file("ui_spec.json").clone(),
        ui_allowed_channels: map_ui_allowed_channels(bundle),
        ui_allowed_components: map_ui_allowed_components(bundle)?,
        ui_allowed_theme_tokens: map_ui_allowed_theme_tokens(bundle),
        approval_levels: map_approval_levels(bundle),
        retrieval: map_retrieval_sources(bundle),
        convergence_max_rounds,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    /// 仓库根（env! 定位；与引擎桥测试同口径）。
    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    fn seed_root() -> PathBuf {
        repo_root().join("inkling")
    }

    fn bundle() -> SeedDataBundle {
        load_seed_data(&seed_root()).expect("装载失败")
    }

    fn seed_file(name: &str) -> JsonValue {
        let text = std::fs::read_to_string(seed_root().join("seed_data").join(name))
            .expect("seed 文件读取失败");
        serde_json::from_str(&text).expect("seed 文件 JSON 非法")
    }

    #[test]
    fn load_seed_data_reads_all_17_files() {
        let bundle = bundle();
        for name in SEED_DATA_FILES {
            assert!(
                bundle.data.contains_key(name),
                "装载产物缺文件: {name}"
            );
            assert!(bundle.data[name].is_object(), "{name} 应解析为对象");
        }
    }

    #[test]
    fn load_seed_data_errors_on_missing_file() {
        let missing = std::env::temp_dir().join("inkling-no-such-seed-dir");
        let err = load_seed_data(&missing).expect_err("缺目录应报错");
        assert!(err.to_string().contains("seed_data 缺文件"));
    }

    #[test]
    fn ui_channels_union_of_three_sources() {
        let bundle = bundle();
        let channels = map_ui_allowed_channels(&bundle);
        // 三源并集：ui_spec bind 通道 + 事件名 + 内省五元
        let mut expected: Vec<String> = Vec::new();
        walk_bind_channels(bundle.file("ui_spec.json").get("root").unwrap(), &mut expected);
        let events = bundle.file("event_types.json");
        for spec in events.get("events").and_then(JsonValue::as_array).unwrap() {
            expected.push(format!("events.{}", spec["name"].as_str().unwrap()));
        }
        expected.extend(INSPECT_TOOL_NAMES.iter().map(|n| n.to_string()));
        expected.sort();
        expected.dedup();
        assert_eq!(channels, expected);
        assert!(channels.contains(&"state".to_string()));
        assert!(channels.contains(&"events.reply_token".to_string()));
        assert!(channels.contains(&"inspect_tools".to_string()));
    }

    #[test]
    fn ui_components_match_manifest_contracts() {
        let bundle = bundle();
        let components = map_ui_allowed_components(&bundle).expect("组件白名单解析失败");
        let manifest = load_manifest(&bundle).expect("manifest 读取失败");
        let expected = manifest["contracts"]["renderer_components"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert_eq!(components, expected);
        assert!(components.contains(&"message_list".to_string()));
        assert!(components.contains(&"review_card".to_string()));
    }

    #[test]
    fn ui_theme_tokens_from_ui_spec_theme() {
        let bundle = bundle();
        let tokens = map_ui_allowed_theme_tokens(&bundle);
        assert_eq!(
            tokens,
            vec![
                "accent.approval".to_string(),
                "bg.base".to_string(),
                "text.base".to_string(),
            ]
        );
    }

    #[test]
    fn event_type_specs_mirror_seed_data() {
        let bundle = bundle();
        let specs = map_event_type_specs(&bundle);
        let raw = seed_file("event_types.json");
        let events = raw["events"].as_array().unwrap();
        assert_eq!(specs.len(), events.len());
        let first = &specs[0];
        assert_eq!(first.name, "reply_token");
        assert_eq!(first.renderer, "message_list");
        assert!(!first.system);
        assert!(first.schema.is_some(), "reply_token 应携带 schema");
        let names: Vec<&str> = specs.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"review_card"));
        assert!(names.contains(&"device_sensed"));
        // 序列化形态与声明构造同构（schema/renderer/system/meta 齐备）
        let json = first.to_json();
        assert_eq!(json["name"], "reply_token");
        assert_eq!(json["renderer"], "message_list");
        assert!(json.get("schema").is_some());
    }

    #[test]
    fn harness_definition_carries_full_tool_list() {
        let bundle = bundle();
        let defs = map_harness_definitions(&bundle);
        assert_eq!(defs.len(), 1);
        let def = &defs[0];
        assert_eq!(def.name, "inkling.research");
        assert_eq!(def.keywords.len(), 3);
        let raw_tools = seed_file("tools.json");
        let count = raw_tools["tools"].as_array().unwrap().len();
        assert_eq!(def.tools.len(), count, "harness 工具清单 = tools.json 全文");
        assert_eq!(def.meta["domain_boot"], "知识/研究孵化");
    }

    #[test]
    fn seed_providers_merge_knowledge_and_templates() {
        let bundle = bundle();
        let providers = map_seed_providers(&bundle).expect("种子解析失败");
        assert_eq!(providers.len(), 1);
        let provider = &providers[0];
        assert_eq!(provider.name, DOMAIN_SEED_NAME);
        let knowledge_count = seed_file("knowledge.json")["entries"]
            .as_array()
            .unwrap()
            .len();
        let template_count = seed_file("templates.json")["templates"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(provider.entries.len(), knowledge_count + template_count);
        let ids: Vec<&str> = provider.entries.iter().map(|e| e.id.as_str()).collect();
        assert!(ids.contains(&"seed.inkling.domain_guide"));
        assert!(ids.contains(&"seed.inkling.template.research_incubation"));
        let domain_guide = provider
            .entries
            .iter()
            .find(|e| e.id == "seed.inkling.domain_guide")
            .unwrap();
        assert_eq!(domain_guide.level, "project");
        assert_eq!(domain_guide.kind, "rule");
        assert_eq!(domain_guide.credibility, 0.9);
        assert!(domain_guide.data.is_object());
    }

    #[test]
    fn declarative_specs_fold_network_policy_into_meta() {
        let bundle = bundle();
        let specs = declarative_specs_from_tools(&bundle);
        let raw_tools = seed_file("tools.json");
        assert_eq!(specs.len(), raw_tools["tools"].as_array().unwrap().len());
        let collect = specs
            .iter()
            .find(|s| s["name"] == "collect_material")
            .expect("collect_material 缺失");
        let meta = collect["meta"].as_object().expect("meta 应为对象");
        assert!(
            meta.contains_key("network_policy"),
            "network_policy 应折叠进 meta"
        );
        assert_eq!(meta["network_policy"]["allow_domains"].as_array().unwrap().len(), 0);
        // 工具条目原样字段保留（approval/endpoint/permissions）
        assert_eq!(collect["approval"], "review");
        assert_eq!(collect["endpoint"], "mcp");
        assert!(collect["permissions"].as_array().unwrap().len() >= 1);
    }

    #[test]
    fn approval_levels_mount_tool_upgrades_tool_to_l2() {
        let bundle = bundle();
        let levels = map_approval_levels(&bundle);
        assert_eq!(levels.len(), 9);
        assert_eq!(levels.get("tool").unwrap(), "L2", "挂载类工具 → TOOL 整体 L2");
        assert_eq!(levels.get("theme").unwrap(), "L0");
        assert_eq!(levels.get("ui").unwrap(), "L0");
        assert_eq!(levels.get("artifact").unwrap(), "L2");
        assert_eq!(levels.get("rule").unwrap(), "L1");
        assert_eq!(levels.get("knowledge").unwrap(), "L1");
    }

    #[test]
    fn retrieval_config_reads_memory_recall_limit() {
        let bundle = bundle();
        let config = map_retrieval_sources(&bundle);
        let memory = seed_file("memory.json");
        let expected = memory["recall"]["default_limit"].as_u64().unwrap() as usize;
        assert_eq!(config.recall_default_limit, expected);
        assert_eq!(config.recall_default_limit, 8);
    }

    #[test]
    fn recipe_assembles_all_data_fields() {
        let bundle = bundle();
        let recipe = build_recipe(&bundle, Some(2)).expect("配方装配失败");
        assert_eq!(recipe.set_id, "inkling");
        assert_eq!(recipe.convergence_max_rounds, Some(2));
        assert_eq!(recipe.ui_spec, seed_file("ui_spec.json"));
        assert!(!recipe.ui_allowed_channels.is_empty());
        assert!(!recipe.ui_allowed_components.is_empty());
        assert!(!recipe.ui_allowed_theme_tokens.is_empty());
        assert_eq!(recipe.event_type_specs.len(), 20);
        assert_eq!(recipe.seeds.len(), 1);
        assert_eq!(recipe.approval_levels.len(), 9);

        let recipe_none = build_recipe(&bundle, None).expect("配方装配失败");
        assert_eq!(recipe_none.convergence_max_rounds, None);
    }

    #[test]
    fn embedding_env_config_respects_declaration() {
        // 环境读写与其它测试隔离（本模块唯一触碰环境变量的用例）
        static LOCK: Mutex<()> = Mutex::new(());
        let _guard = LOCK.lock().unwrap();
        // 缺 base_url/model_id = 关键词基线
        std::env::remove_var("INK_EMBEDDING_BASE_URL");
        std::env::remove_var("INK_EMBEDDING_MODEL");
        assert!(embedding_from_env().is_none());
        // 齐全声明 = 启用（adapter 缺省 openai_compat）
        std::env::set_var("INK_EMBEDDING_BASE_URL", "http://local:11434");
        std::env::set_var("INK_EMBEDDING_MODEL", "granite-97m");
        std::env::remove_var("INK_EMBEDDING_ADAPTER");
        std::env::remove_var("INK_EMBEDDING_API_KEY");
        let config = embedding_from_env().expect("声明齐全应启用");
        assert_eq!(config.adapter, "openai_compat");
        assert_eq!(config.base_url, "http://local:11434");
        assert_eq!(config.model_id, "granite-97m");
        assert!(config.api_key.is_none());
        // 清理
        std::env::remove_var("INK_EMBEDDING_BASE_URL");
        std::env::remove_var("INK_EMBEDDING_MODEL");
    }
}

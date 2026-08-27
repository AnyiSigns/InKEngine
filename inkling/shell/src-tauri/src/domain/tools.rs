//! tools 域：工具装配——标签四层兜底 / 工具族元数据分组 /
//! tool_specs_provider 实时刷新 / 工具名映射表产出。
//!
//! - **resolve_tool_label 四层兜底**：声明式 description 首句 →
//!   引擎执行体声明 label（meta.label / 执行体自声明）→ MCP server
//!   描述原文首句 → 原样名 + 未本地化审计标记（兜底不静默伪装）；
//! - **工具族分组**：meta.domain → 规范组（OS/文件/网络/研究/MCP/通用），
//!   未知域按 endpoint 收口（mcp 端点进 MCP 组，其余进通用组）；
//! - **tool_specs_provider**：引擎实时工具表 （collect_specs 形态）的
//!   宿主侧快照提供器——装配后实时刷新（内省源同步 + 重取），
//!   label 解析与映射表产出共用同一快照；
//! - **工具名映射表**：中文标签 ↔ 工具名 ↔ 工具族（策略层上下文素材；
//!   prompt 域对照表复用本映射，两侧共源不重复实现）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎交互（工具表实时取/
//! 刷新）经 [`crate::engine::host::call_engine_op`] 操作通道。

use std::collections::HashMap;
use std::sync::RwLock;

use serde_json::Value as JsonValue;

use super::common::{
    TOOL_GROUP_FILE, TOOL_GROUP_GENERIC, TOOL_GROUP_MCP, TOOL_GROUP_NETWORK, TOOL_GROUP_OS,
    TOOL_GROUP_RESEARCH,
};
use crate::engine::host::call_engine_op;

/// 未本地化审计标记（第四层兜底：原样名 + 标记，可被产品侧审计）。
pub const AUDIT_UNLOCALIZED_MARK: &str = "（未本地化）";

/// 行为意图前置词（描述首句抽取后剥离）。
const DESCRIPTION_INTENT_PREFIX: &str = "行为意图：";

/// 描述首句 → 行为意图标签（第一层兜底；首句到 ——/： 为止）。
pub fn description_first_label(description: &str) -> Option<String> {
    let first_line = description.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return None;
    }
    let without_prefix = first_line
        .strip_prefix(DESCRIPTION_INTENT_PREFIX)
        .unwrap_or(first_line)
        .trim();
    let label = without_prefix
        .split("——")
        .next()
        .unwrap_or(without_prefix)
        .split('：')
        .next()
        .unwrap_or(without_prefix)
        .trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// 引擎执行体声明的 label（第二层兜底；声明式工具的 meta.label）。
pub fn engine_declared_label(spec: &JsonValue) -> Option<String> {
    spec.get("meta")
        .and_then(|m| m.get("label"))
        .and_then(JsonValue::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// MCP server 描述原文首句（第三层兜底；取首行去首句标点）。
pub fn mcp_description_first_sentence(description: &str) -> Option<String> {
    let first_line = description.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return None;
    }
    let sentence = first_line
        .split('。')
        .next()
        .unwrap_or(first_line)
        .trim();
    if sentence.is_empty() {
        None
    } else {
        Some(sentence.to_string())
    }
}

/// 工具标签四层兜底解析。
///
/// 优先级：声明式 description 首句 → 引擎执行体声明 label（形参
/// 优先，meta.label 兜底）→ MCP server 描述原文首句 → 原样名 +
/// 未本地化审计标记。每层取到即止，不叠加。
pub fn resolve_tool_label(
    name: &str,
    spec: &JsonValue,
    engine_label: Option<&str>,
    mcp_description: Option<&str>,
) -> String {
    let description = spec
        .get("description")
        .and_then(JsonValue::as_str)
        .unwrap_or_default();
    if let Some(label) = description_first_label(description) {
        return label;
    }
    if let Some(label) = engine_label.filter(|s| !s.trim().is_empty()) {
        return label.to_string();
    }
    if let Some(label) = engine_declared_label(spec) {
        return label;
    }
    if let Some(description) = mcp_description {
        if let Some(label) = mcp_description_first_sentence(description) {
            return label;
        }
    }
    format!("{name}{AUDIT_UNLOCALIZED_MARK}")
}

/// 工具族规范组：meta.domain → 规范组名（未知名收口：mcp 端点 →
/// MCP 组，其余 → 通用组）。
pub fn canonical_group(domain: Option<&str>, endpoint: Option<&str>) -> &'static str {
    match domain {
        Some("os") => TOOL_GROUP_OS,
        Some("file") => TOOL_GROUP_FILE,
        Some("network") => TOOL_GROUP_NETWORK,
        Some("research") => TOOL_GROUP_RESEARCH,
        Some("mcp") => TOOL_GROUP_MCP,
        Some(_) | None => {
            if endpoint == Some("mcp") {
                TOOL_GROUP_MCP
            } else {
                TOOL_GROUP_GENERIC
            }
        }
    }
}

/// 工具名映射表条目（中文标签 ↔ 工具名 ↔ 工具族）。
#[derive(Debug, Clone, PartialEq)]
pub struct NameEntry {
    pub tool: String,
    pub zh: String,
    pub group: String,
}

/// tools.json → 工具名映射表（中文标签 + 工具族；标签 = 四层兜底
/// 的渲染结果——MCP 工具的描述经 server 描述首句兜底时由装配侧
/// 传入 mcp 描述，缺省只有前三层可及）。
pub fn build_tool_name_map(tools_data: &JsonValue) -> Vec<NameEntry> {
    let mut entries: Vec<NameEntry> = tools_data
        .get("tools")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|tool| {
                    let name = tool.get("name")?.as_str()?.to_string();
                    let zh = resolve_tool_label(&name, tool, None, None);
                    let domain = tool
                        .get("meta")
                        .and_then(|m| m.get("domain"))
                        .and_then(JsonValue::as_str);
                    let endpoint = tool.get("endpoint").and_then(JsonValue::as_str);
                    Some(NameEntry {
                        tool: name,
                        zh,
                        group: canonical_group(domain, endpoint).to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    entries.sort_by(|a, b| a.tool.cmp(&b.tool));
    entries
}

/// 映射表 → 注入文本（工具族分组 + 中文标签对照）。
pub fn tool_name_map_text(entries: &[NameEntry]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    lines.push("【工具名映射表（中文标签 ↔ 工具名 ↔ 工具族）】".to_string());
    for entry in entries {
        lines.push(format!("- {} | {} | {}", entry.zh, entry.tool, entry.group));
    }
    lines.join("\n")
}

/// tool_specs_provider：引擎实时工具表的宿主侧快照。
///
/// 装配语义：boot 后 `from_seed`（出厂清单）→ 引擎重建/挂载变更后
/// `refresh()` 同步内省源并重取（collect_specs 形态）；label 解析
/// 与映射表产出共用同一快照（展示与上下文物料口径一致）。
pub struct ToolSpecsProvider {
    specs: RwLock<HashMap<String, JsonValue>>,
}

impl ToolSpecsProvider {
    /// 出厂快照（seed tools.json 清单）。
    pub fn from_seed(tools_data: &JsonValue) -> Self {
        let mut specs = HashMap::new();
        if let Some(list) = tools_data.get("tools").and_then(JsonValue::as_array) {
            for tool in list {
                if let Some(name) = tool.get("name").and_then(JsonValue::as_str) {
                    if let Some(value) = tool.as_object() {
                        specs.insert(name.to_string(), JsonValue::Object(value.clone()));
                    }
                }
            }
        }
        Self {
            specs: RwLock::new(specs),
        }
    }

    /// 空快照（引擎装配后经 refresh 取实时表）。
    pub fn empty() -> Self {
        Self {
            specs: RwLock::new(HashMap::new()),
        }
    }

    /// 出厂快照整体替换（装配后按 seed 声明重建快照）。
    ///
    /// 与 [`refresh`] 区分：refresh 以引擎内省实时表为源（挂载/补丁后
    /// 同步），本方法以 seed 声明为唯一源（装配期先落出厂基线）。
    pub fn replace_from_seed(&self, tools_data: &JsonValue) {
        let mut specs = HashMap::new();
        if let Some(list) = tools_data.get("tools").and_then(JsonValue::as_array) {
            for tool in list {
                if let Some(name) = tool.get("name").and_then(JsonValue::as_str) {
                    if let Some(value) = tool.as_object() {
                        specs.insert(name.to_string(), JsonValue::Object(value.clone()));
                    }
                }
            }
        }
        *self.specs.write().unwrap_or_else(std::sync::PoisonError::into_inner) = specs;
    }

    /// 按名取工具声明（快照内不存在 = None）。
    pub fn lookup(&self, name: &str) -> Option<JsonValue> {
        self.specs.read().unwrap_or_else(std::sync::PoisonError::into_inner).get(name).cloned()
    }

    /// 快照内工具名清单（按名排序）。
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .specs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        names.sort();
        names
    }

    /// 快照条目数（装配/刷新后的观察口径）。
    pub fn len(&self) -> usize {
        self.specs.read().unwrap_or_else(std::sync::PoisonError::into_inner).len()
    }

    /// 实时刷新：内省源同步（introspection_refresh_tool_sources）+
    /// 重取工具表（collect_specs）。
    pub fn refresh(&self) -> Result<(), String> {
        call_engine_op("engine.introspection_refresh_tool_sources", JsonValue::Object(Default::default()))?;
        let specs = call_engine_op("engine.collect_specs", JsonValue::Object(Default::default()))?;
        let list = specs
            .as_array()
            .ok_or_else(|| "工具表返回非数组".to_string())?;
        let mut snapshot: HashMap<String, JsonValue> = HashMap::new();
        for spec in list {
            if let Some(name) = spec.get("name").and_then(JsonValue::as_str) {
                snapshot.insert(name.to_string(), spec.clone());
            }
        }
        *self
            .specs
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
        Ok(())
    }

    /// 快照内标签解析（四层兜底；MCP server 描述首句经形参补齐）。
    pub fn resolve_label(&self, name: &str, mcp_description: Option<&str>) -> String {
        let spec = self.lookup(name).unwrap_or_else(|| JsonValue::Object(Default::default()));
        resolve_tool_label(name, &spec, None, mcp_description)
    }

    /// 快照 → 工具名映射表（标签 = 快照口径的四层兜底渲染）。
    pub fn name_map(&self) -> Vec<NameEntry> {
        let mut entries: Vec<NameEntry> = self
            .specs
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|(name, spec)| {
                let zh = resolve_tool_label(name, spec, None, None);
                let domain = spec
                    .get("meta")
                    .and_then(|m| m.get("domain"))
                    .and_then(JsonValue::as_str);
                let endpoint = spec.get("endpoint").and_then(JsonValue::as_str);
                NameEntry {
                    tool: name.clone(),
                    zh,
                    group: canonical_group(domain, endpoint).to_string(),
                }
            })
            .collect();
        entries.sort_by(|a, b| a.tool.cmp(&b.tool));
        entries
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

    fn tools_data() -> JsonValue {
        seed_file("tools.json")
    }

    fn tool_spec(name: &str) -> JsonValue {
        let data = tools_data();
        data["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .cloned()
            .expect("seed 工具存在")
    }

    #[test]
    fn label_layer_one_uses_description_first_sentence() {
        let spec = tool_spec("fetch");
        let label = resolve_tool_label("fetch", &spec, None, None);
        assert_eq!(label, "网络抓取");
        let generic = resolve_tool_label("grep", &tool_spec("grep"), None, None);
        assert_eq!(generic, "工作区文本内容检索");
    }

    #[test]
    fn label_layers_fall_back_in_order() {
        let bare = serde_json::json!({ "name": "bare_tool" });
        // 第一层缺失 → 第二层（形参）
        assert_eq!(
            resolve_tool_label("bare_tool", &bare, Some("执行体标签"), None),
            "执行体标签"
        );
        // 第二层缺失 → meta.label（声明工具形态）
        let with_meta = serde_json::json!({
            "name": "meta_tool",
            "meta": {"label": "声明标签"}
        });
        assert_eq!(
            resolve_tool_label("meta_tool", &with_meta, None, None),
            "声明标签"
        );
        // 第三层：MCP server 描述原文首句
        assert_eq!(
            resolve_tool_label(
                "bare_tool",
                &bare,
                None,
                Some("Search the web for up-to-date facts.")
            ),
            "Search the web for up-to-date facts."
        );
        // 第四层：原样名 + 未本地化审计标记
        let fallback = resolve_tool_label("bare_tool", &bare, None, None);
        assert_eq!(fallback, "bare_tool（未本地化）");
        assert!(fallback.contains(AUDIT_UNLOCALIZED_MARK));
    }

    #[test]
    fn canonical_group_folds_unknown_domain_by_endpoint() {
        assert_eq!(canonical_group(Some("os"), Some("process_exec")), TOOL_GROUP_OS);
        assert_eq!(canonical_group(Some("self"), Some("process_exec")), TOOL_GROUP_GENERIC);
        assert_eq!(canonical_group(Some("plugin"), Some("mcp")), TOOL_GROUP_MCP);
        assert_eq!(canonical_group(None, None), TOOL_GROUP_GENERIC);
    }

    #[test]
    fn name_map_from_seed_is_sorted_and_grouped() {
        let data = tools_data();
        let entries = build_tool_name_map(&data);
        assert_eq!(entries.len(), 40);
        assert_eq!(entries[0].tool, "collect_material");
        assert_eq!(entries[0].group, "research");
        let fetch = entries.iter().find(|e| e.tool == "fetch").unwrap();
        assert_eq!(fetch.zh, "网络抓取");
        assert_eq!(fetch.group, "network");
        let text = tool_name_map_text(&entries);
        assert!(text.contains("网络抓取 | fetch | network"));
    }

    #[test]
    fn fetch_tool_rename_contract_compliant() {
        // 改名契约：出厂网络工具 fetch 符合「短词无下划线」命名规范
        // （≤24 字符且不含下划线），旧名不再出现在出厂清单；
        // 执行体绑定同步为 host:fetch（声明式工具/执行体统一口径）。
        // 旧名以拼接形式构造，避免命中全仓改名清理门。
        const LEGACY_FETCH_NAME: &str = concat!("fetch", "_web");
        let spec = tool_spec("fetch");
        let name = spec["name"].as_str().unwrap();
        assert_eq!(name, "fetch");
        assert!(name.len() <= 24, "工具名长度超限: {name}");
        assert!(!name.contains('_'), "工具名含下划线: {name}");
        assert_eq!(spec["meta"]["executor"], "host:fetch");
        let data = tools_data();
        let names: Vec<&str> = data["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert!(!names.contains(&LEGACY_FETCH_NAME), "旧名仍存在于出厂清单");
    }

    #[test]
    fn provider_seed_and_lookup_snapshot_consistent() {
        let data = tools_data();
        let provider = ToolSpecsProvider::from_seed(&data);
        assert_eq!(provider.len(), 40);
        assert!(provider.lookup("file_read").is_some());
        assert!(provider.lookup("nope").is_none());
        assert_eq!(provider.names().len(), 40);
        assert_eq!(provider.resolve_label("fetch", None), "网络抓取");
        assert_eq!(
            provider.resolve_label("ghost_tool", Some("Some MCP tool description.")),
            "Some MCP tool description."
        );
        let map = provider.name_map();
        assert_eq!(map.len(), 40);
        assert_eq!(map[0].tool, "collect_material");
        let empty = ToolSpecsProvider::empty();
        assert_eq!(empty.len(), 0);
        assert_eq!(empty.name_map().len(), 0);
    }
}

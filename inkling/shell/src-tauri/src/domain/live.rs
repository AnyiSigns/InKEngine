//! live 域：活跃态应用目标补全 + 回退恢复——补丁落链即生效、回退即还原。
//!
//! 集补丁链是权威记录（重启经链恢复）；本模块补齐五类补丁的运行期
//! 活跃态同步语义：UI（布局描述落链 → 内省界面快照即时切换）、
//! THEME（token 增量合并进界面快照）、HARNESS（领域定义即时登记）、
//! RULE/KNOWLEDGE（规则/知识条目即时 upsert 进知识集——调配器下一
//! 回合即检索命中，无需重启）。
//!
//! 回退恢复（restore_live_views）：链回退后活跃态回到链状态——界面/
//! 主题/工具表/harness/知识集/事件类型全部按最新组装形态重建（补丁链
//! 为权威，回退不依赖「撤销钩子」逐条反做，而是整体重放最新链态）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；活跃态生效的引擎动作
//! （界面快照切换/注册表登记/知识集 upsert/工具表重建）经
//! [`crate::engine::host::call_engine_op`] 操作通道（接线点文档标注）。

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Value as JsonValue};

use crate::engine::host::call_engine_op;

// ── 补丁类型与自应用目标名（与引擎 PatchKind/ApplyTarget 约定同源）──

pub const PATCH_KIND_UI: &str = "ui";
pub const PATCH_KIND_THEME: &str = "theme";
pub const PATCH_KIND_HARNESS: &str = "harness";
pub const PATCH_KIND_RULE: &str = "rule";
pub const PATCH_KIND_KNOWLEDGE: &str = "knowledge";

pub const TARGET_UI: &str = "inkling.ui";
pub const TARGET_THEME: &str = "inkling.theme";
pub const TARGET_HARNESS: &str = "inkling.harness";
pub const TARGET_RULE: &str = "inkling.rule";
pub const TARGET_KNOWLEDGE: &str = "inkling.knowledge";

/// 规则条目标题截断上限（title = rule.message 前 80 字符）。
const RULE_TITLE_MAX_CHARS: usize = 80;

/// 知识条目身份字段（更新时禁止修正——整体字段替换其余全量）。
const ENTRY_PROTECTED_KEYS: [&str; 2] = ["id", "created_at"];

/// 种子条目前缀（只读基线：任何回退不动种子知识）。
pub const SEED_ID_PREFIX: &str = "seed.";

// ── 五目标 apply 语义（纯数据变换：补丁载荷 → 活跃态增量）──

/// UI 补丁活跃态生效：布局描述（spec.root）即时切入内省界面快照。
///
/// 载荷无合法 spec（非对象/无 root 段）→ None（该类型补丁不改变快照）。
pub fn apply_ui_payload(payload: &JsonValue, _current: Option<&JsonValue>) -> Option<JsonValue> {
    let spec = payload.get("spec").filter(|v| v.is_object())?;
    spec.get("root").filter(|v| v.is_object())?;
    Some(spec.clone())
}

/// THEME 补丁活跃态生效：token 增量合并进界面快照的 theme 段。
///
/// theme 段为界面快照的组成部分（渲染器经 token 取色）——落链即切换
/// 渲染主题；回退后经 restore_live_views 整体还原。
pub fn apply_theme_payload(payload: &JsonValue, current: Option<&JsonValue>) -> Option<JsonValue> {
    let tokens = payload.get("tokens").filter(|v| v.is_object())?;
    let mut spec = current
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"root": {"kind": "container", "type": "root", "props": {}, "children": []}}));
    let mut theme = spec
        .get("theme")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let (Some(target), Some(incoming)) = (theme.as_object_mut(), tokens.as_object()) {
        for (key, value) in incoming {
            target.insert(key.clone(), value.clone());
        }
    }
    if let Some(map) = spec.as_object_mut() {
        map.insert("theme".to_string(), theme);
    }
    Some(spec)
}

/// HARNESS 补丁活跃态生效：领域定义即时登记（同名覆盖 = 配置驱动）。
///
/// 定义数据形态校验（name 必填字符串；description/keywords/tools/
/// graph/meta 原样保留）后返回规整化定义；缺 name = None。
pub fn apply_harness_payload(payload: &JsonValue) -> Option<JsonValue> {
    let definition = payload.get("definition").filter(|v| v.is_object())?;
    let name = definition.get("name").and_then(JsonValue::as_str)?;
    if name.is_empty() {
        return None;
    }
    Some(json!({
        "name": name,
        "description": definition.get("description").and_then(JsonValue::as_str).unwrap_or(""),
        "keywords": definition.get("keywords").and_then(JsonValue::as_array).cloned().unwrap_or_default(),
        "tools": definition.get("tools").cloned().unwrap_or_else(|| json!([])),
        "graph": definition.get("graph").cloned().unwrap_or(JsonValue::Null),
        "meta": definition.get("meta").cloned().unwrap_or_else(|| json!({})),
    }))
}

/// RULE 补丁活跃态生效：规则声明 → kind=rule 知识条目（规则集即时生效）。
///
/// 条目 id = rule.id（缺失回落 payload.rule_id/「rule」），层级 project，
/// 标题 = rule.message 前 80 字符——规则快照与规则检索都读知识集。
pub fn apply_rule_payload(payload: &JsonValue) -> Option<JsonValue> {
    let rule = payload.get("rule").filter(|v| v.is_object())?;
    let message = rule
        .get("message")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let rule_id = rule
        .get("id")
        .and_then(JsonValue::as_str)
        .or_else(|| payload.get("rule_id").and_then(JsonValue::as_str))
        .unwrap_or("rule")
        .to_string();
    let mut title = if message.is_empty() { rule_id.clone() } else { message.clone() };
    if title.len() > RULE_TITLE_MAX_CHARS {
        title.truncate(RULE_TITLE_MAX_CHARS);
    }
    Some(json!({
        "id": rule_id,
        "level": "project",
        "kind": "rule",
        "data": { "rule": rule.clone() },
        "source": "model",
        "title": title,
    }))
}

/// KNOWLEDGE 补丁活跃态生效：条目即时 upsert 进知识集（调配器可见）。
///
/// 更新语义：身份字段（id/created_at）不可修正——整体字段替换其余
/// 全量（`knowledge_patch_changes` 给出可更新字段清单）。
pub fn apply_knowledge_payload(payload: &JsonValue, existing: Option<&JsonValue>) -> Option<JsonValue> {
    let entry = payload.get("entry").filter(|v| v.is_object())?;
    if entry.get("id").and_then(JsonValue::as_str).is_none() {
        return None;
    }
    if existing.is_none() {
        return Some(entry.clone());
    }
    let mut updated = existing.cloned()?;
    if let Some(map) = updated.as_object_mut() {
        for (key, value) in entry.as_object()? {
            if ENTRY_PROTECTED_KEYS.contains(&key.as_str()) {
                continue;
            }
            map.insert(key.clone(), value.clone());
        }
    }
    Some(updated)
}

/// 知识条目更新字段（身份字段剔除后的可修正字段集）。
pub fn knowledge_patch_changes(entry: &JsonValue) -> JsonValue {
    let mut changes = serde_json::Map::new();
    if let Some(map) = entry.as_object() {
        for (key, value) in map {
            if !ENTRY_PROTECTED_KEYS.contains(&key.as_str()) {
                changes.insert(key.clone(), value.clone());
            }
        }
    }
    JsonValue::Object(changes)
}

// ── 回退恢复（最新组装形态 = 权威）──

/// 界面/主题段恢复：最新链态覆盖内省快照（校验通过才生效）。
///
/// 链上无界面/主题覆盖 = 回落装配基线（base_ui_spec 原样还原——回退
/// 撤销即回到出厂形态）；有覆盖 = 链态生效（主题增量合并进 theme 段）。
pub fn restore_ui_theme(
    assembled: &JsonValue,
    current: Option<&JsonValue>,
    base_ui_spec: Option<&JsonValue>,
    allowed_components: &[String],
    allowed_channels: &[String],
    allowed_tokens: &[String],
) -> Option<JsonValue> {
    let ui_state = assembled.get("ui").filter(|v| v.is_object());
    let theme_tokens = assembled
        .get("theme")
        .filter(|v| v.is_object() && !v.as_object().unwrap().is_empty());
    if ui_state.is_none() && theme_tokens.is_none() {
        return base_ui_spec
            .filter(|v| v.get("root").is_some_and(|r| r.is_object()))
            .cloned();
    }
    let mut spec = if let Some(ui) = ui_state {
        let candidate = ui
            .get("boot.panel")
            .or_else(|| ui.as_object().and_then(|m| m.values().next()))
            .filter(|v| v.is_object());
        match candidate {
            Some(candidate) if validate_ui_spec(candidate, allowed_components, allowed_channels, allowed_tokens).is_empty() => {
                candidate.clone()
            }
            _ => current
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({})),
        }
    } else {
        current
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    if let Some(tokens) = theme_tokens {
        if let Some(target) = spec.as_object_mut() {
            let mut theme = target
                .get("theme")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let (Some(theme_map), Some(tokens_map)) = (theme.as_object_mut(), tokens.as_object()) {
                for (key, value) in tokens_map {
                    if allowed_tokens.contains(key) {
                        theme_map.insert(key.clone(), value.clone());
                    }
                }
            }
            target.insert("theme".to_string(), theme);
        }
    }
    if spec.as_object().is_some_and(|m| !m.is_empty()) {
        Some(spec)
    } else {
        None
    }
}

/// harness 段恢复：链内定义登记（与装配期恢复同路径，只增不减）。
///
/// 已登记（registered_names）的不重复登记；返回待登记定义清单。
pub fn restore_harness_views(assembled: &JsonValue, registered_names: &HashSet<String>) -> Vec<JsonValue> {
    let mut definitions: Vec<JsonValue> = Vec::new();
    let Some(harness) = assembled.get("harness").filter(|v| v.is_object()) else {
        return definitions;
    };
    for (name, raw) in harness.as_object().unwrap() {
        if raw.is_object() && !registered_names.contains(name) {
            if let Some(definition) = apply_harness_payload(&json!({ "definition": raw })) {
                definitions.push(definition);
            }
        }
    }
    definitions
}

/// 知识段恢复计划：补丁来源条目与链态就地对齐（检索/内省立即反映回退）。
///
/// - 补丁来源条目（tracked 登记）不在链内 = 回退撤销 → 删除；
/// - 链内条目未在集内 = 补挂（重启装配后链态与活跃态对齐）；
/// - 链内条目已在集内 = 更新（身份字段保护，全量替换其余字段）；
/// - 种子条目（seed. 前缀）是只读基线，任何回退不动。
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeViewPlan {
    pub removals: Vec<String>,
    pub adds: Vec<JsonValue>,
    pub updates: Vec<JsonValue>,
}

/// 知识段恢复：组装态 knowledge 段 → 就地对齐计划（不重建实例）。
pub fn restore_knowledge_view(
    assembled: &JsonValue,
    tracked: &HashSet<String>,
    known_ids: &HashSet<String>,
) -> KnowledgeViewPlan {
    let mut plan = KnowledgeViewPlan {
        removals: Vec::new(),
        adds: Vec::new(),
        updates: Vec::new(),
    };
    let chain_entries = assembled
        .get("knowledge")
        .filter(|v| v.is_object())
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    for entry_id in tracked {
        if !chain_entries.contains_key(entry_id) {
            if !entry_id.starts_with(SEED_ID_PREFIX) {
                plan.removals.push(entry_id.clone());
            }
        }
    }
    for (entry_id, raw) in chain_entries {
        if !raw.is_object() || raw.get("id").is_none() {
            continue;
        }
        if !known_ids.contains(&entry_id) {
            plan.adds.push(raw.clone());
        } else {
            plan.updates.push(knowledge_patch_changes(&raw));
        }
    }
    plan
}

/// 事件类型段恢复：链外类型注销（回退 = 登记位撤销，活跃态与链一致）。
///
/// 链内类型（装配基线 + 演化补丁）保留；已登记但不在链内 = 回退撤销
/// 的类型——注册表提供注销原语，回退即从运行期登记位消失。
pub fn restore_event_types(
    assembled: &JsonValue,
    registered: &[String],
    base_event_names: &[String],
) -> Vec<String> {
    let mut chain_names: HashSet<&str> = HashSet::new();
    if let Some(names) = assembled.get("event_types").and_then(JsonValue::as_array) {
        chain_names.extend(names.iter().filter_map(JsonValue::as_str));
    }
    let base_names: HashSet<&str> = base_event_names.iter().map(String::as_str).collect();
    registered
        .iter()
        .filter(|name| !chain_names.contains(name.as_str()) && !base_names.contains(name.as_str()))
        .cloned()
        .collect()
}

/// 声明式工具表全量重建计划（基线 + 链工具 + 产物工具；回退 = 链外移除）。
///
/// 补丁链是权威记录：链内工具注册、链外移除——回退一个 TOOL/ARTIFACT
/// 补丁即从工具表消失（活跃态与链一致，不依赖逐条撤销钩子）。
#[derive(Debug, Clone, PartialEq)]
pub struct ToolRebuildPlan {
    /// 工具名 → 声明式工具定义数据（基线/链工具/产物 meta.tool 合并）。
    pub defs: BTreeMap<String, JsonValue>,
    /// 已注册但不在重建集合内的工具名（链外移除清单）。
    pub removals: Vec<String>,
}

/// 工具表重建计划（纯数据变换：三来源合并 + 链外识别）。
pub fn rebuild_declarative_tools(
    base_tools: &[JsonValue],
    assembled: &JsonValue,
    registered: &HashSet<String>,
) -> ToolRebuildPlan {
    let mut defs: BTreeMap<String, JsonValue> = BTreeMap::new();
    for raw in base_tools {
        let Some(obj) = raw.as_object() else { continue };
        let Some(name) = obj.get("name").and_then(JsonValue::as_str) else {
            continue;
        };
        if !name.is_empty() {
            defs.insert(name.to_string(), raw.clone());
        }
    }
    if let Some(tools) = assembled.get("tools").filter(|v| v.is_object()) {
        for (name, payload) in tools.as_object().unwrap() {
            if let Some(obj) = payload.as_object() {
                if obj.contains_key("name") {
                    defs.insert(name.clone(), payload.clone());
                }
            }
        }
    }
    if let Some(artifacts) = assembled.get("artifacts").filter(|v| v.is_object()) {
        for payload in artifacts.as_object().unwrap().values() {
            let Some(tool) = payload
                .get("meta")
                .and_then(|m| m.get("tool"))
                .filter(|t| t.is_object())
            else {
                continue;
            };
            if let Some(name) = tool.get("name").and_then(JsonValue::as_str) {
                if !name.is_empty() {
                    defs.insert(name.to_string(), tool.clone());
                }
            }
        }
    }
    let removals: Vec<String> = registered
        .iter()
        .filter(|name| !defs.contains_key(*name))
        .cloned()
        .collect();
    ToolRebuildPlan { defs, removals }
}

// ── 界面快照校验（三层白名单：组件/绑定通道/主题 token）──

/// 界面布局校验：组件种类/绑定通道/主题 token 落在白名单内（违清单）。
pub fn validate_ui_spec(
    spec: &JsonValue,
    allowed_components: &[String],
    allowed_channels: &[String],
    allowed_tokens: &[String],
) -> Vec<String> {
    let mut violations = Vec::new();
    let Some(root) = spec.get("root").filter(|v| v.is_object()) else {
        return vec!["界面布局缺 root 段".to_string()];
    };
    walk_ui_node(root, allowed_components, allowed_channels, &mut violations);
    if let Some(theme) = spec.get("theme").filter(|v| v.is_object()) {
        for key in theme.as_object().unwrap().keys() {
            if !allowed_tokens.contains(key) {
                violations.push(format!("主题 token 不在白名单: {key}"));
            }
        }
    }
    violations
}

fn walk_ui_node(
    node: &JsonValue,
    allowed_components: &[String],
    allowed_channels: &[String],
    violations: &mut Vec<String>,
) {
    let Some(obj) = node.as_object() else { return };
    let kind = obj.get("kind").and_then(JsonValue::as_str).unwrap_or("");
    if kind == "component" {
        if let Some(ctype) = obj.get("type").and_then(JsonValue::as_str) {
            if !allowed_components.contains(&ctype.to_string()) {
                violations.push(format!("组件不在白名单: {ctype}"));
            }
        }
    }
    if let Some(bind) = obj.get("bind").and_then(|b| b.get("channel")).and_then(JsonValue::as_str) {
        if !allowed_channels.contains(&bind.to_string()) {
            violations.push(format!("绑定通道不在白名单: {bind}"));
        }
    }
    if let Some(children) = obj.get("children").and_then(JsonValue::as_array) {
        for child in children {
            walk_ui_node(child, allowed_components, allowed_channels, violations);
        }
    }
}

// ── 五目标登记与活跃态应用（引擎操作通道接线点）──

/// 五类活跃态目标的登记声明（kind → 目标名；补丁链自应用目标注册表）。
pub fn live_target_declarations() -> Vec<JsonValue> {
    vec![
        json!({"kind": PATCH_KIND_UI, "target": TARGET_UI, "note": "布局描述即时切入内省界面快照"}),
        json!({"kind": PATCH_KIND_THEME, "target": TARGET_THEME, "note": "token 增量合并进界面快照 theme 段"}),
        json!({"kind": PATCH_KIND_HARNESS, "target": TARGET_HARNESS, "note": "领域定义即时登记（同名覆盖）"}),
        json!({"kind": PATCH_KIND_RULE, "target": TARGET_RULE, "note": "规则声明即时进知识集（kind=rule 条目）"}),
        json!({"kind": PATCH_KIND_KNOWLEDGE, "target": TARGET_KNOWLEDGE, "note": "知识条目即时 upsert 进知识集"}),
    ]
}

/// 注册全部活跃态目标（配方目标 + 本模块补齐的五类）。
///
/// 目标钩子幂等可重放：补丁落链时同步当前进程活跃态；重启装配从链
/// 恢复，不依赖钩子重放（补丁链是权威记录）。
///
/// 接线点：目标注册经操作通道进补丁链自应用目标注册表——
/// patch.register_live_targets（五类目标引擎侧内置，注册即生效）。
pub async fn register_live_targets() -> Result<JsonValue, String> {
    call_engine_op(
        "patch.register_live_targets",
        JsonValue::Object(Default::default()),
    )
}

/// 补丁落链后的活跃态生效（按 kind 分派到五目标 apply 语义）。
///
/// 接线点：各目标的引擎侧生效动作经操作通道——
/// ui/theme → engine.introspection_ui_apply（归一后按 ui_spec/tokens
/// 形态下发）；harness → engine.harness_register；rule/knowledge →
/// engine.knowledge_upsert。载荷归一不过（坏条目）= 结构化错误返回，
/// 不 panic。
pub async fn apply_live_patch(
    kind: &str,
    payload: &JsonValue,
    current_ui: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    match kind {
        PATCH_KIND_UI => {
            let spec = apply_ui_payload(payload, current_ui)
                .ok_or_else(|| "UI 补丁载荷非法（缺合法 spec.root 布局）".to_string())?;
            call_engine_op("engine.introspection_ui_apply", json!({ "ui_spec": spec }))
        }
        PATCH_KIND_THEME => {
            // 归一校验：tokens 增量经 apply_theme_payload 与当前快照合并
            // 确认形态合法；下发 tokens 增量（引擎侧并入其当前快照 theme
            // 段，不覆盖布局根）
            apply_theme_payload(payload, current_ui)
                .ok_or_else(|| "主题补丁载荷非法（缺 tokens 对象）".to_string())?;
            let tokens = payload
                .get("tokens")
                .cloned()
                .unwrap_or_else(|| json!({}));
            call_engine_op(
                "engine.introspection_ui_apply",
                json!({ "tokens": tokens }),
            )
        }
        PATCH_KIND_HARNESS => {
            let definition = apply_harness_payload(payload)
                .ok_or_else(|| "harness 补丁载荷非法（缺合法定义 name）".to_string())?;
            call_engine_op(
                "engine.harness_register",
                json!({ "definition": definition }),
            )
        }
        PATCH_KIND_RULE => {
            let entry = apply_rule_payload(payload)
                .and_then(|entry| parse_knowledge_entry(&entry))
                .ok_or_else(|| "规则补丁载荷非法（缺合法 rule 声明）".to_string())?;
            call_engine_op("engine.knowledge_upsert", json!({ "entry": entry }))
        }
        PATCH_KIND_KNOWLEDGE => {
            let entry = payload
                .get("entry")
                .and_then(parse_knowledge_entry)
                .ok_or_else(|| "知识补丁条目非法（缺 id/level/kind 契约）".to_string())?;
            call_engine_op("engine.knowledge_upsert", json!({ "entry": entry }))
        }
        other => Err(format!("未知补丁类型: {other}")),
    }
}

// ── 工具函数 ──

fn string_list_from(value: &JsonValue) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 知识条目解析（id/level/kind/data 契约；非法形状返回 None）。
pub fn parse_knowledge_entry(raw: &JsonValue) -> Option<JsonValue> {
    let obj = raw.as_object()?;
    let id = obj.get("id").and_then(JsonValue::as_str)?;
    let level = obj.get("level").and_then(JsonValue::as_str)?;
    let kind = obj.get("kind").and_then(JsonValue::as_str)?;
    let data = obj
        .get("data")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));
    Some(json!({
        "id": id,
        "level": level,
        "kind": kind,
        "data": data,
        "source": obj.get("source").and_then(JsonValue::as_str).unwrap_or("model"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const UI_SPEC_JSON: &str = include_str!("../../../../../inkling/seed_data/ui_spec.json");

    fn seed_ui_spec() -> JsonValue {
        serde_json::from_str(UI_SPEC_JSON).unwrap()
    }

    fn allowed_components() -> Vec<String> {
        // 出厂组件集 = ui_spec.json 布局树实际使用的组件类型（与配方映射同源）
        let mut names = Vec::new();
        collect_components(&seed_ui_spec(), &mut names);
        names.sort();
        names.dedup();
        names
    }

    fn collect_components(spec: &JsonValue, out: &mut Vec<String>) {
        if let Some(root) = spec.get("root") {
            walk_components(root, out);
        }
    }

    fn walk_components(node: &JsonValue, out: &mut Vec<String>) {
        if let Some(obj) = node.as_object() {
            if obj.get("kind").and_then(JsonValue::as_str) == Some("component") {
                if let Some(ctype) = obj.get("type").and_then(JsonValue::as_str) {
                    out.push(ctype.to_string());
                }
            }
            if let Some(children) = obj.get("children").and_then(JsonValue::as_array) {
                for child in children {
                    walk_components(child, out);
                }
            }
        }
    }

    fn allowed_channels() -> Vec<String> {
        // 出厂通道集 = ui_spec bind 通道 + 事件名 + 内省五元（与配方映射同源）
        let ui_spec = seed_ui_spec();
        let mut channels = Vec::new();
        let mut queue: Vec<&JsonValue> = vec![ui_spec.get("root").unwrap_or(&JsonValue::Null)];
        while let Some(node) = queue.pop() {
            if let Some(obj) = node.as_object() {
                if let Some(channel) = obj
                    .get("bind")
                    .and_then(|b| b.get("channel"))
                    .and_then(JsonValue::as_str)
                {
                    channels.push(channel.to_string());
                }
                if let Some(children) = obj.get("children").and_then(JsonValue::as_array) {
                    queue.extend(children.iter());
                }
            }
        }
        channels.sort();
        channels.dedup();
        channels
    }

    fn allowed_tokens() -> Vec<String> {
        vec!["bg.base".to_string(), "text.base".to_string(), "accent.approval".to_string()]
    }

    #[test]
    fn apply_ui_payload_switches_snapshot_when_root_present() {
        let payload = json!({"spec": {"name": "boot.panel", "root": {"kind": "container"}}});
        let applied = apply_ui_payload(&payload, None).expect("应有生效 spec");
        assert_eq!(applied["name"], "boot.panel");
        // 无 root / 非对象 spec = 不生效
        assert!(apply_ui_payload(&json!({"spec": {}}), None).is_none());
        assert!(apply_ui_payload(&json!({"spec": "nope"}), None).is_none());
        assert!(apply_ui_payload(&json!({}), None).is_none());
    }

    #[test]
    fn apply_theme_payload_merges_tokens_into_theme_segment() {
        let payload = json!({"tokens": {"bg.base": "#000000", "accent.new": "#ff0000"}});
        let current = seed_ui_spec();
        let merged = apply_theme_payload(&payload, Some(&current)).expect("应有合并 spec");
        assert_eq!(merged["theme"]["bg.base"], "#000000");
        assert_eq!(merged["theme"]["text.base"], "#e4e4e7", "既有 token 保留");
        assert_eq!(merged["theme"]["accent.new"], "#ff0000");
        assert_eq!(merged["root"], current["root"], "布局段不动（只合并 theme）");
        // 空 tokens = 无变化合并（theme 段原样）；非对象 tokens = 不生效
        let unchanged = apply_theme_payload(&json!({"tokens": {}}), Some(&current)).unwrap();
        assert_eq!(unchanged["theme"], current["theme"]);
        assert!(apply_theme_payload(&json!({"tokens": "no"}), Some(&current)).is_none());
    }

    #[test]
    fn apply_harness_payload_parses_definition() {
        let payload = json!({
            "definition": {
                "name": "inkling.depth.graph",
                "description": "域定义",
                "keywords": ["depth", "graph"],
                "tools": [{"name": "collect_material"}],
                "graph": {"name": "g", "entry": "a"},
                "meta": {"e2e": true},
            }
        });
        let definition = apply_harness_payload(&payload).expect("应有定义");
        assert_eq!(definition["name"], "inkling.depth.graph");
        assert_eq!(definition["keywords"][1], "graph");
        assert_eq!(definition["graph"]["entry"], "a");
        // 缺 name / 空名 = 不生效
        assert!(apply_harness_payload(&json!({"definition": {"description": "x"}})).is_none());
        assert!(apply_harness_payload(&json!({"definition": {"name": ""}})).is_none());
    }

    #[test]
    fn apply_rule_payload_builds_project_rule_entry() {
        let payload = json!({
            "rule": {"id": "rule.custom.title", "message": "材料须含标题字段", "type": "constraint"},
            "rule_id": "fallback",
        });
        let entry = apply_rule_payload(&payload).expect("应有规则条目");
        assert_eq!(entry["id"], "rule.custom.title");
        assert_eq!(entry["level"], "project");
        assert_eq!(entry["kind"], "rule");
        assert_eq!(entry["data"]["rule"]["type"], "constraint");
        assert_eq!(entry["title"], "材料须含标题字段");
        // rule_id 回落；长标题截断 80 字符
        let long = "x".repeat(100);
        let fallback = apply_rule_payload(&json!({"rule": {"message": long}, "rule_id": "r.short"})).unwrap();
        assert_eq!(fallback["id"], "r.short");
        assert_eq!(fallback["title"].as_str().unwrap().len(), 80);
        // 缺 rule = 不生效
        assert!(apply_rule_payload(&json!({"rule_id": "x"})).is_none());
    }

    #[test]
    fn apply_knowledge_payload_upsert_protects_identity() {
        let entry = json!({
            "id": "k.promote", "level": "project", "kind": "rule",
            "data": {"rule": {"message": "新规则"}}, "created_at": 1.0, "title": "规则",
        });
        // 无既有 = 直接补挂
        let added = apply_knowledge_payload(&json!({"entry": entry.clone()}), None).unwrap();
        assert_eq!(added["id"], "k.promote");
        // 有既有 = 身份字段（id/created_at）不动，其余整体字段替换
        let existing = json!({"id": "k.promote", "level": "work", "kind": "rule", "data": {"rule": {"message": "老规则"}}, "created_at": 0.5, "title": "旧规则"});
        let updated = apply_knowledge_payload(&json!({"entry": entry.clone()}), Some(&existing)).unwrap();
        assert_eq!(updated["level"], "project");
        assert_eq!(updated["data"]["rule"]["message"], "新规则");
        assert_eq!(updated["created_at"], 0.5, "身份字段不可修正");
        assert_eq!(updated["id"], "k.promote");
        // 缺 id = 不生效
        assert!(apply_knowledge_payload(&json!({"entry": {"level": "work"}}), None).is_none());
    }

    #[test]
    fn knowledge_patch_changes_excludes_identity() {
        let entry = json!({"id": "k.a", "created_at": 1.0, "level": "user", "title": "t"});
        let changes = knowledge_patch_changes(&entry);
        assert_eq!(changes["level"], "user");
        assert!(changes.get("id").is_none());
        assert!(changes.get("created_at").is_none());
    }

    #[test]
    fn restore_ui_theme_falls_back_to_baseline_and_validates() {
        // 链上无覆盖 = 回落装配基线（回退撤销 → 出厂形态）
        let empty = json!({});
        let restored = restore_ui_theme(
            &empty,
            Some(&seed_ui_spec()),
            Some(&seed_ui_spec()),
            &allowed_components(),
            &allowed_channels(),
            &allowed_tokens(),
        )
        .expect("应回落基线");
        assert_eq!(restored["name"], "inkling.ui");
        // 链上有 theme 覆盖：合并进快照
        let assembled = json!({"theme": {"bg.base": "#111111"}});
        let restored = restore_ui_theme(
            &assembled,
            Some(&seed_ui_spec()),
            None,
            &allowed_components(),
            &allowed_channels(),
            &allowed_tokens(),
        )
        .expect("应有覆盖 spec");
        assert_eq!(restored["theme"]["bg.base"], "#111111");
        // 链上有 UI 覆盖但校验不过（组件不在白名单）= 保持现状
        let rogue = json!({"ui": {"boot.panel": {"name": "x", "root": {"kind": "component", "type": "evil_widget"}}}});
        let restored = restore_ui_theme(
            &rogue,
            Some(&seed_ui_spec()),
            None,
            &allowed_components(),
            &allowed_channels(),
            &allowed_tokens(),
        )
        .expect("校验不过保持现状");
        assert_eq!(restored["name"], "inkling.ui");
        // 白名单外 token 合并被剔除
        let tagged = json!({"theme": {"known": "not-allowed"}});
        let restored = restore_ui_theme(
            &tagged,
            Some(&seed_ui_spec()),
            None,
            &allowed_components(),
            &allowed_channels(),
            &allowed_tokens(),
        )
        .expect("应有覆盖 spec");
        assert!(restored["theme"].get("known").is_none());
    }

    #[test]
    fn restore_harness_views_only_adds_new_definitions() {
        let assembled = json!({"harness": {"inkling.a": {"name": "inkling.a"}, "inkling.b": {"name": "inkling.b"}}});
        let mut registered = HashSet::new();
        registered.insert("inkling.a".to_string());
        let additions = restore_harness_views(&assembled, &registered);
        assert_eq!(additions.len(), 1);
        assert_eq!(additions[0]["name"], "inkling.b");
        // 全已登记 = 无新增（只增不减）
        let mut all = HashSet::new();
        all.insert("inkling.a".to_string());
        all.insert("inkling.b".to_string());
        assert!(restore_harness_views(&assembled, &all).is_empty());
    }

    #[test]
    fn restore_knowledge_view_aligns_chain_and_tracked() {
        let assembled = json!({
            "knowledge": {
                "k.promote": {"id": "k.promote", "level": "user", "kind": "rule", "data": {"rule": {"message": "m"}}},
                "k.dropped": {"id": "k.dropped", "level": "work", "kind": "rule"},
            }
        });
        let mut tracked = HashSet::new();
        tracked.insert("k.dropped".to_string()); // 链外补丁条目 → 撤销
        tracked.insert("k.removed".to_string());
        tracked.insert("seed.inkling.domain_guide".to_string()); // 种子只读基线
        let known = HashSet::from(["k.promote".to_string(), "seed.inkling.domain_guide".to_string()]);
        let plan = restore_knowledge_view(&assembled, &tracked, &known);
        assert_eq!(plan.removals, vec!["k.removed".to_string()]);
        assert_eq!(plan.adds.len(), 1);
        assert_eq!(plan.adds[0]["id"], "k.dropped");
        assert_eq!(plan.updates.len(), 1);
        assert_eq!(plan.updates[0]["level"], "user");
        assert!(plan.updates[0].get("id").is_none(), "更新只带可修正字段");
    }

    #[test]
    fn restore_event_types_unregisters_out_of_chain_types() {
        let assembled = json!({"event_types": ["tool_start", "patch_applied"]});
        let registered = vec![
            "tool_start".to_string(),
            "patch_applied".to_string(),
            "obsolete_event".to_string(),
        ];
        let base = vec!["reply_token".to_string(), "plan_start".to_string()];
        let unregister = restore_event_types(&assembled, &registered, &base);
        assert_eq!(unregister, vec!["obsolete_event".to_string()]);
        // 基线事件类型在链外也保留（装配基线不是演化产物）
        let registered2 = vec!["reply_token".to_string(), "plan_start".to_string()];
        assert!(restore_event_types(&json!({}), &registered2, &base).is_empty());
        // 链内事件类型（演化补丁产物）链缺时也保留（链已含 = 权威）
        let assembled = json!({"event_types": ["tool_start"]});
        let registered3 = vec!["tool_start".to_string(), "obsolete".to_string()];
        assert_eq!(
            restore_event_types(&assembled, &registered3, &base),
            vec!["obsolete".to_string()]
        );
    }

    #[test]
    fn rebuild_tools_plan_merges_three_sources_and_detects_removals() {
        let base = json!([{"name": "collect_material", "description": "采集"}])
            .as_array()
            .unwrap()
            .clone();
        let assembled = json!({
            "tools": {"new_mcp_tool": {"name": "new_mcp_tool", "endpoint": "mcp"}},
            "artifacts": {"svc-1": {"meta": {"tool": {"name": "artifact_tool", "description": "产物工具"}}}},
        });
        let mut registered = HashSet::new();
        registered.insert("base_tool".to_string());
        registered.insert("collect_material".to_string());
        registered.insert("new_mcp_tool".to_string());
        registered.insert("artifact_tool".to_string());
        let plan = rebuild_declarative_tools(&base, &assembled, &registered);
        assert!(plan.defs.contains_key("collect_material"));
        assert!(plan.defs.contains_key("new_mcp_tool"));
        assert!(plan.defs.contains_key("artifact_tool"));
        assert_eq!(plan.removals, vec!["base_tool".to_string()]);
    }

    #[test]
    fn validate_ui_spec_enforces_three_whitelists() {
        let spec = seed_ui_spec();
        // 种子界面 = 白名单全绿
        assert!(validate_ui_spec(&spec, &allowed_components(), &allowed_channels(), &allowed_tokens()).is_empty());
        // 越界组件/通道/token 各自报违
        let rogue = json!({
            "root": {"kind": "component", "type": "evil_widget", "bind": {"channel": "events.hack"}, "children": []},
            "theme": {"evil.token": "#000"},
        });
        let violations = validate_ui_spec(&rogue, &allowed_components(), &allowed_channels(), &allowed_tokens());
        assert!(violations.iter().any(|v| v.contains("evil_widget")));
        assert!(violations.iter().any(|v| v.contains("events.hack")));
        assert!(violations.iter().any(|v| v.contains("evil.token")));
        // 缺 root = 显式违
        assert_eq!(validate_ui_spec(&json!({"name": "x"}), &allowed_components(), &allowed_channels(), &allowed_tokens()), vec!["界面布局缺 root 段".to_string()]);
    }

    #[test]
    fn live_target_declarations_cover_five_kinds() {
        let declarations = live_target_declarations();
        assert_eq!(declarations.len(), 5);
        let kinds: Vec<&str> = declarations.iter().map(|d| d["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec![PATCH_KIND_UI, PATCH_KIND_THEME, PATCH_KIND_HARNESS, PATCH_KIND_RULE, PATCH_KIND_KNOWLEDGE]);
        assert_eq!(declarations[0]["target"], TARGET_UI);
    }

    #[test]
    fn parse_knowledge_entry_enforces_contract() {
        let valid = json!({"id": "k.a", "level": "work", "kind": "rule", "data": {"rule": {"message": "m"}}});
        let parsed = parse_knowledge_entry(&valid).expect("应解析");
        assert_eq!(parsed["source"], "model");
        assert!(parse_knowledge_entry(&json!({"level": "work", "kind": "rule"})).is_none());
        assert!(parse_knowledge_entry(&json!({"id": "k.a", "kind": "rule"})).is_none());
        assert!(parse_knowledge_entry(&json!("nope")).is_none());
    }

    #[test]
    fn register_live_targets_and_apply_fail_closed_without_engine() {
        // 无引擎环境：目标注册经操作通道失败 = 结构化错误（回调桥/运行时
        // 未装配），不再返回占位文案；载荷归一不过的补丁 = 域侧结构化错误
        let _serial = crate::engine::host::bridge_guard();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(register_live_targets());
        assert!(err.is_err());
        let message = err.unwrap_err();
        assert!(!message.contains("需 op"), "接线后不再返回占位文案: {message}");
        // 非法 UI 载荷（无 root）= 归一拒绝（域侧错误，不触碰通道）
        let err = rt.block_on(apply_live_patch(PATCH_KIND_UI, &json!({"spec": {}}), None));
        assert!(err.is_err());
        assert!(!err.unwrap_err().contains("需 op"));
        // 非法知识条目（缺 id/kind/level 契约）= 归一拒绝
        let err = rt.block_on(apply_live_patch(
            PATCH_KIND_KNOWLEDGE,
            &json!({"entry": {"level": "work"}}),
            None,
        ));
        assert!(err.is_err());
        assert!(!err.unwrap_err().contains("需 op"));
    }

    #[test]
    fn string_list_helper_keeps_strings() {
        assert_eq!(string_list_from(&json!(["a", 1, "b"])), vec!["a", "b"]);
    }
}

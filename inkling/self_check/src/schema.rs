//! schema 门禁：seed_data 数据一致性校验（纯 Rust，零第三方依赖）。
//!
//! 单一入口校验全部 seed_data JSON：先按各自 JSON Schema 逐文件校验
//! （缺失字段/多余字段/类型错误/空值边界全覆盖），再做跨文件一致性
//! 检查（graph↔workflow、ui_spec↔event_types↔manifest、rules↔review、
//! tools↔workflow、samples↔rules），最后运行内置自检夹具验证校验器
//! 自身行为无误（正例通过、反例报错），并核实引擎源码事实
//! （AssemblyRecipe 字段数以 runtime.py 为准、引擎版本以 pyproject 为准）。
//! 工具名校验口径：长度 ≤ 24 全量强制；「无下划线」仅新增/自写工具经
//! 引擎侧 validate_tool_name 强制（出厂工具与 MCP 豁免，见引擎
//! schema_validator.py 的命名规范事实来源）。

use crate::validator::MiniValidator;
use serde_json::Value;
use std::path::Path;

/// 必须交付的 seed_data 文件（缺一即失败，防漏交付）。
const EXPECTED_SEED_FILES: [&str; 17] = [
    "boot_prompt.json",
    "ui_spec.json",
    "event_types.json",
    "graph.json",
    "tools.json",
    "rules.json",
    "samples.json",
    "templates.json",
    "knowledge.json",
    "workflow.json",
    "signals.json",
    "tiers.json",
    "review.json",
    "memory.json",
    "env.json",
    "mcp_market.json",
    "build.json",
];

/// 引擎源码事实核对基准：AssemblyRecipe 字段数以 runtime.py 源码为准
/// （字段增删会让本门禁与常量失配而失败，防口径漂移）。
const ASSEMBLY_RECIPE_FIELD_COUNT: usize = 18;

/// manifest 身份定稿值（出厂登记表）。
const MANIFEST_ID: &str = "inkling";
const MANIFEST_NAME: &str = "InKling";
const MANIFEST_POSITIONING: &str = "你用得越多，它越懂你的领域";
const MANIFEST_DOMAIN_BOOT: &str = "知识/研究孵化";
const MANIFEST_VERSION: &str = "0.1.0";
const MANIFEST_THEME_TOKENS: [(&str, &str); 3] = [
    ("bg.base", "#09090b"),
    ("text.base", "#e4e4e7"),
    ("accent.approval", "#f59e0b"),
];

/// 自举提示词定稿（逐字比对，出厂注入层消费的原文）。
const BOOT_PROMPT_FINAL: &str = "你是 InKling——一个自进化认知伙伴。你对用户的领域起初只有隐约的理解，通过观察、检索、校验与孵化，把使用中积累的理解沉淀为可信的知识；每一次变化都经审批、可审计、可回退；你也可以提议接入外部工具/插件来扩展能力，经你确认后生效。用中文简明作答。";

// ── 领域契约枚举（与引擎源码常量对齐，防魔法字符串）──

const SIGNAL_KINDS: [&str; 5] = [
    "pitfall",
    "user_correction",
    "insight",
    "gap",
    "repeated_root_cause",
];
const SOURCE_KINDS: [&str; 4] = ["web", "dialog", "model", "user"];
const KNOWLEDGE_LEVELS: [&str; 3] = ["work", "project", "user"];
const KNOWLEDGE_KINDS: [&str; 4] = ["rule", "template", "weight", "tool_rule"];
const APPROVAL_TIERS: [&str; 3] = ["allow", "review", "deny"];
const ENV_RUNTIMES: [&str; 3] = ["local", "web_bridge", "container"];
const GRAPH_NODE_TYPES: [&str; 2] = ["research_orchestrator", "tool_pipeline"];
const ORCHESTRATOR_RESERVED_KEYS: [&str; 3] = ["__plan__", "__spawn__", "__simulate__"];

/// 领域工具（exec 执行体一一对应：采集/解析/校验/评分/评审/蒸馏/变异）。
const DOMAIN_TOOLS: [&str; 7] = [
    "collect_material",
    "parse_material",
    "validate_material",
    "score_material",
    "review_material",
    "distill_knowledge",
    "mutate_knowledge",
];
/// shell 执行器注册（感知/控制/进程模板；壳契约测试同源）。
const SHELL_EXECUTORS: [&str; 20] = [
    "launch_app",
    "open_file",
    "system_query",
    "set_volume",
    "set_brightness",
    "notify",
    "schedule",
    "run_typecheck",
    "run_test_cargo",
    "run_test_python",
    "run_test_web",
    "ui_click",
    "ui_type",
    "window_list",
    "window_focus",
    "window_minimize",
    "doc_parse",
    "doc_generate",
    "screenshot_capture",
    "material_import",
];
/// OS 控制类（system_query 属感知/状态查询，不计入）。
const OS_CONTROL_TOOLS: [&str; 11] = [
    "launch_app",
    "open_file",
    "set_volume",
    "set_brightness",
    "notify",
    "schedule",
    "ui_click",
    "ui_type",
    "window_list",
    "window_focus",
    "window_minimize",
];
/// 设备感知类（屏幕/文件状态，经 inkling_shell 设备感知 server 挂载）。
const DEVICE_SENSE_TOOLS: [&str; 3] = ["screen_query", "file_query", "ui_tree_query"];
/// 挂载提案 + 文件开发工具 + 自指演化提案（对话式安装入口 / 工作区
/// 沙箱端点 / 声明式补丁提案）。
const SELF_AND_FILE_TOOLS: [&str; 5] = [
    "propose_mcp_mount",
    "propose_patch",
    "file_read",
    "file_write",
    "file_edit",
];
/// 网络工具（http_fetch 端点：域名白名单策略的抓取与聚合检索）。
const NETWORK_TOOLS: [&str; 2] = ["fetch", "web_search"];
/// 工作区文件内容/路径检索工具（file_ops 端点只读检索）。
const FILE_SEARCH_TOOLS: [&str; 2] = ["grep", "glob"];
/// deny 档工具（三档权限契约的默认拒绝样例，须经补丁链转正才可用）。
const DENY_TOOLS: [&str; 1] = ["shell_exec"];

/// 规则谓词（Rust 谓词执行体实现清单，数据↔执行件绑定的契约面）。
const DOMAIN_PREDICATES: [&str; 6] = [
    "has_fields",
    "in_enum",
    "max_length",
    "non_empty_string",
    "min_value",
    "no_injection_phrase",
];

/// 样例库边界值（与 rules.json max_length 上限 120 的边界用例绑定）。
const TITLE_MAX_CHARS: usize = 120;
const SAMPLE_AT_MAX: &str = "material_title_at_max";
const SAMPLE_OVER_MAX: &str = "material_title_over_max";

/// 跨文件数值联动基准（review 阈值 ↔ 规则阈值，防双源漂移）。
const REVIEW_PASS_THRESHOLD: f64 = 0.75;
const REVIEW_MAX_ROUNDS: u64 = 2;
const REVIEW_BEAM_WIDTH: u64 = 1;
const REVIEW_NEUTRAL_SCORE: f64 = 0.5;

/// 信号蒸馏阈值（引擎 knowledge_signals 常量）。
const DISTILL_COMPLEXITY_THRESHOLD: u64 = 5;
const DISTILL_INTERVENTION_THRESHOLD: u64 = 1;
const REPEAT_THRESHOLD: u64 = 3;

/// 记忆失效窗口（默认 90 天，设置页可调）。
const MEMORY_DEFAULT_WINDOW_DAYS: u64 = 90;

/// 绑定路径保留前缀（引擎 ui_schema：_ 开头路径段为内部数据，禁绑定）。
const RESERVED_BIND_PREFIX: &str = "_";
/// 事件通道前缀（ui_spec 的 events.* 通道须与 event_types.json 逐一对应）。
const EVENT_CHANNEL_PREFIX: &str = "events.";

/// 工具名校验上界（引擎 schema_validator TOOL_NAME_MAX_LENGTH 同值）。
const TOOL_NAME_MAX_LENGTH: usize = 24;

/// file_ops 端点各工具的 operation 固定枚举（端点操作判定同源）。
fn expected_file_ops_enum(name: &str) -> &'static [&'static str] {
    match name {
        "file_read" => &["read"],
        "file_write" | "file_edit" => &["write"],
        "grep" => &["search"],
        "glob" => &["search_paths"],
        _ => &[],
    }
}

// ── 引擎源码事实核实（只读解析，不改动引擎任何文件）──

/// 统计 runtime.py 中 AssemblyRecipe 数据类字段数（文本扫描：
/// 类体缩进内的注解赋值行，跳过文档字符串；验收以源码为准）。
fn count_assembly_recipe_fields(runtime_path: &Path) -> Option<usize> {
    let source = std::fs::read_to_string(runtime_path).ok()?;
    let mut in_class = false;
    let mut in_docstring = false;
    let mut count = 0usize;
    for line in source.lines() {
        let trimmed = line.trim();
        if !in_class {
            if trimmed.starts_with("class AssemblyRecipe") {
                in_class = true;
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if indent == 0 {
            break;
        }
        if trimmed.starts_with("def ") || trimmed.starts_with("class ") {
            break;
        }
        if in_docstring {
            if trimmed.contains("\"\"\"") || trimmed.contains("'''") {
                in_docstring = false;
            }
            continue;
        }
        // 文档字符串（多行）跳过，只数真实字段
        if trimmed.starts_with("\"\"\"") || trimmed.starts_with("'''") {
            let quote = if trimmed.starts_with("\"\"\"") { "\"\"\"" } else { "'''" };
            if !trimmed[quote.len()..].contains(quote) {
                in_docstring = true;
            }
            continue;
        }
        // 注解赋值形态：`name: type`（含 `= default`）
        let Some(colon) = trimmed.find(':') else { continue };
        let name = trimmed[..colon].trim();
        if !name.is_empty()
            && name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            && !name.starts_with('_')
        {
            count += 1;
        }
    }
    Some(count)
}

/// 从 ink_engine/pyproject.toml 读取版本（manifest 锁定的核实基准）。
fn read_engine_version(pyproject_path: &Path) -> Option<String> {
    let source = std::fs::read_to_string(pyproject_path).ok()?;
    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("version") {
            let rest = rest.trim_start();
            if let Some(after_eq) = rest.strip_prefix('=') {
                let raw = after_eq.trim().trim_matches('"');
                if !raw.is_empty() {
                    return Some(raw.to_string());
                }
            }
        }
    }
    None
}

// ── 数据装载 ──

/// 装载 JSON；损坏文件返回带文件名的可读错误（明确报错定位）。
fn load_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| format!("{}: 读取失败（{err}）", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: JSON 解析失败（{err}）", path.display()))
}

// ── 跨文件一致性检查（防双源漂移；每项均带可读说明）──

struct Payload {
    manifest: Value,
    engine_version: Option<String>,
    files: Vec<(String, Value)>,
}

impl Payload {
    fn get(&self, key: &str) -> Option<&Value> {
        self.files
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }
}

fn check_manifest(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let get = |key: &str| data.get(key);
    if get("id").and_then(Value::as_str) != Some(MANIFEST_ID) {
        issues.push(format!("manifest.id 应为 {MANIFEST_ID:?}"));
    }
    if get("name").and_then(Value::as_str) != Some(MANIFEST_NAME) {
        issues.push(format!("manifest.name 应为 {MANIFEST_NAME:?}"));
    }
    if get("positioning").and_then(Value::as_str) != Some(MANIFEST_POSITIONING) {
        issues.push(format!("manifest.positioning 应为 {MANIFEST_POSITIONING:?}"));
    }
    if get("domain_boot").and_then(Value::as_str) != Some(MANIFEST_DOMAIN_BOOT) {
        issues.push(format!("manifest.domain_boot 应为 {MANIFEST_DOMAIN_BOOT:?}"));
    }
    if get("version").and_then(Value::as_str) != Some(MANIFEST_VERSION) {
        issues.push(format!("manifest.version 应为 {MANIFEST_VERSION:?}"));
    }
    let theme = get("theme").and_then(Value::as_object);
    for (token, expected) in MANIFEST_THEME_TOKENS {
        let actual = theme.and_then(|map| map.get(token)).and_then(Value::as_str);
        if actual != Some(expected) {
            issues.push(format!("manifest.theme.{token} 应为 {expected:?}（墨色系定稿）"));
        }
    }
    if let Some(engine_version) = payload.engine_version.as_ref() {
        if get("engine_version_compat").and_then(Value::as_str) != Some(engine_version.as_str()) {
            issues.push(format!(
                "manifest.engine_version_compat {:?} 与 pyproject 版本 {engine_version:?} 不一致",
                get("engine_version_compat")
                    .and_then(Value::as_str)
                    .unwrap_or("（缺失）")
            ));
        }
    }
    let contracts = get("contracts").and_then(Value::as_object);
    let contract_str = |key: &str| {
        contracts
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
    };
    if contract_str("exec_mcp_id") != Some("inkling_exec") {
        issues.push("contracts.exec_mcp_id 应为 inkling_exec".to_string());
    }
    if contract_str("host_id") != Some("inkling_shell") {
        issues.push("contracts.host_id 应为 inkling_shell".to_string());
    }
    let tools = payload.get("tools").and_then(Value::as_object);
    let tool_list = tools
        .and_then(|map| map.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tool_names: Vec<&str> = tool_list
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect();
    let mcp_server_ids: Vec<&str> = tool_list
        .iter()
        .filter(|tool| tool.get("endpoint").and_then(Value::as_str) == Some("mcp"))
        .filter_map(|tool| {
            tool.get("endpoint_config")
                .and_then(Value::as_object)
                .and_then(|config| config.get("server_id"))
                .and_then(Value::as_str)
        })
        .collect();
    if !mcp_server_ids.contains(&"inkling_exec") {
        issues.push("contracts.exec_mcp_id=inkling_exec 未在 tools.json 的任何 mcp 工具中被引用".to_string());
    }
    if !mcp_server_ids.contains(&"inkling_shell") {
        issues.push("contracts.host_id=inkling_shell 未在 tools.json 的任何 mcp 工具中被引用".to_string());
    }
    let mut expected_names: Vec<&str> = Vec::new();
    expected_names.extend(DOMAIN_TOOLS);
    expected_names.extend(SHELL_EXECUTORS);
    expected_names.extend(DEVICE_SENSE_TOOLS);
    expected_names.extend(SELF_AND_FILE_TOOLS);
    expected_names.extend(NETWORK_TOOLS);
    expected_names.extend(FILE_SEARCH_TOOLS);
    expected_names.extend(DENY_TOOLS);
    let mut sorted_actual = tool_names.clone();
    sorted_actual.sort_unstable();
    let mut sorted_expected = expected_names.clone();
    sorted_expected.sort_unstable();
    if sorted_actual != sorted_expected {
        issues.push(format!(
            "tools.json 工具集合与契约清单不一致（域/执行器/感知/自建/网络/检索/deny 档共 {} 件）",
            sorted_expected.len()
        ));
    }
    let theme_tokens = contracts
        .and_then(|map| map.get("theme_tokens"))
        .and_then(Value::as_array);
    let expected_tokens: Vec<&str> = MANIFEST_THEME_TOKENS.iter().map(|(k, _)| *k).collect();
    let actual_tokens: Vec<&str> = theme_tokens
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if actual_tokens != expected_tokens {
        issues.push(format!(
            "contracts.theme_tokens 应恰好为 {expected_tokens:?}（墨色系三 token）"
        ));
    }
    let ui_theme_keys: Vec<&str> = payload
        .get("ui_spec")
        .and_then(|spec| spec.get("theme"))
        .and_then(Value::as_object)
        .map(|theme| theme.keys().map(String::as_str).collect())
        .unwrap_or_default();
    for key in ui_theme_keys {
        if !actual_tokens.contains(&key) {
            issues.push(format!("ui_spec 使用的主题键 {key:?} 超出白名单 {actual_tokens:?}"));
        }
    }
    // 出厂自检表身份定稿：四门禁全部 ready 且命令非空（单一事实源自证）
    let self_check = get("self_check").and_then(Value::as_object);
    if let Some(self_check) = self_check {
        for gate in ["schema", "cargo_test", "frontend", "e2e"] {
            let entry = self_check.get(gate).and_then(Value::as_object);
            let command = entry
                .and_then(|map| map.get("command"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let status = entry
                .and_then(|map| map.get("status"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if command.is_empty() || status != "ready" {
                issues.push(format!(
                    "manifest.self_check.{gate} 应 command 非空且 status=ready（当前 command={command:?} status={status:?}）"
                ));
            }
        }
    }
}

fn walk_nodes(node: &Value) -> Vec<&Value> {
    let mut collected = vec![node];
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            collected.extend(walk_nodes(child));
        }
    }
    collected
}

fn check_ui_spec(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let manifest = &payload.manifest;
    let contracts = manifest.get("contracts").and_then(Value::as_object);
    let allowed_components: Vec<&str> = contracts
        .and_then(|map| map.get("renderer_components"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let allowed_channels: Vec<&str> = contracts
        .and_then(|map| map.get("bind_channels"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let event_names: Vec<&str> = payload
        .get("event_types")
        .and_then(|types| types.get("events"))
        .and_then(Value::as_array)
        .map(|events| events.iter().filter_map(|e| e.get("name").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    for node in walk_nodes(&data["root"]) {
        if node.get("kind").and_then(Value::as_str) == Some("component") {
            let component_type = node.get("type").and_then(Value::as_str).unwrap_or("");
            if !allowed_components.contains(&component_type) {
                issues.push(format!("ui_spec 组件未在白名单: {component_type:?}"));
            }
            if node.get("children").is_some() {
                issues.push(format!("ui_spec 组件节点不允许携带 children: {component_type:?}"));
            }
        }
        let Some(bind) = node.get("bind").and_then(Value::as_object) else {
            continue;
        };
        let channel = bind.get("channel").and_then(Value::as_str).unwrap_or("");
        if !allowed_channels.contains(&channel) {
            issues.push(format!("ui_spec 绑定通道未放行: {channel:?}"));
        }
        if let Some(event_name) = channel.strip_prefix(EVENT_CHANNEL_PREFIX) {
            if !event_names.contains(&event_name) {
                issues.push(format!(
                    "ui_spec 绑定通道 {channel:?} 无对应事件类型（event_types.json 缺 {event_name:?}）"
                ));
            }
        }
        let bind_path = bind.get("path").and_then(Value::as_str).unwrap_or("");
        for segment in bind_path.split('.') {
            if segment.starts_with(RESERVED_BIND_PREFIX) {
                issues.push(format!(
                    "ui_spec 绑定路径命中保留前缀: {channel:?} path={bind_path:?}（内部数据不可绑定）"
                ));
            }
        }
    }
    if let Some(events) = payload.get("event_types").and_then(|types| types.get("events")).and_then(Value::as_array) {
        for event in events {
            let Some(renderer) = event.get("renderer").and_then(Value::as_str) else {
                continue;
            };
            if !allowed_components.contains(&renderer) {
                issues.push(format!(
                    "事件 {:?} 的 renderer {renderer:?} 未在组件白名单",
                    event.get("name").and_then(Value::as_str).unwrap_or("（无名）")
                ));
            }
        }
    }
}

fn check_event_types(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let events = data.get("events").and_then(Value::as_array);
    let Some(events) = events else { return };
    let names: Vec<&str> = events
        .iter()
        .filter_map(|event| event.get("name").and_then(Value::as_str))
        .collect();
    if !unique(&names) {
        issues.push("event_types.json 存在重复事件名".to_string());
    }
    for event in events {
        let Some(schema) = event.get("schema").and_then(Value::as_object) else {
            continue;
        };
        let Some(fields) = schema.get("fields").and_then(Value::as_array) else {
            continue;
        };
        let field_names: Vec<&str> = fields
            .iter()
            .filter_map(|field| field.get("name").and_then(Value::as_str))
            .collect();
        if !unique(&field_names) {
            issues.push(format!(
                "事件 {:?} 的 schema 字段名重复",
                event.get("name").and_then(Value::as_str).unwrap_or("（无名）")
            ));
        }
        for field in fields {
            let min = field.get("min").and_then(Value::as_u64);
            let max = field.get("max").and_then(Value::as_u64);
            if let (Some(min), Some(max)) = (min, max) {
                if min > max {
                    issues.push(format!(
                        "事件 {:?} 字段 {:?} 范围自相矛盾",
                        event.get("name").and_then(Value::as_str).unwrap_or("（无名）"),
                        field.get("name").and_then(Value::as_str).unwrap_or("（无名）")
                    ));
                }
            }
        }
    }
}

fn check_graph(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let nodes = data.get("nodes").and_then(Value::as_object);
    let Some(nodes) = nodes else { return };
    let entry = data.get("entry").and_then(Value::as_str).unwrap_or("");
    if !nodes.contains_key(entry) {
        issues.push(format!("graph.entry {entry:?} 不在节点集合中"));
    }
    for (node_name, spec) in nodes.iter() {
        let node_type = spec.get("type").and_then(Value::as_str).unwrap_or("");
        if !GRAPH_NODE_TYPES.contains(&node_type) {
            issues.push(format!(
                "graph 节点 {node_name:?} 引用了未注册类型 {node_type:?}（出厂仅 {GRAPH_NODE_TYPES:?}）"
            ));
        }
    }
    if let Some(edges) = data.get("edges").and_then(Value::as_object) {
        for (source, edge_list) in edges.iter() {
            if !nodes.contains_key(source) {
                issues.push(format!("graph 边来源 {source:?} 不在节点集合中"));
            }
            if let Some(edge_list) = edge_list.as_array() {
                for edge in edge_list {
                    let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
                    if !nodes.contains_key(target) {
                        issues.push(format!("graph 边 {source} → {target} 目标不在节点集合中"));
                    }
                }
            }
        }
    }
    if let Some(exits) = data.get("exits").and_then(Value::as_array) {
        for exit in exits.iter().filter_map(Value::as_str) {
            if !nodes.contains_key(exit) {
                issues.push(format!("graph 出口 {exit:?} 不在节点集合中"));
            }
        }
    }
    let orchestrator = nodes.get("research_orchestrator");
    let Some(orchestrator) = orchestrator else {
        issues.push("graph 缺少 research_orchestrator 节点（出厂编排节点）".to_string());
        return;
    };
    let config = orchestrator.get("config").and_then(Value::as_object);
    let reserved: Vec<&str> = config
        .and_then(|map| map.get("reserved_keys"))
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if reserved != ORCHESTRATOR_RESERVED_KEYS {
        issues.push(format!("research_orchestrator 保留键应为 {ORCHESTRATOR_RESERVED_KEYS:?}"));
    }
    let workflow_name = config
        .and_then(|map| map.get("workflow"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let expected_workflow = payload
        .get("workflow")
        .and_then(|workflow| workflow.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if workflow_name != expected_workflow {
        issues.push(format!(
            "graph 引用 workflow {workflow_name:?} 与 workflow.json 名称 {expected_workflow:?} 不一致"
        ));
    }
    if !nodes.contains_key("tool_pipeline") {
        issues.push("graph 缺少 tool_pipeline 节点（统一工具分发编排）".to_string());
    }
}

fn check_workflow(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let nodes = data.get("nodes").and_then(Value::as_array);
    let Some(nodes) = nodes else { return };
    let node_ids: Vec<&str> = nodes
        .iter()
        .filter_map(|node| node.get("id").and_then(Value::as_str))
        .collect();
    if !unique(&node_ids) {
        issues.push("workflow 节点 id 重复".to_string());
    }
    let entry = data.get("entry").and_then(Value::as_str).unwrap_or("");
    if !node_ids.contains(&entry) {
        issues.push(format!("workflow.entry {entry:?} 不在节点集合中"));
    }
    let edges = data.get("edges").and_then(Value::as_array);
    let Some(edges) = edges else { return };
    let mut incoming: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for edge in edges {
        let source = edge.get("source").and_then(Value::as_str).unwrap_or("");
        let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
        if !node_ids.contains(&source) || !node_ids.contains(&target) {
            issues.push(format!("workflow 边引用未知节点: {source} → {target}"));
        }
        *incoming.entry(target).or_insert(0) += 1;
    }
    // 环检测（Kahn 拓扑）：有环 = 约束域不可编译，建图期同样拒绝
    let mut degree: std::collections::HashMap<&str, usize> = incoming.clone();
    let mut queue: Vec<&str> = node_ids
        .iter()
        .copied()
        .filter(|id| degree.get(id).copied().unwrap_or(0) == 0)
        .collect();
    let mut ordered = Vec::with_capacity(node_ids.len());
    while let Some(current) = queue.pop() {
        ordered.push(current);
        for edge in edges {
            if edge.get("source").and_then(Value::as_str) == Some(current) {
                let target = edge.get("target").and_then(Value::as_str).unwrap_or("");
                let count = degree.entry(target).or_insert(0);
                *count = count.saturating_sub(1);
                if *count == 0 {
                    queue.push(target);
                }
            }
        }
    }
    if ordered.len() != node_ids.len() {
        issues.push("workflow 存在环（约束域不可编译）".to_string());
    }
    for node in nodes {
        let node_type = node.get("type").and_then(Value::as_str).unwrap_or("");
        if !DOMAIN_TOOLS.contains(&node_type) {
            issues.push(format!(
                "workflow 节点类型 {node_type:?} 不在领域工具集内（tools.json）"
            ));
        }
    }
}

fn check_tools(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let tools = data.get("tools").and_then(Value::as_array);
    let Some(tools) = tools else { return };
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect();
    if !unique(&names) {
        issues.push("tools.json 存在重复工具名".to_string());
    }
    let mut domain_seen: Vec<&str> = Vec::new();
    let mut shell_seen: Vec<&str> = Vec::new();
    let mut deny_seen: Vec<&str> = Vec::new();
    for tool in tools {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let permissions = tool.get("permissions").and_then(Value::as_array);
        if permissions.map_or(true, |list| list.is_empty()) {
            issues.push(format!("工具 {name} 权限声明为空（fail-closed：未声明权限默认拒绝）"));
        }
        let endpoint = tool.get("endpoint").and_then(Value::as_str).unwrap_or("");
        let config = tool.get("endpoint_config").and_then(Value::as_object);
        let parameters = tool.get("parameters").and_then(Value::as_object);
        match endpoint {
            "process_exec" => {
                let allowlist = config
                    .and_then(|map| map.get("allowlist"))
                    .and_then(Value::as_array);
                let allowlist_ok = allowlist.map_or(false, |list| {
                    !list.is_empty()
                        && list
                            .iter()
                            .all(|entry| entry.as_str().map_or(false, |text| !text.is_empty()))
                });
                if !allowlist_ok {
                    issues.push(format!(
                        "工具 {name} 的 process_exec 端点须声明非空命令白名单 allowlist"
                    ));
                }
                let command_props = parameters
                    .and_then(|map| map.get("properties"))
                    .and_then(Value::as_object)
                    .and_then(|props| props.get("command"))
                    .and_then(Value::as_object);
                let command_ok = command_props
                    .and_then(|props| props.get("type"))
                    .and_then(Value::as_str)
                    == Some("string")
                    && command_props
                        .and_then(|props| props.get("enum"))
                        .and_then(Value::as_array)
                        .map_or(false, |choices| {
                            choices.len() == 1 && choices[0].as_str() == Some(name)
                        });
                if !command_ok {
                    issues.push(format!(
                        "工具 {name} 的 process_exec 端点须声明 command 固定枚举 [{name}]"
                    ));
                }
                let required = parameters
                    .and_then(|map| map.get("required"))
                    .and_then(Value::as_array);
                if required.map_or(true, |list| !list.iter().any(|item| item.as_str() == Some("command"))) {
                    issues.push(format!("工具 {name} 的 command 参数须在 required 清单内"));
                }
            }
            "file_ops" => {
                let root = config
                    .and_then(|map| map.get("root"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if root.is_empty() {
                    issues.push(format!("工具 {name} 的 file_ops 端点须声明非空根目录 root（沙箱端点）"));
                }
                let expected_ops = expected_file_ops_enum(name);
                let operation_props = parameters
                    .and_then(|map| map.get("properties"))
                    .and_then(Value::as_object)
                    .and_then(|props| props.get("operation"))
                    .and_then(Value::as_object);
                let operation_ok = operation_props
                    .and_then(|props| props.get("type"))
                    .and_then(Value::as_str)
                    == Some("string")
                    && operation_props
                        .and_then(|props| props.get("enum"))
                        .and_then(Value::as_array)
                        .map_or(false, |choices| {
                            choices.iter().all(|choice| choice.as_str().is_some())
                                && expected_ops
                                    .iter()
                                    .all(|expected| choices.iter().any(|choice| choice.as_str() == Some(expected)))
                        });
                if !operation_ok {
                    issues.push(format!(
                        "工具 {name} 的 file_ops 端点须声明 operation 固定枚举 {expected_ops:?}"
                    ));
                }
                let required = parameters
                    .and_then(|map| map.get("required"))
                    .and_then(Value::as_array);
                if required.map_or(true, |list| !list.iter().any(|item| item.as_str() == Some("operation"))) {
                    issues.push(format!("工具 {name} 的 operation 参数须在 required 清单内"));
                }
                let limits = tool
                    .get("meta")
                    .and_then(Value::as_object)
                    .and_then(|meta| meta.get("sandbox_limits"))
                    .and_then(Value::as_object);
                let max_read = limits.and_then(|map| map.get("max_read_bytes")).and_then(Value::as_u64);
                let max_write = limits.and_then(|map| map.get("max_write_bytes")).and_then(Value::as_u64);
                if max_read.map_or(true, |value| value == 0) {
                    issues.push(format!("工具 {name} 须声明 sandbox_limits.max_read_bytes（正整数大小上限）"));
                }
                if max_write.map_or(true, |value| value == 0) {
                    issues.push(format!("工具 {name} 须声明 sandbox_limits.max_write_bytes（正整数大小上限）"));
                }
            }
            "http_fetch" => {
                let has_network_permission = permissions.map_or(false, |list| {
                    list.iter().any(|item| {
                        item.as_str()
                            .map_or(false, |perm| perm.starts_with("network:connect:"))
                    })
                });
                if !has_network_permission {
                    issues.push(format!(
                        "工具 {name} 的权限须含 network:connect 声明（与网络策略同源）"
                    ));
                }
                // 抓取工具（fetch）须域名白名单非空（空白名单 = 禁网）；
                // 聚合检索（web_search）走本地聚合源/用户自配厂商，白名单可空
                if name == "fetch" {
                    let allow_domains = tool
                        .get("network_policy")
                        .and_then(Value::as_object)
                        .and_then(|policy| policy.get("allow_domains"))
                        .and_then(Value::as_array);
                    if allow_domains.map_or(true, |list| list.is_empty()) {
                        issues.push(format!(
                            "工具 {name} 的 http_fetch 端点须声明非空 network_policy.allow_domains（空白名单 = 禁网）"
                        ));
                    }
                }
            }
            "mcp" => {
                let server_id = config
                    .and_then(|map| map.get("server_id"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if server_id.is_empty() {
                    issues.push(format!("工具 {name} 的 mcp 端点须声明 server_id 路由密钥"));
                }
            }
            _ => {}
        }
        let approval = tool.get("approval").and_then(Value::as_str).unwrap_or("");
        if !APPROVAL_TIERS.contains(&approval) {
            issues.push(format!("工具 {name} 权限分级非法: {approval:?}"));
        }
        if approval == "deny" {
            deny_seen.push(name);
            let deny_by_default = tool
                .get("meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("deny_by_default"))
                .and_then(Value::as_bool);
            if deny_by_default != Some(true) {
                issues.push(format!(
                    "deny 档工具 {name} 须声明 meta.deny_by_default=true（出厂默认拒绝契约）"
                ));
            }
        }
        if tool
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("domain"))
            .and_then(Value::as_str)
            == Some("research")
        {
            domain_seen.push(name);
        }
        let executor = tool
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("executor"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if executor == format!("shell:{name}") {
            shell_seen.push(name);
        }
        // 工具名长度上界全量校验（出厂 25 件现状应全过；命名规范见引擎侧事实来源）
        let char_count = name.chars().count();
        if char_count > TOOL_NAME_MAX_LENGTH {
            issues.push(format!(
                "工具名 {name:?} 长度 {char_count} 超过上界 {TOOL_NAME_MAX_LENGTH}（引擎 validate_tool_name 同口径）"
            ));
        }
    }
    if !same_set(&domain_seen, &DOMAIN_TOOLS) {
        issues.push(format!(
            "领域工具集合应为 {DOMAIN_TOOLS:?}，实际 {domain_seen:?}（与 exec 执行体一一对应）"
        ));
    }
    if !same_set(&shell_seen, &SHELL_EXECUTORS) {
        issues.push(format!(
            "shell 执行器注册集合应为 {SHELL_EXECUTORS:?}，实际 {shell_seen:?}（与 shell 契约一致）"
        ));
    }
    let control_tools: Vec<&str> = tools
        .iter()
        .filter(|tool| {
            tool.get("meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("control"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect();
    if !same_set(&control_tools, &OS_CONTROL_TOOLS) {
        issues.push(format!("OS 控制工具集合应为 {OS_CONTROL_TOOLS:?}，实际 {control_tools:?}"));
    }
    if !same_set(&deny_seen, &DENY_TOOLS) {
        issues.push(format!(
            "deny 档工具集合应为 {DENY_TOOLS:?}，实际 {deny_seen:?}（三档权限契约的拒绝档）"
        ));
    }
}

fn check_rules(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let rules = data.get("rules").and_then(Value::as_array);
    let Some(rules) = rules else { return };
    let rule_ids: Vec<&str> = rules
        .iter()
        .filter_map(|rule| rule.get("id").and_then(Value::as_str))
        .collect();
    if !unique(&rule_ids) {
        issues.push("rules.json 存在重复规则 id".to_string());
    }
    let rule_kinds: Vec<&str> = rules
        .iter()
        .filter_map(|rule| rule.get("kind").and_then(Value::as_str))
        .collect();
    for rule in rules {
        let predicate = rule.get("predicate").and_then(Value::as_str).unwrap_or("");
        if !DOMAIN_PREDICATES.contains(&predicate) {
            issues.push(format!(
                "规则 {:?} 谓词 {predicate:?} 不在谓词实现清单 {DOMAIN_PREDICATES:?}",
                rule.get("id").and_then(Value::as_str).unwrap_or("（无名）")
            ));
        }
    }
    for rule in rules {
        if rule.get("id").and_then(Value::as_str) == Some("rule.review.score_floor") {
            let floor = rule
                .get("config")
                .and_then(Value::as_object)
                .and_then(|config| config.get("min"))
                .and_then(Value::as_f64);
            let review_threshold = payload
                .get("review")
                .and_then(|review| review.get("pass_threshold"))
                .and_then(Value::as_f64);
            if floor != review_threshold {
                issues.push(format!(
                    "rule.review.score_floor.min={floor:?} 与 review.json pass_threshold={review_threshold:?} 不一致（防双源漂移）"
                ));
            }
        }
    }
    let sample_kinds: std::collections::BTreeSet<&str> = payload
        .get("samples")
        .and_then(|samples| samples.get("cases"))
        .and_then(Value::as_array)
        .map(|cases| {
            cases
                .iter()
                .filter_map(|case| case.get("expected_kinds"))
                .filter_map(Value::as_array)
                .flatten()
                .filter_map(Value::as_str)
                .collect()
        })
        .unwrap_or_default();
    let rule_kind_set: std::collections::BTreeSet<&str> = rule_kinds.iter().copied().collect();
    let unknown: Vec<&str> = sample_kinds
        .iter()
        .copied()
        .filter(|kind| !rule_kind_set.contains(kind))
        .collect();
    if !unknown.is_empty() {
        issues.push(format!(
            "samples.json 期望违规类别在规则集中不存在: {unknown:?}"
        ));
    }
    // 每个违规类别至少有一个反例覆盖（L2 闸门的负向证明面）
    for kind in &rule_kind_set {
        if !sample_kinds.contains(kind) {
            issues.push(format!("规则类别 {kind:?} 无样例反例覆盖（每个规则类别须有 fail 用例）"));
        }
    }
}

fn check_samples(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let cases = data.get("cases").and_then(Value::as_array);
    let Some(cases) = cases else { return };
    let case_ids: Vec<&str> = cases
        .iter()
        .filter_map(|case| case.get("id").and_then(Value::as_str))
        .collect();
    if !unique(&case_ids) {
        issues.push("samples.json 存在重复用例 id".to_string());
    }
    const SECTION_KEYS: [&str; 4] = ["material", "entry", "review", "case"];
    for case in cases {
        let data_obj = case.get("data").and_then(Value::as_object);
        let missing: Vec<&str> = SECTION_KEYS
            .iter()
            .copied()
            .filter(|key| data_obj.map_or(true, |map| !map.contains_key(*key)))
            .collect();
        if !missing.is_empty() {
            issues.push(format!(
                "样例 {:?} 缺规则作用域段 {missing:?}（八条规则均须可评估）",
                case.get("id").and_then(Value::as_str).unwrap_or("（无名）")
            ));
        }
    }
    let by_id: std::collections::HashMap<&str, &Value> = cases
        .iter()
        .filter_map(|case| {
            case.get("id")
                .and_then(Value::as_str)
                .map(|id| (id, case))
        })
        .collect();
    let title_of = |id: &str| -> String {
        by_id
            .get(id)
            .and_then(|case| case.get("data"))
            .and_then(|data| data.get("material"))
            .and_then(|material| material.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if let Some(at_max) = by_id.get(SAMPLE_AT_MAX) {
        let length = title_of(SAMPLE_AT_MAX).chars().count();
        if length != TITLE_MAX_CHARS {
            issues.push(format!(
                "样例 {SAMPLE_AT_MAX} 标题长度 {length} 应恰好 {TITLE_MAX_CHARS}（边界通过）"
            ));
        }
        let _ = at_max;
    }
    if let Some(over_max) = by_id.get(SAMPLE_OVER_MAX) {
        let length = title_of(SAMPLE_OVER_MAX).chars().count();
        if length != TITLE_MAX_CHARS + 1 {
            issues.push(format!(
                "样例 {SAMPLE_OVER_MAX} 标题长度 {length} 应恰好 {}（边界违规）",
                TITLE_MAX_CHARS + 1
            ));
        }
        let _ = over_max;
    }
}

fn check_entries(entries: &Value, source_label: &str, issues: &mut Vec<String>) {
    let Some(entries) = entries.as_array() else { return };
    let ids: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    if !unique(&ids) {
        issues.push(format!("{source_label} 存在重复条目 id"));
    }
    for entry in entries {
        let level = entry.get("level").and_then(Value::as_str).unwrap_or("");
        let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("");
        let source = entry.get("source").and_then(Value::as_str).unwrap_or("");
        let credibility = entry.get("credibility").and_then(Value::as_f64);
        if !KNOWLEDGE_LEVELS.contains(&level) {
            issues.push(format!("{source_label} 条目 {:?} 层级非法: {level:?}", entry.get("id").and_then(Value::as_str).unwrap_or("（无名）")));
        }
        if !KNOWLEDGE_KINDS.contains(&kind) {
            issues.push(format!("{source_label} 条目 {:?} kind 非法: {kind:?}", entry.get("id").and_then(Value::as_str).unwrap_or("（无名）")));
        }
        if !SOURCE_KINDS.contains(&source) {
            issues.push(format!("{source_label} 条目 {:?} 来源非法: {source:?}", entry.get("id").and_then(Value::as_str).unwrap_or("（无名）")));
        }
        if credibility.map_or(false, |value| !(0.0..=1.0).contains(&value)) {
            issues.push(format!("{source_label} 条目 {:?} 可信度越界: {credibility:?}", entry.get("id").and_then(Value::as_str).unwrap_or("（无名）")));
        }
        let entry_id = entry.get("id").and_then(Value::as_str).unwrap_or("（无名）");
        let data = entry.get("data").and_then(Value::as_object);
        if kind == "rule" {
            let message = data
                .and_then(|map| map.get("rule"))
                .and_then(Value::as_object)
                .and_then(|rule| rule.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if message.is_empty() {
                issues.push(format!("{source_label} 条目 {entry_id} 的 rule.message 缺失或为空"));
            }
        }
        if kind == "template" {
            let name = data
                .and_then(|map| map.get("template"))
                .and_then(Value::as_object)
                .and_then(|template| template.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name.is_empty() {
                issues.push(format!("{source_label} 条目 {entry_id} 的 template.name 缺失"));
            }
        }
    }
}

fn check_templates(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let templates = data.get("templates");
    if let Some(templates) = templates {
        check_entries(templates, "templates.json", issues);
        let workflow_node_ids: Vec<&str> = payload
            .get("workflow")
            .and_then(|workflow| workflow.get("nodes"))
            .and_then(Value::as_array)
            .map(|nodes| {
                nodes
                    .iter()
                    .filter_map(|node| node.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        if let Some(entries) = templates.as_array() {
            for entry in entries {
                let template = entry
                    .get("data")
                    .and_then(Value::as_object)
                    .and_then(|data| data.get("template"))
                    .and_then(Value::as_object);
                let Some(template) = template else { continue };
                let steps = template.get("plan").and_then(Value::as_object).and_then(|plan| plan.get("steps")).and_then(Value::as_array);
                let Some(steps) = steps else { continue };
                for step in steps {
                    let Some(step_nodes) = step.get("nodes").and_then(Value::as_array) else {
                        continue;
                    };
                    for node_name in step_nodes.iter().filter_map(Value::as_str) {
                        if !workflow_node_ids.contains(&node_name) && !DOMAIN_TOOLS.contains(&node_name) {
                            issues.push(format!(
                                "模板 {:?} 步骤节点 {node_name:?} 不在 workflow 节点/领域工具集内",
                                entry.get("id").and_then(Value::as_str).unwrap_or("（无名）")
                            ));
                        }
                    }
                }
            }
        }
    }
}

fn check_knowledge(data: &Value, payload: &Payload, issues: &mut Vec<String>) {
    let entries = data.get("entries");
    if let Some(entries) = entries {
        check_entries(entries, "knowledge.json", issues);
        let template_ids: std::collections::BTreeSet<&str> = payload
            .get("templates")
            .and_then(|templates| templates.get("templates"))
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let knowledge_ids: std::collections::BTreeSet<&str> = entries
            .as_array()
            .map(|items| items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let clash: Vec<&str> = knowledge_ids.intersection(&template_ids).copied().collect();
        if !clash.is_empty() {
            issues.push(format!(
                "knowledge.json 与 templates.json 条目 id 冲突: {clash:?}（单事实源防双源漂移）"
            ));
        }
        let rule_ids: std::collections::BTreeSet<&str> = payload
            .get("rules")
            .and_then(|rules| rules.get("rules"))
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).collect())
            .unwrap_or_default();
        let clash: Vec<&str> = knowledge_ids.intersection(&rule_ids).copied().collect();
        if !clash.is_empty() {
            issues.push(format!(
                "knowledge.json 与 rules.json id 冲突: {clash:?}"
            ));
        }
    }
}

fn check_signals(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let kinds: Vec<&str> = data
        .get("signal_kinds")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.get("kind").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    if kinds != SIGNAL_KINDS {
        issues.push(format!("信号类别应恰好为 {SIGNAL_KINDS:?}，实际 {kinds:?}"));
    }
    if let Some(items) = data.get("signal_kinds").and_then(Value::as_array) {
        let by_kind: std::collections::HashMap<&str, &Value> = items
            .iter()
            .filter_map(|item| item.get("kind").and_then(Value::as_str).map(|kind| (kind, item)))
            .collect();
        for kind in ["pitfall", "gap", "repeated_root_cause"] {
            if let Some(item) = by_kind.get(kind) {
                let produced = item.get("produced_kind");
                if produced.is_some() && !matches!(produced, Some(Value::Null)) {
                    issues.push(format!("信号 {kind} 不直接产出知识（produced_kind 应为 null）"));
                }
            }
        }
        for kind in ["user_correction", "insight"] {
            if let Some(item) = by_kind.get(kind) {
                let produced = item.get("produced_kind").and_then(Value::as_str).unwrap_or("");
                if produced != "rule" {
                    issues.push(format!("信号 {kind} 应蒸馏为 rule 条目"));
                }
            }
        }
    }
    let distill = data.get("distill").and_then(Value::as_object);
    let threshold = |key: &str| distill.and_then(|map| map.get(key)).and_then(Value::as_u64);
    if threshold("complexity_threshold") != Some(DISTILL_COMPLEXITY_THRESHOLD) {
        issues.push(format!("蒸馏复杂度阈值应为 {DISTILL_COMPLEXITY_THRESHOLD}"));
    }
    if threshold("intervention_threshold") != Some(DISTILL_INTERVENTION_THRESHOLD) {
        issues.push(format!("蒸馏干预阈值应为 {DISTILL_INTERVENTION_THRESHOLD}"));
    }
    if threshold("repeat_threshold") != Some(REPEAT_THRESHOLD) {
        issues.push(format!("重复根因升级阈值应为 {REPEAT_THRESHOLD}"));
    }
}

fn check_tiers(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let tiers: Vec<&str> = data
        .get("tiers")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !unique(&tiers) || tiers.is_empty() {
        issues.push("挡位清单应为非空且无重复".to_string());
    }
    if !tiers.contains(&"main") {
        issues.push("挡位清单须含 main（引擎未知挡位回落锚点）".to_string());
    }
    if data.get("default_tier").and_then(Value::as_str) != Some("main") {
        issues.push("缺省挡位应为 main（引擎 tier_key 未知回落语义）".to_string());
    }
    let model_config = data.get("model_config").and_then(Value::as_object);
    let config_keys: Vec<String> = tiers.iter().map(|tier| format!("{tier}_config")).collect();
    if let Some(model_config) = model_config {
        let actual_keys: Vec<String> = model_config.keys().cloned().collect();
        let mut sorted_actual = actual_keys.clone();
        sorted_actual.sort();
        let mut sorted_expected = config_keys.clone();
        sorted_expected.sort();
        if sorted_actual != sorted_expected {
            issues.push(format!(
                "model_config 键应恰好为各挡位 {config_keys:?}，实际 {actual_keys:?}"
            ));
        }
        for key in &config_keys {
            let entry = model_config.get(key).and_then(Value::as_object);
            let purpose = entry
                .and_then(|map| map.get("purpose"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let requires_user_config = entry
                .and_then(|map| map.get("requires_user_config"))
                .and_then(Value::as_bool);
            if purpose.is_empty() || requires_user_config.is_none() {
                issues.push(format!("挡位 {key} 须声明 purpose 与 requires_user_config"));
            }
        }
    }
    if data
        .get("fallback")
        .and_then(Value::as_object)
        .and_then(|fallback| fallback.get("unknown_tier_falls_to"))
        .and_then(Value::as_str)
        != Some("main")
    {
        issues.push("未知挡位应回落 main".to_string());
    }
    if data
        .get("fallback")
        .and_then(Value::as_object)
        .and_then(|fallback| fallback.get("missing_tier_config_falls_to"))
        .and_then(Value::as_str)
        != Some("main_config")
    {
        issues.push("缺挡位配置应回落 main_config".to_string());
    }
}

fn check_review(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let number = |key: &str| data.get(key).and_then(Value::as_f64);
    if number("pass_threshold") != Some(REVIEW_PASS_THRESHOLD) {
        issues.push(format!("pass_threshold 应为 {REVIEW_PASS_THRESHOLD}"));
    }
    let integer = |key: &str| data.get(key).and_then(Value::as_u64);
    if integer("max_rounds") != Some(REVIEW_MAX_ROUNDS) {
        issues.push(format!("max_rounds 应为 {REVIEW_MAX_ROUNDS}"));
    }
    if integer("beam_width") != Some(REVIEW_BEAM_WIDTH) {
        issues.push(format!("beam_width 应为 {REVIEW_BEAM_WIDTH}"));
    }
    if number("neutral_score") != Some(REVIEW_NEUTRAL_SCORE) {
        issues.push(format!("neutral_score 应为 {REVIEW_NEUTRAL_SCORE}"));
    }
    let total: f64 = data
        .get("dimensions")
        .and_then(Value::as_array)
        .map(|dimensions| {
            dimensions
                .iter()
                .filter_map(|dimension| dimension.get("weight").and_then(Value::as_f64))
                .sum()
        })
        .unwrap_or(0.0);
    if (total - 1.0).abs() > 1e-6 {
        issues.push(format!("评审维度权重之和应为 1.0，实际 {total:.4}"));
    }
}

fn check_memory(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    if data.get("policy").and_then(Value::as_str) != Some("PriorityRecallPolicy") {
        issues.push("记忆召回策略应为 PriorityRecallPolicy（引擎默认确定性召回）".to_string());
    }
    let window = data
        .get("expiry")
        .and_then(Value::as_object)
        .and_then(|expiry| expiry.get("default_window_days"))
        .and_then(Value::as_u64);
    if window != Some(MEMORY_DEFAULT_WINDOW_DAYS) {
        issues.push(format!("记忆失效窗口应为 {MEMORY_DEFAULT_WINDOW_DAYS} 天"));
    }
}

fn check_env(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let environments = data.get("environments").and_then(Value::as_array);
    let Some(environments) = environments else { return };
    let names: Vec<&str> = environments
        .iter()
        .filter_map(|env| env.get("name").and_then(Value::as_str))
        .collect();
    if !unique(&names) {
        issues.push("env.json 存在重复环境名".to_string());
    }
    let runtimes: Vec<&str> = environments
        .iter()
        .filter_map(|env| env.get("runtime").and_then(Value::as_str))
        .collect();
    if !same_set(&runtimes, &ENV_RUNTIMES) {
        issues.push(format!("环境 runtime 应覆盖 {ENV_RUNTIMES:?}，实际 {runtimes:?}"));
    }
    for env in environments {
        let name = env.get("name").and_then(Value::as_str).unwrap_or("（无名）");
        let versioned = env
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|meta| meta.get("versioned_by_patch_chain"))
            .and_then(Value::as_bool);
        if versioned != Some(true) {
            issues.push(format!("环境 {name} 未声明补丁链版本化（versioned_by_patch_chain 应为 true）"));
        }
        if env.get("runtime").and_then(Value::as_str) == Some("container") {
            let image_name = env
                .get("meta")
                .and_then(Value::as_object)
                .and_then(|meta| meta.get("image"))
                .and_then(Value::as_object)
                .and_then(|image| image.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if image_name.is_empty() {
                issues.push(format!("容器环境 {name} 须声明 meta.image.name（镜像描述 = 数据，随补丁链版本化）"));
            }
        }
    }
}

fn check_build(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    let allowlist = data
        .get("builder")
        .and_then(Value::as_object)
        .and_then(|builder| builder.get("allowlist"))
        .and_then(Value::as_array);
    let allowlist_ok = allowlist.map_or(false, |list| {
        let entries: Vec<&str> = list.iter().filter_map(Value::as_str).collect();
        !entries.is_empty() && entries.len() == list.len() && unique(&entries)
    });
    if !allowlist_ok {
        issues.push("build.json builder.allowlist 为空或含重复/非字符串命令（构建命令白名单不可空，fail-closed）".to_string());
    }
    let default_probe = data
        .get("smoke_probes")
        .and_then(Value::as_object)
        .and_then(|probes| probes.get("default"))
        .and_then(Value::as_object);
    let probe_command = default_probe
        .and_then(|probe| probe.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let in_allowlist = allowlist.map_or(false, |list| {
        list.iter().any(|entry| entry.as_str() == Some(probe_command))
    });
    if probe_command.is_empty() || !in_allowlist {
        issues.push("build.json 缺省冒烟探针命令须在构建白名单内（探针经同一沙箱执行）".to_string());
    }
    let target = data
        .get("deploy")
        .and_then(Value::as_object)
        .and_then(|deploy| deploy.get("target_runtime"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if !ENV_RUNTIMES.contains(&target) {
        issues.push(format!("build.json deploy.target_runtime 应为 {ENV_RUNTIMES:?} 之一，实际 {target:?}"));
    }
}

fn check_mcp_market(data: &Value, _payload: &Payload, issues: &mut Vec<String>) {
    if data.get("premounted").and_then(Value::as_bool) != Some(false) {
        issues.push("mcp_market 出厂必须零预挂（premounted 应为 false）".to_string());
    }
    let servers = data.get("servers").and_then(Value::as_array);
    let Some(servers) = servers else { return };
    let ids: Vec<&str> = servers
        .iter()
        .filter_map(|server| server.get("id").and_then(Value::as_str))
        .collect();
    if !unique(&ids) {
        issues.push("mcp_market 存在重复 server id".to_string());
    }
    let categories: std::collections::BTreeSet<&str> = servers
        .iter()
        .filter_map(|server| server.get("category").and_then(Value::as_str))
        .collect();
    for expected in ["web_fetch", "web_search", "file_system"] {
        if !categories.contains(expected) {
            issues.push(format!("市场示例应含 {expected} 类（web 抓取/搜索/文件系统）"));
        }
    }
    for server in servers {
        let id = server.get("id").and_then(Value::as_str).unwrap_or("（无名）");
        if server.get("premounted").and_then(Value::as_bool) != Some(false) {
            issues.push(format!("市场条目 {id} 不得预挂"));
        }
        let transport = server.get("transport").and_then(Value::as_str).unwrap_or("");
        let url = server.get("url").and_then(Value::as_str).unwrap_or("");
        let command = server.get("command").and_then(Value::as_str).unwrap_or("");
        if transport == "http" && url.is_empty() {
            issues.push(format!("市场条目 {id} http 传输缺 url"));
        }
        if transport == "stdio" && command.is_empty() {
            issues.push(format!("市场条目 {id} stdio 传输缺 command"));
        }
    }
}

/// 解析前端 eventTypes.ts 中 `EVENT_TYPE_NAMES = [...]` 的字符串字面量清单
/// （文本扫描，零依赖；与事件类型注册表镜像表同源比对）。
fn parse_frontend_event_names(source: &str) -> Vec<String> {
    let Some(start) = source.find("EVENT_TYPE_NAMES = [") else {
        return Vec::new();
    };
    let rest = &source[start + "EVENT_TYPE_NAMES = [".len()..];
    let end = rest.find("] as const").unwrap_or(rest.len());
    let body = &rest[..end];
    let mut names = Vec::new();
    let mut cursor = 0;
    while cursor < body.len() {
        let Some(quote) = body[cursor..].find('\'') else {
            break;
        };
        let after_quote = cursor + quote + 1;
        let Some(end) = body[after_quote..].find('\'') else {
            break;
        };
        names.push(body[after_quote..after_quote + end].to_string());
        cursor = after_quote + end + 1;
    }
    names
}

/// 三方事件清单一致：seed event_types.json（权威）↔ 前端镜像表 eventTypes.ts
/// ↔ 前端夹具 event_types.fixture.json——防事件类型再漂移。
fn check_event_types_consistency(repo_root: &Path, payload: &Payload, issues: &mut Vec<String>) {
    let seed_names: Vec<&str> = payload
        .get("event_types")
        .and_then(|types| types.get("events"))
        .and_then(Value::as_array)
        .map(|events| {
            events
                .iter()
                .filter_map(|event| event.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let mirror_path = repo_root.join("inkling/frontend/src/shared/session/eventTypes.ts");
    let mirror_source = match std::fs::read_to_string(&mirror_path) {
        Ok(source) => source,
        Err(err) => {
            issues.push(format!("前端事件镜像表读取失败 {}: {err}", mirror_path.display()));
            return;
        }
    };
    let mirror_names = parse_frontend_event_names(&mirror_source);
    if mirror_names.is_empty() {
        issues.push("前端事件镜像表未解析到 EVENT_TYPE_NAMES 清单".to_string());
    }
    let missing_in_mirror: Vec<&str> = seed_names
        .iter()
        .copied()
        .filter(|name| !mirror_names.iter().any(|m| m == name))
        .collect();
    if !missing_in_mirror.is_empty() {
        issues.push(format!(
            "事件清单不一致：seed 有而前端镜像表缺 {missing_in_mirror:?}"
        ));
    }
    let extra_in_mirror: Vec<&str> = mirror_names
        .iter()
        .map(String::as_str)
        .filter(|name| !seed_names.contains(name))
        .collect();
    if !extra_in_mirror.is_empty() {
        issues.push(format!(
            "事件清单不一致：前端镜像表有而 seed 缺 {extra_in_mirror:?}（seed 为权威，须先登记 seed）"
        ));
    }
    let fixture_path = repo_root.join("inkling/frontend/src/data/event_types.fixture.json");
    match load_json(&fixture_path) {
        Ok(fixture) => {
            let fixture_names: Vec<&str> = fixture
                .get("event_types")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.get("name").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            let missing_in_fixture: Vec<&str> = seed_names
                .iter()
                .copied()
                .filter(|name| !fixture_names.contains(name))
                .collect();
            if !missing_in_fixture.is_empty() {
                issues.push(format!(
                    "事件清单不一致：seed 有而前端夹具缺 {missing_in_fixture:?}"
                ));
            }
            let extra_in_fixture: Vec<&str> = fixture_names
                .iter()
                .copied()
                .filter(|name| !seed_names.contains(name))
                .collect();
            if !extra_in_fixture.is_empty() {
                issues.push(format!(
                    "事件清单不一致：前端夹具含 seed 无的事件 {extra_in_fixture:?}"
                ));
            }
        }
        Err(err) => issues.push(err),
    }
}

/// 档位单源：壳侧运行时数据资产 tools_os.json 的权限档必须等于 seed
/// tools.json 的 approval 档（同一能力同一档位，防按调用路径分叉）。
fn check_tool_tier_single_source(repo_root: &Path, payload: &Payload, issues: &mut Vec<String>) {
    let decl_path = repo_root.join("inkling/shell/src-tauri/fixtures/tools_os.json");
    let decls = match load_json(&decl_path) {
        Ok(value) => value,
        Err(err) => {
            issues.push(err);
            return;
        }
    };
    let Some(decl_tools) = decls.get("tools").and_then(Value::as_array) else {
        issues.push("tools_os.json 缺 tools 清单".to_string());
        return;
    };
    let seed_tools = payload
        .get("tools")
        .and_then(|tools| tools.get("tools"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let seed_tier_of = |name: &str| -> Option<&str> {
        seed_tools.iter().find_map(|tool| {
            if tool.get("name").and_then(Value::as_str) == Some(name) {
                tool.get("approval").and_then(Value::as_str)
            } else {
                None
            }
        })
    };
    for tool in decl_tools {
        let name = tool.get("name").and_then(Value::as_str).unwrap_or("");
        let declared = tool.get("permission").and_then(Value::as_str).unwrap_or("");
        let seed_tier = seed_tier_of(name);
        match seed_tier {
            Some(seed) if seed != declared => issues.push(format!(
                "档位双源：壳侧 tools_os.json {name} 档位 {declared:?} ≠ seed tools.json {seed:?}（seed 为唯一权威档位源）"
            )),
            None => issues.push(format!(
                "档位单源：壳侧 tools_os.json {name} 在 seed tools.json 无对应条目（工具登记漂移）"
            )),
            _ => {}
        }
    }
}

fn unique<T: PartialEq>(items: &[T]) -> bool {
    for (index, item) in items.iter().enumerate() {
        if items.iter().skip(index + 1).any(|other| other == item) {
            return false;
        }
    }
    true
}

fn same_set(actual: &[&str], expected: &[&str]) -> bool {
    actual.len() == expected.len()
        && expected.iter().all(|item| actual.contains(item))
}

// ── 校验编排 ──

pub struct SchemaReport {
    pub issues: Vec<String>,
    pub facts: Vec<String>,
}

/// 执行全量 schema 校验（数据一致性 + 引擎事实 + 自检夹具）。
pub fn run(repo_root: &Path) -> SchemaReport {
    let mut issues: Vec<String> = Vec::new();
    let mut facts: Vec<String> = Vec::new();
    let inkling_root = repo_root.join("inkling");
    let seed_data_dir = inkling_root.join("seed_data");
    let manifest_path = inkling_root.join("manifest.json");

    let mut missing: Vec<&str> = Vec::new();
    for name in EXPECTED_SEED_FILES {
        if !seed_data_dir.join(name).exists() {
            missing.push(name);
        }
    }
    if !manifest_path.exists() {
        issues.push(format!("缺失 manifest 文件: {}", manifest_path.display()));
    }
    if !missing.is_empty() {
        issues.push(format!("缺失 seed_data 文件: {missing:?}"));
    }

    // 引擎源码事实（只读，不改动引擎；先于跨文件检查供 manifest 锁定核对）
    let runtime_path = repo_root.join("ink_engine/ink_engine/core/runtime.py");
    let pyproject_path = repo_root.join("ink_engine/pyproject.toml");
    match count_assembly_recipe_fields(&runtime_path) {
        Some(count) if count == ASSEMBLY_RECIPE_FIELD_COUNT => {
            facts.push(format!(
                "AssemblyRecipe 字段数 = {count}（以 runtime.py 源码为准）"
            ));
        }
        Some(count) => issues.push(format!(
            "AssemblyRecipe 实际 {count} 字段，与常量 {ASSEMBLY_RECIPE_FIELD_COUNT} 不符（以 runtime.py 源码为准；若引擎字段已增删请更新本常量）"
        )),
        None => issues.push(format!("无法核实 AssemblyRecipe 字段数（未找到 {}）", runtime_path.display())),
    }
    let engine_version = read_engine_version(&pyproject_path);
    match &engine_version {
        Some(version) => facts.push(format!("engine_version = {version}（pyproject.toml）")),
        None => issues.push(format!("无法核实引擎版本（未找到 {}）", pyproject_path.display())),
    }

    let mut payload = Payload {
        manifest: Value::Null,
        engine_version,
        files: Vec::new(),
    };
    if manifest_path.exists() {
        match load_json(&manifest_path) {
            Ok(value) => payload.manifest = value,
            Err(err) => issues.push(err),
        }
    }
    for name in EXPECTED_SEED_FILES {
        match load_json(&seed_data_dir.join(name)) {
            Ok(value) => payload.files.push((name.trim_end_matches(".json").to_string(), value)),
            Err(err) => issues.push(err),
        }
    }

    // 逐文件 schema 校验（缺失/多余/类型/空值边界；manifest 一并校验）
    let mut schema_names: Vec<String> = EXPECTED_SEED_FILES
        .iter()
        .map(|name| format!("{}.schema.json", name.trim_end_matches(".json")))
        .collect();
    schema_names.push("manifest.schema.json".to_string());
    let missing_schemas: Vec<String> = schema_names
        .into_iter()
        .filter(|name| !SCHEMA_FILES.iter().any(|(known, _)| known == name))
        .collect();
    if !missing_schemas.is_empty() {
        issues.push(format!("缺失 schema 定义: {missing_schemas:?}"));
    }
    if !payload.manifest.is_null() {
        validate_against_schema("manifest", &payload.manifest, &mut issues);
    }
    for (name, value) in &payload.files {
        validate_against_schema(name, value, &mut issues);
    }

    // 跨文件一致性检查（防双源漂移）
    if !payload.manifest.is_null() {
        check_manifest(&payload.manifest, &payload, &mut issues);
        let boot_prompt = payload.get("boot_prompt");
        if let Some(boot_prompt) = boot_prompt {
            let prompt = boot_prompt.get("prompt").and_then(Value::as_str).unwrap_or("");
            if prompt != BOOT_PROMPT_FINAL {
                issues.push("boot_prompt.json 未使用自举提示词定稿原文".to_string());
            }
        }
    }
    for (name, checker) in [
        ("ui_spec", check_ui_spec as fn(&Value, &Payload, &mut Vec<String>)),
        ("event_types", check_event_types),
        ("graph", check_graph),
        ("workflow", check_workflow),
        ("tools", check_tools),
        ("rules", check_rules),
        ("samples", check_samples),
        ("templates", check_templates),
        ("knowledge", check_knowledge),
        ("signals", check_signals),
        ("tiers", check_tiers),
        ("review", check_review),
        ("memory", check_memory),
        ("env", check_env),
        ("build", check_build),
        ("mcp_market", check_mcp_market),
    ] {
        if let Some(data) = payload.get(name) {
            checker(data, &payload, &mut issues);
        }
    }

    // 出厂补充文件（路径组装语料）结构检查：合法 JSON 对象即可
    for extra in ["path_prompts", "path_seeds"] {
        match load_json(&seed_data_dir.join(format!("{extra}.json"))) {
            Ok(Value::Object(_)) => {}
            Ok(_) => issues.push(format!("{extra}.json 顶层应为对象（路径组装语料）")),
            Err(err) => issues.push(err),
        }
    }

    // 跨仓一致性门禁：事件类型三方清单（seed 权威）+ 工具档位单源
    check_event_types_consistency(repo_root, &payload, &mut issues);
    check_tool_tier_single_source(repo_root, &payload, &mut issues);

    // 校验器自检夹具：正例全通过、反例全部命中（防检查器自身失效）
    let fixture_problems = run_validator_fixtures();
    issues.extend(fixture_problems);

    if issues.is_empty() {
        facts.insert(
            0,
            format!(
                "全绿：{} 个 seed_data 文件 schema 校验通过，跨文件一致性通过，自检夹具通过。",
                EXPECTED_SEED_FILES.len()
            ),
        );
    }
    SchemaReport { issues, facts }
}

/// 内嵌 schema 定义（随 crate 编译打包，二进制自包含）。
const SCHEMA_FILES: [(&str, &str); 18] = [
    ("manifest.schema.json", include_str!("../schemas/manifest.schema.json")),
    ("boot_prompt.schema.json", include_str!("../schemas/boot_prompt.schema.json")),
    ("ui_spec.schema.json", include_str!("../schemas/ui_spec.schema.json")),
    ("event_types.schema.json", include_str!("../schemas/event_types.schema.json")),
    ("graph.schema.json", include_str!("../schemas/graph.schema.json")),
    ("tools.schema.json", include_str!("../schemas/tools.schema.json")),
    ("rules.schema.json", include_str!("../schemas/rules.schema.json")),
    ("samples.schema.json", include_str!("../schemas/samples.schema.json")),
    ("templates.schema.json", include_str!("../schemas/templates.schema.json")),
    ("knowledge.schema.json", include_str!("../schemas/knowledge.schema.json")),
    ("workflow.schema.json", include_str!("../schemas/workflow.schema.json")),
    ("signals.schema.json", include_str!("../schemas/signals.schema.json")),
    ("tiers.schema.json", include_str!("../schemas/tiers.schema.json")),
    ("review.schema.json", include_str!("../schemas/review.schema.json")),
    ("memory.schema.json", include_str!("../schemas/memory.schema.json")),
    ("env.schema.json", include_str!("../schemas/env.schema.json")),
    ("mcp_market.schema.json", include_str!("../schemas/mcp_market.schema.json")),
    ("build.schema.json", include_str!("../schemas/build.schema.json")),
];

fn validate_against_schema(key: &str, data: &Value, issues: &mut Vec<String>) {
    let schema_name = format!("{key}.schema.json");
    let Some(schema_text) = SCHEMA_FILES
        .iter()
        .find(|(name, _)| *name == schema_name)
        .map(|(_, text)| *text)
    else {
        return;
    };
    let Ok(schema) = serde_json::from_str::<Value>(schema_text) else {
        issues.push(format!("{schema_name}: schema 定义非法（JSON 解析失败）"));
        return;
    };
    let validator = match MiniValidator::new(&schema) {
        Ok(validator) => validator,
        Err(err) => {
            issues.push(format!("{schema_name}: schema 定义非法——{err}"));
            return;
        }
    };
    validator.validate(data, &schema, key, issues);
}

/// 自检夹具：检查器自身的行为验证（正例应零违规、反例应精确命中）。
fn run_validator_fixtures() -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    let base_schema = serde_json::json!({
        "type": "object",
        "required": ["name", "count"],
        "additionalProperties": false,
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "count": {"type": "integer", "minimum": 0},
            "mode": {"type": "string", "enum": ["a", "b"]},
            "items": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string"}},
            "child": {"$ref": "#/definitions/child"}
        },
        "definitions": {"child": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}}
    });
    let validator = match MiniValidator::new(&base_schema) {
        Ok(validator) => validator,
        Err(err) => {
            return vec![format!("自检夹具 schema 非法: {err}")];
        }
    };
    let mut expect = |instance: &Value, expected_count: usize, label: &str| {
        let mut violations = Vec::new();
        validator.validate(instance, &base_schema, label, &mut violations);
        if violations.len() != expected_count {
            problems.push(format!(
                "自检夹具 {label}: 期望 {expected_count} 条违规，实际 {} 条: {violations:?}",
                violations.len()
            ));
        }
    };
    expect(&serde_json::json!({"name": "x", "count": 0, "mode": "a", "items": ["i"], "child": {"id": "c"}}), 0, "positive_ok");
    expect(&serde_json::json!({"count": 1}), 1, "missing_required");
    expect(&serde_json::json!({"name": "x", "count": 1, "extra": true}), 1, "extra_field");
    expect(&serde_json::json!({"name": 1, "count": 1}), 1, "wrong_type");
    expect(&serde_json::json!({"name": "x", "count": 1, "mode": "z"}), 1, "enum_violation");
    expect(&serde_json::json!({"name": "", "count": 1}), 1, "empty_string");
    expect(&serde_json::json!({"name": "x", "count": -1}), 1, "below_minimum");
    expect(&serde_json::json!({"name": "x", "count": 1, "items": []}), 1, "empty_array");
    expect(&serde_json::json!({"name": "x", "count": 1, "items": ["a", "a"]}), 1, "duplicate_items");
    expect(&serde_json::json!({"name": "x", "count": 1, "child": {}}), 1, "ref_missing_required");
    if MiniValidator::new(&serde_json::json!({"$ref": "#/definitions/ghost"})).is_ok() {
        problems.push("自检夹具 bad_ref: 应拒绝指向不存在 definitions 的 $ref 但未拒绝".to_string());
    }
    // 模式匹配子集自检（seed_data 全部 pattern 形态的代表样例）
    for (pattern, text, should_match) in [
        ("^[a-z][a-z0-9_]*$", "collect_material", true),
        ("^[a-z][a-z0-9_]*$", "has-dash", false),
        ("^[0-9]+\\.[0-9]+\\.[0-9]+$", "0.1.0", true),
        ("^[0-9]+\\.[0-9]+\\.[0-9]+$", "0.1", false),
        ("^#[0-9a-fA-F]{6}$", "#09090b", true),
        ("^#[0-9a-fA-F]{6}$", "#09090", false),
    ] {
        let actual = crate::validator::pattern_matches(pattern, text);
        if actual != should_match {
            problems.push(format!(
                "自检夹具 pattern {pattern:?} 对 {text:?} 期望 {should_match}，实际 {actual}"
            ));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn schema_gate_is_green_on_current_seed_data() {
        let report = run(&repo_root());
        assert!(
            report.issues.is_empty(),
            "schema 门禁应在出厂数据上全绿，实际违规:\n{}",
            report.issues.join("\n")
        );
    }

    #[test]
    fn engine_fact_counter_counts_annotated_fields() {
        let source = "from dataclasses import dataclass\n@dataclass\nclass AssemblyRecipe:\n    a: int = 1\n    b: str = ''\n    c: dict | None = None\n    _hidden: bool = False\n";
        let dir = std::env::temp_dir().join(format!("selfcheck-fact-{}", uuid_like()));
        std::fs::create_dir_all(&dir).expect("临时目录创建失败");
        let path = dir.join("runtime.py");
        std::fs::write(&path, source).expect("临时文件写入失败");
        assert_eq!(count_assembly_recipe_fields(&path), Some(3));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        format!(
            "{:?}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        )
    }
}

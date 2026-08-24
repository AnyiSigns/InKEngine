//! boot 域：装配编排层——机制装配之上的宿主接线（幂等可重放）。
//!
//! 引擎机制装配（[`crate::engine::host::EngineHost::boot`] → 嵌入式装配
//! 域包的 `boot_inkling`）保持原样完成：运行时装配、种子注入、harness
//! 登记、事件类型基线、补丁链基线与引擎内建链恢复。本模块在其后叠加
//! 宿主侧接线：
//! - 安全纵深安装（三档门禁流水线替换 + 文件工具占位根注册 + 授权恢复）；
//! - 活跃态目标注册（五类配方目标 + 引擎内置 TOOL/EVENT_TYPE）；
//! - 链段恢复重放（环境声明、产物声明工具、MCP 挂载登记、界面/主题/
//!   harness/知识活跃态）；
//! - 种子重注入（链恢复整体替换知识集实例后，出厂基线按 id 查重补挂）；
//! - 引擎路径装配机制开关透传（七块 feature flag 随 BootOptions 携带，
//!   默认全关；装配层收敛为按名 JSON 装配数据，引擎侧按名读取）；
//! - 内省源刷新与引擎重建收尾。
//!
//! 全部接线动作幂等可重放：重复执行不改变最终状态；本模块是装配编排
//! 的完整接管点（机制装配在嵌入式装配域包内，装配后的宿主接线全部
//! 经本模块）。失败语义 fail-closed（结构化错误含步骤名与原因，不
//! panic）；live 视图重放例外——各段独立容错，坏段跳过不击穿。
//! 入口为一次性装配调用（重复装配由引擎幂等语义兜底）。
//!
//! 依赖纪律：本模块是唯一装配编排点，只调用各域的冻结装配签名与引擎
//! 操作通道（`call_engine_op` / `call_engine_op_async`），域间不互调。

use std::collections::{HashMap, HashSet};

use pyo3::PyResult;
use serde_json::{json, Value as JsonValue};

use super::common::{readable_path, DomainError};
use super::{build, env, live, mcp, recipe, security};
use crate::engine::host::{
    call_engine_op, call_engine_op_async, BootOptions, EngineHost, PathAssemblyFlags,
};

/// 种子根目录名（seed_data/manifest 所在目录；与引擎桥装配口径一致）。
const SEED_DIR_NAME: &str = "inkling";

/// 集补丁链记录集合/键（版本号 = 补丁数 + 1；空链 = 版本 1）。
const SET_CHAIN_COLLECTION: &str = "set_patch_chain";
const SET_CHAIN_KEY: &str = "chain";

/// 引擎内置活跃态目标种类（配方五类之外由引擎自注册的目标）。
const BUILTIN_TARGET_KINDS: [&str; 2] = ["tool", "event_type"];

/// 规则条目标题截断上限（规则消息超长时截断，与 RULE 活跃态目标同口径）。
const RULE_TITLE_MAX_CHARS: usize = 80;

/// 装配报告：装配结果的观测形态（工具/事件类型清单、链版本、注入量、
/// 目标种类——宿主观测与门禁断言用）。
#[derive(Debug, Clone)]
pub struct AssemblyReport {
    pub tool_names: Vec<String>,
    pub event_types: Vec<String>,
    pub chain_version: i64,
    pub seeds_injected: usize,
    pub seeds_present: usize,
    pub target_kinds: Vec<String>,
}

/// 结构化失败（步骤名 + 原因；产品可读的叙述口吻，fail-closed 入口共用）。
fn fail(step: &str, reason: impl Into<String>) -> String {
    format!("装配失败：步骤「{step}」——{}", reason.into())
}

// ── 种子装载与引擎机制装配 ──

/// 装载种子数据（seed_root = 仓库根/inkling；缺文件/坏 JSON 显式报错）。
fn load_seed(options: &BootOptions) -> Result<recipe::SeedDataBundle, String> {
    let repo_root = readable_path(options.repo_root.clone());
    let seed_root = repo_root.join(SEED_DIR_NAME);
    recipe::load_seed_data(&seed_root)
        .map_err(|err| fail("装载种子数据", err.to_string()))
}

/// 引擎机制装配（Python 侧 boot_inkling；重复调用由引擎幂等语义兜底）。
fn boot_host(options: &BootOptions) -> Result<EngineHost, String> {
    EngineHost::boot(options.clone()).map_err(|err| fail("引擎机制装配", err))
}

// ── 安全纵深接线 ──

/// 安全域接线：三档门禁流水线替换 + 文件工具占位根注册 + 授权恢复。
///
/// 引擎侧效果经操作通道持久（门禁/沙箱回调注册、流水线替换、文件工具
/// 定义注册）；本步失败 = 装配整体失败（安全纵深是装配的硬前提）。
async fn wire_security(bundle: &recipe::SeedDataBundle) -> Result<(), String> {
    let security = security::SecurityDomain::from_tool_data(bundle.file("tools.json"))
        .map_err(|err| fail("安全域装载", err.to_string()))?;
    security
        .apply_to_runtime()
        .await
        .map_err(|err| fail("安全流水线接线", err))?;
    security
        .reregister_file_tools(None)
        .await
        .map_err(|err| fail("文件工具重注册", err))?;
    security::load_authorization(&security)
        .await
        .map_err(|err| fail("工作区授权恢复", err))?;
    Ok(())
}

// ── 联网搜索接线 ──

/// 联网搜索执行体回调注册（web_search 工具的宿主执行路径）。
///
/// Python 宿主执行体经 JSON 回调桥调用本回调；搜索实现 = 壳侧域
/// （本地聚合源默认 / 用户自配厂商 key 降级），回调按调用参数执行
/// 并返回结构化结果 JSON。key 缺省 = 本地聚合源（免费无 key）。
async fn wire_web_search() -> Result<(), String> {
    crate::engine::bridge::register_callback(
        "host.web_search",
        Box::new(|payload: String| -> PyResult<String> {
            let args: JsonValue = serde_json::from_str(&payload)
                .map_err(|err| pyo3::exceptions::PyValueError::new_err(err.to_string()))?;
            let keys = args
                .get("keys")
                .map(super::web_search::parse_search_keys)
                .unwrap_or_default();
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|err| pyo3::exceptions::PyRuntimeError::new_err(err.to_string()))?;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(super::web_search::SEARCH_TIMEOUT_SECS))
                .build()
                .map_err(|err| pyo3::exceptions::PyRuntimeError::new_err(err.to_string()))?;
            Ok(rt.block_on(super::web_search::search_tool(
                &client,
                &args,
                &keys,
            )))
        }),
    )
    .map_err(|err| fail("联网搜索回调注册", err.to_string()))?;
    Ok(())
}

// ── 活跃态目标注册 ──

/// 活跃态目标注册：五类配方目标 + 引擎内置 TOOL/EVENT_TYPE。
async fn wire_live_targets() -> Result<(), String> {
    live::register_live_targets()
        .await
        .map_err(|err| fail("活跃态目标注册", err))?;
    call_engine_op("patch.apply_target_register", json!({ "kind": "tool" }))
        .map_err(|err| fail("引擎内置目标注册（tool）", err))?;
    call_engine_op("patch.apply_target_register", json!({ "kind": "event_type" }))
        .map_err(|err| fail("引擎内置目标注册（event_type）", err))?;
    Ok(())
}

// ── 链组装与段恢复 ──

/// 链组装：补丁链最新态全量（段名：environments/artifacts/tools/ui/
/// theme/harness/knowledge/rules/event_types）。
async fn assemble_chain() -> Result<JsonValue, String> {
    call_engine_op_async("engine.chain_assemble", json!({}))
        .await
        .map_err(|err| fail("链组装", err))
}

/// 组装段 → 字符串映射（链段数据形态；缺段/非对象 = 空映射）。
fn object_map(value: Option<&JsonValue>) -> HashMap<String, JsonValue> {
    value
        .and_then(JsonValue::as_object)
        .map(|map| map.iter().map(|(key, v)| (key.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// 环境段恢复：声明全景 = 基线（env.json）叠加链补丁增量（链为权威）。
async fn restore_environments(
    env_domain: &env::EnvironmentDomain,
    assembled: &JsonValue,
) -> Result<(), String> {
    let patch_values = object_map(assembled.get("environments"));
    env_domain.restore(&patch_values).await;
    Ok(())
}

/// 产物段恢复：链内产物的声明工具注册进工具表（链外移除由域内维护）。
async fn sync_artifacts(
    build_domain: &build::BuildDomain,
    assembled: &JsonValue,
) -> Result<(), String> {
    let artifacts = object_map(assembled.get("artifacts"));
    build_domain
        .sync_artifact_tools(&artifacts)
        .await
        .map_err(|err| fail("产物段恢复", err))
}

/// MCP 挂载登记恢复计划：链内 mcp 端点工具的 server 去重清单。
///
/// 挂载登记为会话态内存数据：重启后补丁 id 序丢失，登记形态 = 空序
/// 占位（供卸载/回退判定）；链内无 mcp 工具 = 空清单（不构造任何
/// 半挂载记录）。
fn plan_mcp_mount_restore(assembled: &JsonValue) -> Vec<String> {
    let mut server_ids: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    if let Some(tools) = assembled.get("tools").and_then(JsonValue::as_object) {
        for payload in tools.values() {
            if payload.get("endpoint").and_then(JsonValue::as_str) != Some("mcp") {
                continue;
            }
            let server_id = payload
                .get("endpoint_config")
                .and_then(|v| v.get("server_id"))
                .and_then(JsonValue::as_str);
            if let Some(server_id) = server_id {
                if !server_id.is_empty() && seen.insert(server_id.to_string()) {
                    server_ids.push(server_id.to_string());
                }
            }
        }
    }
    server_ids
}

/// 挂载登记恢复：链内 mcp 工具按 server 回填挂载登记（空序占位）。
fn restore_mcp_mounts(
    mount_service: &mcp::McpMountService,
    assembled: &JsonValue,
) -> Result<(), String> {
    for server_id in plan_mcp_mount_restore(assembled) {
        mount_service.record_mount(&server_id, Vec::new());
    }
    Ok(())
}

// ── 活跃态视图重放（幂等；各段独立容错，坏段跳过不击穿）──

/// 活跃态重放步骤（纯数据规划：链组装态 → 有序重放动作；坏段不进入
/// 计划 = 跳过不击穿；同一组装态重复规划产出完全相同的步骤序）。
#[derive(Debug, Clone, PartialEq)]
pub enum LiveReplayStep {
    /// UI 段：内省界面快照整表替换（ui_spec 形态）。
    UiSpec(JsonValue),
    /// 主题段：token 增量合并进界面快照 theme 段（tokens 形态）。
    ThemeTokens(JsonValue),
    /// harness 段：领域定义登记。
    Harness(JsonValue),
    /// 知识/规则段：条目 upsert（条目经知识契约归一）。
    Knowledge(JsonValue),
}

/// UI 段取用：`boot.panel` 优先，缺省取首项；须携带合法 root 段。
fn plan_ui_spec(ui: Option<&JsonValue>) -> Option<JsonValue> {
    let map = ui.and_then(JsonValue::as_object)?;
    let spec = map
        .get("boot.panel")
        .or_else(|| map.values().next())
        .filter(|v| v.get("root").is_some())?;
    Some(spec.clone())
}

/// 规则段条目归一：规则对象 → kind=rule 知识条目（与 RULE 活跃态目标
/// 的条目形态一致：标题 = 规则消息前 80 字符）。
fn rule_entry_json(rule_id: &str, rule: &JsonValue) -> Option<JsonValue> {
    let message = rule.get("message").and_then(JsonValue::as_str).unwrap_or("");
    let mut title = if message.is_empty() {
        rule_id.to_string()
    } else {
        message.to_string()
    };
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

/// 活跃态重放计划（纯数据变换；步骤序 = ui → theme → harness →
/// knowledge → rules，与引擎内建恢复的分段口径一致）。
pub fn plan_live_replay(assembled: &JsonValue) -> Vec<LiveReplayStep> {
    let mut steps = Vec::new();
    if let Some(spec) = plan_ui_spec(assembled.get("ui")) {
        steps.push(LiveReplayStep::UiSpec(spec));
    }
    if let Some(tokens) = assembled.get("theme") {
        if let Some(map) = tokens.as_object() {
            if !map.is_empty() {
                steps.push(LiveReplayStep::ThemeTokens(tokens.clone()));
            }
        }
    }
    if let Some(harness) = assembled.get("harness").and_then(JsonValue::as_object) {
        for raw in harness.values() {
            if raw.is_object() {
                steps.push(LiveReplayStep::Harness(raw.clone()));
            }
        }
    }
    if let Some(knowledge) = assembled.get("knowledge").and_then(JsonValue::as_object) {
        for raw in knowledge.values() {
            if let Some(entry) = live::parse_knowledge_entry(raw) {
                steps.push(LiveReplayStep::Knowledge(entry));
            }
        }
    }
    if let Some(rules) = assembled.get("rules").and_then(JsonValue::as_object) {
        for (rule_id, rule) in rules {
            if let Some(entry) = rule_entry_json(rule_id, rule) {
                steps.push(LiveReplayStep::Knowledge(entry));
            }
        }
    }
    steps
}

/// 执行活跃态重放（引擎操作通道；单步失败只计跳过数，不击穿装配）。
async fn replay_live_views(assembled: &JsonValue) -> usize {
    let mut skipped = 0usize;
    for step in plan_live_replay(assembled) {
        let (op, args) = match &step {
            LiveReplayStep::UiSpec(spec) => ("engine.introspection_ui_apply", json!({ "ui_spec": spec })),
            LiveReplayStep::ThemeTokens(tokens) => ("engine.introspection_ui_apply", json!({ "tokens": tokens })),
            LiveReplayStep::Harness(definition) => ("engine.harness_register", json!({ "definition": definition })),
            LiveReplayStep::Knowledge(entry) => ("engine.knowledge_upsert", json!({ "entry": entry })),
        };
        if call_engine_op(op, args).is_err() {
            skipped += 1;
        }
    }
    skipped
}

// ── 种子重注入（链恢复后的出厂基线补挂）──

/// 种子注入规划：对 bundle 数据逐条目推导查重/补挂调用的参数形态。
///
/// 引擎链恢复整体替换知识集实例后，出厂基线（内存态、不在链上）随之
/// 丢失——按既定语义「种子 = 启动注入基线，链只承载演化」重注入，并
/// 与链段条目按 id 去重（晋升过的条目已上链，以链态为准不覆盖）。
#[derive(Debug, Clone, PartialEq)]
pub struct SeedInjectionPlan {
    /// 条目 id（查重键）。
    pub id: String,
    /// knowledge_get 调用参数（查重）。
    pub get_args: JsonValue,
    /// knowledge_add 调用参数（补挂；entry 形态与引擎条目契约对齐）。
    pub add_args: JsonValue,
}

/// 知识条目序列化（引擎条目契约字段：身份/层级/类别/数据/来源/可信度/
/// 标题/标签——与 KnowledgeEntry.from_dict 接受的字段形态一致）。
fn seed_entry_json(entry: &recipe::KnowledgeEntry) -> JsonValue {
    json!({
        "id": entry.id,
        "level": entry.level,
        "kind": entry.kind,
        "data": entry.data,
        "source": entry.source,
        "credibility": entry.credibility,
        "title": entry.title,
        "tags": entry.tags,
    })
}

/// 种子注入规划（配方 seeds 直注清单 → 逐条目查重/补挂参数形态）。
pub fn plan_seed_injection(
    bundle: &recipe::SeedDataBundle,
) -> Result<Vec<SeedInjectionPlan>, DomainError> {
    let mut plans = Vec::new();
    for provider in recipe::map_seed_providers(bundle)? {
        for entry in provider.entries {
            plans.push(SeedInjectionPlan {
                id: entry.id.clone(),
                get_args: json!({ "id": entry.id.clone() }),
                add_args: json!({ "entry": seed_entry_json(&entry) }),
            });
        }
    }
    Ok(plans)
}

/// 种子重注入执行：逐条目查重（knowledge_get）→ 缺失补挂（knowledge_add）。
///
/// 返回 (已补挂数, 查重已存在数)——两者之和 = 种子清单总量；机制装配
/// 已注入时补挂为 0（安全网不重复），链恢复吞掉出厂基线时补挂补齐。
async fn reinject_seeds(bundle: &recipe::SeedDataBundle) -> Result<(usize, usize), String> {
    let plans =
        plan_seed_injection(bundle).map_err(|err| fail("种子注入规划", err.to_string()))?;
    let mut injected = 0usize;
    let mut present = 0usize;
    for plan in plans {
        let existing = call_engine_op("engine.knowledge_get", plan.get_args)
            .map_err(|err| fail("种子重注入（查重）", err))?;
        if existing.is_null() {
            call_engine_op("engine.knowledge_add", plan.add_args)
                .map_err(|err| fail("种子重注入（补挂）", err))?;
            injected += 1;
        } else {
            present += 1;
        }
    }
    Ok((injected, present))
}

// ── 收尾与装配报告 ──

/// 收尾：内省源刷新 + 引擎重建（工具表/流水线变更下一回合生效）。
async fn finish_assembly() -> Result<(), String> {
    call_engine_op("engine.introspection_refresh_tool_sources", json!({}))
        .map_err(|err| fail("内省源刷新", err))?;
    call_engine_op_async("engine.rebuild", json!({}))
        .await
        .map_err(|err| fail("引擎重建", err))?;
    Ok(())
}

/// 链版本号（集补丁链记录：版本 = 补丁数 + 1；无记录/无补丁段 = 1）。
pub fn chain_version(record: &JsonValue) -> i64 {
    record
        .get("patches")
        .and_then(JsonValue::as_array)
        .map(|patches| patches.len() as i64 + 1)
        .unwrap_or(1)
}

/// 活跃态目标种类清单（五类配方目标 + 引擎内置两类）。
pub fn target_kinds_declaration() -> Vec<String> {
    let mut kinds: Vec<String> = live::live_target_declarations()
        .iter()
        .filter_map(|d| d.get("kind").and_then(JsonValue::as_str).map(str::to_string))
        .collect();
    kinds.extend(BUILTIN_TARGET_KINDS.iter().map(|k| k.to_string()));
    kinds
}

/// 装配报告组装：工具/事件类型经宿主摘要；链版本按链记录推导。
fn build_report(
    host: &EngineHost,
    chain_record: &JsonValue,
    seeds: (usize, usize),
) -> Result<AssemblyReport, String> {
    let report = host.report().map_err(|err| fail("装配报告", err))?;
    Ok(AssemblyReport {
        tool_names: report.tool_names,
        event_types: report.event_types,
        chain_version: chain_version(chain_record),
        seeds_injected: seeds.0,
        seeds_present: seeds.1,
        target_kinds: target_kinds_declaration(),
    })
}

// ── 引擎路径装配机制装配参数透传 ──

/// 引擎路径装配机制 feature flag 的按名 JSON 装配数据形态（透传契约）。
///
/// 七块开关随 [`BootOptions`] 携带（默认全关），装配层此处收敛为引擎
/// 侧按名读取的键值形态——键名 = 机制语义名（禁计划编号/阶段字眼），
/// 引擎侧装配入口按同名键消费；开关逐位独立，单块可关闭即回滚路径。
pub fn path_assembly_data(flags: &PathAssemblyFlags) -> JsonValue {
    json!({
        "path_assembly_contract_enabled": flags.contract_enabled,
        "path_assembly_edge_evidence_enabled": flags.edge_evidence_enabled,
        "path_assembly_settle_hooks_enabled": flags.settle_hooks_enabled,
        "path_assembly_pool_governance_enabled": flags.pool_governance_enabled,
        "path_assembly_assembler_enabled": flags.assembler_enabled,
        "path_assembly_multipath_enabled": flags.multipath_enabled,
        "path_assembly_fingerprint_cache_enabled": flags.fingerprint_cache_enabled,
    })
}

// ── 路径组装机制宿主接线（尾部挂载：开关透传 + 种子路径语料导入）──

/// 边证据库文件名（随数据目录落盘；派生数据可由运行历史重建）。
const EVIDENCE_DB_NAME: &str = "edge_evidence.sqlite";

/// 种子路径语料 → 边证据导入条目（逐条边；同键行不覆盖运行统计）。
///
/// 语料形态 = path_seeds.json 的 seed_paths 数组（id/domain/title/
/// description/chain/edge_stats）；逐条路径的相邻结点对展开为边证据
/// 条目（src/dst/成败计数/域/契约版本），计数缺省取 edge_defaults。
/// 纯数据变换（可独立单测）：链长 <2 / 缺字段 / 结点名为空 = 显式报错。
pub fn plan_seed_path_edges(value: &JsonValue) -> Result<Vec<JsonValue>, DomainError> {
    let paths = value
        .get("seed_paths")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| DomainError::InvalidData("缺 seed_paths（数组）".into()))?;
    let defaults = value.get("edge_defaults").and_then(JsonValue::as_object);

    fn count_or_default(
        stats: Option<&serde_json::Map<String, JsonValue>>,
        defaults: Option<&serde_json::Map<String, JsonValue>>,
        key: &str,
        path_id: &str,
    ) -> Result<u64, DomainError> {
        stats
            .and_then(|s| s.get(key))
            .and_then(JsonValue::as_u64)
            .or_else(|| {
                defaults
                    .and_then(|d| d.get(key))
                    .and_then(JsonValue::as_u64)
            })
            .ok_or_else(|| {
                DomainError::InvalidData(format!(
                    "种子路径 {path_id} 缺 {key}（条目或 edge_defaults 须提供）"
                ))
            })
    }

    let mut edges: Vec<JsonValue> = Vec::new();
    for raw in paths {
        let Some(path) = raw.as_object() else {
            return Err(DomainError::InvalidData(format!(
                "种子路径条目须为对象: {raw}"
            )));
        };
        let id = path.get("id").and_then(JsonValue::as_str).unwrap_or("(未命名)");
        let domain = path
            .get("domain")
            .and_then(JsonValue::as_str)
            .unwrap_or("default");
        let chain = path
            .get("chain")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| {
                DomainError::InvalidData(format!("种子路径 {id} 缺 chain（数组）"))
            })?;
        if chain.len() < 2 {
            return Err(DomainError::InvalidData(format!(
                "种子路径 {id} 的 chain 须 ≥2 结点"
            )));
        }
        let success = count_or_default(path.get("edge_stats").and_then(JsonValue::as_object), defaults, "success_count", id)?;
        let fail = count_or_default(path.get("edge_stats").and_then(JsonValue::as_object), defaults, "fail_count", id)?;
        for pair in chain.windows(2) {
            let (src, dst) = (pair[0].as_str(), pair[1].as_str());
            let (Some(src), Some(dst)) = (src, dst) else {
                return Err(DomainError::InvalidData(format!(
                    "种子路径 {id} 的 chain 结点名须为字符串"
                )));
            };
            if src.is_empty() || dst.is_empty() {
                return Err(DomainError::InvalidData(format!(
                    "种子路径 {id} 的 chain 含空结点名"
                )));
            }
            let avg_cost = path
                .get("edge_stats")
                .and_then(JsonValue::as_object)
                .and_then(|s| s.get("avg_cost"))
                .and_then(JsonValue::as_f64)
                .or_else(|| {
                    defaults
                        .and_then(|d| d.get("avg_cost"))
                        .and_then(JsonValue::as_f64)
                })
                .unwrap_or(0.0);
            edges.push(json!({
                "src_type": src,
                "dst_type": dst,
                "success_count": success,
                "fail_count": fail,
                "avg_cost": avg_cost,
                "context_domain": domain,
                "src_contract_version": "1",
                "dst_contract_version": "1",
            }));
        }
    }
    Ok(edges)
}

/// 种子路径挂载：出厂路径语料 → 边证据初始化（幂等：同键行不覆盖）。
///
/// 语料文件 = seed_data/path_seeds.json（缺文件/坏 JSON fail-closed）
/// → 经 op 通道导入边证据库；导入条数随结果返回（重放 = 0 不打翻状态）。
async fn mount_seed_paths(
    bundle: &recipe::SeedDataBundle,
    data_dir: &std::path::Path,
) -> Result<usize, String> {
    let seed_path = bundle.root.join("seed_data").join("path_seeds.json");
    let text = std::fs::read_to_string(&seed_path)
        .map_err(|err| fail("种子路径挂载", format!("读取 path_seeds.json: {err}")))?;
    let value: JsonValue = serde_json::from_str(&text)
        .map_err(|err| fail("种子路径挂载", format!("path_seeds.json 非法 JSON: {err}")))?;
    let edges = plan_seed_path_edges(&value)
        .map_err(|err| fail("种子路径挂载", err.to_string()))?;
    if edges.is_empty() {
        return Ok(0);
    }
    let db_path = data_dir.join(EVIDENCE_DB_NAME);
    let outcome = call_engine_op_async(
        "path.import_seed_paths",
        json!({
            "db_path": db_path.to_string_lossy(),
            "seed_edges": edges,
        }),
    )
    .await
    .map_err(|err| fail("种子路径挂载", err))?;
    Ok(outcome
        .get("imported")
        .and_then(JsonValue::as_u64)
        .map(|n| n as usize)
        .unwrap_or(0))
}

/// 路径组装机制宿主接线：开关透传 + 种子路径挂载（flag 关 = 零生效）。
///
/// 七块机制开关值整体写入桥模块（op fail-closed 的判定依据；与装配期
/// boot_inkling 的 path_assembly 参数同源同值——装配内接线在宿主侧，
/// 此处为运行期开关通道）；开启时才导入种子路径语料（关闭时 op 内部
/// 同样拒绝，双保险不产生任何状态）。
async fn wire_path_assembly(
    options: &BootOptions,
    bundle: &recipe::SeedDataBundle,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    call_engine_op(
        "path.set_flags",
        path_assembly_data(&options.path_assembly),
    )
    .map_err(|err| fail("路径组装开关透传", err))?;
    if options.path_assembly.assembler_enabled {
        // 导入条数为观测值（首启 ≠ 0；重放 = 0 = 同键已存在不打翻状态）
        let _imported = mount_seed_paths(bundle, data_dir).await?;
    }
    Ok(())
}

// ── 装配入口 ──

/// 装配 InKling 运行时：机制装配 + 宿主接线（一次性调用；重复装配由
/// 引擎幂等语义兜底）。步骤失败 = 结构化 Err（含步骤名与原因，fail-closed）。
pub async fn assemble_runtime(options: &BootOptions) -> Result<AssemblyReport, String> {
    let bundle = load_seed(options)?;
    let host = boot_host(options)?;
    wire_security(&bundle).await?;
    wire_web_search().await?;
    wire_live_targets().await?;

    // 运行数据目录（envs/artifacts 落盘根）：注入优先，缺省进程级临时目录
    let data_dir = options.data_dir.clone().unwrap_or_else(std::env::temp_dir);
    let build_domain = build::BuildDomain::new(bundle.file("build.json"), data_dir.join("artifacts"))
        .map_err(|err| fail("构建域装载", err.to_string()))?;
    let env_domain = env::EnvironmentDomain::new(
        bundle.file("env.json"),
        data_dir.join("envs"),
        build_domain.allowlist().to_vec(),
        None,
        None,
    )
    .map_err(|err| fail("环境域装载", err.to_string()))?;
    let mount_service = mcp::McpMountService::new(bundle.file("mcp_market.json"))
        .map_err(|err| fail("挂载服务装载", err.to_string()))?;

    // 链恢复重放（宿主侧剩余段：环境/产物/挂载/活跃态视图）
    let assembled = assemble_chain().await?;
    restore_environments(&env_domain, &assembled).await?;
    sync_artifacts(&build_domain, &assembled).await?;
    restore_mcp_mounts(&mount_service, &assembled)?;
    let _ = replay_live_views(&assembled).await;

    let seeds = reinject_seeds(&bundle).await?;
    finish_assembly().await?;

    // 路径组装机制宿主接线（尾部挂载：开关透传 + 种子路径语料导入；
    // 机制开关关闭时零生效——op fail-closed + 导入跳过，重放幂等）
    wire_path_assembly(options, &bundle, &data_dir).await?;

    // 链版本号：链组装结果本身无版本字段，按链记录补丁段长度 + 1；
    // 记录读取失败只影响报告字段（回落 1），不阻断装配完成
    let chain_record = call_engine_op_async(
        "engine.records_get",
        json!({ "collection": SET_CHAIN_COLLECTION, "key": SET_CHAIN_KEY }),
    )
    .await
    .unwrap_or(JsonValue::Null);

    build_report(&host, &chain_record, seeds)
}

// ── 接线探测（诊断用）──

/// 接线点逐项探测：返回各接线点 ok/error 清单（单点失败继续探测，
/// 不中断）；装配本身失败（种子装载/引擎装配）才返回 Err。
pub async fn wiring_probe(options: &BootOptions) -> Result<Vec<String>, String> {
    let bundle = load_seed(options)?;
    let _host = boot_host(options)?;
    let mut lines: Vec<String> = Vec::new();

    fn probe_line(lines: &mut Vec<String>, name: &str, result: Result<(), String>) {
        match result {
            Ok(()) => lines.push(format!("ok {name}")),
            Err(err) => lines.push(format!("error {name}: {err}")),
        }
    }

    probe_line(&mut lines, "安全域接线", wire_security(&bundle).await.map(|_| ()));
    probe_line(&mut lines, "联网搜索回调注册", wire_web_search().await.map(|_| ()));
    probe_line(&mut lines, "活跃态目标注册", wire_live_targets().await);
    let assembled = match assemble_chain().await {
        Ok(value) => {
            lines.push("ok 链组装".to_string());
            value
        }
        Err(err) => {
            lines.push(format!("error 链组装: {err}"));
            JsonValue::Null
        }
    };

    let data_dir = options.data_dir.clone().unwrap_or_else(std::env::temp_dir);
    let build_domain = match build::BuildDomain::new(bundle.file("build.json"), data_dir.join("artifacts"))
    {
        Ok(domain) => {
            lines.push("ok 构建域装载".to_string());
            Some(domain)
        }
        Err(err) => {
            lines.push(format!("error 构建域装载: {err}"));
            None
        }
    };
    let env_domain = match env::EnvironmentDomain::new(
        bundle.file("env.json"),
        data_dir.join("envs"),
        build_domain
            .as_ref()
            .map(|domain| domain.allowlist().to_vec())
            .unwrap_or_default(),
        None,
        None,
    ) {
        Ok(domain) => {
            lines.push("ok 环境域装载".to_string());
            Some(domain)
        }
        Err(err) => {
            lines.push(format!("error 环境域装载: {err}"));
            None
        }
    };
    let mount_service = match mcp::McpMountService::new(bundle.file("mcp_market.json")) {
        Ok(service) => {
            lines.push("ok 挂载服务装载".to_string());
            Some(service)
        }
        Err(err) => {
            lines.push(format!("error 挂载服务装载: {err}"));
            None
        }
    };

    probe_line(
        &mut lines,
        "环境段恢复",
        match &env_domain {
            Some(domain) => restore_environments(domain, &assembled).await,
            None => Err("环境域未装载".to_string()),
        },
    );
    probe_line(
        &mut lines,
        "产物段恢复",
        match &build_domain {
            Some(domain) => sync_artifacts(domain, &assembled).await,
            None => Err("构建域未装载".to_string()),
        },
    );
    probe_line(
        &mut lines,
        "挂载登记恢复",
        match &mount_service {
            Some(service) => restore_mcp_mounts(service, &assembled),
            None => Err("挂载服务未装载".to_string()),
        },
    );
    let skipped = replay_live_views(&assembled).await;
    lines.push(format!("ok 活跃态重放（跳过 {skipped} 条坏段）"));
    match reinject_seeds(&bundle).await {
        Ok((injected, present)) => lines.push(format!(
            "ok 种子重注入（补挂 {injected} 条，查重已存在 {present} 条）"
        )),
        Err(err) => lines.push(format!("error 种子重注入: {err}")),
    }
    probe_line(&mut lines, "收尾重建", finish_assembly().await);
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// 仓库根（env! 定位；与引擎桥测试同口径）。
    fn repo_root() -> PathBuf {
        readable_path(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
    }

    fn test_bundle() -> recipe::SeedDataBundle {
        recipe::load_seed_data(&repo_root().join("inkling")).expect("装载失败")
    }

    /// 触碰桥的测试串行执行（全 crate 唯一串行锁；桥状态是进程级单例）。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        crate::engine::host::bridge_guard()
    }

    /// 异步装配在单线程运行时内完成（引擎操作须稳定落在同一线程）。
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio 运行时创建失败")
            .block_on(future)
    }

    /// 异步 op 在单线程运行时内完成（与装配同一线程纪律）。
    fn block_on_op(op: &str, args: JsonValue) -> Result<JsonValue, String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio 运行时创建失败")
            .block_on(call_engine_op_async(op, args))
    }

    // ── 纯逻辑测试（不触碰桥）──

    #[test]
    fn seed_injection_plan_matches_provider_output() {
        let bundle = test_bundle();
        let providers = recipe::map_seed_providers(&bundle).expect("种子解析失败");
        let plans = plan_seed_injection(&bundle).expect("注入规划失败");

        let expected: Vec<String> = providers
            .iter()
            .flat_map(|p| p.entries.iter().map(|e| e.id.clone()))
            .collect();
        let planned: Vec<String> = plans.iter().map(|p| p.id.clone()).collect();
        assert_eq!(planned, expected, "规划条目 = 配方种子直注清单");
        assert!(!plans.is_empty(), "种子清单不应为空");

        for plan in &plans {
            assert_eq!(plan.get_args, json!({ "id": plan.id.clone() }));
            let entry = &plan.add_args["entry"];
            assert_eq!(entry["id"], plan.id, "补挂条目身份 = 查重键");
            assert!(entry.get("level").is_some(), "条目缺 level");
            assert!(entry.get("kind").is_some(), "条目缺 kind");
            assert!(entry.get("data").is_some(), "条目缺 data");
            assert!(entry.get("source").is_some(), "条目缺 source");
        }
        assert!(
            planned.iter().any(|id| id == "seed.inkling.domain_guide"),
            "已知种子条目应在列"
        );
    }

    #[test]
    fn live_replay_plan_orders_segments_and_tolerates_bad_segments() {
        let assembled = json!({
            "ui": {"boot.panel": {"name": "boot.panel", "root": {"kind": "container", "children": []}}},
            "theme": {"bg.base": "#111111"},
            "harness": {"inkling.a": {"name": "inkling.a", "description": "域 A"}},
            "knowledge": {
                "k.good": {"id": "k.good", "level": "project", "kind": "rule", "data": {"rule": {"message": "m"}}},
                "k.bad": {"id": "k.bad"},
                "k.list": ["not", "an", "entry"],
            },
            "rules": {
                "rule.x": {"id": "rule.x", "message": "材料须含标题字段", "type": "constraint"},
            },
            "unknown_segment": {"ignored": true},
        });
        let steps = plan_live_replay(&assembled);
        // 步骤序：ui → theme → harness → knowledge → rules
        assert!(matches!(steps[0], LiveReplayStep::UiSpec(_)));
        assert!(matches!(steps[1], LiveReplayStep::ThemeTokens(_)));
        assert!(matches!(steps[2], LiveReplayStep::Harness(_)));
        assert!(matches!(steps[3], LiveReplayStep::Knowledge(_)));
        assert!(matches!(steps[4], LiveReplayStep::Knowledge(_)));

        // 各步骤参数形态与引擎操作契约一致
        match &steps[0] {
            LiveReplayStep::UiSpec(spec) => assert_eq!(spec["name"], "boot.panel"),
            _ => panic!("期望 UI 段步骤"),
        }
        match &steps[1] {
            LiveReplayStep::ThemeTokens(tokens) => assert_eq!(tokens["bg.base"], "#111111"),
            _ => panic!("期望主题段步骤"),
        }
        match &steps[2] {
            LiveReplayStep::Harness(definition) => assert_eq!(definition["name"], "inkling.a"),
            _ => panic!("期望 harness 段步骤"),
        }

        // 知识段坏条目（缺契约字段/非对象）被归一跳过；规则段归一为
        // kind=rule 条目（标题 = 规则消息）
        let knowledge_steps: Vec<&LiveReplayStep> = steps
            .iter()
            .filter(|s| matches!(s, LiveReplayStep::Knowledge(_)))
            .collect();
        assert_eq!(knowledge_steps.len(), 2, "坏条目应被归一跳过");
        match knowledge_steps[1] {
            LiveReplayStep::Knowledge(entry) => {
                assert_eq!(entry["id"], "rule.x");
                assert_eq!(entry["kind"], "rule");
                assert_eq!(entry["level"], "project");
                assert_eq!(entry["title"], "材料须含标题字段");
            }
            _ => panic!("期望知识条目步骤"),
        }

        // 缺段/坏段容错：空组装态 = 空计划；非对象段 = 跳过不击穿
        assert!(plan_live_replay(&json!({})).is_empty());
        assert!(plan_live_replay(&json!({ "knowledge": {} })).is_empty());
        let weird = plan_live_replay(&json!({ "ui": "nope", "theme": 42, "harness": [], "knowledge": "x" }));
        assert!(weird.is_empty());
    }

    #[test]
    fn live_replay_plan_is_deterministic() {
        let assembled = json!({
            "ui": {"boot.panel": {"name": "boot.panel", "root": {"kind": "container"}}},
            "theme": {"bg.base": "#111111"},
            "harness": {"inkling.a": {"name": "inkling.a"}},
            "knowledge": {"k.good": {"id": "k.good", "level": "project", "kind": "rule", "data": {}}},
            "rules": {"rule.x": {"id": "rule.x", "message": "m"}},
        });
        // 幂等步骤序：同一组装态重复规划产出完全相同的步骤序（重放可重复）
        assert_eq!(plan_live_replay(&assembled), plan_live_replay(&assembled));
    }

    #[test]
    fn mcp_mount_restore_plan_scans_chain_tools() {
        let assembled = json!({
            "tools": {
                "echo": {"name": "echo", "endpoint": "mcp", "endpoint_config": {"server_id": "test.echo"}},
                "alarm": {"name": "alarm", "endpoint": "mcp", "endpoint_config": {"server_id": "test.echo"}},
                "web_fetch": {"name": "web_fetch", "endpoint": "http_fetch", "endpoint_config": {"method": "GET"}},
                "mcp_no_id": {"name": "x", "endpoint": "mcp", "endpoint_config": {}},
            }
        });
        assert_eq!(
            plan_mcp_mount_restore(&assembled),
            vec!["test.echo".to_string()],
            "同 server 去重；非 mcp/无 server_id 不入列"
        );
        assert!(plan_mcp_mount_restore(&json!({})).is_empty());
        assert!(plan_mcp_mount_restore(&json!({ "tools": {} })).is_empty());
        assert!(plan_mcp_mount_restore(&json!({ "tools": "nope" })).is_empty());
    }

    #[test]
    fn chain_version_counts_patches_plus_one() {
        assert_eq!(chain_version(&json!({ "base": {}, "patches": [] })), 1);
        assert_eq!(
            chain_version(&json!({ "base": {}, "patches": [{ "op": "append" }] })),
            2
        );
        assert_eq!(chain_version(&json!({ "base": {} })), 1);
        assert_eq!(chain_version(&JsonValue::Null), 1);
        assert_eq!(chain_version(&json!({ "patches": "nope" })), 1);
    }

    #[test]
    fn report_shape_and_target_kinds() {
        let report = AssemblyReport {
            tool_names: vec!["collect_material".to_string(), "inspect_knowledge".to_string()],
            event_types: vec!["reply_token".to_string()],
            chain_version: 3,
            seeds_injected: 2,
            seeds_present: 5,
            target_kinds: target_kinds_declaration(),
        };
        assert_eq!(report.tool_names.len(), 2);
        assert_eq!(report.event_types.len(), 1);
        assert_eq!(report.chain_version, 3);
        assert_eq!(report.seeds_injected, 2);
        assert_eq!(report.seeds_present, 5);
        assert_eq!(report.target_kinds.len(), 7, "五类配方目标 + 两类引擎内置");
        assert!(report.target_kinds.contains(&"ui".to_string()));
        assert!(report.target_kinds.contains(&"knowledge".to_string()));
        assert!(report.target_kinds.contains(&"tool".to_string()));
        assert!(report.target_kinds.contains(&"event_type".to_string()));
    }

    #[test]
    fn segment_maps_fall_back_empty() {
        let assembled = json!({
            "environments": {"inkling.local": {"name": "inkling.local", "runtime": "local"}},
            "artifacts": {"svc-1": {"artifact_id": "svc-1"}},
        });
        let envs = object_map(assembled.get("environments"));
        assert_eq!(envs.len(), 1);
        assert!(envs.contains_key("inkling.local"));
        let artifacts = object_map(assembled.get("artifacts"));
        assert_eq!(artifacts.len(), 1);
        assert!(object_map(assembled.get("missing")).is_empty());
        assert!(object_map(Some(&json!("nope"))).is_empty());
        assert!(object_map(Some(&JsonValue::Null)).is_empty());
    }

    #[test]
    fn path_assembly_defaults_all_off_and_by_name_json() {
        let flags = PathAssemblyFlags::default();
        let data = path_assembly_data(&flags);
        let map = data.as_object().expect("装配数据须为 JSON 对象");
        assert_eq!(map.len(), 7, "七块开关齐备");
        for key in [
            "path_assembly_contract_enabled",
            "path_assembly_edge_evidence_enabled",
            "path_assembly_settle_hooks_enabled",
            "path_assembly_pool_governance_enabled",
            "path_assembly_assembler_enabled",
            "path_assembly_multipath_enabled",
            "path_assembly_fingerprint_cache_enabled",
        ] {
            assert!(map.contains_key(key), "缺键 {key}");
            assert_eq!(map[key], json!(false), "{key} 默认应全关");
        }
        // 键名 = 机制语义名：禁计划编号/阶段字眼（引擎侧按名读取的契约）
        for key in map.keys() {
            let lower = key.to_ascii_lowercase();
            for banned in ["step", "batch", "phase", "stage", "d3"] {
                assert!(!lower.contains(banned), "键名含阶段字眼: {key}");
            }
        }
    }

    #[test]
    fn path_assembly_flags_toggle_individually() {
        let mut flags = PathAssemblyFlags::default();
        flags.multipath_enabled = true;
        flags.fingerprint_cache_enabled = true;
        let data = path_assembly_data(&flags);
        assert_eq!(data["path_assembly_multipath_enabled"], json!(true));
        assert_eq!(data["path_assembly_fingerprint_cache_enabled"], json!(true));
        assert_eq!(data["path_assembly_contract_enabled"], json!(false));
        assert_eq!(data["path_assembly_assembler_enabled"], json!(false));
    }

    #[test]
    fn boot_options_default_carries_all_off_flags() {
        let data = path_assembly_data(&BootOptions::default().path_assembly);
        assert!(
            data.as_object().unwrap().values().all(|v| v == &json!(false)),
            "BootOptions 缺省携带的开关应全部关闭"
        );
    }

    // ── 触碰桥的测试（引擎 boot；串行执行）──

    #[test]
    fn assemble_replays_idempotently() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        // 装配层幂等可重放：同一宿主重复装配产出等价报告（回调重复注册
        // 覆盖、目标重注册覆盖、种子按 id 去重——重放不放大状态）
        let first = block_on(assemble_runtime(&options)).expect("首次装配失败");
        let second = block_on(assemble_runtime(&options)).expect("重放装配失败");
        assert_eq!(first.tool_names, second.tool_names, "重放后工具清单漂移");
        assert_eq!(first.event_types, second.event_types, "重放后事件类型清单漂移");
        assert_eq!(first.seeds_injected, second.seeds_injected, "重放后种子注入量漂移");
        assert_eq!(first.target_kinds, second.target_kinds, "重放后目标登记漂移");
        assert_eq!(first.chain_version, second.chain_version, "重放后链版本漂移");
    }

    #[test]
    fn assemble_succeeds_with_ready_wiring() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        let report = block_on(assemble_runtime(&options)).expect("装配应成功");
        assert!(!report.tool_names.is_empty(), "工具清单为空");
        assert!(!report.event_types.is_empty(), "事件类型清单为空");
        assert!(report.chain_version >= 1, "链版本异常");
        assert_eq!(report.target_kinds.len(), 7, "活跃态目标种类应齐备");
        // 种子不丢不重：机制装配已注入时补挂为 0（安全网不重复），链恢复
        // 吞掉出厂基线时补挂补齐——无论哪种形态，补挂 + 已存在 = 清单总量
        let bundle = test_bundle();
        let plans = plan_seed_injection(&bundle).expect("注入规划失败");
        assert!(!plans.is_empty(), "种子清单为空");
        assert_eq!(
            report.seeds_injected + report.seeds_present,
            plans.len(),
            "种子总量不守恒（注入 + 已存在 ≠ 清单）"
        );
        assert!(report.seeds_present >= 1, "种子均不可达（查重全落空）");
    }

    // ── 路径组装机制宿主接线测试 ──

    /// 读取出厂路径语料（与实际装配同一文件；纯逻辑测试不触碰桥）。
    fn seed_paths_file() -> JsonValue {
        let text = std::fs::read_to_string(
            repo_root().join("inkling").join("seed_data").join("path_seeds.json"),
        )
        .expect("path_seeds.json 读取失败");
        serde_json::from_str(&text).expect("path_seeds.json JSON 非法")
    }

    #[test]
    fn seed_path_edges_plan_converts_and_validates() {
        let value = seed_paths_file();
        let edges = plan_seed_path_edges(&value).expect("语料规划失败");
        // 逐条路径的相邻结点对展开：3+4+4+1+3 = 15 条边
        let paths = value["seed_paths"].as_array().unwrap();
        let expected: usize = paths
            .iter()
            .map(|p| p["chain"].as_array().unwrap().len() - 1)
            .sum();
        assert_eq!(edges.len(), expected, "边数 = 各路径链长减一之和");
        let first = &edges[0];
        assert_eq!(first["src_type"], "intent_parse");
        assert_eq!(first["dst_type"], "retrieval_search");
        assert_eq!(first["context_domain"], "default");
        assert_eq!(first["success_count"], 5);
        assert_eq!(first["fail_count"], 1);
        assert_eq!(first["src_contract_version"], "1");
        // 全部条目字段形态齐备（导入 API 契约）
        for edge in &edges {
            assert!(edge.get("src_type").and_then(JsonValue::as_str).is_some());
            assert!(edge.get("dst_type").and_then(JsonValue::as_str).is_some());
            assert!(edge.get("success_count").and_then(JsonValue::as_u64).is_some());
            assert!(edge.get("fail_count").and_then(JsonValue::as_u64).is_some());
            assert!(edge.get("context_domain").and_then(JsonValue::as_str).is_some());
        }
        // 无环自洽：每条边的产出链方向一致（src 在前、dst 在后）
        for (i, edge) in edges.iter().enumerate() {
            let src = edge["src_type"].as_str().unwrap();
            let dst = edge["dst_type"].as_str().unwrap();
            assert_ne!(src, dst, "自环不应出现（边 {i}）");
        }
    }

    #[test]
    fn seed_path_edges_plan_rejects_bad_shapes() {
        // 缺 seed_paths 数组
        assert!(
            plan_seed_path_edges(&json!({})).is_err(),
            "缺 seed_paths 应报错"
        );
        // 单结点链
        assert!(
            plan_seed_path_edges(&json!({
                "seed_paths": [{"id": "p1", "chain": ["a"], "edge_stats": {"success_count": 1, "fail_count": 0}}],
                "edge_defaults": {"success_count": 1, "fail_count": 0},
            }))
            .is_err(),
            "链长 <2 应报错"
        );
        // 缺计数且 defaults 缺
        assert!(
            plan_seed_path_edges(&json!({
                "seed_paths": [{"id": "p1", "chain": ["a", "b"]}],
            }))
            .is_err(),
            "计数缺失应报错"
        );
        // 计数经 edge_defaults 补齐
        let ok = plan_seed_path_edges(&json!({
            "seed_paths": [{"id": "p1", "chain": ["a", "b"], "edge_stats": {"success_count": 2, "fail_count": 1}}],
            "edge_defaults": {"success_count": 9, "fail_count": 9},
        }))
        .expect("合法语料应通过");
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0]["success_count"], 2, "条目计数优先于 defaults");
        // 空链/坏结点名
        assert!(
            plan_seed_path_edges(&json!({
                "seed_paths": [{"id": "p1", "chain": ["a", 7]}],
                "edge_defaults": {"success_count": 1, "fail_count": 0},
            }))
            .is_err(),
            "结点名非字符串应报错"
        );
    }

    #[test]
    fn path_assemble_op_fail_closed_when_flag_off() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        block_on(assemble_runtime(&options)).expect("装配应成功（开关全关默认形态）");
        let outcome = block_on_op(
            "path.assemble",
            json!({
                "goal_schema": {"name": "goal", "fields": [{"name": "answer", "required": true, "kind": "string"}]},
                "entry_fields": [],
                "domain": "default",
            }),
        )
        .expect("op 调用失败");
        assert_eq!(outcome.get("ok").and_then(JsonValue::as_bool), Some(false));
        assert_eq!(
            outcome.get("enabled").and_then(JsonValue::as_bool),
            Some(false),
            "开关关闭 = fail-closed 结构化「未启用」"
        );
        assert!(
            outcome.get("reason").and_then(JsonValue::as_str).is_some(),
            "拒绝须带可读原因"
        );
    }

    #[test]
    fn path_assemble_op_stub_pool_roundtrip_and_tier_mapping() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            path_assembly: PathAssemblyFlags {
                assembler_enabled: true,
                ..PathAssemblyFlags::default()
            },
            ..BootOptions::default()
        };
        // 直连形态：宿主句柄持有期间开关经 op 透传（装配编排出厂路径在
        // assemble_runtime 尾段完成；此处复刻其开关值以覆盖桥 op 本体）
        let host = EngineHost::boot(options).expect("装配失败");
        call_engine_op("path.set_assembler_enabled", json!({ "enabled": true }))
            .expect("开关透传失败");

        let goal = json!({
            "name": "goal",
            "fields": [{"name": "answer", "required": true, "kind": "string"}],
        });

        // 常规池：意图解析 → 回答生成（两结点 = 一条合法路径）
        let pool = json!([
            {"type_name": "intent_parse", "input_fields": [], "output_fields": ["query"], "safety_tier": 0},
            {"type_name": "answer_generate", "input_fields": ["query"], "output_fields": ["answer"], "safety_tier": 0},
        ]);
        let outcome = block_on_op(
            "path.assemble",
            json!({
                "goal_schema": goal.clone(),
                "entry_fields": [],
                "domain": "default",
                "pool": pool.clone(),
                "approval_tier": "L0",
            }),
        )
        .expect("op 调用失败");
        assert_eq!(outcome.get("ok").and_then(JsonValue::as_bool), Some(true));
        assert_eq!(outcome.get("enabled").and_then(JsonValue::as_bool), Some(true));
        let candidates = outcome["candidates"].as_array().expect("候选须为数组");
        assert!(!candidates.is_empty(), "目标可解应出候选");
        let first_chain = candidates[0]["chain"].as_array().expect("候选链须为数组");
        assert_eq!(
            serde_json::to_string(&first_chain).unwrap(),
            r#"["intent_parse","answer_generate"]"#,
            "候选链 = 意图解析 → 回答生成"
        );
        // 候选 = 图定义数据（可序列化断言：JSON 往返不丢字段）
        assert!(candidates[0].get("graph").and_then(JsonValue::as_object).is_some());
        let serialized = serde_json::to_string(&outcome).expect("结果应可序列化");
        let back: JsonValue = serde_json::from_str(&serialized).expect("序列化往返失败");
        assert!(back["candidates"].is_array());
        assert_eq!(back["stats"]["beam_extensions"].as_u64().map(|n| n > 0), Some(true));
        let audit = outcome["audit"].as_array().expect("审计记录须为数组");
        assert!(!audit.is_empty(), "组装审计应落记录");
        assert_eq!(audit[0]["domain"], "default");
        assert_eq!(outcome["max_safety_tier"], 0, "审批档 L0 → 放行档 0");

        // 档位映射：高安全结点（安全档 2）在 L0 下被剪枝（无候选），
        // 审批档 L2 → 放行档 2 后可入候选
        let gated_pool = json!([
            {"type_name": "intent_parse", "input_fields": [], "output_fields": ["intent"], "safety_tier": 0},
            {"type_name": "deep_analysis", "input_fields": [], "output_fields": ["answer"], "safety_tier": 2},
        ]);
        let strict = block_on_op(
            "path.assemble",
            json!({
                "goal_schema": goal.clone(),
                "entry_fields": [],
                "approval_tier": "L0",
                "pool": gated_pool,
            }),
        )
        .expect("op 调用失败");
        assert!(
            strict["candidates"].as_array().unwrap().is_empty(),
            "L0 下高安全结点应被剪枝"
        );
        assert!(strict["fallback_reason"].as_str().is_some());
        let permissive = block_on_op(
            "path.assemble",
            json!({
                "goal_schema": goal.clone(),
                "entry_fields": [],
                "approval_tier": "L2",
                "pool": gated_pool,
            }),
        )
        .expect("op 调用失败");
        assert_eq!(permissive["max_safety_tier"], 2, "审批档 L2 → 放行档 2");
        let chains: Vec<Vec<&str>> = permissive["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                c["chain"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_str().unwrap())
                    .collect()
            })
            .collect();
        assert!(
            chains.iter().any(|c| c.contains(&"deep_analysis")),
            "L2 下高安全结点应可入候选"
        );

        host.stop().expect("关停失败");
    }

    #[test]
    fn seed_path_import_op_is_idempotent_and_boot_mount_replays() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            path_assembly: PathAssemblyFlags {
                assembler_enabled: true,
                ..PathAssemblyFlags::default()
            },
            ..BootOptions::default()
        };
        let dir = std::env::temp_dir().join(format!(
            "inkling-seed-paths-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("edge_evidence.sqlite");
        let edges = plan_seed_path_edges(&seed_paths_file()).expect("语料规划失败");

        // 导入幂等：首导写入全部，重放同键跳过（imported = 0）
        let first = block_on_op(
            "path.import_seed_paths",
            json!({
                "db_path": db_path.to_string_lossy(),
                "seed_edges": edges.clone(),
            }),
        )
        .expect("导入失败");
        let n = first["imported"].as_u64().expect("缺 imported");
        assert!(n > 0, "首导应写入种子边");
        let second = block_on_op(
            "path.import_seed_paths",
            json!({
                "db_path": db_path.to_string_lossy(),
                "seed_edges": edges,
            }),
        )
        .expect("重放导入失败");
        assert_eq!(
            second["imported"].as_u64(),
            Some(0),
            "同键已存在 = 运行统计优先，种子不覆盖"
        );

        // 装配重放幂等：开关开启下重复装配（含尾部挂载段）不放大状态
        let first_boot = block_on(assemble_runtime(&options)).expect("首次装配失败");
        let second_boot = block_on(assemble_runtime(&options)).expect("重放装配失败");
        assert_eq!(first_boot.tool_names, second_boot.tool_names);
        assert_eq!(first_boot.event_types, second_boot.event_types);
        assert_eq!(first_boot.seeds_injected, second_boot.seeds_injected);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! boot 域：装配编排层——机制装配之上的宿主接线（幂等可重放）。
//!
//! 引擎机制装配（[`crate::engine::host::EngineHost::boot`] → Python 侧
//! `boot_inkling`）保持原样完成：运行时装配、种子注入、harness 登记、
//! 事件类型基线、补丁链基线与引擎内建链恢复。本模块在其后叠加宿主侧
//! 接线：
//! - 安全纵深安装（三档门禁流水线替换 + 文件工具占位根注册 + 授权恢复）；
//! - 活跃态目标注册（五类配方目标 + 引擎内置 TOOL/EVENT_TYPE）；
//! - 链段恢复重放（环境声明、产物声明工具、MCP 挂载登记、界面/主题/
//!   harness/知识活跃态）；
//! - 种子重注入（链恢复整体替换知识集实例后，出厂基线按 id 查重补挂）；
//! - 内省源刷新与引擎重建收尾。
//!
//! 全部接线动作幂等可重放：重复执行不改变最终状态；引擎侧 legacy 移除
//! 后由本模块完整接管装配。失败语义 fail-closed（结构化错误含步骤名与
//! 原因，不 panic）；live 视图重放例外——各段独立容错，坏段跳过不击穿。
//! 入口为一次性装配调用（重复装配由引擎幂等语义兜底）。
//!
//! 依赖纪律：本模块是唯一装配编排点，只调用各域的冻结装配签名与引擎
//! 操作通道（`call_engine_op` / `call_engine_op_async`），域间不互调。

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value as JsonValue};

use super::common::{readable_path, DomainError};
use super::{build, env, live, mcp, recipe, security};
use crate::engine::host::{call_engine_op, call_engine_op_async, BootOptions, EngineHost};

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

/// 种子重注入执行：逐条目查重（knowledge_get）→ 缺失补挂（knowledge_add），
/// 返回实际注入数。
async fn reinject_seeds(bundle: &recipe::SeedDataBundle) -> Result<usize, String> {
    let plans =
        plan_seed_injection(bundle).map_err(|err| fail("种子注入规划", err.to_string()))?;
    let mut injected = 0usize;
    for plan in plans {
        let existing = call_engine_op("engine.knowledge_get", plan.get_args)
            .map_err(|err| fail("种子重注入（查重）", err))?;
        if existing.is_null() {
            call_engine_op("engine.knowledge_add", plan.add_args)
                .map_err(|err| fail("种子重注入（补挂）", err))?;
            injected += 1;
        }
    }
    Ok(injected)
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
    seeds_injected: usize,
) -> Result<AssemblyReport, String> {
    let report = host.report().map_err(|err| fail("装配报告", err))?;
    Ok(AssemblyReport {
        tool_names: report.tool_names,
        event_types: report.event_types,
        chain_version: chain_version(chain_record),
        seeds_injected,
        target_kinds: target_kinds_declaration(),
    })
}

// ── 装配入口 ──

/// 装配 InKling 运行时：机制装配 + 宿主接线（一次性调用；重复装配由
/// 引擎幂等语义兜底）。步骤失败 = 结构化 Err（含步骤名与原因，fail-closed）。
pub async fn assemble_runtime(options: &BootOptions) -> Result<AssemblyReport, String> {
    let bundle = load_seed(options)?;
    let host = boot_host(options)?;
    wire_security(&bundle).await?;
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

    let seeds_injected = reinject_seeds(&bundle).await?;
    finish_assembly().await?;

    // 链版本号：链组装结果本身无版本字段，按链记录补丁段长度 + 1；
    // 记录读取失败只影响报告字段（回落 1），不阻断装配完成
    let chain_record = call_engine_op_async(
        "engine.records_get",
        json!({ "collection": SET_CHAIN_COLLECTION, "key": SET_CHAIN_KEY }),
    )
    .await
    .unwrap_or(JsonValue::Null);

    build_report(&host, &chain_record, seeds_injected)
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
        Ok(injected) => lines.push(format!("ok 种子重注入（补挂 {injected} 条）")),
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
            seeds_injected: 7,
            target_kinds: target_kinds_declaration(),
        };
        assert_eq!(report.tool_names.len(), 2);
        assert_eq!(report.event_types.len(), 1);
        assert_eq!(report.chain_version, 3);
        assert_eq!(report.seeds_injected, 7);
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

    // ── 触碰桥的测试（引擎 boot；串行执行）──

    #[test]
    fn assemble_fails_closed_on_wiring_placeholders() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        // 接线点尚未合入（占位错误体）：装配须在首个未就绪步骤 fail-closed，
        // 返回结构化错误（含步骤名与原因），不 panic
        let err = block_on(assemble_runtime(&options)).expect_err("装配应在接线占位下失败");
        assert!(err.starts_with("装配失败：步骤「"), "错误应为结构化形态: {err}");
        assert!(err.contains("安全流水线接线"), "错误应含未就绪步骤名: {err}");
    }

    #[test]
    #[ignore = "依赖接线代理合入后启用（主会话合并时移除 ignore）"]
    fn assemble_succeeds_when_wiring_ready() {
        let _serial = serial();
        let options = BootOptions {
            repo_root: repo_root(),
            ..BootOptions::default()
        };
        let report = block_on(assemble_runtime(&options)).expect("装配应成功");
        assert!(!report.tool_names.is_empty(), "工具清单为空");
        assert!(!report.event_types.is_empty(), "事件类型清单为空");
        assert!(report.seeds_injected >= 1, "种子重注入为零");
        assert!(report.chain_version >= 1, "链版本异常");
        assert_eq!(report.target_kinds.len(), 7, "活跃态目标种类应齐备");
    }
}

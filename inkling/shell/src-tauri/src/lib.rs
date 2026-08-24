//! InKling 桌面壳（宿主件）——机制件与宿主件的分界线。
//!
//! 壳语义：宿主进程 + WebView 渲染 frontend 产物；引擎侧零改动。
//! 系统操作工具禁止硬编码为固定功能——工具声明（fixtures/tools_os.json）
//! 走声明式工具生成管线产出，壳只做执行器注册：注册时校验「声明 ↔ 执行器
//! 签名」一致，权限/沙箱守卫在执行器层强制（deny 硬拦、review 需授权、
//! 白名单/边界越界拒绝）。
//!
//! 产品后端面：会话 CRUD/分支树/标题生成、回合发送与中止、审批卡、
//! 工作区授权、能力设置（推演档位）、导出备份恢复、工具快照与组件
//! 清单经 Tauri 命令暴露给前端（前端以可注入适配器消费）。引擎装配
//! 在首次使用处懒执行（起步不阻塞首屏），失败语义 = 结构化错误透传
//! （fail-closed，不静默降级）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value as JsonValue};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, State};

pub mod domain;
pub mod engine;
pub mod executors;
pub mod mcp;

use domain::session;
use domain::steps::{RoundAbortSignal, RoundStepsTransport, ToolTitleResolver};
use domain::tools::ToolSpecsProvider;
use executors::backends::{PlatformBackend, ShellBackend};
use executors::impls::Authorization;
use executors::registry::{build_registry_from_declarations, ExecutorRegistry};
use executors::tool_decl::{ToolDeclarations, load_tool_declarations};

/// 工具声明文件（include_str 内嵌：声明 = 数据，随补丁链演化管线产出）
const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

/// 工作区挂载根（文件沙箱的授权底座；挂载授权命令按此校验）
const DEFAULT_MOUNT_ROOT: &str = "~/.inkling/workspace";

/// 引擎装配的种子根目录名（seed_data/manifest 所在目录）
const SEED_DIR_NAME: &str = "inkling";

/// 装配数据文件名（策略层分流/档位阈值读种子数据）
const WORKFLOW_FILE: &str = "workflow.json";

/// 能力设置记录集合/键（设置页应用能力档的持久化底座）
const CAPABILITY_COLLECTION: &str = "app_capabilities";
const CAPABILITY_KEY: &str = "capability";

/// 组件构建产物清单文件名（挂载后注册表刷新的数据源）
const COMPONENT_MANIFEST_FILE: &str = "manifest.json";

/// 产品后端（引擎句柄 + 工具快照 + 回合记录器 + 中止信号）。
struct ShellBackendState {
    engine: Mutex<Option<engine::host::EngineHost>>,
    tool_provider: Arc<ToolSpecsProvider>,
    round: Mutex<Option<RoundStepsTransport>>,
    abort_signal: RoundAbortSignal,
}

impl ShellBackendState {
    fn new() -> Self {
        Self {
            engine: Mutex::new(None),
            tool_provider: Arc::new(ToolSpecsProvider::empty()),
            round: Mutex::new(None),
            abort_signal: RoundAbortSignal::new(),
        }
    }

    /// 引擎就绪（装配成功且可出报告）。
    fn engine_ready(&self) -> bool {
        self.engine
            .lock()
            .unwrap()
            .as_ref()
            .map(|host| host.report().is_ok())
            .unwrap_or(false)
    }
}

/// 壳状态：授权挂载点 + 执行器注册表（声明驱动，启动时构建并自检签名）。
struct ShellState {
    mounts: Mutex<Vec<PathBuf>>,
    registry: ExecutorRegistry,
    backend: ShellBackendState,
}

/// 构建壳后端：平台操作 + Tauri 通知接线。
fn build_shell_backend(app: AppHandle) -> ShellBackend {
    let platform = PlatformBackend;
    ShellBackend::new(app, platform)
}

/// 开发形态仓库根（引擎桥 seed_root 定位；发行期由打包资源覆盖）。
fn dev_repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// 装配选项（开发形态：app_data_dir 内 sqlite + 数据目录落盘）。
fn boot_options(repo_root: PathBuf, data_dir: PathBuf) -> engine::host::BootOptions {
    engine::host::BootOptions {
        repo_root,
        storage_uri: format!("sqlite:///{}", data_dir.join("inkling.sqlite").display()),
        data_dir: Some(data_dir),
        ..Default::default()
    }
}

/// 种子根（仓库形态：workspace/inkling；发行期覆盖为资源目录）。
fn seed_root() -> PathBuf {
    std::fs::canonicalize(dev_repo_root().join(SEED_DIR_NAME))
        .unwrap_or_else(|_| dev_repo_root().join(SEED_DIR_NAME))
}

/// 装配数据装载（策略层分流/档位阈值读种子数据）。
fn load_workflow_data() -> Result<JsonValue, String> {
    let path = seed_root().join(WORKFLOW_FILE);
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("装配数据读取失败 {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("装配数据 JSON 非法: {err}"))
}

/// 懒装配（幂等）：首次调用执行引擎机制装配 + 工具快照刷新。
///
/// 装配 = 嵌入装配域包的 `boot_inkling`（机制装配 + 安全纵深 + 活跃态
/// 目标 + 链恢复全在装配域包内）；装配后工具快照供 label 解析/工具名
/// 映射产出共用。装配失败 = 结构化错误（透传引擎侧真实错误）。
fn ensure_engine(state: &ShellState, data_dir: &Path) -> Result<(), String> {
    let mut engine = state.backend.engine.lock().unwrap();
    if engine.is_some() {
        return Ok(());
    }
    let options = boot_options(dev_repo_root(), data_dir.to_path_buf());
    let host = engine::host::EngineHost::boot(options.clone())
        .map_err(|err| format!("引擎机制装配失败: {err}"))?;
    // 工具快照：出厂清单 + 装配后实时表（内省源同步 + 重取）
    if let Ok(bundle) = domain::recipe::load_seed_data(&seed_root()) {
        state
            .backend
            .tool_provider
            .replace_from_seed(bundle.file("tools.json"));
        let _ = state.backend.tool_provider.refresh();
    }
    *engine = Some(host);
    Ok(())
}

/// 回合记录器（事件弧 + 中止信号 + 工具标题解析挂点）。
fn begin_round_recorder(state: &ShellState, round_id: &str) -> RoundStepsTransport {
    let resolver: ToolTitleResolver = {
        let provider = Arc::clone(&state.backend.tool_provider);
        Arc::new(move |name: &str| {
            let label = provider.resolve_label(name, None);
            if label.contains("（未本地化）") {
                None
            } else {
                Some(label)
            }
        })
    };
    RoundStepsTransport::with_engine_handles(
        round_id,
        None,
        None,
        Some(resolver),
        Some(state.backend.abort_signal.clone()),
    )
}

// ── 引擎生命周期命令 ──

/// 后端状态（前端启动探测：引擎是否就绪/工具面大小）。
#[tauri::command]
fn backend_status(state: State<'_, ShellState>) -> JsonValue {
    json!({
        "engine_ready": state.backend.engine_ready(),
        "tool_count": state.backend.tool_provider.len(),
    })
}

/// 显式装配（懒装配的提前触发；失败 = 结构化错误）。
#[tauri::command]
fn engine_boot(app: AppHandle, state: State<'_, ShellState>) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&state, &data_dir)?;
    let snapshot = state
        .backend
        .engine
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|host| host.report().ok())
        .map(|report| {
            json!({
                "tool_names": report.tool_names,
                "event_types": report.event_types,
            })
        })
        .unwrap_or_else(|| json!({}));
    Ok(json!({ "snapshot": snapshot }))
}

/// 回合发送：引擎回合驱动（装配会话同线程；返回事件流 + 步骤序列）。
///
/// 回合在宿主线程内执行（Python 事件循环线程亲和性），事件经步骤
/// 记录器收敛为步骤序列（tool 行 title 由解析挂点填充）；审批卡默认
/// 接受决议（交互决议经 [`round_resume`] 注入续跑）。
#[tauri::command]
fn round_send(
    app: AppHandle,
    state: State<'_, ShellState>,
    thread_id: String,
    round_id: String,
    text: String,
    auto_accept_review: Option<bool>,
) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&state, &data_dir)?;
    state.backend.abort_signal.begin_round();
    let mut recorder = begin_round_recorder(&state, &round_id);
    {
        let mut slot = state.backend.round.lock().unwrap();
        *slot = Some(recorder.clone());
    }
    let request = engine::host::RoundRequest {
        input_text: text,
        thread_id: thread_id.clone(),
        round_id: round_id.clone(),
        step_args: None,
        inject: None,
        auto_accept_review: auto_accept_review.unwrap_or(true),
    };
    let engine_guard = state.backend.engine.lock().unwrap();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "引擎未装配（引擎装配失败或尚未就绪）".to_string())?;
    let outcome = engine.round(request).map_err(|err| format!("回合执行失败: {err}"))?;
    drop(engine_guard);
    for event in &outcome.events {
        recorder.feed(event);
    }
    let steps = recorder.snapshot();
    Ok(json!({
        "round_id": round_id,
        "thread_id": thread_id,
        "reason": outcome.reason,
        "output": outcome.output,
        "events": outcome.events,
        "steps": steps,
    }))
}

/// 回合续跑（审批决议注入：挂起的审批卡 → 决议 → 续跑）。
///
/// 决议 = 中断点 key → inject 值（accept/reject/edit 形态由宿主构造）；
/// 无挂起卡/卡失效 = 引擎侧结构化错误（fail-closed，前端提示重发）。
#[tauri::command]
async fn round_resume(
    thread_id: String,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
) -> Result<JsonValue, String> {
    let latest = engine::host::call_engine_op_async(
        "engine.thread_latest_checkpoint",
        json!({ "thread_id": thread_id }),
    )
    .await?;
    let checkpoint_id = latest
        .get("checkpoint_id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| "会话无检查点（先发送一条消息）".to_string())?;
    let mut inject = json!({});
    inject[key] = match decision.as_str() {
        "reject" => json!("reject"),
        "edit" => json!(edited_content.unwrap_or_else(|| json!("accept"))),
        _ => json!("accept"),
    };
    let mut args = json!({
        "thread_id": thread_id,
        "checkpoint_id": checkpoint_id,
        "inject": inject,
    });
    if let Some(reason) = reason {
        args["reason"] = json!(reason);
    }
    let outcome = engine::host::call_engine_op_async("engine.thread_resume", args).await?;
    Ok(outcome)
}

/// 回合中止：事件弧关断 + 中止信号握手（引擎在途取消经操作通道）。
#[tauri::command]
fn round_abort(state: State<'_, ShellState>, round_id: String) -> Result<JsonValue, String> {
    {
        let mut slot = state.backend.round.lock().unwrap();
        if let Some(recorder) = slot.as_mut() {
            if recorder.round_id() == round_id {
                recorder.abort_current_round().map_err(|err| err.to_string())?;
            }
        }
    }
    state.backend.abort_signal.abort();
    Ok(json!({
        "round_id": round_id,
        "aborted": state.backend.abort_signal.is_aborted(),
        "engine": "engine.abort_current_run 操作通道由装配侧注册（本层已关断事件弧）",
    }))
}

/// 策略层路由预览（任务分类 → 链分流 → 受控计划 → 配额守门）。
#[tauri::command]
fn route_plan(state: State<'_, ShellState>, text: String, tier: String) -> Result<JsonValue, String> {
    let _ = state;
    let workflow_data = load_workflow_data()?;
    let tier = domain::policy::SimulationTier::parse(&tier).map_err(|err| err.to_string())?;
    let routing =
        domain::policy::route_round(&text, &workflow_data, None, tier).map_err(|err| err.to_string())?;
    Ok(json!({
        "kind": routing.kind.as_str(),
        "chain_id": routing.chain_id,
        "plan": domain::policy::plan_json(&routing.plan),
        "policy": {
            "tier": routing.policy.tier.as_str(),
            "max_simulations": routing.policy.max_simulations,
            "quota_per_round": routing.policy.quota_per_round,
        },
        "quota_guarded": routing.quota_guarded,
    }))
}

// ── 会话命令（真实数据）──

/// 会话清单（按最近活跃倒序；引擎记录为真实数据源）。
#[tauri::command]
async fn session_list() -> Result<JsonValue, String> {
    let sessions = session::fetch_sessions().await?;
    let rows: Vec<JsonValue> = sessions
        .iter()
        .map(session::session_meta_to_record)
        .collect();
    Ok(json!({ "sessions": rows }))
}

/// 新建会话（引擎线程 id；标题留空待首回合生成）。
#[tauri::command]
async fn session_create() -> Result<JsonValue, String> {
    let id = session::new_thread_id();
    let meta = session::new_session(&id);
    session::save_session(&meta).await?;
    Ok(session::session_meta_to_record(&meta))
}

/// 重命名会话（手改覆盖标题；≤12 字约束在域层）。
#[tauri::command]
async fn session_rename(thread_id: String, title: String) -> Result<JsonValue, String> {
    let mut meta = session::fetch_session_meta(&thread_id)
        .await?
        .ok_or_else(|| format!("会话不存在: {thread_id}"))?;
    session::rename_session(&mut meta, &title).map_err(|err| err.to_string())?;
    session::save_session(&meta).await?;
    Ok(session::session_meta_to_record(&meta))
}

/// 删除会话（记录墓碑 + 线程链清理）。
#[tauri::command]
async fn session_delete(thread_id: String) -> Result<JsonValue, String> {
    session::delete_session(&thread_id).await?;
    Ok(json!({ "deleted": true, "thread_id": thread_id }))
}

/// 回合后刷新（消息计数 + 首回合标题生成；幂等）。
#[tauri::command]
async fn session_refresh(thread_id: String) -> Result<JsonValue, String> {
    session::refresh_session_after_round(&thread_id).await
}

/// 会话分支树（链索引 → 叶树；新建会话 = 空树）。
#[tauri::command]
async fn session_tree(thread_id: String) -> Result<JsonValue, String> {
    let tree = session::fetch_branch_tree(&thread_id).await?;
    let nodes: Vec<JsonValue> = tree
        .nodes
        .iter()
        .map(|node| {
            json!({
                "leaf": node.leaf,
                "parent": node.parent,
                "reason": node.reason,
            })
        })
        .collect();
    Ok(json!({
        "session_id": tree.session_id,
        "nodes": nodes,
        "current_leaf": tree.current_leaf,
    }))
}

/// 分支动作（切换叶/切回原叶/链回退/fork 新叶）。
#[tauri::command]
async fn session_branch(
    thread_id: String,
    action: String,
    target_leaf: Option<i64>,
    edit_text: Option<String>,
) -> Result<JsonValue, String> {
    let tree = session::fetch_branch_tree(&thread_id).await?;
    match action.as_str() {
        "branch" => {
            let parent = target_leaf.ok_or_else(|| "分支缺父叶".to_string())?;
            let patch = match edit_text {
                Some(text) => json!({
                    "input": text,
                    "messages": [{ "role": "user", "content": text }],
                }),
                None => json!({}),
            };
            let leaf = session::fork_branch(&tree, parent, patch).await?;
            Ok(json!({ "leaf": leaf, "action": "branch" }))
        }
        other => {
            let leaf = session::branch_action(&tree, other, target_leaf).await?;
            Ok(json!({ "leaf": leaf, "action": other }))
        }
    }
}

// ── 授权 / 审批命令 ──

/// 授权状态（工作区根；无授权记录 = 未授权）。
#[tauri::command]
async fn authorization_state() -> Result<JsonValue, String> {
    let security = security_domain_from_seed()?;
    let root = domain::security::load_authorization(&security).await?;
    Ok(json!({ "authorized": root.is_some(), "root": root }))
}

/// 授权（工作区根写入记录 + 挂载点登记；引擎侧文件工具随装配生效）。
#[tauri::command]
async fn workspace_authorize(state: State<'_, ShellState>, path: String) -> Result<JsonValue, String> {
    let resolved = expand_home(&path);
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|err| format!("工作区不可达: {} ({err})", resolved.display()))?;
    {
        let mut mounts = state.mounts.lock().unwrap();
        if !mounts.contains(&canonical) {
            mounts.push(canonical.clone());
        }
    }
    let record = json!({
        "root": canonical.display().to_string(),
        "authorized_at": chrono::Utc::now().timestamp_millis(),
    });
    domain::security::persist_authorization(record).await?;
    Ok(json!({ "authorized": true, "root": canonical.display().to_string() }))
}

/// 撤销授权（记录置空；重启后不再恢复）。
#[tauri::command]
async fn workspace_revoke() -> Result<JsonValue, String> {
    domain::security::persist_authorization(json!({ "root": "" })).await?;
    Ok(json!({ "authorized": false }))
}

/// 审批卡请求（回合外两步形态：先请求落卡，后注入决议）。
#[tauri::command]
async fn approval_request(
    thread_id: Option<String>,
    key: String,
    action: JsonValue,
    payload: Option<JsonValue>,
) -> Result<JsonValue, String> {
    approval_card(thread_id.as_deref(), &key, action, payload, None).await
}

/// 审批决议注入（决议经操作通道预注入；已决去重）。
#[tauri::command]
async fn approval_resolve(
    thread_id: Option<String>,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
) -> Result<JsonValue, String> {
    approval_card(
        thread_id.as_deref(),
        &key,
        json!({}),
        None,
        Some(json!({
            "decision": decision,
            "reason": reason,
            "edited_content": edited_content,
        })),
    )
    .await
}

/// 审批卡操作通道接线（请求 + 决议注入共用入口）。
async fn approval_card(
    thread_id: Option<&str>,
    key: &str,
    action: JsonValue,
    payload: Option<JsonValue>,
    decision: Option<JsonValue>,
) -> Result<JsonValue, String> {
    let mut args = json!({
        "thread_id": thread_id,
        "key": key,
        "action": action,
    });
    if let Some(payload) = payload {
        args["payload"] = payload;
    }
    if let Some(decision) = decision {
        args["decision"] = decision.get("decision").cloned().unwrap_or_else(|| json!("reject"));
        if let Some(reason) = decision.get("reason").and_then(JsonValue::as_str) {
            args["reason"] = json!(reason);
        }
        if let Some(edited) = decision.get("edited_content") {
            if !edited.is_null() {
                args["edited_content"] = edited.clone();
            }
        }
    }
    engine::host::call_engine_op_async("approval.gate_card_request", args).await
}

// ── 能力设置（推演档位等持久化）──

/// 读取能力设置（无记录 = 装配数据默认档：轻探测）。
#[tauri::command]
async fn capability_get() -> Result<JsonValue, String> {
    let record = engine::host::call_engine_op_async(
        "engine.records_get",
        json!({ "collection": CAPABILITY_COLLECTION, "key": CAPABILITY_KEY }),
    )
    .await?;
    if record.is_null() {
        let workflow = load_workflow_data()?;
        let default = domain::policy::default_simulation_tier_from_data(&workflow);
        Ok(json!({ "simulation_tier": default.as_str() }))
    } else {
        Ok(record)
    }
}

/// 保存能力设置（档位阈值随装配数据，此处只存档选）。
#[tauri::command]
async fn capability_put(record: JsonValue) -> Result<JsonValue, String> {
    engine::host::call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": CAPABILITY_COLLECTION,
            "key": CAPABILITY_KEY,
            "data": record,
        }),
    )
    .await?;
    Ok(record)
}

// ── 导出 / 备份 / 恢复命令 ──

/// 一键导出（data_dir 打包 → 目标文件；含引擎存储快照）。
#[tauri::command]
async fn backup_export(app: AppHandle, dest: String) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    let manifest = domain::backup::pack_data_dir(&data_dir, Path::new(&dest))
        .map_err(|err| err.to_string())?;
    Ok(json!({
        "entries": manifest.entries.len(),
        "size": manifest.entries.iter().map(|e| e.size).sum::<u64>(),
        "created_at": manifest.created_at,
        "has_db": manifest.engine_snapshot,
    }))
}

/// 恢复预览（校验包 → 重建预览：覆盖计数/大小/含库）。
#[tauri::command]
async fn backup_preview(path: String) -> Result<JsonValue, String> {
    let manifest = domain::backup::validate_backup(Path::new(&path))
        .map_err(|err| err.to_string())?;
    let preview_dir = std::env::temp_dir();
    let preview = domain::backup::preview_restore(&manifest, &preview_dir);
    Ok(json!({
        "entries_total": preview.entries_total,
        "will_overwrite": preview.will_overwrite,
        "total_size": preview.total_size,
        "has_db": preview.has_db,
        "created_at": manifest.created_at,
    }))
}

/// 恢复执行（校验 → 当前态快照 → 解包落位；失败留快照不击穿）。
#[tauri::command]
async fn backup_restore(app: AppHandle, path: String) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    let snapshots_dir = data_dir.join("snapshots");
    let (preview, snapshot) = domain::backup::execute_restore(
        Path::new(&path),
        &data_dir,
        &snapshots_dir,
    )
    .map_err(|err| err.to_string())?;
    Ok(json!({
        "restored_entries": preview.entries_total,
        "will_overwrite": preview.will_overwrite,
        "total_size": preview.total_size,
        "has_db": preview.has_db,
        "snapshot": snapshot.display().to_string(),
        "restore_from": path,
    }))
}

// ── 工具快照 / 组件清单 ──

/// 工具快照（四层兜底标签 + 工具族分组；管理台/名映射共用）。
#[tauri::command]
fn tools_snapshot(state: State<'_, ShellState>) -> JsonValue {
    let map: Vec<JsonValue> = state
        .backend
        .tool_provider
        .name_map()
        .iter()
        .map(|entry| json!({ "tool": entry.tool, "zh": entry.zh, "group": entry.group }))
        .collect();
    json!({ "tools": map })
}

/// 组件构建产物清单（挂载后注册表刷新的数据源；无清单 = 空）。
#[tauri::command]
fn components_manifest(app: AppHandle) -> JsonValue {
    let manifest_path = match app_data_dir(&app) {
        Ok(dir) => dir.join("components").join(COMPONENT_MANIFEST_FILE),
        Err(_) => PathBuf::new(),
    };
    if manifest_path.is_file() {
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
            .unwrap_or_else(|| json!({ "artifacts": [] }))
    } else {
        json!({ "artifacts": [] })
    }
}

// ── 底层辅助 ──

/// 安全域实例（授权命令按 seed 声明装载判定语义）。
fn security_domain_from_seed() -> Result<domain::security::SecurityDomain, String> {
    let bundle = domain::recipe::load_seed_data(&seed_root())
        .map_err(|err| format!("种子装载失败: {err}"))?;
    domain::security::SecurityDomain::from_tool_data(bundle.file("tools.json"))
        .map_err(|err| format!("安全域装载失败: {err}"))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("应用数据目录不可达: {err}"))?
        .join("inkling");
    std::fs::create_dir_all(&dir).map_err(|err| format!("数据目录创建失败: {err}"))?;
    Ok(dir)
}

/// process_exec 命令：引擎工具调配器经统一流水线调用（权限分级由引擎
/// 审批层判定后传 approved；壳只强制 deny/沙箱，不自行决定审批）。
#[tauri::command]
fn process_exec(
    state: tauri::State<'_, ShellState>,
    backend: tauri::State<'_, ShellBackend>,
    tool: String,
    args: serde_json::Value,
    approved: bool,
) -> Result<serde_json::Value, String> {
    let args_map = args
        .as_object()
        .cloned()
        .map(|map| map.into_iter().collect::<std::collections::BTreeMap<String, serde_json::Value>>())
        .ok_or_else(|| format!("工具参数须为对象: {tool}"))?;
    let auth = Authorization { approved };
    let outcome = state
        .registry
        .run(&tool, &args_map, backend.inner(), &auth)
        .map_err(|err| err.to_string())?;
    Ok(serde_json::json!({
        "tool": tool,
        "result": outcome.result,
        "sandbox": outcome.sandbox_checked,
    }))
}

/// 文件挂载授权：目录加入授权挂载点（文件沙箱根）。
/// 宿主侧人工授权（设置页「工作区授权」）；集成期由引擎审批层叠加判定。
#[tauri::command]
fn mount_authorize(state: tauri::State<'_, ShellState>, path: String) -> Result<Vec<String>, String> {
    let mut mounts = state.mounts.lock().unwrap();
    let resolved = expand_home(&path);
    let canonical = std::fs::canonicalize(&resolved).map_err(|err| format!("挂载目录不可达: {path} ({err})"))?;
    if !mounts.contains(&canonical) {
        mounts.push(canonical.clone());
    }
    Ok(mounts.iter().map(|p| p.display().to_string()).collect())
}

#[tauri::command]
fn mount_list(state: tauri::State<'_, ShellState>) -> Vec<String> {
    state
        .mounts
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.display().to_string())
        .collect()
}

/// 设备感知 server 调用（进程内接线形态；宿主侧 MCP stdio 形态见 mcp 模块）。
#[tauri::command]
fn device_mcp_call(
    state: tauri::State<'_, ShellState>,
    backend: tauri::State<'_, ShellBackend>,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let args_map = args
        .as_object()
        .cloned()
        .map(|map| map.into_iter().collect::<std::collections::BTreeMap<String, serde_json::Value>>())
        .ok_or_else(|| format!("工具参数须为对象: {tool}"))?;
    // 设备感知工具出厂 allow 级；审批语义与 process_exec 同源（壳只强制沙箱）
    let auth = Authorization { approved: true };
    let outcome = state
        .registry
        .run(&tool, &args_map, backend.inner(), &auth)
        .map_err(|err| err.to_string())?;
    Ok(serde_json::json!({ "tool": tool, "result": outcome.result }))
}

fn expand_home(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘：打开窗口 / 退出（宿主常驻形态，与 forge 壳同构）。
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开 InKling", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("icon".into()))?;
    TrayIconBuilder::with_id("inkling-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    let stop = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 嵌入解释器就绪（引擎桥前置；进程内一次）
            engine::host::ensure_python();
            // 声明加载 + 执行器注册 + 签名自检（不一致 = 启动失败，fail-closed）
            let declarations: ToolDeclarations = load_tool_declarations(TOOLS_DECL_JSON)
                .expect("工具声明解析失败（声明损坏，壳拒绝启动）");
            let registry = build_registry_from_declarations(&declarations)
                .expect("执行器注册契约校验失败（声明 ↔ 执行器签名不一致）");

            let mounts = vec![expand_home(DEFAULT_MOUNT_ROOT)];
            app.manage(ShellState {
                mounts: Mutex::new(mounts),
                registry,
                backend: ShellBackendState::new(),
            });

            let backend = build_shell_backend(app.handle().clone());
            app.manage(backend);

            build_tray(app.handle())?;
            let _ = stop;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process_exec,
            mount_authorize,
            mount_list,
            device_mcp_call,
            backend_status,
            engine_boot,
            round_send,
            round_abort,
            round_resume,
            route_plan,
            session_list,
            session_create,
            session_rename,
            session_delete,
            session_refresh,
            session_tree,
            session_branch,
            authorization_state,
            workspace_authorize,
            workspace_revoke,
            approval_request,
            approval_resolve,
            capability_get,
            capability_put,
            backup_export,
            backup_preview,
            backup_restore,
            tools_snapshot,
            components_manifest,
        ])
        .build(tauri::generate_context!())
        .expect("InKling 桌面壳装配失败");

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            stop.store(true, Ordering::Relaxed);
        }
    });
}

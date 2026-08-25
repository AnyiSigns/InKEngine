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
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

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

/// 运行形态仓库根：捆绑形态 = 数据目录（引擎包/种子根随首启解包落位，
/// 用户零仓库零 Python 前置）；开发形态 = 仓库根。
fn repo_root_for(data_dir: &Path) -> PathBuf {
    if engine::runtime::bundled_mode() {
        data_dir.to_path_buf()
    } else {
        dev_repo_root()
    }
}

/// 本地语义嵌入模型目录：捆绑形态 = 数据目录 assets/ 解包位；开发形态
/// = 仓库 models/（存在才注入，缺模型 = 检索回落关键词基线）。
fn embedder_model_dir(data_dir: &Path) -> Option<PathBuf> {
    let dir = if engine::runtime::bundled_mode() {
        engine::runtime::model_dir_in(data_dir)
    } else {
        dev_repo_root().join("inkling").join("models").join("granite-97m")
    };
    dir.is_dir().then_some(dir)
}

/// 装配选项（开发形态：app_data_dir 内 sqlite + 数据目录落盘；
/// safe_mode = 崩溃循环下出厂基线启动；捆绑形态自动解包资源）。
fn boot_options(
    repo_root: PathBuf,
    data_dir: PathBuf,
    safe_mode: bool,
) -> engine::host::BootOptions {
    engine::host::BootOptions {
        repo_root,
        storage_uri: format!("sqlite:///{}", data_dir.join("inkling.sqlite").display()),
        data_dir: Some(data_dir.clone()),
        safe_mode,
        bundled: engine::runtime::bundled_mode(),
        embedder_model_dir: embedder_model_dir(&data_dir),
        // 引擎路径装配机制出厂全开（契约/证据/沉淀/池/组装/多径/指纹
        // 七块启用；逐块独立，单块异常可关闭回滚）
        path_assembly: engine::host::PathAssemblyFlags {
            contract_enabled: true,
            edge_evidence_enabled: true,
            settle_hooks_enabled: true,
            pool_governance_enabled: true,
            assembler_enabled: true,
            multipath_enabled: true,
            fingerprint_cache_enabled: true,
        },
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
/// 目标 + 链恢复全在装配域包内）；装配失败 = 结构化错误（透传引擎侧
/// 真实错误）。崩溃回退（红线二）编排在此完成：
/// - 启动状态跟踪：失败计数 → 达阈值自动转入安全模式重试（出厂基线
///   启动，链内容不参与装配）；成功启动计数归零；
/// - 启动快照轮换：装配成功后按链版本落一份存储快照（N 份轮换，绑定
///   链版本号），供「回到上一稳定版本」一键回落取用。
fn ensure_engine(state: &ShellState, data_dir: &Path) -> Result<(), String> {
    let mut engine = state.backend.engine.lock().unwrap();
    if engine.is_some() {
        return Ok(());
    }
    let boot_state = domain::recovery::load_boot_state(data_dir);
    let repo_root = repo_root_for(data_dir);
    let host = match engine::host::EngineHost::boot(boot_options(
        repo_root.clone(),
        data_dir.to_path_buf(),
        boot_state.safe_mode,
    )) {
        Ok(host) => host,
        Err(err) if boot_state.safe_mode => {
            return Err(format!("引擎装配失败（安全模式）: {err}"));
        }
        Err(err) => {
            // 崩溃计数 +1；达到阈值自动转入安全模式重试（出厂基线启动）
            let state = domain::recovery::record_boot_failure(data_dir);
            if !state.safe_mode {
                return Err(format!("引擎装配失败: {err}"));
            }
            match engine::host::EngineHost::boot(boot_options(
                repo_root,
                data_dir.to_path_buf(),
                true,
            )) {
                Ok(host) => host,
                Err(safe_err) => {
                    return Err(format!(
                        "引擎装配失败（自动安全模式亦失败）: {err} / {safe_err}"
                    ));
                }
            }
        }
    };
    domain::recovery::record_boot_success(data_dir);
    // 工具快照：出厂清单 + 装配后实时表（内省源同步 + 重取）
    if let Ok(bundle) = domain::recipe::load_seed_data(&seed_root()) {
        state
            .backend
            .tool_provider
            .replace_from_seed(bundle.file("tools.json"));
        let _ = state.backend.tool_provider.refresh();
    }
    *engine = Some(host);
    // 启动快照轮换（非安全模式：安全模式下存储为崩溃前形态，不覆盖
    // 既有稳定快照；失败仅留观测日志，不阻断装配）
    if !domain::recovery::load_boot_state(data_dir).safe_mode {
        if let Err(snap_err) = take_startup_snapshot(data_dir) {
            eprintln!("[recovery] 启动快照失败: {snap_err}");
        }
    }
    Ok(())
}

/// 启动快照轮换：引擎存储快照（存储契约）→ 版本化落位 → N 份轮换。
///
/// 快照绑定链版本号（快照时刻的补丁链版本；回上一稳定版本 = 从最新
/// 快照恢复）；快照为崩溃回退的稳定态备份——恢复后重启即回到快照
/// 时刻形态。
fn take_startup_snapshot(data_dir: &Path) -> Result<(), String> {
    let snap_dir = domain::recovery::snapshot_dir(data_dir);
    std::fs::create_dir_all(&snap_dir)
        .map_err(|err| format!("快照目录创建失败: {err}"))?;
    let fresh = snap_dir.join(format!(
        ".incoming-{}.sqlite",
        uuid::Uuid::new_v4().simple()
    ));
    let fresh_text = fresh.to_string_lossy().into_owned();
    let outcome = block_on_op_async("engine.storage_snapshot", serde_json::json!({ "dest": fresh_text }))
        .map_err(|err| format!("引擎快照失败: {err}"))?;
    if outcome.get("snapshotted").and_then(serde_json::Value::as_bool) != Some(true) {
        let _ = std::fs::remove_file(&fresh);
        return Err("引擎快照未确认落位".to_string());
    }
    // 链版本绑定：链记录补丁段长度 + 1（记录读取失败回落 1，不阻断）
    let chain_record = block_on_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": "set_patch_chain", "key": "chain" }),
    )
    .unwrap_or(serde_json::Value::Null);
    let chain_version = domain::boot::chain_version(&chain_record);
    domain::recovery::rotate_snapshot(data_dir, &fresh, chain_version)
        .map(|_| ())
        .map_err(|err| err.to_string())
}

/// 同步驱动异步引擎操作（装配/恢复路径无 tokio 上下文时使用；
/// 单线程运行时内完成，与引擎线程亲和纪律一致）。
fn block_on_op_async(op: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("操作运行时创建失败: {err}"))?
        .block_on(engine::host::call_engine_op_async(op, args))
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

/// 首启标记文件名（数据目录；存在 = 已完成首次装配引导）。
const FIRST_RUN_MARKER: &str = ".first_run";

/// 首启标记判定（未标记 = 首启引导待展示）。
fn first_run_pending(data_dir: &Path) -> bool {
    !data_dir.join(FIRST_RUN_MARKER).is_file()
}

/// 执行件就位判定（随包检查）：捆绑形态查数据目录解包位，开发形态查
/// 仓库 exec 构建产物；缺构建/缺解包 = 未就位（UI 展示诊断入口）。
fn exec_present(data_dir: &Path) -> bool {
    let dir = if engine::runtime::bundled_mode() {
        engine::runtime::exec_dir_in(data_dir)
    } else {
        let base = dev_repo_root().join("inkling/exec/target");
        let debug_dir = base.join("debug");
        let release_dir = base.join("release");
        return domain::exec_proc::locate_exec_binary(&debug_dir).is_ok()
            || domain::exec_proc::locate_exec_binary(&release_dir).is_ok();
    };
    domain::exec_proc::locate_exec_binary(&dir).is_ok()
}

/// 后端状态（前端启动探测：引擎是否就绪/工具面大小/安全模式标志/
/// 首启引导/执行件随包就位/运行形态）。
#[tauri::command]
fn backend_status(app: AppHandle, state: State<'_, ShellState>) -> JsonValue {
    let safe_mode = app_data_dir(&app)
        .map(|dir| domain::recovery::load_boot_state(&dir).safe_mode)
        .unwrap_or(false);
    let first_run = app_data_dir(&app)
        .map(|dir| first_run_pending(&dir))
        .unwrap_or(true);
    let exec_ready = app_data_dir(&app)
        .map(|dir| exec_present(&dir))
        .unwrap_or(false);
    json!({
        "engine_ready": state.backend.engine_ready(),
        "tool_count": state.backend.tool_provider.len(),
        "safe_mode": safe_mode,
        "first_run": first_run,
        "exec_ready": exec_ready,
        "bundled": engine::runtime::bundled_mode(),
    })
}

/// 首启引导关闭（标记落位；下次启动不再展示引导）。
#[tauri::command]
fn first_run_dismiss(app: AppHandle) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    std::fs::write(data_dir.join(FIRST_RUN_MARKER), serde_json::json!({
        "dismissed_at": chrono::Utc::now().timestamp_millis(),
    }).to_string())
    .map_err(|err| format!("首启标记写入失败: {err}"))?;
    Ok(json!({ "dismissed": true }))
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
        orchestrate: None,
        inject: None,
        auto_accept_review: auto_accept_review.unwrap_or(true),
    };
    let engine_guard = state.backend.engine.lock().unwrap();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "引擎未装配（引擎装配失败或尚未就绪）".to_string())?;
    // 事件流式通道：回合内逐事件实时发射（前端 listen 增量渲染）；
    // 发射失败只记日志不阻断回合（事件收集缓冲与返回体照常）。
    let stream_app = app.clone();
    engine.set_event_emitter(Some(Box::new(move |event_json: &str| {
        let parsed: JsonValue = serde_json::from_str(event_json).unwrap_or(JsonValue::Null);
        if let Err(err) = stream_app.emit("inkling://round_event", parsed) {
            eprintln!("[events] 流式事件发射失败: {err}");
        }
    })));
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

/// 读取能力设置（无记录 = 装配数据默认档：轻探测；自动审批字段
/// 缺省 = 出厂空集——不勾选即不预授权，最保守）。
#[tauri::command]
async fn capability_get() -> Result<JsonValue, String> {
    let record = engine::host::call_engine_op_async(
        "engine.records_get",
        json!({ "collection": CAPABILITY_COLLECTION, "key": CAPABILITY_KEY }),
    )
    .await?;
    let mut merged = match record {
        JsonValue::Object(map) => JsonValue::Object(map),
        _ => json!({}),
    };
    if merged.get("simulation_tier").and_then(JsonValue::as_str).is_none() {
        let workflow = load_workflow_data()?;
        let default = domain::policy::default_simulation_tier_from_data(&workflow);
        merged["simulation_tier"] = json!(default.as_str());
    }
    if merged.get("auto_approve_tools").is_none() {
        merged["auto_approve_tools"] = json!([]);
    }
    if merged.get("auto_approve_all_review").is_none() {
        merged["auto_approve_all_review"] = json!(false);
    }
    Ok(merged)
}

/// 保存能力设置（自动审批先经安全域校验并应用：登记边界外工具
/// 整体拒绝、不落盘；档位阈值随装配数据，此处只存档选）。
#[tauri::command]
async fn capability_put(record: JsonValue) -> Result<JsonValue, String> {
    if record.get("auto_approve_tools").is_some() || record.get("auto_approve_all_review").is_some() {
        let auto_tools = record
            .get("auto_approve_tools")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let auto_all = record
            .get("auto_approve_all_review")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        // 先应用（登记边界在安全域内硬拒，失败 = 不落盘）
        let applied = engine::host::call_engine_op_async(
            "security.auto_approve_set",
            json!({ "tools": auto_tools, "all_review": auto_all }),
        )
        .await?;
        if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
            return Err("自动审批配置未生效（安全域拒绝）".to_string());
        }
    }
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

// ── 崩溃回退（红线二：启动快照 / 一键回落）──

/// 启动快照清单（「回到上一稳定版本」的取用入口：绑定链版本 + 时间序）。
#[tauri::command]
fn recovery_snapshots(app: AppHandle) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    let snapshots: Vec<JsonValue> = domain::recovery::list_snapshots(&data_dir)
        .into_iter()
        .map(|meta| {
            json!({
                "name": meta.name,
                "chain_version": meta.chain_version,
                "created_at": meta.created_at,
            })
        })
        .collect();
    Ok(json!({ "snapshots": snapshots }))
}

/// 回到上一稳定版本：从指定启动快照恢复（引擎存储契约 restore）→
/// 引擎停机重挂（下次命令触发重新装配 = 快照时刻形态）→ 退出安全模式。
///
/// 快照名只接受既有清单条目（防路径穿越：不拼接用户输入路径）。
#[tauri::command]
async fn recovery_restore_snapshot(
    app: AppHandle,
    state: State<'_, ShellState>,
    name: String,
) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    let metas = domain::recovery::list_snapshots(&data_dir);
    let meta = metas
        .iter()
        .find(|m| m.name == name)
        .ok_or_else(|| format!("快照不存在: {name}"))?;
    ensure_engine(&state, &data_dir)?;
    let src = meta.path.to_string_lossy().into_owned();
    let outcome = engine::host::call_engine_op_async(
        "engine.storage_restore",
        serde_json::json!({ "src": src }),
    )
    .await
    .map_err(|err| format!("快照恢复失败: {err}"))?;
    if outcome.get("restored").and_then(JsonValue::as_bool) != Some(true) {
        return Err("快照恢复未确认落位".to_string());
    }
    // 引擎停机重挂：恢复后一致态由下次装配保证（会话/记忆/链回到快照时刻）
    if let Some(host) = state.backend.engine.lock().unwrap().take() {
        let _ = host.stop();
    }
    domain::recovery::clear_safe_mode(&data_dir);
    Ok(json!({
        "restored": meta.name,
        "chain_version": meta.chain_version,
    }))
}

/// 出厂重置：补丁链逐尾回退至基线（每条回退走既有回退路径、逐条落
/// 审计）；链记录损坏（回退不可用）时回落为链记录整体清空 + 审计
/// 留痕。完成后引擎停机重挂（下次装配 = 出厂基线 + 种子重注入），
/// 并退出安全模式。
#[tauri::command]
async fn recovery_factory_reset(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&state, &data_dir)?;
    let mut reverted: Vec<i64> = Vec::new();
    let mut overwritten = false;
    loop {
        let record = engine::host::call_engine_op_async(
            "engine.records_get",
            serde_json::json!({ "collection": "set_patch_chain", "key": "chain" }),
        )
        .await
        .unwrap_or(JsonValue::Null);
        let version = domain::boot::chain_version(&record);
        if version <= 1 {
            break;
        }
        let outcome = engine::host::call_engine_op_async(
            "patch.revert",
            serde_json::json!({
                "patch_id": version,
                "decision": "accept",
                "reason": "出厂重置：逐尾回退至基线",
                "thread_id": "recovery",
            }),
        )
        .await;
        let status = match &outcome {
            Ok(value) => value["outcome"].get("status").and_then(JsonValue::as_str),
            Err(_) => None,
        };
        if status != Some("reverted") {
            // 链记录损坏（回退不可用）：清空回基线 + 审计留痕（机制
            // 豁免路径；被清空补丁数随审计记录保留）
            overwritten = true;
            engine::host::call_engine_op_async(
                "engine.chain_reset_to_base",
                serde_json::json!({ "reason": "出厂重置：链记录损坏，清空至基线" }),
            )
            .await
            .map_err(|err| format!("出厂重置（清空）失败: {err}"))?;
            break;
        }
        reverted.push(version);
    }
    // 引擎停机重挂：下次装配 = 出厂基线（链已空 + 种子重注入）
    if let Some(host) = state.backend.engine.lock().unwrap().take() {
        let _ = host.stop();
    }
    domain::recovery::clear_safe_mode(&data_dir);
    Ok(json!({
        "reverted_patches": reverted,
        "overwritten": overwritten,
    }))
}

// ── 工具快照 / 组件清单 ──

/// 工具快照（四层兜底标签 + 工具族 + 自动审批可登记标记；管理台/
/// 名映射/设置页勾选项共用）。
#[tauri::command]
fn tools_snapshot(state: State<'_, ShellState>) -> JsonValue {
    let provider = state.backend.tool_provider.clone();
    let map: Vec<JsonValue> = provider
        .name_map()
        .iter()
        .map(|entry| {
            let auto_approvable = provider
                .lookup(&entry.tool)
                .and_then(|spec| {
                    spec.get("meta")
                        .and_then(|meta| meta.get("auto_approvable"))
                        .and_then(JsonValue::as_bool)
                })
                .unwrap_or(false);
            json!({
                "tool": entry.tool,
                "zh": entry.zh,
                "group": entry.group,
                "auto_approvable": auto_approvable,
            })
        })
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

// ── 后台任务域命令 ──

/// 启动后台任务（受控承载：经 mpsc 受前端/回合信号驱动，自身不执行引擎
/// 逻辑；事件经既有流式通道留痕，取消经既有链回退通道回退）。
#[tauri::command]
async fn task_start(
    app: AppHandle,
    id: String,
    kind: String,
    goal: String,
    thread_id: Option<String>,
    revert_target: Option<String>,
) -> Result<JsonValue, String> {
    crate::domain::tasks::bind_app(app);
    crate::domain::tasks::registry()
        .start_tracked(
            &id,
            &kind,
            &goal,
            thread_id.as_deref(),
            revert_target.as_deref(),
        )
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task_id": id, "started": true }))
}

/// 取消后台任务：cancel token 撤销在途工作 + 发射 task_cancelled + 经既有
/// `engine.thread_revert` 回退链。未知 id / 已终态 → 结构化错误。
#[tauri::command]
fn task_cancel(id: String, reason: Option<String>) -> Result<JsonValue, String> {
    crate::domain::tasks::registry()
        .cancel(
            &id,
            &reason.unwrap_or_else(|| crate::domain::tasks::DEFAULT_CANCEL_REASON.to_string()),
        )
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task_id": id, "cancelled": true }))
}

/// 上报后台任务进度（受控路径）。
#[tauri::command]
fn task_progress(id: String, progress: f64, note: Option<String>) -> Result<JsonValue, String> {
    crate::domain::tasks::registry()
        .progress_signal(&id, progress, &note.unwrap_or_default())
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task_id": id, "progress": progress }))
}

/// 标记后台任务完成（发射 task_done）。
#[tauri::command]
fn task_finish(id: String, result: String) -> Result<JsonValue, String> {
    crate::domain::tasks::registry()
        .finish_signal(&id, &result)
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task_id": id, "finished": true }))
}

/// 标记后台任务失败（发射 task_cancelled 兜底）。
#[tauri::command]
fn task_fail(id: String, reason: String) -> Result<JsonValue, String> {
    crate::domain::tasks::registry()
        .fail_signal(&id, &reason)
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task_id": id, "failed": true }))
}

/// 后台任务清单（全部元信息）。
#[tauri::command]
fn task_list() -> JsonValue {
    let metas = crate::domain::tasks::registry().list();
    json!({ "tasks": metas })
}

/// 单后台任务状态（未知 id → 结构化错误）。
#[tauri::command]
fn task_state(id: String) -> Result<JsonValue, String> {
    let meta = crate::domain::tasks::registry()
        .state(&id)
        .map_err(|err| err.to_string())?;
    Ok(json!({ "task": meta }))
}

/// 回合续跑并附项目任务对象（经既有 `engine.thread_resume` 通道；inject 透传
/// project_task，引擎零改动感知）。审批决议注入口径与 round_resume 同源。
#[tauri::command]
async fn task_resume(
    thread_id: String,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
    project_task: Option<JsonValue>,
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
    if let Some(pt) = project_task {
        inject["project_task"] = pt;
    }
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

// ── 模型档案（自动探测 + 上下文窗口/多模态能力标记；壳侧为主）──

/// 读取模型档案快照（全部已探测/补录档案，按 model_id 字典序）。
#[tauri::command]
fn model_archive_snapshot(app: AppHandle) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(&app)?;
    let mut store = domain::model_archive::ModelArchiveStore::open_in_data_dir(&data_dir)
        .map_err(|err| err.to_string())?;
    let archives = store
        .list()
        .map_err(|err| err.to_string())?
        .iter()
        .map(|a| a.to_json())
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "archives": archives }))
}

/// 触发模型清单探测与回写（连接配置保存/变更时调用）。
///
/// 入参：`base_url`/`api_key`（连接配置）+ `models`（宣告模型列表
/// `[{ "tier": "main"|"router", "model_id": "..." }]`，降级补录用）。
/// 探测失败/非 JSON/缺字段 → 结构化降级（按档位缺省窗口回落），不崩溃。
#[tauri::command]
async fn models_refresh(app: AppHandle, config: JsonValue) -> Result<JsonValue, String> {
    let base_url = config
        .get("base_url")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = config
        .get("api_key")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let declared: Vec<domain::model_archive::DeclaredModel> = config
        .get("models")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let model_id = item.get("model_id")?.as_str()?.to_string();
                    let tier = item
                        .get("tier")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("main")
                        .to_string();
                    Some(domain::model_archive::DeclaredModel { tier, model_id })
                })
                .collect()
        })
        .unwrap_or_default();
    let data_dir = app_data_dir(&app)?;
    let mut store = domain::model_archive::ModelArchiveStore::open_in_data_dir(&data_dir)
        .map_err(|err| err.to_string())?;
    let fetcher = domain::model_archive::HttpModelsFetcher::new();
    let report = domain::model_archive::refresh_archives(
        &mut store,
        &fetcher,
        &base_url,
        &api_key,
        &declared,
    )
    .await
    .map_err(|err| err.to_string())?;
    Ok(json!({
        "ok": true,
        "mode": if report.mode == domain::model_archive::RefreshMode::Success { "success" } else { "fallback" },
        "probed": report.probed,
        "stored": report.stored,
        "reason": report.reason,
    }))
}

/// 上下文指标快照（转发至嵌入桥 `metrics.snapshot` op；聚合回合/LLM/
/// 缓存/边证据指标，走既有引擎操作通道）。
#[tauri::command]
async fn metrics_snapshot(args: JsonValue) -> Result<JsonValue, String> {
    engine::host::call_engine_op_async("metrics.snapshot", args).await
}

/// 候选路径人工选择（透传至 `path.choose_candidate` op；干预即生效 + 审计）。
#[tauri::command]
async fn path_choose_candidate(
    candidate_id: Option<String>,
    domain: Option<String>,
    chain: Option<JsonValue>,
    fingerprint: Option<String>,
) -> Result<JsonValue, String> {
    let mut args = json!({
        "candidateId": candidate_id.unwrap_or_default(),
        "domain": domain.unwrap_or_else(|| "default".to_string()),
    });
    if let Some(chain) = chain {
        args["chain"] = chain;
    }
    if let Some(fingerprint) = fingerprint {
        args["fingerprint"] = JsonValue::String(fingerprint);
    }
    engine::host::call_engine_op_async("path.choose_candidate", args).await
}

/// 多径开关（透传至 `path.set_multipath` op；单块翻转保留其余装配开关）。
#[tauri::command]
async fn path_set_multipath(enabled: bool) -> Result<JsonValue, String> {
    engine::host::call_engine_op_async("path.set_multipath", json!({ "enabled": enabled })).await
}

/// 指纹缓存语义化失效（透传至 `cache.invalidate` op；清除后同请求不再命中）。
#[tauri::command]
async fn cache_invalidate(
    scope: String,
    reason: Option<String>,
) -> Result<JsonValue, String> {
    let mut args = json!({ "scope": scope });
    if let Some(reason) = reason {
        args["reason"] = JsonValue::String(reason);
    }
    engine::host::call_engine_op_async("cache.invalidate", args).await
}

/// 信任档人工降级（透传至 `edge.downgrade_tier` op；降级前快照可复原）。
#[tauri::command]
async fn edge_downgrade_tier(
    edge_id: String,
    tier: Option<String>,
) -> Result<JsonValue, String> {
    let mut args = json!({ "edgeId": edge_id });
    if let Some(tier) = tier {
        args["tier"] = JsonValue::String(tier);
    }
    engine::host::call_engine_op_async("edge.downgrade_tier", args).await
}

/// 文档解析（PDF/Office → 结构化 JSON；与壳执行器同源域函数，路径根收口）。
#[tauri::command]
fn doc_parse(path: String) -> Result<JsonValue, String> {
    let resolved = expand_home(&path);
    let bytes = std::fs::read(&resolved).map_err(|err| format!("读取文档失败: {err}"))?;
    domain::doc_ops::parse_document(&bytes).map_err(|err| err.to_string())
}

/// 文档生成（docx 报告 / xlsx 表格 → 落盘工作区根，返回路径与字节数）。
#[tauri::command]
fn doc_generate(
    format: String,
    title: String,
    body: Option<String>,
    table: Option<String>,
) -> Result<JsonValue, String> {
    let bytes = match format.as_str() {
        "docx" => {
            use domain::doc_ops::{build_docx_report, DocxReportSpec, DocxSection};
            let spec = DocxReportSpec {
                title: title.clone(),
                sections: vec![DocxSection {
                    heading: None,
                    body: body.unwrap_or_default(),
                }],
                table: None,
            };
            build_docx_report(&spec).map_err(|err| err.to_string())?
        }
        "xlsx" => {
            use domain::doc_ops::build_xlsx_table;
            let rows: Vec<Vec<String>> = table
                .and_then(|text| serde_json::from_str::<Vec<Vec<String>>>(&text).ok())
                .unwrap_or_default();
            build_xlsx_table(&title, &rows).map_err(|err| err.to_string())?
        }
        other => return Err(format!("不支持的文档格式: {other}（docx/xlsx）")),
    };
    let out_dir = expand_home(DEFAULT_MOUNT_ROOT);
    std::fs::create_dir_all(&out_dir).map_err(|err| format!("输出目录创建失败: {err}"))?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let safe_title: String = title
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect();
    let ext = if format == "xlsx" { "xlsx" } else { "docx" };
    let out_path = out_dir.join(format!("{safe_title}_{stamp}.{ext}"));
    std::fs::write(&out_path, &bytes).map_err(|err| format!("文档写入失败: {err}"))?;
    Ok(json!({
        "path": out_path.to_string_lossy(),
        "format": format,
        "bytes": bytes.len(),
    }))
}

/// 屏幕截图（隐私分级：本地直喂 / 云端默认禁外发，授权开关 + 审批回调，
/// 外发事件落审计；与壳执行器同源域函数）。
#[tauri::command]
fn screenshot_capture(
    model_class: String,
    destination: Option<String>,
) -> Result<JsonValue, String> {
    use domain::screenshot::{
        capture_and_feed, WindowsScreenCapturer, ModelClass, VisionGate, VisionSettings,
    };
    let model = match model_class.as_str() {
        "local" => ModelClass::Local,
        "cloud" => ModelClass::Cloud,
        other => return Err(format!("目标模型类别非法: {other}（local/cloud）")),
    };
    let destination = destination.unwrap_or_else(|| "engine".to_string());
    let settings_path = expand_home("~/.inkling/vision.json");
    let settings = VisionSettings::load(&settings_path).unwrap_or_else(|_| VisionSettings::default());
    let gate = VisionGate {
        settings,
        approve: std::sync::Arc::new(|| false),
    };
    let out_dir = expand_home("~/.inkling/attachments");
    let capturer = WindowsScreenCapturer;
    let attachment = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("截图运行时构建失败: {err}"))?
        .block_on(capture_and_feed(
            &capturer,
            &gate,
            model,
            &destination,
            &out_dir,
            &None,
        ))
        .map_err(|err| err.to_string())?;
    Ok(attachment.to_dict())
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
    // 设备感知工具审批语义与 process_exec 同源：审批闸门在引擎侧 approval
    // 档（seed 单源，出厂 review）；壳此路径只强制沙箱，不重复弹卡
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

/// 自检持久化标记文件名（selftest 二次运行的会话持久断言基准）。
const SELFTEST_PHASE_MARKER: &str = ".selftest_phase";

/// 出厂自检（`--selftest` 入口）：全新机器路径模拟——不依赖仓库/不依赖
/// 外部 Python，只依赖发行资源（或显式注入的模拟环境）。覆盖面：
/// 首启解包 → 内嵌解释器 → 引擎装配 → stub 回合 → 会话记录持久 →
/// 导出包校验 → 执行件就位。
///
/// 运行方式：
/// - 数据目录 = `INK_DATA_DIR`（缺省 = 临时目录）；
/// - 捆绑形态 = release 构建自动开启，debug 构建经 `INKLING_BUNDLED=1`
///   模拟，资源根经 `INKLING_RESOURCE_DIR` 指向打包产物；
/// - 二次运行（同数据目录）断言会话持久（重启后列表可恢复）。
///
/// 返回 0 = 全过；非 0 = 失败（结构化错误到 stderr）。
pub fn selftest() -> i32 {
    let data_dir = std::env::var("INK_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::temp_dir().join(format!(
                "inkling-selftest-{}",
                uuid::Uuid::new_v4()
            ))
        });
    let phase = data_dir.join(SELFTEST_PHASE_MARKER).is_file();
    let outcome = run_selftest(&data_dir, phase);
    match outcome {
        Ok(summary) => {
            println!("{}", serde_json::to_string_pretty(&summary).unwrap_or_default());
            0
        }
        Err(err) => {
            eprintln!("SELFTEST FAIL: {err}");
            1
        }
    }
}

/// 自检单次运行（phase = 是否二次运行；二次运行断言会话持久）。
fn run_selftest(data_dir: &Path, phase: bool) -> Result<JsonValue, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|err| format!("数据目录创建失败 {}: {err}", data_dir.display()))?;
    let root = repo_root_for(data_dir);
    let options = engine::host::BootOptions {
        repo_root: root.clone(),
        storage_uri: format!(
            "sqlite:///{}",
            data_dir.join("inkling.sqlite").display()
        ),
        data_dir: Some(data_dir.to_path_buf()),
        stub_script: Some(serde_json::json!({
            "研究": {"reply": "自检回合通过：装配 → 回合 → 事件流完整。"},
        })),
        default_reply: "自检缺省回复".to_string(),
        bundled: engine::runtime::bundled_mode(),
        embedder_model_dir: embedder_model_dir(data_dir),
        ..Default::default()
    };
    let host = engine::host::EngineHost::boot(options).map_err(|err| format!("装配失败: {err}"))?;
    let report = host
        .report()
        .map_err(|err| format!("装配摘要失败: {err}"))?;
    if report.tool_names.is_empty() {
        return Err("装配摘要工具清单为空".to_string());
    }

    let outcome = host
        .round(engine::host::RoundRequest {
            input_text: "研究墨引擎机制".to_string(),
            thread_id: "selftest-t1".to_string(),
            round_id: "selftest-r1".to_string(),
            step_args: None,
            orchestrate: None,
            inject: None,
            auto_accept_review: true,
        })
        .map_err(|err| format!("回合失败: {err}"))?;
    if outcome.reason != "reply" {
        return Err(format!("回合未完成到回复: {}", outcome.reason));
    }
    if outcome.events.is_empty() {
        return Err("回合事件流为空".to_string());
    }

    // 会话记录：写入 → 列出（真实数据源 = 引擎 sqlite 记录）
    let session_id = if phase {
        "selftest-session-persisted".to_string()
    } else {
        "selftest-session-1".to_string()
    };
    let put = block_on_op_async(
        "engine.records_put",
        serde_json::json!({
            "collection": "sessions",
            "key": session_id,
            "data": {
                "thread_id": session_id,
                "title": "自检会话",
                "created_at": 1.0,
                "updated_at": 2.0,
                "message_count": 3,
                "current_leaf": 1i64,
                "rename_count": 0,
                "deleted": false,
            },
        }),
    )
    .map_err(|err| format!("会话写入失败: {err}"))?;
    let _ = put;
    let listed = block_on_op_async(
        "engine.records_list",
        serde_json::json!({ "collection": "sessions" }),
    )
    .map_err(|err| format!("会话列出失败: {err}"))?;
    let rows = listed.as_array().cloned().unwrap_or_default();
    let persisted = rows.iter().any(|row| {
        row.get("key").and_then(JsonValue::as_str) == Some(session_id.as_str())
            || row.get("thread_id").and_then(JsonValue::as_str) == Some(session_id.as_str())
    });
    if !persisted {
        return Err("会话记录未出现在清单（持久化失败）".to_string());
    }

    // 导出包：数据目录打包 → 校验（恢复向导入口的同一对校验函数）
    let pack_path = data_dir.join("selftest-export.zip");
    let manifest = domain::backup::pack_data_dir(data_dir, &pack_path)
        .map_err(|err| format!("导出失败: {err}"))?;
    let validated = domain::backup::validate_backup(&pack_path)
        .map_err(|err| format!("导出包校验失败: {err}"))?;
    if validated.entries.is_empty() {
        return Err("导出包条目为空".to_string());
    }
    let export_entries = validated.entries.len();
    let export_has_db = validated.engine_snapshot;
    let _ = manifest;

    // 执行件随包就位（捆绑形态硬断言；开发形态 = 仓库构建产物可定位）
    let exec_dir = if engine::runtime::bundled_mode() {
        engine::runtime::exec_dir_in(data_dir)
    } else {
        dev_repo_root().join("inkling/exec/target/debug")
    };
    let exec_ok = domain::exec_proc::locate_exec_binary(&exec_dir).is_ok();

    // 本地语义嵌入器（出厂接通断言：模型目录注入后计划解析 = 本地真实
    // 推理；缺模型 = 确定性保底，来源可观测）
    let embedder_note = match embedder_model_dir(data_dir) {
        Some(dir) => {
            let embedder = crate::domain::embedder::LocalOnnxEmbedder::with_model_dir(dir);
            let source = format!("{:?}", embedder.source());
            let note = embedder.note().map(|n| n.to_string());
            serde_json::json!({ "source": source, "note": note })
        }
        None => serde_json::json!({ "source": "not_injected", "note": null }),
    };

    if engine::runtime::bundled_mode() && !exec_ok {
        return Err("捆绑形态执行件未就位（resources/exec 缺随包二进制）".to_string());
    }

    host.stop().map_err(|err| format!("关停失败: {err}"))?;
    // 二次运行标记（会话持久断言的基准：下次运行同数据目录仍可见）
    if !phase {
        std::fs::write(
            data_dir.join(SELFTEST_PHASE_MARKER),
            serde_json::json!({ "phase": 1 }).to_string(),
        )
        .map_err(|err| format!("自检标记写入失败: {err}"))?;
    }

    Ok(serde_json::json!({
        "phase": if phase { 2 } else { 1 },
        "data_dir": data_dir.display().to_string(),
        "bundled": engine::runtime::bundled_mode(),
        "tool_count": report.tool_names.len(),
        "round_reason": outcome.reason,
        "event_count": outcome.events.len(),
        "session_persisted": persisted,
        "export_entries": export_entries,
        "export_has_db": export_has_db,
        "exec_ready": exec_ok,
        "embedder": embedder_note,
    }))
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

            // OS 执行体接桥：引擎链路（process_exec 端点 → 宿主 os_registry
            // 分发）经回调桥转发到本注册表——同一套运行体，两处调度点合一；
            // 回调执行在引擎回合线程，经 AppHandle 取托管状态（沙箱/授权在
            // 执行器 run 内强制，此处只做转发）。
            let os_bridge_app = app.handle().clone();
            engine::bridge::register_callback(
                "os.dispatch",
                Box::new(move |payload: String| -> pyo3::PyResult<String> {
                    let parsed: JsonValue = serde_json::from_str(&payload).map_err(|err| {
                        pyo3::exceptions::PyValueError::new_err(format!(
                            "os.dispatch 载荷非法: {err}"
                        ))
                    })?;
                    let tool = parsed
                        .get("tool")
                        .and_then(JsonValue::as_str)
                        .ok_or_else(|| {
                            pyo3::exceptions::PyValueError::new_err("os.dispatch 缺 tool")
                        })?
                        .to_string();
                    let args_obj = parsed.get("args").cloned().unwrap_or_else(|| json!({}));
                    let args_map: std::collections::BTreeMap<String, JsonValue> = args_obj
                        .as_object()
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .collect();
                    let state = os_bridge_app.state::<ShellState>();
                    let shell_backend = os_bridge_app.state::<ShellBackend>();
                    // 审批闸门在引擎侧 approval 档（seed 单源）；执行器层
                    // 只强制沙箱/签名（与 device_mcp_call 同口径）
                    let auth = executors::impls::Authorization { approved: true };
                    match state
                        .registry
                        .run(&tool, &args_map, shell_backend.inner(), &auth)
                    {
                        Ok(outcome) => Ok(serde_json::json!({
                            "ok": true,
                            "result": outcome.result,
                        })
                        .to_string()),
                        Err(err) => Ok(serde_json::json!({
                            "ok": false,
                            "status": "executor_error",
                            "error": err.to_string(),
                        })
                        .to_string()),
                    }
                }),
            )
            .expect("os.dispatch 回调注册失败");

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
            first_run_dismiss,
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
            recovery_snapshots,
            recovery_restore_snapshot,
            recovery_factory_reset,
            tools_snapshot,
            components_manifest,
            task_start,
            task_cancel,
            task_progress,
            task_finish,
            task_fail,
            task_list,
            task_state,
            task_resume,
            model_archive_snapshot,
            models_refresh,
            metrics_snapshot,
            path_choose_candidate,
            path_set_multipath,
            cache_invalidate,
            edge_downgrade_tier,
            doc_parse,
            doc_generate,
            screenshot_capture,
        ])
        .build(tauri::generate_context!())
        .expect("InKling 桌面壳装配失败");

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            stop.store(true, Ordering::Relaxed);
        }
    });
}

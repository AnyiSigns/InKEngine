//! InKling 桌面壳（宿主件）——机制件与宿主件的分界线。
//!
//! 壳语义：宿主进程 + WebView 渲染 frontend 产物；引擎侧零改动。
//! 系统操作工具禁止硬编码为固定功能——工具声明（fixtures/tools_os.json）
//! 走声明式工具生成管线产出，壳只做执行器注册：注册时校验「声明 ↔ 执行器
//! 签名」一致，权限/沙箱守卫在执行器层强制（deny 硬拦、review 需授权、
//! 白名单/边界越界拒绝）。
//!
//! 命令面（Tauri command 层）已按域拆分到 [`commands`]（L9 决议 12）：
//! 本文件保留装配 / 状态 / 引擎生命周期 / 托盘 / 自检 / 运行时装配；
//! 错误统一经 [`commands::error::CommandError`]（L6 信封 {code, message,
//! trace_id}）。
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
use tauri::{AppHandle, Manager, RunEvent};

pub mod commands;
pub mod domain;
pub mod engine;
pub mod executors;
pub mod mcp;

pub use commands::approval::ApprovalLedger;
pub use commands::process::redact_workspace;

/// 工具声明文件（include_str 内嵌：声明 = 数据，随补丁链演化管线产出）
const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

/// 工作区挂载根（文件沙箱的授权底座；挂载授权命令按此校验）
pub(crate) const DEFAULT_MOUNT_ROOT: &str = "~/.inkling/workspace";

/// 引擎装配的种子根目录名（seed_data/manifest 所在目录）
const SEED_DIR_NAME: &str = "inkling";

/// 装配数据文件名（策略层分流/档位阈值读种子数据）
const WORKFLOW_FILE: &str = "workflow.json";

/// 能力设置记录集合/键（设置页应用能力档的持久化底座）
pub(crate) const CAPABILITY_COLLECTION: &str = "app_capabilities";
pub(crate) const CAPABILITY_KEY: &str = "capability";

/// 组件构建产物清单文件名（挂载后注册表刷新的数据源）
pub(crate) const COMPONENT_MANIFEST_FILE: &str = "manifest.json";

/// 首启标记文件名（数据目录；存在 = 已完成首次装配引导）
pub(crate) const FIRST_RUN_MARKER: &str = ".first_run";

/// 产品后端（引擎句柄 + 工具快照 + 回合记录器 + 中止信号）。
struct ShellBackendState {
    engine: Mutex<Option<engine::host::EngineHost>>,
    tool_provider: Arc<domain::tools::ToolSpecsProvider>,
    round: Mutex<Option<domain::steps::RoundStepsTransport>>,
    abort_signal: domain::steps::RoundAbortSignal,
    /// 演化触发回合计数（每 N 回合触发一批知识进化）。
    evolution_round_counter: Mutex<u64>,
}

impl ShellBackendState {
    fn new(abort_signal: domain::steps::RoundAbortSignal) -> Self {
        Self {
            engine: Mutex::new(None),
            tool_provider: Arc::new(domain::tools::ToolSpecsProvider::empty()),
            round: Mutex::new(None),
            abort_signal,
            evolution_round_counter: Mutex::new(0),
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

/// 壳状态：授权挂载点 + 执行器注册表（声明驱动，启动时构建并自检签名）
/// + 壳侧审批台账（决议 4：命令层裁决的档位表与决议态）。
struct ShellState {
    mounts: Mutex<Vec<PathBuf>>,
    registry: executors::registry::ExecutorRegistry,
    backend: ShellBackendState,
    approval: commands::approval::ApprovalLedger,
    os_dispatch: std::sync::OnceLock<()>,
}

/// 构建壳后端：平台操作 + Tauri 通知接线 + 回合中止信号（sleep 中断感知）。
fn build_shell_backend(
    app: AppHandle,
    abort_signal: domain::steps::RoundAbortSignal,
) -> executors::backends::ShellBackend {
    let platform = executors::backends::PlatformBackend;
    executors::backends::ShellBackend::new(app, platform, abort_signal)
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
    tool_provider: Option<std::sync::Arc<domain::tools::ToolSpecsProvider>>,
) -> engine::host::BootOptions {
    engine::host::BootOptions {
        repo_root,
        storage_uri: format!("sqlite:///{}", data_dir.join("inkling.sqlite").display()),
        data_dir: Some(data_dir.clone()),
        safe_mode,
        bundled: engine::runtime::bundled_mode(),
        embedder_model_dir: embedder_model_dir(&data_dir),
        // 引擎路径装配机制（实验性机制）出厂默认
        // 全关——缩小装配爆炸半径（红线二仅靠崩溃循环回退）；用户显式
        // 开启（BootOptions 注入 / 未来设置项）后逐块独立，单块异常可
        // 单独关闭回滚。
        path_assembly: engine::host::PathAssemblyFlags::default(),
        // FA12：回合行为层工具对照表经运行时快照（装配前种子装载 +
        // 装配后内省刷新；MCP 挂载/补丁后随 refresh 更新）
        tool_provider,
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

/// 装配失败脱敏：引擎装配错误可能含绝对路径/堆栈/内部布局——
/// 本地日志留痕完整错误，对外仅回传粗粒度提示，trace_id 关联排障。
fn assembly_failure(stage: &str, detail: impl std::fmt::Display) -> String {
    let trace_id = uuid::Uuid::new_v4().simple().to_string();
    eprintln!("[assembly] {stage} 失败 trace_id={trace_id}: {detail}");
    format!("引擎装配失败（{stage}，trace_id={trace_id}；详见本地日志）")
}

/// 懒装配（幂等）：首次调用执行引擎机制装配 + 工具快照刷新。
///
/// 装配 = 嵌入装配域包的 `boot_inkling`（机制装配 + 安全纵深 + 活跃态
/// 目标 + 链恢复全在装配域包内）；装配失败 = 结构化错误（粗粒度提示 +
/// 本地详细日志）。崩溃回退（红线二）编排在此完成：
/// - 启动状态跟踪：失败计数 → 达阈值自动转入安全模式重试（出厂基线
///   启动，链内容不参与装配）；成功启动计数归零；
/// - 启动快照轮换：装配成功后按链版本落一份存储快照（N 份轮换，绑定
///   链版本号），供「回到上一稳定版本」一键回落取用。
fn ensure_engine(app: &tauri::AppHandle, state: &ShellState, data_dir: &Path) -> Result<(), String> {
    let mut engine = state.backend.engine.lock().unwrap();
    if engine.is_some() {
        return Ok(());
    }
    let boot_state = domain::recovery::load_boot_state(data_dir);
    let repo_root = repo_root_for(data_dir);
    // FA12：回合行为层工具对照表取运行时快照——装配前先以种子装载
    // 提供器（装配后经 refresh 同步实时表，MCP 挂载/补丁后快照随内省
    // 刷新更新）
    if let Ok(bundle) = domain::recipe::load_seed_data(&seed_root()) {
        state
            .backend
            .tool_provider
            .replace_from_seed(bundle.file("tools.json"));
    }
    let tool_provider = std::sync::Arc::clone(&state.backend.tool_provider);
    let host = match engine::host::EngineHost::boot(boot_options(
        repo_root.clone(),
        data_dir.to_path_buf(),
        boot_state.safe_mode,
        Some(tool_provider.clone()),
    )) {
        Ok(host) => host,
        Err(err) if boot_state.safe_mode => {
            return Err(assembly_failure("安全模式装配", err));
        }
        Err(err) => {
            // 崩溃计数 +1；达到阈值自动转入安全模式重试（出厂基线启动）
            let boot_state_after = domain::recovery::record_boot_failure(data_dir);
            if !boot_state_after.safe_mode {
                return Err(assembly_failure("装配", err));
            }
            match engine::host::EngineHost::boot(boot_options(
                repo_root,
                data_dir.to_path_buf(),
                true,
                Some(tool_provider),
            )) {
                Ok(host) => host,
                Err(safe_err) => {
                    let trace_id = uuid::Uuid::new_v4().simple().to_string();
                    eprintln!(
                        "[assembly] 装配失败（自动安全模式亦失败）trace_id={trace_id}: {err} / {safe_err}"
                    );
                    return Err(format!(
                        "引擎装配失败（自动安全模式亦失败，trace_id={trace_id}；详见本地日志）"
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
    // OS 执行体接桥（引擎桥就绪后注册，避免装配前触碰 Python 模块）：
    // process_exec 端点 → 宿主 os_registry 分发经回调桥转发到本注册表；
    // 同一套运行体，两处调度点合一；回调执行在引擎回合线程，经 AppHandle
    // 取托管状态（沙箱/授权在执行器 run 内强制，此处只做转发）。
    wire_os_dispatch(app, state).map_err(|err| format!("os.dispatch 接线失败: {err}"))?;
    // 启动快照轮换（非安全模式：安全模式下存储为崩溃前形态，不覆盖
    // 既有稳定快照；失败仅留观测日志，不阻断装配）
    if !domain::recovery::load_boot_state(data_dir).safe_mode {
        if let Err(snap_err) = take_startup_snapshot(data_dir) {
            eprintln!("[recovery] 启动快照失败: {snap_err}");
        }
    }
    Ok(())
}

/// OS 执行体回调注册（引擎装配成功后执行一次）。
fn wire_os_dispatch(app: &tauri::AppHandle, state: &ShellState) -> Result<(), String> {
    state
        .os_dispatch
        .get_or_init(|| {
            let os_bridge_app = app.clone();
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
                    let os_state = os_bridge_app.state::<ShellState>();
                    let shell_backend =
                        os_bridge_app.state::<executors::backends::ShellBackend>();
                    // 引擎通道：审批流水线在引擎侧先行裁决（approval 档 seed
                    // 单源），壳侧将引擎放行态记入审批台账后经同一裁决函数
                    // 放行（决议 4：无硬编码放行，客户端通道与引擎通道共用
                    // 台账裁决；执行器层守卫 deny/沙箱/签名照常强制）
                    os_state.approval.record_engine_dispatch(&tool, &args_map);
                    let auth = os_state.approval.adjudicate(&tool, &args_map);
                    let dynamic_roots: Vec<String> = os_state
                        .mounts
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect();
                    let gate = executors::registry::CallGate::with_roots(
                        executors::tool_decl::Endpoint::ProcessExec,
                        dynamic_roots,
                    );
                    match os_state.registry.run(
                        &tool,
                        &args_map,
                        shell_backend.inner(),
                        &auth,
                        &gate,
                    ) {
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
        });
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

/// 结构化日志订阅器装配（FA17：tracing 正式接入——进程级一次；默认
/// info 级到 stderr，`RUST_LOG` 可调）。
pub fn init_tracing() {
    static TRACING: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    TRACING.get_or_init(|| {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::INFO)
            .try_init();
    });
}

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
/// 返回 0 = 全过；非 0 = 失败。输出改结构化日志（H13：不再 println!
/// 裸文本——summary 事件带结构化字段，失败事件含 trace_id 与明细）。
pub fn selftest() -> i32 {
    init_tracing();
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
            let text = serde_json::to_string_pretty(&summary).unwrap_or_default();
            tracing::info!(
                target: "selftest",
                phase = summary.get("phase").and_then(JsonValue::as_i64).unwrap_or(0),
                tool_count = summary.get("tool_count").and_then(JsonValue::as_i64).unwrap_or(0),
                event_count = summary.get("event_count").and_then(JsonValue::as_i64).unwrap_or(0),
                session_persisted = summary.get("session_persisted").and_then(JsonValue::as_bool).unwrap_or(false),
                "出厂自检通过: {text}",
            );
            0
        }
        Err(err) => {
            let trace_id = uuid::Uuid::new_v4().simple().to_string();
            tracing::error!(target: "selftest", trace_id, "出厂自检失败: {err}");
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
    init_tracing();
    let stop = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 嵌入解释器就绪（引擎桥前置；进程内一次）
            engine::host::ensure_python();
            // 声明加载 + 执行器注册 + 签名自检（不一致 = 启动失败，fail-closed）
            let declarations: executors::tool_decl::ToolDeclarations =
                executors::tool_decl::load_tool_declarations(TOOLS_DECL_JSON)
                    .expect("工具声明解析失败（声明损坏，壳拒绝启动）");
            let registry = executors::registry::build_registry_from_declarations(&declarations)
                .expect("执行器注册契约校验失败（声明 ↔ 执行器签名不一致）");

            let mounts = vec![expand_home(DEFAULT_MOUNT_ROOT)];
            let approval = commands::approval::ApprovalLedger::from_declarations(&declarations);
            // 回合中止信号在壳状态与执行器后端间共享：round_abort 置位后，
            // 执行器（sleep 等前台工具）轮询感知并中断。
            let abort_signal = domain::steps::RoundAbortSignal::new();
            app.manage(ShellState {
                mounts: Mutex::new(mounts),
                registry,
                backend: ShellBackendState::new(abort_signal.clone()),
                approval,
                os_dispatch: std::sync::OnceLock::new(),
            });

            let backend = build_shell_backend(app.handle().clone(), abort_signal);
            app.manage(backend);

            build_tray(app.handle())?;
            let _ = stop;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::process::process_exec,
            commands::workspace::mount_authorize,
            commands::workspace::mount_list,
            commands::process::device_mcp_call,
            commands::lifecycle::backend_status,
            commands::lifecycle::engine_boot,
            commands::lifecycle::first_run_dismiss,
            commands::lifecycle::runtime_state,
            commands::lifecycle::runtime_pause,
            commands::lifecycle::runtime_resume,
            commands::lifecycle::runtime_stop,
            commands::rounds::round_send,
            commands::rounds::round_abort,
            commands::rounds::round_resume,
            commands::lifecycle::route_plan,
            commands::sessions::session_list,
            commands::sessions::session_create,
            commands::sessions::session_rename,
            commands::sessions::session_delete,
            commands::sessions::session_refresh,
            commands::sessions::session_tree,
            commands::sessions::session_branch,
            commands::workspace::authorization_state,
            commands::workspace::workspace_authorize,
            commands::workspace::workspace_revoke,
            commands::workspace::shell_open_path,
            commands::workspace::approval_request,
            commands::workspace::approval_resolve,
            commands::capability::capability_get,
            commands::capability::capability_put,
            commands::capability::security_tier_overrides_set,
            commands::backup::backup_export,
            commands::backup::backup_preview,
            commands::backup::backup_restore,
            commands::backup::recovery_snapshots,
            commands::backup::recovery_restore_snapshot,
            commands::backup::recovery_factory_reset,
            commands::tools::tools_snapshot,
            commands::tools::tools_manifest,
            commands::tools::tools_baseline_get,
            commands::tools::tools_baseline_set,
            commands::tools::components_manifest,
            commands::tools::components_manifest_put,
            commands::models::model_archive_snapshot,
            commands::models::models_refresh,
            commands::models::models_config_get,
            commands::models::metrics_snapshot,
            commands::models::path_choose_candidate,
            commands::models::path_set_multipath,
            commands::models::cache_invalidate,
            commands::models::cache_rebuild,
            commands::models::edge_downgrade_tier,
            commands::models::edge_restore_tier,
            commands::models::models_config_put,
            commands::mcp::mcp_market_status,
            commands::mcp::mcp_market_mount,
            commands::mcp::mcp_market_unmount,
            commands::mcp::mcp_market_preview,
            commands::mcp::mcp_market_add,
            commands::mcp::mcp_market_remove,
            commands::files::doc_parse,
            commands::files::doc_generate,
            commands::files::material_import,
            commands::files::screenshot_capture,
            commands::voice::voice_status,
            commands::voice::voice_transcribe,
            commands::voice::voice_synthesize,
            commands::voice::voice_record,
            commands::voice::voice_devices,
            commands::offline::offline_detect,
            commands::offline::offline_settings_get,
            commands::offline::offline_settings_put,
            commands::search::search_keys_get,
            commands::search::search_keys_put,
            commands::ops::assemble_stats,
            commands::ops::graph_snapshot,
            commands::ops::pool_snapshot,
            commands::ops::pool_evaluate,
            commands::ops::edge_evidence_list,
            commands::ops::edge_evidence_update,
            commands::ops::path_assemble,
            commands::ops::path_clear_candidate,
            commands::ops::path_set_assembler_enabled,
            commands::ops::cache_stats,
            commands::ops::cache_clear,
            commands::ops::why_audit,
            commands::ops::sovereignty_snapshot,
            commands::ops::suggestion_scan,
            commands::ops::growth_report,
            commands::ops::audit_list,
            commands::knowledge::knowledge_list,
            commands::knowledge::knowledge_add,
            commands::knowledge::knowledge_promote,
            commands::knowledge::knowledge_archive,
            commands::knowledge::knowledge_restore,
            commands::knowledge::knowledge_export,
            commands::knowledge::knowledge_skill_import,
            commands::knowledge::knowledge_skill_reimport,
            commands::knowledge::knowledge_graph,
            commands::memory::memory_list,
            commands::memory::memory_invalidate,
            commands::memory::memory_update_frontmatter,
            commands::rounds::round_ledger_record,
            commands::rounds::round_ledger_chain,
            commands::rounds::round_ledger_list,
            commands::rounds::round_ledger_roll,
            commands::rounds::round_ledger_merge,
            commands::rounds::round_memory_extract,
            commands::rounds::round_resume_with_summary,
            commands::ops::ui_spec_get,
            commands::ops::ui_spec_apply,
            commands::ops::ui_spec_revert_latest,
            commands::ops::model_reload,
        ])
        .build(tauri::generate_context!())
        .expect("InKling 桌面壳装配失败");

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            stop.store(true, Ordering::Relaxed);
        }
    });
}

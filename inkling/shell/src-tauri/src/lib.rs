//! InKling 桌面壳（宿主件）——机制件与宿主件的分界线。
//!
//! 壳语义：宿主进程 + WebView 渲染 frontend 产物；引擎侧零改动。
//! 系统操作工具禁止硬编码为固定功能——工具声明（fixtures/tools_os.json）
//! 走声明式工具生成管线产出，壳只做执行器注册：注册时校验「声明 ↔ 执行器
//! 签名」一致，权限/沙箱守卫在执行器层强制（deny 硬拦、review 需授权、
//! 白名单/边界越界拒绝）。
//!
//! 装配：托盘 + 系统通知 + 文件挂载授权 + process_exec 命令路由 +
//! 设备感知 server（stdio JSON-RPC，供宿主/引擎侧 mcp_client 挂载）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};

pub mod domain;
pub mod engine;
pub mod executors;
pub mod mcp;

use executors::backends::{PlatformBackend, ShellBackend};
use executors::impls::Authorization;
use executors::registry::{build_registry_from_declarations, ExecutorRegistry};
use executors::tool_decl::{ToolDeclarations, load_tool_declarations};

/// 工具声明文件（include_str 内嵌：声明 = 数据，随补丁链演化管线产出）
const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

/// 工作区挂载根（文件沙箱的授权底座；挂载授权命令按此校验）
const DEFAULT_MOUNT_ROOT: &str = "~/.inkling/workspace";

/// 壳状态：授权挂载点 + 执行器注册表（声明驱动，启动时构建并自检签名）
struct ShellState {
    mounts: Mutex<Vec<PathBuf>>,
    registry: ExecutorRegistry,
}

/// 构建壳后端：平台操作 + Tauri 通知接线。
fn build_shell_backend(app: AppHandle) -> ShellBackend {
    let platform = PlatformBackend;
    ShellBackend::new(app, platform)
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
            device_mcp_call
        ])
        .build(tauri::generate_context!())
        .expect("InKling 桌面壳装配失败");

    app.run(move |_app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            stop.store(true, Ordering::Relaxed);
        }
    });
}

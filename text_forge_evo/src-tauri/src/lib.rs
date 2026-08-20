//! Forge 桌面壳（引导壳）：引擎进程 sidecar + WebView 渲染前端产物。
//!
//! 壳语义：exe = 引导壳，应用形态 = 集数据（~/.textforge/ 不动）。
//! 启动时检测引擎端口（8010），未起则拉起引擎进程（开发模式 = 项目
//! venv python；打包模式 = 安装包内捆绑运行时）；WebView 指向
//! localhost:8010（开发模式）或前端产物（打包模式）。引擎子进程由
//! 看护线程监控：异常退出退避重启（崩溃恢复），退出流程不重启。
//! 系统托盘常驻 + 全局快捷键唤起窗口；退出时回收引擎子进程。

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

/// 引擎端口（与 backend 一致，单一来源）
const ENGINE_PORT: u16 = 8010;

/// 引擎子进程句柄与退出标志（退出流程置位后看护线程不再重启）
struct EngineChild {
    process: Mutex<Option<Child>>,
    stop: Arc<AtomicBool>,
}

fn port_alive(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// 工程根探测：当前 exe（target/debug 或 release）上溯到 text_forge_evo。
fn project_root() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..3 {
        dir = dir.parent()?.to_path_buf();
    }
    Some(dir)
}

/// 安装布局探测：exe 同级 resources/（打包脚本把 Python 运行时与后端产物放进该目录）。
fn bundle_resources() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let resources = exe_dir.join("resources");
    resources.is_dir().then_some(resources)
}

/// 引擎 Python 解释器探测：环境变量优先，其次安装包捆绑运行时，
/// 再工程 venv，最后 PATH。
fn detect_python() -> PathBuf {
    if let Ok(custom) = std::env::var("FORGE_PYTHON") {
        let path = PathBuf::from(custom);
        if path.exists() {
            return path;
        }
    }
    if let Some(resources) = bundle_resources() {
        let bundled_windows = resources.join("python/python.exe");
        if bundled_windows.exists() {
            return bundled_windows;
        }
        let bundled_unix = resources.join("python/bin/python3");
        if bundled_unix.exists() {
            return bundled_unix;
        }
    }
    if let Some(root) = project_root() {
        let venv_windows = root.join(".venv/Scripts/python.exe");
        if venv_windows.exists() {
            return venv_windows;
        }
        let venv_unix = root.join(".venv/bin/python");
        if venv_unix.exists() {
            return venv_unix;
        }
    }
    PathBuf::from("python")
}

/// 引擎后端目录探测：环境变量优先，其次安装包捆绑后端，再工程根，
/// 最后当前目录。
fn detect_backend() -> PathBuf {
    if let Ok(custom) = std::env::var("FORGE_BACKEND") {
        let path = PathBuf::from(custom);
        if path.is_dir() {
            return path;
        }
    }
    if let Some(resources) = bundle_resources() {
        let bundled = resources.join("backend");
        if bundled.is_dir() {
            return bundled;
        }
    }
    if let Some(root) = project_root() {
        let candidate = root.join("backend");
        if candidate.is_dir() {
            return candidate;
        }
    }
    PathBuf::from("backend")
}

/// 拉起引擎进程（端口未活时；启动即持锁，双开由进程锁拒绝）。
fn spawn_engine(app: &AppHandle) {
    if port_alive(ENGINE_PORT) {
        return;
    }
    let python = detect_python();
    let backend = detect_backend();
    match Command::new(&python)
        .args(["-m", "app.main"])
        .current_dir(&backend)
        .spawn()
    {
        Ok(child) => {
            app.state::<EngineChild>().process.lock().unwrap().replace(child);
        }
        Err(err) => {
            eprintln!("引擎进程拉起失败: {err}（python={python:?} backend={backend:?}）");
        }
    }
}

/// 引擎子进程看护：异常退出退避重启（崩溃后产品不失联）；退出流程
/// （stop 置位）下只回收不重启。端口活 = 引擎可用（可能有外部实例）。
fn spawn_watchdog(app: &AppHandle) {
    let handle = app.clone();
    let stop = app.state::<EngineChild>().stop.clone();
    std::thread::spawn(move || {
        let mut backoff_secs: u64 = 1;
        loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let child_state = handle.state::<EngineChild>();
            let mut process = child_state.process.lock().unwrap();
            let exited = match process.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_)) => true,
                    Ok(None) => false,
                    Err(_) => true,
                },
                None => break,
            };
            if !exited {
                drop(process);
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
            drop(process);
            if stop.load(Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(backoff_secs));
            backoff_secs = (backoff_secs * 2).min(16);
            if !port_alive(ENGINE_PORT) {
                spawn_engine(&handle);
            }
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 托盘菜单（打开窗口 / 退出——退出即回收引擎进程）。
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开 Forge", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("icon".into()))?;
    TrayIconBuilder::with_id("forge-tray")
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

/// 全局快捷键：唤起窗口（macOS Command+K，Windows/Linux Ctrl+K）。
fn register_hotkey(app: &AppHandle) -> tauri::Result<()> {
    let modifier = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    let shortcut = Shortcut::new(Some(modifier), Code::KeyK);
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                show_main_window(app);
            }
        })
        .map_err(|err| {
            std::io::Error::new(std::io::ErrorKind::Other, err.to_string())
        })?;
    Ok(())
}

pub fn run() {
    let app_stop = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(EngineChild {
            process: Mutex::new(None),
            stop: app_stop.clone(),
        })
        .setup(move |app| {
            spawn_engine(app.handle());
            spawn_watchdog(app.handle());
            build_tray(app.handle())?;
            register_hotkey(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Forge 桌面壳装配失败");

    app.run(move |app, event| {
        // 退出回收引擎子进程：置位停止标志（看护不再重启）后 kill
        if let RunEvent::ExitRequested { .. } = event {
            app.state::<EngineChild>()
                .stop
                .store(true, Ordering::Relaxed);
            if let Some(mut child) = app.state::<EngineChild>().process.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}

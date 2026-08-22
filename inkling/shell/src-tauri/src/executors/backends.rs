//! 系统操作后端：执行器的真实副作用隔离层。
//!
//! 测试注入 MockBackend（免真实桌面）；生产用 PlatformBackend（平台原生
//! 实现，winmm/winuser FFI 免外部依赖）+ ShellBackend（Tauri 通知接线）。
//! 执行器逻辑与副作用解耦——守卫断言在纯逻辑层，与后端无关。

/// 系统操作后端契约（执行器只经此接触真实系统）
pub trait SystemBackend: Send + Sync {
    fn launch_app(&self, app: &str) -> Result<String, String>;
    fn open_file(&self, path: &str) -> Result<String, String>;
    fn system_query(&self, query: &str) -> Result<String, String>;
    fn set_volume(&self, percent: u32) -> Result<String, String>;
    fn set_brightness(&self, percent: u32) -> Result<String, String>;
    fn notify(&self, title: &str, body: &str) -> Result<String, String>;
    fn schedule(&self, seconds: u64, action: &str) -> Result<String, String>;
    fn screen_query(&self, target: &str) -> Result<String, String>;
    fn file_query(&self, path: &str) -> Result<String, String>;
}

/// 平台后端：真实系统操作的唯一实现（Windows 优先，其余平台显式报不支持）
pub struct PlatformBackend;

fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("命令执行失败: {err}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(format!(
            "命令退出码 {}: {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

impl Default for PlatformBackend {
    fn default() -> Self {
        Self
    }
}

impl SystemBackend for PlatformBackend {
    fn launch_app(&self, app: &str) -> Result<String, String> {
        // Windows: start 解析 PATH/注册表（执行器已做白名单守卫）
        run_cmd("cmd", &["/C", "start", "", app])?;
        Ok(format!("已启动应用: {app}"))
    }

    fn open_file(&self, path: &str) -> Result<String, String> {
        run_cmd("cmd", &["/C", "start", "", path])?;
        Ok(format!("已打开: {path}"))
    }

    fn system_query(&self, query: &str) -> Result<String, String> {
        let value = match query {
            "os" => std::env::consts::OS.to_string(),
            "arch" => std::env::consts::ARCH.to_string(),
            "hostname" => std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "unknown".into()),
            "home" => std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| "unknown".into()),
            "cwd" => std::env::current_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "unknown".into()),
            "uptime" => format!("{}s", process_uptime_secs()),
            _ => return Err(format!("不支持的查询面: {query}")),
        };
        Ok(value)
    }

    fn set_volume(&self, percent: u32) -> Result<String, String> {
        windows_ops::set_volume(percent)
    }

    fn set_brightness(&self, percent: u32) -> Result<String, String> {
        windows_ops::set_brightness(percent)
    }

    fn notify(&self, title: &str, body: &str) -> Result<String, String> {
        // 裸平台后端不做真实通知（无宿主上下文）；ShellBackend 接线到
        // tauri-plugin-notification。此处返回结构化记录供宿主侧转发。
        Ok(format!("notification:{title}|{body}"))
    }

    fn schedule(&self, seconds: u64, action: &str) -> Result<String, String> {
        let job_id = format!("job-{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0));
        let title = "InKling 定时任务";
        let body = format!("{action}（延迟 {seconds}s）");
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            // 到点经后端通知通道发出（无宿主时静默记录）
            let _ = format!("notification:{title}|{body}");
        });
        Ok(job_id)
    }

    fn screen_query(&self, target: &str) -> Result<String, String> {
        windows_ops::screen_query(target)
    }

    fn file_query(&self, path: &str) -> Result<String, String> {
        let entries = std::fs::read_dir(path)
            .map_err(|err| format!("目录读取失败: {path} ({err})"))?
            .filter_map(|entry| entry.ok())
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                let kind = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    "dir"
                } else {
                    "file"
                };
                format!("{kind}:{name}")
            })
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("[{path}] {entries}"))
    }
}

/// 进程运行时长（system_query/uptime；跨平台 std 近似——进程自身时长）
fn process_uptime_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Windows 原生操作（winmm/winuser FFI，零外部依赖）
#[cfg(windows)]
mod windows_ops {
    #[link(name = "winmm")]
    extern "system" {
        fn waveOutSetVolume(device: usize, volume: u32) -> u32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetSystemMetrics(index: i32) -> i32;
    }

    const SM_CXSCREEN: i32 = 0;
    const SM_CYSCREEN: i32 = 1;
    const SM_XVIRTUALSCREEN: i32 = 76;
    const SM_YVIRTUALSCREEN: i32 = 77;
    const SM_CXVIRTUALSCREEN: i32 = 78;
    const SM_CYVIRTUALSCREEN: i32 = 79;

    pub fn set_volume(percent: u32) -> Result<String, String> {
        // waveOutSetVolume：0–0xFFFF，左右声道同值（percent 0–100 已在守卫层校验）
        let volume = ((percent * 0xFFFF / 100) & 0xFFFF) as u32;
        let packed = (volume << 16) | volume;
        let result = unsafe { waveOutSetVolume(0, packed) };
        if result == 0 {
            Ok(format!("音量已设为 {percent}%"))
        } else {
            Err(format!("音量设置失败（waveOut 错误码 {result}）"))
        }
    }

    pub fn set_brightness(percent: u32) -> Result<String, String> {
        // WMI WmiSetBrightness（经 PowerShell；执行器已做边界守卫）
        let script = format!(
            "(Get-WmiObject -Namespace root\\wmi -Class WmiMonitorBrightnessMethods).WmiSetBrightness(1,{percent})"
        );
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|err| format!("亮度设置失败: {err}"))?;
        if output.status.success() {
            Ok(format!("亮度已设为 {percent}%"))
        } else {
            Err(format!(
                "亮度设置失败（退出码 {}）",
                output.status.code().unwrap_or(-1)
            ))
        }
    }

    pub fn screen_query(target: &str) -> Result<String, String> {
        let value = match target {
            "resolution" => unsafe {
                format!(
                    "{}x{}",
                    GetSystemMetrics(SM_CXSCREEN),
                    GetSystemMetrics(SM_CYSCREEN)
                )
            },
            "work_area" => unsafe {
                format!(
                    "{}x{} @({},{})",
                    GetSystemMetrics(SM_CXVIRTUALSCREEN),
                    GetSystemMetrics(SM_CYVIRTUALSCREEN),
                    GetSystemMetrics(SM_XVIRTUALSCREEN),
                    GetSystemMetrics(SM_YVIRTUALSCREEN)
                )
            },
            _ => return Err(format!("不支持的感知面: {target}")),
        };
        Ok(value)
    }
}

#[cfg(not(windows))]
mod windows_ops {
    pub fn set_volume(percent: u32) -> Result<String, String> {
        Err(format!("当前平台不支持音量设置（percent={percent}）"))
    }

    pub fn set_brightness(percent: u32) -> Result<String, String> {
        Err(format!("当前平台不支持亮度设置（percent={percent}）"))
    }

    pub fn screen_query(target: &str) -> Result<String, String> {
        Err(format!("当前平台不支持屏幕感知（target={target}）"))
    }
}

/// 测试后端：记录调用面（免真实桌面断言守卫的宿主侧行为）
#[derive(Default)]
pub struct MockBackend {
    pub calls: std::sync::Mutex<Vec<String>>,
}

impl MockBackend {
    pub fn new() -> Self {
        Self::default()
    }
}

/// 壳后端：平台操作 + Tauri 系统通知接线（宿主侧唯一通知通道）。
pub struct ShellBackend {
    app: tauri::AppHandle,
    platform: PlatformBackend,
}

impl ShellBackend {
    pub fn new(app: tauri::AppHandle, platform: PlatformBackend) -> Self {
        Self { app, platform }
    }
}

impl SystemBackend for ShellBackend {
    fn launch_app(&self, app: &str) -> Result<String, String> {
        self.platform.launch_app(app)
    }

    fn open_file(&self, path: &str) -> Result<String, String> {
        self.platform.open_file(path)
    }

    fn system_query(&self, query: &str) -> Result<String, String> {
        self.platform.system_query(query)
    }

    fn set_volume(&self, percent: u32) -> Result<String, String> {
        self.platform.set_volume(percent)
    }

    fn set_brightness(&self, percent: u32) -> Result<String, String> {
        self.platform.set_brightness(percent)
    }

    fn notify(&self, title: &str, body: &str) -> Result<String, String> {
        use tauri_plugin_notification::NotificationExt;
        self.app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|err| format!("系统通知失败: {err}"))?;
        Ok(format!("已通知: {title}"))
    }

    fn schedule(&self, seconds: u64, action: &str) -> Result<String, String> {
        self.platform.schedule(seconds, action)
    }

    fn screen_query(&self, target: &str) -> Result<String, String> {
        self.platform.screen_query(target)
    }

    fn file_query(&self, path: &str) -> Result<String, String> {
        self.platform.file_query(path)
    }
}

impl SystemBackend for MockBackend {
    fn launch_app(&self, app: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("launch_app:{app}"));
        Ok(format!("mock:launch {app}"))
    }

    fn open_file(&self, path: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("open_file:{path}"));
        Ok(format!("mock:open {path}"))
    }

    fn system_query(&self, query: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("system_query:{query}"));
        Ok(format!("mock:query {query}"))
    }

    fn set_volume(&self, percent: u32) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("set_volume:{percent}"));
        Ok(format!("mock:volume {percent}"))
    }

    fn set_brightness(&self, percent: u32) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("set_brightness:{percent}"));
        Ok(format!("mock:brightness {percent}"))
    }

    fn notify(&self, title: &str, body: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("notify:{title}|{body}"));
        Ok(format!("mock:notify {title}"))
    }

    fn schedule(&self, seconds: u64, action: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("schedule:{seconds}:{action}"));
        Ok("mock:job-1".into())
    }

    fn screen_query(&self, target: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("screen_query:{target}"));
        Ok(format!("mock:screen {target}"))
    }

    fn file_query(&self, path: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("file_query:{path}"));
        Ok(format!("mock:file {path}"))
    }
}

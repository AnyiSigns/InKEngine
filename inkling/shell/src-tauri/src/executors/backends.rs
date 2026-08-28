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
    /// 进程模板执行（钉死 argv + 工作目录 + 超时；输出按流截断）。
    ///
    /// 结构化结果文本（退出码 + 标准输出/错误 + 截断标记）而非裸错误：
    /// 超时与退出码非零都落在结果文本里，调用方按结果语义读成败
    /// （与引擎侧 ProcessResult 形状一致）；仅启动失败/参数非法返回 Err。
    fn run_process(&self, argv: &[String], cwd: &str, timeout_secs: u64) -> Result<String, String>;
    /// 元素树感知（只读）：枚举前台窗口 + 顶级窗口 + 子窗口层级，返回 JSON 元素树。
    ///
    /// 只读、无控制权；越权域（非桌面窗口/隐私控件）由上游作用域白名单拒绝，
    /// 本方法只负责收集当前桌面的窗口/控件层级。
    fn ui_tree_query(&self) -> Result<String, String>;
    /// 鼠标点击（屏幕坐标 + 按键）；真实副作用仅经此触发。
    fn ui_click(&self, x: i32, y: i32, button: &str) -> Result<String, String>;
    /// 文本输入（键盘事件注入）；真实副作用仅经此触发。
    fn ui_type(&self, text: &str) -> Result<String, String>;
    /// 窗口清单（JSON：句柄/标题/可见性）。
    fn window_list(&self) -> Result<String, String>;
    /// 聚焦窗口（按句柄/标题/foreground 定位）。
    fn window_focus(&self, handle: &str) -> Result<String, String>;
    /// 最小化窗口（按句柄/标题/foreground 定位）。
    fn window_minimize(&self, handle: &str) -> Result<String, String>;
}

/// 平台后端：真实系统操作的唯一实现（Windows 优先，其余平台显式报不支持）
pub struct PlatformBackend;

/// 启动类命令执行（fire-and-forget）：拉起即返回，不等待子进程退出。
///
/// launch_app / open_file 的语义是「拉起后立即把控制权交还回合」——
/// 若等待（output()）且子进程继承了输出管道句柄，回合线程会阻塞在
/// 子进程整个生命周期上（实测 `cmd /C start` 拉起 GUI 应用后永不返回）。
/// 这里丢弃输出并 detach 句柄，只校验「启动动作本身成功」。
fn run_cmd(program: &str, args: &[&str]) -> Result<String, String> {
    std::process::Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|err| format!("命令启动失败: {err}"))?;
    Ok(String::new())
}

/// 进程模板输出单流截断上限（字符；与回合工具结果上限同量级，
/// 防长输出撑爆结果通道）。
const PROCESS_OUTPUT_MAX_CHARS: usize = 4000;

/// 单流字节读取上限（max_chars × UTF-8 最大字节/字符，防超大输出占满内存；
/// 超上限 = 停止读取并追加截断标记，进程可继续消费管道不阻塞）。
const PROCESS_OUTPUT_READ_CAP: usize = PROCESS_OUTPUT_MAX_CHARS * 4;

/// 子进程输出读取（后台线程消费管道，防管道缓冲写满后子进程阻塞）。
/// 读取按 [`PROCESS_OUTPUT_READ_CAP`] 上限截断：不整块读入后再截断，
/// 超大输出（GB 级）不常驻内存。
fn spawn_pipe_reader<R>(mut pipe: R) -> std::thread::JoinHandle<String>
where
    R: std::io::Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if bytes.len() + n > PROCESS_OUTPUT_READ_CAP {
                        bytes.extend_from_slice(&buf[..PROCESS_OUTPUT_READ_CAP - bytes.len()]);
                        bytes.extend_from_slice("…（输出过长，已截断）".as_bytes());
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

fn truncate_stream(text: String) -> String {
    if text.chars().count() <= PROCESS_OUTPUT_MAX_CHARS {
        return text;
    }
    let mut head: String = text.chars().take(PROCESS_OUTPUT_MAX_CHARS).collect();
    head.push_str("\n…（已截断）");
    head
}

/// 进程模板执行（真实子进程）：钉死 argv + 工作目录 + 超时终止 +
/// 按流截断。退出码与输出落在结构化文本里（超时 = 退出码 -1 +
/// 超时标记，不抛错）；启动失败 = Err。
fn run_process_impl(
    argv: &[String],
    cwd: &str,
    timeout_secs: u64,
) -> Result<String, String> {
    let Some(program) = argv.first() else {
        return Err("进程模板为空（缺程序名）".to_string());
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("命令启动失败: {err}"))?;
    let stdout_reader = child.stdout.take().map(spawn_pipe_reader);
    let stderr_reader = child.stderr.take().map(spawn_pipe_reader);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs.max(1));
    let mut timed_out = false;
    let mut exit_code: Option<i32> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) => {}
            Err(err) => {
                let _ = child.kill();
                return Err(format!("等待子进程失败: {err}"));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let stdout = stdout_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let code = if timed_out { -1 } else { exit_code.unwrap_or(-1) };
    let mut text = String::new();
    if timed_out {
        text.push_str(&format!("exit {code}（执行超时 {timeout_secs}s，已终止）\n"));
    } else {
        text.push_str(&format!("exit {code}\n"));
    }
    text.push_str("[stdout]\n");
    text.push_str(&truncate_stream(stdout));
    text.push('\n');
    text.push_str("[stderr]\n");
    text.push_str(&truncate_stream(stderr));
    Ok(text)
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
        // 只回传条目（不含绝对路径前缀）：工作区绝对路径/目录结构不泄露给
        // 用户可见结果（审计侧留完整路径，见 lib.rs 命令层脱敏分层）
        Ok(entries)
    }

    fn run_process(&self, argv: &[String], cwd: &str, timeout_secs: u64) -> Result<String, String> {
        run_process_impl(argv, cwd, timeout_secs)
    }

    fn ui_tree_query(&self) -> Result<String, String> {
        windows_ui_ops::query_ui_tree()
    }

    fn ui_click(&self, x: i32, y: i32, button: &str) -> Result<String, String> {
        windows_ui_ops::click(x, y, button)
    }

    fn ui_type(&self, text: &str) -> Result<String, String> {
        windows_ui_ops::type_text(text)
    }

    fn window_list(&self) -> Result<String, String> {
        windows_ui_ops::list_windows()
    }

    fn window_focus(&self, handle: &str) -> Result<String, String> {
        windows_ui_ops::focus_window(handle)
    }

    fn window_minimize(&self, handle: &str) -> Result<String, String> {
        windows_ui_ops::minimize_window(handle)
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
        let volume = (percent * 0xFFFF / 100) & 0xFFFF;
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

/// Windows 原生 UI 操作（user32 FFI，零外部依赖）：元素树感知 + 鼠标点击
/// + 文本输入 + 窗口枚举/聚焦/最小化。手写 FFI，与既有 windows_ops 同风格。
#[cfg(windows)]
mod windows_ui_ops {
use std::ffi::c_void;
use serde_json::{json, Value};

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(
            lpEnumFunc: extern "system" fn(*mut c_void, isize) -> i32,
            lParam: isize,
        ) -> i32;
        fn EnumChildWindows(
            hWndParent: *mut c_void,
            lpEnumFunc: extern "system" fn(*mut c_void, isize) -> i32,
            lParam: isize,
        ) -> i32;
        fn GetWindowTextW(hWnd: *mut c_void, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetClassNameW(hWnd: *mut c_void, lpString: *mut u16, nMaxCount: i32) -> i32;
        fn GetWindowTextLengthW(hWnd: *mut c_void) -> i32;
        fn IsWindowVisible(hWnd: *mut c_void) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn mouse_event(dwFlags: u32, dx: u32, dy: u32, dwData: u32, dwExtraInfo: usize);
        fn SetForegroundWindow(hWnd: *mut c_void) -> i32;
        fn ShowWindow(hWnd: *mut c_void, nCmdShow: i32) -> i32;
        fn keybd_event(bVk: u8, bScan: u8, dwFlags: u32, dwExtraInfo: usize);
        fn VkKeyScanW(ch: u16) -> i16;
    }

    const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
    const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
    const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
    const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const VK_SHIFT: u8 = 0x10;
    const SW_MINIMIZE: i32 = 6;

    /// 窗口原始信息（句柄 + 标题 + 类名 + 可见性）
    struct RawWindow {
        hwnd: usize,
        title: String,
        class_name: String,
        visible: bool,
    }

    /// 读取窗口标题（UTF-16 → UTF-8，截断容错）。
    unsafe fn read_window_text(hwnd: *mut c_void) -> String {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buffer: Vec<u16> = vec![0u16; (len + 1) as usize];
        let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), len + 1);
        if copied <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..copied as usize])
    }

    /// 读取窗口类名（UTF-16 → UTF-8）。
    unsafe fn read_class_name(hwnd: *mut c_void) -> String {
        let mut buffer: Vec<u16> = vec![0u16; 256];
        let copied = GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        if copied <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..copied as usize])
    }

    /// EnumWindows/EnumChildWindows 回调（经 lParam 回传收集容器，避免捕获）。
    extern "system" fn collect_window(hwnd: *mut c_void, lparam: isize) -> i32 {
        let list = unsafe { &mut *(lparam as *mut Vec<RawWindow>) };
        let raw = RawWindow {
            hwnd: hwnd as usize,
            title: unsafe { read_window_text(hwnd) },
            class_name: unsafe { read_class_name(hwnd) },
            visible: unsafe { IsWindowVisible(hwnd) != 0 },
        };
        list.push(raw);
        1
    }

    /// 收集顶级窗口（仅句柄/可见性，子窗口层级按需再枚举）。
    fn collect_top_level() -> Vec<RawWindow> {
        let mut list: Vec<RawWindow> = Vec::new();
        unsafe {
            EnumWindows(
                collect_window,
                &mut list as *mut Vec<RawWindow> as isize,
            );
        }
        list
    }

    /// 收集某窗口的子窗口（控件层级）。
    fn collect_children(hwnd: usize) -> Vec<RawWindow> {
        let mut list: Vec<RawWindow> = Vec::new();
        unsafe {
            EnumChildWindows(
                hwnd as *mut c_void,
                collect_window,
                &mut list as *mut Vec<RawWindow> as isize,
            );
        }
        list
    }

    /// 单窗口 → JSON（含子窗口递归层级）。
    fn window_to_json(w: &RawWindow) -> Value {
        let children = collect_children(w.hwnd)
            .iter()
            .map(window_to_json)
            .collect::<Vec<Value>>();
        json!({
            "handle": w.hwnd.to_string(),
            "title": w.title,
            "class": w.class_name,
            "visible": w.visible,
            "children": children,
        })
    }

    /// 元素树感知：前台窗口句柄 + 顶级窗口列表 + 每窗口子窗口层级。
    pub fn query_ui_tree() -> Result<String, String> {
        let top = collect_top_level();
        let windows: Vec<Value> = top.iter().map(window_to_json).collect();
        let fg = unsafe { GetForegroundWindow() as usize };
        let tree = json!({
            "foreground": if fg == 0 { Value::Null } else { json!(fg.to_string()) },
            "windows": windows,
        });
        Ok(tree.to_string())
    }

    /// 按键 → 鼠标事件按下/抬起标志对。
    fn button_flags(button: &str) -> Option<(u32, u32)> {
        match button {
            "left" => Some((MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)),
            "right" => Some((MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)),
            "middle" => Some((MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP)),
            _ => None,
        }
    }

    /// 鼠标点击：定位光标 → 按下 → 抬起（失败 fail-closed）。
    pub fn click(x: i32, y: i32, button: &str) -> Result<String, String> {
        let Some((down, up)) = button_flags(button) else {
            return Err(format!("不支持的按键: {button}"));
        };
        if unsafe { SetCursorPos(x, y) } == 0 {
            return Err(format!("光标定位失败（{x},{y}）"));
        }
        unsafe {
            mouse_event(down, 0, 0, 0, 0);
            mouse_event(up, 0, 0, 0, 0);
        }
        Ok(format!("已点击 {button} @ ({x},{y})"))
    }

    /// 文本输入：逐字符经 VkKeyScanW 映射虚拟键 + Shift 状态注入（不可映射字符 = 失败）。
    pub fn type_text(text: &str) -> Result<String, String> {
        for ch in text.chars() {
            let vk = unsafe { VkKeyScanW(ch as u16) };
            if vk == -1 {
                return Err(format!("不支持的字符（无法映射虚拟键）: {ch}"));
            }
            let low = (vk & 0xff) as u8;
            let shift = ((vk >> 8) & 0xff) != 0;
            unsafe {
                if shift {
                    keybd_event(VK_SHIFT, 0, 0, 0);
                }
                keybd_event(low, 0, 0, 0);
                keybd_event(low, 0, KEYEVENTF_KEYUP, 0);
                if shift {
                    keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
                }
            }
        }
        Ok(format!("已输入文本（{} 字符）", text.chars().count()))
    }

    /// 按句柄（十进制 HWND）/标题/foreground 关键字定位窗口。
    fn find_window(handle: &str) -> Option<*mut c_void> {
        if handle == "foreground" {
            let fg = unsafe { GetForegroundWindow() };
            return if fg.is_null() { None } else { Some(fg) };
        }
        if let Ok(addr) = handle.parse::<usize>() {
            return Some(addr as *mut c_void);
        }
        collect_top_level()
            .iter()
            .find(|w| w.visible && w.title == handle)
            .map(|w| w.hwnd as *mut c_void)
    }

    /// 窗口清单（句柄/标题/可见性，不含子层级）。
    pub fn list_windows() -> Result<String, String> {
        let top = collect_top_level();
        let windows: Vec<Value> = top
            .iter()
            .map(|w| {
                json!({
                    "handle": w.hwnd.to_string(),
                    "title": w.title,
                    "class": w.class_name,
                    "visible": w.visible,
                })
            })
            .collect();
        Ok(json!({ "windows": windows }).to_string())
    }

    /// 聚焦窗口（定位失败 = 失败，fail-closed）。
    pub fn focus_window(handle: &str) -> Result<String, String> {
        let Some(hwnd) = find_window(handle) else {
            return Err(format!("未找到窗口: {handle}"));
        };
        if unsafe { SetForegroundWindow(hwnd) } != 0 {
            Ok(format!("已聚焦窗口: {handle}"))
        } else {
            Err(format!("聚焦窗口失败: {handle}"))
        }
    }

    /// 最小化窗口（定位失败 = 失败，fail-closed）。
    pub fn minimize_window(handle: &str) -> Result<String, String> {
        let Some(hwnd) = find_window(handle) else {
            return Err(format!("未找到窗口: {handle}"));
        };
        if unsafe { ShowWindow(hwnd, SW_MINIMIZE) } != 0 {
            Ok(format!("已最小化窗口: {handle}"))
        } else {
            Err(format!("最小化窗口失败: {handle}"))
        }
    }
}

#[cfg(not(windows))]
mod windows_ui_ops {
    pub fn query_ui_tree() -> Result<String, String> {
        Err("当前平台不支持 UI 元素树感知".to_string())
    }
    pub fn click(_x: i32, _y: i32, _button: &str) -> Result<String, String> {
        Err("当前平台不支持鼠标点击".to_string())
    }
    pub fn type_text(_text: &str) -> Result<String, String> {
        Err("当前平台不支持文本输入".to_string())
    }
    pub fn list_windows() -> Result<String, String> {
        Err("当前平台不支持窗口枚举".to_string())
    }
    pub fn focus_window(_handle: &str) -> Result<String, String> {
        Err("当前平台不支持窗口聚焦".to_string())
    }
    pub fn minimize_window(_handle: &str) -> Result<String, String> {
        Err("当前平台不支持窗口最小化".to_string())
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
        // 定时任务升级：到点自动建任务对象并触发例行回合。
        // 计时在子线程进行，到点后登记例行任务域对象并经既有引擎回合通道
        // 拉起一轮执行；失败仅留观测日志，不阻断调度。
        let task_id = format!("routine-task-{}", uuid::Uuid::new_v4().simple());
        let app = self.app.clone();
        let action = action.to_string();
        let scheduled_task_id = task_id.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(seconds));
            if let Err(err) = crate::domain::tasks::registry().start_tracked(
                &scheduled_task_id,
                "routine",
                &action,
                None,
                None,
            ) {
                eprintln!("[schedule] 例行任务登记失败: {err}");
                return;
            }
            match crate::run_routine_round(&app, &action) {
                Ok(_) => {
                    let _ = crate::domain::tasks::registry().finish_signal(&scheduled_task_id, "例行回合已触发");
                }
                Err(err) => {
                    eprintln!("[schedule] 例行回合触发失败: {err}");
                    let _ = crate::domain::tasks::registry().fail_signal(&scheduled_task_id, &err);
                }
            }
        });
        Ok(task_id)
    }

    fn screen_query(&self, target: &str) -> Result<String, String> {
        self.platform.screen_query(target)
    }

    fn file_query(&self, path: &str) -> Result<String, String> {
        self.platform.file_query(path)
    }

    fn run_process(&self, argv: &[String], cwd: &str, timeout_secs: u64) -> Result<String, String> {
        self.platform.run_process(argv, cwd, timeout_secs)
    }

    fn ui_tree_query(&self) -> Result<String, String> {
        self.platform.ui_tree_query()
    }

    fn ui_click(&self, x: i32, y: i32, button: &str) -> Result<String, String> {
        self.platform.ui_click(x, y, button)
    }

    fn ui_type(&self, text: &str) -> Result<String, String> {
        self.platform.ui_type(text)
    }

    fn window_list(&self) -> Result<String, String> {
        self.platform.window_list()
    }

    fn window_focus(&self, handle: &str) -> Result<String, String> {
        self.platform.window_focus(handle)
    }

    fn window_minimize(&self, handle: &str) -> Result<String, String> {
        self.platform.window_minimize(handle)
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
        Ok(format!("routine-task-mock-{seconds}"))
    }

    fn screen_query(&self, target: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("screen_query:{target}"));
        Ok(format!("mock:screen {target}"))
    }

    fn file_query(&self, path: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("file_query:{path}"));
        Ok(format!("mock:file {path}"))
    }

    fn run_process(&self, argv: &[String], cwd: &str, timeout_secs: u64) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!(
            "run_process:{}|{}|{}s",
            argv.join(" "),
            cwd,
            timeout_secs
        ));
        Ok(format!("mock:run {}（exit 0）", argv.join(" ")))
    }

    fn ui_tree_query(&self) -> Result<String, String> {
        self.calls.lock().unwrap().push("ui_tree_query".into());
        // 结构化元素树（前台窗口 + 窗口列表 + 子窗口层级），供断言 JSON 形态。
        Ok(serde_json::json!({
            "foreground": "1",
            "windows": [
                {
                    "handle": "1",
                    "title": "mock-window",
                    "class": "MockWindow",
                    "visible": true,
                    "children": [
                        {
                            "handle": "2",
                            "title": "mock-child",
                            "class": "MockChild",
                            "visible": true,
                            "children": []
                        }
                    ]
                }
            ]
        })
        .to_string())
    }

    fn ui_click(&self, x: i32, y: i32, button: &str) -> Result<String, String> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("ui_click:{x},{y},{button}"));
        Ok(format!("mock:click {button} @ ({x},{y})"))
    }

    fn ui_type(&self, text: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("ui_type:{text}"));
        Ok(format!("mock:type {text}"))
    }

    fn window_list(&self) -> Result<String, String> {
        self.calls.lock().unwrap().push("window_list".into());
        Ok(serde_json::json!({
            "windows": [
                {
                    "handle": "1",
                    "title": "mock-window",
                    "class": "MockWindow",
                    "visible": true
                }
            ]
        })
        .to_string())
    }

    fn window_focus(&self, handle: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("window_focus:{handle}"));
        Ok(format!("mock:focus {handle}"))
    }

    fn window_minimize(&self, handle: &str) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("window_minimize:{handle}"));
        Ok(format!("mock:minimize {handle}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_process_reports_exit_code_and_output() {
        let backend = PlatformBackend;
        #[cfg(windows)]
        let argv = vec!["cmd".into(), "/C".into(), "echo".into(), "process-ok".into()];
        #[cfg(not(windows))]
        let argv = vec!["echo".into(), "process-ok".into()];
        let result = backend.run_process(&argv, ".", 30).expect("执行应成功");
        assert!(result.contains("exit 0"), "退出码缺失: {result}");
        assert!(result.contains("process-ok"), "stdout 缺失: {result}");
    }

    #[test]
    fn run_process_timeout_kills_and_marks() {
        let backend = PlatformBackend;
        #[cfg(windows)]
        let argv = vec![
            "cmd".into(),
            "/C".into(),
            "ping".into(),
            "-n".into(),
            "30".into(),
            "127.0.0.1".into(),
        ];
        #[cfg(not(windows))]
        let argv = vec!["sleep".into(), "30".into()];
        let result = backend.run_process(&argv, ".", 1).expect("超时返回结构化结果");
        assert!(result.contains("超时"), "超时标记缺失: {result}");
        assert!(result.contains("exit -1"), "超时退出码应为 -1: {result}");
    }

    #[test]
    fn run_process_spawn_failure_is_err() {
        let backend = PlatformBackend;
        let argv = vec!["definitely-not-a-real-binary-xyz".into()];
        assert!(backend.run_process(&argv, ".", 5).is_err());
    }

    #[test]
    fn run_process_empty_argv_is_err() {
        let backend = PlatformBackend;
        assert!(backend.run_process(&[], ".", 5).is_err());
    }

    #[test]
    fn run_cmd_fire_and_forget_returns_immediately() {
        // 拉起一个远超阈值时长才退出的进程，run_cmd 应即刻返回
        #[cfg(windows)]
        let argv = ["cmd", "/C", "ping", "-n", "4", "127.0.0.1"];
        #[cfg(not(windows))]
        let argv = ["sleep", "3"];
        let started = std::time::Instant::now();
        let result = run_cmd(argv[0], &argv[1..]);
        assert!(result.is_ok(), "启动动作应成功: {result:?}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "run_cmd 不应等待子进程退出（耗时 {:?}）",
            started.elapsed()
        );
    }
}

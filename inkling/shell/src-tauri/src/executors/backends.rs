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
    /// 前台休眠（阻塞 seconds 秒；壳后端轮询中止信号，停止会话即打断）。
    fn sleep(&self, seconds: u64) -> Result<String, String>;
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

    fn sleep(&self, seconds: u64) -> Result<String, String> {
        std::thread::sleep(std::time::Duration::from_secs(seconds));
        Ok(format!("已等待 {seconds}s"))
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
        fn IsIconic(hWnd: *mut c_void) -> i32;
        fn GetWindowRect(hWnd: *mut c_void, lpRect: *mut Rect) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn mouse_event(dwFlags: u32, dx: u32, dy: u32, dwData: u32, dwExtraInfo: usize);
        fn SetForegroundWindow(hWnd: *mut c_void) -> i32;
        fn ShowWindow(hWnd: *mut c_void, nCmdShow: i32) -> i32;
        fn SendInput(cInputs: u32, pInputs: *const Input, cbSize: i32) -> u32;
    }

    const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
    const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
    const MOUSEEVENTF_RIGHTDOWN: u32 = 0x0008;
    const MOUSEEVENTF_RIGHTUP: u32 = 0x0010;
    const MOUSEEVENTF_MIDDLEDOWN: u32 = 0x0020;
    const MOUSEEVENTF_MIDDLEUP: u32 = 0x0040;
    const KEYEVENTF_KEYUP: u32 = 0x0002;
    const KEYEVENTF_UNICODE: u32 = 0x0004;
    const INPUT_KEYBOARD: u32 = 1;
    const SW_MINIMIZE: i32 = 6;

    /// 窗口矩形（屏幕坐标，user32 RECT 同布局）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    /// SendInput 的 INPUT 键盘变体（KEYBDINPUT 布局）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KeyboardInput {
        wvk: u16,
        wscan: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    /// SendInput 的 INPUT 鼠标变体（MOUSEINPUT 布局，保证联合尺寸正确）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct MouseInput {
        dx: i32,
        dy: i32,
        mouse_data: u32,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    /// SendInput 的 INPUT 联合体（仅键盘变体被使用）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    union InputData {
        mouse: MouseInput,
        keyboard: KeyboardInput,
    }

    /// SendInput 的 INPUT 结构（type + 联合体）。
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Input {
        kind: u32,
        data: InputData,
    }

    /// 窗口原始信息（句柄 + 标题 + 类名 + 可见性 + 最小化态 + 屏幕矩形）
    struct RawWindow {
        hwnd: usize,
        title: String,
        class_name: String,
        visible: bool,
        minimized: bool,
        rect: Rect,
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
        let mut rect = Rect { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe {
            GetWindowRect(hwnd, &mut rect);
        }
        let raw = RawWindow {
            hwnd: hwnd as usize,
            title: unsafe { read_window_text(hwnd) },
            class_name: unsafe { read_class_name(hwnd) },
            visible: unsafe { IsWindowVisible(hwnd) != 0 },
            minimized: unsafe { IsIconic(hwnd) != 0 },
            rect,
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
            "minimized": w.minimized,
            "rect": {
                "left": w.rect.left,
                "top": w.rect.top,
                "right": w.rect.right,
                "bottom": w.rect.bottom,
            },
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

    /// 文本输入：把文本编码为 KEYEVENTF_UNICODE 键盘事件序列经 SendInput 注入
    /// （按 UTF-16 码元直送，绕开中文输入法转换，内容不受 IME 影响）。
    pub fn type_text(text: &str) -> Result<String, String> {
        let inputs = build_text_inputs(text);
        if inputs.is_empty() {
            return Ok("已输入文本（0 字符）".to_string());
        }
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                std::mem::size_of::<Input>() as i32,
            )
        };
        if sent != inputs.len() as u32 {
            return Err(format!(
                "文本注入失败（{}/{} 事件被接受）",
                sent,
                inputs.len()
            ));
        }
        Ok(format!("已输入文本（{} 字符）", text.chars().count()))
    }

    /// 文本 → UNICODE 键盘事件序列（每个 UTF-16 码元一个键入事件；
    /// 非 BMP 字符按代理对拆两个码元；KEYEVENTF_UNICODE|KEYEVENTF_KEYUP
    /// 组合即键入语义，不映射虚拟键）。
    fn build_text_inputs(text: &str) -> Vec<Input> {
        let mut inputs: Vec<Input> = Vec::new();
        for ch in text.chars() {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                inputs.push(unsafe {
                    Input {
                        kind: INPUT_KEYBOARD,
                        data: InputData {
                            keyboard: KeyboardInput {
                                wvk: 0,
                                wscan: *unit,
                                flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                                time: 0,
                                extra_info: 0,
                            },
                        },
                    }
                });
            }
        }
        inputs
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
                    "minimized": w.minimized,
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn window_json_includes_rect_and_minimized() {
            let w = RawWindow {
                hwnd: 0,
                title: "mock".into(),
                class_name: "Mock".into(),
                visible: true,
                minimized: false,
                rect: Rect { left: 10, top: 20, right: 30, bottom: 40 },
            };
            let json = window_to_json(&w);
            assert_eq!(json["minimized"], false);
            assert_eq!(json["rect"]["left"], 10);
            assert_eq!(json["rect"]["top"], 20);
            assert_eq!(json["rect"]["right"], 30);
            assert_eq!(json["rect"]["bottom"], 40);
        }

        #[test]
        fn window_list_entries_have_minimized_field() {
            let result = list_windows().expect("窗口枚举应成功");
            let json: Value = serde_json::from_str(&result).expect("应为 JSON");
            let windows = json["windows"].as_array().expect("应有 windows 数组");
            if windows.is_empty() {
                return;
            }
            assert!(
                windows[0].get("minimized").is_some(),
                "window_list 每项应有 minimized 字段: {json}"
            );
            assert!(windows[0]["minimized"].is_boolean());
        }

        #[test]
        fn text_inputs_build_unicode_keyboard_events() {
            let inputs = build_text_inputs("a阿😀");
            assert_eq!(inputs.len(), 4, "ASCII1 + BMP1 + 代理对2 = 4 个码元事件");
            for input in &inputs {
                assert_eq!(input.kind, INPUT_KEYBOARD);
                let kb = unsafe { input.data.keyboard };
                assert_eq!(kb.wvk, 0);
                assert_eq!(kb.flags, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            }
            let first = unsafe { inputs[0].data.keyboard };
            assert_eq!(first.wscan, 'a' as u16);
            let third = unsafe { inputs[2].data.keyboard };
            assert_eq!(third.wscan, 0xd83d, "高代理码元");
            let fourth = unsafe { inputs[3].data.keyboard };
            assert_eq!(fourth.wscan, 0xde00, "低代理码元");
        }

        #[test]
        fn text_inputs_empty_is_noop() {
            assert!(build_text_inputs("").is_empty());
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
    abort_signal: crate::domain::steps::RoundAbortSignal,
}

impl ShellBackend {
    pub fn new(
        app: tauri::AppHandle,
        platform: PlatformBackend,
        abort_signal: crate::domain::steps::RoundAbortSignal,
    ) -> Self {
        Self { app, platform, abort_signal }
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

    fn sleep(&self, seconds: u64) -> Result<String, String> {
        // 前台休眠：轮询中止信号，停止会话（round_abort）即中断，不残留后台态。
        let start = std::time::Instant::now();
        let total = std::time::Duration::from_secs(seconds);
        loop {
            if self.abort_signal.is_aborted() {
                return Ok(format!(
                    "等待被用户停止打断（已等待 {}s）",
                    start.elapsed().as_secs()
                ));
            }
            if start.elapsed() >= total {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        Ok(format!("已等待 {seconds}s"))
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

    fn sleep(&self, seconds: u64) -> Result<String, String> {
        self.calls.lock().unwrap().push(format!("sleep:{seconds}"));
        Ok(format!("已等待 {seconds}s"))
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

//! 子进程执行工具：超时结构化 + 输出解码（UTF-8 优先 GBK 降级）。
//!
//! 门禁进程统一经此执行：超时按失败结构化呈现（不裸抛、不悬挂），
//! Windows 上超时按进程树终止（cargo/npm 会拉起子进程，仅杀父进程
//! 会留下 rustc/node 孤儿）；输出解码 UTF-8 优先，失败按 GBK
//! （代码页 936）降级，仍失败按替换符兜底——GBK 控制台输出不乱码。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 子进程执行结果（结构化，失败不吞细节）。
pub struct RunOutcome {
    pub output: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
}

impl RunOutcome {
    pub fn passed(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// 执行命令（cwd 固定仓库根；PATH 可前置附加目录——Windows 下
/// Python 运行时 DLL 目录须在 PATH 内，pyo3 嵌入式解释器才能加载）。
pub fn run_command(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    extra_path: Option<&Path>,
) -> RunOutcome {
    let Some((head, tail)) = argv.split_first() else {
        return RunOutcome {
            output: "（命令为空）".to_string(),
            exit_code: None,
            timed_out: false,
            spawn_error: Some("命令为空".to_string()),
        };
    };
    let executable = resolve_executable(head);
    let mut command = Command::new(executable);
    command.args(tail.iter().map(String::as_str)).current_dir(cwd).stdin(Stdio::null());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = extra_path {
        // 前置目录用字符串拼接（join_paths 会整体加引号——原 PATH 含
        // 分号时被引成单一无效条目，System32 等将无法解析）
        let mut joined = dir.to_string_lossy().into_owned();
        if let Ok(current) = std::env::var("PATH") {
            if !current.is_empty() {
                joined.push(';');
                joined.push_str(&current);
            }
        }
        command.env("PATH", joined);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return RunOutcome {
                output: format!("进程启动失败: {err}"),
                exit_code: None,
                timed_out: false,
                spawn_error: Some(err.to_string()),
            };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_thread = stdout.map(|stream| {
        std::thread::spawn(move || drain(stream))
    });
    let stderr_thread = stderr.map(|stream| {
        std::thread::spawn(move || drain(stream))
    });

    let started = Instant::now();
    let mut timed_out = false;
    let exit_code = loop {
        if started.elapsed() >= timeout {
            timed_out = true;
            kill_tree(&child);
            break child.wait().ok().and_then(|status| status.code());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout_bytes = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr_bytes = stderr_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let mut combined = stdout_bytes;
    combined.extend_from_slice(&stderr_bytes);
    let output = decode_bytes(&combined);
    RunOutcome {
        output,
        exit_code,
        timed_out,
        spawn_error: None,
    }
}

fn drain(mut stream: impl Read) -> Vec<u8> {
    let mut buffer = Vec::new();
    let _ = stream.read_to_end(&mut buffer);
    buffer
}

/// 可执行文件解析：Windows 下按 PATHEXT 扩展名逐一探测 PATH
/// （npm/python 等 .cmd/.exe 形态 CreateProcess 不会自动补扩展名），
/// 其余平台原样返回（交由 shell/execvp 解析）。
fn resolve_executable(name: &str) -> String {
    #[cfg(windows)]
    {
        if name.contains('/') || name.contains('\\') || Path::new(name).extension().is_some() {
            return name.to_string();
        }
        let extensions: Vec<String> = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|ext| ext.to_lowercase())
            .filter(|ext| !ext.is_empty())
            .collect();
        let mut search_dirs: Vec<PathBuf> = std::env::var("PATH")
            .map(|paths| std::env::split_paths(&paths).collect())
            .unwrap_or_default();
        search_dirs.push(PathBuf::from("."));
        for dir in &search_dirs {
            let base = dir.join(name);
            for ext in &extensions {
                let candidate = format!("{}{}", base.to_string_lossy(), ext);
                if Path::new(&candidate).is_file() {
                    return candidate;
                }
            }
        }
        name.to_string()
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

/// 进程树终止：Windows 用 taskkill /T（连带子进程），其余平台 kill 父进程。
fn kill_tree(child: &std::process::Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

/// 字节 → 文本：UTF-8 严格优先，失败按 GBK（代码页 936）降级，
/// 再失败按替换符兜底（不中断报告）。
pub fn decode_bytes(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => decode_gbk(raw).unwrap_or_else(|| String::from_utf8_lossy(raw).into_owned()),
    }
}

/// GBK 解码（Windows 系统库 MultiByteToWideChar，代码页 936）：
/// 尾部截断字节（管道未刷尽的半字符）逐字节回退直到解码成功。
#[cfg(windows)]
fn decode_gbk(raw: &[u8]) -> Option<String> {
    use std::os::raw::{c_int, c_uint};

    extern "system" {
        fn MultiByteToWideChar(
            code_page: c_uint,
            flags: c_uint,
            multi_byte_str: *const u8,
            multi_byte_size: c_int,
            wide_char_str: *mut u16,
            wide_char_size: c_int,
        ) -> c_int;
    }
    const CODE_PAGE_GBK: c_uint = 936;
    const FLAGS_NONE: c_uint = 0;
    let mut trimmed = raw;
    loop {
        let count = unsafe {
            MultiByteToWideChar(
                CODE_PAGE_GBK,
                FLAGS_NONE,
                trimmed.as_ptr(),
                trimmed.len() as c_int,
                std::ptr::null_mut(),
                0,
            )
        };
        if count > 0 {
            let mut buffer = vec![0u16; count as usize];
            let written = unsafe {
                MultiByteToWideChar(
                    CODE_PAGE_GBK,
                    FLAGS_NONE,
                    trimmed.as_ptr(),
                    trimmed.len() as c_int,
                    buffer.as_mut_ptr(),
                    count,
                )
            };
            if written > 0 {
                return String::from_utf16(&buffer[..written as usize]).ok();
            }
        }
        if trimmed.is_empty() {
            return None;
        }
        trimmed = &trimmed[..trimmed.len() - 1];
    }
}

#[cfg(not(windows))]
fn decode_gbk(_raw: &[u8]) -> Option<String> {
    None
}

/// 轮询间隔（毫秒）：进程状态轮询粒度，不影响超时精度。
const POLL_INTERVAL_MS: u64 = 100;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_prefers_utf8_and_falls_back() {
        assert_eq!(decode_bytes("你好".as_bytes()), "你好");
        let gbk_bytes = b"\xc4\xe3\xba\xc3"; // GBK 编码的「你好」
        let decoded = decode_bytes(gbk_bytes);
        #[cfg(windows)]
        assert_eq!(decoded, "你好");
        #[cfg(not(windows))]
        assert!(decoded.contains('\u{fffd}'));
    }

    #[test]
    fn run_command_captures_exit_code() {
        let outcome = run_command(
            &["cmd".to_string(), "/C".to_string(), "exit 3".to_string()],
            Path::new("."),
            Duration::from_secs(10),
            None,
        );
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.timed_out);
        assert!(outcome.spawn_error.is_none());
    }

    #[test]
    fn run_command_reports_timeout() {
        let outcome = run_command(
            &["cmd".to_string(), "/C".to_string(), "ping -n 6 127.0.0.1 >nul".to_string()],
            Path::new("."),
            Duration::from_millis(300),
            None,
        );
        assert!(
            outcome.timed_out,
            "短超时应触发超时终止（exit_code={:?} spawn={:?} output={:?}）",
            outcome.exit_code,
            outcome.spawn_error,
            outcome.output.chars().take(200).collect::<String>()
        );
    }
}

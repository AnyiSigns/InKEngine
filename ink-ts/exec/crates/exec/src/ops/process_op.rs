//! 进程物理执行体（os 端点）：钉死 argv + cwd（挂载根内）+ 超时 kill +
//! 按流截断。退出码与输出落在结构化结果里（超时 = -1 + timed_out，
//! 不抛错）；启动失败 = 结构化 Deny(execution)。语义摘取自壳蓝本
//! backends.rs run_process_impl + common.rs run_command 的物理执行面
//! （不迁声明表/权限判定——本模块只跑已过守门的信封）。

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value as JsonValue, json};

use super::super::envelope::{Deny, Envelope, TIMEOUT_SECS_MAX, TIMEOUT_SECS_MIN};
use super::super::guard::{self, normalize_env};

/// 单流读取上限（max_chars × UTF-8 最大字节/字符，防超大输出占满内存；
/// 超上限 = 停止读取并追加截断标记，进程可继续消费管道不阻塞）。
const PIPE_READ_CAP_MULTIPLIER: usize = 4;

/// 受限子进程最小环境面（env=None 时注入：清空宿主环境后仅保留平台
/// 运行最小变量，宿主环境不外泄给子进程——与壳 common.rs 同口径）。
const RESTRICTED_ENV_WHITELIST: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// 进程执行目标（守门产物；执行对象 = 校验对象）。
pub struct ProcessTarget {
    pub argv: Vec<String>,
    pub cwd: PathBuf,
    pub env: Option<HashMap<String, String>>,
    pub timeout_secs: u64,
    pub max_chars: usize,
}

/// 守门：argv 形状 + 命令白名单 + cwd 根内 + env 面形状 + 超时/截断上界。
fn prepare(envelope: &Envelope) -> Result<ProcessTarget, Deny> {
    let args = envelope
        .args
        .as_object()
        .ok_or_else(|| Deny::new("params", "process 的 args 须为对象"))?;
    let argv_raw = args
        .get("argv")
        .ok_or_else(|| Deny::new("params", "process 缺 argv"))?;
    let argv_items = argv_raw
        .as_array()
        .ok_or_else(|| Deny::new("params", "argv 须为字符串数组"))?;
    if argv_items.is_empty() {
        return Err(Deny::new("params", "argv 不能为空（缺命令名）"));
    }
    let mut argv = Vec::with_capacity(argv_items.len());
    for item in argv_items {
        let text = item
            .as_str()
            .ok_or_else(|| Deny::new("params", "argv 元素须为字符串"))?;
        argv.push(text.to_string());
    }
    if argv.len() > 128 {
        return Err(Deny::new("size", "argv 过长（≤128 项）"));
    }
    let program = argv[0].clone();
    guard::check_allowlist(&envelope.allowlist, &program, &envelope.tool)?;

    let roots = guard::validate_roots(&envelope.roots)?;
    let cwd = match &envelope.cwd {
        Some(target) => guard::resolve_within_roots(&roots, target)?,
        None => roots[0].clone(),
    };
    let env = normalize_env(envelope.env.as_ref())?;
    if !(TIMEOUT_SECS_MIN..=TIMEOUT_SECS_MAX).contains(&envelope.timeout_secs) {
        return Err(Deny::new(
            "timeout",
            format!("timeout_secs 越界: {}", envelope.timeout_secs),
        ));
    }
    Ok(ProcessTarget {
        argv,
        cwd,
        env,
        timeout_secs: envelope.timeout_secs as u64,
        max_chars: envelope.max_chars as usize,
    })
}

/// 物理执行体入口。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let target = prepare(envelope)?;
    let read_cap = target.max_chars * PIPE_READ_CAP_MULTIPLIER;
    let outcome = run_process(
        &target.argv,
        &target.cwd,
        target.env.as_ref(),
        target.timeout_secs,
        target.max_chars,
        read_cap,
    )?;
    Ok(json!({
        "exit_code": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
        "timed_out": outcome.timed_out,
    }))
}

/// 结构化进程结果（退出码 + 截断输出 + 超时标记）。
struct ProcessOutcome {
    exit_code: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// 子进程执行（同步）：后台线程消费管道防阻塞 → 超时 kill → 按流截断。
fn run_process(
    argv: &[String],
    cwd: &PathBuf,
    env: Option<&HashMap<String, String>>,
    timeout_secs: u64,
    max_chars: usize,
    read_cap: usize,
) -> Result<ProcessOutcome, Deny> {
    let Some(program) = argv.first() else {
        return Err(Deny::new("execution", "进程参数为空（缺程序名）"));
    };
    let mut cmd = std::process::Command::new(program);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    match env {
        Some(map) => {
            cmd.env_clear();
            for (key, value) in map {
                cmd.env(key, value);
            }
        }
        None => {
            cmd.env_clear();
            for key in RESTRICTED_ENV_WHITELIST {
                if let Ok(value) = std::env::var(key) {
                    cmd.env(key, value);
                }
            }
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|err| Deny::new("execution", format!("命令启动失败: {err}")))?;
    let stdout_reader = child.stdout.take().map(|pipe| spawn_pipe_reader(pipe, read_cap));
    let stderr_reader = child.stderr.take().map(|pipe| spawn_pipe_reader(pipe, read_cap));
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs.max(1));
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
                return Err(Deny::new("execution", format!("等待子进程失败: {err}")));
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            timed_out = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let stdout = stdout_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let stderr = stderr_reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let code = if timed_out { -1 } else { exit_code.unwrap_or(-1) };
    Ok(ProcessOutcome {
        exit_code: code,
        stdout: truncate_chars(&stdout, max_chars),
        stderr: truncate_chars(&stderr, max_chars),
        timed_out,
    })
}

/// 子进程输出读取（后台线程消费管道，防管道缓冲写满后子进程阻塞）。
fn spawn_pipe_reader<R>(mut pipe: R, read_cap: usize) -> std::thread::JoinHandle<String>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if bytes.len() + n > read_cap {
                        bytes.extend_from_slice(&buf[..read_cap - bytes.len()]);
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

/// 文本截断（字符上限；超限截断并追加截断标记，禁裸截断语义失真）。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut head: String = text.chars().take(max_chars).collect();
    head.push_str("…（已截断）");
    head
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_envelope(argv: Vec<String>, cwd: Option<&str>, allowlist: Vec<String>) -> Envelope {
        let workspace = std::env::temp_dir();
        let args = json!({ "argv": argv });
        Envelope {
            version: 1,
            id: "op-test".into(),
            tool: "process_exec".into(),
            op: "process".into(),
            args,
            endpoint: "os".into(),
            roots: vec![workspace.to_string_lossy().into_owned()],
            allowlist,
            allow_domains: vec![],
            cwd: cwd.map(|s| s.to_string()),
            env: None,
            timeout_secs: 20,
            max_chars: 4096,
            nonce: "n".into(),
            issued_at: 1,
            decision: super::super::super::envelope::Decision {
                approved: true,
                by: "test".into(),
                trace_id: None,
            },
        }
    }

    #[test]
    fn allowlisted_command_executes_with_output() {
        #[cfg(windows)]
        let argv = vec!["cmd".into(), "/C".into(), "echo".into(), "process-ok".into()];
        #[cfg(not(windows))]
        let argv = vec!["echo".into(), "process-ok".into()];
        let env = sample_envelope(argv, None, vec!["cmd".into(), "echo".into()]);
        let value = run(&env).expect("执行应成功");
        assert_eq!(value["exit_code"], 0);
        assert!(value["stdout"].as_str().unwrap().contains("process-ok"));
    }

    #[test]
    fn non_allowlisted_program_is_refused() {
        let env = sample_envelope(
            vec!["evil-tool-xyz".into(), "x".into()],
            None,
            vec!["git".into()],
        );
        let deny = run(&env).expect_err("白名单外命令须拒绝");
        assert_eq!(deny.reason, "allowlist");
        assert!(deny.message.contains("evil-tool-xyz"));
    }

    #[test]
    fn out_of_root_cwd_is_refused() {
        #[cfg(windows)]
        let argv = vec!["cmd".into(), "/C".into(), "echo".into(), "hi".into()];
        #[cfg(not(windows))]
        let argv = vec!["echo".into(), "hi".into()];
        // cwd 指向与 roots 无关的路径 → 越根拒绝（fail-closed）
        let outside = match std::env::temp_dir().parent() {
            Some(parent) => parent.to_string_lossy().into_owned(),
            None => "C:\\".to_string(),
        };
        let env = sample_envelope(argv, Some(&outside), vec!["cmd".into(), "echo".into()]);
        let deny = run(&env).expect_err("根外 cwd 须拒绝");
        assert_eq!(deny.reason, "root");
    }
}

//! 域模块共享基础件：域间公共的类型/常量/错误形态。
//!
//! 各域模块只依赖本模块与引擎公开 API，避免相互直接引用；
//! 装配编排只发生在 [`super::boot`]，其余域之间不发生调用。
//!
//! 收敛纪律（H9/H10/H11/FA16/S12）：跨域重复的小工具与常量（object_map /
//! readable_path / now_epoch / truncate_chars / NUL_PROBE_WINDOW /
//! 沙箱大小上限）一律以本模块为唯一权威，域内禁止平行副本。

use serde_json::Value as JsonValue;

/// 域层统一错误（消息形态产品可读；域内各模块按其细分错误包装）。
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("数据缺失或格式非法: {0}")]
    InvalidData(String),
    #[error("存储/持久化操作失败: {0}")]
    Storage(String),
    #[error("引擎调用失败: {0}")]
    Engine(String),
    #[error("外部进程/网络失败: {0}")]
    External(String),
    #[error("{0}")]
    Other(String),
}

impl DomainError {
    /// 构造一般性错误（消息直接透传）。
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}

/// seed_data 21 数据文件清单（与 schema 校验脚本同源；manifest.json 例外：
/// 位于产品根而非 seed_data 目录，单独读取）。消费方：path_prompts.json
/// 由桥层组装草稿策略模板消费，path_seeds.json 由 boot 边证据导入消费，
/// skills_market.json/components_market.json 由技能/组件市场服务消费。
pub const SEED_DATA_FILES: [&str; 21] = [
    "boot_prompt.json",
    "build.json",
    "components_market.json",
    "env.json",
    "event_types.json",
    "graph.json",
    "knowledge.json",
    "mcp_market.json",
    "memory.json",
    "path_prompts.json",
    "path_seeds.json",
    "review.json",
    "rules.json",
    "samples.json",
    "signals.json",
    "skills_market.json",
    "templates.json",
    "tiers.json",
    "tools.json",
    "ui_spec.json",
    "workflow.json",
];

/// 工作区授权占位符（tools.json 文件工具的 root 值；授权时替换为真实路径）。
pub const WORKSPACE_ROOT_PLACEHOLDER: &str = "${workspace_root}";

/// 出厂工具族分组（工具行/管理台分组展示的元数据键）。
pub const TOOL_GROUP_OS: &str = "os";
pub const TOOL_GROUP_FILE: &str = "file";
pub const TOOL_GROUP_NETWORK: &str = "network";
pub const TOOL_GROUP_RESEARCH: &str = "research";
pub const TOOL_GROUP_MCP: &str = "mcp";
pub const TOOL_GROUP_GENERIC: &str = "generic";

// ── 安全面共享常量（S12：权限/沙箱裁决的 Rust 侧权威源）──

/// 文件工具读大小上限缺省值（字节；声明 sandbox_limits 缺项时兜底）。
///
/// 对偶文件：`engine/py/inkling_host/security_domain.py`（Python 侧同一
/// 常量按批 6e 收敛引用本值；值变更须双侧同步，本侧为权威）。
pub const DEFAULT_MAX_READ_BYTES: u64 = 1 << 20;

/// 文件工具写大小上限缺省值（字节；同上对偶）。
pub const DEFAULT_MAX_WRITE_BYTES: u64 = 1 << 20;

/// NUL 探针窗口（文件头该字节数内含 NUL = 二进制跳过；code_tools/doc_ops
/// 共享——FA16 上移 common）。
pub const NUL_PROBE_WINDOW: usize = 8192;

// ── 域间共享小工具（H9/H11：object_map / now_epoch / truncate 单一权威）──

/// JSON 对象 → 字符串键映射（缺段/非对象 = 空映射；链段数据形态）。
pub fn object_map(value: Option<&JsonValue>) -> HashMap<String, JsonValue> {
    value
        .and_then(JsonValue::as_object)
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

/// 当前 Unix 时间戳（秒；时钟异常回落 0——与既有域实现同语义）。
pub fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 文本截断（字节上限；超限截断并追加截断标记）。
///
/// 统一行为口径（H11）：所有域内 truncate_chars 副本收敛到本函数——
/// 超限文本一律带「…（已截断）」标记，禁止裸截断（防无标记截断的
/// 语义失真）。
pub fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        let mut head = text.to_string();
        head.truncate(max);
        head.push_str("…（已截断）");
        head
    }
}

// ── 受限进程执行（env/build 域共用的宿主侧进程通道）──

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 受限进程的执行结果（退出码 + 截断输出 + 超时标记）。
///
/// 结构化形态而非裸错误：超时/启动失败统一落为结果字段，调用方按
/// 结果语义处理（降级路径不崩溃），与引擎侧 ProcessResult 形状一致。
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

impl ProcessResult {
    /// 启动失败/参数非法的结构化结果（exit -1，消息进 stderr）。
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            exit_code: -1,
            stdout: String::new(),
            stderr: message.into(),
            timed_out: false,
        }
    }

    pub fn ok(&self) -> bool {
        self.exit_code == 0 && !self.timed_out
    }
}

/// 受限进程缺省环境白名单（env=None 时的注入面）。
///
/// 受限执行体默认不继承宿主完整环境：环境清空后仅注入平台运行最小面
/// （裸命令名经 PATH 解析；Windows 系统目录/临时目录/用户主目录供
/// 运行时与工具链自举），其余宿主环境变量一律不外泄给子进程。
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

/// 执行受限子进程（超时 kill + 输出截断；进程型域动作的通用通道）。
///
/// - env 为完整环境块；None = 环境清空后按 [`RESTRICTED_ENV_WHITELIST`]
///   白名单注入（不继承宿主完整环境，受限执行体最小面）；
/// - 超时 = kill 后返回 timed_out 结果（不崩溃），kill 语义经
///   kill_on_drop 保证（等待侧因超时离开后子进程不再残留）；
/// - 输出按 max_chars 截断（超限追加截断标记，防撑爆结果通道）。
pub async fn run_command(
    argv: &[String],
    cwd: Option<&Path>,
    env: Option<&HashMap<String, String>>,
    timeout_secs: f64,
    max_chars: usize,
    timeout_stderr: &str,
) -> ProcessResult {
    let Some(program) = argv.first() else {
        return ProcessResult::failed("进程参数为空（缺程序名）");
    };
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&argv[1..])
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
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
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => return ProcessResult::failed(format!("进程启动失败: {err}")),
    };
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let collected = async move {
        let stdout = read_pipe(stdout_pipe).await.unwrap_or_default();
        let stderr = read_pipe(stderr_pipe).await.unwrap_or_default();
        let status = child.wait().await;
        (stdout, stderr, status)
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs_f64(timeout_secs.max(0.0)),
        collected,
    )
    .await
    {
        Ok((stdout, stderr, status)) => {
            let exit_code = status.ok().and_then(|exit| exit.code()).unwrap_or(-1);
            ProcessResult {
                exit_code,
                stdout: truncate_text(stdout, max_chars),
                stderr: truncate_text(stderr, max_chars),
                timed_out: false,
            }
        }
        Err(_) => ProcessResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: timeout_stderr.to_string(),
            timed_out: true,
        },
    }
}

async fn read_pipe<R: tokio::io::AsyncRead + Unpin>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut buffer = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut buffer).await?;
    }
    Ok(buffer)
}

fn truncate_text(data: Vec<u8>, max_chars: usize) -> String {
    truncate_chars(&String::from_utf8_lossy(&data), max_chars)
}

/// 归一化路径：Windows canonicalize 产出 `\\?\` 前缀的 verbatim 路径，
/// 路径比较与展示统一转普通形态（与引擎桥 readable_path 同口径）。
///
/// 统一语义（H10）：目标已存在 = canonicalize（跟随符号链接）后去
/// `\\?\` 前缀；不存在 = 原样返回（写新文件场景不因路径不存在而失败）。
pub fn readable_path(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path);
    let text = canonical.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        canonical
    }
}

/// 非严格路径解析（模拟 Python Path.resolve 的既有语义）：目标已存在
/// = canonicalize（跟随符号链接）；目标不存在 = 沿父目录回退到最近
/// 存在点解析后按词法补齐剩余段（写新文件场景不因路径不存在而失败）。
pub fn resolve_non_strict(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return readable_path(canonical);
    }
    let mut head = path.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !head.exists() {
        match (head.file_name(), head.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                head = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut resolved = head
        .canonicalize()
        .map(readable_path)
        .unwrap_or(head);
    for component in tail.iter().rev() {
        resolved.push(component);
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_file_list_has_expected_count() {
        assert_eq!(SEED_DATA_FILES.len(), 21);
    }

    #[test]
    fn placeholder_constant_is_untouched() {
        assert_eq!(WORKSPACE_ROOT_PLACEHOLDER, "${workspace_root}");
    }

    #[test]
    fn shared_constants_and_helpers_are_single_authority() {
        // S12：沙箱大小上限 = 1 MiB（与 Python 侧 security_domain.py 对偶）
        assert_eq!(DEFAULT_MAX_READ_BYTES, 1 << 20);
        assert_eq!(DEFAULT_MAX_WRITE_BYTES, 1 << 20);
        // FA16：NUL 探针窗口（code_tools/doc_ops 共享）
        assert_eq!(NUL_PROBE_WINDOW, 8192);
        // H9：object_map 缺段/非对象 = 空映射
        let map = object_map(Some(&serde_json::json!({"a": 1})));
        assert_eq!(map.len(), 1);
        assert!(object_map(None).is_empty());
        assert!(object_map(Some(&JsonValue::Null)).is_empty());
        assert!(object_map(Some(&serde_json::json!("nope"))).is_empty());
        // H11：truncate 统一带截断标记（禁裸截断语义失真）
        assert_eq!(truncate_chars("短文本", 10), "短文本");
        let cut = truncate_chars("一二三四五六七八九十", 6);
        assert!(cut.starts_with("一二"), "截断保留头部: {cut}");
        assert!(cut.contains("已截断"), "超限截断须带标记: {cut}");
        // H11：now_epoch 为正值秒时间戳
        assert!(now_epoch() > 1_700_000_000.0);
    }

    #[tokio::test]
    async fn run_command_success_and_stdout() {
        let argv = vec![
            "python".to_string(),
            "-c".to_string(),
            "print('common-run-ok')".to_string(),
        ];
        let env = host_path_env();
        let result = run_command(&argv, None, Some(&env), 20.0, 1024, "超时").await;
        assert!(!result.timed_out, "超时标记异常: {}", result.stderr);
        assert_eq!(result.exit_code, 0, "退出码异常: {}", result.stderr);
        assert!(result.stdout.contains("common-run-ok"), "stdout 缺失");
    }

    #[tokio::test]
    async fn run_command_timeout_kills_child() {
        let argv = vec![
            "python".to_string(),
            "-c".to_string(),
            "import time; time.sleep(60)".to_string(),
        ];
        let env = host_path_env();
        let result = run_command(&argv, None, Some(&env), 0.3, 1024, "容器动作超时（已 kill）").await;
        assert!(result.timed_out, "超时未标记");
        assert_eq!(result.exit_code, -1);
    }

    #[tokio::test]
    async fn run_command_missing_binary_is_structured() {
        let argv = vec!["definitely-not-a-real-binary-xyz".to_string()];
        let result = run_command(&argv, None, None, 5.0, 1024, "超时").await;
        assert_eq!(result.exit_code, -1);
        assert!(result.stderr.contains("启动失败"), "启动失败未结构化: {}", result.stderr);
    }

    fn host_path_env() -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        env
    }
}

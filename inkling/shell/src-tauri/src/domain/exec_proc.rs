//! exec_proc 域：exec 子进程的产品集成面——随包就位检查（exec/
//! 二进制定位与可执行校验）、进程注册表 UI 数据（服务器名/状态/
//! 最近心跳/崩溃计数）、诊断入口（日志尾部/退出码）。
//!
//! 机制面（健康检查/崩溃拉起/重启策略）已下沉引擎 mcp_client 的
//! stdio 传输监督；本模块只做壳侧观察与展示数据——注册表 UI 行、
//! 心跳/崩溃计数的心跳数据由引擎侧观测事件回流（经 op 通道），
//! 模块侧提供数据形态映射与展示口径。
//!
//! 依赖纪律：本模块不直接调用其它域模块；注册表数据的引擎侧观测
//! 经 [`crate::engine::host::call_engine_op_async`] 操作通道
//! （未注册 op 显式声明）。

use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;

use super::common::{run_command, DomainError};

/// 随包二进制定位文件名前缀（tools.json 的 inkling_exec server 名）。
pub const EXEC_BINARY_PREFIX: &str = "inkling_exec";

/// 进程状态枚举（UI 行展示的数据形态）。
pub const PROCESS_STATUS_RUNNING: &str = "running";
pub const PROCESS_STATUS_STOPPED: &str = "stopped";
pub const PROCESS_STATUS_CRASHED: &str = "crashed";
pub const PROCESS_STATUS_UNKNOWN: &str = "unknown";

/// 最近心跳超时阈值（秒；超过 = 状态视作不可信）。
pub const HEARTBEAT_STALE_SECS: f64 = 60.0;

/// 随包二进制描述（就位检查产物）。
#[derive(Debug, Clone, PartialEq)]
pub struct ExecBinary {
    pub name: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub executable: bool,
}

/// 平台可执行形态判定（Windows = 扩展名形态；其它平台 = 执行位）。
pub fn looks_executable(path: &Path) -> bool {
    #[cfg(windows)]
    {
        matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase())
                .unwrap_or_default()
                .as_str(),
            "exe" | "cmd" | "bat" | "ps1" | "com"
        )
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
}

/// exec/ 二进制定位与可执行校验（随包就位检查）。
///
/// 定位优先级：文件名含 `inkling_exec` 前缀 → 平台可执行形态；
/// 其次：平台可执行形态的任意单文件（无子目录）。找不到 = 结构化
/// 错误（随包未就位，不得默认它在）。
pub fn locate_exec_binary(exec_dir: &Path) -> Result<ExecBinary, DomainError> {
    if !exec_dir.is_dir() {
        return Err(DomainError::InvalidData(format!(
            "exec/ 目录缺失: {}",
            exec_dir.display()
        )));
    }
    let mut preferred: Option<ExecBinary> = None;
    let mut fallback: Option<ExecBinary> = None;
    let mut entries: Vec<PathBuf> = std::fs::read_dir(exec_dir)
        .map_err(|err| DomainError::InvalidData(format!("exec/ 读取失败: {err}")))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    entries.sort();
    for path in entries {
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let executable = looks_executable(&path);
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let binary = ExecBinary {
            name: name.clone(),
            path: path.clone(),
            size_bytes,
            executable,
        };
        if name.to_lowercase().contains(EXEC_BINARY_PREFIX) && executable {
            return Ok(binary);
        }
        if preferred.is_none() && name.to_lowercase().contains(EXEC_BINARY_PREFIX) {
            preferred = Some(binary.clone());
        }
        if fallback.is_none() && executable {
            fallback = Some(binary);
        }
    }
    if let Some(binary) = preferred {
        return Ok(binary);
    }
    if let Some(binary) = fallback {
        return Ok(binary);
    }
    Err(DomainError::InvalidData(format!(
        "exec/ 未找到可执行件（{}）",
        exec_dir.display()
    )))
}

/// 数据目录下的 exec/ 路径（运行数据根的产品化布局）。
pub fn exec_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("exec")
}

/// 二进制版本探测（`--version` 输出首行；探测失败 = None，不阻塞
/// 就位检查结论——就位只看定位与可执行形态）。
pub async fn probe_version(binary: &ExecBinary) -> Option<String> {
    let argv = vec![
        binary.path.to_string_lossy().into_owned(),
        "--version".to_string(),
    ];
    let mut env = std::collections::HashMap::new();
    if let Ok(path) = std::env::var("PATH") {
        env.insert("PATH".to_string(), path);
    }
    let result = run_command(&argv, None, Some(&env), 5.0, 200, "").await;
    if result.ok() {
        result
            .stdout
            .lines()
            .next()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
    } else {
        None
    }
}

// ── 进程注册表 UI 数据 ──

/// 进程注册表行（UI 展示形态：服务器名/状态/最近心跳/崩溃计数）。
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessEntry {
    pub server_name: String,
    pub status: String,
    pub last_heartbeat: Option<f64>,
    pub crash_count: u32,
}

impl ProcessEntry {
    /// 心跳数据刷新（引擎观测回流后调用；状态回 running）。
    pub fn touch_heartbeat(mut self, now: f64) -> Self {
        self.last_heartbeat = Some(now);
        self.status = PROCESS_STATUS_RUNNING.to_string();
        self
    }

    /// 心跳过期判定（最近心跳距今超过阈值 = 信任度下降）。
    pub fn heartbeat_stale(&self, now: f64) -> bool {
        self.last_heartbeat
            .map(|beat| now - beat > HEARTBEAT_STALE_SECS)
            .unwrap_or(true)
    }

    /// 崩溃记录（崩溃计数 +1，状态改 Crashed）。
    pub fn record_crash(mut self) -> Self {
        self.crash_count += 1;
        self.status = PROCESS_STATUS_CRASHED.to_string();
        self
    }
}

/// 引擎观测记录 → 注册表行（records 数据形态映射；字段缺失容错）。
pub fn process_entry_from_record(record: &JsonValue) -> Result<ProcessEntry, DomainError> {
    let server_name = record
        .get("server_name")
        .or_else(|| record.get("name"))
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| DomainError::InvalidData("进程记录缺 server_name".to_string()))?
        .to_string();
    let status = record
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or(PROCESS_STATUS_UNKNOWN)
        .to_string();
    Ok(ProcessEntry {
        server_name,
        status,
        last_heartbeat: record.get("last_heartbeat").and_then(JsonValue::as_f64),
        crash_count: record
            .get("crash_count")
            .and_then(JsonValue::as_u64)
            .unwrap_or(0) as u32,
    })
}

/// 注册表记录清单 → UI 行清单（按服务器名排序；坏行跳过留痕）。
pub fn registry_from_records(records: &[JsonValue]) -> Vec<ProcessEntry> {
    let mut rows: Vec<ProcessEntry> = records
        .iter()
        .filter_map(|record| process_entry_from_record(record).ok())
        .collect();
    rows.sort_by(|a, b| a.server_name.cmp(&b.server_name));
    rows
}

/// 状态展示文案（UI 行；状态值归一化，未知值不静默）。
pub fn status_label(status: &str) -> &'static str {
    match status {
        PROCESS_STATUS_RUNNING => "运行中",
        PROCESS_STATUS_STOPPED => "已停止",
        PROCESS_STATUS_CRASHED => "已崩溃",
        _ => "未知",
    }
}

/// 崩溃计数聚合（注册表行 → 总数；UI 摘要行）。
pub fn crash_total(rows: &[ProcessEntry]) -> u32 {
    rows.iter().map(|entry| entry.crash_count).sum()
}

/// 心跳超期计数（注册表行 → 数量；UI 摘要行）。
pub fn heartbeat_stale_count(rows: &[ProcessEntry], now: f64) -> usize {
    rows.iter()
        .filter(|entry| entry.heartbeat_stale(now))
        .count()
}

// ── 诊断入口 ──

/// 日志尾部读取（最近 max_chars 字符；超长带截断标记）。
pub fn log_tail(log_path: &Path, max_chars: usize) -> Result<String, DomainError> {
    let content = std::fs::read_to_string(log_path)
        .map_err(|err| DomainError::Storage(format!("日志读取失败 {}: {err}", log_path.display())))?;
    if content.chars().count() <= max_chars {
        return Ok(content);
    }
    let skip = content.chars().count() - max_chars;
    let mut tail: String = content.chars().skip(skip).collect();
    tail.insert_str(0, "…（头部省略）\n");
    Ok(tail)
}

/// 退出码语义说明（诊断行；常见码有文案，其余按数值展示）。
pub fn exit_code_diag(exit_code: i32) -> String {
    match exit_code {
        0 => "正常退出（exit 0）".to_string(),
        1 => "进程崩溃/异常退出（exit 1）".to_string(),
        137 => "被终止（exit 137；资源超限或主动 kill）".to_string(),
        -1 => "未启动/启动失败（无有效退出码）".to_string(),
        other => format!("退出码 {other}"),
    }
}

// ── 引擎交互（op 通道；未注册 op 显式声明）──

/// 拉取进程注册表数据（引擎侧 stdio 传输监督的心跳/崩溃观测）。
///
/// 需 op: engine.mcp_process_registry（mcp_client stdio 传输监督的
/// 观测数据经引擎操作通道待注册；注册后本函数直接可用，未注册
/// 返回结构化错误——UI 行由引擎事件回流兜底）。
pub async fn fetch_process_registry() -> Result<Vec<ProcessEntry>, String> {
    Err("需 op: engine.mcp_process_registry —— 进程注册表引擎观测经操作通道待注册".to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("inkling-exec-proc-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn locate_finds_exec_binary_and_reports_missing() {
        let ws = Scratch::new("locate");
        let exec_dir = ws.0.join("exec");
        std::fs::create_dir_all(&exec_dir).unwrap();
        #[cfg(windows)]
        {
            let bin = exec_dir.join("inkling_exec.exe");
            std::fs::write(&bin, b"MZ fake").unwrap();
            let located = locate_exec_binary(&exec_dir).expect("定位成功");
            assert_eq!(located.name, "inkling_exec.exe");
            assert!(located.executable);
            assert!(located.size_bytes > 0);
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let bin = exec_dir.join("inkling_exec");
            std::fs::write(&bin, b"#!/bin/sh\necho inkling\n").unwrap();
            let mut perms = std::fs::metadata(&bin).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&bin, perms).unwrap();
            let located = locate_exec_binary(&exec_dir).expect("定位成功");
            assert_eq!(located.name, "inkling_exec");
            assert!(located.executable);
        }
        let empty = Scratch::new("empty");
        std::fs::create_dir_all(&empty.0.join("exec")).unwrap();
        assert!(locate_exec_binary(&empty.0.join("exec")).is_err());
        assert!(locate_exec_binary(&empty.0.join("nope")).is_err());
    }

    #[tokio::test]
    async fn version_probe_is_optional() {
        let ws = Scratch::new("probe");
        let binary = ExecBinary {
            name: "inkling_exec.exe".to_string(),
            path: ws.0.join("nope.exe"),
            size_bytes: 0,
            executable: true,
        };
        let version = probe_version(&binary).await;
        assert_eq!(version, None, "探测失败不阻塞 = None");
    }

    #[test]
    fn registry_mapping_and_lifecycle() {
        let records = vec![
            serde_json::json!({"server_name": "inkling_exec", "status": "running", "last_heartbeat": 100.0, "crash_count": 1}),
            serde_json::json!({"name": "inkling_shell", "status": "crashed", "crash_count": 3}),
            serde_json::json!({"other": "skip"}),
        ];
        let rows = registry_from_records(&records);
        assert_eq!(rows.len(), 2, "坏行跳过");
        assert_eq!(rows[0].server_name, "inkling_exec");
        assert_eq!(rows[1].server_name, "inkling_shell");
        let alive = rows[0].clone().touch_heartbeat(200.0);
        assert_eq!(alive.status, PROCESS_STATUS_RUNNING);
        assert!(!alive.heartbeat_stale(210.0));
        assert!(alive.heartbeat_stale(300.0));
        let crashed = rows[0].clone().record_crash();
        assert_eq!(crashed.crash_count, 2);
        assert_eq!(crashed.status, PROCESS_STATUS_CRASHED);
        assert_eq!(crash_total(&rows), 4);
        assert_eq!(heartbeat_stale_count(&rows, 1000.0), 2);
        assert_eq!(heartbeat_stale_count(&rows, 101.0), 1);
        assert_eq!(status_label("running"), "运行中");
        assert_eq!(status_label("crashed"), "已崩溃");
        assert_eq!(status_label("whatever"), "未知");
    }

    #[test]
    fn log_tail_reads_recent_window() {
        let ws = Scratch::new("logs");
        let log = ws.0.join("server.log");
        std::fs::write(&log, "line1\nline2\nline3\nline4\n").unwrap();
        let tail = log_tail(&log, 12).expect("读取成功");
        assert!(tail.contains("line4"));
        assert!(tail.contains("头部省略"), "超长截断标记");
        let full = log_tail(&log, 1000).expect("小日志全量");
        assert_eq!(full.lines().count(), 4);
        assert!(log_tail(&ws.0.join("missing.log"), 100).is_err());
    }

    #[test]
    fn exit_code_diagnostics() {
        assert!(exit_code_diag(0).contains("正常"));
        assert!(exit_code_diag(1).contains("崩溃"));
        assert!(exit_code_diag(137).contains("终止"));
        assert!(exit_code_diag(-1).contains("未启动"));
        assert_eq!(exit_code_diag(42), "退出码 42");
    }

    #[test]
    fn registry_op_facade_reports_unregistered() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(fetch_process_registry());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("需 op"));
    }
}

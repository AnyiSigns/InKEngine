//! 执行器实现：纯逻辑守卫（权限/沙箱）+ 后端副作用调用。
//!
//! 每个执行器自带签名契约（params/permission/endpoint/sandbox）；
//! 注册时与声明逐项比对——不一致 = 注册失败（fail-closed，禁硬编码漂移）。
//! 守卫先行：deny 硬拦、review 需授权、白名单/边界越界拒绝，
//! 副作用只在守卫通过后经 SystemBackend 触发。
//!
//! 签名单一来源：executor_spec(name) 返回执行器侧签名契约，
//! 注册校验 = 声明 params/permission/endpoint/sandbox ↔ 执行器侧签名逐项比对。

use std::collections::BTreeMap;

use serde_json::Value;

use super::backends::SystemBackend;
use super::tool_decl::{Endpoint, ParamType, PermissionLevel, SandboxRule};

/// 参数规格（签名契约的比对面）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamSpec {
    pub name: &'static str,
    pub param_type: ParamType,
    pub required: bool,
}

/// 执行结果
#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub result: String,
    /// 本次调用经过的沙箱守卫（true = 沙箱校验通过后放行）
    pub sandbox_checked: bool,
}

/// 执行错误（守卫与执行两类）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecError {
    /// 未知工具（注册表外拒绝，禁硬编码回退）
    UnknownTool(String),
    /// deny 级硬拦
    PermissionDenied(String),
    /// review 级未授权
    ApprovalRequired(String),
    /// 沙箱越界（白名单/路径根/边界/长度）
    SandboxViolation(String),
    /// 参数缺失/类型非法
    BadArgs(String),
    /// 副作用执行失败
    ExecutionFailed(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::UnknownTool(name) => write!(f, "未知工具（注册表拒绝）: {name}"),
            ExecError::PermissionDenied(name) => write!(f, "权限 deny 硬拦: {name}"),
            ExecError::ApprovalRequired(name) => write!(f, "需 L2 人工审批后方可执行: {name}"),
            ExecError::SandboxViolation(detail) => write!(f, "沙箱越界拒绝: {detail}"),
            ExecError::BadArgs(detail) => write!(f, "参数非法: {detail}"),
            ExecError::ExecutionFailed(detail) => write!(f, "执行失败: {detail}"),
        }
    }
}

/// 授权面（引擎审批层判定后传入；壳只做强制，不自行决定审批）
#[derive(Debug, Clone, Copy)]
pub struct Authorization {
    pub approved: bool,
}

/// 执行器契约
pub trait Executor: Send + Sync {
    fn name(&self) -> &str;
    fn spec(&self) -> &ExecutorSpec;
    fn run(
        &self,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError>;
}

/// 执行器签名契约（注册校验的比对面）
#[derive(Debug, Clone)]
pub struct ExecutorSpec {
    pub name: &'static str,
    pub params: Vec<ParamSpec>,
    pub permission: PermissionLevel,
    pub endpoint: Endpoint,
    pub sandbox: SandboxRule,
}

/// 守卫辅助：权限分级判定（deny 硬拦 / review 需授权 / allow 放行）
pub(crate) fn check_permission(
    tool: &str,
    level: PermissionLevel,
    auth: &Authorization,
) -> Result<(), ExecError> {
    match level {
        PermissionLevel::Deny => Err(ExecError::PermissionDenied(tool.into())),
        PermissionLevel::Review if !auth.approved => Err(ExecError::ApprovalRequired(tool.into())),
        _ => Ok(()),
    }
}

/// 参数提取辅助：必填缺失 / 类型非法 → BadArgs
pub(crate) fn arg_str<'a>(
    args: &'a BTreeMap<String, Value>,
    name: &str,
) -> Result<&'a str, ExecError> {
    match args.get(name) {
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(value),
        Some(_) => Err(ExecError::BadArgs(format!("{name} 须为字符串"))),
        None => Err(ExecError::BadArgs(format!("缺少必填参数 {name}"))),
    }
}

pub(crate) fn arg_i64(args: &BTreeMap<String, Value>, name: &str) -> Result<i64, ExecError> {
    match args.get(name) {
        Some(Value::Number(value)) => value
            .as_i64()
            .ok_or_else(|| ExecError::BadArgs(format!("{name} 须为整数"))),
        Some(Value::String(value)) => value
            .parse::<i64>()
            .map_err(|_| ExecError::BadArgs(format!("{name} 须为整数"))),
        _ => Err(ExecError::BadArgs(format!("缺少必填参数 {name}"))),
    }
}

/// 沙箱校验辅助：命令/查询面白名单
pub(crate) fn check_allowlist(
    allowlist: &[String],
    value: &str,
    tool: &str,
) -> Result<(), ExecError> {
    if allowlist.iter().any(|item| item == value) {
        Ok(())
    } else {
        Err(ExecError::SandboxViolation(format!(
            "{tool} 白名单外取值: {value}"
        )))
    }
}

/// 沙箱校验辅助：路径根（规范化后前缀匹配，杜绝 ../ 越界与相对路径）
pub(crate) fn check_path_roots(roots: &[String], path: &str) -> Result<(), ExecError> {
    let target = normalize_abs(path)?;
    let inside = roots.iter().any(|root| {
        match normalize_abs(root) {
            Ok(root_path) => target.starts_with(&root_path),
            Err(_) => false,
        }
    });
    if inside {
        Ok(())
    } else {
        Err(ExecError::SandboxViolation(format!(
            "路径不在工作区挂载根内: {path}"
        )))
    }
}

fn normalize_abs(path: &str) -> Result<std::path::PathBuf, ExecError> {
    let expanded = if let Some(rest) = path.trim().strip_prefix("~/") {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(|home| std::path::PathBuf::from(home).join(rest))
            .unwrap_or_else(|_| std::path::PathBuf::from(path))
    } else {
        std::path::PathBuf::from(path)
    };
    if !expanded.is_absolute() {
        return Err(ExecError::SandboxViolation(format!(
            "路径须为绝对路径: {path}"
        )));
    }
    Ok(expanded)
}

/// 沙箱校验辅助：数值边界
pub(crate) fn check_bounds(min: i64, max: i64, value: i64, tool: &str) -> Result<(), ExecError> {
    if value < min || value > max {
        Err(ExecError::SandboxViolation(format!(
            "{tool} 越界: {value}（允许 {min}–{max}）"
        )))
    } else {
        Ok(())
    }
}

// ===== 执行器签名单一来源 =====

const WORKSPACE_ROOT: &str = "~/.inkling/workspace";

fn launch_app_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "launch_app",
        params: vec![ParamSpec { name: "app", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec!["notepad".into(), "calc".into(), "mspaint".into()],
        },
    }
}

fn open_file_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "open_file",
        params: vec![ParamSpec { name: "path", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::PathRoots { roots: vec![WORKSPACE_ROOT.into()] },
    }
}

fn system_query_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "system_query",
        params: vec![ParamSpec { name: "query", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec![
                "os".into(),
                "arch".into(),
                "hostname".into(),
                "home".into(),
                "cwd".into(),
                "uptime".into(),
            ],
        },
    }
}

fn set_volume_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "set_volume",
        params: vec![ParamSpec { name: "percent", param_type: ParamType::Integer, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::Bounds { min: 0, max: 100 },
    }
}

fn set_brightness_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "set_brightness",
        params: vec![ParamSpec { name: "percent", param_type: ParamType::Integer, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::Bounds { min: 0, max: 100 },
    }
}

fn notify_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "notify",
        params: vec![
            ParamSpec { name: "title", param_type: ParamType::String, required: true },
            ParamSpec { name: "body", param_type: ParamType::String, required: true },
        ],
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::LengthCaps { title_max: 80, body_max: 500 },
    }
}

fn schedule_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "schedule",
        params: vec![
            ParamSpec { name: "seconds", param_type: ParamType::Integer, required: true },
            ParamSpec { name: "action", param_type: ParamType::String, required: true },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::Bounds { min: 1, max: 86400 },
    }
}

fn screen_query_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "screen_query",
        params: vec![ParamSpec { name: "target", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec!["resolution".into(), "work_area".into()],
        },
    }
}

fn file_query_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "file_query",
        params: vec![ParamSpec { name: "path", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::PathRoots { roots: vec![WORKSPACE_ROOT.into()] },
    }
}

/// 进程模板工具的超时上限（秒；钉死在声明侧，与夹具一致）。
const PROCESS_TEMPLATE_TIMEOUT_SECS: u64 = 180;

fn run_typecheck_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_typecheck",
        params: vec![ParamSpec { name: "command", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["tsc".into(), "--noEmit".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
        },
    }
}

fn run_test_cargo_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_cargo",
        params: vec![ParamSpec { name: "command", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["cargo".into(), "test".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
        },
    }
}

fn run_test_python_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_python",
        params: vec![ParamSpec { name: "command", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["python".into(), "-m".into(), "pytest".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
        },
    }
}

fn run_test_web_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_web",
        params: vec![ParamSpec { name: "command", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["npx".into(), "vitest".into(), "run".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
        },
    }
}

/// 执行器实现表：名字 → (签名契约, 运行体)
pub fn executor_impl(name: &str) -> Option<(ExecutorSpec, RunFn)> {
    let pair: (ExecutorSpec, RunFn) = match name {
        "launch_app" => (launch_app_spec(), launch_app_run),
        "open_file" => (open_file_spec(), open_file_run),
        "system_query" => (system_query_spec(), system_query_run),
        "set_volume" => (set_volume_spec(), set_volume_run),
        "set_brightness" => (set_brightness_spec(), set_brightness_run),
        "notify" => (notify_spec(), notify_run),
        "schedule" => (schedule_spec(), schedule_run),
        "screen_query" => (screen_query_spec(), screen_query_run),
        "file_query" => (file_query_spec(), file_query_run),
        "run_typecheck" => (run_typecheck_spec(), run_process_template),
        "run_test_cargo" => (run_test_cargo_spec(), run_process_template),
        "run_test_python" => (run_test_python_spec(), run_process_template),
        "run_test_web" => (run_test_web_spec(), run_process_template),
        _ => return None,
    };
    Some(pair)
}

pub type RunFn = fn(
    &dyn Executor,
    &BTreeMap<String, Value>,
    &dyn SystemBackend,
    &Authorization,
) -> Result<ExecOutcome, ExecError>;

// ===== 运行体（守卫 → 后端副作用） =====

fn launch_app_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let app = arg_str(args, "app")?.to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &app, tool)?;
    }
    let result = backend.launch_app(&app).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn open_file_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let path = arg_str(args, "path")?.to_string();
    if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?;
    }
    let result = backend.open_file(&path).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn system_query_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let query = arg_str(args, "query")?.to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &query, tool)?;
    }
    let result = backend.system_query(&query).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn set_volume_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let percent = arg_i64(args, "percent")?;
    if let SandboxRule::Bounds { min, max } = &executor.spec().sandbox {
        check_bounds(*min, *max, percent, tool)?;
    }
    let result = backend.set_volume(percent as u32).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn set_brightness_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let percent = arg_i64(args, "percent")?;
    if let SandboxRule::Bounds { min, max } = &executor.spec().sandbox {
        check_bounds(*min, *max, percent, tool)?;
    }
    let result = backend.set_brightness(percent as u32).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn notify_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let title = arg_str(args, "title")?.to_string();
    let body = arg_str(args, "body")?.to_string();
    if let SandboxRule::LengthCaps { title_max, body_max } = &executor.spec().sandbox {
        if title.chars().count() > *title_max || body.chars().count() > *body_max {
            return Err(ExecError::SandboxViolation(format!(
                "notify 超长: title≤{title_max} body≤{body_max}"
            )));
        }
    }
    let result = backend.notify(&title, &body).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn schedule_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let seconds = arg_i64(args, "seconds")?;
    let action = arg_str(args, "action")?.to_string();
    if let SandboxRule::Bounds { min, max } = &executor.spec().sandbox {
        check_bounds(*min, *max, seconds, tool)?;
    }
    let result = backend.schedule(seconds as u64, &action).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn screen_query_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let target = arg_str(args, "target")?.to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &target, tool)?;
    }
    let result = backend.screen_query(&target).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

fn file_query_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let path = arg_str(args, "path")?.to_string();
    if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?;
    }
    let result = backend.file_query(&path).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 进程模板运行体（run_typecheck / run_test_* 共用）：
///
/// 调用参数只承载端点操作判定的固定命令名（command 与工具名不符 =
/// 拒绝）；可执行面 = 声明侧钉死的参数模板（无自由参数），工作目录
/// = 工作区挂载根，超时与输出截断由后端保证。守卫 = 权限档 + 模板
/// 形态校验；命令名本身经引擎侧端点白名单收口（双重校验）。
fn run_process_template(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let command = arg_str(args, "command")?;
    if command != tool {
        return Err(ExecError::BadArgs(format!(
            "command 固定枚举不符: {command}（期望 {tool}）"
        )));
    }
    let (argv, timeout_secs) = match &executor.spec().sandbox {
        SandboxRule::ProcessTemplate { argv, timeout_secs } => (argv.clone(), *timeout_secs),
        _ => {
            return Err(ExecError::SandboxViolation(
                "沙箱模式非法（进程模板工具须声明钉死模板）".into(),
            ))
        }
    };
    let cwd = normalize_abs(WORKSPACE_ROOT)?;
    let cwd_text = cwd.to_string_lossy().into_owned();
    let result = backend
        .run_process(&argv, &cwd_text, timeout_secs)
        .map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

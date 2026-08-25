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

/// 屏幕坐标范围（Windows 坐标空间上限；与 fixture 坐标点击沙箱同源）。
const CLICK_X_MIN: i64 = 0;
const CLICK_X_MAX: i64 = 32767;
const CLICK_Y_MIN: i64 = 0;
const CLICK_Y_MAX: i64 = 32767;
/// 点击按键白名单（与 fixture 坐标点击沙箱 buttons 同源）。
const CLICK_BUTTONS: &[&str] = &["left", "right", "middle"];
/// 文本输入长度上限（字符；与 fixture 文本输入沙箱 max_chars 同源）。
const UI_TEXT_MAX_CHARS: usize = 256;
/// 窗口作用域白名单（window_list 用；与 fixture window_target scopes 同源）。
const WINDOW_SCOPES: &[&str] = &["all", "foreground"];

fn ui_tree_query_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "ui_tree_query",
        params: vec![ParamSpec { name: "scope", param_type: ParamType::String, required: false }],
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec!["foreground".into(), "all".into()],
        },
    }
}

fn ui_click_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "ui_click",
        params: vec![
            ParamSpec { name: "x", param_type: ParamType::Integer, required: true },
            ParamSpec { name: "y", param_type: ParamType::Integer, required: true },
            ParamSpec { name: "button", param_type: ParamType::String, required: true },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CoordinateClick {
            x_min: CLICK_X_MIN,
            x_max: CLICK_X_MAX,
            y_min: CLICK_Y_MIN,
            y_max: CLICK_Y_MAX,
            buttons: CLICK_BUTTONS.iter().map(|item| item.to_string()).collect(),
        },
    }
}

fn ui_type_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "ui_type",
        params: vec![ParamSpec { name: "text", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::TextInput { max_chars: UI_TEXT_MAX_CHARS },
    }
}

fn window_list_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "window_list",
        params: vec![ParamSpec { name: "scope", param_type: ParamType::String, required: false }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::WindowTarget {
            scopes: WINDOW_SCOPES.iter().map(|item| item.to_string()).collect(),
        },
    }
}

fn window_focus_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "window_focus",
        params: vec![ParamSpec { name: "handle", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::WindowTarget { scopes: vec![] },
    }
}

fn window_minimize_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "window_minimize",
        params: vec![ParamSpec { name: "handle", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::WindowTarget { scopes: vec![] },
    }
}

/// 文档解析沙箱根（工作区挂载根 + 附件落点；上传/截图文件均在此域）。
const DOC_PARSE_ROOTS: &[&str] = &["~/.inkling/workspace", "~/.inkling/attachments"];

fn doc_parse_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "doc_parse",
        params: vec![ParamSpec { name: "path", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::PathRoots {
            roots: DOC_PARSE_ROOTS.iter().map(|root| root.to_string()).collect(),
        },
    }
}

/// 文档解析运行体（只读：路径根收口 + 格式识别 + 结构化解析为 JSON）。
fn doc_parse_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let _ = backend;
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let path = arg_str(args, "path")?.to_string();
    if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?;
    }
    let bytes = std::fs::read(&path)
        .map_err(|err| ExecError::ExecutionFailed(format!("读取文档失败: {err}")))?;
    let parsed = crate::domain::doc_ops::parse_document(&bytes)
        .map_err(|err| ExecError::ExecutionFailed(err.to_string()))?;
    Ok(ExecOutcome { result: parsed.to_string(), sandbox_checked: true })
}

/// 既有资料批量导入（目录扫描 + 格式归一；沙箱端点 device_mcp，根收口于用户主目录域）。
fn material_import_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "material_import",
        params: vec![
            ParamSpec { name: "path", param_type: ParamType::String, required: true },
            ParamSpec { name: "recursive", param_type: ParamType::Boolean, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::PathRoots {
            roots: crate::domain::import_material::MATERIAL_ROOTS
                .iter()
                .map(|root| root.to_string())
                .collect(),
        },
    }
}

/// 既有资料批量导入运行体（只读：路径根收口 + 递归深度/文件数/体积上限 → 格式归一）。
fn material_import_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let _ = backend;
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let path = arg_str(args, "path")?.to_string();
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let result = crate::domain::import_material::scan_and_normalize(&path, recursive)
        .map_err(ExecError::ExecutionFailed)?;
    let serialized = serde_json::to_string(&result)
        .map_err(|err| ExecError::ExecutionFailed(format!("扫描结果序列化失败: {err}")))?;
    Ok(ExecOutcome { result: serialized, sandbox_checked: true })
}

/// 文档生成参数上限（正文/表格行防滥用；声明侧同源）。
const DOC_GENERATE_BODY_MAX_CHARS: usize = 20000;
const DOC_GENERATE_TABLE_MAX_ROWS: usize = 500;

fn doc_generate_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "doc_generate",
        params: vec![
            ParamSpec { name: "format", param_type: ParamType::String, required: true },
            ParamSpec { name: "title", param_type: ParamType::String, required: true },
            ParamSpec { name: "body", param_type: ParamType::String, required: false },
            ParamSpec { name: "table", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::PathRoots { roots: vec![WORKSPACE_ROOT.into()] },
    }
}

/// 文档生成运行体（写文件副作用：仅工作区根内落盘，格式枚举 + 长度上限收口）。
fn doc_generate_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let _ = backend;
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let format = arg_str(args, "format")?.to_string();
    let title = arg_str(args, "title")?.to_string();
    if title.trim().is_empty() {
        return Err(ExecError::BadArgs(format!("{tool} 标题不可为空")));
    }
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if body.chars().count() > DOC_GENERATE_BODY_MAX_CHARS {
        return Err(ExecError::SandboxViolation(format!(
            "{tool} 正文超长（≤{DOC_GENERATE_BODY_MAX_CHARS} 字符）"
        )));
    }
    let bytes = match format.as_str() {
        "docx" => {
            use crate::domain::doc_ops::{build_docx_report, DocxReportSpec, DocxSection};
            let spec = DocxReportSpec {
                title: title.clone(),
                sections: vec![DocxSection { heading: None, body }],
                table: None,
            };
            build_docx_report(&spec).map_err(|err| ExecError::ExecutionFailed(err.to_string()))?
        }
        "xlsx" => {
            use crate::domain::doc_ops::build_xlsx_table;
            let rows: Vec<Vec<String>> = args
                .get("table")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Vec<Vec<String>>>(text).ok())
                .unwrap_or_default();
            if rows.len() > DOC_GENERATE_TABLE_MAX_ROWS {
                return Err(ExecError::SandboxViolation(format!(
                    "{tool} 表格行数超限（≤{DOC_GENERATE_TABLE_MAX_ROWS}）"
                )));
            }
            build_xlsx_table(&title, &rows).map_err(|err| ExecError::ExecutionFailed(err.to_string()))?
        }
        other => {
            return Err(ExecError::BadArgs(format!(
                "{tool} 不支持的格式: {other}（docx/xlsx）"
            )))
        }
    };
    let out_dir = normalize_abs(WORKSPACE_ROOT)?;
    std::fs::create_dir_all(&out_dir)
        .map_err(|err| ExecError::ExecutionFailed(format!("输出目录创建失败: {err}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let safe_title: String = title
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect();
    let ext = if format == "xlsx" { "xlsx" } else { "docx" };
    let file_name = format!("{safe_title}_{stamp}.{ext}");
    let out_path = out_dir.join(&file_name);
    std::fs::write(&out_path, &bytes)
        .map_err(|err| ExecError::ExecutionFailed(format!("文档写入失败: {err}")))?;
    let result = serde_json::json!({
        "path": out_path.to_string_lossy(),
        "format": format,
        "bytes": bytes.len(),
    })
    .to_string();
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 截图目标模型类别白名单（与声明侧同源；cloud 经隐私分级闸门）。
const SCREENSHOT_MODEL_CLASSES: &[&str] = &["local", "cloud"];

fn screenshot_capture_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "screenshot_capture",
        params: vec![
            ParamSpec { name: "model_class", param_type: ParamType::String, required: true },
            ParamSpec { name: "destination", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: SCREENSHOT_MODEL_CLASSES.iter().map(|item| item.to_string()).collect(),
        },
    }
}

/// 截图运行体（隐私分级闸门：本地直喂 / 云端默认禁外发，审批后放行）。
fn screenshot_capture_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let _ = backend;
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let model_class = arg_str(args, "model_class")?.to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &model_class, tool)?;
    }
    let model = match model_class.as_str() {
        "local" => crate::domain::screenshot::ModelClass::Local,
        _ => crate::domain::screenshot::ModelClass::Cloud,
    };
    let destination = args
        .get("destination")
        .and_then(Value::as_str)
        .unwrap_or("engine")
        .to_string();
    let settings_path = normalize_abs("~/.inkling/vision.json")?;
    let settings = crate::domain::screenshot::VisionSettings::load(&settings_path)
        .unwrap_or_else(|_| crate::domain::screenshot::VisionSettings::default());
    let approved = auth.approved;
    let gate = crate::domain::screenshot::VisionGate {
        settings,
        approve: std::sync::Arc::new(move || approved),
    };
    let out_dir = normalize_abs("~/.inkling/attachments")?;
    let capturer = crate::domain::screenshot::WindowsScreenCapturer;
    let attachment = tokio_block_on(crate::domain::screenshot::capture_and_feed(
        &capturer,
        &gate,
        model,
        &destination,
        &out_dir,
        &None,
    ))
    .map_err(|err| ExecError::ExecutionFailed(err.to_string()))?;
    Ok(ExecOutcome {
        result: attachment.to_dict().to_string(),
        sandbox_checked: true,
    })
}

/// 同步侧桥接异步域函数（截图分级流程为异步审计流；执行器签名保持同步）。
fn tokio_block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("截图流程运行时构建失败")
        .block_on(future)
}

/// 进程模板工具的超时上限（秒；钉死在声明侧，与夹具一致）。
const PROCESS_TEMPLATE_TIMEOUT_SECS: u64 = 180;

/// 测试筛选值长度上限（字符；足够承载测试名子串/关键词组合）。
const FILTER_MAX_CHARS: usize = 64;

fn run_typecheck_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_typecheck",
        params: vec![ParamSpec { name: "command", param_type: ParamType::String, required: true }],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["tsc".into(), "--noEmit".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
            filter_arg: None,
        },
    }
}

fn run_test_cargo_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_cargo",
        params: vec![
            ParamSpec { name: "command", param_type: ParamType::String, required: true },
            ParamSpec { name: "filter", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["cargo".into(), "test".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
            filter_arg: Some("--".into()),
        },
    }
}

fn run_test_python_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_python",
        params: vec![
            ParamSpec { name: "command", param_type: ParamType::String, required: true },
            ParamSpec { name: "filter", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["python".into(), "-m".into(), "pytest".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
            filter_arg: Some("-k".into()),
        },
    }
}

fn run_test_web_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "run_test_web",
        params: vec![
            ParamSpec { name: "command", param_type: ParamType::String, required: true },
            ParamSpec { name: "filter", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::ProcessTemplate {
            argv: vec!["npx".into(), "vitest".into(), "run".into()],
            timeout_secs: PROCESS_TEMPLATE_TIMEOUT_SECS,
            filter_arg: Some("-t".into()),
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
        "ui_tree_query" => (ui_tree_query_spec(), ui_tree_query_run),
        "ui_click" => (ui_click_spec(), ui_click_run),
        "ui_type" => (ui_type_spec(), ui_type_run),
        "window_list" => (window_list_spec(), window_list_run),
        "window_focus" => (window_focus_spec(), window_focus_run),
        "window_minimize" => (window_minimize_spec(), window_minimize_run),
        "doc_parse" => (doc_parse_spec(), doc_parse_run),
        "material_import" => (material_import_spec(), material_import_run),
        "doc_generate" => (doc_generate_spec(), doc_generate_run),
        "screenshot_capture" => (screenshot_capture_spec(), screenshot_capture_run),
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

/// 元素树感知运行体（只读：作用域白名单收口，越权域拒绝）。
///
/// ui_tree_query 为 allow 档（只读感知无副作用），但作用域（foreground/all）
/// 越界仍按沙箱拒绝——只读不代表可越权感知任意桌面控件层级。
fn ui_tree_query_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("all")
        .to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &scope, tool)?;
    }
    let result = backend.ui_tree_query().map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 鼠标点击运行体（坐标边界 + 按键白名单收口；审批档 review）。
fn ui_click_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let x = arg_i64(args, "x")?;
    let y = arg_i64(args, "y")?;
    let button = arg_str(args, "button")?.to_string();
    if let SandboxRule::CoordinateClick { x_min, x_max, y_min, y_max, buttons } = &executor.spec().sandbox {
        check_bounds(*x_min, *x_max, x, tool)?;
        check_bounds(*y_min, *y_max, y, tool)?;
        if !buttons.iter().any(|item| item == &button) {
            return Err(ExecError::SandboxViolation(format!(
                "{tool} 不支持的按键: {button}"
            )));
        }
    }
    let result = backend
        .ui_click(x as i32, y as i32, &button)
        .map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 文本输入运行体（长度上限收口；审批档 review）。
fn ui_type_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let text = arg_str(args, "text")?.to_string();
    if let SandboxRule::TextInput { max_chars } = &executor.spec().sandbox {
        if text.chars().count() > *max_chars {
            return Err(ExecError::SandboxViolation(format!(
                "{tool} 文本超长（≤{max_chars} 字符）"
            )));
        }
    }
    let result = backend.ui_type(&text).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 窗口清单运行体（作用域白名单收口；审批档 review）。
fn window_list_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("all")
        .to_string();
    if let SandboxRule::WindowTarget { scopes } = &executor.spec().sandbox {
        if !scopes.is_empty() && !scopes.iter().any(|item| item == &scope) {
            return Err(ExecError::SandboxViolation(format!(
                "{tool} 不支持的作用域: {scope}"
            )));
        }
    }
    let result = backend.window_list().map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 聚焦窗口运行体（句柄非空校验；审批档 review）。
fn window_focus_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let handle = arg_str(args, "handle")?.to_string();
    if handle.trim().is_empty() {
        return Err(ExecError::BadArgs(format!("{tool} 句柄不可为空")));
    }
    let result = backend.window_focus(&handle).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 最小化窗口运行体（句柄非空校验；审批档 review）。
fn window_minimize_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let handle = arg_str(args, "handle")?.to_string();
    if handle.trim().is_empty() {
        return Err(ExecError::BadArgs(format!("{tool} 句柄不可为空")));
    }
    let result = backend.window_minimize(&handle).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 测试筛选值校验（run_test_* 的 filter 参数）。
///
/// 直接 argv 数组传给测试运行器（不经 shell，无命令拼接面），校验
/// 只关两点：值不得以 `-` 开头（防被解析为运行器旗标，如 pytest 的
/// --pdb 交互式调试器）且仅限安全字符集（关键词/文件名子串语义够用，
/// 排除 `;` `&` `|` `$` 反引号等一切可作逃逸/拼接的符号——纵深防御，
/// 即便未来某层引入 shell 拼接也不放大攻击面）。
fn validate_test_filter(filter: &str) -> Result<(), ExecError> {
    let len = filter.chars().count();
    if !(1..=FILTER_MAX_CHARS).contains(&len) {
        return Err(ExecError::BadArgs(format!(
            "filter 长度须在 1..={FILTER_MAX_CHARS} 字符内（实际 {len}）"
        )));
    }
    let head = filter.chars().next().unwrap_or_default();
    if head == '-' || head == ' ' {
        return Err(ExecError::BadArgs(
            "filter 不得以 `-` 或空格开头（防旗标注入）".into(),
        ));
    }
    if !filter.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ' ')) {
        return Err(ExecError::BadArgs(
            "filter 仅限字母/数字/`_`/`-`/`.`/`/`/空格（无命令拼接面）".into(),
        ));
    }
    Ok(())
}

/// 进程模板运行体（run_typecheck / run_test_* 共用）：
///
/// 调用参数 = 端点操作判定的固定命令名（command 与工具名不符 = 拒绝）
/// + 可选的受限筛选（filter：仅声明 filter_arg 的工具接受；值经字符
/// 集/长度/前导符校验后以 [标志, 值] 追加到模板尾部）。可执行面 =
/// 声明侧钉死的参数模板，工作目录 = 工作区挂载根，超时与输出截断由
/// 后端保证。守卫 = 权限档 + 模板形态校验 + 筛选校验。
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
    let (mut argv, timeout_secs, filter_arg) = match &executor.spec().sandbox {
        SandboxRule::ProcessTemplate { argv, timeout_secs, filter_arg } => {
            (argv.clone(), *timeout_secs, filter_arg.clone())
        }
        _ => {
            return Err(ExecError::SandboxViolation(
                "沙箱模式非法（进程模板工具须声明钉死模板）".into(),
            ))
        }
    };
    if let Some(filter) = args.get("filter").and_then(Value::as_str) {
        if !filter.trim().is_empty() {
            let Some(flag) = filter_arg else {
                return Err(ExecError::BadArgs(format!(
                    "{tool} 不接受筛选参数（模板钉死，无 filter 声明位）"
                )));
            };
            validate_test_filter(filter)?;
            argv.push(flag);
            argv.push(filter.to_string());
        }
    }
    let cwd = normalize_abs(WORKSPACE_ROOT)?;
    let cwd_text = cwd.to_string_lossy().into_owned();
    let result = backend
        .run_process(&argv, &cwd_text, timeout_secs)
        .map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executors::backends::{MockBackend, PlatformBackend, SystemBackend};
    use serde_json::Value;

    /// 测试桩执行器：把执行器侧签名契约喂给运行体（运行体只读 name/spec）。
    struct SpecExecutor {
        spec: ExecutorSpec,
    }

    impl Executor for SpecExecutor {
        fn name(&self) -> &str {
            self.spec.name
        }
        fn spec(&self) -> &ExecutorSpec {
            &self.spec
        }
        fn run(
            &self,
            _args: &BTreeMap<String, Value>,
            _backend: &dyn SystemBackend,
            _auth: &Authorization,
        ) -> Result<ExecOutcome, ExecError> {
            unreachable!("测试桩不参与 run 分发")
        }
    }

    /// 经执行器注册表表项运行（守卫 + 后端副作用同真实路径）。
    fn run_via(
        name: &str,
        args: &BTreeMap<String, Value>,
        backend: &dyn SystemBackend,
        auth: &Authorization,
    ) -> Result<ExecOutcome, ExecError> {
        let (spec, run) = executor_impl(name).expect("执行器须已实现");
        let executor = SpecExecutor { spec };
        run(&executor, args, backend, auth)
    }

    #[test]
    fn ui_tree_query_mock_returns_json_structure() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("scope".into(), Value::String("all".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_tree_query", &args, &backend, &auth).expect("须成功");
        let tree: Value = serde_json::from_str(&outcome.result).expect("须为 JSON");
        assert!(tree.get("foreground").is_some(), "缺 foreground 字段");
        let windows = tree.get("windows").and_then(Value::as_array).expect("缺 windows 数组");
        assert!(!windows.is_empty(), "窗口列表不应为空");
        let first = &windows[0];
        assert!(first.get("handle").is_some());
        assert!(first.get("children").is_some(), "顶级窗口须含子窗口层级");
    }

    #[test]
    fn ui_tree_query_overreach_scope_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("scope".into(), Value::String("camera".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_tree_query", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "越权域须被拒: {err}");
    }

    #[test]
    fn ui_tree_query_allow_tier_needs_no_approval() {
        let backend = MockBackend::new();
        let args = BTreeMap::new();
        let auth = Authorization { approved: false };
        let outcome = run_via("ui_tree_query", &args, &backend, &auth).expect("allow 档无需审批");
        assert!(outcome.result.contains("windows"));
    }

    #[test]
    fn ui_click_requires_approval() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("x".into(), Value::from(10i64));
        args.insert("y".into(), Value::from(10i64));
        args.insert("button".into(), Value::String("left".into()));
        let auth = Authorization { approved: false };
        let err = run_via("ui_click", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::ApprovalRequired(_)), "review 档须审批: {err}");
    }

    #[test]
    fn ui_click_bad_button_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("x".into(), Value::from(10i64));
        args.insert("y".into(), Value::from(10i64));
        args.insert("button".into(), Value::String("explode".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_click", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "非法按键须被拒: {err}");
    }

    #[test]
    fn ui_click_out_of_bounds_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("x".into(), Value::from(999999i64));
        args.insert("y".into(), Value::from(10i64));
        args.insert("button".into(), Value::String("left".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_click", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "越界坐标须被拒: {err}");
    }

    #[test]
    fn ui_click_approved_injects_backend() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("x".into(), Value::from(10i64));
        args.insert("y".into(), Value::from(20i64));
        args.insert("button".into(), Value::String("right".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_click", &args, &backend, &auth).expect("审批通过须执行");
        assert!(outcome.result.contains("right @ (10,20)"));
        assert!(backend.calls.lock().unwrap().iter().any(|call| call.contains("ui_click:10,20,right")));
    }

    #[test]
    fn ui_type_overlong_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("text".into(), Value::String("x".repeat((UI_TEXT_MAX_CHARS as i64 + 1) as usize)));
        let auth = Authorization { approved: true };
        let err = run_via("ui_type", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "超长文本须被拒: {err}");
    }

    #[test]
    fn ui_type_approved_injects_backend() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("text".into(), Value::String("hello".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_type", &args, &backend, &auth).expect("审批通过须执行");
        assert!(outcome.result.contains("hello"));
    }

    #[test]
    fn window_list_invalid_scope_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("scope".into(), Value::String("secrets".into()));
        let auth = Authorization { approved: true };
        let err = run_via("window_list", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "非法作用域须被拒: {err}");
    }

    #[test]
    fn window_focus_empty_handle_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("handle".into(), Value::String("".into()));
        let auth = Authorization { approved: true };
        let err = run_via("window_focus", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::BadArgs(_)), "空句柄须被拒: {err}");
    }

    #[test]
    fn window_focus_missing_handle_fail_closed() {
        // 真实后端对不存在窗口返回 Err → 执行失败（fail-closed，不静默成功）。
        let backend = PlatformBackend;
        let mut args = BTreeMap::new();
        args.insert("handle".into(), Value::String("__no_such_window__".into()));
        let auth = Authorization { approved: true };
        let err = run_via("window_focus", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::ExecutionFailed(_)), "定位失败须 fail-closed: {err}");
    }

    #[test]
    fn window_minimize_missing_handle_fail_closed() {
        let backend = PlatformBackend;
        let mut args = BTreeMap::new();
        args.insert("handle".into(), Value::String("__no_such_window__".into()));
        let auth = Authorization { approved: true };
        let err = run_via("window_minimize", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::ExecutionFailed(_)), "定位失败须 fail-closed: {err}");
    }

    #[test]
    fn ui_type_unmappable_char_fail_closed() {
        // 不可映射字符（如私有区码点）经 VkKeyScanW 返回 -1 → 失败，不静默丢字符。
        let backend = PlatformBackend;
        let mut args = BTreeMap::new();
        args.insert("text".into(), Value::String("".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_type", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::ExecutionFailed(_)), "不可映射字符须 fail-closed: {err}");
    }

    #[test]
    fn new_executors_registered() {
        for name in [
            "ui_tree_query",
            "ui_click",
            "ui_type",
            "window_list",
            "window_focus",
            "window_minimize",
        ] {
            assert!(executor_impl(name).is_some(), "执行器未注册: {name}");
        }
    }
}

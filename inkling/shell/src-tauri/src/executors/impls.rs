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

use crate::domain::common::resolve_non_strict;

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

/// 参数提取辅助：字符串数组（shell_exec argv 等；空数组/类型非法 → BadArgs）
pub(crate) fn arg_str_list(
    args: &BTreeMap<String, Value>,
    name: &str,
) -> Result<Vec<String>, ExecError> {
    match args.get(name) {
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item.as_str() {
                    Some(value) if !value.is_empty() => out.push(value.to_string()),
                    _ => return Err(ExecError::BadArgs(format!("{name} 须为字符串数组"))),
                }
            }
            if out.is_empty() {
                Err(ExecError::BadArgs(format!("{name} 不能为空数组")))
            } else {
                Ok(out)
            }
        }
        Some(_) => Err(ExecError::BadArgs(format!("{name} 须为字符串数组"))),
        None => Err(ExecError::BadArgs(format!("缺少必填参数 {name}"))),
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

/// 沙箱校验辅助：路径根（规范化后前缀匹配，杜绝 ../ 越界与相对路径）。
///
/// 解析 = resolve_non_strict（目标已存在 = canonicalize 跟随符号链接；不存在
/// = 沿父目录回退到最近存在点解析后按词法补齐）——`..` 穿越与符号链接逃逸
/// 在解析后按前缀匹配拒绝。返回解析后的绝对路径供 IO 使用（执行对象 =
/// 校验对象，防 TOCTOU 校验后回用原始路径）。
pub(crate) fn check_path_roots(roots: &[String], path: &str) -> Result<std::path::PathBuf, ExecError> {
    let target = normalize_abs(path)?;
    if has_dotdot_segments(&target) {
        return Err(ExecError::SandboxViolation(format!(
            "路径含 `..` 段，拒绝穿越: {path}"
        )));
    }
    let resolved = resolve_non_strict(&target);
    let inside = roots.iter().any(|root| {
        let root_path = match normalize_abs(root) {
            Ok(root_path) => root_path,
            Err(_) => return false,
        };
        if has_dotdot_segments(&root_path) {
            return false;
        }
        resolved.starts_with(resolve_non_strict(&root_path))
    });
    if inside {
        Ok(resolved)
    } else {
        Err(ExecError::SandboxViolation(format!(
            "路径不在工作区挂载根内: {path}"
        )))
    }
}

fn normalize_abs(path: &str) -> Result<std::path::PathBuf, ExecError> {
    let trimmed = path.trim();
    let expanded = if trimmed == "~" {
        home_dir().unwrap_or_else(|| std::path::PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~/") {
        home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| std::path::PathBuf::from(trimmed))
    } else {
        std::path::PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(ExecError::SandboxViolation(format!(
            "路径须为绝对路径: {path}"
        )));
    }
    Ok(expanded)
}

fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(std::path::PathBuf::from)
}

/// 工作区挂载根（进程模板执行 cwd / 路径沙箱根）：headless 经
/// ``INKENGINE_WS_ROOT`` 环境变量覆盖挂载根（lib.rs wire_round_execution
/// 与文件工具沙箱同源），桌面壳回落默认 ``WORKSPACE_ROOT``。
fn workspace_root() -> String {
    std::env::var("INKENGINE_WS_ROOT").unwrap_or_else(|_| WORKSPACE_ROOT.to_string())
}

/// 路径是否含 `..` 段（词法判定；与安全域 rule_matches 的 `..` 拒绝同纪律，
/// 新建文件场景无法靠解析结果兜底，必须先按段拒绝）。
fn has_dotdot_segments(path: &std::path::Path) -> bool {
    path.components()
        .any(|component| component == std::path::Component::ParentDir)
}

/// 沙箱校验辅助：新建文件路径（写入目标可不存在，无法 canonicalize）——
/// 「解析后的根前缀 + 禁 `..` 段」双校验，返回解析后的父目录与文件名
/// （父目录经 resolve_non_strict 解析，落盘对象 = 校验对象）。
pub(crate) fn check_new_path_root(
    roots: &[String],
    target: &std::path::Path,
) -> Result<std::path::PathBuf, ExecError> {
    let target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        normalize_abs(&target.to_string_lossy())?
    };
    if has_dotdot_segments(&target) {
        return Err(ExecError::SandboxViolation(format!(
            "路径含 `..` 段，拒绝穿越: {}",
            target.display()
        )));
    }
    let resolved = resolve_non_strict(&target);
    let inside = roots.iter().any(|root| {
        let root_path = match normalize_abs(root) {
            Ok(root_path) => root_path,
            Err(_) => return false,
        };
        if has_dotdot_segments(&root_path) {
            return false;
        }
        resolved.starts_with(resolve_non_strict(&root_path))
    });
    if inside {
        Ok(resolved)
    } else {
        Err(ExecError::SandboxViolation(format!(
            "路径不在工作区挂载根内: {}",
            target.display()
        )))
    }
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

fn sleep_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "sleep",
        params: vec![ParamSpec { name: "seconds", param_type: ParamType::Integer, required: true }],
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::Bounds { min: 1, max: 86400 },
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
/// 元素树作用域白名单（ui_query 的 scope 用；与 fixture window_target scopes 同源）。
const UI_QUERY_SCOPES: &[&str] = &["all", "foreground"];

/// 桌面 UI 感知签名契约（原 window_list/screen_query/ui_tree_query 三合一）：
/// target 选感知面（tree=元素树/resolution/work_area=屏幕几何参数），
/// scope 只约束元素树范围（foreground/all）。只读感知 = allow 档。
fn ui_query_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "ui_query",
        params: vec![
            ParamSpec { name: "target", param_type: ParamType::String, required: false },
            ParamSpec { name: "scope", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::DeviceMcp,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec!["tree".into(), "resolution".into(), "work_area".into()],
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
pub(crate) const DOC_PARSE_ROOTS: &[&str] = &["~/.inkling/workspace", "~/.inkling/attachments"];

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
    let resolved = if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?
    } else {
        return Err(ExecError::SandboxViolation(
            "沙箱模式非法（doc_parse 须声明路径根）".into(),
        ));
    };
    let bytes = crate::domain::doc_ops::read_document_file(&resolved)
        .map_err(|err| ExecError::ExecutionFailed(err.to_string()))?;
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
    let resolved = if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?
    } else {
        return Err(ExecError::SandboxViolation(
            "沙箱模式非法（material_import 须声明路径根）".into(),
        ));
    };
    let result = crate::domain::import_material::scan_and_normalize(&resolved.to_string_lossy(), recursive)
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
    let roots = vec![WORKSPACE_ROOT.to_string()];
    let out_dir = check_new_path_root(&roots, &out_dir)?;
    std::fs::create_dir_all(&out_dir)
        .map_err(|err| ExecError::ExecutionFailed(format!("输出目录创建失败: {err}")))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_title: String = title
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '_' || ch == '-' { ch } else { '_' })
        .collect();
    let ext = if format == "xlsx" { "xlsx" } else { "docx" };
    let file_name = format!("{safe_title}_{stamp}.{ext}");
    let out_path = out_dir.join(&file_name);
    let out_path = check_new_path_root(&roots, &out_path)?;
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

/// 自指演化提案执行器：把工具调用转发给引擎接线桥的 propose_patch op
/// （审批分级 L0/L1/L2 与补丁链 vetting 全部在引擎侧既有管线内执行，
/// 壳侧只做签名校验与转发，不做域逻辑）。
fn propose_patch_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "propose_patch",
        params: vec![
            ParamSpec { name: "kind", param_type: ParamType::String, required: true },
            ParamSpec { name: "payload", param_type: ParamType::String, required: true },
            ParamSpec { name: "base_version", param_type: ParamType::Integer, required: false },
            ParamSpec { name: "rationale", param_type: ParamType::String, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec!["propose_patch".into()],
        },
    }
}

/// shell_exec 执行超时上限（秒；agent 可控时长的上界，与声明一致）。
const SHELL_EXEC_TIMEOUT_MAX: i64 = 3600;
/// shell_exec 执行超时缺省值（秒；未传 timeout 时回落）。
const SHELL_EXEC_DEFAULT_TIMEOUT_SECS: u64 = 180;

/// 工作区命令执行执行器（shell_exec 混合级别：白名单内命令 cwd 钉在
/// 工作区挂载根、命令面白名单 + review 档门禁；白名单外命令经引擎侧
/// 升级审批（L2 卡）通过后一次性系统级放行——escalated 标记由引擎
/// 审批通过后注入 argv，壳侧跳过命令面白名单并改用系统主目录 cwd。
/// timeout 参数由 agent 控制执行时长（1-3600 秒，缺省 180）。档位与
/// 命令面以声明为准（seed_data/tools.json → tools_os.json）。
fn shell_exec_spec() -> ExecutorSpec {
    ExecutorSpec {
        name: "shell_exec",
        params: vec![
            ParamSpec { name: "command", param_type: ParamType::String, required: true },
            ParamSpec { name: "argv", param_type: ParamType::StringArray, required: true },
            ParamSpec { name: "timeout", param_type: ParamType::Integer, required: false },
        ],
        permission: PermissionLevel::Review,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CommandAllowlist {
            allowlist: vec![
                "pip".into(),
                "python".into(),
                "uv".into(),
                "git".into(),
                "cargo".into(),
                "npm".into(),
                "npx".into(),
            ],
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
        "sleep" => (sleep_spec(), sleep_run),
        "file_query" => (file_query_spec(), file_query_run),
        "ui_query" => (ui_query_spec(), ui_query_run),
        "ui_click" => (ui_click_spec(), ui_click_run),
        "ui_type" => (ui_type_spec(), ui_type_run),
        "window_focus" => (window_focus_spec(), window_focus_run),
        "window_minimize" => (window_minimize_spec(), window_minimize_run),
        "doc_parse" => (doc_parse_spec(), doc_parse_run),
        "material_import" => (material_import_spec(), material_import_run),
        "doc_generate" => (doc_generate_spec(), doc_generate_run),
        "screenshot_capture" => (screenshot_capture_spec(), screenshot_capture_run),
        "propose_patch" => (propose_patch_spec(), propose_patch_run),
        "shell_exec" => (shell_exec_spec(), shell_exec_run),
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
    let resolved = if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?
    } else {
        return Err(ExecError::SandboxViolation(
            "沙箱模式非法（open_file 须声明路径根）".into(),
        ));
    };
    let result = backend
        .open_file(&resolved.to_string_lossy())
        .map_err(ExecError::ExecutionFailed)?;
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

fn sleep_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let seconds = arg_i64(args, "seconds")?;
    if let SandboxRule::Bounds { min, max } = &executor.spec().sandbox {
        check_bounds(*min, *max, seconds, tool)?;
    }
    let result = backend.sleep(seconds as u64).map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result, sandbox_checked: true })
}

/// 桌面 UI 感知运行体（只读：target 白名单 + scope 白名单收口，越权域拒绝）。
///
/// ui_query 为 allow 档（只读感知无副作用），但感知面/作用域越界仍按沙箱
/// 拒绝——只读不代表可越权感知任意桌面控件层级。
fn ui_query_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let target = args
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("tree")
        .to_string();
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, &target, tool)?;
    }
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("all")
        .to_string();
    if !UI_QUERY_SCOPES.iter().any(|item| *item == scope) {
        return Err(ExecError::SandboxViolation(format!(
            "{tool} 不支持的感知范围: {scope}"
        )));
    }
    let result = match target.as_str() {
        "resolution" | "work_area" => backend.screen_query(&target),
        _ => backend.ui_tree_query(&scope),
    }
    .map_err(ExecError::ExecutionFailed)?;
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
    let resolved = if let SandboxRule::PathRoots { roots } = &executor.spec().sandbox {
        check_path_roots(roots, &path)?
    } else {
        return Err(ExecError::SandboxViolation(
            "沙箱模式非法（file_query 须声明路径根）".into(),
        ));
    };
    let result = backend
        .file_query(&resolved.to_string_lossy())
        .map_err(ExecError::ExecutionFailed)?;
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

/// 自指演化提案运行体：签名校验 + 转发引擎接线桥 op。
///
/// 域逻辑（按类型校验 / 审批分级 / 补丁链落链回退）全部在引擎侧
/// ``engine.propose_patch`` op 内执行，壳侧只做守卫与 JSON 转发——
/// payload 按扁平签名为 JSON 文本，引擎侧还原为对象。
fn propose_patch_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    _backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    if let SandboxRule::CommandAllowlist { allowlist } = &executor.spec().sandbox {
        check_allowlist(allowlist, tool, tool)?;
    } else {
        return Err(ExecError::SandboxViolation(
            "沙箱模式非法（propose_patch 须声明命令白名单）".into(),
        ));
    }
    let kind = arg_str(args, "kind")?.to_string();
    let payload = arg_str(args, "payload")?.to_string();
    let base_version = args
        .get("base_version")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let rationale = args
        .get("rationale")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let params = serde_json::json!({
        "kind": kind,
        "payload": serde_json::from_str::<serde_json::Value>(&payload)
            .unwrap_or(serde_json::Value::Null),
        "base_version": base_version,
        "rationale": rationale,
    });
    let result = crate::engine::host::call_engine_op("engine.propose_patch", params)
        .map_err(ExecError::ExecutionFailed)?;
    Ok(ExecOutcome { result: result.to_string(), sandbox_checked: true })
}

/// 工作区命令执行运行体：权限守卫（review 档）→ 命令面白名单（argv[0]，
/// escalated 标记 = 引擎升级审批通过后注入，跳过白名单并用系统主目录
/// cwd）→ 工作区挂载根/主目录 cwd → 真实子进程执行（超时/截断由后端
/// 保证；timeout 参数由 agent 控制，1-3600 秒，缺省 180）。
fn shell_exec_run(
    executor: &dyn Executor,
    args: &BTreeMap<String, Value>,
    backend: &dyn SystemBackend,
    auth: &Authorization,
) -> Result<ExecOutcome, ExecError> {
    let tool = executor.name();
    check_permission(tool, executor.spec().permission, auth)?;
    let argv = arg_str_list(args, "argv")?;
    let Some(program) = argv.first() else {
        return Err(ExecError::BadArgs("argv 不能为空（缺命令名）".into()));
    };
    // 升级审批放行判定（S-2 修复）：不再信任 args 中的 `_escalated` 标记
    // ——渲染进程可直接伪造该参数提权绕过白名单。放行 = 审批台账已批准
    // （auth.approved：review 档工具须经引擎审批流水线/自动放行配置，
    // 审批卡为唯一防线）+ 命令不在白名单（白名单内本就放行）。args 中
    // 的下划线内部键已在命令面/台账登记处剥离，不参与裁决指纹。
    let allowlist = match &executor.spec().sandbox {
        SandboxRule::CommandAllowlist { allowlist } => allowlist,
        _ => {
            return Err(ExecError::SandboxViolation(
                "沙箱模式非法（shell_exec 须声明命令白名单）".into(),
            ));
        }
    };
    let in_allowlist = allowlist.iter().any(|item| item == program);
    let escalated = auth.approved
        && matches!(executor.spec().permission, PermissionLevel::Review)
        && !in_allowlist;
    if !escalated {
        check_allowlist(allowlist, program, tool)?;
    }
    // cwd：白名单内 = 工作区挂载根（沙箱级）；升级放行 = 系统主目录
    // （系统级一次性放行，不钉工作区）
    let cwd_text = if escalated {
        home_dir()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
            .to_string_lossy()
            .into_owned()
    } else {
        normalize_abs(&workspace_root())?.to_string_lossy().into_owned()
    };
    // timeout：agent 可控时长（1-3600，缺省 180）
    let timeout_secs = args
        .get("timeout")
        .and_then(Value::as_i64)
        .map(|v| v.clamp(1, SHELL_EXEC_TIMEOUT_MAX) as u64)
        .unwrap_or(SHELL_EXEC_DEFAULT_TIMEOUT_SECS);
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

    /// shell_exec 混合级别：缺 argv / 白名单外命令无升级标记 = 拒绝；
    /// 白名单内命令照常执行。
    #[test]
    fn shell_exec_missing_argv_rejected() {
        let backend = MockBackend::new();
        let args = BTreeMap::new();
        let auth = Authorization { approved: true };
        let err = run_via("shell_exec", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::BadArgs(_)), "缺 argv 须拒绝: {err}");
        assert!(
            backend.calls.lock().unwrap().is_empty(),
            "拒绝的调用不得触达后端副作用"
        );
    }

    #[test]
    fn shell_exec_forged_escalation_without_approval_rejected() {
        // S-2 安全回归：args 中伪造 `_escalated: true` 而无审批批准态，
        // 白名单外命令必须被拒（审批卡为唯一防线，标记不再被信任）。
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("argv".into(), Value::Array(vec![Value::String("where".into()), Value::String("git".into())]));
        args.insert("_escalated".into(), Value::Bool(true));
        let auth = Authorization { approved: false };
        let err = run_via("shell_exec", &args, &backend, &auth).unwrap_err();
        assert!(
            matches!(err, ExecError::ApprovalRequired(_) | ExecError::SandboxViolation(_)),
            "伪造升级标记无批准态须拒绝: {err}"
        );
        assert!(backend.calls.lock().unwrap().is_empty(), "拒绝的调用不得触达后端");
    }

    #[test]
    fn shell_exec_approved_non_allowlisted_executes() {
        // 升级放行 = 审批批准态本身（无需 args 标记）：review 档工具
        // 已批准 + 命令不在白名单 → 执行（系统主目录 cwd）。
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("argv".into(), Value::Array(vec![Value::String("where".into()), Value::String("git".into())]));
        let auth = Authorization { approved: true };
        let outcome = run_via("shell_exec", &args, &backend, &auth).expect("升级放行后白名单外命令应执行");
        assert!(outcome.result.contains("where git"), "{}", outcome.result);
        assert!(
            backend.calls.lock().unwrap().iter().any(|c| c.starts_with("run_process:")),
            "升级放行应触达后端执行"
        );
    }

    #[test]
    fn ui_query_tree_mock_returns_json_structure() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("target".into(), Value::String("tree".into()));
        args.insert("scope".into(), Value::String("all".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_query", &args, &backend, &auth).expect("须成功");
        let tree: Value = serde_json::from_str(&outcome.result).expect("须为 JSON");
        assert!(tree.get("foreground").is_some(), "缺 foreground 字段");
        let windows = tree.get("windows").and_then(Value::as_array).expect("缺 windows 数组");
        assert!(!windows.is_empty(), "窗口列表不应为空");
        let first = &windows[0];
        assert!(first.get("handle").is_some());
        assert!(first.get("children").is_some(), "顶级窗口须含子窗口层级");
        assert!(backend.calls.lock().unwrap().iter().any(|c| c == "ui_tree_query:all"));
    }

    #[test]
    fn ui_query_resolution_dispatches_screen_query() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("target".into(), Value::String("resolution".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_query", &args, &backend, &auth).expect("须成功");
        assert_eq!(outcome.result, "mock:screen resolution");
        assert!(backend.calls.lock().unwrap().iter().any(|c| c == "screen_query:resolution"));
    }

    #[test]
    fn ui_query_overreach_scope_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("scope".into(), Value::String("camera".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_query", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "越权域须被拒: {err}");
    }

    #[test]
    fn ui_query_overreach_target_denied() {
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("target".into(), Value::String("spy_camera".into()));
        let auth = Authorization { approved: true };
        let err = run_via("ui_query", &args, &backend, &auth).unwrap_err();
        assert!(matches!(err, ExecError::SandboxViolation(_)), "越权感知面须被拒: {err}");
    }

    #[test]
    fn ui_query_allow_tier_needs_no_approval() {
        let backend = MockBackend::new();
        let args = BTreeMap::new();
        let auth = Authorization { approved: false };
        let outcome = run_via("ui_query", &args, &backend, &auth).expect("allow 档无需审批");
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
    fn ui_type_accepts_unmappable_codepoints() {
        // UNICODE 注入按 UTF-16 码元直送：私有区码点不再被拒（无「不可映射字符」概念）。
        let backend = MockBackend::new();
        let mut args = BTreeMap::new();
        args.insert("text".into(), Value::String("\u{e100}".into()));
        let auth = Authorization { approved: true };
        let outcome = run_via("ui_type", &args, &backend, &auth).expect("UNICODE 注入须接受任意码元");
        assert!(outcome.result.contains("mock:type"), "执行应成功并透传文本: {outcome:?}");
        assert!(
            backend.calls.lock().unwrap().iter().any(|call| call.contains("ui_type:\u{e100}")),
            "文本应原样透传给后端"
        );
    }

    #[test]
    fn new_executors_registered() {
        for name in [
            "ui_query",
            "ui_click",
            "ui_type",
            "window_focus",
            "window_minimize",
        ] {
            assert!(executor_impl(name).is_some(), "执行器未注册: {name}");
        }
    }
}

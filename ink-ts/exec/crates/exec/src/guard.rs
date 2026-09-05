//! 机械守门基元：端点归属表、路径根/动态挂载根解析、环境面形状校验。
//!
//! 零裁决红线：本模块只做「信封约束 vs 请求形态」的一致性复核（fail-closed），
//! 不读策略文件、不做审批判定。约束对象 = 信封内现取的 roots/allowlist/
//! allow_domains/端点名——exec 没有本地副本，信封里没有的能力本进程不存在。
//!
//! 端点归属表（CallGate 的机械形态，L7）：每种物理 op 只能由固定端点族
//! 承载——进程执行只归 os 端点、文件 IO 只归 file 端点、出网抓取只归
//! network 端点。这是「能力归属」而非权限声明（不随工具声明变化）。
//! 新端点类型（如 database）如要复用物理执行体，归属表是 exec 侧唯一需要
//! 开口的机械点（由收口方评审，不开给 agent）。

use std::path::{Path, PathBuf};

use super::envelope::{
    Deny, ENV_ENTRIES_MAX, ENV_KEY_MAX_CHARS, ENV_VALUE_MAX_CHARS,
};

/// 物理 op ↔ 端点归属（机械常量；op 不在表内 = 未知能力，拒绝）。
pub fn op_allows_endpoint(op: &str, endpoint: &str) -> bool {
    match op {
        "process" => endpoint == "os",
        "file" => endpoint == "file",
        "http" => endpoint == "network",
        _ => false,
    }
}

/// 根目录白名单形态：非空且每项为绝对路径（host 已裁决后的路径根）。
pub fn validate_roots(roots: &[String]) -> Result<Vec<PathBuf>, Deny> {
    if roots.is_empty() {
        return Err(Deny::new("root", "信封 roots 为空（须含工作区根）"));
    }
    let mut resolved = Vec::with_capacity(roots.len());
    for root in roots {
        resolved.push(normalize_root(root)?);
    }
    Ok(resolved)
}

/// 归一化根目录：须为绝对路径、词法不含 `..` 段；已存在 = canonicalize
/// 跟随符号链接（去 `\\?\` 前缀）后作为比较基准。
pub fn normalize_root(text: &str) -> Result<PathBuf, Deny> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(Deny::new("root", "root 为空"));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(Deny::new("root", format!("路径根须为绝对路径: {trimmed}")));
    }
    if has_dotdot(&path) {
        return Err(Deny::new("root", format!("路径根含 `..` 段，拒绝: {trimmed}")));
    }
    Ok(resolve_non_strict(&path))
}

/// 目标路径解析 + 根内判定（写入目标可不存在；`..` 段词法先拒）。
///
/// 返回解析后的绝对路径供 IO 使用（执行对象 = 校验对象，防 TOCTOU 校验后
/// 回用原始路径）。符号链接指向根外 = canonicalize 后越界拒绝。
pub fn resolve_within_roots(roots: &[PathBuf], target: &str) -> Result<PathBuf, Deny> {
    let raw = target.trim();
    if raw.is_empty() {
        return Err(Deny::new("root", "路径为空"));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(Deny::new("root", format!("路径须为绝对路径: {raw}")));
    }
    if has_dotdot(&path) {
        return Err(Deny::new("root", format!("路径含 `..` 段，拒绝穿越: {raw}")));
    }
    let resolved = resolve_non_strict(&path);
    let inside = roots
        .iter()
        .any(|root| resolved.starts_with(root.as_path()));
    if inside {
        Ok(resolved)
    } else {
        Err(Deny::new(
            "root",
            format!("路径不在挂载根内（工作区根或动态挂载根）: {raw}"),
        ))
    }
}

/// 词法判定路径含 `..` 段（与旧壳 has_dotdot_segments 同纪律）。
fn has_dotdot(path: &Path) -> bool {
    path.components()
        .any(|component| component == std::path::Component::ParentDir)
}

/// 归一化路径：Windows canonicalize 产出 `\\?\` 前缀的 verbatim 路径，
/// 比较/展示统一转普通形态。
pub fn readable_path(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or(path);
    let text = canonical.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        canonical
    }
}

/// 非严格路径解析（模拟 Python Path.resolve 语义）：目标已存在 =
/// canonicalize（跟随符号链接）；不存在 = 沿父目录回退到最近存在点解析
/// 后按词法补齐剩余段（写新文件场景不因路径不存在而失败）。
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
    let mut resolved = head.canonicalize().map(readable_path).unwrap_or(head);
    for component in tail.iter().rev() {
        resolved.push(component);
    }
    resolved
}

/// 命令白名单复核：argv[0]（命令名）必须精确命中信封 allowlist。
pub fn check_allowlist(allowlist: &[String], program: &str, tool: &str) -> Result<(), Deny> {
    if allowlist.is_empty() {
        return Err(Deny::new(
            "allowlist",
            format!("{tool} 信封 allowlist 为空（无放行命令，fail-closed）"),
        ));
    }
    if allowlist.iter().any(|item| item == program) {
        Ok(())
    } else {
        Err(Deny::new(
            "allowlist",
            format!("{tool} 命令不在信封白名单内（越权）: {program}"),
        ))
    }
}

/// 显式 env 面校验：entries ≤ 上界、值全为字符串、键/值长度收口。
/// 返回扁平 HashMap（不含平台继承——env=None 时由 runner 注入最小面）。
pub fn normalize_env(raw: Option<&serde_json::Value>) -> Result<Option<std::collections::HashMap<String, String>>, Deny> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let obj = raw
        .as_object()
        .ok_or_else(|| Deny::new("params", "env 须为对象（string→string）"))?;
    if obj.len() > ENV_ENTRIES_MAX {
        return Err(Deny::new("env", format!("env 条数超限（≤{ENV_ENTRIES_MAX}）")));
    }
    let mut out = std::collections::HashMap::with_capacity(obj.len());
    for (key, value) in obj {
        let value = value
            .as_str()
            .ok_or_else(|| Deny::new("params", format!("env[{key}] 须为字符串")))?;
        if key.is_empty() || key.chars().count() > ENV_KEY_MAX_CHARS {
            return Err(Deny::new(
                "env",
                format!("env 键非法（空或超 {ENV_KEY_MAX_CHARS} 字符）: {key}"),
            ));
        }
        if value.chars().count() > ENV_VALUE_MAX_CHARS {
            return Err(Deny::new(
                "env",
                format!("env[{key}] 值超长（≤{ENV_VALUE_MAX_CHARS} 字符）"),
            ));
        }
        out.insert(key.clone(), value.to_string());
    }
    Ok(Some(out))
}

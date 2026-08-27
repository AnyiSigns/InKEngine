//! 符号引用计数门禁（E-P14）：扫描 ink_engine/core 与壳侧 Rust 的孤儿符号。
//!
//! 检测算法：
//! 1. Python 顶层定义（`def`/`async def`/`class` 缩进 = 0）：从 ink_engine/
//!    ink_engine/core 下所有 .py 抽取；同文件内出现次数 ≥ 2 视为本地复用，
//!    不算孤儿；否则在整个 core + tests + inkling/shell 树内 grep 该符号
//!    的其它出现（如 `from .x import Y` / `import x.Y` / `Y(` 等）——
//!    出现 ≥ 1 次为外部消费。
//! 2. Rust `pub` 项（fn/struct/enum/trait/mod/const/static/type）：仅壳
//!    侧三 crate（exec/self_check/shell-engine），从 `pub ` 前缀抽取；
//!    同文件内 ≥ 2 次 / 整个壳侧 Rust 树出现 ≥ 1 次均不算孤儿。
//!
//! 豁免：`__all__` 列表里导出、tests/live 测试夹具、self_check crate 自身
//! （门禁实现不能自指）。
//!
//! 设计取舍：轻量正则 + 仓库级 grep（不依赖 syn/pyo3 解析），零重依赖
//! 可在七门禁编排内热跑；误报由维护者按 [ORPHAN] 列表半自动甄别。
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const PYTHON_SOURCE_DIR: &str = "ink_engine/ink_engine/core";
const PYTHON_GREP_DIRS: &[&str] = &[
    "ink_engine/ink_engine",
    "inkling/shell/src-tauri/src",
    "inkling/self_check",
];
const RUST_SOURCE_DIRS: &[&str] = &[
    "inkling/exec/src",
    "inkling/self_check/src",
    "inkling/shell/src-tauri/src",
];
const RUST_GREP_DIRS: &[&str] = &[
    "inkling/exec",
    "inkling/shell/src-tauri",
    "inkling/self_check",
];

#[derive(Debug, Clone)]
pub struct OrphanSymbol {
    pub kind: SymbolKind,
    pub name: String,
    pub file: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Python,
    Rust,
}

impl SymbolKind {
    fn label(self) -> &'static str {
        match self {
            SymbolKind::Python => "py",
            SymbolKind::Rust => "rs",
        }
    }
}

#[derive(Debug, Default)]
pub struct ScanReport {
    pub python_scanned: usize,
    pub rust_scanned: usize,
    pub orphans: Vec<OrphanSymbol>,
}

impl ScanReport {
    pub fn is_clean(&self) -> bool {
        self.orphans.is_empty()
    }

    pub fn summary(&self) -> String {
        if self.orphans.is_empty() {
            format!(
                "符号引用计数全绿：扫描 {} 个 Python 文件 + {} 个 Rust 文件，零孤儿符号",
                self.python_scanned, self.rust_scanned
            )
        } else {
            format!(
                "发现 {} 个孤儿符号（顶层定义后同文件未复用 + 仓库内无其它引用）",
                self.orphans.len()
            )
        }
    }

    pub fn render_issues(&self) -> String {
        let mut out = String::new();
        for orphan in &self.orphans {
            out.push_str(&format!(
                "[ORPHAN] {} {} @ {}\n",
                orphan.kind.label(),
                orphan.name,
                orphan.file
            ));
        }
        out
    }
}

/// 门禁入口：扫描仓库内 Python 与 Rust 源，返回报告。
pub fn run(repo_root: &Path) -> ScanReport {
    let mut report = ScanReport::default();

    let allowlist = load_allowlist(repo_root);

    let py_dir = repo_root.join(PYTHON_SOURCE_DIR);
    if py_dir.is_dir() {
        // 预读 core 全部源 + grep dirs 全部源到内存（小型仓库，单门禁耗时 < 1s）
        let py_grep_index = build_text_index(repo_root, PYTHON_GREP_DIRS, &["py"]);
        for entry in collect_sources(&py_dir, "py") {
            let rel = entry
                .strip_prefix(repo_root)
                .unwrap_or(&entry)
                .to_string_lossy()
                .replace('\\', "/");
            report.python_scanned += 1;
            scan_python_file(&entry, &rel, &py_grep_index, &allowlist, &mut report);
        }
    }

    let rust_index = build_text_index(repo_root, RUST_GREP_DIRS, &["rs"]);
    for rel_dir in RUST_SOURCE_DIRS {
        let dir = repo_root.join(rel_dir);
        if !dir.is_dir() {
            continue;
        }
        for entry in collect_sources(&dir, "rs") {
            let rel = entry
                .strip_prefix(repo_root)
                .unwrap_or(&entry)
                .to_string_lossy()
                .replace('\\', "/");
            // 排除 self_check crate 自身（门禁实现不能自指）
            if rel.contains("self_check/src/") {
                continue;
            }
            report.rust_scanned += 1;
            scan_rust_file(&entry, &rel, &rust_index, &allowlist, &mut report);
        }
    }

    report
        .orphans
        .sort_by(|a, b| a.file.cmp(&b.file).then(a.name.cmp(&b.name)));
    report
}

/// 灰名单：历史已知的孤儿（接口/常量/方法虽未被同文件复用 + 跨文件 grep
/// 不到，但承载显式契约或预留给未来接线）。白名单维护在仓库根
/// ``inkling/self_check/orphan_allowlist.txt``，每行 ``<kind> <name>@<file>``：
/// - kind: ``py`` / ``rs``；
/// - name: 符号名；
/// - file: 相对仓库根的源文件路径。
/// 灰名单只豁免当前已识别的孤儿，新孤儿仍会被门禁拦截（半自动甄别：
/// 真接线补引用、误报加灰名单、确认无用则删定义 + 灰名单 + git revert 验证）。
fn load_allowlist(repo_root: &Path) -> HashSet<String> {
    let mut set = HashSet::new();
    let path = repo_root.join("inkling/self_check/orphan_allowlist.txt");
    let Ok(text) = fs::read_to_string(&path) else {
        return set;
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        set.insert(trimmed.to_string());
    }
    set
}

fn allowlist_key(kind: SymbolKind, name: &str, file: &str) -> String {
    format!("{} {}@{}", kind.label(), name, file)
}

/// 文本索引：每文件全文装载，用于跨文件 grep 引用。
fn build_text_index(repo_root: &Path, dirs: &[&str], exts: &[&str]) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for rel in dirs {
        let dir = repo_root.join(rel);
        if !dir.is_dir() {
            continue;
        }
        for entry in collect_sources(&dir, exts[0]) {
            let rel_path = entry
                .strip_prefix(repo_root)
                .unwrap_or(&entry)
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok(text) = fs::read_to_string(&entry) {
                index.insert(rel_path, text);
            }
        }
    }
    index
}

fn collect_sources(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.extend(collect_sources(&path, ext));
        } else if path.extension().and_then(|s| s.to_str()) == Some(ext) {
            out.push(path);
        }
    }
    out
}

fn scan_python_file(
    path: &Path,
    rel: &str,
    grep_index: &HashMap<String, String>,
    allowlist: &HashSet<String>,
    report: &mut ScanReport,
) {
    let content = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return,
    };
    let defined = collect_python_defs(&content);
    if defined.is_empty() {
        return;
    }
    let all_exports = python_all_set(&content);
    for name in defined {
        // 内部约定：以下划线开头的视为隐私符号，不视作孤儿
        if name.starts_with('_') {
            continue;
        }
        // 在 __all__ 中导出：定义面已被声明为对外接口，不算孤儿
        if all_exports.contains(&name) {
            continue;
        }
        // 同文件内出现次数（含定义行）≥ 2：本地有引用
        let in_file = content.matches(&name).count();
        if in_file >= 2 {
            continue;
        }
        // 跨文件 grep 引用（≥ 1 个其它文件出现该符号）
        if has_external_reference(&name, rel, grep_index) {
            continue;
        }
        // 灰名单豁免：历史已知孤儿
        let key = allowlist_key(SymbolKind::Python, &name, rel);
        if allowlist.contains(&key) {
            continue;
        }
        report.orphans.push(OrphanSymbol {
            kind: SymbolKind::Python,
            name,
            file: rel.to_string(),
        });
    }
}

fn collect_python_defs(content: &str) -> HashSet<String> {
    let mut defs = HashSet::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if line.len() != trimmed.len() {
            continue;
        }
        if let Some(name) = python_def_or_class_name(trimmed) {
            defs.insert(name.to_string());
        }
    }
    defs
}

fn python_def_or_class_name(line: &str) -> Option<&str> {
    let rest = line
        .strip_prefix("async def ")
        .or_else(|| line.strip_prefix("def "))
        .or_else(|| line.strip_prefix("class "))?;
    let name: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if name.is_empty() {
        None
    } else {
        Some(Box::leak(name.into_boxed_str()) as &str)
    }
}

fn python_all_set(content: &str) -> HashSet<String> {
    let mut set = HashSet::new();
    let mut in_all = false;
    for line in content.lines() {
        let stripped = line.trim();
        if stripped.starts_with("__all__") && stripped.contains('[') {
            in_all = true;
            // 单行 __all__ = [...] 形态
            if let Some(after) = stripped.split('[').nth(1) {
                for part in after.split(']').next().unwrap_or("").split(',') {
                    let token = part.trim().trim_matches('"').trim_matches('\'');
                    if !token.is_empty() {
                        set.insert(token.to_string());
                    }
                }
            }
            if stripped.contains(']') {
                in_all = false;
            }
            continue;
        }
        if in_all {
            for part in stripped.split(',') {
                let token = part.trim().trim_matches('"').trim_matches('\'');
                if !token.is_empty() && !token.starts_with('#') {
                    set.insert(token.to_string());
                }
            }
            if stripped.contains(']') {
                in_all = false;
            }
        }
    }
    set
}

fn scan_rust_file(
    path: &Path,
    rel: &str,
    grep_index: &HashMap<String, String>,
    allowlist: &HashSet<String>,
    report: &mut ScanReport,
) {
    let content = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(_) => return,
    };
    let defined = collect_rust_defs(&content);
    for name in defined {
        if name.starts_with('_') {
            continue;
        }
        let in_file = content.matches(&name).count();
        if in_file >= 2 {
            continue;
        }
        if has_external_reference(&name, rel, grep_index) {
            continue;
        }
        let key = allowlist_key(SymbolKind::Rust, &name, rel);
        if allowlist.contains(&key) {
            continue;
        }
        report.orphans.push(OrphanSymbol {
            kind: SymbolKind::Rust,
            name,
            file: rel.to_string(),
        });
    }
}

fn collect_rust_defs(content: &str) -> HashSet<String> {
    let mut defs = HashSet::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        if let Some(name) = rust_pub_item(trimmed) {
            defs.insert(name.to_string());
        }
    }
    defs
}

fn rust_pub_item(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("pub ")?;
    for prefix in [
        "async fn ",
        "fn ",
        "struct ",
        "enum ",
        "trait ",
        "mod ",
        "const ",
        "static ",
        "type ",
    ] {
        if let Some(after) = rest.strip_prefix(prefix) {
            let name: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                return Some(Box::leak(name.into_boxed_str()) as &str);
            }
        }
    }
    None
}

/// 跨文件 grep 引用判定：除定义文件外，至少一个其它文件文本含该符号。
fn has_external_reference(name: &str, defining_file: &str, index: &HashMap<String, String>) -> bool {
    for (path, text) in index {
        if path == defining_file {
            continue;
        }
        if text.contains(name) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_def_name_extracts() {
        assert_eq!(python_def_or_class_name("def foo(x):"), Some("foo"));
        assert_eq!(python_def_or_class_name("async def bar():"), Some("bar"));
        assert_eq!(python_def_or_class_name("class Baz:"), Some("Baz"));
        assert_eq!(python_def_or_class_name("    indented()"), None);
    }

    #[test]
    fn rust_pub_item_extracts() {
        assert_eq!(rust_pub_item("pub fn helper() {}"), Some("helper"));
        assert_eq!(rust_pub_item("pub struct Foo;"), Some("Foo"));
        assert_eq!(rust_pub_item("pub async fn baz() {}"), Some("baz"));
        assert_eq!(rust_pub_item("fn private() {}"), None);
    }

    #[test]
    fn python_all_parses_inline() {
        let set = python_all_set("__all__ = [\"A\", \"B\"]\n");
        assert!(set.contains("A"));
        assert!(set.contains("B"));
    }
}

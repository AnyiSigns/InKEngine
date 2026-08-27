//! code_tools 域：工作区代码检索工具——grep（文本内容检索）/ glob
//! （路径递归匹配 + 目录树）/ file_query（文件状态）三工具 + 工作区
//! 根白名单（`${workspace_root}` 占位替换）+ 三工具互让行为手册。
//!
//! - **grep**：glob 模式限定路径范围 + 正则匹配文件内容 + 文件类型
//!   过滤 + 结果条数上限截断（截断标记不静默）；
//! - **glob**：路径递归匹配（globset `**` 语义）+ 目录树（匹配路径的
//!   祖先目录并入目录行）；
//! - **工作区根白名单**：`${workspace_root}` 占位符在装配期替换为
//!   设置页「工作区授权」的实际路径；检索前做沙箱前缀校验（越界
//!   拒绝，与 file_ops 端点同口径）；
//! - **互让手册**：grep=内容、glob=文件名/路径、file_query=文件状态
//!   与边界——三工具按分工互让，命中过多先收 glob/include 再查。
//!
//! 依赖纪律：本模块为纯逻辑（文件系统 + 检索过滤），不调用其它域
//! 模块；工具声明（approval=review、sandbox=file_root 等）由装配侧
//! 从 tools.json 读取。

use std::path::{Path, PathBuf};

use super::common::{resolve_non_strict, DomainError, WORKSPACE_ROOT_PLACEHOLDER};

/// 缺省结果条数上限（tools.json max_results 下限一致）。
pub const DEFAULT_MAX_RESULTS: usize = 100;

/// 单文件读取上限（字节；超限不读全文，命中行以阅读窗口截断）。
pub const MAX_READ_BYTES: usize = 1 << 20;

/// NUL 探针窗口（字节）：文件头该窗口内含 NUL 判定为二进制跳过。
/// 与 doc_ops 共用同一窗口口径（doc_ops 当前无 NUL 探针使用点；
/// 若批 6c 后 common.rs 可承载跨域常量，统一上移至 common）。
pub const NUL_PROBE_WINDOW: usize = 8192;

/// 命中文本行长展示上限（字符）。
pub const HIT_TEXT_MAX_CHARS: usize = 200;

/// 检索跳过目录（版本控制/依赖目录不进检索面）。
pub const SKIPPED_DIRS: [&str; 3] = [".git", "target", "node_modules"];

/// grep 检索请求（pattern 必填；glob/include 收窄；root 已授权沙箱）。
#[derive(Debug, Clone, PartialEq)]
pub struct GrepRequest {
    pub pattern: String,
    pub glob: Option<String>,
    pub include: Option<String>,
    pub max_results: usize,
    pub root: PathBuf,
}

/// 单命中（相对路径 + 行号 + 行文本截断）。
#[derive(Debug, Clone, PartialEq)]
pub struct GrepHit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// grep 结果（命中 + 截断标记 + 扫描文件数）。
#[derive(Debug, Clone, PartialEq)]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    pub scanned_files: usize,
}

/// glob 检索请求（pattern 必填；start = 检索起点，缺省工作区根）。
#[derive(Debug, Clone, PartialEq)]
pub struct GlobRequest {
    pub pattern: String,
    pub start: Option<PathBuf>,
    pub max_results: usize,
}

/// 单个路径条目（匹配文件/目录行；目录为祖先目录或命中的目录）。
#[derive(Debug, Clone, PartialEq)]
pub struct GlobEntry {
    pub path: String,
    pub kind: &'static str,
}

/// glob 结果（条目 + 截断标记；目录树 = 目录行 + 文件行的层次）。
#[derive(Debug, Clone, PartialEq)]
pub struct GlobResult {
    pub entries: Vec<GlobEntry>,
    pub truncated: bool,
}

/// 工作区根解析：声明值（endpoint_config.root 等）的 `${workspace_root}`
/// 占位符在装配期替换为授权根；声明为绝对路径则按声明显式使用。
pub fn resolve_workspace_root(declared: &str, authorized: &Path) -> PathBuf {
    let trimmed = declared.trim();
    if trimmed.is_empty() || trimmed == WORKSPACE_ROOT_PLACEHOLDER {
        resolve_non_strict(authorized)
    } else {
        resolve_non_strict(Path::new(trimmed))
    }
}

/// 沙箱前缀校验：target 的规范化路径位于 root 之内（越界拒绝）。
pub fn workspace_sandboxed(root: &Path, target: &Path) -> bool {
    let root = resolve_non_strict(root);
    let target = resolve_non_strict(target);
    target.starts_with(&root)
}

/// glob 模式编译（globset 语义；`**` 递归匹配）。
pub fn compile_glob(pattern: &str) -> Result<globset::GlobMatcher, DomainError> {
    globset::Glob::new(pattern)
        .map(|glob| glob.compile_matcher())
        .map_err(|err| DomainError::InvalidData(format!("glob 模式非法 {pattern:?}: {err}")))
}

/// 文件类型过滤（include：py/.py/*.py/*.pyi 形态归一；空 = 不过滤）。
fn include_matches(file_name: &str, include: &str) -> bool {
    let needle = include.trim().trim_start_matches('*').trim_start_matches('.').to_lowercase();
    if needle.is_empty() {
        return true;
    }
    let name = file_name.to_lowercase();
    name.ends_with(&format!(".{needle}")) || name == needle
}

/// 工作区内容检索（grep）：glob 限定路径 + 正则行匹配 + 类型过滤 +
/// 超限截断。
///
/// 只读、不进 .git/target/node_modules；二进制文件（前
/// [`NUL_PROBE_WINDOW`] 字节含 NUL）跳过；根目录须已授权（调用方从
/// 设置页授权根取 root）。
///
/// 读取形态（FA10）：按文件行缓冲流式读取——超体积上限的文件按
/// 元数据直接跳过（不读全文），限内文件逐行处理，内存占用随行长
/// 而非整文件体积。
pub fn run_grep(request: &GrepRequest) -> Result<GrepResult, DomainError> {
    use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

    let matcher = regex::Regex::new(&request.pattern).map_err(|err| {
        DomainError::InvalidData(format!("检索正则非法 {:?}: {err}", request.pattern))
    })?;
    let glob_matcher = request
        .glob
        .as_deref()
        .map(compile_glob)
        .transpose()?;
    let root = resolve_non_strict(&request.root);
    if !root.is_dir() {
        return Err(DomainError::InvalidData(format!(
            "工作区根不存在: {}",
            root.display()
        )));
    }
    let max_results = request.max_results.max(1);
    let mut hits: Vec<GrepHit> = Vec::new();
    let mut truncated = false;
    let mut scanned_files = 0usize;
    let walker = walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| !is_skipped_dir(entry));
    for entry in walker {
        let entry = entry.map_err(|err| DomainError::Other(format!("目录遍历失败: {err}")))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry.path().strip_prefix(&root).map_err(|err| {
            DomainError::Other(format!("路径剥离失败: {err}"))
        })?;
        if let Some(matcher) = &glob_matcher {
            if !matcher.is_match(rel) {
                continue;
            }
        }
        if let Some(include) = request.include.as_deref() {
            if !include_matches(&entry.file_name().to_string_lossy(), include) {
                continue;
            }
        }
        scanned_files += 1;
        // 超体积文件不读全文（元数据直接跳过，命中语义与旧实现一致）
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_READ_BYTES as u64 {
            truncated = true;
            continue;
        }
        let mut file = match std::fs::File::open(entry.path()) {
            Ok(file) => file,
            Err(_) => continue,
        };
        // NUL 探针：文件头 NUL_PROBE_WINDOW 字节含 NUL = 二进制跳过
        let mut probe = [0u8; NUL_PROBE_WINDOW];
        let probe_len = file.read(&mut probe).unwrap_or(0);
        if probe[..probe_len].contains(&0u8) {
            continue;
        }
        if let Err(err) = file.seek(SeekFrom::Start(0)) {
            eprintln!("[code_tools] grep seek_failed path={} err={err}", entry.path().display());
            continue;
        }
        let mut reader = BufReader::new(file);
        let mut line_buf: Vec<u8> = Vec::new();
        let mut line_no = 0usize;
        loop {
            line_buf.clear();
            let read = reader.read_until(b'\n', &mut line_buf).unwrap_or(0);
            if read == 0 {
                break;
            }
            line_no += 1;
            // 与旧实现一致：非法 UTF-8 行 lossy 化（行缓冲，不整文件载入）
            let raw = String::from_utf8_lossy(&line_buf);
            let line = raw.trim_end_matches(['\r', '\n']);
            if matcher.is_match(line) && !is_binary_line(line) {
                hits.push(GrepHit {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    line: line_no,
                    text: truncate_chars(line.trim(), HIT_TEXT_MAX_CHARS),
                });
                if hits.len() >= max_results {
                    truncated = true;
                    break;
                }
            }
        }
        if truncated {
            break;
        }
    }
    Ok(GrepResult {
        hits,
        truncated,
        scanned_files,
    })
}

fn is_binary_line(line: &str) -> bool {
    line.chars().take(64).any(|c| c == '\u{0}')
}

/// 遍历保留判定：目录树入口只剪枝跳过目录（.git/target/node_modules，
/// 其子树整体不进检索面），文件与普通目录正常放行。
fn is_skipped_dir(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return false;
    }
    SKIPPED_DIRS.contains(&entry.file_name().to_string_lossy().as_ref())
}

fn truncate_chars(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// 工作区路径递归匹配（glob）：模式匹配文件/目录 + 祖先目录树。
///
/// 结果条目 = 命中路径 + 命中的祖先目录（目录树形态，按路径排序，
/// 目录行唯一）；超限截断标记。
pub fn run_glob(request: &GlobRequest) -> Result<GlobResult, DomainError> {
    let matcher = compile_glob(&request.pattern)?;
    let start = resolve_non_strict(
        request
            .start
            .as_deref()
            .unwrap_or(Path::new(WORKSPACE_ROOT_PLACEHOLDER)),
    );
    if !start.is_dir() {
        return Err(DomainError::InvalidData(format!(
            "检索起点不存在: {}",
            start.display()
        )));
    }
    let max_results = request.max_results.max(1);
    let mut entries: Vec<GlobEntry> = Vec::new();
    let mut seen_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(&start)
        .into_iter()
        .filter_entry(|entry| !is_skipped_dir(entry));
    for entry in walker {
        let entry = entry.map_err(|err| DomainError::Other(format!("目录遍历失败: {err}")))?;
        if entry.depth() == 0 {
            continue;
        }
        let rel = entry.path().strip_prefix(&start).map_err(|err| {
            DomainError::Other(format!("路径剥离失败: {err}"))
        })?;
        let rel_text = rel.to_string_lossy().replace('\\', "/");
        if matcher.is_match(rel) {
            let kind = if entry.file_type().is_dir() { "dir" } else { "file" };
            entries.push(GlobEntry {
                path: rel_text.clone(),
                kind,
            });
            if kind == "file" {
                push_ancestor_dirs(&rel_text, &mut entries, &mut seen_dirs);
            }
            if entries.len() >= max_results {
                truncated = true;
                break;
            }
        }
    }
    Ok(GlobResult { entries, truncated })
}

/// 命中文件的祖先路径并入目录行（目录树形态；已在集合内跳过）。
fn push_ancestor_dirs(
    path: &str,
    entries: &mut Vec<GlobEntry>,
    seen_dirs: &mut std::collections::HashSet<String>,
) {
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    let mut prefix = String::new();
    for segment in segments {
        if prefix.is_empty() {
            prefix.push_str(segment);
        } else {
            prefix.push('/');
            prefix.push_str(segment);
        }
        if seen_dirs.insert(prefix.clone()) {
            entries.push(GlobEntry {
                path: prefix.clone(),
                kind: "dir",
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("inkling-code-tools-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(ws: &Path, rel: &str, content: &str) {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn fixture_workspace() -> (Scratch, PathBuf) {
        let ws = Scratch::new("workspace");
        write(&ws.0, "src/app.py", "print('hello grep')\ndef main():\n    pass\n");
        write(&ws.0, "src/lib/util.py", "# hello util\nimport os\nCONST = 'x'\n");
        write(&ws.0, "README.md", "# 项目说明\n说 hello 在这里\n");
        write(&ws.0, "data/notes.txt", "hello there\n");
        write(&ws.0, ".git/ignore.py", "hello in git dir\n");
        write(&ws.0, "target/gen.py", "hello in target\n");
        let root = ws.0.clone();
        (ws, root)
    }

    #[test]
    fn workspace_root_resolution_replaces_placeholder() {
        let authorized = PathBuf::from("C:/ws/authorized");
        assert_eq!(
            resolve_workspace_root(WORKSPACE_ROOT_PLACEHOLDER, &authorized),
            resolve_non_strict(&authorized)
        );
        assert_eq!(resolve_workspace_root("", &authorized), resolve_non_strict(&authorized));
        let explicit = resolve_workspace_root("D:/other/root", &authorized);
        assert!(explicit.to_string_lossy().contains("other"), "绝对路径按声明使用");
    }

    #[test]
    fn sandbox_prefix_check_bounds_targets() {
        let (ws, root) = fixture_workspace();
        let _keep = ws;
        assert!(workspace_sandboxed(&root, &root.join("src/app.py")));
        assert!(!workspace_sandboxed(&root, &root.join("../outside.txt")));
        assert!(!workspace_sandboxed(&root, &PathBuf::from("C:/Windows/system32")));
    }

    #[test]
    fn grep_matches_content_and_honors_glob() {
        let (_ws, root) = fixture_workspace();
        let request = GrepRequest {
            pattern: "hello".to_string(),
            glob: Some("**/*.py".to_string()),
            include: None,
            max_results: DEFAULT_MAX_RESULTS,
            root,
        };
        let result = run_grep(&request).expect("检索成功");
        assert_eq!(result.hits.len(), 2, "两个 py 命中（.git/target 被跳过）");
        assert!(!result.truncated);
        assert!(result.hits.iter().all(|h| h.path.ends_with(".py")));
        let positions: Vec<&String> = result.hits.iter().map(|h| &h.path).collect();
        assert!(positions.contains(&&"src/app.py".to_string()));
        assert!(positions.contains(&&"src/lib/util.py".to_string()));
        assert!(!positions.contains(&&".git/ignore.py".to_string()));
    }

    #[test]
    fn grep_filters_by_include_and_truncates() {
        let (_ws, root) = fixture_workspace();
        let md = GrepRequest {
            pattern: "hello".to_string(),
            glob: None,
            include: Some("md".to_string()),
            max_results: DEFAULT_MAX_RESULTS,
            root: root.clone(),
        };
        let result = run_grep(&md).expect("检索成功");
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].path, "README.md");
        let capped = GrepRequest {
            pattern: "hello".to_string(),
            glob: Some("**/*".to_string()),
            include: None,
            max_results: 1,
            root,
        };
        let result = run_grep(&capped).expect("检索成功");
        assert_eq!(result.hits.len(), 1);
        assert!(result.truncated, "超限截断标记");
    }

    #[test]
    fn grep_rejects_bad_pattern_and_missing_root() {
        let (_ws, root) = fixture_workspace();
        let bad = GrepRequest {
            pattern: "(".to_string(),
            glob: None,
            include: None,
            max_results: 10,
            root: root.clone(),
        };
        assert!(run_grep(&bad).is_err());
        let missing = GrepRequest {
            pattern: "x".to_string(),
            glob: None,
            include: None,
            max_results: 10,
            root: PathBuf::from("C:/nonexistent/inkling-nope"),
        };
        assert!(run_grep(&missing).is_err());
    }

    #[test]
    fn glob_matches_paths_and_builds_directory_tree() {
        let (_ws, root) = fixture_workspace();
        let request = GlobRequest {
            pattern: "**/*.py".to_string(),
            start: Some(root),
            max_results: DEFAULT_MAX_RESULTS,
        };
        let result = run_glob(&request).expect("glob 成功");
        let files: Vec<&str> = result
            .entries
            .iter()
            .filter(|e| e.kind == "file")
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(files.len(), 2, ".git/target 被跳过: {files:?}");
        assert!(files.contains(&"src/app.py"));
        assert!(files.contains(&"src/lib/util.py"));
        let dirs: Vec<&str> = result
            .entries
            .iter()
            .filter(|e| e.kind == "dir")
            .map(|e| e.path.as_str())
            .collect();
        assert!(dirs.contains(&"src"), "目录树含 src");
        assert!(dirs.contains(&"src/lib"), "目录树含 src/lib");
        assert!(!result.truncated);
    }

    #[test]
    fn glob_respects_start_and_truncation() {
        let (_ws, root) = fixture_workspace();
        let subtree = GlobRequest {
            pattern: "**/*.py".to_string(),
            start: Some(root.join("src")),
            max_results: DEFAULT_MAX_RESULTS,
        };
        let result = run_glob(&subtree).expect("子树 glob 成功");
        let files: Vec<&str> = result.entries.iter().filter(|e| e.kind == "file").map(|e| e.path.as_str()).collect();
        assert_eq!(files.len(), 2);
        let capped = GlobRequest {
            pattern: "**".to_string(),
            start: Some(root),
            max_results: 1,
        };
        let result = run_glob(&capped).expect("截断 glob 成功");
        assert_eq!(result.entries.len(), 1);
        assert!(result.truncated);
    }

    #[test]
    fn grep_skips_oversized_and_binary_files() {
        // FA10 回归：超体积文件按元数据跳过（不读全文），二进制（NUL）
        // 文件跳过——行缓冲读取保持与旧语义一致
        let (_ws, root) = fixture_workspace();
        let big_path = root.join("big.bin");
        std::fs::write(&big_path, vec![b'x'; MAX_READ_BYTES + 16]).unwrap();
        let bin_path = root.join("blob.dat");
        std::fs::write(&bin_path, [b'a', 0u8, b'b', b'c']).unwrap();
        let request = GrepRequest {
            pattern: "x".to_string(),
            glob: Some("**/*".to_string()),
            include: None,
            max_results: DEFAULT_MAX_RESULTS,
            root,
        };
        let result = run_grep(&request).expect("检索成功");
        assert!(result.truncated, "超体积文件命中截断标记");
        assert!(result.hits.iter().all(|h| h.path != "big.bin"), "超体积文件不产出命中");
        assert!(result.hits.iter().all(|h| h.path != "blob.dat"), "二进制文件不产出命中");
    }
}

//! 既有资料批量导入（搬进 InKling 第一步）：目录扫描 + 格式归一 + 入料前收口。
//!
//! 职责边界：本模块只做「本地只读扫描 + 结构化归一」（复用 [`crate::domain::doc_ops`]
//! 既有一键解析），并把产物交回调用方走既有样例闸门/知识集入料链（引擎侧
//! `patch.propose_knowledge`）。模块不直连引擎——入料经调用方经引擎操作通道，
//! 保证闸门单一事实源在引擎侧。
//!
//! 沙箱收口（fail-closed）：扫描根须落在 [`MATERIAL_ROOTS`] 内（用户主目录域），
//! 递归深度 / 文件数 / 单文件体积三道硬上限，越界即结构化拒绝，不静默降级。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 允许导入的根（用户主目录域；`~` = 整主目录，覆盖工作区/附件挂载根）。
pub const MATERIAL_ROOTS: &[&str] = &["~/.inkling/workspace", "~/.inkling/attachments", "~"];

/// 递归扫描最大深度（相对扫描根）。
pub const MATERIAL_SCAN_MAX_DEPTH: usize = 6;

/// 单次扫描文件数硬上限（防滥用；超出截断并标注）。
pub const MATERIAL_SCAN_MAX_FILES: usize = 2000;

/// 单文件体积上限（字节；超出跳过）。
pub const MATERIAL_FILE_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// 文档格式（走 [`crate::domain::doc_ops::parse_document`] 归一）。
pub const MATERIAL_DOC_EXTS: &[&str] = &["pdf", "docx", "xlsx", "pptx"];

/// 纯文本格式（直接读 UTF-8 归一，避免引入解析依赖）。
pub const MATERIAL_TEXT_EXTS: &[&str] = &["txt", "md", "markdown", "json", "csv", "log"];

/// 单条归一结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialFile {
    /// 绝对路径。
    pub path: String,
    /// 归一后格式标识（doc/pdf/xlsx/pptx/txt/md/json/csv/log）。
    pub format: String,
    /// 字节体积。
    pub size: u64,
    /// 结构化内容（doc_ops 产物或纯文本包裹）。
    pub normalized: serde_json::Value,
}

/// 跳过项（UnsupportedFormat / TooLarge / 超扫描上限）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialSkipped {
    pub path: String,
    pub reason: String,
}

/// 扫描归一结果（交给调用方走闸门入料）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaterialScanResult {
    pub root: String,
    pub recursive: bool,
    pub scanned: usize,
    pub files: Vec<MaterialFile>,
    pub skipped: Vec<MaterialSkipped>,
}

/// 主入口：扫描根目录并归一其下既有资料。
pub fn scan_and_normalize(root: &str, recursive: bool) -> Result<MaterialScanResult, String> {
    let root_path = expand_home(root)?;
    if !root_path.is_dir() {
        return Err(format!("导入路径不是目录或不存在: {root}"));
    }
    if !is_within_roots(&root_path) {
        return Err(format!("路径不在允许导入根内（仅限用户主目录域）: {root}"));
    }
    let mut result = MaterialScanResult {
        root: root_path.to_string_lossy().to_string(),
        recursive,
        scanned: 0,
        files: Vec::new(),
        skipped: Vec::new(),
    };
    walk(&root_path, 0, recursive, &mut result)?;
    eprintln!(
        "[import_material] scan root={} recursive={} scanned={} files={} skipped={}",
        result.root,
        result.recursive,
        result.scanned,
        result.files.len(),
        result.skipped.len()
    );
    Ok(result)
}

fn walk(
    dir: &Path,
    depth: usize,
    recursive: bool,
    result: &mut MaterialScanResult,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|err| format!("读取目录失败 {}: {err}", dir.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            // FA19：符号链接显式记 skipped，不跟随——跟随可能越出扫描根
            // （链接指向沙箱外），静默跳过会让用户误以为文件已入料
            result.skipped.push(MaterialSkipped {
                path: path.to_string_lossy().to_string(),
                reason: "符号链接不跟随（防越出沙箱根）".to_string(),
            });
            continue;
        }
        if file_type.is_dir() {
            if recursive && depth + 1 <= MATERIAL_SCAN_MAX_DEPTH {
                walk(&path, depth + 1, recursive, result)?;
            }
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        if result.files.len() >= MATERIAL_SCAN_MAX_FILES {
            result.skipped.push(MaterialSkipped {
                path: path.to_string_lossy().to_string(),
                reason: format!("超过单次扫描上限 {MATERIAL_SCAN_MAX_FILES} 件"),
            });
            continue;
        }
        result.scanned += 1;
        match normalize_file(&path) {
            Ok(file) => result.files.push(file),
            Err(skip) => result.skipped.push(skip),
        }
    }
    Ok(())
}

fn normalize_file(path: &Path) -> Result<MaterialFile, MaterialSkipped> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    let size = std::fs::metadata(path)
        .map(|m| m.len())
        .unwrap_or(0);
    if size > MATERIAL_FILE_MAX_BYTES {
        return Err(MaterialSkipped {
            path: path.to_string_lossy().to_string(),
            reason: format!("单文件超体积上限 {MATERIAL_FILE_MAX_BYTES} 字节"),
        });
    }
    if MATERIAL_DOC_EXTS.contains(&ext.as_str()) {
        let bytes = std::fs::read(path).map_err(|err| MaterialSkipped {
            path: path.to_string_lossy().to_string(),
            reason: format!("读取失败: {err}"),
        })?;
        return match crate::domain::doc_ops::parse_document(&bytes) {
            Ok(normalized) => Ok(MaterialFile {
                path: path.to_string_lossy().to_string(),
                format: ext,
                size,
                normalized,
            }),
            Err(err) => Err(MaterialSkipped {
                path: path.to_string_lossy().to_string(),
                reason: format!("格式解析失败: {err}"),
            }),
        };
    }
    if MATERIAL_TEXT_EXTS.contains(&ext.as_str()) {
        let text = std::fs::read_to_string(path).map_err(|err| MaterialSkipped {
            path: path.to_string_lossy().to_string(),
            reason: format!("文本读取失败: {err}"),
        })?;
        return Ok(MaterialFile {
            path: path.to_string_lossy().to_string(),
            format: ext.clone(),
            size,
            normalized: serde_json::json!({ "format": ext, "text": text }),
        });
    }
    Err(MaterialSkipped {
        path: path.to_string_lossy().to_string(),
        reason: format!("不支持的格式: {ext}"),
    })
}

fn expand_home(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    let expanded = if trimmed == "~" || trimmed.starts_with("~/") {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "无法解析用户主目录".to_string())?;
        if trimmed == "~" {
            PathBuf::from(home)
        } else {
            PathBuf::from(home).join(&trimmed[2..])
        }
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(format!("路径须为绝对路径: {path}"));
    }
    Ok(expanded)
}

fn is_within_roots(target: &Path) -> bool {
    MATERIAL_ROOTS.iter().any(|root| match expand_home(root) {
        Ok(root_path) => target.starts_with(&root_path),
        Err(_) => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_temp_file(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).expect("写入临时文件");
        path
    }

    #[test]
    fn scan_collects_supported_files_and_skips_others() {
        let base = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        let dir = std::path::Path::new(&base).join("ink_material_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        write_temp_file(&dir, "note.md", "# 标题\n正文");
        write_temp_file(&dir, "data.json", "{\"a\":1}");
        write_temp_file(&dir, "ignore.bin", "binary");

        let result = scan_and_normalize(dir.to_str().unwrap(), false).expect("扫描应成功");
        assert_eq!(result.files.len(), 2, "md+json 应被归一，bin 跳过");
        assert_eq!(result.skipped.len(), 1);
        assert!(result.files.iter().any(|f| f.format == "md"));
        assert!(result.files.iter().any(|f| f.format == "json"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_rejects_path_outside_allowed_roots() {
        // 用户主目录域外的系统目录（即便不存在也须被沙箱拒绝）：
        // Windows 下 C:\Windows 不在 ~/ 内；其他平台该路径非绝对/不存在同样 Err。
        let err = scan_and_normalize("C:\\Windows", false);
        assert!(err.is_err(), "主目录域外路径应被沙箱拒绝");
    }

    #[cfg(windows)]
    #[test]
    fn scan_records_symlinks_as_skipped() {
        // FA19：符号链接显式记 skipped（不跟随防越出沙箱根），
        // 不再静默忽略；无符号链接权限（未开开发者模式）时跳过场景。
        let base = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        let dir = std::path::Path::new(&base).join("ink_material_symlink_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        write_temp_file(&dir, "real.md", "# 正文");
        let link = dir.join("alias.md");
        let linked = std::fs::canonicalize(dir.join("real.md")).unwrap();
        if std::os::windows::fs::symlink_file(&linked, &link).is_err() {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let result = scan_and_normalize(dir.to_str().unwrap(), false).expect("扫描应成功");
        assert_eq!(result.files.len(), 1, "仅真实文件被归一");
        assert_eq!(result.skipped.len(), 1);
        assert!(
            result.skipped[0].reason.contains("符号链接"),
            "符号链接显式记 skipped: {}",
            result.skipped[0].reason
        );
        assert!(
            result.skipped[0].path.contains("alias.md"),
            "跳过项携带链接路径"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

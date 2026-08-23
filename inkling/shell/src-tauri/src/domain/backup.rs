//! backup 域：导出/恢复——一键导出（data_dir 打包：sqlite + md +
//! 补丁链快照形态，单文件）、恢复向导（选包 → 校验 → 重建预览 →
//! 执行）、恢复前当前态快照（防误恢复）。
//!
//! 打包格式（自定义容器，随包无第三方压缩依赖）：魔数 + 版本 +
//! JSON 清单（条目 = 路径/大小/sha256）+ 长度前导数帧；清单先行，
//! 恢复前即校验（哈希逐条核对，坏包拒绝恢复）。`compression`
//! 字段当前为 `stored`（预设压缩位：数据块层面支持升级为紧凑
//! 编码，同一容器形态不破坏既有包）。
//!
//! 引擎存储契约（snapshot/restore）经 op 通道调用：引擎侧存储快照
//! 落在受控路径后，宿主以本模块容器打包/校验；未注册 op 显式声明。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎交互经
//! [`crate::engine::host::call_engine_op_async`] 操作通道。

use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use super::common::DomainError;
use crate::engine::host::call_engine_op_async;

/// 备份容器魔数（16 字节；版本化可在同文件头演进）。
pub const BACKUP_MAGIC: [u8; 16] = *b"INKLING-BACKUP\x01\0";

/// 备份容器版本（清单格式版本）。
pub const BACKUP_FORMAT_VERSION: u32 = 1;

/// 当前数据块压缩形态（stored = 原样；预设压缩位）。
pub const BACKUP_COMPRESSION: &str = "stored";

/// 恢复前当前态快照目录名前缀。
pub const PRE_RESTORE_SNAPSHOT_PREFIX: &str = "pre-restore-";

/// 清单条目（单文件：相对路径 + 大小 + sha256）。
#[derive(Debug, Clone, PartialEq)]
pub struct BackupEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// 备份清单（容器头部 JSON；文件列表 + 元信息）。
#[derive(Debug, Clone, PartialEq)]
pub struct BackupManifest {
    pub format: u32,
    pub created_at: f64,
    pub compression: String,
    pub engine_snapshot: bool,
    pub entries: Vec<BackupEntry>,
}

/// 恢复预览（重建预览：覆盖计数/总大小/数据库在包内）。
#[derive(Debug, Clone, PartialEq)]
pub struct RestorePreview {
    pub entries_total: usize,
    pub will_overwrite: usize,
    pub total_size: u64,
    pub has_db: bool,
}

fn sha256_bytes(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn manifest_json(manifest: &BackupManifest) -> Vec<u8> {
    serde_json::json!({
        "format": manifest.format,
        "created_at": manifest.created_at,
        "compression": manifest.compression,
        "engine_snapshot": manifest.engine_snapshot,
        "entries": manifest.entries.iter().map(|entry| serde_json::json!({
            "path": entry.path,
            "size": entry.size,
            "sha256": entry.sha256,
        })).collect::<Vec<_>>(),
    })
    .to_string()
    .into_bytes()
}

fn parse_manifest(bytes: &[u8]) -> Result<BackupManifest, DomainError> {
    let value: JsonValue = serde_json::from_slice(bytes)
        .map_err(|err| DomainError::InvalidData(format!("备份清单 JSON 非法: {err}")))?;
    let entries = value
        .get("entries")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    Some(BackupEntry {
                        path: entry.get("path")?.as_str()?.to_string(),
                        size: entry.get("size").and_then(JsonValue::as_u64)?,
                        sha256: entry.get("sha256")?.as_str()?.to_string(),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(BackupManifest {
        format: value.get("format").and_then(JsonValue::as_u64).unwrap_or(0) as u32,
        created_at: value.get("created_at").and_then(JsonValue::as_f64).unwrap_or(0.0),
        compression: value
            .get("compression")
            .and_then(JsonValue::as_str)
            .unwrap_or("stored")
            .to_string(),
        engine_snapshot: value
            .get("engine_snapshot")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
        entries,
    })
}

// ── 导出 ──

/// 一键导出：data_dir 递归打包 → 单文件容器（sqlite + md + 补丁链
/// 快照形态 = 数据目录全部运行数据；顺序确定，可复现导出）。
pub fn pack_data_dir(data_dir: &Path, dest: &Path) -> Result<BackupManifest, DomainError> {
    if !data_dir.is_dir() {
        return Err(DomainError::InvalidData(format!(
            "数据目录不存在: {}",
            data_dir.display()
        )));
    }
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in walkdir::WalkDir::new(data_dir) {
        let entry = entry.map_err(|err| DomainError::Storage(format!("数据目录遍历失败: {err}")))?;
        if entry.file_type().is_file() {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    let mut entries: Vec<BackupEntry> = Vec::new();
    let mut has_db = false;
    let mut frames: Vec<(String, Vec<u8>)> = Vec::new();
    for path in files {
        let rel = path
            .strip_prefix(data_dir)
            .map_err(|err| DomainError::Storage(format!("路径剥离失败: {err}")))?
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        let data = std::fs::read(&path)
            .map_err(|err| DomainError::Storage(format!("读取失败 {}: {err}", path.display())))?;
        if rel.ends_with(".sqlite") || rel.ends_with(".db") {
            has_db = true;
        }
        entries.push(BackupEntry {
            path: rel.clone(),
            size: data.len() as u64,
            sha256: sha256_bytes(&data),
        });
        frames.push((rel, data));
    }
    let manifest = BackupManifest {
        format: BACKUP_FORMAT_VERSION,
        created_at: now_epoch(),
        compression: BACKUP_COMPRESSION.to_string(),
        engine_snapshot: has_db,
        entries: entries.clone(),
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| DomainError::Storage(format!("备份目录创建失败: {err}")))?;
    }
    let manifest_bytes = manifest_json(&manifest);
    let mut output = Vec::new();
    output.extend_from_slice(&BACKUP_MAGIC);
    output.extend_from_slice(&BACKUP_FORMAT_VERSION.to_le_bytes());
    output.extend_from_slice(&(manifest_bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(&manifest_bytes);
    for (path, data) in frames {
        let path_bytes = path.as_bytes();
        output.extend_from_slice(&(path_bytes.len() as u32).to_le_bytes());
        output.extend_from_slice(path_bytes);
        output.extend_from_slice(&(data.len() as u64).to_le_bytes());
        output.extend_from_slice(&data);
    }
    std::fs::write(dest, &output)
        .map_err(|err| DomainError::Storage(format!("备份落盘失败 {}: {err}", dest.display())))?;
    Ok(manifest)
}

// ── 校验 ──

struct BackupReader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> BackupReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), DomainError> {
        if self.offset + buf.len() > self.bytes.len() {
            return Err(DomainError::InvalidData("备份容器截断（读取越过末尾）".to_string()));
        }
        buf.copy_from_slice(&self.bytes[self.offset..self.offset + buf.len()]);
        self.offset += buf.len();
        Ok(())
    }

    fn read_u32(&mut self) -> Result<u32, DomainError> {
        let mut buf = [0u8; 4];
        self.read_exact(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    }

    fn read_u64(&mut self) -> Result<u64, DomainError> {
        let mut buf = [0u8; 8];
        self.read_exact(&mut buf)?;
        Ok(u64::from_le_bytes(buf))
    }
}

/// 选包校验：容器头 + 清单 + 逐条目哈希核对（坏包拒绝恢复）。
///
/// 校验通过才进入恢复向导（fail-closed：任何一条哈希不符 = 整包
/// 拒绝，不部分恢复）。
pub fn validate_backup(path: &Path) -> Result<BackupManifest, DomainError> {
    let bytes = std::fs::read(path)
        .map_err(|err| DomainError::Storage(format!("备份读取失败 {}: {err}", path.display())))?;
    if bytes.len() < BACKUP_MAGIC.len() + 8 {
        return Err(DomainError::InvalidData("非 InKling 备份包（文件过短，魔数不符）".to_string()));
    }
    let mut reader = BackupReader::new(&bytes);
    let mut magic = [0u8; 16];
    reader.read_exact(&mut magic)?;
    if magic != BACKUP_MAGIC {
        return Err(DomainError::InvalidData("非 InKling 备份包（魔数不符）".to_string()));
    }
    let version = reader.read_u32()?;
    if version != BACKUP_FORMAT_VERSION {
        return Err(DomainError::InvalidData(format!(
            "备份版本不兼容: {version}（预期 {BACKUP_FORMAT_VERSION}）"
        )));
    }
    let manifest_len = reader.read_u32()? as usize;
    let mut manifest_bytes = vec![0u8; manifest_len];
    reader.read_exact(&mut manifest_bytes)?;
    let manifest = parse_manifest(&manifest_bytes)?;
    if manifest.format != version {
        return Err(DomainError::InvalidData("清单格式与容器版本不一致".to_string()));
    }
    for entry in &manifest.entries {
        let path_len = reader.read_u32()? as usize;
        let mut path_bytes = vec![0u8; path_len];
        reader.read_exact(&mut path_bytes)?;
        let path_text = String::from_utf8(path_bytes)
            .map_err(|_| DomainError::InvalidData("条目路径非 UTF-8".to_string()))?;
        if path_text != entry.path {
            return Err(DomainError::InvalidData(format!(
                "条目路径与清单不一致: {path_text:?}"
            )));
        }
        let data_len = reader.read_u64()?;
        if data_len != entry.size {
            return Err(DomainError::InvalidData(format!(
                "条目大小与清单不一致: {}",
                entry.path
            )));
        }
        let mut data = vec![0u8; data_len as usize];
        reader.read_exact(&mut data)?;
        if sha256_bytes(&data) != entry.sha256 {
            return Err(DomainError::InvalidData(format!(
                "条目哈希未通过: {}",
                entry.path
            )));
        }
    }
    Ok(manifest)
}

// ── 恢复向导 ──

/// 恢复向导第一步：选包 → 校验（返回清单供预览）。
pub fn restore_wizard_select(path: &Path) -> Result<BackupManifest, DomainError> {
    validate_backup(path)
}

/// 恢复预览：清单 × 当前数据目录 → 覆盖计数/体积/包内数据库标记。
pub fn preview_restore(manifest: &BackupManifest, target_dir: &Path) -> RestorePreview {
    let mut will_overwrite = 0usize;
    for entry in &manifest.entries {
        let target = Path::new(&entry.path);
        if target_dir.join(target).exists() {
            will_overwrite += 1;
        }
    }
    RestorePreview {
        entries_total: manifest.entries.len(),
        will_overwrite,
        total_size: manifest.entries.iter().map(|entry| entry.size).sum(),
        has_db: manifest.engine_snapshot,
    }
}

/// 恢复前当前态快照（防误恢复：数据目录 → 快照目录副本）。
///
/// 快照目录 = `<snapshots_dir>/pre-restore-<时间戳>/`；恢复失败/误
/// 恢复时以快照原位回滚。
pub fn snapshot_current_state(
    data_dir: &Path,
    snapshots_dir: &Path,
) -> Result<PathBuf, DomainError> {
    // 数据目录未落盘（首次恢复前）也允许快照：创建空目录后快照
    // 空态——恢复前快照是防误恢复的护栏，不是恢复的前提。
    if !data_dir.is_dir() {
        std::fs::create_dir_all(data_dir)
            .map_err(|err| DomainError::Storage(format!("数据目录创建失败: {err}")))?;
    }
    let stamp = format!("{}{}", PRE_RESTORE_SNAPSHOT_PREFIX, now_epoch());
    let snapshot_dir = snapshots_dir.join(stamp);
    std::fs::create_dir_all(&snapshot_dir)
        .map_err(|err| DomainError::Storage(format!("快照目录创建失败: {err}")))?;
    for entry in walkdir::WalkDir::new(data_dir) {
        let entry = entry
            .map_err(|err| DomainError::Storage(format!("快照遍历失败: {err}")))?;
        if entry.file_type().is_file() {
            let rel = entry.path().strip_prefix(data_dir).map_err(|err| {
                DomainError::Storage(format!("快照路径剥离失败: {err}"))
            })?;
            let dest = snapshot_dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| DomainError::Storage(format!("快照子目录失败: {err}")))?;
            }
            std::fs::copy(entry.path(), &dest)
                .map_err(|err| DomainError::Storage(format!("快照拷贝失败: {err}")))?;
        }
    }
    Ok(snapshot_dir)
}

/// 路径穿越防护：条目路径须为相对路径（无绝对/盘符/.. 片段）。
fn path_within_target(rel: &str) -> bool {
    if Path::new(rel).is_absolute() {
        return false;
    }
    !Path::new(rel)
        .components()
        .any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
}

/// 执行恢复（校验 → 当前态快照 → 解包落位）。
///
/// 失败即中止（快照已留——可回滚），不部分恢复（半恢复态直接
/// 拒绝返回，快照目录地址随错误信息给出）。
pub fn execute_restore(
    backup_path: &Path,
    target_dir: &Path,
    snapshots_dir: &Path,
) -> Result<(RestorePreview, PathBuf), DomainError> {
    let manifest = restore_wizard_select(backup_path)?;
    let preview = preview_restore(&manifest, target_dir);
    let snapshot = snapshot_current_state(target_dir, snapshots_dir)?;
    std::fs::create_dir_all(target_dir)
        .map_err(|err| DomainError::Storage(format!("恢复目标目录创建失败: {err}")))?;
    let bytes = std::fs::read(backup_path)
        .map_err(|err| DomainError::Storage(format!("备份读取失败: {err}")))?;
    let mut reader = BackupReader::new(&bytes);
    let mut magic = [0u8; 16];
    reader.read_exact(&mut magic)?;
    let _ = reader.read_u32()?;
    let manifest_len = reader.read_u32()? as usize;
    let mut manifest_bytes = vec![0u8; manifest_len];
    reader.read_exact(&mut manifest_bytes)?;
    let manifest = parse_manifest(&manifest_bytes)?;
    for entry in &manifest.entries {
        let path_len = reader.read_u32()? as usize;
        let mut path_bytes = vec![0u8; path_len];
        reader.read_exact(&mut path_bytes)?;
        let path_text = String::from_utf8(path_bytes)
            .map_err(|_| DomainError::InvalidData("条目路径非 UTF-8".to_string()))?;
        let data_len = reader.read_u64()?;
        let mut data = vec![0u8; data_len as usize];
        reader.read_exact(&mut data)?;
        if path_text != entry.path || sha256_bytes(&data) != entry.sha256 {
            return Err(DomainError::InvalidData(format!(
                "恢复前校验未通过: {}（当前态快照已留于 {}）",
                entry.path,
                snapshot.display()
            )));
        }
        if !path_within_target(&path_text) {
            return Err(DomainError::InvalidData(format!(
                "恢复条目路径越界（拒绝）: {path_text:?}"
            )));
        }
        let dest = target_dir.join(&path_text);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| DomainError::Storage(format!("恢复子目录失败: {err}")))?;
        }
        std::fs::write(&dest, &data).map_err(|err| {
            DomainError::Storage(format!("恢复写入失败 {}: {err}", dest.display()))
        })?;
    }
    Ok((preview, snapshot))
}

// ── 引擎存储契约（op 通道；未注册 op 显式声明）──

/// 引擎存储快照（引擎侧 storage.snapshot 的薄包装；sqlite 后端
/// backup API 一致性快照）。
///
/// 需 op: engine.storage_snapshot（引擎存储快照待注册；未注册返回
/// 结构化错误，本地文件打包路径不依赖它——引擎快照是补丁链完整
/// 性的增强形态）。
pub async fn engine_storage_snapshot(dest: &str) -> Result<(), String> {
    let outcome = call_engine_op_async(
        "engine.storage_snapshot",
        serde_json::json!({ "dest": dest }),
    )
    .await;
    match outcome {
        Ok(_) => Ok(()),
        Err(err) => Err(format!(
            "需 op: engine.storage_snapshot —— 引擎存储快照经操作通道待注册（{err}）"
        )),
    }
}

/// 引擎存储恢复（引擎侧 storage.restore 的薄包装）。
///
/// 需 op: engine.storage_restore（引擎存储恢复待注册；恢复执行由
/// 宿主向导先经本地容器校验后调用，未注册时由本地解包覆盖）。
pub async fn engine_storage_restore(src: &str) -> Result<(), String> {
    let outcome = call_engine_op_async(
        "engine.storage_restore",
        serde_json::json!({ "src": src }),
    )
    .await;
    match outcome {
        Ok(_) => Ok(()),
        Err(err) => Err(format!(
            "需 op: engine.storage_restore —— 引擎存储恢复经操作通道待注册（{err}）"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("inkling-backup-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(ws: &Path, rel: &str, content: &[u8]) {
        let path = ws.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn fixture_data_dir() -> (Scratch, PathBuf) {
        let ws = Scratch::new("data");
        write(&ws.0, "inkling.sqlite", b"sqlite-file-bytes-\x00\x01");
        write(&ws.0, "memory/main.md", "## 笔记\n内容\n".as_bytes());
        write(&ws.0, "envs/local/cfg.yaml", "runtime: local\n".as_bytes());
        write(&ws.0, "artifacts/service-abc/file.txt", b"artifact-content");
        let data = ws.0.clone();
        (ws, data)
    }

    #[test]
    fn pack_validate_roundtrip_and_manifest() {
        let (ws, data_dir) = fixture_data_dir();
        let backup = ws.0.join("out.inkb");
        let manifest = pack_data_dir(&data_dir, &backup).expect("导出成功");
        assert_eq!(manifest.entries.len(), 4);
        assert!(manifest.engine_snapshot, "sqlite 在包内");
        assert_eq!(manifest.compression, "stored");
        let revalidated = validate_backup(&backup).expect("校验通过");
        assert_eq!(revalidated, manifest);
    }

    #[test]
    fn validate_rejects_tampered_and_foreign_files() {
        let (ws, data_dir) = fixture_data_dir();
        let backup = ws.0.join("out.inkb");
        pack_data_dir(&data_dir, &backup).expect("导出成功");
        // 篡改内容 → 哈希不符拒绝
        let tampered = ws.0.join("tampered.inkb");
        let raw = std::fs::read(&backup).unwrap();
        let mut bytes = raw.clone();
        let last = bytes.len() - 10;
        bytes[last] ^= 0xFF;
        std::fs::write(&tampered, &bytes).unwrap();
        let err = validate_backup(&tampered).unwrap_err();
        assert!(err.to_string().contains("哈希") || err.to_string().contains("未通过"), "{err}");
        // 非备份文件拒绝
        let foreign = ws.0.join("foreign.bin");
        std::fs::write(&foreign, b"not a backup").unwrap();
        let err = validate_backup(&foreign).unwrap_err();
        assert!(err.to_string().contains("魔数"));
        // 截断拒绝
        let truncated = ws.0.join("truncated.inkb");
        std::fs::write(&truncated, &raw[..raw.len() / 2]).unwrap();
        assert!(validate_backup(&truncated).is_err());
        let _ = tampered;
    }

    #[test]
    fn restore_unpacks_and_snapshots_current_state() {
        let (ws, data_dir) = fixture_data_dir();
        let backup = ws.0.join("out.inkb");
        pack_data_dir(&data_dir, &backup).expect("导出成功");
        let restored = ws.0.join("restored");
        let preview = preview_restore(&validate_backup(&backup).unwrap(), &restored);
        assert_eq!(preview.entries_total, 4);
        assert_eq!(preview.will_overwrite, 0);
        assert!(preview.has_db);
        let (preview, snapshot) =
            execute_restore(&backup, &restored, &ws.0.join("snapshots")).expect("恢复成功");
        assert_eq!(preview.entries_total, 4);
        assert!(snapshot.exists(), "当前态快照已留");
        let restored_sqlite = std::fs::read(restored.join("inkling.sqlite")).unwrap();
        assert_eq!(restored_sqlite, b"sqlite-file-bytes-\x00\x01");
        let restored_md = std::fs::read_to_string(restored.join("memory/main.md")).unwrap();
        assert!(restored_md.contains("笔记"));
        assert!(restored.join("envs/local/cfg.yaml").is_file());
    }

    #[test]
    fn restore_preview_counts_overwrites() {
        let (ws, data_dir) = fixture_data_dir();
        let backup = ws.0.join("out.inkb");
        pack_data_dir(&data_dir, &backup).expect("导出成功");
        let manifest = validate_backup(&backup).unwrap();
        let existing = ws.0.join("existing");
        write(&existing, "memory/main.md", "旧内容".as_bytes());
        let preview = preview_restore(&manifest, &existing);
        assert_eq!(preview.will_overwrite, 1);
        assert!(preview.total_size > 0);
    }

    #[test]
    fn restore_rejects_path_traversal_entries() {
        assert!(!path_within_target("../evil.txt"));
        assert!(!path_within_target("a/../../b"));
        assert!(!path_within_target("C:/evil.txt"));
        assert!(path_within_target("memory/main.md"));
        assert!(path_within_target("a/b/c.txt"));
    }

    #[test]
    fn engine_snapshot_ops_declare_unregistered_channel() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(engine_storage_snapshot("C:/tmp/x.sqlite"));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("需 op"));
    }
}

//! recovery 域：崩溃回退栈（红线二）的启动侧编排——
//! 启动状态跟踪（连续失败计数 → 自动安全模式）、启动快照轮换
//! （N 份绑定链版本）、一键回落（回到上一稳定版本 / 出厂重置）。
//!
//! 崩溃回退的观测面（`boot_state.json` + `startup_snapshots/`）为文件
//! 系统形态，独立于引擎存储：引擎起不来（崩溃循环）时仍可读写，恢复
//! 动作不依赖引擎可用。引擎存储快照/恢复本身走既有 op 通道（存储
//! 契约 snapshot/restore，sqlite backup API 实现）；本模块只编排落位
//! 与轮换。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎交互经
//! [`crate::engine::host::call_engine_op_async`] 操作通道（编排发生在
//! 壳装配层，见 [`crate::lib`] 装配入口）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::common::DomainError;

/// 启动状态文件名（数据目录根；引擎不可用时仍可读写）。
pub const BOOT_STATE_FILE: &str = "boot_state.json";

/// 启动快照目录名（数据目录根下）。
pub const STARTUP_SNAPSHOTS_DIR: &str = "startup_snapshots";

/// 启动快照轮换保留份数（N 份，绑定链版本；超出按新旧淘汰最旧）。
pub const SNAPSHOT_KEEP: usize = 5;

/// 连续启动失败阈值：达到即自动转入安全模式（出厂基线启动）。
pub const CRASH_LOOP_THRESHOLD: u32 = 3;

/// 启动状态（数据目录根 boot_state.json；缺文件/坏 JSON = 默认态）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BootState {
    /// 连续启动失败计数（成功启动归零）。
    pub consecutive_failures: u32,
    /// 安全模式：链内容（自写资产载体）不参与装配，出厂基线启动。
    pub safe_mode: bool,
    /// 最近一次启动时间（毫秒精度 epoch）。
    pub last_boot_at: f64,
}

impl Default for BootState {
    fn default() -> Self {
        Self {
            consecutive_failures: 0,
            safe_mode: false,
            last_boot_at: 0.0,
        }
    }
}

/// 启动快照元信息（版本绑定 + 时间序；轮换/列表的观测形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotMeta {
    /// 版本化文件名（chain-v{版本}-{时间戳}-{随机}.sqlite）。
    pub name: String,
    /// 快照完整路径。
    pub path: PathBuf,
    /// 快照时补丁链版本（版本 = 补丁数 + 1；绑定链版本号）。
    pub chain_version: i64,
    /// 快照时间（毫秒精度 epoch）。
    pub created_at: f64,
}

fn now_epoch_ms() -> f64 {
    // 整数毫秒（JSON 往返恒等：浮点秒级会有末位 ulp 偏差，整数值
    // 精确往返；产品语义 = 时间戳排序/展示，毫秒精度足够）
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

// ── 启动状态 ──

/// 读取启动状态（缺文件/坏 JSON = 默认态：崩溃计数归零、非安全模式——
/// 观测文件损坏不得把正常启动误判为崩溃循环）。
pub fn load_boot_state(data_dir: &Path) -> BootState {
    let path = data_dir.join(BOOT_STATE_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<BootState>(&text).ok())
        .unwrap_or_default()
}

/// 持久化启动状态（原子写：临时文件 + 改名落位）。
fn save_boot_state(data_dir: &Path, state: &BootState) -> Result<(), DomainError> {
    let dir = data_dir.to_path_buf();
    std::fs::create_dir_all(&dir)
        .map_err(|err| DomainError::Storage(format!("启动状态目录创建失败: {err}")))?;
    let target = dir.join(BOOT_STATE_FILE);
    let tmp = dir.join(format!("{BOOT_STATE_FILE}.tmp"));
    let text = serde_json::to_string_pretty(state)
        .map_err(|err| DomainError::Storage(format!("启动状态序列化失败: {err}")))?;
    std::fs::write(&tmp, text)
        .map_err(|err| DomainError::Storage(format!("启动状态写入失败: {err}")))?;
    std::fs::rename(&tmp, &target)
        .map_err(|err| DomainError::Storage(format!("启动状态落位失败: {err}")))?;
    Ok(())
}

/// 登记一次启动失败：计数 +1；达到阈值自动转入安全模式。返回新状态。
pub fn record_boot_failure(data_dir: &Path) -> BootState {
    let mut state = load_boot_state(data_dir);
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    if state.consecutive_failures >= CRASH_LOOP_THRESHOLD {
        state.safe_mode = true;
    }
    state.last_boot_at = now_epoch_ms();
    let _ = save_boot_state(data_dir, &state);
    state
}

/// 登记一次成功启动：计数归零；安全模式保持（安全模式下稳定运行由
/// 宿主显式恢复动作退出，不因单次成功自动切换——防止崩溃链复现的
/// 反复震荡）。
pub fn record_boot_success(data_dir: &Path) -> BootState {
    let mut state = load_boot_state(data_dir);
    state.consecutive_failures = 0;
    state.last_boot_at = now_epoch_ms();
    let _ = save_boot_state(data_dir, &state);
    state
}

/// 退出安全模式（恢复动作成功后调用：回落/重置生效，回到正常启动）。
pub fn clear_safe_mode(data_dir: &Path) -> BootState {
    let mut state = load_boot_state(data_dir);
    state.consecutive_failures = 0;
    state.safe_mode = false;
    state.last_boot_at = now_epoch_ms();
    let _ = save_boot_state(data_dir, &state);
    state
}

// ── 启动快照轮换 ──

/// 启动快照目录（数据目录根下）。
pub fn snapshot_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(STARTUP_SNAPSHOTS_DIR)
}

/// 版本化快照文件名（版本 + 时间戳 + 随机后缀；解析见
/// [`parse_snapshot_name`]）。
pub fn snapshot_file_name(chain_version: i64, created_at_ms: f64) -> String {
    let token = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "chain-v{chain_version}-{:.0}-{token}.sqlite",
        created_at_ms
    )
}

/// 快照文件名解析（chain-v{版本}-{时间戳}-{随机}.sqlite → 元信息；
/// 形态不符 = None，跳过不误删）。
pub fn parse_snapshot_name(name: &str) -> Option<(i64, f64)> {
    let rest = name.strip_prefix("chain-v")?;
    let mut parts = rest.split('-');
    let version = parts.next()?.parse::<i64>().ok()?;
    let created_at = parts.next()?.parse::<f64>().ok()?;
    if !name.ends_with(".sqlite") {
        return None;
    }
    Some((version, created_at))
}

/// 启动快照清单（按时间倒序：最新在前；非版本化文件跳过）。
pub fn list_snapshots(data_dir: &Path) -> Vec<SnapshotMeta> {
    let dir = snapshot_dir(data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut metas: Vec<SnapshotMeta> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let (chain_version, created_at) = parse_snapshot_name(&name)?;
            Some(SnapshotMeta {
                name,
                path: entry.path(),
                chain_version,
                created_at,
            })
        })
        .collect();
    metas.sort_by(|a, b| {
        b.created_at
            .partial_cmp(&a.created_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    metas
}

/// 轮换落位：把新快照改名为版本化文件名落进快照目录，再按保留份数
/// 淘汰最旧（返回淘汰清单；新快照已就位 = 幂等可重放）。
pub fn rotate_snapshot(
    data_dir: &Path,
    fresh_path: &Path,
    chain_version: i64,
) -> Result<SnapshotMeta, DomainError> {
    let dir = snapshot_dir(data_dir);
    std::fs::create_dir_all(&dir)
        .map_err(|err| DomainError::Storage(format!("快照目录创建失败: {err}")))?;
    let created_at = std::fs::metadata(fresh_path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .ok()
        })
        .unwrap_or_else(now_epoch_ms);
    let name = snapshot_file_name(chain_version, created_at);
    let dest = dir.join(&name);
    std::fs::rename(fresh_path, &dest).map_err(|err| {
        DomainError::Storage(format!("快照落位失败（{} → {}）: {err}", fresh_path.display(), dest.display()))
    })?;
    let meta = SnapshotMeta {
        name,
        path: dest,
        chain_version,
        created_at,
    };
    prune_snapshots(data_dir, SNAPSHOT_KEEP);
    Ok(meta)
}

/// 淘汰最旧快照：保留最新 `keep` 份，其余删除（删除失败跳过不击穿）。
/// 返回实际删除数。
pub fn prune_snapshots(data_dir: &Path, keep: usize) -> usize {
    let metas = list_snapshots(data_dir);
    let mut removed = 0usize;
    for meta in metas.into_iter().skip(keep) {
        if std::fs::remove_file(&meta.path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkling-recovery-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("临时目录创建失败");
        dir
    }

    // ── 启动状态 ──

    #[test]
    fn boot_state_defaults_when_missing_or_broken() {
        let dir = temp_dir();
        let state = load_boot_state(&dir);
        assert_eq!(state.consecutive_failures, 0);
        assert!(!state.safe_mode);
        std::fs::write(dir.join(BOOT_STATE_FILE), "not json").unwrap();
        let state = load_boot_state(&dir);
        assert_eq!(state.consecutive_failures, 0, "坏 JSON = 默认态（不误判崩溃）");
        assert!(!state.safe_mode);
    }

    #[test]
    fn failure_counting_reaches_safe_mode_at_threshold() {
        let dir = temp_dir();
        let mut state = record_boot_failure(&dir);
        assert_eq!(state.consecutive_failures, 1);
        assert!(!state.safe_mode);
        state = record_boot_failure(&dir);
        assert_eq!(state.consecutive_failures, 2);
        assert!(!state.safe_mode, "阈值前不进入安全模式");
        state = record_boot_failure(&dir);
        assert_eq!(state.consecutive_failures, 3);
        assert!(state.safe_mode, "达到阈值自动转入安全模式");
        let reloaded = load_boot_state(&dir);
        assert_eq!(reloaded, state, "状态持久化往返一致");
    }

    #[test]
    fn success_resets_counter_and_keeps_safe_mode() {
        let dir = temp_dir();
        for _ in 0..CRASH_LOOP_THRESHOLD {
            record_boot_failure(&dir);
        }
        assert!(load_boot_state(&dir).safe_mode);
        let state = record_boot_success(&dir);
        assert_eq!(state.consecutive_failures, 0, "成功启动计数归零");
        assert!(state.safe_mode, "安全模式保持（恢复动作才退出）");
    }

    #[test]
    fn clear_safe_mode_exits_after_recovery() {
        let dir = temp_dir();
        for _ in 0..CRASH_LOOP_THRESHOLD {
            record_boot_failure(&dir);
        }
        let state = clear_safe_mode(&dir);
        assert_eq!(state.consecutive_failures, 0);
        assert!(!state.safe_mode, "恢复动作后退出安全模式");
        assert!(!load_boot_state(&dir).safe_mode);
    }

    // ── 快照轮换 ──

    #[test]
    fn snapshot_name_roundtrip_and_parse_rejects_foreign() {
        let name = snapshot_file_name(7, 1_720_000_000_000.0);
        assert!(name.starts_with("chain-v7-"));
        assert!(name.ends_with(".sqlite"));
        let (version, created_at) = parse_snapshot_name(&name).expect("解析失败");
        assert_eq!(version, 7);
        assert_eq!(created_at, 1_720_000_000_000.0);
        for bad in ["chain-v7.sqlite", "chain-v-7-1.sqlite", "notes.sqlite", "chain-v7-1.txt"] {
            assert!(parse_snapshot_name(bad).is_none(), "形态不符应跳过: {bad}");
        }
    }

    #[test]
    fn rotation_binds_version_and_prunes_oldest() {
        let dir = temp_dir();
        let snap_dir = snapshot_dir(&dir);
        std::fs::create_dir_all(&snap_dir).unwrap();
        // 制造 keep+2 份快照（版本绑定：新旧交错，验证按时间序而非版本序淘汰）
        for (index, (version, hour)) in [(1, 1), (2, 2), (3, 3), (4, 4), (5, 5), (9, 6), (10, 7)]
            .iter()
            .enumerate()
        {
            let fresh = snap_dir.join(format!("fresh-{index}.sqlite"));
            std::fs::write(&fresh, format!("snapshot-{index}")).unwrap();
            let stamp = 1_700_000_000_000.0 + (hour * 3_600_000) as f64;
            let named = snap_dir.join(snapshot_file_name(*version, stamp));
            std::fs::rename(&fresh, &named).unwrap();
        }
        let metas = list_snapshots(&dir);
        assert_eq!(metas.len(), 7);
        assert_eq!(metas[0].chain_version, 10, "最新时间在前");
        let removed = prune_snapshots(&dir, SNAPSHOT_KEEP);
        assert_eq!(removed, 2, "超出保留份数的按新旧淘汰");
        let remaining = list_snapshots(&dir);
        assert_eq!(remaining.len(), SNAPSHOT_KEEP);
        let versions: Vec<i64> = remaining.iter().map(|m| m.chain_version).collect();
        assert_eq!(versions, vec![10, 9, 5, 4, 3], "保留最新 5 份");
    }

    #[test]
    fn rotate_snapshot_places_and_prunes() {
        let dir = temp_dir();
        let snap_dir = snapshot_dir(&dir);
        std::fs::create_dir_all(&snap_dir).unwrap();
        let fresh = snap_dir.join("incoming.sqlite");
        std::fs::write(&fresh, "data").unwrap();
        let meta = rotate_snapshot(&dir, &fresh, 3).expect("轮换失败");
        assert_eq!(meta.chain_version, 3);
        assert!(meta.path.is_file(), "新快照已就位");
        assert!(!fresh.exists(), "临时文件已改名");
        assert_eq!(list_snapshots(&dir).len(), 1);
        // 幂等：同名不重复（再放一份同版本 → 新时间戳 → 2 份）
        let fresh2 = snap_dir.join("incoming-2.sqlite");
        std::fs::write(&fresh2, "data2").unwrap();
        let meta2 = rotate_snapshot(&dir, &fresh2, 3).expect("二次轮换失败");
        assert_eq!(list_snapshots(&dir).len(), 2);
        assert_ne!(meta.name, meta2.name, "时间戳随机后缀保证唯一");
    }
}

//! 导出 / 备份 / 恢复 / 崩溃回退命令面（红线二：启动快照 + 一键回落）。

use std::path::Path;

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use crate::ShellState;
use crate::{app_data_dir, ensure_engine};

/// 一键导出（data_dir 打包 → 目标文件；含引擎存储快照）。
///
/// 引擎运行中 = 一致性导出：先经引擎存储快照 op（sqlite backup API 一致
/// 副本）取主库一致形态，再以快照内容替换活动库入包——不裸读运行中库
/// （可能取到未含 WAL 提交的中间形态）。引擎未挂载 = 无运行写入者，
/// 直接读盘打包（磁盘即一致源）。
#[tauri::command]
pub(crate) async fn backup_export(
    app: AppHandle,
    state: State<'_, ShellState>,
    dest: String,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let engine_live = state.backend.engine.lock().unwrap().is_some();
    let manifest = if engine_live {
        let tmp_dir = std::env::temp_dir();
        let snap_path = tmp_dir.join(format!(
            "inkling-export-{}.sqlite",
            uuid::Uuid::new_v4().simple()
        ));
        crate::domain::backup::engine_storage_snapshot(&snap_path.to_string_lossy())
            .await
            .map_err(CommandError::engine)?;
        let manifest = crate::domain::backup::pack_data_dir_with_snapshot(
            &data_dir,
            Path::new(&dest),
            "inkling.sqlite",
            &snap_path,
        )
        .map_err(CommandError::io)?;
        let _ = std::fs::remove_file(&snap_path);
        manifest
    } else {
        crate::domain::backup::pack_data_dir(&data_dir, Path::new(&dest))
            .map_err(CommandError::io)?
    };
    Ok(json!({
        "entries": manifest.entries.len(),
        "size": manifest.entries.iter().map(|e| e.size).sum::<u64>(),
        "created_at": manifest.created_at,
        "has_db": manifest.engine_snapshot,
    }))
}

/// 恢复预览（校验包 → 重建预览：覆盖计数/大小/含库）。
#[tauri::command]
pub(crate) async fn backup_preview(path: String) -> Result<JsonValue, CommandError> {
    let manifest = crate::domain::backup::validate_backup(Path::new(&path))
        .map_err(CommandError::io)?;
    let preview_dir = std::env::temp_dir();
    let preview = crate::domain::backup::preview_restore(&manifest, &preview_dir);
    Ok(json!({
        "entries_total": preview.entries_total,
        "will_overwrite": preview.will_overwrite,
        "total_size": preview.total_size,
        "has_db": preview.has_db,
        "created_at": manifest.created_at,
    }))
}

/// 恢复执行（停引擎 → 校验 → 当前态快照 → 解包落位；失败留快照不击穿）。
///
/// 一致性纪律（与 recovery_restore_snapshot 对齐）：恢复前先停引擎——运行中
/// 引擎持有 sqlite 句柄，Windows 共享锁下解包直接覆盖主库会失败，且引擎
/// 内存态（记录/链缓存）在文件被替换后失效；停机后磁盘为唯一一致源，
/// 恢复前快照亦为一致形态。恢复完成后引擎由下次命令懒装配（重挂），
/// 并退出安全模式（用户显式恢复已知状态，回正常启动路径）。
#[tauri::command]
pub(crate) async fn backup_restore(
    app: AppHandle,
    state: State<'_, ShellState>,
    path: String,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    // R6：恢复全程持禁装闸——停机解包写盘窗口内并发命令不得 ensure_engine
    // 用半态库装配；失败/成功均须解除（闸解除后下次命令懒装配新库形态）。
    crate::set_restore_in_progress(true);
    let outcome = (|| -> Result<JsonValue, CommandError> {
        if let Some(host) = state.backend.engine.lock().unwrap().take() {
            let _ = host.stop();
        }
        let snapshots_dir = data_dir.join("snapshots");
        let (preview, snapshot) = crate::domain::backup::execute_restore(
            Path::new(&path),
            &data_dir,
            &snapshots_dir,
        )
        .map_err(CommandError::io)?;
        crate::domain::recovery::clear_safe_mode(&data_dir);
        Ok(json!({
            "restored_entries": preview.entries_total,
            "will_overwrite": preview.will_overwrite,
            "total_size": preview.total_size,
            "has_db": preview.has_db,
            "snapshot": snapshot.display().to_string(),
            "restore_from": path,
        }))
    })();
    crate::set_restore_in_progress(false);
    outcome
}

/// 启动快照清单（「回到上一稳定版本」的取用入口：绑定链版本 + 时间序）。
#[tauri::command]
pub(crate) fn recovery_snapshots(app: AppHandle) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let snapshots: Vec<JsonValue> = crate::domain::recovery::list_snapshots(&data_dir)
        .into_iter()
        .map(|meta| {
            json!({
                "name": meta.name,
                "chain_version": meta.chain_version,
                "created_at": meta.created_at,
            })
        })
        .collect();
    Ok(json!({ "snapshots": snapshots }))
}

/// 回到上一稳定版本：从指定启动快照恢复（引擎存储契约 restore）→
/// 引擎停机重挂（下次命令触发重新装配 = 快照时刻形态）→ 退出安全模式。
///
/// 快照名只接受既有清单条目（防路径穿越：不拼接用户输入路径）。
#[tauri::command]
pub(crate) async fn recovery_restore_snapshot(
    app: AppHandle,
    state: State<'_, ShellState>,
    name: String,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let metas = crate::domain::recovery::list_snapshots(&data_dir);
    let meta = metas
        .iter()
        .find(|m| m.name == name)
        .ok_or_else(|| CommandError::not_found(format!("快照不存在: {name}")))?;
    ensure_engine(&app, &state, &data_dir)?;
    let src = meta.path.to_string_lossy().into_owned();
    let outcome = crate::engine::host::call_engine_op_async(
        "engine.storage_restore",
        serde_json::json!({ "src": src }),
    )
    .await
    .map_err(|err| CommandError::engine(format!("快照恢复失败: {err}")))?;
    if outcome.get("restored").and_then(JsonValue::as_bool) != Some(true) {
        return Err(CommandError::engine("快照恢复未确认落位"));
    }
    // 引擎停机重挂：恢复后一致态由下次装配保证（会话/记忆/链回到快照时刻）。
    // R6：停机窗口持禁装闸，防并发命令在半态库上重挂。
    crate::set_restore_in_progress(true);
    if let Some(host) = state.backend.engine.lock().unwrap().take() {
        let _ = host.stop();
    }
    crate::set_restore_in_progress(false);
    crate::domain::recovery::clear_safe_mode(&data_dir);
    Ok(json!({
        "restored": meta.name,
        "chain_version": meta.chain_version,
    }))
}

/// 出厂重置：补丁链逐尾回退至基线（每条回退走既有回退路径、逐条落
/// 审计）；链记录损坏（回退不可用）时回落为链记录整体清空 + 审计
/// 留痕。完成后引擎停机重挂（下次装配 = 出厂基线 + 种子重注入），
/// 并退出安全模式。
#[tauri::command]
pub(crate) async fn recovery_factory_reset(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&app, &state, &data_dir)?;
    let mut reverted: Vec<i64> = Vec::new();
    let mut overwritten = false;
    loop {
        let record = crate::engine::host::call_engine_op_async(
            "engine.records_get",
            serde_json::json!({ "collection": "set_patch_chain", "key": "chain" }),
        )
        .await
        .unwrap_or(JsonValue::Null);
        let version = crate::domain::boot::chain_version(&record);
        if version <= 1 {
            break;
        }
        let outcome = crate::engine::host::call_engine_op_async(
            "patch.revert",
            serde_json::json!({
                "patch_id": version,
                "decision": "accept",
                "reason": "出厂重置：逐尾回退至基线",
                "thread_id": "recovery",
            }),
        )
        .await;
        let status = match &outcome {
            Ok(value) => value["outcome"].get("status").and_then(JsonValue::as_str),
            Err(_) => None,
        };
        if status != Some("reverted") {
            // 链记录损坏（回退不可用）：清空回基线 + 审计留痕（机制
            // 豁免路径；被清空补丁数随审计记录保留）
            overwritten = true;
            crate::engine::host::call_engine_op_async(
                "engine.chain_reset_to_base",
                serde_json::json!({ "reason": "出厂重置：链记录损坏，清空至基线" }),
            )
            .await
            .map_err(|err| CommandError::engine(format!("出厂重置（清空）失败: {err}")))?;
            break;
        }
        reverted.push(version);
    }
    // 引擎停机重挂：下次装配 = 出厂基线（链已空 + 种子重注入）。
    // R6：停机窗口持禁装闸，防并发命令在半态库上重挂。
    crate::set_restore_in_progress(true);
    if let Some(host) = state.backend.engine.lock().unwrap().take() {
        let _ = host.stop();
    }
    crate::set_restore_in_progress(false);
    crate::domain::recovery::clear_safe_mode(&data_dir);
    Ok(json!({
        "reverted_patches": reverted,
        "overwritten": overwritten,
    }))
}

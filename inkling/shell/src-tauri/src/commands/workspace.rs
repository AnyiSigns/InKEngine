//! 授权 / 审批 / 挂载命令面（工作区授权 + 审批卡 + 文件挂载授权）。

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use crate::ShellState;
use crate::{app_data_dir, ensure_engine, expand_home, security_domain_from_seed};

/// 授权状态（工作区根；无授权记录 = 未授权）。
///
/// 授权态经引擎 records 通道落库，须先确保引擎已装配（首轮会话前也可能
/// 直接打开侧边栏选目录，此时引擎尚未 boot，否则 runtime_handle 为空会
/// 静默失败、侧边栏不显示目录）。
#[tauri::command]
pub(crate) async fn authorization_state(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app).map_err(CommandError::internal)?;
    ensure_engine(&app, &state, &data_dir).map_err(CommandError::internal)?;
    let security = security_domain_from_seed().map_err(CommandError::internal)?;
    let root = crate::domain::security::load_authorization(&security)
        .await
        .map_err(CommandError::internal)?;
    Ok(json!({ "authorized": root.is_some(), "root": root }))
}

/// 授权（工作区根写入记录 + 挂载点登记；引擎侧文件工具随装配生效）。
///
/// 授权态经引擎 records 通道落库，须先确保引擎已装配（否则 runtime_handle
/// 为空会报错、前端静默吞掉导致侧边栏不显示）。
#[tauri::command]
pub(crate) async fn workspace_authorize(
    app: AppHandle,
    state: State<'_, ShellState>,
    path: String,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app).map_err(CommandError::internal)?;
    ensure_engine(&app, &state, &data_dir).map_err(CommandError::internal)?;
    let resolved = expand_home(&path);
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|err| CommandError::io(format!("工作区不可达: {} ({err})", resolved.display())))?;
    {
        let mut mounts = state.mounts.lock().unwrap();
        if !mounts.contains(&canonical) {
            mounts.push(canonical.clone());
        }
    }
    let record = json!({
        "root": canonical.display().to_string(),
        "authorized_at": chrono::Utc::now().timestamp_millis(),
    });
    crate::domain::security::persist_authorization(record)
        .await
        .map_err(CommandError::internal)?;
    Ok(json!({ "authorized": true, "root": canonical.display().to_string() }))
}

/// 撤销授权（记录置空；重启后不再恢复）。
#[tauri::command]
pub(crate) async fn workspace_revoke(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app).map_err(CommandError::internal)?;
    ensure_engine(&app, &state, &data_dir).map_err(CommandError::internal)?;
    crate::domain::security::persist_authorization(json!({ "root": "" }))
        .await
        .map_err(CommandError::internal)?;
    Ok(json!({ "authorized": false }))
}

/// 在系统文件管理器中打开路径（工作区授权视图「打开路径」）。
///
/// 安全边界：仅接受授权工作区内的目录（canonicalize 后前缀校验），
/// 防前端传入任意路径触发外部程序。
#[tauri::command]
pub(crate) async fn shell_open_path(path: String) -> Result<JsonValue, CommandError> {
    let security = security_domain_from_seed().map_err(CommandError::internal)?;
    let root = crate::domain::security::load_authorization(&security)
        .await
        .map_err(CommandError::internal)?;
    let root = root.ok_or_else(|| CommandError::new("DENIED", "未授权工作区"))?;
    let root_canonical = std::fs::canonicalize(&root)
        .map_err(|err| CommandError::io(format!("工作区根不可达: {} ({err})", root)))?;
    let target = std::fs::canonicalize(&path)
        .map_err(|err| CommandError::io(format!("路径不可达: {} ({err})", path)))?;
    if !target.starts_with(&root_canonical) {
        return Err(CommandError::new("DENIED", "路径不在授权工作区内"));
    }
    if !target.is_dir() {
        return Err(CommandError::io("路径不是目录"));
    }
    #[cfg(target_os = "windows")]
    let opened = std::process::Command::new("explorer")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|err| CommandError::io(format!("打开路径失败: {err}")))?;
    #[cfg(target_os = "macos")]
    let opened = std::process::Command::new("open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|err| CommandError::io(format!("打开路径失败: {err}")))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let opened = std::process::Command::new("xdg-open")
        .arg(&target)
        .spawn()
        .map(|_| ())
        .map_err(|err| CommandError::io(format!("打开路径失败: {err}")))?;
    #[cfg(any(target_os = "windows", target_os = "macos", all(unix, not(target_os = "macos"))))]
    let _ = opened;
    Ok(json!({ "opened": target.display().to_string() }))
}

/// 审批卡请求（回合外两步形态：先请求落卡，后注入决议）。
#[tauri::command]
pub(crate) async fn approval_request(
    state: State<'_, ShellState>,
    thread_id: Option<String>,
    key: String,
    action: JsonValue,
    payload: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    approval_card(&state, thread_id.as_deref(), &key, action, payload, None).await
}

/// 审批决议注入（决议经操作通道预注入；已决去重）。
#[tauri::command]
pub(crate) async fn approval_resolve(
    state: State<'_, ShellState>,
    thread_id: Option<String>,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    approval_card(
        &state,
        thread_id.as_deref(),
        &key,
        json!({}),
        None,
        Some(json!({
            "decision": decision,
            "reason": reason,
            "edited_content": edited_content,
        })),
    )
    .await
}

/// 审批卡操作通道接线（请求 + 决议注入共用入口）。
///
/// 决议态同时登记进壳侧审批台账（决议 4：引擎审批卡决议态驱动命令面裁决
/// ——`approval_resolve`/自动审批的引擎决议结果落台账，process_exec /
/// device_mcp_call 按 (工具, 参数指纹) 查询放行）。
async fn approval_card(
    state: &State<'_, ShellState>,
    thread_id: Option<&str>,
    key: &str,
    action: JsonValue,
    payload: Option<JsonValue>,
    decision: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let mut args = json!({
        "thread_id": thread_id,
        "key": key,
        "action": action,
    });
    let payload_for_ledger = payload.clone();
    if let Some(payload) = payload {
        args["payload"] = payload;
    }
    if let Some(decision) = decision {
        args["decision"] = decision
            .get("decision")
            .cloned()
            .unwrap_or_else(|| json!("reject"));
        if let Some(reason) = decision.get("reason").and_then(JsonValue::as_str) {
            args["reason"] = json!(reason);
        }
        if let Some(edited) = decision.get("edited_content") {
            if !edited.is_null() {
                args["edited_content"] = edited.clone();
            }
        }
    }
    let outcome = crate::engine::host::call_engine_op_async("approval.gate_card_request", args)
        .await
        .map_err(CommandError::engine)?;
    // 引擎决议态入台账（决议 4）：按引擎返回的 decision 登记（payload 带
    // tool/args 线索时按指纹命中命令面裁决）
    let decision = outcome
        .get("decision")
        .and_then(JsonValue::as_str)
        .unwrap_or("reject");
    state
        .approval
        .record_resolution(key, decision, payload_for_ledger.as_ref());
    Ok(outcome)
}

/// 文件挂载授权：目录加入授权挂载点（文件沙箱根）。
/// 宿主侧人工授权（设置页「工作区授权」）；集成期由引擎审批层叠加判定。
/// 决议 14：挂载点并入 `check_path_roots` 动态根——授权即沙箱生效。
#[tauri::command]
pub(crate) fn mount_authorize(state: State<'_, ShellState>, path: String) -> Result<Vec<String>, CommandError> {
    let mut mounts = state.mounts.lock().unwrap();
    let resolved = expand_home(&path);
    let canonical = std::fs::canonicalize(&resolved)
        .map_err(|err| CommandError::io(format!("挂载目录不可达: {path} ({err})")))?;
    if !mounts.contains(&canonical) {
        mounts.push(canonical.clone());
    }
    Ok(mounts.iter().map(|p| p.display().to_string()).collect())
}

#[tauri::command]
pub(crate) fn mount_list(state: State<'_, ShellState>) -> Vec<String> {
    state
        .mounts
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.display().to_string())
        .collect()
}

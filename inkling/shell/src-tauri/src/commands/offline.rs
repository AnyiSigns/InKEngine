//! 离线支持级命令面（Ollama + 本地嵌入 + 本地记忆探测与 settings 档读写）。

use serde_json::Value as JsonValue;
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 离线支持级探测（Ollama + 本地嵌入 + 本地记忆）。
#[tauri::command]
pub(crate) async fn offline_detect(app: AppHandle) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app).ok();
    crate::domain::offline::detect(dir.as_deref())
        .await
        .map_err(CommandError::internal)
}

/// 读取离线 settings 档。
#[tauri::command]
pub(crate) fn offline_settings_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app)?;
    Ok(crate::domain::offline::read_settings(&dir))
}

/// 写入离线 settings 档。
#[tauri::command]
pub(crate) fn offline_settings_put(app: AppHandle, settings: JsonValue) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app)?;
    Ok(crate::domain::offline::write_settings(&dir, settings))
}

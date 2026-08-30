//! 离线支持级命令面（Ollama + 本地嵌入 + 本地记忆探测与 settings 档读写）。

use serde_json::Value as JsonValue;
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 离线 settings 记录集合/键（引擎 records 通道；引擎不可用时降级文件层）。
const OFFLINE_SETTINGS_COLLECTION: &str = "offline_settings";
const OFFLINE_SETTINGS_KEY: &str = "settings";

/// 离线支持级探测（Ollama + 本地嵌入 + 本地记忆）。
#[tauri::command]
pub(crate) async fn offline_detect(app: AppHandle) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app).ok();
    crate::domain::offline::detect(dir.as_deref())
        .await
        .map_err(CommandError::internal)
}

/// 读取离线 settings（优先引擎 records；引擎不可用降级文件层）。
#[tauri::command]
pub(crate) async fn offline_settings_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    if let Ok(record) = crate::engine::host::call_engine_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": OFFLINE_SETTINGS_COLLECTION, "key": OFFLINE_SETTINGS_KEY }),
    )
    .await
    {
        if let JsonValue::Object(_) = &record {
            let mut merged = crate::domain::offline::default_settings();
            if let (Some(m), Some(obj)) = (merged.as_object_mut(), record.as_object()) {
                for (k, v) in obj {
                    m.insert(k.clone(), v.clone());
                }
            }
            return Ok(merged);
        }
    }
    let dir = app_data_dir(&app)?;
    Ok(crate::domain::offline::read_settings(&dir))
}

/// 写入离线 settings（优先引擎 records；引擎不可用降级文件层）。
#[tauri::command]
pub(crate) async fn offline_settings_put(app: AppHandle, settings: JsonValue) -> Result<JsonValue, CommandError> {
    let mut merged = crate::domain::offline::default_settings();
    if let (Some(m), Some(s)) = (merged.as_object_mut(), settings.as_object()) {
        for (k, v) in s {
            m.insert(k.clone(), v.clone());
        }
    }
    match crate::engine::host::call_engine_op_async(
        "engine.records_put",
        serde_json::json!({
            "collection": OFFLINE_SETTINGS_COLLECTION,
            "key": OFFLINE_SETTINGS_KEY,
            "data": merged.clone(),
        }),
    )
    .await
    {
        Ok(_) => Ok(merged),
        Err(_) => {
            let dir = app_data_dir(&app)?;
            Ok(crate::domain::offline::write_settings(&dir, settings))
        }
    }
}

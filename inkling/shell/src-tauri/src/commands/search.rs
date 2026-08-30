//! 联网搜索 key 命令面（环境变量优先 + 设置页输入联动）。

use serde_json::Value as JsonValue;
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 搜索 key 记录集合/键（引擎 records 通道；引擎不可用时降级文件层）。
const SEARCH_KEYS_COLLECTION: &str = "search_keys";
const SEARCH_KEYS_KEY: &str = "keys";

/// 搜索 key 配置文件名（数据目录；降级读写路径）。
const SEARCH_KEYS_FILE: &str = "search_keys.json";

/// 读取搜索 key 配置（优先引擎 records；引擎不可用降级文件层）。
#[tauri::command]
pub(crate) async fn search_keys_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    if let Ok(record) = crate::engine::host::call_engine_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": SEARCH_KEYS_COLLECTION, "key": SEARCH_KEYS_KEY }),
    )
    .await
    {
        if record.is_object() {
            return Ok(record);
        }
    }
    let dir = app_data_dir(&app)?;
    let path = dir.join(SEARCH_KEYS_FILE);
    if path.is_file() {
        let text = std::fs::read_to_string(&path).map_err(CommandError::io)?;
        let value: JsonValue = serde_json::from_str(&text).map_err(CommandError::internal)?;
        Ok(value)
    } else {
        Ok(JsonValue::Object(Default::default()))
    }
}

/// 写入搜索 key 配置（优先引擎 records；引擎不可用降级文件层）。
#[tauri::command]
pub(crate) async fn search_keys_put(
    app: AppHandle,
    keys: JsonValue,
) -> Result<JsonValue, CommandError> {
    match crate::engine::host::call_engine_op_async(
        "engine.records_put",
        serde_json::json!({
            "collection": SEARCH_KEYS_COLLECTION,
            "key": SEARCH_KEYS_KEY,
            "data": keys,
        }),
    )
    .await
    {
        Ok(_) => Ok(keys),
        Err(_) => {
            let dir = app_data_dir(&app)?;
            let path = dir.join(SEARCH_KEYS_FILE);
            let text = serde_json::to_string_pretty(&keys).map_err(CommandError::internal)?;
            std::fs::write(&path, text).map_err(CommandError::io)?;
            Ok(keys)
        }
    }
}

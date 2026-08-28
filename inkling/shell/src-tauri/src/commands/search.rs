//! 联网搜索 key 命令面（环境变量优先 + 设置页输入联动）。

use serde_json::Value as JsonValue;
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 搜索 key 配置文件名（数据目录）。
const SEARCH_KEYS_FILE: &str = "search_keys.json";

/// 读取搜索 key 配置（缺文件 = 空对象）。
#[tauri::command]
pub(crate) fn search_keys_get(app: AppHandle) -> Result<JsonValue, CommandError> {
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

/// 写入搜索 key 配置（覆盖写入；掩码日志由前端/壳层负责）。
#[tauri::command]
pub(crate) fn search_keys_put(
    app: AppHandle,
    keys: JsonValue,
) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app)?;
    let path = dir.join(SEARCH_KEYS_FILE);
    let text = serde_json::to_string_pretty(&keys).map_err(CommandError::internal)?;
    std::fs::write(&path, text).map_err(CommandError::io)?;
    Ok(keys)
}

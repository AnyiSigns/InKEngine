//! 联网搜索 key 命令面（环境变量优先 + 设置页输入联动）。

use serde_json::{json, Value as JsonValue};
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 搜索 key 记录集合/键（引擎 records 通道；引擎不可用时降级文件层）。
const SEARCH_KEYS_COLLECTION: &str = "search_keys";
const SEARCH_KEYS_KEY: &str = "keys";

/// 搜索 key 配置文件名（数据目录；降级读写路径）。
const SEARCH_KEYS_FILE: &str = "search_keys.json";

/// 变换搜索 key 配置中的厂商密钥字段（exa/parallel/bocha/`*_key`，
/// 顶层与 `search`/`search_keys` 嵌套形态均覆盖）。
fn transform_key_values(value: &mut JsonValue, mut transform: impl FnMut(&str) -> String) {
    fn walk(node: &mut JsonValue, transform: &mut impl FnMut(&str) -> String) {
        if let JsonValue::Object(map) = node {
            for (key, value) in map.iter_mut() {
                if key == "exa" || key == "parallel" || key == "bocha" || key.ends_with("_key") {
                    if let JsonValue::String(text) = value {
                        *value = JsonValue::String(transform(text));
                    }
                } else if let JsonValue::Object(_) = value {
                    walk(value, transform);
                }
            }
        }
    }
    walk(value, &mut transform);
}

/// 读取搜索 key 配置（优先引擎 records；引擎不可用降级文件层）。
/// api_key 还原（dpapi: 解密）后按打码形态回传（完整密钥不落前端）。
#[tauri::command]
pub(crate) async fn search_keys_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    let mut record = if let Ok(record) = crate::engine::host::call_engine_op_async(
        "engine.records_get",
        json!({ "collection": SEARCH_KEYS_COLLECTION, "key": SEARCH_KEYS_KEY }),
    )
    .await
    {
        if record.is_object() {
            record
        } else {
            JsonValue::Object(Default::default())
        }
    } else {
        let dir = app_data_dir(&app)?;
        let path = dir.join(SEARCH_KEYS_FILE);
        if path.is_file() {
            let text = std::fs::read_to_string(&path).map_err(CommandError::io)?;
            serde_json::from_str(&text).map_err(CommandError::internal)?
        } else {
            JsonValue::Object(Default::default())
        }
    };
    transform_key_values(&mut record, crate::domain::crypto::restore_secret);
    transform_key_values(&mut record, crate::domain::crypto::mask_secret);
    Ok(record)
}

/// 写入搜索 key 配置（优先引擎 records；引擎不可用降级文件层）。
/// 落盘前厂商密钥经 DPAPI 加密（dpapi: 前缀），明文不落盘。
#[tauri::command]
pub(crate) async fn search_keys_put(
    app: AppHandle,
    keys: JsonValue,
) -> Result<JsonValue, CommandError> {
    let mut stored = keys.clone();
    transform_key_values(&mut stored, crate::domain::crypto::protect_secret);
    match crate::engine::host::call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": SEARCH_KEYS_COLLECTION,
            "key": SEARCH_KEYS_KEY,
            "data": stored,
        }),
    )
    .await
    {
        Ok(_) => Ok(keys),
        Err(_) => {
            let dir = app_data_dir(&app)?;
            let path = dir.join(SEARCH_KEYS_FILE);
            let text = serde_json::to_string_pretty(&stored).map_err(CommandError::internal)?;
            std::fs::write(&path, text).map_err(CommandError::io)?;
            Ok(keys)
        }
    }
}

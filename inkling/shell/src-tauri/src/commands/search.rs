//! 联网搜索 key 命令面（设置档文件 = 单一权威；环境变量显式优先覆盖）。

use serde_json::Value as JsonValue;
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 搜索 key 配置文件路径（数据目录；唯一权威通道——运行期 web_search
/// 每次调用读同一文件，保存即生效）。
fn search_keys_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("search_keys.json")
}

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

/// 读取搜索 key 配置（设置档文件；api_key 还原后按打码形态回传——完整
/// 密钥不落前端）。兼容旧嵌套形态与设置表单形态读取（normalize 收敛）。
#[tauri::command]
pub(crate) async fn search_keys_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app)?;
    let path = search_keys_path(&dir);
    let raw: JsonValue = if path.is_file() {
        let text = std::fs::read_to_string(&path).map_err(CommandError::io)?;
        serde_json::from_str(&text).map_err(CommandError::internal)?
    } else {
        JsonValue::Object(Default::default())
    };
    let mut record = crate::domain::web_search::normalize_search_key_config(&raw);
    transform_key_values(&mut record, crate::domain::crypto::restore_secret);
    transform_key_values(&mut record, crate::domain::crypto::mask_secret);
    Ok(record)
}

/// 写入搜索 key 配置（设置档文件；records 通道废弃——统一文件通道，
/// 运行期 web_search 同源读取，引擎在线/离线都生效）。落盘前厂商密钥经
/// DPAPI 加密（dpapi: 前缀），明文不落盘；打码占位（未变更）幂等透传。
/// 返回打码后的运行期形态（不透传明文/密文原文给前端）。
#[tauri::command]
pub(crate) async fn search_keys_put(
    app: AppHandle,
    keys: JsonValue,
) -> Result<JsonValue, CommandError> {
    let dir = app_data_dir(&app)?;
    let stored = crate::domain::web_search::write_search_keys(&dir, &keys)
        .map_err(CommandError::internal)?;
    let mut response = stored;
    transform_key_values(&mut response, crate::domain::crypto::mask_secret);
    Ok(response)
}

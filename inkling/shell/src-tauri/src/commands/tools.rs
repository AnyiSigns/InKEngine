//! 工具快照 / 组件清单命令面。

use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use crate::ShellState;
use crate::{COMPONENT_MANIFEST_FILE, app_data_dir};

/// 工具快照（四层兜底标签 + 工具族 + 自动审批可登记标记；管理台/
/// 名映射/设置页勾选项共用）。
#[tauri::command]
pub(crate) fn tools_snapshot(state: State<'_, ShellState>) -> JsonValue {
    let provider = state.backend.tool_provider.clone();
    let map: Vec<JsonValue> = provider
        .name_map()
        .iter()
        .map(|entry| {
            let auto_approvable = provider
                .lookup(&entry.tool)
                .and_then(|spec| {
                    spec.get("meta")
                        .and_then(|meta| meta.get("auto_approvable"))
                        .and_then(JsonValue::as_bool)
                })
                .unwrap_or(false);
            json!({
                "tool": entry.tool,
                "zh": entry.zh,
                "group": entry.group,
                "auto_approvable": auto_approvable,
            })
        })
        .collect();
    json!({ "tools": map })
}

/// 组件构建产物清单（挂载后注册表刷新的数据源；无清单 = 空）。
#[tauri::command]
pub(crate) fn components_manifest(app: AppHandle) -> JsonValue {
    let manifest_path = match app_data_dir(&app) {
        Ok(dir) => dir.join("components").join(COMPONENT_MANIFEST_FILE),
        Err(_) => PathBuf::new(),
    };
    if manifest_path.is_file() {
        std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
            .unwrap_or_else(|| json!({ "artifacts": [] }))
    } else {
        json!({ "artifacts": [] })
    }
}

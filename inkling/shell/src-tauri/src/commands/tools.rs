//! 工具快照 / 组件清单命令面。

use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use crate::ShellState;
use crate::{COMPONENT_MANIFEST_FILE, app_data_dir, security_domain_from_seed};

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

/// 全量工具清单（设置页「工具」管理面数据源）。
///
/// 数据 = 引擎 merged_specs 全量工具（含 MCP 挂载）附常驻必带标记/来源/
/// 声明式细节；审批档由壳侧安全域（tools.json 声明）补齐，缺省 review
/// （MCP 动态工具经挂载 vetting 门禁判定，不在此表）。
#[tauri::command]
pub(crate) async fn tools_manifest() -> Result<JsonValue, CommandError> {
    let mut value = crate::engine::host::call_engine_op_async("engine.tools_manifest", json!({}))
        .await
        .map_err(CommandError::engine)?;
    let tiers = security_domain_from_seed()
        .map(|security| security.tiers.clone())
        .unwrap_or_default();
    if let Some(tools) = value.get_mut("tools").and_then(JsonValue::as_array_mut) {
        for tool in tools {
            if let Some(obj) = tool.as_object_mut() {
                let name = obj.get("name").and_then(JsonValue::as_str).unwrap_or("");
                if !obj.contains_key("approval") {
                    obj.insert(
                        "approval".to_string(),
                        JsonValue::String(
                            tiers.get(name).cloned().unwrap_or_else(|| "review".to_string()),
                        ),
                    );
                }
            }
        }
    }
    Ok(value)
}

/// 常驻必带工具集读取（设置页「工具」勾选态）。
#[tauri::command]
pub(crate) async fn tools_baseline_get() -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async("engine.baseline_get", json!({}))
        .await
        .map_err(CommandError::engine)
}

/// 常驻必带工具集写入（整集替换；强制保留检索工具；records 持久化）。
///
/// 非法名（不在全量工具表内）由引擎侧 set_baseline_names 结构化拒绝，
/// 错误经 CommandError 回传前端展示。
#[tauri::command]
pub(crate) async fn tools_baseline_set(tools: Vec<String>) -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async(
        "engine.baseline_set",
        json!({ "tools": tools }),
    )
    .await
    .map_err(CommandError::engine)
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

/// 写入组件构建产物清单（挂载/构建完成后更新；白名单拒绝语义保持）。
#[tauri::command]
pub(crate) fn components_manifest_put(
    app: AppHandle,
    artifacts: JsonValue,
) -> Result<JsonValue, crate::commands::error::CommandError> {
    let dir = app_data_dir(&app)?;
    let components_dir = dir.join("components");
    std::fs::create_dir_all(&components_dir).map_err(crate::commands::error::CommandError::io)?;
    let manifest_path = components_dir.join(COMPONENT_MANIFEST_FILE);
    let text =
        serde_json::to_string_pretty(&artifacts).map_err(crate::commands::error::CommandError::internal)?;
    std::fs::write(&manifest_path, text).map_err(crate::commands::error::CommandError::io)?;
    Ok(artifacts)
}

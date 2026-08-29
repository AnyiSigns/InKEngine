//! 能力设置命令面（推演档位等持久化；自动审批配置与壳侧审批台账同步）。

use serde_json::{json, Value as JsonValue};
use tauri::State;

use super::error::CommandError;
use crate::ShellState;
use crate::{CAPABILITY_COLLECTION, CAPABILITY_KEY, load_workflow_data};

/// 读取能力设置（无记录 = 装配数据默认档：轻探测；自动审批字段
/// 缺省 = 出厂空集——不勾选即不预授权，最保守）。
///
/// 读取时同步台账（重启后命令面裁决与持久化的自动审批配置对齐）。
#[tauri::command]
pub(crate) async fn capability_get(state: State<'_, ShellState>) -> Result<JsonValue, CommandError> {
    let record = crate::engine::host::call_engine_op_async(
        "engine.records_get",
        json!({ "collection": CAPABILITY_COLLECTION, "key": CAPABILITY_KEY }),
    )
    .await
    .map_err(CommandError::engine)?;
    let mut merged = match record {
        JsonValue::Object(map) => JsonValue::Object(map),
        _ => json!({}),
    };
    if merged.get("simulation_tier").and_then(JsonValue::as_str).is_none() {
        let workflow = load_workflow_data().map_err(CommandError::internal)?;
        let default = crate::domain::policy::default_simulation_tier_from_data(&workflow);
        merged["simulation_tier"] = json!(default.as_str());
    }
    if merged.get("auto_approve_tools").is_none() {
        merged["auto_approve_tools"] = json!([]);
    }
    if merged.get("auto_approve_all_review").is_none() {
        merged["auto_approve_all_review"] = json!(false);
    }
    if merged.get("tier_overrides").is_none() {
        merged["tier_overrides"] = json!({});
    }
    // 默认值懒初始化落盘：注入的缺省字段一并持久化，重启后 restore 路径
    // 读到与内存同源的数据（此前仅内存注入，重启即丢，自动审批配置随
    // 每次首次读档与保存路径分歧）。
    crate::engine::host::call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": CAPABILITY_COLLECTION,
            "key": CAPABILITY_KEY,
            "data": merged,
        }),
    )
    .await
    .map_err(CommandError::engine)?;
    let auto_tools: Vec<String> = merged
        .get("auto_approve_tools")
        .and_then(JsonValue::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let auto_all = merged
        .get("auto_approve_all_review")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    state.approval.set_auto_approve(auto_tools, auto_all);
    Ok(merged)
}

/// 保存能力设置（自动审批先经安全域校验并应用：登记边界外工具
/// 整体拒绝、不落盘；档位阈值随装配数据，此处只存档选）。
///
/// 自动审批配置同时同步进壳侧审批台账（决议 4：命令面裁决与引擎侧
/// `security.auto_approve_set` 门禁同口径）。
#[tauri::command]
pub(crate) async fn capability_put(
    state: State<'_, ShellState>,
    record: JsonValue,
) -> Result<JsonValue, CommandError> {
    if record.get("auto_approve_tools").is_some() || record.get("auto_approve_all_review").is_some() {
        let auto_tools = record
            .get("auto_approve_tools")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let auto_all = record
            .get("auto_approve_all_review")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false);
        // 先应用（登记边界在安全域内硬拒，失败 = 不落盘）
        let applied = crate::engine::host::call_engine_op_async(
            "security.auto_approve_set",
            json!({ "tools": auto_tools, "all_review": auto_all }),
        )
        .await
        .map_err(CommandError::engine)?;
        if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
            return Err(CommandError::approval("自动审批配置未生效（安全域拒绝）"));
        }
        let tools: Vec<String> = auto_tools
            .iter()
            .filter_map(JsonValue::as_str)
            .map(str::to_string)
            .collect();
        state.approval.set_auto_approve(tools, auto_all);
    }
    // 合并语义：能力记录是「整体存储」，但调用方（推演档 / ui_spec /
    // 自动审批）各写各自字段——先读既有记录再并入，避免单字段写清空
    // 其余字段（如切换推演档清空自动审批集 / 保存 ui_spec 清空档位）。
    let existing = crate::engine::host::call_engine_op_async(
        "engine.records_get",
        json!({ "collection": CAPABILITY_COLLECTION, "key": CAPABILITY_KEY }),
    )
    .await
    .map_err(CommandError::engine)?;
    let mut merged = match existing {
        JsonValue::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    if let JsonValue::Object(incoming) = &record {
        for (key, value) in incoming {
            merged.insert(key.clone(), value.clone());
        }
    }
    crate::engine::host::call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": CAPABILITY_COLLECTION,
            "key": CAPABILITY_KEY,
            "data": JsonValue::Object(merged),
        }),
    )
    .await
    .map_err(CommandError::engine)?;
    Ok(record)
}

/// 逐工具档位覆盖（权限矩阵写面：工具 tab 档位编辑；安全域校验
/// deny 出厂档不可覆盖 + 合法值白名单，失败 = 不落盘）。
#[tauri::command]
pub(crate) async fn security_tier_overrides_set(
    overrides: JsonValue,
) -> Result<JsonValue, CommandError> {
    let applied = crate::engine::host::call_engine_op_async(
        "security.tier_overrides_set",
        json!({ "overrides": overrides }),
    )
    .await
    .map_err(CommandError::engine)?;
    if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
        return Err(CommandError::approval("档位覆盖未生效（安全域拒绝）"));
    }
    Ok(applied)
}

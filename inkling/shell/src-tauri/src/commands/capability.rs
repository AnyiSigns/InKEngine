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
    if merged.get("remembered_domains").is_none() {
        merged["remembered_domains"] = json!([]);
    }
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
    // 已记住域名（联网审批的域名级记忆：审批卡「记住此域名」/设置页
    // 管理列表共用；安全域应用 + 随能力记录持久化）
    if record.get("remembered_domains").is_some() {
        let domains = record
            .get("remembered_domains")
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let applied = crate::engine::host::call_engine_op_async(
            "security.remembered_domains_set",
            json!({ "domains": domains }),
        )
        .await
        .map_err(CommandError::engine)?;
        if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
            return Err(CommandError::approval("已记住域名配置未生效（安全域拒绝）"));
        }
    }
    crate::engine::host::call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": CAPABILITY_COLLECTION,
            "key": CAPABILITY_KEY,
            "data": record,
        }),
    )
    .await
    .map_err(CommandError::engine)?;
    Ok(record)
}

/// 已记住域名清单（联网审批的域名级记忆：设置页管理列表读入面）。
#[tauri::command]
pub(crate) async fn security_remembered_domains_get(
) -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async(
        "security.remembered_domains_get",
        json!({}),
    )
    .await
    .map_err(CommandError::engine)
}

/// 已记住域名全量替换（设置页增删 / 审批卡记住域名共用）。
#[tauri::command]
pub(crate) async fn security_remembered_domains_set(
    domains: Vec<String>,
) -> Result<JsonValue, CommandError> {
    let applied = crate::engine::host::call_engine_op_async(
        "security.remembered_domains_set",
        json!({ "domains": domains }),
    )
    .await
    .map_err(CommandError::engine)?;
    if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
        return Err(CommandError::approval("已记住域名配置未生效（安全域拒绝）"));
    }
    Ok(applied)
}

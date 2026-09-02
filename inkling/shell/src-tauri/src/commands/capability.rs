//! 能力设置命令面（推演档位等持久化；自动审批配置与壳侧审批台账同步）。

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

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
/// `security.auto_approve_set` 门禁同口径）。全量自动审批（
/// `auto_approve_all_review=true`）属高风险提权面：渲染进程可借此跳过
/// 全部 review 审批卡，故开启时须经原生确认对话框二次确认（渲染进程
/// 被攻破时无法伪造原生手势）。
#[tauri::command]
pub(crate) async fn capability_put(
    app: AppHandle,
    state: State<'_, ShellState>,
    record: JsonValue,
) -> Result<JsonValue, CommandError> {
    if record.get("auto_approve_all_review").and_then(JsonValue::as_bool) == Some(true) {
        if !confirm_auto_approve(&app).await {
            return Err(CommandError::approval(
                "全量自动审批未获确认（原生对话框已取消）",
            ));
        }
    }
    // 回合工具上限覆盖（max_tool_rounds 设置项）：正整数校验，越界拒绝
    // 不落盘；保存后触发引擎重建使 llm_decider 立即按新值收口。
    let mut rebuild_after = false;
    if record.get("max_tool_rounds").is_some() {
        let value = record
            .get("max_tool_rounds")
            .and_then(JsonValue::as_u64)
            .ok_or_else(|| {
                CommandError::invalid_arg("max_tool_rounds 须为整数")
            })?;
        if value == 0 || value > 200 {
            return Err(CommandError::invalid_arg(
                "max_tool_rounds 须在 1..=200 之间",
            ));
        }
        rebuild_after = true;
    }
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
        // 先应用（登记边界在安全域内硬拒，失败 = 不落盘）；security.* 为
        // 同步 op（仅注册同步通道），须经同步通道调用（此前误走异步通道
        // 恒返回 unregistered_op，设置保存必失败）
        let applied = crate::engine::host::call_engine_op(
            "security.auto_approve_set",
            json!({ "tools": auto_tools, "all_review": auto_all }),
        )
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
    // 回合工具上限改动 → 引擎重建（桥侧刷新覆盖值后重建回合图，
    // llm_decider 立即按新上限收口；其余字段改动不触发重建）
    if rebuild_after {
        crate::engine::host::call_engine_op_async("engine.rebuild", json!({}))
            .await
            .map_err(CommandError::engine)?;
    }
    Ok(record)
}

/// 逐工具档位覆盖（权限矩阵写面：工具 tab 档位编辑；安全域校验
/// deny 出厂档不可覆盖 + 合法值白名单，失败 = 不落盘）。
#[tauri::command]
pub(crate) async fn security_tier_overrides_set(
    overrides: JsonValue,
) -> Result<JsonValue, CommandError> {
    // security.* 为同步 op（仅注册同步通道），须经同步通道调用
    let applied = crate::engine::host::call_engine_op(
        "security.tier_overrides_set",
        json!({ "overrides": overrides }),
    )
    .map_err(CommandError::engine)?;
    if applied.get("applied").and_then(JsonValue::as_bool) != Some(true) {
        return Err(CommandError::approval("档位覆盖未生效（安全域拒绝）"));
    }
    Ok(applied)
}

/// 全量自动审批开启的原生确认对话框（渲染进程无法伪造原生手势）。
///
/// 确认对话框回调形态（tauri-plugin-dialog v2 的异步 show）；oneshot
/// 通道把回调结果转为可等待——对话框被关闭/回调未触发 = 拒绝（fail-closed）。
async fn confirm_auto_approve(app: &AppHandle) -> bool {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("开启后，回合内所有待审核工具（含 shell_exec 升级）将自动放行，不再弹审批卡。是否确认？")
        .title("开启全量自动审批")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });
    rx.await.unwrap_or(false)
}

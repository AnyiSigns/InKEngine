//! 引擎生命周期命令面（backend_status / engine_boot / first_run_dismiss /
//! 策略层路由预览 route_plan）。

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use crate::ShellState;
use crate::{app_data_dir, ensure_engine, first_run_pending, load_workflow_data, exec_present};

/// 后端状态（前端启动探测：引擎是否就绪/工具面大小/安全模式标志/
/// 首启引导/执行件随包就位/运行形态）。
#[tauri::command]
pub(crate) fn backend_status(app: AppHandle, state: State<'_, ShellState>) -> JsonValue {
    let safe_mode = app_data_dir(&app)
        .map(|dir| crate::domain::recovery::load_boot_state(&dir).safe_mode)
        .unwrap_or(false);
    let first_run = app_data_dir(&app)
        .map(|dir| first_run_pending(&dir))
        .unwrap_or(true);
    let exec_ready = app_data_dir(&app)
        .map(|dir| exec_present(&dir))
        .unwrap_or(false);
    json!({
        "engine_ready": state.backend.engine_ready(),
        "tool_count": state.backend.tool_provider.len(),
        "safe_mode": safe_mode,
        "first_run": first_run,
        "exec_ready": exec_ready,
        "bundled": crate::engine::runtime::bundled_mode(),
    })
}

/// 首启引导关闭（标记落位；下次启动不再展示引导）。
#[tauri::command]
pub(crate) fn first_run_dismiss(app: AppHandle) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    std::fs::write(
        data_dir.join(crate::FIRST_RUN_MARKER),
        serde_json::json!({
            "dismissed_at": chrono::Utc::now().timestamp_millis(),
        })
        .to_string(),
    )
    .map_err(|err| CommandError::io(format!("首启标记写入失败: {err}")))?;
    Ok(json!({ "dismissed": true }))
}

/// 显式装配（懒装配的提前触发；失败 = 结构化错误）。
#[tauri::command]
pub(crate) fn engine_boot(app: AppHandle, state: State<'_, ShellState>) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&app, &state, &data_dir)?;
    let snapshot = state
        .backend
        .engine
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|host| host.report().ok())
        .map(|report| {
            json!({
                "tool_names": report.tool_names,
                "event_types": report.event_types,
            })
        })
        .unwrap_or_else(|| json!({}));
    Ok(json!({ "snapshot": snapshot }))
}

/// 策略层路由预览（任务分类 → 链分流 → 受控计划 → 配额守门）。
#[tauri::command]
pub(crate) fn route_plan(state: State<'_, ShellState>, text: String, tier: String) -> Result<JsonValue, CommandError> {
    let _ = state;
    let workflow_data = load_workflow_data().map_err(CommandError::internal)?;
    let tier = crate::domain::policy::SimulationTier::parse(&tier)
        .map_err(|err| CommandError::invalid_arg(err.to_string()))?;
    let routing = crate::domain::policy::route_round(&text, &workflow_data, None, tier)
        .map_err(CommandError::internal)?;
    Ok(json!({
        "kind": routing.kind.as_str(),
        "chain_id": routing.chain_id,
        "plan": crate::domain::policy::plan_json(&routing.plan),
        "policy": {
            "tier": routing.policy.tier.as_str(),
            "max_simulations": routing.policy.max_simulations,
            "quota_per_round": routing.policy.quota_per_round,
        },
        "quota_guarded": routing.quota_guarded,
    }))
}

/// 运行时生命周期状态（组合引擎 `engine.runtime_state` + 既有 boot/safe/ready
/// 取值逻辑，组装为前端 LifecycleStatus）。
#[tauri::command]
pub(crate) fn runtime_state(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, CommandError> {
    let rt = crate::engine::host::call_engine_op("engine.runtime_state", json!({}))
        .map_err(CommandError::engine)?;
    let engine_state = rt
        .get("state")
        .cloned()
        .unwrap_or_else(|| JsonValue::String("unknown".into()));
    let safe_mode = app_data_dir(&app)
        .map(|dir| crate::domain::recovery::load_boot_state(&dir).safe_mode)
        .unwrap_or(false);
    let boot_state = json!({ "safe_mode": safe_mode });
    let engine_ready = state.backend.engine_ready();
    Ok(json!({
        "state": engine_state,
        "boot_state": boot_state,
        "engine_ready": engine_ready,
        "safe_mode": safe_mode,
    }))
}

/// 运行时暂停（转发到 `engine.runtime_pause` op；仅 running 可暂停）。
#[tauri::command]
pub(crate) fn runtime_pause() -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op("engine.runtime_pause", json!({}))
        .map_err(CommandError::engine)
}

/// 运行时恢复（转发到 `engine.runtime_resume` op；仅 paused 可恢复）。
#[tauri::command]
pub(crate) fn runtime_resume() -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op("engine.runtime_resume", json!({}))
        .map_err(CommandError::engine)
}

/// 运行时关停（转发到 `engine.runtime_stop` op；幂等优雅退出）。
#[tauri::command]
pub(crate) async fn runtime_stop() -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async("engine.runtime_stop", json!({}))
        .await
        .map_err(CommandError::engine)
}

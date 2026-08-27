//! 后台任务域命令面（承载/取消/进度/终态 + 项目任务续跑接线）。

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use super::rounds::resume_round_with_inject;
use crate::ShellState;

/// 启动后台任务（受控承载：经 mpsc 受前端/回合信号驱动，自身不执行引擎
/// 逻辑；事件经既有流式通道留痕，取消经既有链回退通道回退）。
#[tauri::command]
pub(crate) async fn task_start(
    app: AppHandle,
    id: String,
    kind: String,
    goal: String,
    thread_id: Option<String>,
    revert_target: Option<String>,
) -> Result<JsonValue, CommandError> {
    crate::domain::tasks::bind_app(app);
    crate::domain::tasks::registry()
        .start_tracked(
            &id,
            &kind,
            &goal,
            thread_id.as_deref(),
            revert_target.as_deref(),
        )
        .map_err(CommandError::internal)?;
    Ok(json!({ "task_id": id, "started": true }))
}

/// 取消后台任务：cancel token 撤销在途工作 + 发射 task_cancelled + 经既有
/// `engine.thread_revert` 回退链。未知 id / 已终态 → 结构化错误。
#[tauri::command]
pub(crate) fn task_cancel(id: String, reason: Option<String>) -> Result<JsonValue, CommandError> {
    crate::domain::tasks::registry()
        .cancel(
            &id,
            &reason.unwrap_or_else(|| crate::domain::tasks::DEFAULT_CANCEL_REASON.to_string()),
        )
        .map_err(CommandError::internal)?;
    Ok(json!({ "task_id": id, "cancelled": true }))
}

/// 上报后台任务进度（受控路径）。
#[tauri::command]
pub(crate) fn task_progress(id: String, progress: f64, note: Option<String>) -> Result<JsonValue, CommandError> {
    crate::domain::tasks::registry()
        .progress_signal(&id, progress, &note.unwrap_or_default())
        .map_err(CommandError::internal)?;
    Ok(json!({ "task_id": id, "progress": progress }))
}

/// 标记后台任务完成（发射 task_done）。
#[tauri::command]
pub(crate) fn task_finish(id: String, result: String) -> Result<JsonValue, CommandError> {
    crate::domain::tasks::registry()
        .finish_signal(&id, &result)
        .map_err(CommandError::internal)?;
    Ok(json!({ "task_id": id, "finished": true }))
}

/// 标记后台任务失败（发射 task_cancelled 兜底）。
#[tauri::command]
pub(crate) fn task_fail(id: String, reason: String) -> Result<JsonValue, CommandError> {
    crate::domain::tasks::registry()
        .fail_signal(&id, &reason)
        .map_err(CommandError::internal)?;
    Ok(json!({ "task_id": id, "failed": true }))
}

/// 后台任务清单（全部元信息）。
#[tauri::command]
pub(crate) fn task_list() -> JsonValue {
    let metas = crate::domain::tasks::registry().list();
    json!({ "tasks": metas })
}

/// 单后台任务状态（未知 id → 结构化错误）。
#[tauri::command]
pub(crate) fn task_state(id: String) -> Result<JsonValue, CommandError> {
    let meta = crate::domain::tasks::registry()
        .state(&id)
        .map_err(CommandError::internal)?;
    Ok(json!({ "task": meta }))
}

/// 回合续跑并附项目任务对象（经既有 `engine.thread_resume` 通道；inject 透传
/// project_task，引擎零改动感知）。审批决议注入口径与 round_resume 同源；
/// 种子续流（R1）与 round_resume 同路径。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn task_resume(
    app: AppHandle,
    state: State<'_, ShellState>,
    thread_id: String,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
    project_task: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let extra = match project_task {
        Some(pt) => json!({ "project_task": pt }),
        None => json!({}),
    };
    resume_round_with_inject(
        &app,
        &state,
        &thread_id,
        &key,
        &decision,
        reason.as_deref(),
        edited_content,
        extra,
    )
    .await
}

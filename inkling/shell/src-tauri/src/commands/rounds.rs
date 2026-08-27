//! 回合命令面（round_send / round_resume / round_abort + 过程摘要链命令）。
//!
//! R1（种子续流接线）：`round_send` 收尾把步骤快照落盘 checkpoint；
//! `round_resume` 读回 checkpoint 注入种子（不再恒 None）——中断续跑
//! step_id 连续性闭环。
//! R15（账本自动记录）：`round_send` 收尾自动记录回合账本（决议 11，
//! 可配开关：能力记录 `auto_round_ledger` / 环境变量
//! `INKLING_AUTO_ROUND_LEDGER`），前端不再依赖主动调 round_ledger_record。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter, Manager, State};

use super::error::CommandError;
use crate::domain::steps::{RoundStepsTransport, ToolTitleResolver};
use crate::engine::host::{RoundRequest, call_engine_op_async};
use crate::{CAPABILITY_COLLECTION, CAPABILITY_KEY, ShellState, app_data_dir, block_on_op_async, ensure_engine};

// ── 回合 checkpoint（R1：种子续流落盘/读回）──

/// checkpoint 目录名（data_dir 下；回合快照 + 线程最新回合指针）。
const CHECKPOINT_DIR_NAME: &str = "round_checkpoints";

/// 文件名安全化（非字母数字统一为下划线，防路径穿越；与账本同纪律）。
fn sanitize_id(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '_' })
        .collect()
}

fn checkpoint_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(CHECKPOINT_DIR_NAME)
}

fn checkpoint_path(data_dir: &Path, round_id: &str) -> PathBuf {
    checkpoint_dir(data_dir).join(format!("round_{}.json", sanitize_id(round_id)))
}

fn latest_pointer_path(data_dir: &Path, thread_id: &str) -> PathBuf {
    checkpoint_dir(data_dir).join(format!("latest_{}.json", sanitize_id(thread_id)))
}

/// 回合收尾 snapshot 落盘 checkpoint（含线程最新回合指针；供 resume 读回
/// 注入种子）。已完成回合由调用方决定是否落盘。
pub(crate) fn write_round_checkpoint(
    data_dir: &Path,
    thread_id: &str,
    round_id: &str,
    steps: &[JsonValue],
) -> Result<(), String> {
    std::fs::create_dir_all(checkpoint_dir(data_dir))
        .map_err(|err| format!("checkpoint 目录创建失败: {err}"))?;
    let data = json!({ "round_id": round_id, "thread_id": thread_id, "steps": steps });
    let text = serde_json::to_string_pretty(&data)
        .map_err(|err| format!("checkpoint 序列化失败: {err}"))?;
    std::fs::write(checkpoint_path(data_dir, round_id), text)
        .map_err(|err| format!("checkpoint 写入失败: {err}"))?;
    std::fs::write(
        latest_pointer_path(data_dir, thread_id),
        serde_json::to_string(&json!({ "round_id": round_id }))
            .map_err(|err| format!("回合指针序列化失败: {err}"))?,
    )
    .map_err(|err| format!("回合指针写入失败: {err}"))?;
    Ok(())
}

/// 读回合 checkpoint 步骤（种子；无 checkpoint = None）。
pub(crate) fn read_round_checkpoint(data_dir: &Path, round_id: &str) -> Option<Vec<JsonValue>> {
    let text = std::fs::read_to_string(checkpoint_path(data_dir, round_id)).ok()?;
    let parsed: JsonValue = serde_json::from_str(&text).ok()?;
    parsed.get("steps").and_then(JsonValue::as_array).cloned()
}

/// 线程最近回合 id（resume 无 round_id 入参时定位 checkpoint 用）。
fn read_latest_round_id(data_dir: &Path, thread_id: &str) -> Option<String> {
    let text = std::fs::read_to_string(latest_pointer_path(data_dir, thread_id)).ok()?;
    let parsed: JsonValue = serde_json::from_str(&text).ok()?;
    parsed.get("round_id").and_then(JsonValue::as_str).map(str::to_string)
}

/// 清回合 checkpoint（回合完成不再续流）。
fn clear_round_checkpoint(data_dir: &Path, round_id: &str) {
    let _ = std::fs::remove_file(checkpoint_path(data_dir, round_id));
}

// ── 回合记录器 ──

/// 回合记录器（事件弧 + 中止信号 + 工具标题解析挂点）；种子读回既有
/// checkpoint 步骤（R1：不再恒传 None——中断回合重发/resume 的 step_id
/// 与中断前连续）。
fn begin_round_recorder(state: &ShellState, round_id: &str, data_dir: &Path) -> RoundStepsTransport {
    let resolver: ToolTitleResolver = {
        let provider = Arc::clone(&state.backend.tool_provider);
        Arc::new(move |name: &str| {
            let label = provider.resolve_label(name, None);
            if label.contains("（未本地化）") {
                None
            } else {
                Some(label)
            }
        })
    };
    let seed = read_round_checkpoint(data_dir, round_id);
    RoundStepsTransport::with_engine_handles(
        round_id,
        seed,
        None,
        Some(resolver),
        Some(state.backend.abort_signal.clone()),
    )
}

/// 链式事件发射：续跑/回合事件捕获进记录器 + 转发前端（前端 listen
/// 增量渲染；捕获失败只记日志不阻断主流程）。
fn chain_event_emitter(
    state: &ShellState,
    app: &AppHandle,
    recorder: Arc<Mutex<RoundStepsTransport>>,
) {
    let stream_app = app.clone();
    let recorder_capture = recorder;
    if let Some(engine) = state.backend.engine.lock().unwrap().as_ref() {
        engine.set_event_emitter(Some(Box::new(move |event_json: &str| {
            let parsed: JsonValue = serde_json::from_str(event_json).unwrap_or(JsonValue::Null);
            if !parsed.is_null() {
                if let Ok(mut rec) = recorder_capture.lock() {
                    rec.feed(&parsed);
                }
            }
            if let Err(err) = stream_app.emit("inkling://round_event", parsed) {
                eprintln!("[events] 流式事件发射失败: {err}");
            }
        })));
    }
}

// ── R15：回合账本自动记录 ──

/// 自动账本开关：环境变量 `INKLING_AUTO_ROUND_LEDGER`（1/true/on = 开，
/// 0/false/off = 关）优先；缺省读能力记录 `auto_round_ledger`（无记录 =
/// 默认开——决议 11：前端不再依赖主动调 round_ledger_record）。
fn auto_round_ledger_enabled() -> bool {
    if let Ok(value) = std::env::var("INKLING_AUTO_ROUND_LEDGER") {
        let v = value.trim().to_ascii_lowercase();
        return v == "1" || v == "true" || v == "on";
    }
    let record = block_on_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": CAPABILITY_COLLECTION, "key": CAPABILITY_KEY }),
    )
    .unwrap_or(JsonValue::Null);
    record
        .get("auto_round_ledger")
        .and_then(JsonValue::as_bool)
        .unwrap_or(true)
}

/// 自动账本落盘（R15：round_send 收尾确定性归约 + 写账本；失败仅留观测日志）。
fn record_round_ledger_auto(
    data_dir: &Path,
    thread_id: &str,
    round_id: &str,
    intent: Option<&str>,
    conclusion: Option<&str>,
    events: &[JsonValue],
) -> Result<(), String> {
    let dir = crate::domain::round_ledger::ledger_dir(data_dir);
    let ledger = crate::domain::round_ledger::reduce_round(
        thread_id,
        round_id,
        intent,
        conclusion,
        events,
        &json!({}),
        &json!([]),
    );
    crate::domain::round_ledger::write_ledger(&dir, &ledger).map(|_| ())
}

/// 引擎操作失败脱敏（R5：引擎内部错误串可能含路径/堆栈，不透传前端）。
///
/// 前端只拿粗粒度文案（code=ENGINE 信封）；引擎详细错误仅本地审计日志
/// 留痕（trace_id 与信封联动，排障经日志定位）。
fn engine_failure(command: &str, detail: impl std::fmt::Display) -> CommandError {
    let err = CommandError::engine(format!("{command}失败"));
    eprintln!(
        "[rounds] {command} 失败 trace_id={} detail={detail}",
        err.trace_id
    );
    err
}

// ── 回合命令 ──

/// 回合发送：引擎回合驱动（装配会话同线程；返回事件流 + 步骤序列）。
///
/// 回合在宿主线程内执行（Python 事件循环线程亲和性），事件经步骤
/// 记录器收敛为步骤序列（tool 行 title 由解析挂点填充）；审批卡默认
/// 接受决议（交互决议经 [`round_resume`] 注入续跑）。
///
/// 收尾：中断回合（reason ≠ reply）snapshot 落盘 checkpoint（R1）；
/// 自动记录回合账本（R15，可配开关）。
#[tauri::command]
pub(crate) fn round_send(
    app: AppHandle,
    state: State<'_, ShellState>,
    thread_id: String,
    round_id: String,
    text: String,
    auto_accept_review: Option<bool>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&state, &data_dir)?;
    state.backend.abort_signal.begin_round();
    let mut recorder = begin_round_recorder(&state, &round_id, &data_dir);
    {
        let mut slot = state.backend.round.lock().unwrap();
        *slot = Some(recorder.clone());
    }
    // R2（决议 10）：项目任务注入——线程绑定任务的持久化对象读回并
    // 序列化进 inject（引擎零改动感知）；回合后按事件流归约并写回
    // （读 → 注入 → 归约 → 落库完整链）
    let bound_task = crate::domain::tasks::registry()
        .list()
        .into_iter()
        .find(|meta| meta.thread_id.as_deref() == Some(thread_id.as_str()))
        .map(|meta| meta.id.clone())
        .and_then(|task_id| {
            crate::domain::tasks::load_project_task(&data_dir, &task_id)
                .map(|task| (task_id, task))
        });
    let inject = bound_task
        .as_ref()
        .map(|(_, task)| crate::domain::tasks::inject_project_task(task));
    let request = RoundRequest {
        input_text: text.clone(),
        thread_id: thread_id.clone(),
        round_id: round_id.clone(),
        step_args: None,
        orchestrate: None,
        inject,
        auto_accept_review: auto_accept_review.unwrap_or(true),
    };
    let engine_guard = state.backend.engine.lock().unwrap();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| CommandError::internal("引擎未装配（引擎装配失败或尚未就绪）"))?;
    // 事件流式通道：回合内逐事件实时发射（前端 listen 增量渲染）；
    // 发射失败只记日志不阻断回合（事件收集缓冲与返回体照常）。
    let stream_app = app.clone();
    engine.set_event_emitter(Some(Box::new(move |event_json: &str| {
        let parsed: JsonValue = serde_json::from_str(event_json).unwrap_or(JsonValue::Null);
        if let Err(err) = stream_app.emit("inkling://round_event", parsed) {
            eprintln!("[events] 流式事件发射失败: {err}");
        }
    })));
    let outcome = engine
        .round(request)
        .map_err(|err| engine_failure("回合执行", err))?;
    drop(engine_guard);
    // R2：回合事件流归约写回项目任务（绑定线程的任务对象；失败仅观测
    // 日志——任务对象仍保留上一回合状态，不阻断回合返回）
    if let Some((task_id, task)) = bound_task {
        if let Err(err) = crate::domain::tasks::reduce_and_save_project_task(
            &data_dir,
            &task_id,
            &task,
            &outcome.events,
        ) {
            eprintln!("[rounds] 项目任务归约落库失败: {err}");
        }
    }
    for event in &outcome.events {
        recorder.feed(event);
    }
    let steps = recorder.snapshot();
    // R1：中断回合快照落盘 checkpoint（已完成回合不落盘；失败仅观测日志）
    if outcome.reason != "reply" && !steps.is_empty() {
        if let Err(err) = write_round_checkpoint(&data_dir, &thread_id, &round_id, &steps) {
            eprintln!("[rounds] checkpoint 落盘失败: {err}");
        }
    }
    // R15：回合账本自动记录（决议 11——收尾自动触发；失败仅观测日志）
    if auto_round_ledger_enabled() {
        if let Err(err) = record_round_ledger_auto(
            &data_dir,
            &thread_id,
            &round_id,
            Some(&text),
            outcome.output.as_deref(),
            &outcome.events,
        ) {
            eprintln!("[rounds] 回合账本自动记录失败: {err}");
        }
    }
    Ok(json!({
        "round_id": round_id,
        "thread_id": thread_id,
        "reason": outcome.reason,
        "output": outcome.output,
        "events": outcome.events,
        "steps": steps,
    }))
}

/// 回合续跑（审批决议注入：挂起的审批卡 → 决议 → 续跑）。
///
/// 决议 = 中断点 key → inject 值（accept/reject/edit 形态由宿主构造）；
/// 无挂起卡/卡失效 = 引擎侧结构化错误（fail-closed，前端提示重发）。
///
/// R1：续跑记录器读回 checkpoint 种子（step_id 与中断前连续）；续跑事件
/// 链式捕获进记录器并转发前端；回合完成（reply）清 checkpoint，仍挂起则
/// 以新快照更新 checkpoint。
#[tauri::command]
pub(crate) async fn round_resume(
    app: AppHandle,
    state: State<'_, ShellState>,
    thread_id: String,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    resume_round_with_inject(
        &app,
        &state,
        &thread_id,
        &key,
        &decision,
        reason.as_deref(),
        edited_content,
        json!({}),
    )
    .await
}

/// 回合续跑并附最新摘要：加载线程摘要链最新一条，注入 `ledger_summary`
/// 续跑（引擎零改动感知，压缩前事实快照随续跑上下文回流）。
#[tauri::command]
pub(crate) async fn round_resume_with_summary(
    app: AppHandle,
    state: State<'_, ShellState>,
    thread_id: String,
    key: String,
    decision: String,
    reason: Option<String>,
    edited_content: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let latest_summary = crate::domain::round_ledger::load_summary_chain(&dir, &thread_id)
        .last()
        .cloned();
    let extra = match latest_summary {
        Some(summary) => json!({ "ledger_summary": summary }),
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

/// 续跑共享实现（round_resume / round_resume_with_summary / task_resume
/// 共用）：读回 checkpoint 种子 → 链式捕获续跑事件 → thread_resume →
/// 快照随返回体回传 + checkpoint 更新/清理。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resume_round_with_inject(
    app: &AppHandle,
    state: &ShellState,
    thread_id: &str,
    key: &str,
    decision: &str,
    reason: Option<&str>,
    edited_content: Option<JsonValue>,
    extra_inject: JsonValue,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(app)?;
    let round_id = read_latest_round_id(&data_dir, thread_id).unwrap_or_default();
    let recorder = Arc::new(Mutex::new(begin_round_recorder(state, &round_id, &data_dir)));
    {
        let mut slot = state.backend.round.lock().unwrap();
        *slot = Some(recorder.lock().unwrap().clone());
    }
    // R1：续跑事件链式捕获（记录器种子续流）+ 转发前端
    chain_event_emitter(state, app, Arc::clone(&recorder));

    let latest = call_engine_op_async(
        "engine.thread_latest_checkpoint",
        json!({ "thread_id": thread_id }),
    )
    .await
    .map_err(|err| engine_failure("会话检查点读取", err))?;
    let checkpoint_id = latest
        .get("checkpoint_id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| CommandError::not_found("会话无检查点（先发送一条消息）"))?;
    let mut inject = json!({});
    inject[key] = match decision {
        "reject" => json!("reject"),
        "edit" => json!(edited_content.unwrap_or_else(|| json!("accept"))),
        _ => json!("accept"),
    };
    if let JsonValue::Object(extra) = extra_inject {
        for (k, v) in extra {
            inject[k] = v;
        }
    }
    let mut args = json!({
        "thread_id": thread_id,
        "checkpoint_id": checkpoint_id,
        "inject": inject,
    });
    if let Some(reason) = reason {
        args["reason"] = json!(reason);
    }
    let outcome = call_engine_op_async("engine.thread_resume", args)
        .await
        .map_err(|err| engine_failure("回合续跑", err))?;
    let steps = recorder.lock().unwrap().snapshot();
    let resume_reason = outcome
        .get("reason")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    // R1：回合完成清 checkpoint；仍挂起以新快照更新（下一轮 resume 续流）
    if resume_reason == "reply" || steps.is_empty() {
        clear_round_checkpoint(&data_dir, &round_id);
    } else if let Err(err) =
        write_round_checkpoint(&data_dir, thread_id, &round_id, &steps)
    {
        eprintln!("[rounds] checkpoint 续写失败: {err}");
    }
    let mut response = outcome;
    response["steps"] = json!(steps);
    response["round_id"] = json!(round_id);
    Ok(response)
}

/// 回合中止：事件弧关断 + 中止信号握手 + 引擎在途回合取消（R8 接线：
/// engine.abort_current_run 操作通道——引擎侧在途回合在下一个取消检查点
/// 退出；操作调用失败仅留观测日志——中止信号已置位，事件弧已关断，
/// 本地回合通道的取消语义不依赖该 op 成功）。
#[tauri::command]
pub(crate) fn round_abort(state: State<'_, ShellState>, round_id: String) -> Result<JsonValue, CommandError> {
    {
        let mut slot = state.backend.round.lock().unwrap();
        if let Some(recorder) = slot.as_mut() {
            if recorder.round_id() == round_id {
                recorder.abort_current_round();
            }
        }
    }
    state.backend.abort_signal.abort();
    let engine_abort = match crate::block_on_op_async("engine.abort_current_run", json!({})) {
        Ok(outcome) => outcome,
        Err(err) => {
            eprintln!("[rounds] 引擎回合取消调用失败（中止信号已置位，不阻断）: {err}");
            json!({ "ok": false })
        }
    };
    Ok(json!({
        "round_id": round_id,
        "aborted": state.backend.abort_signal.is_aborted(),
        "engine_abort": engine_abort,
    }))
}

/// 例行任务到点触发回合（schedule 工具升级路径）：经既有引擎回合通道拉起
/// 一轮执行，输入即到点动作，引擎零改动感知。本函数供壳后端定时线程调用，
/// 失败仅留观测日志，不阻断定时调度。
pub fn run_routine_round(app: &AppHandle, action: &str) -> Result<JsonValue, String> {
    let data_dir = app_data_dir(app)?;
    let state = app.state::<ShellState>();
    ensure_engine(&state, &data_dir)?;
    let thread_id = format!("routine-{}", chrono::Utc::now().timestamp());
    let round_id = format!("routine-r-{}", uuid::Uuid::new_v4().simple());
    let mut recorder = begin_round_recorder(&state, &round_id, &data_dir);
    let request = RoundRequest {
        input_text: action.to_string(),
        thread_id: thread_id.clone(),
        round_id: round_id.clone(),
        step_args: None,
        orchestrate: None,
        inject: None,
        auto_accept_review: true,
    };
    let engine_guard = state.backend.engine.lock().unwrap();
    let engine = engine_guard
        .as_ref()
        .ok_or_else(|| "引擎未装配（例行回合失败）".to_string())?;
    let outcome = engine
        .round(request)
        .map_err(|err| format!("例行回合失败: {err}"))?;
    drop(engine_guard);
    for event in &outcome.events {
        recorder.feed(event);
    }
    let steps = recorder.snapshot();
    if outcome.reason != "reply" && !steps.is_empty() {
        let _ = write_round_checkpoint(&data_dir, &thread_id, &round_id, &steps);
    }
    Ok(json!({
        "thread_id": thread_id,
        "round_id": round_id,
        "reason": outcome.reason,
    }))
}

// ── 过程摘要链命令（回合账本 / 摘要合并 / 记忆无感提取）──

/// 回合账本记录：壳侧确定性归约回合事件 → 结构化账本落记忆目录，引擎零改动。
///
/// 归约不调模型（零成本、可审计）；账本 = 压缩前的事实快照，留待引擎侧
/// `ledger.merge` op 按需增量压缩。返回落盘路径与账本 JSON。
///
/// 注：命令签名为前端固定契约（Tauri invoke 入参形态），参数数超 lint
/// 阈值属命令面固有形态，维持不动。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) fn round_ledger_record(
    app: AppHandle,
    thread_id: String,
    round_id: String,
    intent: Option<String>,
    conclusion: Option<String>,
    events: JsonValue,
    turn_metrics: Option<JsonValue>,
    audit_events: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let ev_array = events
        .get("events")
        .cloned()
        .unwrap_or_else(|| events.clone())
        .as_array()
        .cloned()
        .unwrap_or_default();
    let tm = turn_metrics.unwrap_or_else(|| json!({}));
    let au = audit_events.unwrap_or_else(|| json!([]));
    let ledger = crate::domain::round_ledger::reduce_round(
        &thread_id,
        &round_id,
        intent.as_deref(),
        conclusion.as_deref(),
        &ev_array,
        &tm,
        &au,
    );
    let path = crate::domain::round_ledger::write_ledger(&dir, &ledger)
        .map_err(|err| CommandError::io(format!("回合账本落盘失败: {err}")))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "ledger": ledger.to_json(),
    }))
}

/// 回合账本摘要链读取（append-only 可回溯）。
#[tauri::command]
pub(crate) fn round_ledger_chain(app: AppHandle, thread_id: String) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let chain = crate::domain::round_ledger::load_summary_chain(&dir, &thread_id);
    Ok(json!({ "thread_id": thread_id, "chain": chain }))
}

/// 回合账本容量滚动（按 N 周或 N MB 上限，与 fingerprint_cache 同语义）：
/// 超龄最旧删、超限最旧删；不传 thread_id 则全量线程滚动。
#[tauri::command]
pub(crate) fn round_ledger_roll(
    app: AppHandle,
    thread_id: Option<String>,
    max_bytes: Option<i64>,
    max_age_days: Option<i64>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let max_bytes = max_bytes
        .unwrap_or(crate::domain::round_ledger::DEFAULT_MAX_BYTES as i64)
        as u64;
    let max_age = max_age_days.unwrap_or(crate::domain::round_ledger::DEFAULT_MAX_AGE_DAYS);
    let removed = match thread_id {
        Some(t) => crate::domain::round_ledger::roll_ledgers(&dir, &t, max_bytes, max_age)
            .map_err(CommandError::internal)?,
        None => {
            let mut total = 0usize;
            for t in crate::domain::round_ledger::list_thread_ids(&dir) {
                total += crate::domain::round_ledger::roll_ledgers(&dir, &t, max_bytes, max_age)
                    .map_err(CommandError::internal)?;
            }
            total
        }
    };
    Ok(json!({ "removed": removed }))
}

/// 回合账本摘要合并：汇总线程最新摘要 + 账本事实快照，经引擎 `ledger.merge`
/// op 复用压缩形态产出增量摘要，落回摘要链（append-only）并滚动留界。
#[tauri::command]
pub(crate) async fn round_ledger_merge(
    app: AppHandle,
    thread_id: String,
    old_summary: Option<String>,
    ledgers: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let old = old_summary.or_else(|| {
        crate::domain::round_ledger::load_summary_chain(&dir, &thread_id)
            .last()
            .cloned()
    });
    let leds = ledgers
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_else(|| crate::domain::round_ledger::load_ledger_jsons(&dir, &thread_id));
    let merged = call_engine_op_async(
        "ledger.merge",
        json!({
            "thread_id": thread_id,
            "old_summary": old,
            "new_ledgers": leds,
        }),
    )
    .await
    .map_err(|err| engine_failure("账本摘要合并", err))?;
    if let Some(summary) = merged.get("summary").and_then(|v| v.as_str()) {
        crate::domain::round_ledger::append_summary(&dir, &thread_id, summary)
            .map_err(|err| CommandError::io(format!("摘要链追加失败: {err}")))?;
        let _ = crate::domain::round_ledger::roll_summary_chain(
            &dir,
            &thread_id,
            crate::domain::round_ledger::SUMMARY_CHAIN_KEEP,
        );
    }
    Ok(merged)
}

/// 记忆无感提取：回合账本（用户意图/结论/确认）经引擎 `memory.extract` op
/// 规则抽取（零 LLM）→ 冲突仲裁（新旧并存留痕）入记忆。
#[tauri::command]
pub(crate) async fn round_memory_extract(
    thread_id: String,
    ledger: JsonValue,
) -> Result<JsonValue, CommandError> {
    let _ = thread_id;
    call_engine_op_async("memory.extract", json!({ "ledger": ledger }))
        .await
        .map_err(|err| engine_failure("记忆提取", err))
}

// ── 单元测试 ──

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("rounds_test_{}", uuid::Uuid::new_v4().simple()))
    }

    #[test]
    fn checkpoint_roundtrip_preserves_steps() {
        let dir = tmp_dir();
        let steps = vec![
            json!({ "step_id": "think:1", "type": "thinking", "payload": { "content": "既有" } }),
            json!({ "step_id": "card:1", "type": "review_card", "payload": { "payload": {} } }),
        ];
        write_round_checkpoint(&dir, "th-1", "r-1", &steps).expect("落盘须成功");
        let read = read_round_checkpoint(&dir, "r-1").expect("读回须命中");
        assert_eq!(read, steps, "checkpoint 步骤须原样读回");
        assert_eq!(read_latest_round_id(&dir, "th-1").as_deref(), Some("r-1"));
        clear_round_checkpoint(&dir, "r-1");
        assert!(read_round_checkpoint(&dir, "r-1").is_none(), "清理后应无 checkpoint");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn checkpoint_absent_returns_none_seed() {
        let dir = tmp_dir();
        assert!(read_round_checkpoint(&dir, "missing").is_none());
        assert!(read_latest_round_id(&dir, "missing").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_prevents_path_traversal_in_ids() {
        assert_eq!(sanitize_id("../evil"), "___evil");
        assert_eq!(sanitize_id("a/b"), "a_b");
    }

    #[test]
    fn auto_ledger_env_switch_off_disables() {
        std::env::set_var("INKLING_AUTO_ROUND_LEDGER", "0");
        // 无引擎可查：回落默认 true，但环境变量关闭优先 → false
        assert!(!auto_round_ledger_enabled());
        std::env::set_var("INKLING_AUTO_ROUND_LEDGER", "true");
        assert!(auto_round_ledger_enabled());
        std::env::remove_var("INKLING_AUTO_ROUND_LEDGER");
        // 无能力记录（引擎不可用）→ 默认开（决议 11）
        assert!(auto_round_ledger_enabled());
    }
}

//! 回合命令面（round_send / round_resume / round_abort + 过程摘要链命令）。
//!
//! R1（种子续流接线）：`round_send` 收尾把步骤快照经引擎 records 通道写
//! checkpoint；`round_resume` 读回 checkpoint 注入种子（不再恒 None）——
//! 中断续跑 step_id 连续性闭环。
//! R15（账本自动记录）：`round_send` 收尾自动记录回合账本（决议 11，
//! 可配开关：能力记录 `auto_round_ledger` / 环境变量
//! `INKLING_AUTO_ROUND_LEDGER`），前端不再依赖主动调 round_ledger_record。

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter, State};

use super::error::CommandError;
use crate::domain::steps::{RoundStepsTransport, ToolTitleResolver};
use crate::engine::host::{RoundRequest, call_engine_op_async};
use crate::{CAPABILITY_COLLECTION, CAPABILITY_KEY, ShellState, app_data_dir, block_on, block_on_op_async, ensure_engine};

// ── 回合 checkpoint（R1：种子续流经引擎 records 通道）──

/// checkpoint 集合名（引擎 records 通道；回合快照 + 线程最新回合指针）。
const ROUND_CHECKPOINT_COLLECTION: &str = "round_checkpoints";

/// 线程最新回合指针键（与回合快照同集合，键加 latest_ 前缀避免与 round id 冲突）。
fn latest_checkpoint_key(thread_id: &str) -> String {
    format!("latest_{}", thread_id)
}

/// 回合收尾 snapshot 经 records 通道落 checkpoint（含线程最新回合指针；
/// 供 resume 读回注入种子）。已完成回合由调用方决定是否落盘。
async fn write_round_checkpoint(
    thread_id: &str,
    round_id: &str,
    steps: &[JsonValue],
) -> Result<(), String> {
    call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": ROUND_CHECKPOINT_COLLECTION,
            "key": round_id,
            "data": json!({ "round_id": round_id, "thread_id": thread_id, "steps": steps }),
        }),
    )
    .await
    .map_err(|err| format!("checkpoint 写入失败: {err}"))?;
    call_engine_op_async(
        "engine.records_put",
        json!({
            "collection": ROUND_CHECKPOINT_COLLECTION,
            "key": latest_checkpoint_key(thread_id),
            "data": json!({ "round_id": round_id }),
        }),
    )
    .await
    .map_err(|err| format!("回合指针写入失败: {err}"))?;
    Ok(())
}

/// 读回合 checkpoint 步骤（种子；无 checkpoint = None）。
async fn read_round_checkpoint(round_id: &str) -> Option<Vec<JsonValue>> {
    let record = call_engine_op_async(
        "engine.records_get",
        json!({ "collection": ROUND_CHECKPOINT_COLLECTION, "key": round_id }),
    )
    .await
    .ok()?;
    record.get("steps").and_then(JsonValue::as_array).cloned()
}

/// 线程最近回合 id（resume 无 round_id 入参时定位 checkpoint 用）。
async fn read_latest_round_id(thread_id: &str) -> Option<String> {
    let record = call_engine_op_async(
        "engine.records_get",
        json!({ "collection": ROUND_CHECKPOINT_COLLECTION, "key": latest_checkpoint_key(thread_id) }),
    )
    .await
    .ok()?;
    record.get("round_id").and_then(JsonValue::as_str).map(str::to_string)
}

/// 清回合 checkpoint（回合完成不再续流）。
async fn clear_round_checkpoint(round_id: &str) {
    let _ = call_engine_op_async(
        "engine.records_delete",
        json!({ "collection": ROUND_CHECKPOINT_COLLECTION, "key": round_id }),
    )
    .await;
}

/// 清线程最新回合指针（checkpoint 清除后同步清指针，避免 resume 读到悬空 latest）。
async fn clear_latest_pointer(thread_id: &str) {
    let _ = call_engine_op_async(
        "engine.records_delete",
        json!({ "collection": ROUND_CHECKPOINT_COLLECTION, "key": latest_checkpoint_key(thread_id) }),
    )
    .await;
}

// ── 回合记录器 ──

/// 回合记录器（事件弧 + 中止信号 + 工具标题解析挂点）；种子读回既有
/// checkpoint 步骤（R1：不再恒传 None——中断回合重发/resume 的 step_id
/// 与中断前连续）。
async fn begin_round_recorder(state: &ShellState, round_id: &str) -> RoundStepsTransport {
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
    let seed = read_round_checkpoint(round_id).await;
    RoundStepsTransport::with_engine_handles(
        round_id,
        seed,
        None,
        Some(resolver),
        Some(state.backend.abort_signal.clone()),
    )
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
) -> Result<JsonValue, String> {
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
    crate::domain::round_ledger::write_ledger(&dir, &ledger)?;
    Ok(ledger.to_json())
}

/// 自动记忆提取（账本 → 记忆闭环：回合收尾静默触发，失败仅观测日志）。
///
/// 复用 `memory.extract` 引擎 op——零 LLM 规则抽取（意图/结论/确认事件）
/// + 冲突仲裁（新旧并存留痕），把回合账本沉淀为可召回记忆。账本已落盘，
/// 提取失败不影响回合返回（观测侧语义）。
fn auto_extract_memory(
    thread_id: &str,
    ledger_json: &JsonValue,
) -> Result<(), String> {
    let result = block_on_op_async(
        "memory.extract",
        json!({ "thread_id": thread_id, "ledger": ledger_json }),
    )?;
    let stored = result.get("stored").and_then(JsonValue::as_array).map(|v| v.len()).unwrap_or(0);
    if stored > 0 {
        eprintln!("[rounds] 回合账本 → 记忆提取完成（{} 条落记忆库）", stored);
    }
    Ok(())
}

/// 自动演化触发（知识集 → 演化闭环：回合收尾低频，失败仅观测日志）。
///
/// 复用 `knowledge.evolve` 引擎 op——失败驱动反思式变异 + 三层闸门防退化，
/// 变异体经 KNOWLEDGE 补丁落集补丁链。低频语义：每 N 回合触发一批（N =
/// review.json evolve_interval_rounds / 缺省 10），批量小（单批 1 条防膨胀）。
/// 无候选 = 空结果。
fn auto_evolve(thread_id: &str, round_counter: &mut u64) -> Result<(), String> {
    *round_counter = round_counter.wrapping_add(1);
    if *round_counter % evolve_interval_rounds() != 0 {
        return Ok(());
    }
    let result = block_on_op_async(
        "knowledge.evolve",
        json!({ "thread_id": thread_id, "limit": 1 }),
    )?;
    let outcomes = result
        .get("outcomes")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let landed: usize = outcomes
        .iter()
        .map(|o| o.get("variants").and_then(JsonValue::as_array).map(|v| v.len()).unwrap_or(0))
        .sum();
    if landed > 0 {
        eprintln!("[rounds] 知识演化批次完成（{} 变异体落位）", landed);
    }
    Ok(())
}

/// 演化触发频率（回合）：每 N 回合触发一批进化（低频防膨胀/防每回合开销）。
///
/// N 取自评审配方数据 `review.json` 的 `evolve_interval_rounds`（缺省回落 10；
/// 读档失败/字段缺失不报错——启动首次读取后缓存）。
static EVOLVE_INTERVAL_ROUNDS: OnceLock<u64> = OnceLock::new();

/// 读取评审配方数据（seed_data/review.json；与 load_workflow_data 同风格）。
/// W-7 修复：路径经 seed_root() 定位（与装配数据装载同源，git worktree
/// 形态下不再依赖 CARGO_MANIFEST_DIR 多级相对回溯）。
fn load_review_data() -> Result<JsonValue, String> {
    let path = crate::seed_root().join("seed_data").join("review.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|err| format!("评审数据读取失败 {}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("评审数据 JSON 非法: {err}"))
}

/// 演化触发间隔（回合）：读 review.json `evolve_interval_rounds`；缺失/失败回落 10。
fn evolve_interval_rounds() -> u64 {
    *EVOLVE_INTERVAL_ROUNDS.get_or_init(|| {
        load_review_data()
            .ok()
            .and_then(|v| v.get("evolve_interval_rounds").and_then(JsonValue::as_u64))
            .unwrap_or(10)
    })
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
    model: Option<JsonValue>,
    attachments: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    ensure_engine(&app, &state, &data_dir)?;
    state.backend.abort_signal.begin_round();
    let mut recorder = block_on(begin_round_recorder(&state, &round_id));
    {
        let mut slot = state.backend.round.lock().unwrap();
        *slot = Some(recorder.clone());
    }
    // 后台任务域已废弃（定时走前台 sleep 工具），不再有线程绑定任务的
    // 注入/归约接线；项目任务对象保留为独立模块（见 domain/tasks.rs）。
    let request = RoundRequest {
        input_text: text.clone(),
        thread_id: thread_id.clone(),
        round_id: round_id.clone(),
        step_args: None,
        orchestrate: None,
        inject: None,
        model,
        // 附件（引擎 Attachment 契约数组）：随回合开篇用户消息注入
        attachments,
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
    // 收尾清 emitter：避免上一轮 emitter 泄漏到后续不设 emitter 的回合，
    // 把事件误推前端、混入错误 round（#1）。
    engine.set_event_emitter(None);
    drop(engine_guard);
    for event in &outcome.events {
        recorder.feed(event);
    }
    let steps = recorder.snapshot();
    // R1：中断回合快照落盘 checkpoint（已完成回合不落盘；失败仅观测日志）
    if outcome.reason != "reply" && !steps.is_empty() {
        if let Err(err) = block_on(write_round_checkpoint(&thread_id, &round_id, &steps)) {
            eprintln!("[rounds] checkpoint 落盘失败: {err}");
        }
    }
    // R15：回合账本自动记录（决议 11——收尾自动触发；失败仅观测日志）
    if auto_round_ledger_enabled() {
        let ledger_json = record_round_ledger_auto(
            &data_dir,
            &thread_id,
            &round_id,
            Some(&text),
            outcome.output.as_deref(),
            &outcome.events,
        );
        match &ledger_json {
            Ok(ledger) => {
                // 账本 → 记忆闭环（意图/结论/确认事件规则抽取入记忆库）
                if let Err(err) = auto_extract_memory(&thread_id, ledger) {
                    eprintln!("[rounds] 回合账本记忆提取失败: {err}");
                }
            }
            Err(err) => eprintln!("[rounds] 回合账本自动记录失败: {err}"),
        }
    }
    // R15b：账本摘要链自动合并（阈值触发：自上次合并后新增账本 ≥ 10 条；
    // 零 LLM 确定性压缩；失败仅观测日志，不阻断回合返回）
    if auto_round_ledger_enabled() {
        if let Err(err) = block_on_ledger_merge(&data_dir, &thread_id) {
            eprintln!("[rounds] 账本摘要链自动合并失败: {err}");
        }
    }
    // 演化闭环：知识集低频批次（每 N 回合触发一批；失败仅观测日志）
    {
        let mut counter = state.backend.evolution_round_counter.lock().unwrap();
        if let Err(err) = auto_evolve(&thread_id, &mut counter) {
            eprintln!("[rounds] 知识演化自动触发失败: {err}");
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

/// 续跑共享实现（round_resume / round_resume_with_summary 共用）：
/// 读回 checkpoint 种子 → 链式捕获续跑事件 → thread_resume →
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
    // 续跑开启新一轮：清中止态，避免沿用上一轮 abort 信号（#2：recorder.feed
    // 轮询 abort_signal 早退 → 步骤恒空 → 误清 checkpoint）；与 round_send
    // 开头 begin_round 同口径。
    state.backend.abort_signal.begin_round();
    let _data_dir = app_data_dir(app)?;
    let round_id = read_latest_round_id(thread_id).await.unwrap_or_default();
    let recorder = Arc::new(Mutex::new(begin_round_recorder(state, &round_id).await));
    {
        let mut slot = state.backend.round.lock().unwrap();
        *slot = Some(recorder.lock().unwrap().clone());
    }
    // 续跑事件发射：只发前端（#3 统一为与 round_send 同口径——recorder
    // 不再由 emitter 喂入，统一在回合结束后用 transport 缓冲事件喂入，
    // 避免 emitter 双路径/步骤重复累积）。
    {
        let guard = state.backend.engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            let stream_app = app.clone();
            engine.set_event_emitter(Some(Box::new(move |event_json: &str| {
                let parsed: JsonValue = serde_json::from_str(event_json).unwrap_or(JsonValue::Null);
                if let Err(err) = stream_app.emit("inkling://round_event", parsed) {
                    eprintln!("[events] 流式事件发射失败: {err}");
                }
            })));
        }
    }

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
    // 续跑经 inner 锁串行化（#4：与 EngineHost::round 同款），避免与在途
    // round_send 并发双 ainvoke（快速 send/resume 竞态）。thread_resume 为
    // 同步方法（内部持 inner 锁阻塞驱动），调用方持 engine 守卫跨同步调用即可。
    let outcome = {
        let guard = state.backend.engine.lock().unwrap();
        let engine = guard
            .as_ref()
            .ok_or_else(|| CommandError::internal("引擎未装配（回合续跑）"))?;
        engine
            .thread_resume(thread_id, checkpoint_id, inject, reason)
            .map_err(|err| engine_failure("回合续跑", err))?
    };
    // 统一喂 recorder（#3）：回合结束后取 transport 缓冲事件（与 round_send
    // 同口径），不再由 emitter 喂入，确保步骤快照完整且不重复。
    {
        let guard = state.backend.engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            let events = engine.take_transport_events();
            for event in &events {
                recorder.lock().unwrap().feed(event);
            }
            // 清 emitter，避免泄漏到后续回合（与 round_send 收尾同口径，#1）。
            engine.set_event_emitter(None);
        }
    }
    let steps = recorder.lock().unwrap().snapshot();
    let resume_reason = outcome
        .get("reason")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    // R1：回合完成清 checkpoint；仍挂起以新快照更新（下一轮 resume 续流）
    if resume_reason == "reply" || steps.is_empty() {
        clear_round_checkpoint(&round_id).await;
        // 同步清 latest 指针，避免后续 resume 读到已被清除的 round（seed 空 → 续流 step_id 连续性丢失）
        clear_latest_pointer(thread_id).await;
    } else if let Err(err) =
        write_round_checkpoint(thread_id, &round_id, &steps).await
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
    // 关断事件弧同时清 emitter（中止后不再有在途回合推前端；与 round_send
    // 收尾同口径，避免 emitter 泄漏到后续不设 emitter 的回合，#1）。
    {
        let guard = state.backend.engine.lock().unwrap();
        if let Some(engine) = guard.as_ref() {
            engine.set_event_emitter(None);
        }
    }
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

/// 回合账本清单读取（某线程全部账本，按时间序；主会话页账本视图数据源）。
#[tauri::command]
pub(crate) fn round_ledger_list(app: AppHandle, thread_id: String) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let dir = crate::domain::round_ledger::ledger_dir(&data_dir);
    let mut ledgers = crate::domain::round_ledger::load_ledger_jsons(&dir, &thread_id);
    ledgers.sort_by_key(|l| l.get("created_at").and_then(JsonValue::as_i64).unwrap_or(0));
    Ok(json!({ "thread_id": thread_id, "ledgers": ledgers }))
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

/// 账本摘要链自动合并（回合收尾静默触发）：自上次合并后新增账本
/// ≥ `AUTO_MERGE_THRESHOLD` 条才合并一次——只压缩增量账本（零 LLM
/// 确定性压缩），推进合并标记后下次只处理新账本，避免重复压缩质量衰减。
async fn auto_merge_ledger_chain(data_dir: &Path, thread_id: &str) -> Result<(), String> {
    let dir = crate::domain::round_ledger::ledger_dir(data_dir);
    let new_ledgers = crate::domain::round_ledger::new_ledgers_since_marker(&dir, thread_id);
    if new_ledgers.len() < crate::domain::round_ledger::AUTO_MERGE_THRESHOLD {
        return Ok(());
    }
    let old = crate::domain::round_ledger::load_summary_chain(&dir, thread_id)
        .last()
        .cloned();
    let merged = call_engine_op_async(
        "ledger.merge",
        json!({
            "thread_id": thread_id,
            "old_summary": old,
            "new_ledgers": new_ledgers,
        }),
    )
    .await
    .map_err(|err| format!("引擎账本合并失败: {err}"))?;
    if let Some(summary) = merged.get("summary").and_then(|v| v.as_str()) {
        crate::domain::round_ledger::append_summary(&dir, thread_id, summary)
            .map_err(|err| format!("摘要链追加失败: {err}"))?;
        let _ = crate::domain::round_ledger::roll_summary_chain(
            &dir,
            thread_id,
            crate::domain::round_ledger::SUMMARY_CHAIN_KEEP,
        );
        if let Some(last_id) = new_ledgers
            .last()
            .and_then(|l| l.get("round_id").and_then(JsonValue::as_str))
        {
            crate::domain::round_ledger::save_merge_marker(&dir, thread_id, last_id)
                .map_err(|err| format!("合并标记推进失败: {err}"))?;
        }
    }
    Ok(())
}

/// 同步驱动账本自动合并（round_send 无 tokio 上下文时使用；单线程运行时
/// 内完成，与 `block_on_op_async` 的引擎线程亲和纪律一致）。
fn block_on_ledger_merge(data_dir: &Path, thread_id: &str) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("合并运行时创建失败: {err}"))?
        .block_on(auto_merge_ledger_chain(data_dir, thread_id))
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

    #[test]
    fn latest_checkpoint_key_prefixes_thread() {
        assert_eq!(latest_checkpoint_key("th-1"), "latest_th-1");
    }

    #[test]
    fn evolve_interval_rounds_reads_review_default() {
        // review.json 含 evolve_interval_rounds = 10；读档/字段缺失回落 10
        assert_eq!(evolve_interval_rounds(), 10);
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

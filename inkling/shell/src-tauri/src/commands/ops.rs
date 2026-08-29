//! 引擎 op 薄转发命令面（A 类：前端已按命令名调用、后端此前未注册的转换命令）。
//!
//! 全部为异步 Tauri 命令，经 `crate::engine::host` 的 op 通道转发到
//! bridge.py 注册表对应 op。引擎 op 分同步/异步两通道：异步 op 走
//! `call_engine_op_async`，同步 op 走 `call_engine_op`（invoke_async 仅派发
//! 异步注册表，同步 op 须经同步通道）；参数缺省时回退空对象（兼容前端
//! 无参调用）。点号命令名经 `#[command(rename = "...")]` 暴露给前端。

use serde_json::{json, Value as JsonValue};
use tauri::command;

use super::error::CommandError;

/// 转发到异步引擎 op（参数缺省时回退空对象）。
async fn forward_async(op: &str, args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::engine::host::call_engine_op_async(op, args)
        .await
        .map_err(CommandError::engine)
}

/// 转发到同步引擎 op（参数缺省时回退空对象；在异步命令体内同步阻塞派发）。
fn forward_sync(op: &str, args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::engine::host::call_engine_op(op, args).map_err(CommandError::engine)
}

#[command]
pub(crate) async fn assemble_stats(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("assemble_stats", args).await
}

#[command]
pub(crate) async fn graph_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("graph.snapshot", args)
}

#[command]
pub(crate) async fn graph_instance_snapshot(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_async("graph.instance_snapshot", args).await
}

#[command]
pub(crate) async fn pool_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("pool.snapshot", args)
}

#[command]
pub(crate) async fn pool_evaluate(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("pool.evaluate", args)
}

#[command]
pub(crate) async fn edge_evidence_list(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("edge_evidence.list", args).await
}

#[command]
pub(crate) async fn edge_evidence_update(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("edge_evidence.update", args).await
}

#[command]
pub(crate) async fn path_assemble(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("path.assemble", args).await
}

#[command]
pub(crate) async fn path_clear_candidate(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("path.clear_candidate", args).await
}

#[command]
pub(crate) async fn path_set_assembler_enabled(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_sync("path.set_assembler_enabled", args)
}

#[command]
pub(crate) async fn cache_stats(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("cache.stats", args).await
}

#[command]
pub(crate) async fn cache_clear(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("cache.clear", args).await
}

#[command(rename = "why.audit")]
pub(crate) async fn why_audit(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("why.audit", args).await
}

#[command(rename = "sovereignty.snapshot")]
pub(crate) async fn sovereignty_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("sovereignty.snapshot", args).await
}

#[command(rename = "suggestion.scan")]
pub(crate) async fn suggestion_scan(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("suggestion.scan", args)
}

#[command(rename = "growth.report")]
pub(crate) async fn growth_report(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("report.growth", args).await
}

/// 审计流水（只读）：读取 `set_audit` 集合（append-only 干预/自修改留痕）。
/// 洞察事件时间线的历史底账源；集合缺省 set_audit，可由参数覆盖。
#[command(rename = "audit.list")]
pub(crate) async fn audit_list(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let collection = args
        .as_ref()
        .and_then(JsonValue::as_object)
        .and_then(|m| m.get("collection"))
        .and_then(JsonValue::as_str)
        .map(String::from)
        .unwrap_or_else(|| "set_audit".to_string());
    forward_async("engine.records_list", Some(json!({ "collection": collection }))).await
}

#[command(rename = "ui_spec.get")]
pub(crate) async fn ui_spec_get(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("ui_spec.get", args)
}

#[command(rename = "ui_spec.apply")]
pub(crate) async fn ui_spec_apply(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("ui_spec.apply", args).await
}

#[command(rename = "ui_spec.revert_latest")]
pub(crate) async fn ui_spec_revert_latest(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_async("ui_spec.revert_latest", args).await
}

#[command(rename = "model.reload")]
pub(crate) async fn model_reload(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("model.reload", args).await
}

#[command(rename = "ui_components.get")]
pub(crate) async fn ui_components_get(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("engine.ui_components_get", args)
}

#[command(rename = "ui_components.set_disabled")]
pub(crate) async fn ui_components_set_disabled(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_async("engine.ui_components_set_disabled", args).await
}

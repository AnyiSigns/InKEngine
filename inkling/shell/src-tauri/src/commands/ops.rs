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

/// 转发到同步引擎 op（参数缺省时回退空对象；同步引擎调用在 tokio 阻塞
/// 池内执行——异步命令体内直接同步调会长时间占用 async worker）。
async fn forward_sync(op: &str, args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    let op = op.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        crate::engine::host::call_engine_op(&op, args).map_err(CommandError::engine)
    })
    .await
    .map_err(|err| CommandError::internal(format!("同步 op 派发任务失败: {err}")))?
}

#[command]
pub(crate) async fn assemble_stats(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("assemble_stats", args).await
}

#[command]
pub(crate) async fn graph_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("graph.snapshot", args).await
}

#[command]
pub(crate) async fn graph_instance_snapshot(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_async("graph.instance_snapshot", args).await
}

#[command]
pub(crate) async fn pool_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("pool.snapshot", args).await
}

#[command]
pub(crate) async fn entities_snapshot(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("entities.snapshot", args).await
}

#[command]
pub(crate) async fn pool_evaluate(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("pool.evaluate", args).await
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
    forward_sync("path.set_assembler_enabled", args).await
}

#[command]
pub(crate) async fn cache_stats(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("cache.stats", args).await
}

#[command]
pub(crate) async fn cache_clear(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("cache.clear", args).await
}

#[command(rename = "growth.report")]
pub(crate) async fn growth_report(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("report.growth", args).await
}

/// 审计清单默认条数上限（时间窗模式未显式传 limit 时的兜底截断，
/// 防全量膨胀）。
const AUDIT_DEFAULT_LIMIT: usize = 2000;

/// 审计清单单次最大条数（导出分页窗口；防前端一次拉全量审计集合）。
const AUDIT_MAX_LIMIT: usize = 5000;

/// 审计记录时间戳提取：`ts`（秒）或 `created_at`；无时间戳 = None（不进
/// 时间窗过滤但保留排序兜底）。
fn audit_record_ts(record: &JsonValue) -> Option<f64> {
    for key in ["ts", "created_at"] {
        if let Some(ts) = record.get(key).and_then(JsonValue::as_f64) {
            return Some(ts);
        }
    }
    None
}

/// 可读审计集合白名单（防前端任意指定集合名越权读取引擎其它记录面）。
const AUDIT_READABLE_COLLECTIONS: &[&str] = &["set_audit", "sessions"];

/// 审计时间窗过滤 + 条数截断（纯函数，窗口化路径专用）：按时间倒序
/// （最新在前）取最近 `limit` 条。`limit` 缺省 = AUDIT_DEFAULT_LIMIT。
/// 无窗口参数（limit/after/before 均缺）= 原样透传（不排序不截断）。
fn apply_audit_window(
    list: Vec<JsonValue>,
    limit: Option<usize>,
    after: Option<f64>,
    before: Option<f64>,
) -> Vec<JsonValue> {
    if limit.is_none() && after.is_none() && before.is_none() {
        return list;
    }
    let mut list = list;
    list.retain(|record| {
        let ts = match audit_record_ts(record) {
            Some(ts) => ts,
            None => return after.is_none() && before.is_none(),
        };
        after.is_none_or(|after| ts >= after) && before.is_none_or(|before| ts <= before)
    });
    list.sort_by(|a, b| {
        let ta = audit_record_ts(a).unwrap_or(0.0);
        let tb = audit_record_ts(b).unwrap_or(0.0);
        tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
    });
    let limit = limit.unwrap_or(AUDIT_DEFAULT_LIMIT).clamp(1, AUDIT_MAX_LIMIT);
    list.truncate(limit);
    list
}

/// 窗口参数透传载荷构造（纯函数；audit_list 窗口化路径使用）。
///
///  下推：带窗口参数时把归一化后的 limit/after/before 传给引擎
/// `engine.records_list`（limit 缺省 = AUDIT_DEFAULT_LIMIT、钳
/// 1..=AUDIT_MAX_LIMIT），引擎在存储读取侧完成过滤/倒序/截断。
fn audit_window_forward_payload(
    collection: &str,
    limit: Option<usize>,
    after: Option<f64>,
    before: Option<f64>,
) -> JsonValue {
    let effective_limit = limit
        .unwrap_or(AUDIT_DEFAULT_LIMIT)
        .clamp(1, AUDIT_MAX_LIMIT);
    let mut payload = json!({
        "collection": collection,
        "limit": effective_limit,
    });
    if let Some(after) = after {
        payload["after"] = json!(after);
    }
    if let Some(before) = before {
        payload["before"] = json!(before);
    }
    payload
}

/// 审计流水（只读）：读取 `set_audit` 集合（append-only 干预/自修改留痕）。
/// 洞察事件时间线的历史底账源。
///
/// R5 窗口语义：仅当调用方显式传 `limit`/`after`/`before`（任一带参）才
/// 应用时间窗 + 倒序 + 截断（`limit` 1..=AUDIT_MAX_LIMIT，缺省
/// AUDIT_DEFAULT_LIMIT；`after`/`before` 为 epoch 秒时间窗，含端点）。
///  下推：带参时窗口参数透传 `engine.records_list`，引擎读取侧完成
/// 过滤/倒序/截断（审计长文件不再整表 JSON 序列化 + 跨边界传输）；壳侧
/// 再按同一窗口归一（幂等），返回体与直接窗口一致。
/// 无参调用 = 原样转发 `engine.records_list` 的集合顺序/全量——保持与
/// 改动前历史契约一致（洞察等既有消费方不静默截断反转）；新消费方
/// （audit_recovery 导出等）显式传 limit 取窗口形态。
#[command(rename = "audit.list")]
pub(crate) async fn audit_list(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    let collection = args
        .get("collection")
        .and_then(JsonValue::as_str)
        .map(String::from)
        .unwrap_or_else(|| "set_audit".to_string());
    if !AUDIT_READABLE_COLLECTIONS.contains(&collection.as_str()) {
        return Err(CommandError::invalid_arg(format!(
            "审计集合不可读: {collection}"
        )));
    }
    let limit = args.get("limit").and_then(JsonValue::as_u64).map(|n| n as usize);
    let after = args.get("after").and_then(JsonValue::as_f64);
    let before = args.get("before").and_then(JsonValue::as_f64);
    if limit.is_some() || after.is_some() || before.is_some() {
        // 窗口参数透传引擎侧下推（）：引擎 records_list 返回前已按窗口
        // 过滤/倒序/截断——审计长文件不再整表 JSON 序列化 + 跨边界传输。
        // 壳侧再按同一窗口归一（幂等）：返回体与直接窗口（全量上应用
        // apply_audit_window）一致，纯函数继续在窗口化路径生效。
        let forwarded = audit_window_forward_payload(&collection, limit, after, before);
        let records = forward_async("engine.records_list", Some(forwarded)).await?;
        let list = records.as_array().cloned().unwrap_or_default();
        return Ok(JsonValue::Array(apply_audit_window(list, limit, after, before)));
    }
    let records = forward_async(
        "engine.records_list",
        Some(json!({ "collection": collection })),
    )
    .await?;
    Ok(records)
}

#[command(rename = "ui_spec.get")]
pub(crate) async fn ui_spec_get(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("ui_spec.get", args).await
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

#[command(rename = "todo.get")]
pub(crate) async fn todo_get(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_async("todo.get", args).await
}

#[command(rename = "ui_components.get")]
pub(crate) async fn ui_components_get(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward_sync("engine.ui_components_get", args).await
}

#[command(rename = "ui_components.set_disabled")]
pub(crate) async fn ui_components_set_disabled(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward_async("engine.ui_components_set_disabled", args).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(ts: f64, key: &str) -> JsonValue {
        json!({ "key": key, "ts": ts })
    }

    #[test]
    fn audit_window_passthrough_unchanged_without_params() {
        // R5：无参 = 原样（集合顺序/全量）——洞察等既有消费方的历史契约，
        // 不静默截断反转。
        let records = vec![record(3.0, "c"), record(1.0, "a"), record(2.0, "b")];
        let out = apply_audit_window(records.clone(), None, None, None);
        assert_eq!(out, records, "无窗口参数须原样透传集合顺序/全量");
    }

    #[test]
    fn audit_window_desc_truncates_on_explicit_limit() {
        // 显式 limit：按时间倒序（最新在前）+ 截断。
        let records = vec![record(1.0, "a"), record(5.0, "e"), record(3.0, "c")];
        let out = apply_audit_window(records, Some(2), None, None);
        let keys: Vec<&str> = out.iter().map(|r| r["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["e", "c"], "应倒序取最近 2 条");
    }

    #[test]
    fn audit_window_filters_by_time_bounds() {
        let records = vec![
            record(1.0, "a"),
            record(3.0, "c"),
            record(4.0, "d"),
            record(5.0, "e"),
        ];
        // after=2.5, before=4.5 → c/d（含端点语义），倒序 d,c
        let out = apply_audit_window(records, None, Some(2.5), Some(4.5));
        let keys: Vec<&str> = out.iter().map(|r| r["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["d", "c"]);
    }

    #[test]
    fn audit_window_keeps_timeless_records_when_no_bounds() {
        let records = vec![record(2.0, "b"), json!({ "key": "x" })];
        // 时间窗打开但 after/before 均缺：无时间戳记录仍保留（排序兜底 0）
        let out = apply_audit_window(records, None, None, None);
        assert_eq!(out.len(), 2);
        // 显式 after 后：无时间戳记录被过滤（无法证实在窗内）
        let out = apply_audit_window(vec![json!({ "key": "x" }), record(5.0, "e")], None, Some(4.0), None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["key"], "e");
    }

    #[test]
    fn audit_window_forward_payload_normalizes_limit() {
        //  下推：窗口参数经壳归一（limit 缺省 2000、钳 1..=AUDIT_MAX_LIMIT）
        // 后传给引擎 records_list——引擎读取侧收敛返回体。
        let payload = audit_window_forward_payload("set_audit", None, None, None);
        assert_eq!(payload["collection"], "set_audit");
        assert_eq!(payload["limit"], AUDIT_DEFAULT_LIMIT as u64);
        assert!(payload.get("after").is_none());
        let payload = audit_window_forward_payload("set_audit", Some(9999), Some(1.5), Some(3.5));
        assert_eq!(payload["limit"], AUDIT_MAX_LIMIT as u64, "limit 超上限应钳制");
        assert_eq!(payload["after"], 1.5);
        assert_eq!(payload["before"], 3.5);
        let payload = audit_window_forward_payload("set_audit", Some(3), None, None);
        assert_eq!(payload["limit"], 3u64);
        assert!(payload.get("after").is_none());
        assert!(payload.get("before").is_none());
    }

    #[test]
    fn audit_window_forward_payload_matches_local_window_semantics() {
        // 透传载荷经壳 apply_audit_window 归一后 = 直接窗口（同参数下引擎
        // 窗口返回体与壳直接窗口语义一致——壳侧幂等归一不改变返回体）。
        let records = vec![record(1.0, "a"), record(5.0, "e"), record(3.0, "c")];
        let payload = audit_window_forward_payload("set_audit", Some(2), None, None);
        assert_eq!(payload["limit"], 2u64);
        let direct = apply_audit_window(records.clone(), Some(2), None, None);
        let keys: Vec<&str> = direct.iter().map(|r| r["key"].as_str().unwrap()).collect();
        assert_eq!(keys, vec!["e", "c"]);
        // 引擎窗口返回体（e/c）再过壳窗口 = 不变（幂等）
        let engine_windowed: Vec<JsonValue> = vec![record(5.0, "e"), record(3.0, "c")];
        let normalized = apply_audit_window(engine_windowed, Some(2), None, None);
        assert_eq!(normalized, direct);
    }
}

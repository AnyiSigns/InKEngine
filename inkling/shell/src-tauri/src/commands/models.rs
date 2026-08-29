//! 模型档案 / 上下文指标 / 路径多径 / 缓存 / 信任档命令面。

use serde_json::{json, Value as JsonValue};
use tauri::AppHandle;

use super::error::CommandError;
use crate::app_data_dir;

/// 读取模型档案快照（全部已探测/补录档案，按 model_id 字典序）。
#[tauri::command]
pub(crate) fn model_archive_snapshot(app: AppHandle) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    let store = crate::domain::model_archive::ModelArchiveStore::open_in_data_dir(&data_dir)
        .map_err(CommandError::io)?;
    let archives = store
        .list()
        .map_err(CommandError::io)?
        .iter()
        .map(|a| a.to_json())
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "archives": archives }))
}

/// 读取模型连接配置（上次探测保存的 base_url / api_key）。
#[tauri::command]
pub(crate) fn models_config_get(app: AppHandle) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    Ok(crate::domain::model_archive::read_model_connection(&data_dir))
}

/// 触发模型清单探测与回写（连接配置保存/变更时调用）。
///
/// 入参：`base_url`/`api_key`（连接配置）+ `models`（宣告模型列表
/// `[{ "tier": "main"|"router", "model_id": "..." }]`，降级补录用）。
/// 探测失败/非 JSON/缺字段 → 结构化降级（按档位缺省窗口回落），不崩溃。
/// 连接配置探测成功后持久化供下次 / 真实模型注入回落使用。
#[tauri::command]
pub(crate) async fn models_refresh(app: AppHandle, config: JsonValue) -> Result<JsonValue, CommandError> {
    let base_url = config
        .get("base_url")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let api_key = config
        .get("api_key")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let declared: Vec<crate::domain::model_archive::DeclaredModel> = config
        .get("models")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let model_id = item.get("model_id")?.as_str()?.to_string();
                    let tier = item
                        .get("tier")
                        .and_then(JsonValue::as_str)
                        .unwrap_or("main")
                        .to_string();
                    Some(crate::domain::model_archive::DeclaredModel { tier, model_id })
                })
                .collect()
        })
        .unwrap_or_default();
    let data_dir = app_data_dir(&app)?;
    let mut store = crate::domain::model_archive::ModelArchiveStore::open_in_data_dir(&data_dir)
        .map_err(CommandError::io)?;
    let fetcher = crate::domain::model_archive::HttpModelsFetcher::new();
    let report = crate::domain::model_archive::refresh_archives(
        &mut store,
        &fetcher,
        &base_url,
        &api_key,
        &declared,
    )
    .await
    .map_err(CommandError::internal)?;
    let saved = if report.mode == crate::domain::model_archive::RefreshMode::Success {
        crate::domain::model_archive::write_model_connection(
            &data_dir,
            &json!({ "base_url": base_url, "api_key": api_key }),
        )
    } else {
        json!({ "base_url": base_url, "api_key": api_key })
    };
    Ok(json!({
        "ok": true,
        "mode": if report.mode == crate::domain::model_archive::RefreshMode::Success { "success" } else { "fallback" },
        "probed": report.probed,
        "stored": report.stored,
        "reason": report.reason,
        "connection_saved": saved,
    }))
}

/// 上下文指标快照（转发至嵌入桥 `metrics.snapshot` op；聚合回合/LLM/
/// 缓存/边证据指标，走既有引擎操作通道）。
#[tauri::command]
pub(crate) async fn metrics_snapshot(args: JsonValue) -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async("metrics.snapshot", args)
        .await
        .map_err(CommandError::engine)
}

/// 候选路径人工选择（透传至 `path.choose_candidate` op；干预即生效 + 审计）。
#[tauri::command]
pub(crate) async fn path_choose_candidate(
    candidate_id: Option<String>,
    domain: Option<String>,
    chain: Option<JsonValue>,
    fingerprint: Option<String>,
) -> Result<JsonValue, CommandError> {
    let mut args = json!({
        "candidateId": candidate_id.unwrap_or_default(),
        "domain": domain.unwrap_or_else(|| "default".to_string()),
    });
    if let Some(chain) = chain {
        args["chain"] = chain;
    }
    if let Some(fingerprint) = fingerprint {
        args["fingerprint"] = JsonValue::String(fingerprint);
    }
    crate::engine::host::call_engine_op_async("path.choose_candidate", args)
        .await
        .map_err(CommandError::engine)
}

/// 多径开关（透传至 `path.set_multipath` op；单块翻转保留其余装配开关）。
#[tauri::command]
pub(crate) async fn path_set_multipath(enabled: bool) -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async("path.set_multipath", json!({ "enabled": enabled }))
        .await
        .map_err(CommandError::engine)
}

/// 指纹缓存语义化失效（透传至 `cache.invalidate` op；清除后同请求不再命中）。
#[tauri::command]
pub(crate) async fn cache_invalidate(scope: String, reason: Option<String>) -> Result<JsonValue, CommandError> {
    let mut args = json!({ "scope": scope });
    if let Some(reason) = reason {
        args["reason"] = JsonValue::String(reason);
    }
    crate::engine::host::call_engine_op_async("cache.invalidate", args)
        .await
        .map_err(CommandError::engine)
}

/// 指纹缓存重建（透传至 `cache.rebuild` op；清空指定域缓存 → 下次访问重算）。
#[tauri::command]
pub(crate) async fn cache_rebuild(domain: Option<String>) -> Result<JsonValue, CommandError> {
    let mut args = json!({});
    if let Some(domain) = domain {
        args["domain"] = JsonValue::String(domain);
    }
    crate::engine::host::call_engine_op_async("cache.rebuild", args)
        .await
        .map_err(CommandError::engine)
}

/// 信任档人工降级（透传至 `edge.downgrade_tier` op；降级前快照可复原）。
#[tauri::command]
pub(crate) async fn edge_downgrade_tier(
    edge_id: String,
    tier: Option<String>,
) -> Result<JsonValue, CommandError> {
    let mut args = json!({ "edgeId": edge_id });
    if let Some(tier) = tier {
        args["tier"] = JsonValue::String(tier);
    }
    crate::engine::host::call_engine_op_async("edge.downgrade_tier", args)
        .await
        .map_err(CommandError::engine)
}

/// 信任档人工恢复（透传至 `edge.restore_tier` op；从降级快照回写原计数）。
#[tauri::command]
pub(crate) async fn edge_restore_tier(edge_id: String) -> Result<JsonValue, CommandError> {
    crate::engine::host::call_engine_op_async("edge.restore_tier", json!({ "edgeId": edge_id }))
        .await
        .map_err(CommandError::engine)
}

/// 模型连接配置落盘（settings_put 的替代：前端 model_section 改调此名）。
#[tauri::command]
pub(crate) async fn models_config_put(
    app: AppHandle,
    config: JsonValue,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(&app)?;
    crate::domain::model_archive::write_model_connection(&data_dir, &config);
    // 运行期生效：通知引擎重载模型配置（宿未装配 = 下次启动生效，不报错）
    let reloaded = crate::engine::host::call_engine_op_async(
        "model.reload",
        json!({}),
    )
    .await;
    if let Err(err) = reloaded {
        tracing::warn!("模型配置已落盘，但运行期重载未生效（下次启动生效）: {err}");
    }
    Ok(config)
}

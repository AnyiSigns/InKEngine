//! infer 协议层：stdio JSON-RPC 方法面（传输健壮性 + 嵌入方法分派）。
//!
//! 方法面：`ping` + `infer.plan`（来源/维度/降级原因解析，懒触发）+
//! `infer.embed`（texts → vectors，按 embedder.rs resolve_plan 三态路由：
//! 本地 ONNX / 远端 openai_compat / 确定性保底）。错误走 JSON-RPC 错误码
//! （-32000 携带 data.reason），诊断行落 stderr。

use std::sync::OnceLock;

use serde_json::{Value as JsonValue, json};

use ink_ts_rpc::code::{
    EXEC_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR,
    error_response, log_line, message_id, response,
};

use crate::embedder::{EmbedSource, EmbedderPlan, LocalOnnxEmbedder, RemoteEndpoint};

/// 单次 embed 请求文本条数上界（防超大批量拖垮进程）。
const EMBED_TEXTS_MAX: usize = 256;
/// 单条文本长度上界（字符）。
const EMBED_TEXT_MAX_CHARS: usize = 100_000;

/// 协议错误（JSON-RPC 码 + 文案 + 机器可读 reason）。
pub struct RpcFailure {
    pub code: i64,
    pub message: String,
    pub reason: &'static str,
}

/// 协议会话：嵌入器（懒解析计划）+ 推理运行时（block_on 用）。
pub struct InferContext {
    pub embedder: LocalOnnxEmbedder,
    rt: OnceLock<tokio::runtime::Runtime>,
}

impl InferContext {
    /// 默认构造：嵌入器按环境解析（INK_EMBEDDING_* 全覆盖）。
    pub fn from_env() -> Self {
        Self {
            embedder: LocalOnnxEmbedder::new(),
            rt: OnceLock::new(),
        }
    }

    fn runtime(&self) -> &tokio::runtime::Runtime {
        self.rt
            .get_or_init(|| tokio::runtime::Runtime::new().expect("嵌入推理运行时构建失败"))
    }

    fn block_on<T>(&self, future: impl std::future::Future<Output = T>) -> T {
        self.runtime().block_on(future)
    }
}

/// EmbedSource → 线协议来源名。
fn source_name(source: &EmbedSource) -> &'static str {
    match source {
        EmbedSource::LocalOnnx => "local_onnx",
        EmbedSource::Remote => "remote",
        EmbedSource::Deterministic => "deterministic",
    }
}

/// 计划 → 线协议形态（remote 只透出端点不含密钥）。
fn plan_payload(plan: &EmbedderPlan) -> JsonValue {
    json!({
        "source": source_name(&plan.source),
        "dim": plan.dim,
        "note": plan.note,
        "remote": plan.remote.as_ref().map(remote_payload),
    })
}

fn remote_payload(remote: &RemoteEndpoint) -> JsonValue {
    json!({
        "base_url": remote.base_url,
        "model_id": remote.model_id,
        "adapter": remote.adapter,
    })
}

/// 处理一行输入：返回要写往 stdout 的响应行（None = 通知，无需响应）。
pub fn handle_line(line: &str, ctx: &InferContext) -> Option<String> {
    let msg: JsonValue = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            let detail = format!("JSON 解析错误: {err}");
            log_line("rpc", "error", "", &JsonValue::Null, 0, Some(&detail));
            return Some(json_string(error_response(
                &JsonValue::Null,
                PARSE_ERROR,
                detail,
                None,
            )));
        }
    };
    let obj = match msg {
        JsonValue::Object(map) => map,
        JsonValue::Array(_) => {
            return Some(json_string(error_response(
                &JsonValue::Null,
                INVALID_REQUEST,
                "批处理（数组消息）不受支持".to_string(),
                None,
            )))
        }
        _ => {
            return Some(json_string(error_response(
                &JsonValue::Null,
                INVALID_REQUEST,
                "消息须为 JSON-RPC 请求对象".to_string(),
                None,
            )))
        }
    };
    let Some(id) = message_id(&JsonValue::Object(obj.clone())) else {
        return None; // 无 id = 通知：不响应
    };
    let id = match id {
        Ok(id) => id,
        Err(()) => {
            return Some(json_string(error_response(
                &JsonValue::Null,
                INVALID_REQUEST,
                "id 须为 number/string/null".to_string(),
                None,
            )))
        }
    };
    let method = match obj.get("method").and_then(JsonValue::as_str) {
        Some(method) => method.to_string(),
        None => {
            let message = "消息缺 method".to_string();
            log_line("rpc", "error", "", &id, 0, Some(&message));
            return Some(json_string(error_response(&id, INVALID_REQUEST, message, None)));
        }
    };
    let params = obj.get("params").cloned().unwrap_or(JsonValue::Null);
    let outcome: Result<Option<JsonValue>, RpcFailure> = match method.as_str() {
        "ping" => Ok(Some(response(&id, JsonValue::Object(Default::default())))),
        "infer.plan" => match handle_plan(ctx, &params) {
            Ok(result) => Ok(Some(response(&id, result))),
            Err(failure) => Err(failure),
        },
        "infer.embed" => match handle_embed(ctx, &params) {
            Ok(result) => Ok(Some(response(&id, result))),
            Err(failure) => Err(failure),
        },
        _ if method.starts_with("notifications/") => {
            Ok(Some(response(&id, JsonValue::Object(Default::default()))))
        }
        _ => Err(RpcFailure {
            code: METHOD_NOT_FOUND,
            message: format!("方法未实现: {method}"),
            reason: "method",
        }),
    };
    match outcome {
        Ok(Some(resp)) => {
            log_line("rpc", "info", &method, &id, 0, None);
            Some(json_string(resp))
        }
        Ok(None) => {
            log_line("rpc", "info", &method, &id, 0, None);
            None
        }
        Err(failure) => {
            let detail = format!("{}/{}", failure.reason, failure.message);
            log_line("rpc", "error", &method, &id, 0, Some(&detail));
            Some(json_string(error_response(
                &id,
                failure.code,
                failure.message,
                Some(json!({ "reason": failure.reason })),
            )))
        }
    }
}

/// infer.plan：当前解析出的来源/维度/降级原因（懒触发解析，不载模型）。
fn handle_plan(ctx: &InferContext, _params: &JsonValue) -> Result<JsonValue, RpcFailure> {
    let plan = ctx.embedder.plan();
    Ok(plan_payload(plan))
}

/// infer.embed：texts → vectors（保底/远端/本地按 resolve_plan 路由）。
fn handle_embed(ctx: &InferContext, params: &JsonValue) -> Result<JsonValue, RpcFailure> {
    let obj = params
        .as_object()
        .ok_or_else(|| invalid_params("infer.embed 参数须为对象"))?;
    let texts_raw = obj
        .get("texts")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("infer.embed 缺 texts（字符串数组）"))?;
    if texts_raw.is_empty() {
        return Err(invalid_params("infer.embed texts 不能为空"));
    }
    if texts_raw.len() > EMBED_TEXTS_MAX {
        return Err(RpcFailure {
            code: EXEC_ERROR,
            message: format!("texts 条数超限（≤{EMBED_TEXTS_MAX}）"),
            reason: "size",
        });
    }
    let mut texts = Vec::with_capacity(texts_raw.len());
    for text in texts_raw {
        let text = text
            .as_str()
            .ok_or_else(|| invalid_params("texts 元素须为字符串"))?;
        if text.chars().count() > EMBED_TEXT_MAX_CHARS {
            return Err(RpcFailure {
                code: EXEC_ERROR,
                message: format!("单条文本超长（≤{EMBED_TEXT_MAX_CHARS} 字符）"),
                reason: "size",
            });
        }
        texts.push(text.to_string());
    }
    let plan = ctx.embedder.plan();
    let vectors = ctx
        .block_on(ctx.embedder.aembed_documents(&texts))
        .map_err(|err| RpcFailure {
            code: EXEC_ERROR,
            message: format!("嵌入失败: {err}"),
            reason: "embed",
        })?;
    Ok(json!({
        "source": source_name(&plan.source),
        "dim": plan.dim,
        "note": plan.note,
        "vectors": vectors,
    }))
}

fn invalid_params(message: &str) -> RpcFailure {
    RpcFailure {
        code: INVALID_PARAMS,
        message: message.to_string(),
        reason: "params",
    }
}

fn json_string(value: JsonValue) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embedder::EmbedderPlan;

    fn parse_response(line: &str) -> JsonValue {
        serde_json::from_str(line).expect("响应须为 JSON")
    }

    fn ctx_deterministic() -> InferContext {
        // 显式注入确定性保底计划（aembed 纯本地，不触碰模型/网络）
        InferContext {
            embedder: LocalOnnxEmbedder::with_plan(EmbedderPlan {
                source: EmbedSource::Deterministic,
                dim: 384,
                note: Some("测试保底".to_string()),
                remote: None,
            }),
            rt: OnceLock::new(),
        }
    }

    fn call(ctx: &InferContext, line: &str) -> Option<String> {
        handle_line(line, ctx)
    }

    #[test]
    fn plan_reports_deterministic_source() {
        let ctx = ctx_deterministic();
        let resp = call(&ctx, r#"{"jsonrpc":"2.0","id":1,"method":"infer.plan","params":{}}"#).unwrap();
        let result = parse_response(&resp)["result"].clone();
        assert_eq!(result["source"], "deterministic");
        assert_eq!(result["dim"], 384);
        assert_eq!(result["note"], "测试保底");
    }

    #[test]
    fn embed_returns_deterministic_unit_vectors() {
        let ctx = ctx_deterministic();
        let resp = call(
            &ctx,
            r#"{"jsonrpc":"2.0","id":2,"method":"infer.embed","params":{"texts":["输入一","输入二"]}}"#,
        )
        .unwrap();
        let result = parse_response(&resp)["result"].clone();
        assert_eq!(result["source"], "deterministic");
        let vectors = result["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 2);
        for vector in vectors {
            let values: Vec<f64> = vector
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap())
                .collect();
            assert_eq!(values.len(), 384);
            let norm: f64 = values.iter().map(|x| x * x).sum::<f64>().sqrt();
            assert!((norm - 1.0).abs() < 1e-6, "向量须单位化: {norm}");
        }
        // 同文再生同向量（确定性保底断言交给 embedder 单测；这里验证跨协议稳定性）
        let again = call(
            &ctx,
            r#"{"jsonrpc":"2.0","id":3,"method":"infer.embed","params":{"texts":["输入一"]}}"#,
        )
        .unwrap();
        let first = &vectors[0];
        let rerun = &parse_response(&again)["result"]["vectors"][0];
        assert_eq!(first, rerun);
    }

    #[test]
    fn embed_requires_non_empty_texts() {
        let ctx = ctx_deterministic();
        let resp = call(&ctx, r#"{"jsonrpc":"2.0","id":4,"method":"infer.embed","params":{"texts":[]}}"#).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "params");
    }

    #[test]
    fn ping_and_unknown_method() {
        let ctx = ctx_deterministic();
        let resp = call(&ctx, r#"{"jsonrpc":"2.0","id":5,"method":"ping"}"#).unwrap();
        assert!(parse_response(&resp).get("result").is_some());
        let resp = call(&ctx, r#"{"jsonrpc":"2.0","id":6,"method":"no/such"}"#).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["code"], METHOD_NOT_FOUND as f64);
    }

    #[test]
    fn notification_gets_no_response() {
        let ctx = ctx_deterministic();
        assert!(call(&ctx, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).is_none());
    }
}

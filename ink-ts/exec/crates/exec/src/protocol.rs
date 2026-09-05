//! JSON-RPC 方法面（exec 侧协议层）：传输健壮性 + 方法分派。
//!
//! 方法面：`ping`（健康探测）+ `exec.call`（信封执行）。exec.call 参数 =
//! { body, signature }：body 为信封 JSON 紧凑文本，signature = 会话密钥
//! HMAC-SHA256(body) 十六进制。复核与执行对象是同一串 body 字节——先验
//! 签名（fail-closed：无密钥/签名不符一律拒绝），再解析信封并走守门执行。

use serde_json::{Value as JsonValue, json};

use super::envelope::Deny;
use super::hmac::{constant_time_eq, hex_encode, hmac_sha256};
use super::ops;
use super::Executor;
use ink_ts_rpc::code::{
    EXEC_ERROR, INVALID_PARAMS, INVALID_REQUEST, METHOD_NOT_FOUND, PARSE_ERROR,
    error_response, log_line, message_id, response,
};

/// 信封 body 文本长度上界（字符；防超大 body 轰炸解析）。
const BODY_MAX_CHARS: usize = 1 << 20;

/// 执行失败（协议码 + 文案 + 机器可读 reason 分类）。
pub struct RpcFailure {
    pub code: i64,
    pub message: String,
    pub reason: &'static str,
}

impl RpcFailure {
    fn deny(deny: Deny) -> Self {
        Self {
            code: EXEC_ERROR,
            message: deny.message,
            reason: deny.reason,
        }
    }
}

/// 处理一行输入：返回要写往 stdout 的响应行（None = 通知，无需响应）。
pub fn handle_line(line: &str, executor: &Executor) -> Option<String> {
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
        "exec.call" => match handle_exec_call(executor, &params) {
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

/// exec.call：验签 → 解析信封 → 守门执行。
fn handle_exec_call(executor: &Executor, params: &JsonValue) -> Result<JsonValue, RpcFailure> {
    let Some(session_key) = &executor.key else {
        return Err(RpcFailure {
            code: EXEC_ERROR,
            message: "exec 会话密钥缺失（宿主须经 INK_EXEC_SESSION_KEY 注入）——fail-closed".to_string(),
            reason: "no_key",
        });
    };
    let obj = params
        .as_object()
        .ok_or_else(|| invalid_params("exec.call 参数须为对象"))?;
    let body = obj
        .get("body")
        .and_then(JsonValue::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid_params("缺 body（信封 JSON 紧凑文本）"))?;
    if body.chars().count() > BODY_MAX_CHARS {
        return Err(RpcFailure {
            code: EXEC_ERROR,
            message: format!("body 超长（≤{BODY_MAX_CHARS} 字符）"),
            reason: "size",
        });
    }
    let signature = obj
        .get("signature")
        .and_then(JsonValue::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid_params("缺 signature（HMAC-SHA256(body) 十六进制）"))?;
    let expected = hmac_sha256(session_key.as_bytes(), body.as_bytes());
    let expected_hex = hex_encode(&expected);
    if !constant_time_eq(signature.as_bytes(), expected_hex.as_bytes()) {
        return Err(RpcFailure {
            code: EXEC_ERROR,
            message: "信封签名校验失败（拒绝执行）".to_string(),
            reason: "signature",
        });
    }
    let envelope: super::envelope::Envelope = serde_json::from_str(body).map_err(|err| {
        RpcFailure {
            code: INVALID_PARAMS,
            message: format!("信封解析失败: {err}"),
            reason: "params",
        }
    })?;
    let output = ops::execute(&envelope).map_err(RpcFailure::deny)?;
    Ok(json!({
        "tool": envelope.tool,
        "op": envelope.op,
        "endpoint": envelope.endpoint,
        "output": output,
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
    use serde_json::json;

    fn parse_response(line: &str) -> JsonValue {
        serde_json::from_str(line).expect("响应须为 JSON")
    }

    fn call(key: &str, line: &str) -> Option<String> {
        handle_line(line, &Executor::with_key(Some(key.to_string())))
    }

    fn sign(key: &str, body: &str) -> String {
        hex_encode(&hmac_sha256(key.as_bytes(), body.as_bytes()))
    }

    /// 构造合法信封 body（roots 指向临时目录）。
    fn sample_body() -> String {
        json!({
            "version": 1,
            "id": "op-1",
            "tool": "process_exec",
            "op": "process",
            "args": { "argv": ["echo", "signed-ok"] },
            "endpoint": "os",
            "roots": [std::env::temp_dir().to_string_lossy()],
            "allowlist": ["echo"],
            "allow_domains": [],
            "cwd": std::env::temp_dir().to_string_lossy(),
            "env": null,
            "timeout_secs": 10,
            "max_chars": 4096,
            "nonce": "n1",
            "issued_at": 1,
            "decision": { "approved": true, "by": "test", "trace_id": null }
        })
        .to_string()
    }

    fn call_exec(key: &str, body: &str, signature: &str) -> Option<String> {
        call(
            key,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "exec.call",
                "params": { "body": body, "signature": signature } })
            .to_string(),
        )
    }

    #[test]
    fn ping_returns_empty_result() {
        let resp = call("k", r#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#).unwrap();
        assert!(parse_response(&resp).get("result").is_some());
    }

    #[test]
    fn missing_key_fails_closed() {
        let body = sample_body();
        let resp = call_exec("", &body, &sign("k", &body)).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "no_key");
    }

    #[test]
    fn bad_signature_is_rejected() {
        let body = sample_body();
        let resp = call_exec("k", &body, "deadbeef").unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "signature");
        assert!(error["message"].as_str().unwrap().contains("签名"));
    }

    #[test]
    fn valid_signature_executes_process() {
        let envelope = if cfg!(windows) {
            json!({
                "version": 1, "id": "op-1", "tool": "process_exec", "op": "process",
                "args": { "argv": ["cmd", "/C", "echo", "signed-ok"] },
                "endpoint": "os",
                "roots": [std::env::temp_dir().to_string_lossy()],
                "allowlist": ["cmd", "echo"],
                "allow_domains": [],
                "cwd": std::env::temp_dir().to_string_lossy(),
                "env": null, "timeout_secs": 10, "max_chars": 4096,
                "nonce": "n1", "issued_at": 1,
                "decision": { "approved": true, "by": "test", "trace_id": null }
            })
        } else {
            json!({
                "version": 1, "id": "op-1", "tool": "process_exec", "op": "process",
                "args": { "argv": ["echo", "signed-ok"] },
                "endpoint": "os",
                "roots": [std::env::temp_dir().to_string_lossy()],
                "allowlist": ["echo"],
                "allow_domains": [],
                "cwd": std::env::temp_dir().to_string_lossy(),
                "env": null, "timeout_secs": 10, "max_chars": 4096,
                "nonce": "n1", "issued_at": 1,
                "decision": { "approved": true, "by": "test", "trace_id": null }
            })
        };
        let body = envelope.to_string();
        let resp = call_exec("k", &body, &sign("k", &body)).unwrap();
        let result = parse_response(&resp)["result"].clone();
        assert_eq!(result["tool"], "process_exec");
        assert_eq!(result["output"]["exit_code"], 0);
        assert!(result["output"]["stdout"].as_str().unwrap().contains("signed-ok"));
    }

    #[test]
    fn out_of_allowlist_rejected_mechanically() {
        let body = json!({
            "version": 1, "id": "op-2", "tool": "process_exec", "op": "process",
            "args": { "argv": ["evil-tool-xyz"] },
            "endpoint": "os",
            "roots": [std::env::temp_dir().to_string_lossy()],
            "allowlist": ["git"],
            "allow_domains": [],
            "cwd": std::env::temp_dir().to_string_lossy(),
            "env": null, "timeout_secs": 10, "max_chars": 4096,
            "nonce": "n2", "issued_at": 1,
            "decision": { "approved": true, "by": "test", "trace_id": null }
        }).to_string();
        let resp = call_exec("k", &body, &sign("k", &body)).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "allowlist");
        assert!(error["message"].as_str().unwrap().contains("evil-tool-xyz"));
    }

    #[test]
    fn unapproved_decision_envelope_rejected() {
        let mut body: JsonValue = serde_json::from_str(&sample_body()).unwrap();
        body["decision"]["approved"] = JsonValue::Bool(false);
        let body = body.to_string();
        let resp = call_exec("k", &body, &sign("k", &body)).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "decision");
    }

    #[test]
    fn unknown_method_is_32601() {
        let resp = call("k", r#"{"jsonrpc":"2.0","id":9,"method":"no/such"}"#).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["code"], METHOD_NOT_FOUND as f64);
    }
}

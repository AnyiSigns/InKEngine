//! JSON-RPC 2.0 错误码常量与响应/诊断行构造（与 inkling/exec 协议同款）。
//!
//! 错误码用常量表达（禁魔法数字）：解析错误 -32700 / 非法请求 -32600 /
//! 方法未实现 -32601 / 参数非法 -32602 / 内部错误 -32603，执行失败
//! -32000（MCP server 错误区间，ts_seed_pack 同款）。无 id 消息按规范
//! 视为通知、不响应（由调用方的 handle_line 判定，本模块只提供构造件）。

use serde_json::{Value, json};

/// 解析错误：非法 JSON 文本。
pub const PARSE_ERROR: i64 = -32700;
/// 非法请求：消息不是合法请求形态。
pub const INVALID_REQUEST: i64 = -32600;
/// 方法未实现：未知 method。
pub const METHOD_NOT_FOUND: i64 = -32601;
/// 参数非法：方法已知但参数不符合契约。
pub const INVALID_PARAMS: i64 = -32602;
/// 内部错误：服务内部异常。
pub const INTERNAL_ERROR: i64 = -32603;
/// 执行错误（机制件执行失败/守门拒绝区间）。
pub const EXEC_ERROR: i64 = -32000;

/// 构造成功响应值。
pub fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 构造错误响应值（可带结构化 data，供调用方按 reason 分类守门拒绝）。
pub fn error_response(id: &Value, code: i64, message: String, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(payload) = data {
        error["data"] = payload;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

/// 消息 id 提取：合法 id = number/string/null；无 id = 通知（None）。
pub fn message_id(msg: &Value) -> Option<Result<Value, ()>> {
    let id = msg.get("id")?;
    if matches!(id, Value::Number(_) | Value::String(_) | Value::Null) {
        Some(Ok(id.clone()))
    } else {
        Some(Err(()))
    }
}

/// 当前墙钟毫秒（供诊断行 ts 字段）。
pub fn epoch_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 诊断行写入 stderr（JSON 单行：事件/请求 id/耗时/成败/细节）。
#[allow(clippy::too_many_arguments)]
pub fn log_line(
    event: &str,
    level: &str,
    method: &str,
    id: &Value,
    duration_ms: u128,
    detail: Option<&str>,
) {
    let mut line = json!({
        "ts": epoch_ms() as f64,
        "level": level,
        "event": event,
        "duration_ms": (duration_ms as u64),
    });
    if !method.is_empty() {
        line["method"] = Value::String(method.to_string());
    }
    if !id.is_null() {
        line["id"] = id.clone();
    }
    if let Some(detail) = detail {
        line["detail"] = Value::String(detail.to_string());
    }
    eprintln!("{}", line);
}

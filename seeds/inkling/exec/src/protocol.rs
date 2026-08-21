//! MCP stdio JSON-RPC 服务（协议层：消息形态以 ts_seed_pack 先例为准）。
//!
//! 传输：stdin 逐行读取 + stdout JSON 行响应 + stderr 结构化日志通道
//! （trace 语义：请求 id 透传、耗时、成败）。方法面：
//! initialize → notifications/initialized（无需响应）→ tools/list →
//! tools/call；另支持 ping（MCP 心跳）与 notifications/*（静默）。
//! 错误码用常量表达（禁魔法数字），与 JSON-RPC 2.0 规范一致：
//! 解析错误 -32700 / 非法请求 -32600 / 方法未实现 -32601 /
//! 参数非法 -32602 / 内部错误 -32603，工具执行失败 -32000
//! （MCP server 错误区间，ts_seed_pack 同款）。
//!
//! 健壮性：截断/畸形 JSON 返回结构化 -32700 不崩溃；未知方法 -32601；
//! 非法参数 -32602；无 id 的消息按通知语义不响应；单行超长跳过并留
//! stderr 日志（防内存轰炸）。与 ts_seed_pack 先例的刻意差异（记录在
//! 案）：JSON-RPC 规范规定无 id 消息 = 通知、不得响应，先例对未知方法
//! 的无 id 消息仍会响应，这里按规范静默（MCP SDK 行为兼容优先）。

use std::io::{BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::json::{self, Object, Value};
use crate::tool::{ToolError, ToolErrorKind};

// -- JSON-RPC 错误码（常量表达，禁魔法数字） ------------------------------

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
/// 工具执行错误（MCP server 错误区间起点，ts_seed_pack 同款）。
pub const TOOL_ERROR: i64 = -32000;

/// 服务标识（与 manifest.json contracts 中的执行件 MCP id 对齐）。
const SERVER_NAME: &str = "inkling_exec";
const SERVER_VERSION: &str = "0.1.0";
/// initialize 时回显/缺省用的协议版本（与 ts_seed_pack 一致）。
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// 单行输入长度上限（16 MiB）：超限行跳过并留日志（防内存轰炸）。
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 工具执行错误 → JSON-RPC 错误码映射（执行体不感知协议错误码）。
fn tool_error_code(kind: ToolErrorKind) -> i64 {
    match kind {
        ToolErrorKind::InvalidParams => INVALID_PARAMS,
        ToolErrorKind::ToolError => TOOL_ERROR,
    }
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// stderr 结构化日志（JSON 行）：事件/请求 id/耗时/成败，trace 语义。
fn log_line(
    event: &str,
    method: &str,
    id: &Value,
    duration_ms: u128,
    ok: bool,
    detail: Option<&str>,
) {
    let mut obj = Object::new();
    obj.insert("ts".to_string(), Value::Number(epoch_ms() as f64));
    obj.insert(
        "level".to_string(),
        Value::String(if ok { "info".into() } else { "error".into() }),
    );
    obj.insert("event".to_string(), Value::String(event.to_string()));
    if !method.is_empty() {
        obj.insert("method".to_string(), Value::String(method.to_string()));
    }
    if !id.is_null() {
        obj.insert("id".to_string(), id.clone());
    }
    obj.insert("duration_ms".to_string(), Value::Number(duration_ms as f64));
    obj.insert("ok".to_string(), Value::Bool(ok));
    if let Some(detail) = detail {
        obj.insert("detail".to_string(), Value::String(detail.to_string()));
    }
    eprintln!("{}", json::serialize(&Value::Object(obj)));
}

// -- 响应构造 ------------------------------------------------------------

fn response(id: &Value, result: Value) -> String {
    let mut obj = Object::new();
    obj.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
    obj.insert("id".to_string(), id.clone());
    obj.insert("result".to_string(), result);
    json::serialize(&Value::Object(obj))
}

fn error_response(id: &Value, code: i64, message: String) -> String {
    let mut obj = Object::new();
    obj.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
    obj.insert("id".to_string(), id.clone());
    let mut error = Object::new();
    error.insert("code".to_string(), Value::Number(code as f64));
    error.insert("message".to_string(), Value::String(message));
    obj.insert("error".to_string(), Value::Object(error));
    json::serialize(&Value::Object(obj))
}

/// 消息 id 提取：合法 id = number/string/null；其余形态视为非法请求。
/// 无 id = 通知（调用方据此不响应）。
fn message_id(msg: &Object) -> Option<Result<Value, ()>> {
    match msg.get("id") {
        None => None, // 通知
        Some(id @ (Value::Number(_) | Value::String(_) | Value::Null)) => Some(Ok(id.clone())),
        Some(_) => Some(Err(())), // 非法 id 形态
    }
}

// -- 方法分派 ------------------------------------------------------------

fn handle_initialize(params: &Value) -> Value {
    let protocol_version = params
        .as_object()
        .and_then(|o| o.get_str("protocolVersion"))
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    let mut capabilities = Object::new();
    capabilities.insert("tools".to_string(), Value::Object(Object::new()));
    let mut server_info = Object::new();
    server_info.insert("name".to_string(), Value::String(SERVER_NAME.to_string()));
    server_info.insert(
        "version".to_string(),
        Value::String(SERVER_VERSION.to_string()),
    );
    json::object_from_pairs(vec![
        (
            "protocolVersion",
            Value::String(protocol_version.to_string()),
        ),
        ("capabilities", Value::Object(capabilities)),
        ("serverInfo", Value::Object(server_info)),
    ])
}

fn handle_tools_list() -> Value {
    let tools: Vec<Value> = crate::executors::registry()
        .iter()
        .map(|def| {
            json::object_from_pairs(vec![
                ("name", Value::String(def.name.to_string())),
                ("description", Value::String(def.description.to_string())),
                ("inputSchema", def.input_schema.clone()),
            ])
        })
        .collect();
    json::object_from_pairs(vec![("tools", Value::Array(tools))])
}

fn handle_tools_call(params: &Value) -> Result<Value, (i64, String)> {
    // 参数校验：先验结构（name 字符串、arguments 对象），再按执行体执行
    let params = params
        .as_object()
        .ok_or_else(|| (INVALID_PARAMS, "tools/call 参数须为对象".to_string()))?;
    let name = params
        .get_str("name")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| (INVALID_PARAMS, "缺工具名 name".to_string()))?;
    let arguments = match params.get("arguments") {
        None => Value::Object(Object::new()),
        Some(a @ Value::Object(_)) => a.clone(),
        Some(_) => return Err((INVALID_PARAMS, "arguments 须为对象".to_string())),
    };
    let registry = crate::executors::registry();
    let def = registry
        .iter()
        .find(|d| d.name == name)
        .ok_or_else(|| (INVALID_PARAMS, format!("未知工具: {}", name)))?;
    let result =
        (def.run)(&arguments).map_err(|e: ToolError| (tool_error_code(e.kind), e.message))?;
    let text = json::serialize(&result);
    let content = Value::Array(vec![json::object_from_pairs(vec![
        ("type", Value::String("text".to_string())),
        ("text", Value::String(text)),
    ])]);
    Ok(json::object_from_pairs(vec![("content", content)]))
}

/// 处理一行输入：返回要写往 stdout 的响应行（None = 通知，无需响应）。
pub fn handle_line(line: &str) -> Option<String> {
    let start = epoch_ms();
    let msg = match json::parse(line) {
        Ok(value) => value,
        Err(err) => {
            log_line(
                "rpc",
                "",
                &Value::Null,
                epoch_ms() - start,
                false,
                Some(&err.to_string()),
            );
            return Some(error_response(
                &Value::Null,
                PARSE_ERROR,
                format!("JSON 解析错误: {}", err),
            ));
        }
    };
    // 批处理（数组形态）不支持：结构化非法请求错误（MCP 传输不用批处理）
    let obj = match msg {
        Value::Object(obj) => obj,
        Value::Array(_) => {
            return Some(error_response(
                &Value::Null,
                INVALID_REQUEST,
                "批处理（数组消息）不受支持".to_string(),
            ))
        }
        _ => {
            return Some(error_response(
                &Value::Null,
                INVALID_REQUEST,
                "消息须为 JSON-RPC 请求对象".to_string(),
            ))
        }
    };
    let id = match message_id(&obj) {
        None => return None, // 通知：不响应（含 notifications/* 与一切无 id 消息）
        Some(Ok(id)) => id,
        Some(Err(())) => {
            return Some(error_response(
                &Value::Null,
                INVALID_REQUEST,
                "id 须为 number/string/null".to_string(),
            ))
        }
    };
    let method = match obj.get_str("method") {
        Some(m) => m,
        None => {
            log_line(
                "rpc",
                "",
                &id,
                epoch_ms() - start,
                false,
                Some("消息缺 method"),
            );
            return Some(error_response(
                &id,
                INVALID_REQUEST,
                "消息缺 method".to_string(),
            ));
        }
    };
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    let outcome: Result<Option<String>, String> = match method {
        "initialize" => Ok(Some(response(&id, handle_initialize(&params)))),
        "tools/list" => Ok(Some(response(&id, handle_tools_list()))),
        "tools/call" => match handle_tools_call(&params) {
            Ok(result) => Ok(Some(response(&id, result))),
            Err((code, message)) => Err(error_response(&id, code, message)),
        },
        "ping" => Ok(Some(response(&id, Value::Object(Object::new())))),
        // 通知类方法（含 notifications/initialized）在无 id 分支已返回；
        // 带 id 的通知方法同样按「无响应」处理（方法面兼容）
        m if m.starts_with("notifications/") => Ok(None),
        m => Err(error_response(
            &id,
            METHOD_NOT_FOUND,
            format!("方法未实现: {}", m),
        )),
    };
    match outcome {
        Ok(Some(resp)) => {
            log_line("rpc", method, &id, epoch_ms() - start, true, None);
            Some(resp)
        }
        Ok(None) => {
            log_line("rpc", method, &id, epoch_ms() - start, true, None);
            None
        }
        Err(resp) => {
            log_line("rpc", method, &id, epoch_ms() - start, false, None);
            Some(resp)
        }
    }
}

/// 服务主循环（stdin 逐行 → stdout 响应；EOF 优雅退出 0；写失败退出 1）。
pub fn run_server<R: BufRead, W: Write>(input: &mut R, output: &mut W) -> i32 {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => {
                // EOF = 客户端关闭 stdio：优雅退出
                if let Err(e) = output.flush() {
                    eprintln!(
                        "{}",
                        json::serialize(&Value::Object({
                            let mut obj = Object::new();
                            obj.insert("ts".to_string(), Value::Number(epoch_ms() as f64));
                            obj.insert("level".to_string(), Value::String("error".to_string()));
                            obj.insert("event".to_string(), Value::String("exit".to_string()));
                            obj.insert(
                                "detail".to_string(),
                                Value::String(format!("stdout 写入失败: {}", e)),
                            );
                            obj
                        }))
                    );
                    return 1;
                }
                return 0;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!(
                    "{}",
                    json::serialize(&Value::Object({
                        let mut obj = Object::new();
                        obj.insert("ts".to_string(), Value::Number(epoch_ms() as f64));
                        obj.insert("level".to_string(), Value::String("error".to_string()));
                        obj.insert("event".to_string(), Value::String("stdin_read".to_string()));
                        obj.insert(
                            "detail".to_string(),
                            Value::String(format!("stdin 读取失败: {}", e)),
                        );
                        obj
                    }))
                );
                return 1;
            }
        }
        if line.len() > MAX_LINE_BYTES {
            log_line(
                "rpc",
                "",
                &Value::Null,
                0,
                false,
                Some("单行超过 16 MiB 上限，跳过"),
            );
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(response) = handle_line(trimmed) {
            if let Err(e) = writeln!(output, "{}", response) {
                eprintln!(
                    "{}",
                    json::serialize(&Value::Object({
                        let mut obj = Object::new();
                        obj.insert("ts".to_string(), Value::Number(epoch_ms() as f64));
                        obj.insert("level".to_string(), Value::String("error".to_string()));
                        obj.insert(
                            "event".to_string(),
                            Value::String("stdout_write".to_string()),
                        );
                        obj.insert(
                            "detail".to_string(),
                            Value::String(format!("stdout 写入失败: {}", e)),
                        );
                        obj
                    }))
                );
                return 1;
            }
            let _ = output.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(line: &str) -> Option<String> {
        handle_line(line)
    }

    #[test]
    fn initialize_returns_server_info() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}}"#)
            .unwrap();
        let value = json::parse(&resp).unwrap();
        let result = value.as_object().unwrap().get_object("result").unwrap();
        assert_eq!(result.get_str("protocolVersion"), Some("2025-06-18"));
        let info = result.get_object("serverInfo").unwrap();
        assert_eq!(info.get_str("name"), Some("inkling_exec"));
    }

    #[test]
    fn notification_gets_no_response() {
        assert!(call(r#"{"jsonrpc": "2.0", "method": "notifications/initialized"}"#).is_none());
        assert!(
            call(r#"{"jsonrpc": "2.0", "method": "notifications/whatever", "params": {}}"#)
                .is_none()
        );
    }

    #[test]
    fn tools_list_has_seven_tools() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        let tools = value
            .as_object()
            .unwrap()
            .get_object("result")
            .unwrap()
            .get_array("tools")
            .unwrap();
        assert_eq!(tools.len(), 7);
        assert!(tools
            .iter()
            .all(|t| t.as_object().unwrap().get_str("name").is_some()));
    }

    #[test]
    fn unknown_method_is_32601() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 3, "method": "no/such"}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        let error = value.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(METHOD_NOT_FOUND as f64));
    }

    #[test]
    fn unknown_tool_is_invalid_params() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope", "arguments": {}}}"#)
            .unwrap();
        let value = json::parse(&resp).unwrap();
        let error = value.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(INVALID_PARAMS as f64));
    }

    #[test]
    fn bad_json_is_32700() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 5, "method": "initialize""#).unwrap();
        let value = json::parse(&resp).unwrap();
        let error = value.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(PARSE_ERROR as f64));
        assert_eq!(value.as_object().unwrap().get("id"), Some(&Value::Null));
    }

    #[test]
    fn missing_method_is_32600() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 6, "params": {}}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        let error = value.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(INVALID_REQUEST as f64));
    }

    #[test]
    fn ping_returns_empty_result() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 7, "method": "ping"}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        assert!(value.as_object().unwrap().get_object("result").is_some());
        assert_eq!(
            value.as_object().unwrap().get("id"),
            Some(&Value::Number(7.0))
        );
    }

    #[test]
    fn string_id_echoes() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": "abc", "method": "ping"}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        assert_eq!(
            value.as_object().unwrap().get("id"),
            Some(&Value::String("abc".to_string()))
        );
    }

    #[test]
    fn array_message_is_invalid_request() {
        let resp = call(r#"[{"jsonrpc": "2.0", "id": 1, "method": "ping"}]"#).unwrap();
        let value = json::parse(&resp).unwrap();
        let error = value.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(INVALID_REQUEST as f64));
    }
}

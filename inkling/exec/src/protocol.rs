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
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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

/// 单行输入长度上限（16 MiB）：超限行拒绝解析并回结构化错误（防内存轰炸）。
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// 工具执行错误 → JSON-RPC 错误码映射（执行体不感知协议错误码）。
fn tool_error_code(kind: ToolErrorKind) -> i64 {
    match kind {
        ToolErrorKind::InvalidParams => INVALID_PARAMS,
        ToolErrorKind::ToolError => TOOL_ERROR,
    }
}

/// 日志时间戳（墙钟，供 trace 对账；计时用 Instant——见 handle_line）。
fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// stderr 结构化日志（JSON 行）：事件/请求 id/耗时/成败 + 失败时的
/// error_code/error_message/tool（E16：失败日志不再只剩 ok:false）。
#[allow(clippy::too_many_arguments)]
fn log_line(
    event: &str,
    method: &str,
    id: &Value,
    duration_ms: u128,
    ok: bool,
    error_code: Option<i64>,
    error_message: Option<&str>,
    tool: Option<&str>,
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
    if let Some(code) = error_code {
        obj.insert("error_code".to_string(), Value::Number(code as f64));
    }
    if let Some(message) = error_message {
        obj.insert("error_message".to_string(), Value::String(message.to_string()));
    }
    if let Some(tool) = tool {
        obj.insert("tool".to_string(), Value::String(tool.to_string()));
    }
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
    // E18：耗时用 Instant（单调钟），NTP 回拨不会导致 u128 下溢
    let start = Instant::now();
    let msg = match json::parse(line) {
        Ok(value) => value,
        Err(err) => {
            let detail = err.to_string();
            log_line(
                "rpc",
                "",
                &Value::Null,
                start.elapsed().as_millis(),
                false,
                Some(PARSE_ERROR),
                Some(&detail),
                None,
                None,
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
            let message = "消息缺 method";
            log_line(
                "rpc",
                "",
                &id,
                start.elapsed().as_millis(),
                false,
                Some(INVALID_REQUEST),
                Some(message),
                None,
                None,
            );
            return Some(error_response(&id, INVALID_REQUEST, message.to_string()));
        }
    };
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    let outcome: Result<Option<String>, (i64, String)> = match method {
        "initialize" => Ok(Some(response(&id, handle_initialize(&params)))),
        "tools/list" => Ok(Some(response(&id, handle_tools_list()))),
        "tools/call" => match handle_tools_call(&params) {
            Ok(result) => Ok(Some(response(&id, result))),
            Err((code, message)) => Err((code, message)),
        },
        "ping" => Ok(Some(response(&id, Value::Object(Object::new())))),
        // E25：带 id 的通知方法同样回响应（空 result）——只有无 id 消息
        // 才是真通知（上面 message_id None 分支已处理）；带 id 不回响应
        // 会令客户端悬挂等待
        m if m.starts_with("notifications/") => {
            Ok(Some(response(&id, Value::Object(Object::new()))))
        }
        m => Err((METHOD_NOT_FOUND, format!("方法未实现: {}", m))),
    };
    let duration_ms = start.elapsed().as_millis();
    match outcome {
        Ok(Some(resp)) => {
            log_line("rpc", method, &id, duration_ms, true, None, None, None, None);
            Some(resp)
        }
        Ok(None) => {
            log_line("rpc", method, &id, duration_ms, true, None, None, None, None);
            None
        }
        Err((code, message)) => {
            // E16：失败日志补 code/message/tool 字段（排障不再只见 ok:false）
            let tool = if method == "tools/call" {
                params
                    .as_object()
                    .and_then(|o| o.get_str("name"))
            } else {
                None
            };
            log_line(
                "rpc",
                method,
                &id,
                duration_ms,
                false,
                Some(code),
                Some(&message),
                tool,
                None,
            );
            Some(error_response(&id, code, message))
        }
    }
}

/// 限长行读取：追加到 buf（Vec<u8>，调用方负责 clear），至多 limit 字节
/// 或到行尾（含 \n）。返回已读字节数（0 = EOF）。E8：任何路径都不把整行
/// 无界读入内存——fill_buf 分段消费，超限即停（不等待行尾）。
fn read_bounded_line<R: BufRead>(input: &mut R, buf: &mut Vec<u8>, limit: usize) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        if total >= limit {
            break;
        }
        // 借用作用域化：chunk 借用结束（consume 前）再消费
        let (take, ended_with_newline) = {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                break; // EOF
            }
            let take = chunk
                .iter()
                .position(|&b| b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(chunk.len())
                .min(limit - total);
            if take == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..take]);
            (take, chunk[take - 1] == b'\n')
        };
        input.consume(take);
        total += take;
        if ended_with_newline {
            break; // 完整行结束
        }
    }
    Ok(total)
}

/// 排空到行尾（超限行余量，分块消费不落内存）。
fn drain_to_line_end<R: BufRead>(input: &mut R) -> std::io::Result<usize> {
    let mut total = 0usize;
    loop {
        let (take, ended_with_newline) = {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                break; // EOF
            }
            let take = chunk
                .iter()
                .position(|&b| b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(chunk.len());
            (take, chunk[take - 1] == b'\n')
        };
        input.consume(take);
        total += take;
        if ended_with_newline {
            break;
        }
    }
    Ok(total)
}

/// 服务主循环（stdin 逐行 → stdout 响应；EOF 优雅退出 0；写失败退出 1）。
///
/// E8：行读取限长（read_line 无界读入会让 1 GiB 行常驻内存），超限行回
/// 结构化 -32700 错误并排空余下到行尾（保持流对齐，不吞下一行）；大行
/// 缓冲区一次性释放（不保留高水位）。
pub fn run_server<R: BufRead, W: Write>(input: &mut R, output: &mut W) -> i32 {
    let mut line: Vec<u8> = Vec::with_capacity(256);
    loop {
        line.clear();
        let read = read_bounded_line(input, &mut line, MAX_LINE_BYTES + 1);
        match read {
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
            // E8：超限行不回静默跳过——客户端会悬挂；回结构化 -32700 错误
            // 并排空本行余量到行尾（限长读取已停在 MAX+1，余下按行清掉）
            let message = format!("单行超过 {} 字节上限，拒绝解析", MAX_LINE_BYTES);
            log_line(
                "rpc",
                "",
                &Value::Null,
                0,
                false,
                Some(PARSE_ERROR),
                Some(&message),
                None,
                None,
            );
            if let Err(e) = writeln!(output, "{}", error_response(&Value::Null, PARSE_ERROR, message)) {
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
            // 排空余下到行尾（分块消费，不把超大行留在内存里）
            if let Err(e) = drain_to_line_end(input) {
                eprintln!(
                    "{}",
                    json::serialize(&Value::Object({
                        let mut obj = Object::new();
                        obj.insert("ts".to_string(), Value::Number(epoch_ms() as f64));
                        obj.insert("level".to_string(), Value::String("error".to_string()));
                        obj.insert(
                            "event".to_string(),
                            Value::String("stdin_read".to_string()),
                        );
                        obj.insert(
                            "detail".to_string(),
                            Value::String(format!("stdin 读取失败: {}", e)),
                        );
                        obj
                    }))
                );
                return 1;
            }
            // 收缩超限缓冲（大行分配一次性释放）
            line.clear();
            line.shrink_to_fit();
            continue;
        }
        if line.capacity() > MAX_LINE_BYTES {
            line.clear();
            line.shrink_to_fit();
        }
        // 缓冲里是 UTF-8（协议面），lossy 兜底不 panic
        let trimmed = std::str::from_utf8(&line).unwrap_or("").trim();
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
    fn tools_list_has_six_tools() {
        let resp = call(r#"{"jsonrpc": "2.0", "id": 2, "method": "tools/list"}"#).unwrap();
        let value = json::parse(&resp).unwrap();
        let tools = value
            .as_object()
            .unwrap()
            .get_object("result")
            .unwrap()
            .get_array("tools")
            .unwrap();
        assert_eq!(tools.len(), 6);
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

    #[test]
    fn notification_with_id_gets_response() {
        // E25：带 id 的通知方法必须回响应（否则客户端悬挂）；无 id 才静默
        let resp = call(r#"{"jsonrpc": "2.0", "id": 8, "method": "notifications/whatever", "params": {}}"#)
            .unwrap();
        let value = json::parse(&resp).unwrap();
        assert!(value.as_object().unwrap().get_object("result").is_some());
        assert_eq!(
            value.as_object().unwrap().get("id"),
            Some(&Value::Number(8.0))
        );
    }

    #[test]
    fn overlong_line_gets_structured_error_and_recovers() {
        // E8：超限行回结构化 -32700 错误（不回静默跳过），服务继续可用
        let mut input = std::io::Cursor::new(Vec::<u8>::new());
        input.get_mut().extend_from_slice(&vec![b'x'; MAX_LINE_BYTES + 10]);
        input.get_mut().push(b'\n');
        input.get_mut().extend_from_slice(
            br#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#.to_vec().as_slice(),
        );
        input.get_mut().push(b'\n');
        let mut output = Vec::<u8>::new();
        let code = run_server(&mut input, &mut output);
        assert_eq!(code, 0, "EOF 优雅退出");
        let text = String::from_utf8_lossy(&output);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "超限行错误 + ping 响应: {}", text);
        let first = json::parse(lines[0]).unwrap();
        let error = first.as_object().unwrap().get_object("error").unwrap();
        assert_eq!(error.get_f64("code"), Some(PARSE_ERROR as f64));
        assert_eq!(first.as_object().unwrap().get("id"), Some(&Value::Null));
        let second = json::parse(lines[1]).unwrap();
        assert!(second.as_object().unwrap().get_object("result").is_some());
    }
}

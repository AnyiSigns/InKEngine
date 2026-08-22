//! MCP 协议 conformance 测试（免引擎）：spawn 真实二进制，按 MCP 协议
//! 喂 JSON 行（initialize → notifications/initialized → tools/list →
//! tools/call），覆盖成功/失败全路径。协议消息形态与 ts_seed_pack 先例
//! 同构对照（initialize 回 serverInfo/capabilities、tools/call 结果包
//! content[0].text、错误走 JSON-RPC error 对象）。

#[path = "protocol/helpers.rs"]
mod helpers;

use helpers::{parse_response, spawn};
use inkling_exec::json::Value;

const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"conformance","version":"0"}}}"#;

/// 从响应对象取 result（期望成功路径）。
fn result_of(value: &Value) -> &inkling_exec::json::Object {
    value
        .as_object()
        .unwrap()
        .get_object("result")
        .expect("期望 result，实际是 error")
}

fn error_code_of(value: &Value) -> f64 {
    value
        .as_object()
        .unwrap()
        .get_object("error")
        .expect("期望 error，实际是 result")
        .get_f64("code")
        .expect("error 缺 code")
}

fn error_message_of(value: &Value) -> String {
    value
        .as_object()
        .unwrap()
        .get_object("error")
        .expect("期望 error，实际是 result")
        .get_str("message")
        .expect("error 缺 message")
        .to_string()
}

fn content_text(value: &Value) -> String {
    let content = result_of(value).get_array("content").unwrap();
    let item = content[0].as_object().unwrap();
    assert_eq!(
        item.get_str("type"),
        Some("text"),
        "content 项须为 text 类型"
    );
    item.get_str("text").expect("text 项缺 text").to_string()
}

fn call_tool(exec: &mut helpers::ExecProcess, id: i64, name: &str, arguments: &str) -> Value {
    let line = format!(
        r#"{{"jsonrpc":"2.0","id":{},"method":"tools/call","params":{{"name":"{}","arguments":{}}}}}"#,
        id, name, arguments
    );
    parse_response(&exec.roundtrip(&line))
}

// -- 握手流程 ------------------------------------------------------------

#[test]
fn initialize_handshake() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(INITIALIZE));
    assert_eq!(
        resp.as_object().unwrap().get("id"),
        Some(&Value::Number(1.0))
    );
    let result = result_of(&resp);
    assert_eq!(
        result.get_str("protocolVersion"),
        Some("2025-06-18"),
        "协议版本须回显客户端声明值"
    );
    let server_info = result.get_object("serverInfo").unwrap();
    assert_eq!(server_info.get_str("name"), Some("inkling_exec"));
    assert_eq!(server_info.get_str("version"), Some("0.1.0"));
    assert!(
        result
            .get_object("capabilities")
            .unwrap()
            .get_object("tools")
            .is_some(),
        "capabilities 须声明 tools 能力"
    );
    exec.close_and_wait();
}

#[test]
fn initialized_notification_then_full_flow() {
    let mut exec = spawn();
    exec.roundtrip(INITIALIZE);
    // 通知不得有响应行（MCP 客户端在 initialize 后发送，等待响应会挂死）
    exec.send_no_reply(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    // 服务端未被通知扰乱：随后的 tools/list 正常应答
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#));
    let tools = result_of(&resp).get_array("tools").unwrap();
    assert_eq!(tools.len(), 7);
    exec.close_and_wait();
}

// -- tools/list -----------------------------------------------------------

#[test]
fn tools_list_metadata_shape() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#));
    let tools = result_of(&resp).get_array("tools").unwrap();
    assert_eq!(
        tools.len(),
        7,
        "执行体清单 = 采集/解析/校验/评分/评审/蒸馏/变异"
    );
    for tool in tools {
        let obj = tool.as_object().unwrap();
        assert!(
            obj.get_str("name").unwrap().starts_with("inkling_"),
            "工具名须带 inkling_ 前缀"
        );
        assert!(!obj.get_str("description").unwrap().is_empty());
        let schema = obj.get_object("inputSchema").unwrap();
        assert_eq!(schema.get_str("type"), Some("object"));
        assert!(
            schema.get_object("properties").is_some(),
            "inputSchema 须声明 properties"
        );
    }
    exec.close_and_wait();
}

// -- tools/call 成功路径 ---------------------------------------------------

#[test]
fn validate_tool_pass_and_fail_paths() {
    let mut exec = spawn();
    // 合法条目：零违规
    let out = call_tool(
        &mut exec,
        10,
        "inkling_validate",
        r#"{"data":{"title":"溯源方法论","title_length":6,"kind":"insight","source":"model","evidence":"证据","text":"普通文本。","credibility":0.8,"count":2,"limit":5,"tags":[{"tag":"方法"},{"tag":"溯源"}],"from_state":"draft","to_state":"reviewing"}}"#,
    );
    let text = content_text(&out);
    let parsed = parse_response(&text);
    assert_eq!(parsed.as_object().unwrap().get_bool("ok"), Some(true));
    assert!(
        parsed
            .as_object()
            .unwrap()
            .get_array("issues")
            .unwrap()
            .is_empty(),
        "合法条目应零违规"
    );
    // 缺标题：completeness 违规
    let out = call_tool(
        &mut exec,
        11,
        "inkling_validate",
        r#"{"data":{"kind":"rule","source":"model","evidence":"证据"}}"#,
    );
    let text = content_text(&out);
    let parsed = parse_response(&text);
    let issues = parsed.as_object().unwrap().get_array("issues").unwrap();
    assert!(!issues.is_empty(), "缺标题应报违规");
    assert!(issues
        .iter()
        .any(|i| i.as_object().unwrap().get_str("kind") == Some("completeness")));
    exec.close_and_wait();
}

#[test]
fn distill_tool_returns_engine_shape() {
    let mut exec = spawn();
    let out = call_tool(
        &mut exec,
        12,
        "inkling_distill",
        r#"{"signals":[{"kind":"insight","message":"知识沉淀需证据留痕","source":"model","context":{"node":"research"}},{"kind":"pitfall","message":"无证据落库被拒","source":"web"}],"complexity":6,"interventions":1}"#,
    );
    let text = content_text(&out);
    let parsed = parse_response(&text);
    let data = parsed.as_object().unwrap().get_object("data").unwrap();
    assert_eq!(data.get_str("kind"), Some("insight"));
    let insight = data.get_object("insight").unwrap();
    assert_eq!(insight.get_str("message"), Some("知识沉淀需证据留痕"));
    assert_eq!(insight.get_str("note"), Some("无证据落库被拒"));
    exec.close_and_wait();
}

#[test]
fn collect_text_and_review_roundtrip() {
    let mut exec = spawn();
    let out = call_tool(
        &mut exec,
        13,
        "inkling_collect",
        r#"{"source":"text","text":"hello","max_bytes":3}"#,
    );
    let parsed = parse_response(&content_text(&out));
    assert_eq!(
        parsed.as_object().unwrap().get_bool("truncated"),
        Some(true)
    );
    assert_eq!(parsed.as_object().unwrap().get_str("content"), Some("hel"));
    let out = call_tool(
        &mut exec,
        14,
        "inkling_review",
        r#"{"candidates":[{"text":"xxxxxxxxxxxxxxxxxxxx","claims":["a","b","c"]}],"dimension_scores":[{"candidate_index":0,"name":"evidence","score":0.9},{"candidate_index":0,"name":"relevance","score":0.8},{"candidate_index":0,"name":"clarity","score":0.8},{"candidate_index":0,"name":"completeness","score":0.8}]}"#,
    );
    let parsed = parse_response(&content_text(&out));
    let decision = parsed.as_object().unwrap().get_object("decision").unwrap();
    assert_eq!(decision.get_bool("converged"), Some(true));
    exec.close_and_wait();
}

// -- tools/call 失败路径（结构化错误，不崩溃） ------------------------------

#[test]
fn unknown_tool_returns_structured_error() {
    let mut exec = spawn();
    let resp = call_tool(&mut exec, 20, "no_such_tool", "{}");
    assert_eq!(
        error_code_of(&resp),
        -32602.0,
        "未知工具 = 参数非法（ts_seed_pack 同款）"
    );
    assert!(error_message_of(&resp).contains("未知工具"));
    // 错误后服务端仍可用（不崩溃、状态不污染）
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":21,"method":"ping"}"#));
    assert!(result_of(&resp).is_empty());
    exec.close_and_wait();
}

#[test]
fn missing_tool_name_returns_structured_error() {
    let mut exec = spawn();
    let resp = call_tool(&mut exec, 22, "", "{}");
    assert_eq!(error_code_of(&resp), -32602.0);
    exec.close_and_wait();
}

#[test]
fn non_object_arguments_returns_structured_error() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"inkling_validate","arguments":[1,2]}}"#));
    assert_eq!(
        error_code_of(&resp),
        -32602.0,
        "arguments 非对象 = 参数非法"
    );
    exec.close_and_wait();
}

#[test]
fn tool_domain_error_returns_32000() {
    let mut exec = spawn();
    // https 取回 = 领域能力边界（需宿主 web_bridge 代理）→ 工具执行错误
    let out = call_tool(
        &mut exec,
        24,
        "inkling_collect",
        r#"{"source":"url","url":"https://example.com"}"#,
    );
    assert_eq!(error_code_of(&out), -32000.0, "https 取回须报工具执行错误");
    assert!(
        error_message_of(&out).contains("web_bridge"),
        "错误消息须给出可操作指引"
    );
    exec.close_and_wait();
}

// -- 协议健壮性 ------------------------------------------------------------

#[test]
fn truncated_json_returns_32700() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":30,"method":"initialize""#));
    assert_eq!(error_code_of(&resp), -32700.0, "截断输入 = 解析错误");
    assert_eq!(
        resp.as_object().unwrap().get("id"),
        Some(&Value::Null),
        "解析错误 id 为 null（JSON-RPC 规范）"
    );
    exec.close_and_wait();
}

#[test]
fn garbage_json_returns_32700() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip("this is not json"));
    assert_eq!(error_code_of(&resp), -32700.0);
    exec.close_and_wait();
}

#[test]
fn unknown_method_returns_32601() {
    let mut exec = spawn();
    let resp =
        parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":31,"method":"tools/delete"}"#));
    assert_eq!(error_code_of(&resp), -32601.0);
    exec.close_and_wait();
}

#[test]
fn missing_method_returns_32600() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":32,"params":{}}"#));
    assert_eq!(error_code_of(&resp), -32600.0);
    exec.close_and_wait();
}

#[test]
fn batch_message_returns_32600() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#));
    assert_eq!(error_code_of(&resp), -32600.0, "批处理不受支持 = 非法请求");
    exec.close_and_wait();
}

#[test]
fn id_type_invalid_returns_32600() {
    let mut exec = spawn();
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":{},"method":"ping"}"#));
    assert_eq!(error_code_of(&resp), -32600.0);
    exec.close_and_wait();
}

#[test]
fn string_id_echoed_back() {
    let mut exec = spawn();
    let resp =
        parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":"trace-1","method":"ping"}"#));
    assert_eq!(
        resp.as_object().unwrap().get("id"),
        Some(&Value::String("trace-1".to_string()))
    );
    exec.close_and_wait();
}

#[test]
fn arbitrary_notification_gets_no_response() {
    let mut exec = spawn();
    exec.send_no_reply(r#"{"jsonrpc":"2.0","method":"notifications/whatever","params":{"x":1}}"#);
    // 服务端仍可服务（通知未造成响应错位）
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":33,"method":"ping"}"#));
    assert!(result_of(&resp).is_empty());
    exec.close_and_wait();
}

#[test]
fn no_id_request_is_treated_as_notification() {
    let mut exec = spawn();
    exec.send_no_reply(r#"{"jsonrpc":"2.0","method":"tools/list"}"#);
    let resp = parse_response(&exec.roundtrip(r#"{"jsonrpc":"2.0","id":34,"method":"ping"}"#));
    assert!(result_of(&resp).is_empty());
    exec.close_and_wait();
}

// -- 退出语义与可观测性 ------------------------------------------------------

#[test]
fn eof_exits_gracefully_with_code_zero() {
    let mut exec = spawn();
    exec.roundtrip(INITIALIZE);
    let code = exec.close_and_wait();
    assert_eq!(code, 0, "EOF 应优雅退出（客户端正常关停）");
}

#[test]
fn stderr_logs_are_structured_json_lines() {
    let mut exec = spawn();
    exec.roundtrip(INITIALIZE);
    exec.roundtrip(r#"{"jsonrpc":"2.0","id":41,"method":"tools/list"}"#);
    // stderr 由独立线程异步收集：轮询等待（上限 3 秒），避免收集时序竞争
    let mut logs = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while logs.is_empty() && std::time::Instant::now() < deadline {
        logs = exec.stderr_logs();
        if logs.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    assert!(!logs.is_empty(), "stderr 日志通道应有输出");
    for line in &logs {
        let value = parse_response(line);
        let obj = value.as_object().expect("日志须为 JSON 对象行");
        assert!(obj.get_f64("ts").is_some(), "日志须带时间戳");
        assert!(obj.get_str("event").is_some(), "日志须带事件名");
        assert!(obj.get_bool("ok").is_some(), "日志须带成败标记");
        assert!(obj.get_f64("duration_ms").is_some(), "日志须带耗时");
    }
    // trace 语义：请求 id 透传
    let list_log = logs
        .iter()
        .find(|l| l.contains("\"method\":\"tools/list\""))
        .expect("tools/list 应有日志");
    assert!(
        list_log.contains("\"id\":41"),
        "请求 id 须透传进日志: {}",
        list_log
    );
}

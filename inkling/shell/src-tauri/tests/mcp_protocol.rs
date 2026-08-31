//! 设备感知 server 协议 conformance（宿主件挂载接线，免真实桌面）。
//!
//! initialize → tools/list → tools/call 逐行喂 JSON，断言响应；
//! 与 M1 执行件 conformance 同构。感知工具经统一执行器注册表执行
//! （沙箱守卫断言与 executor_contract 同源，此处验证 MCP 层接线）。
//!
//! 审批语义（L2）：设备 server 的裁决经壳侧审批台账（与批 1 ApprovalLedger
//! 同口径）——测试以引擎通道形态模拟「引擎放行态登记」后再调用，
//! 无批准态的 review 档调用被拒（fail-closed，无硬编码 approved）。

use std::collections::BTreeMap;

use inkling_shell_lib::ApprovalLedger;
use inkling_shell_lib::executors::backends::MockBackend;
use inkling_shell_lib::executors::registry::build_registry_from_declarations;
use inkling_shell_lib::executors::tool_decl::load_tool_declarations;
use inkling_shell_lib::mcp::DeviceServer;

const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

/// 构造设备 server + 壳侧审批台账（测试保留台账句柄以模拟引擎通道
/// 放行态登记；`DeviceServer::new` 装载同一台账实例）。
fn server() -> (DeviceServer<'static>, ApprovalLedger) {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry: &'static _ = Box::leak(Box::new(
        build_registry_from_declarations(&declarations).unwrap(),
    ));
    let backend: &'static MockBackend = Box::leak(Box::new(MockBackend::new()));
    let approval = ApprovalLedger::from_declarations(&declarations);
    let server = DeviceServer::new(registry, backend, approval.clone());
    (server, approval)
}

fn args(pairs: &[(&str, serde_json::Value)]) -> BTreeMap<String, serde_json::Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn call_line(server: &DeviceServer, line: &str) -> serde_json::Value {
    let response = server
        .handle_line(line)
        .expect("协议处理必须产出响应行");
    serde_json::from_str(&response).expect("响应须为合法 JSON")
}

#[test]
fn initialize_handshake() {
    let (server, _ledger) = server();
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}"#,
    );
    assert_eq!(response["id"], 1);
    assert_eq!(response["result"]["serverInfo"]["name"], "inkling_device");
    assert!(response["result"]["capabilities"]["tools"].is_object());
}

#[test]
fn tools_list_exposes_only_device_endpoint_tools() {
    let (server, _ledger) = server();
    let response = call_line(&server, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#);
    let tools = response["result"]["tools"].as_array().expect("tools 应为数组");
    let names: Vec<String> = tools
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"ui_query".to_string()));
    assert!(names.contains(&"file_query".to_string()));
    // process_exec 端点工具不出现在设备 server（端点隔离）
    assert!(!names.contains(&"launch_app".to_string()));
    // inputSchema 与执行器签名一致（声明驱动投影）
    let ui = tools.iter().find(|t| t["name"] == "ui_query").unwrap();
    assert!(ui["inputSchema"]["properties"].as_object().unwrap().contains_key("target"));
}

#[test]
fn tools_call_ui_query_happy_path() {
    let (server, _ledger) = server();
    // ui_query 为 allow 档只读感知（无需审批态），target=resolution 走屏幕参数面
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ui_query","arguments":{"target":"resolution"}}}"#,
    );
    assert_eq!(response["id"], 3);
    assert_eq!(response["result"]["isError"], false);
    assert_eq!(response["result"]["content"][0]["text"], "mock:screen resolution");
    assert_eq!(response["result"]["sandbox_checked"], true);
}

#[test]
fn review_tool_rejected_without_approval_state() {
    // L2：无服务端审批态时 review 档被拒（fail-closed，客户端无法自证授权）
    let (server, _ledger) = server();
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"file_query","arguments":{"path":"/tmp/x"}}}"#,
    );
    assert!(response["error"].is_object(), "无审批态须拒绝: {response}");
    assert!(
        response["error"]["message"].as_str().unwrap().contains("审批"),
        "应报需审批: {response}"
    );
    // L6：错误对象携带 trace_id 信封字段
    assert!(response["error"]["trace_id"].as_str().unwrap().len() >= 16, "缺 trace_id: {response}");
}

#[test]
fn tools_call_sandbox_violation_returns_error() {
    let (server, _ledger) = server();
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ui_query","arguments":{"target":"spy_camera"}}}"#,
    );
    assert!(response["error"].is_object(), "沙箱越界应返回 JSON-RPC 错误");
    assert!(response["error"]["message"].as_str().unwrap().contains("沙箱越界"));
    assert!(response["error"]["trace_id"].as_str().unwrap().len() >= 16, "缺 trace_id: {response}");
}

#[test]
fn tools_call_unknown_tool_rejected() {
    let (server, _ledger) = server();
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"launch_app","arguments":{"app":"notepad"}}}"#,
    );
    assert!(response["error"].is_object(), "未知工具（端点外）应拒绝");
}

#[test]
fn malformed_line_returns_parse_error_without_crash() {
    let (server, _ledger) = server();
    let response = call_line(&server, "{not json at all");
    assert_eq!(response["error"]["code"], -32700);
    assert!(response["error"]["trace_id"].as_str().unwrap().len() >= 16, "缺 trace_id: {response}");
}

#[test]
fn unknown_method_returns_method_not_found() {
    let (server, _ledger) = server();
    let response = call_line(&server, r#"{"jsonrpc":"2.0","id":6,"method":"shutdown","params":{}}"#);
    assert_eq!(response["error"]["code"], -32601);
}

#[test]
fn notifications_are_ignored() {
    let (server, _ledger) = server();
    let response = server.handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#);
    assert!(response.is_none(), "通知不产出响应行");
}

#[test]
fn missing_args_reported_as_error() {
    let (server, ledger) = server();
    ledger.record_engine_dispatch("file_query", &args(&[]));
    let response = call_line(
        &server,
        r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"file_query","arguments":{}}}"#,
    );
    assert!(response["error"].is_object(), "缺参应返回错误（参数校验在注册表层）");
}

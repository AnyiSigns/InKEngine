//! MCP 方法面与工具执行（initialize / notifications/initialized / ping /
//! tools/list / tools/call）。
//!
//! 执行与守门全部复用既有库逻辑（零新执行逻辑）：
//! - file/process/doc → 组装信封后走 exec ops::execute（路径根内解析、
//!   `..`/符号链接拒绝、命令白名单、env 面形状、尺寸/超时上界、裁决字段
//!   校验——机械守门零裁决）；
//! - embed（shell profile）→ infer crate 的 in-process 嵌入面（同一套
//!   plan/embed 语义，参数与上限与 infer.embed 完全一致）。
//!
//! fail-closed 门：
//! - 路径类/进程工具要求 `INK_MCP_ROOT`（启动期读取一次；未配置 = 拒绝）；
//! - 进程命令要求 `INK_MCP_PROCESS_ALLOW`（启动期读取一次；未配置 = 拒绝）；
//! - tools/* 在 initialize 握手 + notifications/initialized 到达前拒绝；
//! - 进程 env 注入仅放行 `INK_*`/基础平台键，禁覆写密钥样键名。
//!
//! 结果形态：守门/执行失败以 MCP 工具结果的 `isError=true` 承载（文本含
//! 机器可读 reason 分类）；协议级违规（未初始化、未知方法/工具、参数畸形）
//! 回 JSON-RPC 错误（data.reason）。

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value as JsonValue};

use ink_ts_exec::envelope::{Deny, Envelope};
use ink_ts_exec::ops;
use ink_ts_rpc::code::{
    error_response, log_line, response, EXEC_ERROR, INVALID_PARAMS, INVALID_REQUEST,
    METHOD_NOT_FOUND, PARSE_ERROR,
};

use crate::profile::{tools_for, Profile, ToolSpec};

/// 沙箱根环境变量（路径类/进程工具的挂载根；未配置 = fail-closed）。
pub const ROOT_ENV: &str = "INK_MCP_ROOT";
/// 进程命令白名单环境变量（逗号/分号分隔；未配置 = 进程工具拒绝）。
pub const PROCESS_ALLOW_ENV: &str = "INK_MCP_PROCESS_ALLOW";
/// MCP 协议版本（与宿主客户端 `MCP_PROTOCOL_VERSION` 对偶）。
pub const PROTOCOL_VERSION: &str = "2025-03-26";
/// serverInfo.name（MCP initialize 响应）。
pub const SERVER_NAME: &str = "ink-ts-mcp";
/// serverInfo.version。
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 进程默认超时（秒；信封校验下界/上界内）。
const PROCESS_DEFAULT_TIMEOUT_SECS: i64 = 30;
/// 输出截断默认字符数（信封校验上界内；单次工具结果上限）。
const DEFAULT_MAX_CHARS: i64 = 200_000;

/// 协议错误（JSON-RPC 码 + 文案 + 机器可读 reason；与 exec/infer 同款）。
pub struct RpcFailure {
    pub code: i64,
    pub message: String,
    pub reason: &'static str,
}

fn invalid_params(message: impl Into<String>) -> RpcFailure {
    RpcFailure {
        code: INVALID_PARAMS,
        message: message.into(),
        reason: "params",
    }
}

/// 受限子进程最小环境面（与 exec process_op 的 RESTRICTED_ENV_WHITELIST
/// 同口径——进程 env 只在此面 + INK_* 显式注入之上叠加）。
const BASE_ENV_KEYS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
];

/// 密钥样键名标记（禁覆写：命中任一子串即拒绝注入）。
const SECRET_KEY_MARKERS: &[&str] = &["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"];

/// MCP server 状态（一次启动固定 profile 与沙箱配置；init 状态随会话推进）。
pub struct McpServer {
    pub profile: Profile,
    root: Option<String>,
    process_allow: Vec<String>,
    init_ok: bool,
    initialized: bool,
    serial: AtomicU64,
    #[cfg(feature = "embed")]
    infer_ctx: Option<ink_ts_infer::protocol::InferContext>,
}

impl McpServer {
    /// 从环境构造（profile 参数已解析；沙箱配置读自环境变量）。
    pub fn from_env(profile: Profile) -> Self {
        let root = std::env::var(ROOT_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty());
        let process_allow = std::env::var(PROCESS_ALLOW_ENV)
            .ok()
            .map(|value| {
                value
                    .split([',', ';'])
                    .map(|item| item.trim().to_string())
                    .filter(|item| !item.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Self::with_config(profile, root, process_allow)
    }

    /// 显式配置构造（测试/宿主注入）；embed 面按环境懒解析（INK_EMBEDDING_*）。
    pub fn with_config(profile: Profile, root: Option<String>, process_allow: Vec<String>) -> Self {
        Self {
            profile,
            root,
            process_allow,
            init_ok: false,
            initialized: false,
            serial: AtomicU64::new(0),
            #[cfg(feature = "embed")]
            infer_ctx: profile
                .has_embed()
                .then(ink_ts_infer::protocol::InferContext::from_env),
        }
    }

    fn next_serial(&self) -> String {
        let n = self.serial.fetch_add(1, Ordering::Relaxed);
        format!("{}-{:016x}", self.profile.name(), n)
    }

    /// 工具目录（tools/list 用；按 profile + 编译 feature 现行收录）。
    pub fn tools(&self) -> Vec<ToolSpec> {
        tools_for(self.profile)
    }

    fn fail_uninitialized() -> RpcFailure {
        RpcFailure {
            code: EXEC_ERROR,
            message:
                "MCP server 未初始化（须先 initialize + notifications/initialized）——fail-closed"
                    .to_string(),
            reason: "init",
        }
    }

    /// 工具调用就绪门（initialize 请求 + initialized 通知均须到位）。
    fn tools_ready(&self) -> bool {
        self.init_ok && self.initialized
    }

    fn root_deny() -> ink_ts_exec::envelope::Deny {
        ink_ts_exec::envelope::Deny::new(
            "no_root",
            "INK_MCP_ROOT 未配置——路径类/进程工具整体拒绝（fail-closed）",
        )
    }
}

/// 处理一行输入：返回要写往 stdout 的响应行（None = 通知，无需响应）。
pub fn handle_line(server: &mut McpServer, line: &str) -> Option<String> {
    let msg: JsonValue = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            let detail = format!("JSON 解析错误: {err}");
            log_line("mcp", "error", "", &JsonValue::Null, 0, Some(&detail));
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
    // 无 id = 通知（MCP 规范：不响应）；仅 notifications/initialized 推进状态
    let Some(id) = ink_ts_rpc::code::message_id(&JsonValue::Object(obj.clone())) else {
        if obj.get("method").and_then(JsonValue::as_str) == Some("notifications/initialized") {
            server.initialized = true;
            log_line(
                "mcp",
                "info",
                "notifications/initialized",
                &JsonValue::Null,
                0,
                None,
            );
        }
        return None;
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
            log_line("mcp", "error", "", &id, 0, Some(&message));
            return Some(json_string(error_response(
                &id,
                INVALID_REQUEST,
                message,
                None,
            )));
        }
    };
    let params = obj.get("params").cloned().unwrap_or(JsonValue::Null);
    let outcome: Result<Option<JsonValue>, RpcFailure> = match method.as_str() {
        "initialize" => {
            // initialize 请求：返回 serverInfo；此后允许 initialized 通知推进
            server.init_ok = true;
            Ok(Some(response(
                &id,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                }),
            )))
        }
        "ping" => Ok(Some(response(&id, JsonValue::Object(Default::default())))),
        "tools/list" => {
            if !server.tools_ready() {
                Err(McpServer::fail_uninitialized())
            } else {
                let tools: Vec<JsonValue> = server
                    .tools()
                    .iter()
                    .map(|spec| {
                        json!({
                            "name": spec.name,
                            "description": spec.description,
                            "inputSchema": spec.input_schema,
                        })
                    })
                    .collect();
                Ok(Some(response(&id, json!({ "tools": tools }))))
            }
        }
        "tools/call" => {
            if !server.tools_ready() {
                Err(McpServer::fail_uninitialized())
            } else {
                handle_tool_call(server, &params).map(|result| Some(response(&id, result)))
            }
        }
        _ => Err(RpcFailure {
            code: METHOD_NOT_FOUND,
            message: format!("方法未实现: {method}"),
            reason: "method",
        }),
    };
    match outcome {
        Ok(Some(resp)) => {
            log_line("mcp", "info", &method, &id, 0, None);
            Some(json_string(resp))
        }
        Ok(None) => {
            log_line("mcp", "info", &method, &id, 0, None);
            None
        }
        Err(failure) => {
            let detail = format!("{}/{}", failure.reason, failure.message);
            log_line("mcp", "error", &method, &id, 0, Some(&detail));
            Some(json_string(error_response(
                &id,
                failure.code,
                failure.message,
                Some(json!({ "reason": failure.reason })),
            )))
        }
    }
}

fn json_string(value: JsonValue) -> String {
    value.to_string()
}

/// tools/call：工具名/参数形状 → 执行结果（MCP 工具结果形态）。
fn handle_tool_call(server: &mut McpServer, params: &JsonValue) -> Result<JsonValue, RpcFailure> {
    let obj = params
        .as_object()
        .ok_or_else(|| invalid_params("tools/call 参数须为对象"))?;
    let name = obj
        .get("name")
        .and_then(JsonValue::as_str)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid_params("tools/call 缺 name（工具名）"))?;
    let known = server.tools().iter().any(|spec| spec.name == name);
    if !known {
        return Err(invalid_params(format!("未知工具: {name}")));
    }
    let args = obj.get("arguments").cloned().unwrap_or(JsonValue::Null);
    let args_obj = args
        .as_object()
        .ok_or_else(|| invalid_params("tools/call arguments 须为对象"))?;
    let result = match name {
        "embed" => run_embed(server, args_obj),
        _ => run_exec_tool(server, name, args_obj),
    };
    Ok(result)
}

/// 组装信封并走 exec ops::execute（file/process/doc 物理执行体的唯一通道）。
fn run_exec_tool(
    server: &McpServer,
    tool: &str,
    args: &serde_json::Map<String, JsonValue>,
) -> JsonValue {
    let outcome = exec_tool(server, tool, args);
    match outcome {
        Ok(output) => success_result(&output),
        Err(deny) => deny_result(&deny),
    }
}

/// 工具参数 → op/端点归属/组装信封 → ops::execute。
fn exec_tool(
    server: &McpServer,
    tool: &str,
    args: &serde_json::Map<String, JsonValue>,
) -> Result<JsonValue, ink_ts_exec::envelope::Deny> {
    let root_text = server.root.as_deref().ok_or_else(McpServer::root_deny)?;
    let (op, synthesized, cwd, env, timeout_secs) = match tool {
        "file_read" => ("file", synth_file("read", args), None, None, 0),
        "file_list" => ("file", synth_file("list", args), None, None, 0),
        "file_write" => ("file", synth_file("write", args), None, None, 0),
        "doc_parse" => ("doc", synth_file("parse", args), None, None, 0),
        "process_exec" => {
            if server.process_allow.is_empty() {
                return Err(ink_ts_exec::envelope::Deny::new(
                    "allowlist",
                    "INK_MCP_PROCESS_ALLOW 未配置——进程工具无放行命令（fail-closed）",
                ));
            }
            (
                "process",
                synth_process_args(args)?,
                string_field(args, "cwd")?,
                env_field(args)?,
                int_field(args, "timeout_secs")?.unwrap_or(PROCESS_DEFAULT_TIMEOUT_SECS),
            )
        }
        other => {
            return Err(ink_ts_exec::envelope::Deny::new(
                "tool",
                format!("未知物理工具: {other}"),
            ))
        }
    };
    let endpoint = match op {
        "process" => "os",
        "file" | "doc" => "file",
        _ => unreachable!("op 归属表由上方 tool 分支限定"),
    };
    let allowlist = if op == "process" {
        server.process_allow.clone()
    } else {
        Vec::new()
    };
    let timeout_secs = if timeout_secs <= 0 {
        PROCESS_DEFAULT_TIMEOUT_SECS
    } else {
        timeout_secs.min(3600)
    };
    let serial = server.next_serial();
    let envelope = Envelope {
        version: ink_ts_exec::envelope::ENVELOPE_VERSION,
        id: format!("mcp-{tool}-{serial}"),
        tool: tool.to_string(),
        op: op.to_string(),
        args: synthesized,
        endpoint: endpoint.to_string(),
        roots: vec![root_text.to_string()],
        allowlist,
        cwd,
        env,
        timeout_secs,
        max_chars: DEFAULT_MAX_CHARS,
        nonce: serial,
        issued_at: ink_ts_rpc::code::epoch_ms().try_into().unwrap_or(0),
        decision: ink_ts_exec::envelope::Decision {
            approved: true,
            by: "ink_ts_mcp".to_string(),
            trace_id: None,
        },
    };
    ops::execute(&envelope)
}

/// file/doc 系列工具参数组装（subop + path[+content]）。
fn synth_file(subop: &str, args: &serde_json::Map<String, JsonValue>) -> JsonValue {
    let mut out = serde_json::Map::new();
    out.insert("subop".to_string(), JsonValue::String(subop.to_string()));
    if let Ok(Some(path)) = string_field(args, "path") {
        out.insert("path".to_string(), JsonValue::String(path));
    }
    if let Some(content) = args.get("content").and_then(JsonValue::as_str) {
        out.insert(
            "content".to_string(),
            JsonValue::String(content.to_string()),
        );
    }
    JsonValue::Object(out)
}

/// process_exec 参数组装（argv；缺参数时留待 exec 参数校验拒绝——错误
/// 信息与 exec 一致，fail-closed 不静默）。
fn synth_process_args(
    args: &serde_json::Map<String, JsonValue>,
) -> Result<JsonValue, ink_ts_exec::envelope::Deny> {
    let raw = args
        .get("argv")
        .ok_or_else(|| invalid_params_deny("process_exec 缺 argv"))?;
    let items = raw
        .as_array()
        .ok_or_else(|| invalid_params_deny("argv 须为字符串数组"))?;
    if items.is_empty() {
        return Err(invalid_params_deny("argv 不能为空（缺命令名）"));
    }
    let argv: Vec<JsonValue> = items
        .iter()
        .map(|item| {
            item.as_str()
                .map(|text| JsonValue::String(text.to_string()))
                .ok_or_else(|| invalid_params_deny("argv 元素须为字符串"))
        })
        .collect::<Result<_, _>>()?;
    Ok(json!({ "argv": argv }))
}

/// 进程 env 面：仅放行 INK_* 与基础平台键、禁覆写密钥样键名；输出 =
/// 受限基础面 + 放行覆盖（env 缺省 None → exec 注入纯受限面）。
fn env_field(
    args: &serde_json::Map<String, JsonValue>,
) -> Result<Option<JsonValue>, ink_ts_exec::envelope::Deny> {
    let Some(raw) = args.get("env") else {
        return Ok(None);
    };
    let obj = raw
        .as_object()
        .ok_or_else(|| invalid_params_deny("env 须为对象（string→string）"))?;
    let mut overrides: serde_json::Map<String, JsonValue> = serde_json::Map::new();
    for (key, value) in obj {
        if key.is_empty() {
            return Err(ink_ts_exec::envelope::Deny::new("env", "env 键为空"));
        }
        let upper = key.to_ascii_uppercase();
        let secret = SECRET_KEY_MARKERS
            .iter()
            .any(|marker| upper.contains(marker));
        let base = BASE_ENV_KEYS.contains(&key.as_str());
        let ink = key.starts_with("INK_");
        if secret || !(ink || base) {
            return Err(ink_ts_exec::envelope::Deny::new(
                "env",
                format!("进程 env 仅放行 INK_* 与基础平台键且禁覆写密钥样键名: {key}"),
            ));
        }
        let text = value
            .as_str()
            .ok_or_else(|| invalid_params_deny(format!("env[{key}] 须为字符串")))?;
        overrides.insert(key.clone(), JsonValue::String(text.to_string()));
    }
    // 受限基础面（从本进程环境取平台键）+ 放行覆盖；禁覆写密钥由上面已拦
    let mut merged: serde_json::Map<String, JsonValue> = serde_json::Map::new();
    for key in BASE_ENV_KEYS {
        if let Ok(value) = std::env::var(key) {
            merged.insert((*key).to_string(), JsonValue::String(value));
        }
    }
    for (key, value) in overrides {
        merged.insert(key, value);
    }
    Ok(Some(JsonValue::Object(merged)))
}

fn string_field(
    args: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<Option<String>, ink_ts_exec::envelope::Deny> {
    match args.get(key) {
        None => Ok(None),
        Some(JsonValue::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        _ => Err(invalid_params_deny(format!("{key} 须为非空字符串"))),
    }
}

fn int_field(
    args: &serde_json::Map<String, JsonValue>,
    key: &str,
) -> Result<Option<i64>, ink_ts_exec::envelope::Deny> {
    match args.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid_params_deny(format!("{key} 须为整数"))),
    }
}

fn invalid_params_deny(message: impl Into<String>) -> ink_ts_exec::envelope::Deny {
    ink_ts_exec::envelope::Deny::new("params", message)
}

/// embed（shell profile）：infer crate in-process 嵌入面。
///
/// 推理/参数失败一律以工具结果 isError 承载（文本含 reason；形状类参数
/// 违规已在 infer 侧带 reason 归因）。
#[cfg(feature = "embed")]
fn run_embed(server: &mut McpServer, args: &serde_json::Map<String, JsonValue>) -> JsonValue {
    let Some(ctx) = &server.infer_ctx else {
        return deny_result(&Deny::new(
            "tool",
            "embed 工具不可用（shell profile 未装载 infer 面）",
        ));
    };
    let params = JsonValue::Object(args.clone());
    match ink_ts_infer::protocol::embed_result(ctx, &params) {
        Ok(payload) => success_result(&payload),
        Err(failure) => deny_result(&Deny::new("embed", failure.message.clone())),
    }
}

/// embed（编译期 feature 关闭 = 工具目录不含 embed；防御分支）。
#[cfg(not(feature = "embed"))]
fn run_embed(_server: &mut McpServer, _args: &serde_json::Map<String, JsonValue>) -> JsonValue {
    deny_result(&ink_ts_exec::envelope::Deny::new(
        "tool",
        "embed 工具不可用（构建未启用 embed feature）",
    ))
}

/// 成功工具结果（MCP 形态：text 内容承载 op 输出 JSON）。
fn success_result(payload: &JsonValue) -> JsonValue {
    json!({
        "content": [{ "type": "text", "text": payload.to_string() }],
        "isError": false,
    })
}

/// 守门拒绝工具结果（MCP 形态：isError=true，文本含 reason 分类）。
fn deny_result(deny: &ink_ts_exec::envelope::Deny) -> JsonValue {
    json!({
        "content": [{ "type": "text", "text": format!("[{}] {}", deny.reason, deny.message) }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::encode_frame;
    use serde_json::json;
    use uuid::Uuid;

    fn scratch_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ink-mcp-{label}-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn server_with_root(root: &std::path::Path, allow: &[&str]) -> McpServer {
        McpServer::with_config(
            Profile::Exec,
            Some(root.to_string_lossy().into_owned()),
            allow.iter().map(|item| item.to_string()).collect(),
        )
    }

    fn parse_response(line: &str) -> JsonValue {
        serde_json::from_str(line).expect("响应须为 JSON")
    }

    fn json_rpc(id: i64, method: &str, params: JsonValue) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    fn json_rpc_notify(method: &str, params: JsonValue) -> String {
        json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
    }

    fn initialize(server: &mut McpServer) {
        let resp = handle_line(server, &json_rpc(1, "initialize", json!({}))).unwrap();
        let result = parse_response(&resp)["result"].clone();
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["protocolVersion"], PROTOCOL_VERSION);
        assert!(handle_line(
            server,
            &json_rpc_notify("notifications/initialized", json!({}))
        )
        .is_none());
    }

    fn call_tool(server: &mut McpServer, name: &str, arguments: JsonValue) -> JsonValue {
        let resp = handle_line(
            server,
            &json_rpc(
                7,
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            ),
        )
        .unwrap();
        let parsed = parse_response(&resp);
        assert!(parsed.get("result").is_some(), "响应应为 result: {parsed}");
        parsed["result"].clone()
    }

    #[test]
    fn tools_require_initialize_and_initialized() {
        let dir = scratch_dir("gate");
        let mut server = server_with_root(&dir, &[]);
        // 未初始化：tools/list 拒绝
        let resp = handle_line(&mut server, &json_rpc(1, "tools/list", json!({}))).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "init");
        // initialize 完成但仍未收 initialized 通知：tools/call 拒绝
        initialize(&mut server);
        server.initialized = false;
        let resp = handle_line(&mut server, &json_rpc(2, "tools/list", json!({}))).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "init");
        // 通知后再列：成功
        handle_line(
            &mut server,
            &json_rpc_notify("notifications/initialized", json!({})),
        );
        let resp = handle_line(&mut server, &json_rpc(3, "tools/list", json!({}))).unwrap();
        let parsed = parse_response(&resp);
        let tools = parsed["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|tool| tool["name"] == "file_read"));
        assert!(tools.iter().any(|tool| tool["name"] == "process_exec"));
    }

    #[test]
    fn unknown_method_is_32601() {
        let dir = scratch_dir("unknown");
        let mut server = server_with_root(&dir, &[]);
        let resp = handle_line(&mut server, &json_rpc(1, "no/such", json!({}))).unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["code"], METHOD_NOT_FOUND as f64);
    }

    #[test]
    fn notifications_prefix_with_id_is_unknown_method() {
        let dir = scratch_dir("notify-id");
        let mut server = server_with_root(&dir, &[]);
        let resp = handle_line(
            &mut server,
            &json_rpc(1, "notifications/initialized", json!({})),
        )
        .unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["code"], METHOD_NOT_FOUND as f64);
    }

    #[test]
    fn file_write_then_read_within_root() {
        let dir = scratch_dir("rw");
        let path = dir.join("notes.txt");
        let mut server = server_with_root(&dir, &[]);
        initialize(&mut server);
        let written = call_tool(
            &mut server,
            "file_write",
            json!({ "path": path.to_string_lossy(), "content": "你好 ink_ts_mcp" }),
        );
        assert_eq!(written["isError"], false);
        let read = call_tool(
            &mut server,
            "file_read",
            json!({ "path": path.to_string_lossy() }),
        );
        assert_eq!(read["isError"], false);
        let text = read["content"][0]["text"].as_str().unwrap();
        let output: JsonValue = serde_json::from_str(text).unwrap();
        assert!(output["content"]
            .as_str()
            .unwrap()
            .contains("你好 ink_ts_mcp"));
    }

    #[test]
    fn path_outside_root_is_refused() {
        let dir = scratch_dir("outside");
        let outside = std::env::temp_dir().join(format!("ink-mcp-outside-{}.txt", Uuid::new_v4()));
        std::fs::write(&outside, b"x").unwrap();
        let mut server = server_with_root(&dir, &[]);
        initialize(&mut server);
        let read = call_tool(
            &mut server,
            "file_read",
            json!({ "path": outside.to_string_lossy() }),
        );
        assert_eq!(read["isError"], true);
        let text = read["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[root]"), "text={text}");
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn dotdot_path_is_refused() {
        let dir = scratch_dir("dotdot");
        let mut server = server_with_root(&dir, &[]);
        initialize(&mut server);
        let escape = dir.join("..").join("escape.txt");
        let written = call_tool(
            &mut server,
            "file_write",
            json!({ "path": escape.to_string_lossy(), "content": "x" }),
        );
        assert_eq!(written["isError"], true);
        let text = written["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[root]"), "text={text}");
        assert!(text.contains(".."), "text={text}");
    }

    #[test]
    fn no_root_fails_closed_for_path_tools() {
        let mut server = McpServer::with_config(Profile::Exec, None, vec![]);
        initialize(&mut server);
        let read = call_tool(&mut server, "file_read", json!({ "path": "C:\\x" }));
        assert_eq!(read["isError"], true);
        let text = read["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[no_root]"), "text={text}");
    }

    #[test]
    fn process_allowlisted_command_runs_inside_root() {
        let dir = scratch_dir("proc");
        #[cfg(windows)]
        let argv = json!(["cmd", "/C", "echo", "mcp-proc-ok"]);
        #[cfg(not(windows))]
        let argv = json!(["echo", "mcp-proc-ok"]);
        let mut server = server_with_root(&dir, &["cmd", "echo"]);
        initialize(&mut server);
        let result = call_tool(&mut server, "process_exec", json!({ "argv": argv }));
        assert_eq!(result["isError"], false);
        let text = result["content"][0]["text"].as_str().unwrap();
        let output: JsonValue = serde_json::from_str(text).unwrap();
        assert_eq!(output["exit_code"], 0);
        assert!(output["stdout"].as_str().unwrap().contains("mcp-proc-ok"));
    }

    #[test]
    fn process_non_allowlisted_command_is_refused() {
        let dir = scratch_dir("proc-deny");
        let mut server = server_with_root(&dir, &["git"]);
        initialize(&mut server);
        let result = call_tool(
            &mut server,
            "process_exec",
            json!({ "argv": ["evil-tool-xyz", "x"] }),
        );
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[allowlist]"), "text={text}");
    }

    #[test]
    fn process_requires_allowlist_configured() {
        let dir = scratch_dir("proc-noallow");
        let mut server = server_with_root(&dir, &[]);
        initialize(&mut server);
        let result = call_tool(&mut server, "process_exec", json!({ "argv": ["git", "x"] }));
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[allowlist]"), "text={text}");
    }

    #[test]
    fn process_env_secret_like_keys_are_blocked() {
        let dir = scratch_dir("proc-env");
        let mut server = server_with_root(&dir, &["cmd", "echo"]);
        initialize(&mut server);
        let result = call_tool(
            &mut server,
            "process_exec",
            json!({ "argv": ["echo", "x"], "env": { "MY_API_KEY": "sekret" } }),
        );
        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[env]"), "text={text}");
        // INK_ 前缀但密钥样键名同样禁覆写
        let result = call_tool(
            &mut server,
            "process_exec",
            json!({ "argv": ["echo", "x"], "env": { "INK_EMBEDDING_API_KEY": "sekret" } }),
        );
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("[env]"), "text={text}");
    }

    #[test]
    fn process_env_allows_ink_and_base_keys() {
        let dir = scratch_dir("proc-env-ok");
        #[cfg(windows)]
        let argv = json!(["cmd", "/C", "echo", "ok"]);
        #[cfg(not(windows))]
        let argv = json!(["echo", "ok"]);
        let mut server = server_with_root(&dir, &["cmd", "echo"]);
        initialize(&mut server);
        let result = call_tool(
            &mut server,
            "process_exec",
            json!({ "argv": argv, "env": { "INK_MARKER": "visible" } }),
        );
        assert_eq!(result["isError"], false, "result={result}");
    }

    #[test]
    fn unknown_tool_is_invalid_params() {
        let dir = scratch_dir("unknown-tool");
        let mut server = server_with_root(&dir, &[]);
        initialize(&mut server);
        let resp = handle_line(
            &mut server,
            &json_rpc(5, "tools/call", json!({ "name": "ghost", "arguments": {} })),
        )
        .unwrap();
        let error = parse_response(&resp)["error"].clone();
        assert_eq!(error["data"]["reason"], "params");
        assert!(error["message"].as_str().unwrap().contains("ghost"));
    }

    #[cfg(feature = "embed")]
    #[test]
    fn shell_profile_embed_falls_back_deterministic_without_model() {
        // 显式跳过本地模型（禁环境把计划推到远端/真实模型——测试确定性；
        // 不触碰真实 ONNX 会话）。本测试是包内唯一构造 shell profile 的用例。
        std::env::set_var("INK_EMBEDDING_LOCAL", "off");
        let dir = scratch_dir("embed");
        let mut server = McpServer::with_config(
            Profile::Shell,
            Some(dir.to_string_lossy().into_owned()),
            vec![],
        );
        initialize(&mut server);
        let result = call_tool(
            &mut server,
            "embed",
            json!({ "texts": ["输入一", "输入二"] }),
        );
        assert_eq!(result["isError"], false, "result={result}");
        let text = result["content"][0]["text"].as_str().unwrap();
        let payload: JsonValue = serde_json::from_str(text).unwrap();
        assert_eq!(payload["source"], "deterministic");
        let vectors = payload["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 2);
    }

    #[test]
    fn frame_decode_then_handle_line() {
        // 帧解码在 main 循环（read_frame），handle_line 消费帧体 JSON——
        // 两条路径经此串联验证（Content-Length 帧 → 解码 → 协议响应）。
        let dir = scratch_dir("frame");
        let mut server = server_with_root(&dir, &[]);
        let payload = r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#;
        let frame = encode_frame(payload);
        let mut cursor = std::io::Cursor::new(frame.as_slice());
        let item = crate::frame::read_frame(&mut cursor)
            .unwrap()
            .unwrap()
            .unwrap();
        let body = String::from_utf8(item).unwrap();
        let resp = handle_line(&mut server, body.trim()).unwrap();
        assert!(parse_response(&resp).get("result").is_some());
    }

    #[test]
    fn ping_before_initialize_is_allowed() {
        let dir = scratch_dir("ping");
        let mut server = server_with_root(&dir, &[]);
        let resp = handle_line(&mut server, &json_rpc(1, "ping", json!({}))).unwrap();
        assert!(parse_response(&resp).get("result").is_some());
    }
}

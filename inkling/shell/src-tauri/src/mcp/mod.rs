//! 设备感知 server（宿主件挂载接线）：stdio JSON-RPC（MCP 形态）。
//!
//! 供引擎侧 mcp_client 挂载（宿主进程 spawn 本 server 或进程内调用）；
//! 协议与 M1 执行件 conformance 同构：initialize → tools/list → tools/call。
//! 感知工具（screen_query/file_query，声明 endpoint=device_mcp）经统一
//! 执行器注册表执行——同一套权限/沙箱守卫，无第二条执行路径。
//!
//! 挂载接线：DeviceServer::handle_line(line) 单行处理（stdin 逐行读 →
//! stdout 逐行写）；测试直接驱动 handle_line（免真实桌面）。

use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::executors::backends::SystemBackend;
use super::executors::impls::Authorization;
use super::executors::registry::ExecutorRegistry;
use super::executors::tool_decl::Endpoint;

/// 设备感知 server 上下文（注册表 + 后端 + 授权面）
pub struct DeviceServer<'a> {
    registry: &'a ExecutorRegistry,
    backend: &'a dyn SystemBackend,
}

impl<'a> DeviceServer<'a> {
    pub fn new(registry: &'a ExecutorRegistry, backend: &'a dyn SystemBackend) -> Self {
        Self { registry, backend }
    }

    /// 感知工具清单（声明 endpoint = device_mcp 的执行器）
    fn device_tools(&self) -> Vec<String> {
        self.registry
            .names()
            .into_iter()
            .filter(|name| {
                self.registry
                    .get(name)
                    .map(|e| e.spec().endpoint == Endpoint::DeviceMcp)
                    .unwrap_or(false)
            })
            .collect()
    }

    /// 单行 JSON-RPC 处理：返回响应行（无响应 = None）。
    /// 未知方法/解析失败 → JSON-RPC 错误响应（不崩，保持会话存活）。
    pub fn handle_line(&self, line: &str) -> Option<String> {
        let request: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(err) => {
                return Some(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("parse error: {err}") }
                })
                .to_string());
            }
        };

        let method = request.get("method").and_then(Value::as_str);
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let params = request.get("params").cloned().unwrap_or(Value::Null);

        match method {
            Some("initialize") => Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": "inkling_device", "version": "0.1.0" }
                    }
                })
                .to_string(),
            ),
            Some("tools/list") => {
                let tools: Vec<Value> = self
                    .device_tools()
                    .into_iter()
                    .map(|name| {
                        let executor = self.registry.get(&name).expect("感知工具已注册");
                        let spec = executor.spec();
                        json!({
                            "name": name,
                            "description": "设备感知（声明驱动，权限/沙箱守卫与 process_exec 同源）",
                            "inputSchema": {
                                "type": "object",
                                "properties": schema_properties(spec),
                                "required": spec.params.iter().filter(|p| p.required).map(|p| p.name).collect::<Vec<_>>(),
                            }
                        })
                    })
                    .collect();
                Some(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tools } }).to_string())
            }
            Some("tools/call") => {
                let tool = params.get("name").and_then(Value::as_str).unwrap_or("");
                let executor = self.registry.get(tool);
                // 端点隔离：设备 server 只服务 device_mcp 端点工具（process_exec
                // 工具走引擎统一流水线 + 审批面，不经本 server 绕行）
                let is_device_tool = executor
                    .map(|e| e.spec().endpoint == Endpoint::DeviceMcp)
                    .unwrap_or(false);
                if !is_device_tool {
                    return Some(
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32602, "message": format!("tool not served by device server: {tool}") }
                        })
                        .to_string(),
                    );
                }
                let args = params
                    .get("arguments")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect::<BTreeMap<String, Value>>();
                // 设备感知工具审批语义与 process_exec 同源：审批闸门在引擎
                // 侧 approval 档（seed 单源，出厂 review），此处只强制沙箱
                let auth = Authorization { approved: true };
                match self.registry.run(tool, &args, self.backend, &auth) {
                    Ok(outcome) => Some(
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "content": [{ "type": "text", "text": outcome.result }],
                                "isError": false,
                                "sandbox_checked": outcome.sandbox_checked,
                            }
                        })
                        .to_string(),
                    ),
                    Err(err) => Some(
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32001, "message": err.to_string() }
                        })
                        .to_string(),
                    ),
                }
            }
            Some(method) if method.starts_with("notifications/") => None,
            Some(method) => Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": format!("method not found: {method}") }
                })
                .to_string(),
            ),
            None => Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32600, "message": "invalid request" }
                })
                .to_string(),
            ),
        }
    }
}

fn schema_properties(spec: &super::executors::impls::ExecutorSpec) -> BTreeMap<String, Value> {
    spec.params
        .iter()
        .map(|param| {
            let schema = match param.param_type {
                super::executors::tool_decl::ParamType::String => json!({ "type": "string" }),
                super::executors::tool_decl::ParamType::Integer => json!({ "type": "integer" }),
                super::executors::tool_decl::ParamType::Number => json!({ "type": "number" }),
                super::executors::tool_decl::ParamType::Boolean => json!({ "type": "boolean" }),
            };
            (param.name.to_string(), schema)
        })
        .collect()
}

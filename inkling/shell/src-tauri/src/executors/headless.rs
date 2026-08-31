//! headless 形态的 OS 执行器接线：把引擎回合内的 OS 工具调用（process_exec
//! 端点 → 宿主 os_registry 分发 → `os.dispatch` 回调）转发到本进程内声明的
//! 执行器注册表（PlatformBackend 真实子进程/系统调用）。
//!
//! 与桌面壳 `os.dispatch` 回调同口径：审批裁决经壳侧审批台账（L2——headless
//! 授权语义由调用方显式声明，等同 CLI `--approve`，台账按此配置为全量自动
//! 审批；无任何硬编码 approved 字面量）；端点隔离（L7）与沙箱守卫在注册表
//! 层强制。
//!
//! 注册表从 `tools_os.json` 声明构建（与 `run_os_op` 同一路径），回调按名
//! 分发；未注册工具 = 结构化 `executor_error`（fail-closed，不崩溃）。

use std::collections::BTreeMap;

use serde_json::Value as JsonValue;

use super::backends::PlatformBackend;
use super::registry::{build_registry_from_declarations, CallGate, ExecutorRegistry};
use super::tool_decl::load_tool_declarations;
use super::tool_decl::Endpoint;
use crate::commands::approval::ApprovalLedger;
use crate::engine::bridge::register_callback;

/// 注册 headless `os.dispatch` 回调（引擎回合线程经回调桥调用本注册表）。
///
/// 回调载荷形态（与引擎侧 os_registry.dispatch 同构）：`{"tool": ..., "args": {...}}`；
/// 返回 `{"ok": true, "result": ...}` 或 `{"ok": false, "status": "executor_error",
/// "error": "...", "code": "...", "trace_id": "..."}`（L6：错误信封
/// {code, message, trace_id} 字段级对齐；error 保持字符串 = 引擎消费契约不变）。
/// 重复注册同名 = 覆盖（幂等，与既有回调语义一致）。
pub fn register_headless_os_dispatch(tools_os_json: &str) -> Result<(), String> {
    let declarations = load_tool_declarations(tools_os_json)
        .map_err(|err| format!("工具声明解析失败: {err}"))?;
    let registry = build_registry_from_declarations(&declarations)
        .map_err(|err| format!("执行器注册契约校验失败: {err}"))?;
    // L2：审批裁决经壳侧审批台账（决议 8 语义：headless 无人值守定位，
    // 授权由调用方显式声明，等同 CLI --approve → 台账配置全量自动审批；
    // 无硬编码 approved 字面量，未来接入真实审批态可翻转配置）。
    let approval = ApprovalLedger::from_declarations(&declarations);
    approval.set_auto_approve(Vec::new(), true);

    register_callback(
        "os.dispatch",
        Box::new(move |payload: String| -> pyo3::PyResult<String> {
            let trace_id = uuid::Uuid::new_v4().simple().to_string();
            let parsed: JsonValue = serde_json::from_str(&payload).map_err(|err| {
                pyo3::exceptions::PyValueError::new_err(format!("os.dispatch 载荷非法: {err}"))
            })?;
            let tool = parsed
                .get("tool")
                .and_then(JsonValue::as_str)
                .ok_or_else(|| pyo3::exceptions::PyValueError::new_err("os.dispatch 缺 tool"))?
                .to_string();
            let args_obj = parsed
                .get("args")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(Default::default()));
            let args_map: BTreeMap<String, JsonValue> = args_obj
                .as_object()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let backend = PlatformBackend;
            // 审批裁决与桌面壳同源（引擎通道语义）：引擎放行态登记入台账后
            // 经同一裁决函数放行；执行器层只强制沙箱/签名
            approval.record_engine_dispatch(&tool, &args_map);
            let auth = approval.adjudicate(&tool, &args_map);
            // 动态挂载根：headless 经 INKENGINE_WS_ROOT 授权工作区（与桌面壳
            // state.mounts 并入路径根沙箱同语义）——open_file/file_query 等
            // 路径根工具按「声明根 + 实际工作区根」裁决，不钉死出厂默认根
            let mut gate = CallGate::new(Endpoint::ProcessExec);
            if let Ok(ws) = std::env::var("INKENGINE_WS_ROOT") {
                let ws = ws.trim();
                if !ws.is_empty() {
                    gate = CallGate::with_roots(Endpoint::ProcessExec, vec![ws.to_string()]);
                }
            }
            match registry.run(&tool, &args_map, &backend, &auth, &gate) {
                Ok(outcome) => Ok(serde_json::json!({
                    "ok": true,
                    "result": outcome.result,
                })
                .to_string()),
                Err(err) => Ok(serde_json::json!({
                    "ok": false,
                    "status": "executor_error",
                    "error": err.to_string(),
                    "code": "EXECUTOR_ERROR",
                    "trace_id": trace_id,
                })
                .to_string()),
            }
        }),
    )
    .map_err(|err| format!("os.dispatch 回调注册失败: {err}"))
}

/// 声明驱动注册（headless 注册表构建的只读入口：供回调注册前的契约校验与
/// 单测断言使用；实际回调持有的是同一注册表实例）。
pub fn build_headless_registry(tools_os_json: &str) -> Result<ExecutorRegistry, String> {
    let declarations = load_tool_declarations(tools_os_json)
        .map_err(|err| format!("工具声明解析失败: {err}"))?;
    build_registry_from_declarations(&declarations)
        .map_err(|err| format!("执行器注册契约校验失败: {err}"))
}

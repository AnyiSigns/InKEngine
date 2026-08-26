//! headless 形态的 OS 执行器接线：把引擎回合内的 OS 工具调用（process_exec
//! 端点 → 宿主 os_registry 分发 → `os.dispatch` 回调）转发到本进程内声明的
//! 执行器注册表（PlatformBackend 真实子进程/系统调用）。
//!
//! 与桌面壳 `os.dispatch` 回调同口径：审批闸门在引擎侧 approval 档已判定，
//! 执行器层只强制沙箱/签名（回调内 Authorization.approved 恒 true——headless
//! 下授权语义由调用方显式声明，等同 CLI `--approve`）。
//!
//! 注册表从 `tools_os.json` 声明构建（与 `run_os_op` 同一路径），回调按名
//! 分发；未注册工具 = 结构化 `executor_error`（fail-closed，不崩溃）。

use std::collections::BTreeMap;

use serde_json::Value as JsonValue;

use super::backends::PlatformBackend;
use super::impls::Authorization;
use super::registry::{build_registry_from_declarations, ExecutorRegistry};
use super::tool_decl::load_tool_declarations;
use crate::engine::bridge::register_callback;

/// 注册 headless `os.dispatch` 回调（引擎回合线程经回调桥调用本注册表）。
///
/// 回调载荷形态（与引擎侧 os_registry.dispatch 同构）：`{"tool": ..., "args": {...}}`；
/// 返回 `{"ok": true, "result": ...}` 或 `{"ok": false, "status": "executor_error", "error": ...}`。
/// 重复注册同名 = 覆盖（幂等，与既有回调语义一致）。
pub fn register_headless_os_dispatch(tools_os_json: &str) -> Result<(), String> {
    let declarations = load_tool_declarations(tools_os_json)
        .map_err(|err| format!("工具声明解析失败: {err}"))?;
    let registry = build_registry_from_declarations(&declarations)
        .map_err(|err| format!("执行器注册契约校验失败: {err}"))?;

    register_callback(
        "os.dispatch",
        Box::new(move |payload: String| -> pyo3::PyResult<String> {
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
            // 审批闸门在引擎侧 approval 档（seed 单源）；执行器层只强制沙箱/签名
            let auth = Authorization { approved: true };
            match registry.run(&tool, &args_map, &backend, &auth) {
                Ok(outcome) => Ok(serde_json::json!({
                    "ok": true,
                    "result": outcome.result,
                })
                .to_string()),
                Err(err) => Ok(serde_json::json!({
                    "ok": false,
                    "status": "executor_error",
                    "error": err.to_string(),
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

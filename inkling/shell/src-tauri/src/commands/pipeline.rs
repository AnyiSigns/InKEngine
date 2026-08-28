//! 流水线安全命令面（D 类：security_section 调用）。
//!
//! `pipeline.security_status` 与 `pipeline.install_security_pipeline` 均为同步
//! op（经同步通道 `call_engine_op` 派发；`invoke_async` 仅派发异步注册表）。
//! 点号命令名经 rename 暴露给前端。

use serde_json::{json, Value as JsonValue};
use tauri::command;

use super::error::CommandError;

/// 转发到同步引擎 op（参数缺省时回退空对象；同步命令体内同步派发）。
fn forward(op: &str, args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::engine::host::call_engine_op(op, args).map_err(CommandError::engine)
}

#[command(rename = "pipeline.security_status")]
pub(crate) fn pipeline_security_status(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward("pipeline.security_status", args)
}

#[command(rename = "pipeline.install_security_pipeline")]
pub(crate) fn pipeline_install_security_pipeline(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward("pipeline.install_security_pipeline", args)
}

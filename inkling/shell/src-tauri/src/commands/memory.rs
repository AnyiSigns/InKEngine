//! 记忆命令面（B 类：引擎缺 op，已在 bridge.py `_register_memory_ops` 补
//! 注册，此处薄转发到对应 `memory.*` op）。
//!
//! 点号命令名经 `#[command(rename = "...")]` 暴露给前端（前端按点号名调用）。

use serde_json::{json, Value as JsonValue};
use tauri::command;

use super::error::CommandError;

/// 转发到引擎 op：参数缺省时回退空对象（兼容前端无参调用）。
async fn forward(op: &str, args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::engine::host::call_engine_op_async(op, args)
        .await
        .map_err(CommandError::engine)
}

#[command(rename = "memory.list")]
pub(crate) async fn memory_list(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("memory.list", args).await
}

#[command(rename = "memory.invalidate")]
pub(crate) async fn memory_invalidate(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("memory.invalidate", args).await
}

#[command(rename = "memory.update_frontmatter")]
pub(crate) async fn memory_update_frontmatter(
    args: Option<JsonValue>,
) -> Result<JsonValue, CommandError> {
    forward("memory.update_frontmatter", args).await
}

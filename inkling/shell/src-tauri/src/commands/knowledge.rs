//! 知识集命令面（B 类：引擎缺 op，已在 bridge.py `_register_knowledge_ops`
//! 补注册，此处薄转发到对应 `knowledge.*` op）。
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

#[command(rename = "knowledge.list")]
pub(crate) async fn knowledge_list(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.list", args).await
}

#[command(rename = "knowledge.add")]
pub(crate) async fn knowledge_add(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.add", args).await
}

#[command(rename = "knowledge.promote")]
pub(crate) async fn knowledge_promote(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.promote", args).await
}

#[command(rename = "knowledge.archive")]
pub(crate) async fn knowledge_archive(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.archive", args).await
}

#[command(rename = "knowledge.restore")]
pub(crate) async fn knowledge_restore(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.restore", args).await
}

#[command(rename = "knowledge.export")]
pub(crate) async fn knowledge_export(args: Option<JsonValue>) -> Result<JsonValue, CommandError> {
    forward("knowledge.export", args).await
}

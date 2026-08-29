//! MCP 市场命令面：市场管理（状态/添加/删除）+ 服务挂载/卸载。
//!
//! 桥接：全部转发到 Python host 的 mcp.market_* op（McpMountService
//! 为挂载双入口的共用编排：连接页手动挂载走 require_approval=False
//! 免审批卡；agent 对话式安装仍走 propose_mcp_mount 挂卡路径）。

use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, State};

use super::error::CommandError;
use crate::{ShellState, app_data_dir, block_on_op_async, ensure_engine};

/// 统一驱动引擎异步 op（装配就绪 + 同步阻塞等引擎循环）。
///
/// 装配失败映射 INTERNAL（与其他命令 ensure_engine 的 `?` 回落一致，
/// 避免同一失败在不同命令面产生不同错误码）；引擎 op 执行失败映射
/// ENGINE。
fn run_mcp_op(
    app: &AppHandle,
    state: &State<'_, ShellState>,
    op: &str,
    args: JsonValue,
) -> Result<JsonValue, CommandError> {
    let data_dir = app_data_dir(app)?;
    ensure_engine(app, state, &data_dir).map_err(CommandError::internal)?;
    block_on_op_async(op, args).map_err(CommandError::engine)
}

/// 市场 + 挂载状态（设置「连接」/「市场」视图数据源）。
#[tauri::command]
pub(crate) fn mcp_market_status(
    app: AppHandle,
    state: State<'_, ShellState>,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_status", json!({}))
}

/// 市场一键挂载（手动挂载：免挂载审批卡）。
#[tauri::command]
pub(crate) fn mcp_market_mount(
    app: AppHandle,
    state: State<'_, ShellState>,
    server_id: String,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_mount", json!({ "server_id": server_id }))
}

/// 市场服务取消挂载（补丁链回退 + 会话断开）。
#[tauri::command]
pub(crate) fn mcp_market_unmount(
    app: AppHandle,
    state: State<'_, ShellState>,
    server_id: String,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_unmount", json!({ "server_id": server_id }))
}

/// 市场摄入预览（拉取 + vetting + 摘要；不落注册表）。
#[tauri::command]
pub(crate) fn mcp_market_preview(
    app: AppHandle,
    state: State<'_, ShellState>,
    link: String,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_preview", json!({ "link": link }))
}

/// 添加市场（外部目录摄入：预览确认后落注册表持久化）。
#[tauri::command]
pub(crate) fn mcp_market_add(
    app: AppHandle,
    state: State<'_, ShellState>,
    link: String,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_add", json!({ "link": link }))
}

/// 删除市场（内置不可删；级联卸载其下服务）。
#[tauri::command]
pub(crate) fn mcp_market_remove(
    app: AppHandle,
    state: State<'_, ShellState>,
    market_id: String,
) -> Result<JsonValue, CommandError> {
    run_mcp_op(&app, &state, "mcp.market_remove", json!({ "market_id": market_id }))
}

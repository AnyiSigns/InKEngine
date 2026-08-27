//! OS 执行命令面（process_exec / device_mcp_call）：统一审批台账裁决 +
//! 端点隔离（L7）+ 动态挂载根（L4）+ 用户可见结果脱敏（S10）。

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

use tauri::State;

use super::error::CommandError;
use crate::executors::backends::ShellBackend;
use crate::executors::registry::CallGate;
use crate::executors::tool_decl::Endpoint;
use crate::{DEFAULT_MOUNT_ROOT, ShellState, expand_home};

/// 用户可见结果脱敏（S10）：工作区绝对路径 → `<workspace>` 占位；审计侧
/// 日志保留完整文本（process_exec/device_mcp_call 审计分层——完整结果只进
/// 本地日志，回传前端的结果为脱敏形态）。
pub fn redact_workspace(text: &str, root: &Path) -> String {
    let root_text = root.to_string_lossy();
    text.replace(&*root_text, "<workspace>")
        .replace(&root_text.replace('\\', "/"), "<workspace>")
}

/// 工作区根（沙箱根 + 脱敏替换目标）。
fn workspace_root() -> PathBuf {
    expand_home(DEFAULT_MOUNT_ROOT)
}

/// 授权挂载点集合（决议 14：`state.mounts` 并入路径根沙箱动态根——
/// 命令面把授权挂载点随调用闸门传入注册表，执行器按「声明根 + 动态挂载根」
/// 裁决）。
fn dynamic_roots(state: &ShellState) -> Vec<String> {
    state
        .mounts
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.display().to_string())
        .collect()
}

/// process_exec 命令：统一审批台账裁决（决议 4）——命令层不再接受客户端
/// approved 布尔；`registry.run` 前壳侧按档位表 + 审批台账自行裁决
/// （无服务端审批态时 review 档被拒，fail-closed）。端点隔离 = process_exec
/// （L7：不可调 device_mcp 工具）。
#[tauri::command]
pub(crate) fn process_exec(
    state: State<'_, ShellState>,
    backend: State<'_, ShellBackend>,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    let args_map = args
        .as_object()
        .cloned()
        .map(|map| map.into_iter().collect::<BTreeMap<String, serde_json::Value>>())
        .ok_or_else(|| CommandError::invalid_arg(format!("工具参数须为对象: {tool}")))?;
    let auth = state.approval.adjudicate(&tool, &args_map);
    let gate = CallGate::with_roots(Endpoint::ProcessExec, dynamic_roots(&state));
    let outcome = state
        .registry
        .run(&tool, &args_map, backend.inner(), &auth, &gate)
        .map_err(|err| CommandError::new("EXECUTOR", err.to_string()))?;
    // 审计分层（S10）：完整结果留本地日志；用户可见结果经工作区路径脱敏
    eprintln!(
        "[process_exec] tool={tool} sandbox={} result={}",
        outcome.sandbox_checked, outcome.result
    );
    Ok(serde_json::json!({
        "tool": tool,
        "result": redact_workspace(&outcome.result, &workspace_root()),
        "sandbox": outcome.sandbox_checked,
    }))
}

/// 设备感知 server 调用（进程内接线形态；宿主侧 MCP stdio 形态见 mcp 模块）。
///
/// 审批语义与 process_exec 同源（决议 4）：壳侧审批台账裁决——引擎审批卡
/// 决议态驱动的批准才放行 review 档，不再硬编码 approved。端点隔离 =
/// device_mcp（L7：不可调 process_exec 工具）。
#[tauri::command]
pub(crate) fn device_mcp_call(
    state: State<'_, ShellState>,
    backend: State<'_, ShellBackend>,
    tool: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    let args_map = args
        .as_object()
        .cloned()
        .map(|map| map.into_iter().collect::<BTreeMap<String, serde_json::Value>>())
        .ok_or_else(|| CommandError::invalid_arg(format!("工具参数须为对象: {tool}")))?;
    let auth = state.approval.adjudicate(&tool, &args_map);
    let gate = CallGate::with_roots(Endpoint::DeviceMcp, dynamic_roots(&state));
    let outcome = state
        .registry
        .run(&tool, &args_map, backend.inner(), &auth, &gate)
        .map_err(|err| CommandError::new("EXECUTOR", err.to_string()))?;
    // 审计分层（S10）：完整结果留本地日志；用户可见结果经工作区路径脱敏
    eprintln!(
        "[device_mcp_call] tool={tool} sandbox={} result={}",
        outcome.sandbox_checked, outcome.result
    );
    Ok(serde_json::json!({
        "tool": tool,
        "result": redact_workspace(&outcome.result, &workspace_root()),
    }))
}

//! 会话命令面（真实数据：引擎 records 通道为数据源）。

use serde_json::{json, Value as JsonValue};

use super::error::CommandError;
use crate::domain::session;

/// 会话清单（按最近活跃倒序；引擎记录为真实数据源）。
#[tauri::command]
pub(crate) async fn session_list() -> Result<JsonValue, CommandError> {
    let sessions = session::fetch_sessions().await.map_err(CommandError::internal)?;
    let rows: Vec<JsonValue> = sessions
        .iter()
        .map(session::session_meta_to_record)
        .collect();
    Ok(json!({ "sessions": rows }))
}

/// 新建会话（引擎线程 id；标题留空待首回合生成）。
#[tauri::command]
pub(crate) async fn session_create() -> Result<JsonValue, CommandError> {
    let id = session::new_thread_id();
    let meta = session::new_session(&id);
    session::save_session(&meta).await.map_err(CommandError::internal)?;
    Ok(session::session_meta_to_record(&meta))
}

/// 重命名会话（手改覆盖标题；≤12 字约束在域层）。
#[tauri::command]
pub(crate) async fn session_rename(thread_id: String, title: String) -> Result<JsonValue, CommandError> {
    let mut meta = session::fetch_session_meta(&thread_id)
        .await
        .map_err(CommandError::internal)?
        .ok_or_else(|| CommandError::not_found(format!("会话不存在: {thread_id}")))?;
    session::rename_session(&mut meta, &title).map_err(CommandError::invalid_arg)?;
    session::save_session(&meta).await.map_err(CommandError::internal)?;
    Ok(session::session_meta_to_record(&meta))
}

/// 删除会话（记录墓碑 + 线程链清理）。
#[tauri::command]
pub(crate) async fn session_delete(thread_id: String) -> Result<JsonValue, CommandError> {
    session::delete_session(&thread_id)
        .await
        .map_err(CommandError::internal)?;
    Ok(json!({ "deleted": true, "thread_id": thread_id }))
}

/// 回合后刷新（消息计数 + 首回合标题生成；幂等）。
#[tauri::command]
pub(crate) async fn session_refresh(thread_id: String) -> Result<JsonValue, CommandError> {
    session::refresh_session_after_round(&thread_id)
        .await
        .map_err(CommandError::internal)
}

/// 会话分支树（链索引 → 叶树；新建会话 = 空树）。
#[tauri::command]
pub(crate) async fn session_tree(thread_id: String) -> Result<JsonValue, CommandError> {
    let tree = session::fetch_branch_tree(&thread_id)
        .await
        .map_err(CommandError::internal)?;
    let nodes: Vec<JsonValue> = tree
        .nodes
        .iter()
        .map(|node| {
            json!({
                "leaf": node.leaf,
                "parent": node.parent,
                "reason": node.reason,
            })
        })
        .collect();
    Ok(json!({
        "session_id": tree.session_id,
        "nodes": nodes,
        "current_leaf": tree.current_leaf,
    }))
}

/// 分支动作（切换叶/切回原叶/链回退/fork 新叶）。
#[tauri::command]
pub(crate) async fn session_branch(
    thread_id: String,
    action: String,
    target_leaf: Option<i64>,
    edit_text: Option<String>,
) -> Result<JsonValue, CommandError> {
    let tree = session::fetch_branch_tree(&thread_id)
        .await
        .map_err(CommandError::internal)?;
    match action.as_str() {
        "branch" => {
            let parent = target_leaf.ok_or_else(|| CommandError::invalid_arg("分支缺父叶"))?;
            let patch = match edit_text {
                Some(text) => json!({
                    "input": text,
                    "messages": [{ "role": "user", "content": text }],
                }),
                None => json!({}),
            };
            let leaf = session::fork_branch(&tree, parent, patch)
                .await
                .map_err(CommandError::internal)?;
            Ok(json!({ "leaf": leaf, "action": "branch" }))
        }
        other => {
            let leaf = session::branch_action(&tree, other, target_leaf)
                .await
                .map_err(CommandError::internal)?;
            Ok(json!({ "leaf": leaf, "action": other }))
        }
    }
}

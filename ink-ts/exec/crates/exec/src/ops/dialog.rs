//! 原生目录选择（宿主 UI 面：exec 稳定原生件承载 OS 对话框）。
//!
//! 语义：host（serve 进程）与浏览器同机时，浏览器无法弹 OS 目录框；本 op
//! 在 exec 进程内弹原生目录选择器（rfd），把所选绝对路径回给 host。
//! 非 agent 工具端点（不经引擎声明式工具），端点 = dialog，仅 host 显式
//! 裁决后下发；用户取消返回 null；无交互桌面会话失败即 fail-closed。

use serde_json::{json, Value as JsonValue};

use crate::envelope::{Deny, Envelope};

/// dialog.open_directory：弹原生目录选择器 → { path: string|null }。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let title = envelope
        .args
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("选择目录");
    match rfd::FileDialog::new().set_title(title).pick_folder() {
        Some(dir) => Ok(json!({ "path": dir.to_string_lossy().to_string() })),
        None => Ok(json!({ "path": null })),
    }
}

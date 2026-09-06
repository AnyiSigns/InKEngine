//! 原生目录选择（宿主 UI 面：exec 稳定原生件承载 OS 对话框）。
//!
//! 语义：host（serve 进程）与浏览器同机时，浏览器无法弹 OS 目录框；本 op
//! 在 exec 进程内弹原生目录选择器（rfd），把所选绝对路径回给 host。
//! 非 agent 工具端点（不经引擎声明式工具），端点 = dialog，仅 host 显式
//! 裁决后下发；用户取消返回 null。
//!
//! 无桌面健壮性：release 档 panic=abort，对话框后端在无图形会话下可能
//! panic，直接裸调会杀死整个 exec 进程。因此先做图形会话探测（Linux 缺
//! DISPLAY/WAYLAND_DISPLAY 即结构化拒绝），rfd 调用再包 catch_unwind
//! 兜底转 Deny——任何路径都不因对话框不可用而 abort 进程。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

use serde_json::{json, Value as JsonValue};

use crate::envelope::{Deny, Envelope};

/// 图形会话探测（Windows/macOS 不依赖 DISPLAY，直接交由 rfd 平台后端；
/// Linux 的 GTK/xdg 后端需要图形会话，缺失即判不可用）。
fn has_graphics_session() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
}

/// 弹原生目录选择器：无图形会话或后端异常 = 结构化 Deny，不 abort。
fn pick_folder(title: &str) -> Result<Option<PathBuf>, Deny> {
    if !has_graphics_session() {
        return Err(Deny::new(
            "dialog",
            "无图形会话（缺 DISPLAY/WAYLAND_DISPLAY），目录对话框不可用",
        ));
    }
    catch_unwind(AssertUnwindSafe(|| {
        rfd::FileDialog::new().set_title(title).pick_folder()
    }))
    .map_err(|_| {
        Deny::new(
            "dialog",
            "原生目录对话框异常退出（无桌面/后端不可用），拒绝而非崩溃",
        )
    })
}

/// dialog.open_directory：弹原生目录选择器 → { path: string|null }。
pub fn run(envelope: &Envelope) -> Result<JsonValue, Deny> {
    let title = envelope
        .args
        .get("title")
        .and_then(|value| value.as_str())
        .unwrap_or("选择目录");
    match pick_folder(title)? {
        Some(dir) => Ok(json!({ "path": dir.to_string_lossy().to_string() })),
        None => Ok(json!({ "path": null })),
    }
}

//! 命令面（Tauri command 层）：lib.rs god-file 按域拆分（L9 决议 12）。
//!
//! 分域：生命周期 / 回合 / 会话 / 授权审批 / 能力 / 备份恢复 / 工具快照 /
//! 后台任务 / 模型指标 / 文件功能域 / 语音 / 离线 / OS 执行。错误统一经
//! [`error::CommandError`]（L6：{code, message, trace_id} 信封）。

pub mod approval;
pub mod backup;
pub mod capability;
pub mod error;
pub mod files;
pub mod lifecycle;
pub mod models;
pub mod offline;
pub mod process;
pub mod rounds;
pub mod sessions;
pub mod tasks;
pub mod tools;
pub mod voice;
pub mod workspace;

pub use error::CommandError;

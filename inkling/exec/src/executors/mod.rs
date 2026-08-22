//! 领域执行体集合（插拔式：新执行体 = 新增文件 + tool.rs 注册表登记）。
//!
//! 每个执行体是纯函数（输入 JSON → 输出 JSON），不持有全局状态，可独立
//! 单测；数据绑定（rules/samples/signals/review.json）经 data.rs 加载，
//! 执行体与数据文件是「谓词名/维度名/信号类名」级别的绑定锚点。

pub mod collect;
pub mod distill;
pub mod mutate;
pub mod parse;
pub mod review;
pub mod score;
pub mod validate;

/// 执行体注册表（协议层 tools/list 与 tools/call 的唯一事实源）。
pub fn registry() -> Vec<crate::tool::ToolDef> {
    crate::tool::registry()
}

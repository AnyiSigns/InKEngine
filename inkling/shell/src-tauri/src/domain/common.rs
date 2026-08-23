//! 域模块共享基础件：域间公共的类型/常量/错误形态。
//!
//! 各域模块只依赖本模块与引擎公开 API，避免相互直接引用；
//! 装配编排只发生在 [`super::boot`]，其余域之间不发生调用。

/// 域层统一错误（消息形态产品可读；域内各模块按其细分错误包装）。
#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("数据缺失或格式非法: {0}")]
    InvalidData(String),
    #[error("存储/持久化操作失败: {0}")]
    Storage(String),
    #[error("引擎调用失败: {0}")]
    Engine(String),
    #[error("外部进程/网络失败: {0}")]
    External(String),
    #[error("{0}")]
    Other(String),
}

impl DomainError {
    /// 构造一般性错误（消息直接透传）。
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}

/// seed_data 17 数据文件清单（与 schema 校验脚本同源；manifest.json 例外：
/// 位于产品根而非 seed_data 目录，单独读取）。
pub const SEED_DATA_FILES: [&str; 17] = [
    "boot_prompt.json",
    "build.json",
    "env.json",
    "event_types.json",
    "graph.json",
    "knowledge.json",
    "mcp_market.json",
    "memory.json",
    "review.json",
    "rules.json",
    "samples.json",
    "signals.json",
    "templates.json",
    "tiers.json",
    "tools.json",
    "ui_spec.json",
    "workflow.json",
];

/// 工作区授权占位符（tools.json 文件工具的 root 值；授权时替换为真实路径）。
pub const WORKSPACE_ROOT_PLACEHOLDER: &str = "${workspace_root}";

/// 出厂工具族分组（工具行/管理台分组展示的元数据键）。
pub const TOOL_GROUP_OS: &str = "os";
pub const TOOL_GROUP_FILE: &str = "file";
pub const TOOL_GROUP_NETWORK: &str = "network";
pub const TOOL_GROUP_RESEARCH: &str = "research";
pub const TOOL_GROUP_MCP: &str = "mcp";
pub const TOOL_GROUP_GENERIC: &str = "generic";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_file_list_has_expected_count() {
        assert_eq!(SEED_DATA_FILES.len(), 17);
    }

    #[test]
    fn placeholder_constant_is_untouched() {
        assert_eq!(WORKSPACE_ROOT_PLACEHOLDER, "${workspace_root}");
    }
}

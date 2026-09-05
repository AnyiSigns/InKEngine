//! infer crate 的错误形态（embedder.rs 原样摘入所依赖的 DomainError）。
//!
//! 语义同壳 domain/common.rs：域层统一错误，消息形态产品可读；远端/本地
//! 加载失败的归因由调用方（协议层）转 JSON-RPC 错误。

use std::fmt;

#[derive(Debug)]
pub enum DomainError {
    InvalidData(String),
    Storage(String),
    Engine(String),
    External(String),
    Other(String),
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DomainError::InvalidData(msg) => write!(f, "数据缺失或格式非法: {msg}"),
            DomainError::Storage(msg) => write!(f, "存储/持久化操作失败: {msg}"),
            DomainError::Engine(msg) => write!(f, "引擎调用失败: {msg}"),
            DomainError::External(msg) => write!(f, "外部进程/网络失败: {msg}"),
            DomainError::Other(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for DomainError {}

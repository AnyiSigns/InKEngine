//! 引擎桥：嵌入式 Python 引擎（PyO3 内嵌）接入壳进程的接线层。
//!
//! - [`host`]：装配（boot）与回合驱动封装（引擎宿主句柄）；
//! - [`bridge`]：经 PyO3 注入引擎消费的 Rust 侧协议对象
//!   （事件传输回桥/内嵌嵌入器/记忆存储）。

pub mod bridge;
pub mod host;

pub use host::{BootOptions, BootReport, EngineHost, ProtocolCheck, RoundOutcome, RoundRequest};

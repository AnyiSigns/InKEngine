//! InKling 产品种子机制件一：Rust 执行件（MCP stdio server，零外部依赖）。
//!
//! 库形态与二进制形态分离：所有机制（JSON/协议/执行体）在 lib 里可单测，
//! main.rs 只是薄入口。语言无关契约 = JSON 数据形态 + stdio 传输（与
//! ts_seed_pack 先例同构）；领域语义全部在 executors/ 下以纯函数落地，
//! 领域数据全部在 seed_data/（开发/测试期回落 tests/fixtures/）。

pub mod data;
pub mod executors;
pub mod json;
pub mod protocol;
pub mod tool;

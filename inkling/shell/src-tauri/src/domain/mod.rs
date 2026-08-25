//! 接线层域模块：产品宿主侧的领域逻辑（装配/安全/构建/环境/孵化/挂载/检索等）。
//!
//! 每个域模块 = 一块可独立验证的领域逻辑（数据映射或运行时交互），
//! 经引擎桥（`crate::engine`）访问引擎公开 API；域测试以产品行为
//! 契约（seed_data 数据形态 + 引擎事件协议）为规格，不依赖内部实现。
//!
//! 依赖纪律：域模块之间不直接互调（装配编排只发生在 [`boot`]）；
//! 域模块只依赖引擎公开 API 与数据契约，保证可单测、可替换。

pub mod assembly;
pub mod backup;
pub mod boot;
pub mod build;
pub mod canary;
pub mod code_tools;
pub mod common;
pub mod doc_ops;
pub mod convergence;
pub mod embedder;
pub mod env;
pub mod exec_proc;
pub mod graph;
pub mod import_material;
pub mod incubation;
pub mod live;
pub mod mcp;
pub mod model_archive;
pub mod memory_md;
pub mod policy;
pub mod prompt;
pub mod recovery;
pub mod recipe;
pub mod review;
pub mod score;
pub mod screenshot;
pub mod security;
pub mod session;
pub mod steps;
pub mod tasks;
pub mod tiers;
pub mod tools;
pub mod vectors;
pub mod web_search;

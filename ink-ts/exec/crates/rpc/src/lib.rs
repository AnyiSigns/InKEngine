//! ink-ts 原生机制件共享底座：stdio JSON-RPC 行帧 + 服务主循环。
//!
//! 两个机制件（exec OS 执行器 / infer 本地嵌入推理）都以「stdin 逐行
//! JSON-RPC、stdout 响应行、stderr 诊断」为同一传输形态；本 crate 只承载
//! 传输与协议共性（限长行读取、EOF/写失败退出语义、JSON-RPC 错误码与
//! 响应构造、结构化诊断行），不携带任何业务——方法分派由各 crate 各自的
//! handle_line 负责（协议面与执行语义解耦，单测可脱离进程跑纯协议）。

pub mod code;
pub mod frame;
pub mod server;

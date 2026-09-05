//! 本地嵌入推理子进程（granite-97m；D10/§1.3）。
//!
//! embedder.rs 为「原样摘入」壳 domain/embedder.rs（ort + tokenizers：
//! 懒加载、CLS 池化按 config.json bos_token_id 归一、L2、384 维、确定性
//! 保底、INK_EMBEDDING_* 环境覆盖全保留）；本 crate 只包 stdio JSON-RPC
//! 协议面（与 exec 共用 rpc 行帧底座），不做任何推理逻辑复刻。
//!
//! 方法面：`ping` / `infer.plan` / `infer.embed`（texts → vectors +
//! source/dim/note）。远端/保底降级语义与壳完全一致；模型目录经
//! `INK_EMBEDDING_MODEL_DIR` 或默认相对路径定位，资产缺失/内核不满足时
//! 确定性保底（向量非空不 crash）。

pub mod embedder;
pub mod error;
pub mod protocol;

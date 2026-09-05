//! 物理执行体分派（op → runner；先结构校验 + 端点归属守门，再执行）。
//!
//! 副作用只在守门通过后经物理 runner 触发；守门失败一律 fail-closed 返回
//! Deny（reason 分类），不触碰系统。

pub mod file_op;
pub mod http_op;
pub mod process_op;

use serde_json::Value as JsonValue;

use super::envelope::{validate, Deny, Envelope};
use super::guard::op_allows_endpoint;

/// 信封 → 执行（守门 → 物理执行体）。
pub fn execute(envelope: &Envelope) -> Result<JsonValue, Deny> {
    validate(envelope)?;
    if !op_allows_endpoint(&envelope.op, &envelope.endpoint) {
        return Err(Deny::new(
            "endpoint",
            format!(
                "端点归属漂移：op={} 不接受 endpoint={}（信封须由归属端点签发）",
                envelope.op, envelope.endpoint
            ),
        ));
    }
    match envelope.op.as_str() {
        "process" => process_op::run(envelope),
        "file" => file_op::run(envelope),
        "http" => http_op::run(envelope),
        other => Err(Deny::new("op", format!("未知物理 op: {other}"))),
    }
}

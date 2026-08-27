//! 全局错误信封（L6）：`{code, message, trace_id}` 统一错误返回结构。
//!
//! 命令面（Tauri invoke）所有失败经 [`CommandError`] 回传：Tauri 将错误
//! 序列化为 JSON 对象（code/message/trace_id），前端按结构化拒绝处理；
//! trace_id 与本地审计日志（命令失败时的 eprintln 留痕）联动，支持
//! 跨进程排障。内部错误（String）经 `From` 落入 INTERNAL 码，命令侧
//! 可按域显式构造（ENGINE / IO / BAD_ARGS / NOT_FOUND / APPROVAL）。

use serde::Serialize;

/// 统一错误信封：`{code, message, trace_id}`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: String,
    pub message: String,
    pub trace_id: String,
}

impl CommandError {
    /// 构造信封并生成独立 trace_id（与本地审计日志联动）。
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            trace_id: uuid::Uuid::new_v4().simple().to_string(),
        }
    }

    /// 引擎操作失败（错误串可能含引擎内部细节；仅本地日志留痕）。
    pub fn engine(message: impl std::fmt::Display) -> Self {
        Self::new("ENGINE", message.to_string())
    }

    /// 内部错误（域函数返回的自由文本错误串的统一收口）。
    pub fn internal(message: impl std::fmt::Display) -> Self {
        Self::new("INTERNAL", message.to_string())
    }

    /// 参数非法。
    pub fn invalid_arg(message: impl std::fmt::Display) -> Self {
        Self::new("BAD_ARGS", message.to_string())
    }

    /// 资源不存在。
    pub fn not_found(message: impl std::fmt::Display) -> Self {
        Self::new("NOT_FOUND", message.to_string())
    }

    /// 文件系统/数据目录操作失败。
    pub fn io(message: impl std::fmt::Display) -> Self {
        Self::new("IO", message.to_string())
    }

    /// 审批未决 / 需 L2 人工审批。
    pub fn approval(message: impl std::fmt::Display) -> Self {
        Self::new("APPROVAL_REQUIRED", message.to_string())
    }

    /// 带命令名的失败留痕（审计侧日志：trace_id + 命令 + 码）。
    pub fn log(&self, command: &str) {
        eprintln!(
            "[commands] {command} 失败 code={} trace_id={} message={}",
            self.code, self.trace_id, self.message
        );
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

impl From<String> for CommandError {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

impl From<&str> for CommandError {
    fn from(value: &str) -> Self {
        Self::internal(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_contains_code_message_trace_id() {
        let err = CommandError::new("ENGINE", "装配失败");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "ENGINE");
        assert_eq!(json["message"], "装配失败");
        assert!(json["trace_id"].as_str().unwrap().len() >= 16, "trace_id 须为非空短 id");
    }

    #[test]
    fn trace_id_distinct_per_construction() {
        let a = CommandError::internal("x");
        let b = CommandError::internal("x");
        assert_ne!(a.trace_id, b.trace_id, "每次构造独立 trace_id");
    }

    #[test]
    fn from_string_and_str_fall_into_internal_code() {
        assert_eq!(CommandError::from("msg".to_string()).code, "INTERNAL");
        assert_eq!(CommandError::from("msg").code, "INTERNAL");
    }
}

//! profile 与工具目录（MCP `tools/list` 的声明源）。
//!
//! 两个 profile：`exec`（file/process/doc 工具集——复用 exec ops 的物理
//! 执行体）与 `shell`（exec 工具集 + embed——本地嵌入经 infer crate）。
//! 声明只描述工具名/输入形状/行为语义；执行与守门全在 server.rs 经
//! exec/infer 既有库逻辑落地（本模块零执行逻辑、零安全判定）。

use serde_json::{json, Value as JsonValue};

/// 内置 MCP server profile（二进制首参：`ink_ts_mcp exec|shell`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    /// exec profile：file/process/doc 工具（os/file 物理执行体）。
    Exec,
    /// shell profile：exec 工具集 + embed 工具（本地嵌入）。
    Shell,
}

impl Profile {
    /// 解析 profile 参数（未知 = None，fail-closed：调用方拒绝启动）。
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "exec" => Some(Profile::Exec),
            "shell" => Some(Profile::Shell),
            _ => None,
        }
    }

    /// profile 名（进程首参；诊断/协议 serverInfo 用）。
    pub fn name(self) -> &'static str {
        match self {
            Profile::Exec => "exec",
            Profile::Shell => "shell",
        }
    }

    /// 是否提供 embed 工具（shell profile；另受编译 feature `embed` 约束）。
    pub fn has_embed(self) -> bool {
        matches!(self, Profile::Shell)
    }
}

/// 工具声明（`tools/list` 条目）。
pub struct ToolSpec {
    pub name: &'static str,
    pub description: String,
    pub input_schema: JsonValue,
}

/// 路径类/进程工具沙箱根的语义注记（工具描述尾部统一附注，client 可见）。
const ROOT_NOTE: &str = "\n\n路径沙箱：目标路径必须为绝对路径且位于环境变量 INK_MCP_ROOT 内（未配置 INK_MCP_ROOT = 路径类工具整体拒绝，fail-closed）；拒绝 `..` 段与指向根外的符号链接。";

const PROCESS_NOTE: &str = "\n\n进程沙箱：cwd 必须位于 INK_MCP_ROOT 内；命令名必须在环境变量 INK_MCP_PROCESS_ALLOW 白名单内（未配置 = 进程工具拒绝，fail-closed）；注入 env 仅放行 INK_* 前缀与基础平台键，禁覆写密钥样键名（KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL）。";

fn path_property(description: &str) -> JsonValue {
    json!({ "type": "string", "description": description })
}

/// 工具目录（profile → 列表；embed 按编译 feature 决定是否收录）。
pub fn tools_for(profile: Profile) -> Vec<ToolSpec> {
    let file_root = path_property("目标绝对路径（须位于 INK_MCP_ROOT 内）");
    let mut tools = vec![
        ToolSpec {
            name: "file_read",
            description: format!("读取 INK_MCP_ROOT 内文本文件（≤1 MiB，按字符截断带标记）。{ROOT_NOTE}"),
            input_schema: json!({
                "type": "object",
                "properties": { "path": file_root.clone() },
                "required": ["path"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: "file_list",
            description: format!("列举 INK_MCP_ROOT 内目录条目（按名升序，条目数有上界）。{ROOT_NOTE}"),
            input_schema: json!({
                "type": "object",
                "properties": { "path": file_root.clone() },
                "required": ["path"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: "file_write",
            description: format!("写入 INK_MCP_ROOT 内文件（父目录按需创建仍限根内；≤1 MiB）。{ROOT_NOTE}"),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": file_root.clone(),
                    "content": { "type": "string", "description": "写入文本内容" },
                },
                "required": ["path", "content"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: "doc_parse",
            description: format!("解析 INK_MCP_ROOT 内文档（pdf/docx/xlsx/pptx → 文本；≤20 MiB）。{ROOT_NOTE}"),
            input_schema: json!({
                "type": "object",
                "properties": { "path": path_property("文档绝对路径（pdf/docx/xlsx/pptx）") },
                "required": ["path"],
                "additionalProperties": false,
            }),
        },
        ToolSpec {
            name: "process_exec",
            description: format!("在 INK_MCP_ROOT 内执行白名单命令（cwd 缺省 = INK_MCP_ROOT；超时 kill；输出按流截断）。{PROCESS_NOTE}"),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "argv": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "description": "命令与参数（argv[0] = 白名单命令名）",
                    },
                    "cwd": { "type": "string", "description": "工作目录（绝对路径，须位于 INK_MCP_ROOT 内；缺省 = 根）" },
                    "env": {
                        "type": "object",
                        "additionalProperties": { "type": "string" },
                        "description": "附加环境（仅放行 INK_* 与基础平台键，禁覆写密钥样键名）",
                    },
                    "timeout_secs": { "type": "integer", "minimum": 1, "description": "超时秒数（缺省 30，≤3600）" },
                },
                "required": ["argv"],
                "additionalProperties": false,
            }),
        },
    ];
    if profile.has_embed() && cfg!(feature = "embed") {
        tools.push(ToolSpec {
            name: "embed",
            description: "本地文本嵌入（infer crate：本地 ONNX 推理 / 远端 / 确定性保底按 INK_EMBEDDING_* 路由，永不空返回）。\n\n输入：texts = 待嵌入文本列表（≤256 条、单条 ≤100k 字符）。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "texts": {
                        "type": "array",
                        "items": { "type": "string" },
                        "minItems": 1,
                        "description": "待嵌入文本",
                    },
                },
                "required": ["texts"],
                "additionalProperties": false,
            }),
        });
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_parse_accepts_exec_and_shell_only() {
        assert_eq!(Profile::parse("exec"), Some(Profile::Exec));
        assert_eq!(Profile::parse("shell"), Some(Profile::Shell));
        assert_eq!(Profile::parse("EXEC"), Some(Profile::Exec));
        assert_eq!(Profile::parse(""), None);
        assert_eq!(Profile::parse("nope"), None);
        assert!(Profile::parse(" exec ").is_some());
    }

    #[test]
    fn exec_profile_has_path_and_process_tools() {
        let names: Vec<&str> = tools_for(Profile::Exec)
            .iter()
            .map(|spec| spec.name)
            .collect();
        assert!(names.contains(&"file_read"));
        assert!(names.contains(&"file_list"));
        assert!(names.contains(&"file_write"));
        assert!(names.contains(&"doc_parse"));
        assert!(names.contains(&"process_exec"));
        assert!(!names.contains(&"embed"));
        for spec in tools_for(Profile::Exec) {
            assert!(spec.input_schema.get("properties").is_some());
        }
    }

    #[cfg(feature = "embed")]
    #[test]
    fn shell_profile_adds_embed_tool() {
        let names: Vec<&str> = tools_for(Profile::Shell)
            .iter()
            .map(|spec| spec.name)
            .collect();
        assert!(names.contains(&"file_read"));
        assert!(names.contains(&"embed"));
    }
}

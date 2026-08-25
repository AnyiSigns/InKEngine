//! 工具声明加载（数据资产形态：只读，禁硬编码）。
//!
//! 声明文件 = seed_data/tools.json 的 OS 工具段（夹具 = 定稿形态）；
//! 壳只消费声明，不自行定义工具能力——新增/演化工具走补丁链管线产出
//! 声明后再注册。

use serde::Deserialize;

/// 权限分级（与引擎 approval 分级同源语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionLevel {
    Allow,
    Review,
    Deny,
}

/// 端点：process_exec（控制类统一流水线）| device_mcp（设备感知 server）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Endpoint {
    ProcessExec,
    DeviceMcp,
}

/// 参数类型（声明 ↔ 执行器签名一致性校验的比对面）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParamType {
    String,
    Integer,
    Number,
    Boolean,
}

/// 沙箱规则（守卫断言面；模式与声明字段一一对应）
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SandboxRule {
    /// 值白名单（launch_app 命令 / system_query、screen_query 查询面）
    #[serde(alias = "query_allowlist")]
    CommandAllowlist { allowlist: Vec<String> },
    /// 路径根（open_file / file_query：须位于工作区挂载根内）
    PathRoots { roots: Vec<String> },
    /// 数值边界（set_volume / set_brightness / schedule）
    Bounds { min: i64, max: i64 },
    /// 长度上限（notify）
    LengthCaps { title_max: usize, body_max: usize },
    /// 进程模板（run_typecheck / run_test_*：钉死参数模板 + 超时上限，
    /// 无自由参数面——调用参数只承载端点操作判定的固定命令名）
    ProcessTemplate { argv: Vec<String>, timeout_secs: u64 },
}

/// 参数声明
#[derive(Debug, Clone, Deserialize)]
pub struct ParamDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: ParamType,
    pub required: bool,
}

/// 单条工具声明
#[derive(Debug, Clone, Deserialize)]
pub struct ToolDecl {
    pub name: String,
    pub description: String,
    pub permission: PermissionLevel,
    pub endpoint: Endpoint,
    pub sandbox: SandboxRule,
    pub params: Vec<ParamDecl>,
}

/// 声明文件根（tools.json 的 OS 工具段形态）
#[derive(Debug, Clone, Deserialize)]
pub struct ToolDeclarations {
    pub tools: Vec<ToolDecl>,
}

/// 从 JSON 文本加载声明（解析失败 = 声明损坏，调用方 fail-closed）
pub fn load_tool_declarations(json: &str) -> Result<ToolDeclarations, String> {
    let declarations: ToolDeclarations = serde_json::from_str(json)
        .map_err(|err| format!("工具声明解析失败: {err}"))?;
    for tool in &declarations.tools {
        if tool.name.trim().is_empty() {
            return Err("工具声明包含空名称".into());
        }
    }
    Ok(declarations)
}

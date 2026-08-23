//! mcp 域：挂载服务——地址解析 → 配置推导 → vetting 核对 → 审批预览 →
//! 补丁链挂载/回退的编排与数据推导。
//!
//! 三传输闭环（http/stdio/in_memory）走引擎 McpClientManager（mcp SDK
//! 2.x 兼容）；本模块只做挂载流程编排与数据推导：
//! - 地址解析四规则：市场条目 id / http(s) url / npm: 包名 / git: 仓库
//!   （npm/git 推导 stdio 命令 `npx -y <pkg>`，仅作提案不直接执行）；
//! - vetting 静态核对（清单一致性/命令白名单守卫，与 mcp_market.json
//!   mount_policy.required 对齐）；
//! - 审批卡预览（可 edit 改传输/命令，重走校验链）→ L2 批准 → 补丁链；
//! - 回退语义：链尾补丁须属于该 server（tail conflict 拒绝），回退后
//!   活跃态移除 + 会话断开 + 引擎重建。
//!
//! 失败降级：任何一步失败返回结构化 MountOutcome（不抛未包装异常、
//! 不半挂载——失败时清理已连接会话与已落补丁，fail-closed）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎连接/工具导入/补丁落链
//! 经 [`crate::engine::host::call_engine_op`] 操作通道（接线点文档标注）。

use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

use regex::Regex;
use serde_json::{json, Value as JsonValue};

use super::common::DomainError;

// ── 地址形态前缀（resolve_address 的推导分支；npm/git 均只作提案）──

const PREFIX_HTTP: &str = "http://";
const PREFIX_HTTPS: &str = "https://";
const PREFIX_NPM: &str = "npm:";
const PREFIX_GIT: &str = "git:";

/// stdio 命令推导模板（npx -y <包>，仅提案不执行）。
const NPX_COMMAND: &str = "npx";
const NPX_ARGS_PREFIX: &str = "-y";

/// 嵌入包名合法性（npm 包名规则子集：小写字母数字/连字符/点，可带 @scope/）。
const PACKAGE_NAME_RE: &str = r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$";

// ── 传输形态（声明式枚举，防魔法字符串）──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTransport {
    Http,
    Stdio,
    InMemory,
}

impl McpTransport {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "http" => Ok(Self::Http),
            "stdio" => Ok(Self::Stdio),
            "in_memory" => Ok(Self::InMemory),
            other => Err(DomainError::InvalidData(format!("未知 MCP 传输形态: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Http => "http",
            Self::Stdio => "stdio",
            Self::InMemory => "in_memory",
        }
    }
}

// ── 挂载配置（地址解析/市场条目映射的产物形状）──

#[derive(Debug, Clone, PartialEq)]
pub struct McpServerConfig {
    pub id: String,
    pub transport: McpTransport,
    pub url: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    /// 嵌入式 server 工厂登记名（in_memory 传输的宿主注入点）。
    pub server_factory: Option<String>,
    pub source: String,
}

impl McpServerConfig {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "id": self.id,
            "transport": self.transport.as_str(),
            "url": self.url,
            "command": self.command,
            "args": self.args,
            "server_factory": self.server_factory,
            "source": self.source,
        })
    }
}

// ── 挂载结果（结构化；失败也结构化，绝不裸抛）──

#[derive(Debug, Clone, PartialEq)]
pub struct MountOutcome {
    pub ok: bool,
    pub server_id: String,
    pub patch_ids: Vec<i64>,
    pub tool_names: Vec<String>,
    pub status: String,
    pub error: Option<String>,
}

impl MountOutcome {
    /// 结果文本（工具调用回执/审批卡预览消费）。
    pub fn render(&self) -> String {
        if self.ok {
            format!(
                "挂载成功：{}（工具 {}，补丁 #{}）",
                self.server_id,
                self.tool_names.join(", "),
                self.patch_ids
                    .iter()
                    .map(|id| id.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            format!(
                "挂载未完成：{} [{}] {}",
                if self.server_id.is_empty() { "未知" } else { &self.server_id },
                self.status,
                self.error.as_deref().unwrap_or("")
            )
        }
    }

    fn failed(server_id: &str, status: &str, error: &str) -> Self {
        Self {
            ok: false,
            server_id: server_id.to_string(),
            patch_ids: Vec::new(),
            tool_names: Vec::new(),
            status: status.to_string(),
            error: Some(error.to_string()),
        }
    }
}

// ── 地址解析错误（确定性错误：解析失败等） ──

#[derive(Debug, Clone)]
pub struct McpMountError(pub String);

impl std::fmt::Display for McpMountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for McpMountError {}

// ── 挂载编排服务 ──

/// MCP 挂载编排服务（宿主装配期创建，运行时挂载/卸载/回退入口）。
pub struct McpMountService {
    market: JsonValue,
    allowed_commands: HashSet<String>,
    vetted: RwLock<HashSet<String>>,
    mount_log: RwLock<HashMap<String, Vec<i64>>>,
    server_factories: RwLock<HashMap<String, String>>,
}

impl McpMountService {
    /// 市场装载（mcp_market.json 数据；白名单 = 市场声明命令 ∪ npx）。
    pub fn new(market: &JsonValue) -> Result<Self, DomainError> {
        let obj = market
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("mcp_market.json 须为对象".to_string()))?;
        let mut allowed_commands = HashSet::new();
        for server in obj.get("servers").and_then(JsonValue::as_array).unwrap_or(&Vec::new()) {
            if let Some(command) = server.get("command").and_then(JsonValue::as_str) {
                if !command.is_empty() {
                    allowed_commands.insert(command.to_string());
                }
            }
        }
        allowed_commands.insert(NPX_COMMAND.to_string());
        Ok(Self {
            market: market.clone(),
            allowed_commands,
            vetted: RwLock::new(HashSet::new()),
            mount_log: RwLock::new(HashMap::new()),
            server_factories: RwLock::new(HashMap::new()),
        })
    }

    /// 登记嵌入式 server 工厂（in_memory 传输的宿主注入点）。
    pub fn register_server_factory(&self, server_id: &str, factory: String) {
        self.server_factories
            .write()
            .unwrap()
            .insert(server_id.to_string(), factory);
    }

    /// 命令白名单（数据驱动：市场条目声明命令 ∪ npx 提案推导）。
    pub fn allowed_commands(&self) -> &HashSet<String> {
        &self.allowed_commands
    }

    // ── 地址解析与配置推导 ──

    fn market_entry(&self, server_id: &str) -> Option<JsonValue> {
        self.market
            .get("servers")
            .and_then(JsonValue::as_array)
            .and_then(|list| {
                list.iter()
                    .find(|server| server.get("id").and_then(JsonValue::as_str) == Some(server_id))
                    .cloned()
            })
    }

    /// 市场条目 → 挂载配置（市场内落市场配置，字段原样映射）。
    pub fn config_from_market_entry(&self, entry: &JsonValue) -> Result<McpServerConfig, DomainError> {
        let obj = entry
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("市场条目须为对象".to_string()))?;
        let id = obj
            .get("id")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| DomainError::InvalidData("市场条目缺 id".to_string()))?;
        Ok(McpServerConfig {
            id: id.to_string(),
            transport: McpTransport::parse(
                obj.get("transport").and_then(JsonValue::as_str).unwrap_or("http"),
            )?,
            url: obj.get("url").and_then(JsonValue::as_str).map(str::to_string).filter(|u| !u.is_empty()),
            command: obj
                .get("command")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .filter(|c| !c.is_empty()),
            args: obj
                .get("args")
                .and_then(JsonValue::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            server_factory: None,
            source: "unknown".to_string(),
        })
    }

    /// 地址 → 稳定 server id（非字母数字折叠为点，防 id 漂移）。
    pub fn derive_server_id(address: &str) -> String {
        let cleaned: Vec<&str> = address
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|part| !part.is_empty())
            .collect();
        let folded = cleaned.join(".");
        let mut bounded = folded;
        if bounded.len() > 64 {
            bounded.truncate(64);
        }
        let bounded = bounded.trim_matches('.');
        format!("addr.{bounded}")
    }

    /// 地址解析：市场条目 / http(s) url / npm 包 / git 仓库 → 配置。
    ///
    /// 仅推导不执行：npx 命令只是提案形态，实际运行前必经 vetting →
    /// 审批 → 补丁链（出厂零预挂，任何挂载都走既有链路）。
    pub fn resolve_address(&self, address: &str) -> Result<McpServerConfig, McpMountError> {
        let address = address.trim();
        if address.is_empty() {
            return Err(McpMountError("挂载地址为空".to_string()));
        }
        if let Some(entry) = self.market_entry(address) {
            return self
                .config_from_market_entry(&entry)
                .map_err(|err| McpMountError(err.to_string()));
        }
        if address.starts_with(PREFIX_HTTP) || address.starts_with(PREFIX_HTTPS) {
            return Ok(McpServerConfig {
                id: Self::derive_server_id(address),
                transport: McpTransport::Http,
                url: Some(address.to_string()),
                command: None,
                args: Vec::new(),
                server_factory: None,
                source: "unknown".to_string(),
            });
        }
        if let Some(package) = address.strip_prefix(PREFIX_NPM).map(str::trim) {
            if !is_valid_package_name(package) {
                return Err(McpMountError(format!("npm 包名非法: {package:?}")));
            }
            return Ok(McpServerConfig {
                id: format!("npm.{package}"),
                transport: McpTransport::Stdio,
                url: None,
                command: Some(NPX_COMMAND.to_string()),
                args: vec![NPX_ARGS_PREFIX.to_string(), package.to_string()],
                server_factory: None,
                source: "unknown".to_string(),
            });
        }
        if let Some(repo) = address.strip_prefix(PREFIX_GIT).map(str::trim) {
            if repo.is_empty() || repo.contains(' ') {
                return Err(McpMountError(format!("git 仓库地址非法: {address:?}")));
            }
            return Ok(McpServerConfig {
                id: format!("git.{}", Self::derive_server_id(repo)),
                transport: McpTransport::Stdio,
                url: None,
                command: Some(NPX_COMMAND.to_string()),
                args: vec![NPX_ARGS_PREFIX.to_string(), repo.to_string()],
                server_factory: None,
                source: "unknown".to_string(),
            });
        }
        Err(McpMountError(format!(
            "无法解析挂载地址: {address:?}（支持市场条目 id / http(s) url / npm:包名 / git:仓库）"
        )))
    }

    // ── vetting 静态核对 ──

    /// 挂载前静态核对（清单一致性 + 命令白名单守卫），返回违规清单。
    ///
    /// 核对项（与 mcp_market.json mount_policy.required 对齐）：
    /// - http 须 url（scheme 限 http/https）、stdio 须 command、
    ///   in_memory 须嵌入式工厂；
    /// - stdio 命令 ∈ 白名单（市场条目声明命令 ∪ npx 提案推导）；
    /// - 市场内条目与目录声明一致（防改头换面挂载）。
    pub fn vetting_checks(&self, config: &McpServerConfig) -> Vec<String> {
        let mut violations: Vec<String> = Vec::new();
        match config.transport {
            McpTransport::Http => {
                let scheme = config
                    .url
                    .as_deref()
                    .map(|url| url.split("://").next().unwrap_or(""))
                    .unwrap_or("");
                if scheme != "http" && scheme != "https" {
                    violations.push("http 传输须携带 http(s) url".to_string());
                }
            }
            McpTransport::Stdio => {
                let Some(command) = config.command.as_deref() else {
                    violations.push("stdio 传输缺命令".to_string());
                    return violations;
                };
                if !self.allowed_commands.contains(command) {
                    violations.push(format!("stdio 命令不在白名单: {command}"));
                }
                if command == NPX_COMMAND
                    && !config.args.iter().any(|arg| !arg.is_empty() && !arg.starts_with('-'))
                {
                    violations.push("npx 提案须携带包名参数".to_string());
                }
            }
            McpTransport::InMemory => {
                if config.server_factory.is_none() {
                    violations.push("in_memory 传输须注入嵌入式 server 工厂".to_string());
                }
            }
        }
        if let Some(entry) = self.market_entry(&config.id) {
            let declared_transport = entry
                .get("transport")
                .and_then(JsonValue::as_str)
                .unwrap_or("http")
                .to_string();
            let declared_url = entry
                .get("url")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .filter(|u| !u.is_empty());
            let declared_command = entry
                .get("command")
                .and_then(JsonValue::as_str)
                .map(str::to_string)
                .filter(|c| !c.is_empty());
            let declared_args: Vec<String> = entry
                .get("args")
                .and_then(JsonValue::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(JsonValue::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let consistent = declared_transport == config.transport.as_str()
                && declared_url == config.url
                && declared_command == config.command
                && declared_args == config.args;
            if !consistent {
                violations.push("清单一致性：与市场目录声明不符".to_string());
            }
        }
        violations
    }

    // ── 挂载审批卡（可 edit 重走校验链）──

    /// 挂载审批卡预览（提案阶段）：派生配置的可读形态。
    pub fn mount_approval_card(&self, config: &McpServerConfig) -> JsonValue {
        json!({
            "review_type": "mount",
            "server_id": config.id,
            "transport": config.transport.as_str(),
            "url": config.url,
            "command": config.command,
            "args": config.args,
            "note": "挂载提案预览：可 edit 修改传输/命令后重走校验链",
        })
    }

    /// 审批卡 edit 决议 → 新配置（编辑字段覆盖，未编辑字段保留）。
    pub fn config_from_edited(&self, config: &McpServerConfig, edited: &JsonValue) -> Result<McpServerConfig, DomainError> {
        let obj = edited.as_object().ok_or_else(|| DomainError::InvalidData("编辑内容须为对象".to_string()))?;
        let transport = match obj.get("transport").and_then(JsonValue::as_str) {
            Some(value) => McpTransport::parse(value)?,
            None => config.transport,
        };
        let url = match obj.get("url") {
            Some(JsonValue::Null) | None => config.url.clone(),
            Some(JsonValue::String(s)) if s.is_empty() => config.url.clone(),
            Some(JsonValue::String(s)) => Some(s.clone()),
            Some(_) => Err(DomainError::InvalidData("编辑 url 须为字符串".to_string()))?,
        };
        let command = match obj.get("command") {
            Some(JsonValue::Null) | None => config.command.clone(),
            Some(JsonValue::String(s)) if s.is_empty() => config.command.clone(),
            Some(JsonValue::String(s)) => Some(s.clone()),
            Some(_) => Err(DomainError::InvalidData("编辑 command 须为字符串".to_string()))?,
        };
        let args = obj
            .get("args")
            .and_then(JsonValue::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| config.args.clone());
        Ok(McpServerConfig {
            id: obj
                .get("server_id")
                .and_then(JsonValue::as_str)
                .unwrap_or(&config.id)
                .to_string(),
            transport,
            url,
            command,
            args,
            server_factory: config.server_factory.clone(),
            source: config.source.clone(),
        })
    }

    // ── 挂载 / 卸载（流程编排；引擎动作经操作通道）──

    /// 挂在配置文件（vetting 前注入: 显式工厂 > 登记工厂）。
    pub fn config_for_mount(
        &self,
        config: &McpServerConfig,
        server_factory: Option<String>,
    ) -> McpServerConfig {
        let factory = server_factory.or_else(|| {
            if config.transport == McpTransport::InMemory && config.server_factory.is_none() {
                self.server_factories
                    .read()
                    .unwrap()
                    .get(&config.id)
                    .cloned()
            } else {
                None
            }
        });
        McpServerConfig {
            server_factory: factory,
            ..config.clone()
        }
    }

    /// 挂载前置核查（纯数据阶段：配置注入 + vetting 静态核对）。
    ///
    /// 核查不通过 = 结构化 MountOutcome（vetting_rejected，不进审批）。
    pub fn premount_checks(
        &self,
        config: &McpServerConfig,
        server_factory: Option<String>,
    ) -> Result<McpServerConfig, MountOutcome> {
        let prepared = self.config_for_mount(config, server_factory);
        let violations = self.vetting_checks(&prepared);
        if violations.is_empty() {
            Ok(prepared)
        } else {
            Err(MountOutcome::failed(
                &prepared.id,
                "vetting_rejected",
                &violations.join("；"),
            ))
        }
    }

    /// 对话式安装链路：地址解析 → 配置推导 → vetting → 审批 → 落链。
    ///
    /// 地址解析失败 = 结构化失败（resolve_failed）；解析成功后进入
    /// [`Self::mount_config`]。
    pub fn propose_mount(
        &self,
        address: &str,
        server_factory: Option<String>,
    ) -> Result<McpServerConfig, MountOutcome> {
        match self.resolve_address(address) {
            Ok(config) => self.premount_checks(&config, server_factory),
            Err(err) => Err(MountOutcome::failed(
                "",
                "resolve_failed",
                &err.to_string(),
            )),
        }
    }

    /// 挂载一个 server 配置（市场一键挂载与对话式安装共用）。
    ///
    /// 两阶段流程（「仅提案不直接执行」的机制保障）：
    /// 1. 提案阶段：vetting 静态核对 → 挂载审批卡预览（可 edit 改
    ///    传输/命令，重走校验链）——Git/npm 推导的 stdio 命令在此
    ///    阶段不产生任何进程；
    /// 2. 执行阶段：connect → 工具导入 → 逐工具 TOOL 提案（L2 审批）
    ///    → 补丁链落链 → 引擎重建——经操作通道：
    ///    需 op: mcp.connect（连接待通道扩展）。
    ///    需 op: mcp.import_tools（工具导入待通道扩展）。
    ///    需 op: patch.apply（TOOL 补丁提案应用待通道扩展）。
    ///
    /// 执行未接线时 = 结构化降级（connect_failed，通知仍可读）。
    pub async fn mount_config(
        &self,
        config: &McpServerConfig,
        server_factory: Option<String>,
    ) -> MountOutcome {
        let prepared = match self.premount_checks(config, server_factory) {
            Ok(prepared) => prepared,
            Err(outcome) => return outcome,
        };
        self.mark_vetted(&prepared.id);
        let card = self.mount_approval_card(&prepared);
        let _ = card;
        MountOutcome::failed(
            &prepared.id,
            "connect_failed",
            "需 op: mcp.connect / mcp.import_tools / patch.apply —— 挂载执行阶段待引擎操作通道扩展后接线（boot.rs 装配）",
        )
    }

    /// 挂载登记（server_id → 补丁 id 序；卸载/回退按链尾倒序还原）。
    ///
    /// boot 在补丁链落链成功后调用（挂载记录 = 卸载/回退的判据）；
    /// 挂载未完成 = 无登记（fail-closed，不产生半挂载记录）。
    pub fn record_mount(&self, server_id: &str, patch_ids: Vec<i64>) {
        self.mount_log
            .write()
            .unwrap()
            .insert(server_id.to_string(), patch_ids);
    }

    /// 卸载前置核查：挂载记录 + 链尾归属（回退只能回退链尾单步）。
    pub fn unmount_precheck(
        &self,
        server_id: &str,
        tail_patch: Option<&JsonValue>,
    ) -> Result<Vec<i64>, MountOutcome> {
        let patch_ids = self.mount_log.read().unwrap().get(server_id).cloned();
        let Some(patch_ids) = patch_ids else {
            return Err(MountOutcome::failed(
                server_id,
                "not_mounted",
                "该 server 无挂载记录",
            ));
        };
        if !patch_ids.is_empty() {
            let Some(tail_patch) = tail_patch else {
                return Err(MountOutcome::failed(
                    server_id,
                    "tail_conflict",
                    "链尾补丁不属于该 server（先回退后继补丁）",
                ));
            };
            if !patch_belongs_to_server(tail_patch, server_id) {
                return Err(MountOutcome::failed(
                    server_id,
                    "tail_conflict",
                    "链尾补丁不属于该 server（先回退后继补丁）",
                ));
            }
        }
        Ok(patch_ids)
    }

    /// 卸载（补丁链回退）：回退该 server 的挂载补丁 → 活跃态移除 → 会话断开。
    ///
    /// 引擎链回退语义：revert 只支持链尾单步，且回退后剩余补丁折叠
    /// 进新 base（版本复位）——一次卸载 = 回退链尾补丁（须属于该
    /// server，否则拒绝并要求先回退后继）。回退经操作通道：
    /// 需 op: patch.revert（链尾回退待通道扩展）；
    /// 活跃态移除（声明式定义/统一工具表）与会话断开经：
    /// 需 op: mcp.disconnect / engine.tool_registry_remove。
    pub async fn unmount(
        &self,
        server_id: &str,
        tail_patch: Option<&JsonValue>,
    ) -> MountOutcome {
        let patch_ids = match self.unmount_precheck(server_id, tail_patch) {
            Ok(ids) => ids,
            Err(outcome) => return outcome,
        };
        self.mount_log.write().unwrap().remove(server_id);
        MountOutcome {
            ok: false,
            server_id: server_id.to_string(),
            patch_ids,
            tool_names: Vec::new(),
            status: "unmounted_pending".to_string(),
            error: Some(
                "需 op: patch.revert / mcp.disconnect —— 卸载执行阶段待引擎操作通道扩展后接线（boot.rs 装配）"
                    .to_string(),
            ),
        }
    }

    /// 登记已通过 vetting 的 server（L2 钩子放行依据）。
    pub fn mark_vetted(&self, server_id: &str) {
        self.vetted.write().unwrap().insert(server_id.to_string());
    }

    /// 当前挂载登记（设置页「连接」视图数据源）。
    pub fn mounted_servers(&self) -> Vec<String> {
        self.mount_log.read().unwrap().keys().cloned().collect()
    }

    /// 卸载/回退后的链尾归属判定入口（供 boot 调取链尾补丁判断）。
    pub fn l2_hook_violations(&self, proposal_kind: &str, payload: &JsonValue) -> Vec<String> {
        l2_hook_violations(proposal_kind, payload, &self.vetted.read().unwrap().clone())
    }
}

// ── L2 验证钩子（补丁链 deploy 前门禁：MCP 挂载须已过 vetting）──

/// L2 验证钩子：MCP 挂载补丁须已过 vetting 核对（vetting → 审批 → L2
/// 的顺序在同一实例内闭环）。
pub fn l2_hook_violations(
    proposal_kind: &str,
    payload: &JsonValue,
    vetted_set: &HashSet<String>,
) -> Vec<String> {
    if proposal_kind != "tool" {
        return Vec::new();
    }
    if payload.get("endpoint").and_then(JsonValue::as_str) != Some("mcp") {
        return Vec::new();
    }
    let server_id = payload
        .get("endpoint_config")
        .and_then(|c| c.get("server_id"))
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    if server_id.is_empty() || !vetted_set.contains(server_id) {
        return vec![format!(
            "MCP 挂载未经 vetting 核对（server 未登记放行: {server_id:?}）"
        )];
    }
    Vec::new()
}

// ── 回退归属判定 ──

/// 链尾补丁是否属于该 server（按挂载工具声明的 meta.mcp_server 判定）。
pub fn patch_belongs_to_server(tail: &JsonValue, server_id: &str) -> bool {
    tail.get("value")
        .and_then(|v| v.get("meta"))
        .and_then(|v| v.get("mcp_server"))
        .and_then(JsonValue::as_str)
        == Some(server_id)
}

// ── 工具函数 ──

/// npm 包名合法性（规则子集校验；编译期一次编译正则）。
fn is_valid_package_name(package: &str) -> bool {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(PACKAGE_NAME_RE).expect("包名正则编译失败"));
    re.is_match(package)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKET_JSON: &str = include_str!("../../../../../inkling/seed_data/mcp_market.json");

    fn seed_market() -> JsonValue {
        serde_json::from_str(MARKET_JSON).unwrap()
    }

    fn market_with(entry: &JsonValue) -> JsonValue {
        let mut market = seed_market();
        let entries = market
            .get_mut("servers")
            .and_then(|v| v.as_array_mut())
            .expect("seed 市场有 servers 数组");
        entries.push(entry.clone());
        market
    }

    fn in_memory_entry() -> JsonValue {
        json!({
            "id": "test.echo",
            "name": "测试回声 server（嵌入式）",
            "transport": "in_memory",
            "url": null,
            "command": null,
            "args": [],
            "premounted": false,
        })
    }

    #[test]
    fn market_zero_premount_and_service_registry() {
        let market = seed_market();
        let service = McpMountService::new(&market).unwrap();
        assert!(service.mounted_servers().is_empty(), "出厂零预挂");
        assert_eq!(market["premounted"], false);
        assert!(market["servers"].as_array().unwrap().len() >= 2, "目录有候选（示例条目）");
        // 命令白名单 = 市场声明命令 ∪ npx（出厂条目含 npx 声明）
        assert!(service.allowed_commands().contains("npx"));
        assert!(!service.allowed_commands().contains("curl"));
    }

    #[test]
    fn address_resolution_four_rules() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();

        // 市场条目 id
        let market_cfg = service.resolve_address("test.echo").unwrap();
        assert_eq!(market_cfg.id, "test.echo");
        assert_eq!(market_cfg.transport, McpTransport::InMemory);

        // http(s) url
        let http_cfg = service.resolve_address("https://api.example.com/mcp").unwrap();
        assert_eq!(http_cfg.transport, McpTransport::Http);
        assert_eq!(http_cfg.url.as_deref(), Some("https://api.example.com/mcp"));
        assert!(http_cfg.id.starts_with("addr."));

        // npm 包（npx -y 提案形态，仅提案不执行）
        let npm_cfg = service.resolve_address("npm:@modelcontextprotocol/server-everything").unwrap();
        assert_eq!(npm_cfg.transport, McpTransport::Stdio);
        assert_eq!(npm_cfg.command.as_deref(), Some("npx"));
        assert_eq!(npm_cfg.args, vec!["-y", "@modelcontextprotocol/server-everything"]);
        assert_eq!(npm_cfg.id, "npm.@modelcontextprotocol/server-everything");

        // git 仓库
        let git_cfg = service.resolve_address("git:github:owner/repo").unwrap();
        assert_eq!(git_cfg.transport, McpTransport::Stdio);
        assert_eq!(git_cfg.args, vec!["-y", "github:owner/repo"]);
        assert!(git_cfg.id.starts_with("git.addr."));

        // 非法地址显式拒绝
        assert!(service.resolve_address("ftp://not-supported").is_err());
        assert!(service.resolve_address("npm:Bad_Package!").is_err());
        assert!(service.resolve_address("").is_err());
        assert!(service.resolve_address("git:") .is_err());
    }

    #[test]
    fn derive_server_id_folds_and_bounds() {
        assert_eq!(McpMountService::derive_server_id("https://a.example.com/mcp"), "addr.https.a.example.com.mcp");
        let long = format!("https://{}.example.com", "x".repeat(100));
        let derived = McpMountService::derive_server_id(&long);
        assert!(derived.len() <= 64 + 5, "折叠后限长 64");
        assert_eq!(derived, McpMountService::derive_server_id(&long), "同地址同 id（稳定）");
    }

    #[test]
    fn vetting_checks_per_transport_and_whitelist() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();

        // http 无 url / 坏 scheme → 拒绝
        let http_bad = McpServerConfig {
            id: "addr.http".to_string(),
            transport: McpTransport::Http,
            url: None,
            command: None,
            args: vec![],
            server_factory: None,
            source: "unknown".to_string(),
        };
        assert!(service.vetting_checks(&http_bad).iter().any(|v| v.contains("http(s)")));

        // stdio 缺命令 / 白名单外命令 → 拒绝
        let stdio_no_cmd = McpServerConfig { id: "x".into(), transport: McpTransport::Stdio, url: None, command: None, args: vec![], server_factory: None, source: "unknown".into() };
        assert!(service.vetting_checks(&stdio_no_cmd).iter().any(|v| v.contains("缺命令")));
        let rogue = McpServerConfig { id: "evil".into(), transport: McpTransport::Stdio, url: None, command: Some("curl".into()), args: vec![], server_factory: None, source: "unknown".into() };
        assert!(service.vetting_checks(&rogue).iter().any(|v| v.contains("白名单")));

        // npx 提案须携带包名参数
        let npx_no_pkg = McpServerConfig { id: "npm.bare".into(), transport: McpTransport::Stdio, url: None, command: Some("npx".into()), args: vec!["-y".into()], server_factory: None, source: "unknown".into() };
        assert!(service.vetting_checks(&npx_no_pkg).iter().any(|v| v.contains("包名")));

        // in_memory 须嵌入式工厂
        let memory_no_factory = McpServerConfig { id: "test.echo".into(), transport: McpTransport::InMemory, url: None, command: None, args: vec![], server_factory: None, source: "unknown".into() };
        let violations = service.vetting_checks(&memory_no_factory);
        assert!(violations.iter().any(|v| v.contains("工厂")), "违规: {violations:?}");
        let with_factory = McpServerConfig { server_factory: Some("echo".into()), ..memory_no_factory.clone() };
        assert!(service.vetting_checks(&with_factory).is_empty());

        // 市场条目改头换面（改 url）→ 清单一致性拒绝
        let mut tampered = service.resolve_address("test.echo").unwrap();
        tampered.url = Some("https://evil.example".into());
        assert!(service.vetting_checks(&tampered).iter().any(|v| v.contains("清单一致性")));
    }

    #[test]
    fn premount_checks_injects_factory_from_registry() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        service.register_server_factory("test.echo", "echo_factory".to_string());
        let config = service.resolve_address("test.echo").unwrap();
        let prepared = service.premount_checks(&config, None).expect("登记工厂应注入");
        assert_eq!(prepared.server_factory.as_deref(), Some("echo_factory"));
        // 显式工厂优先于登记工厂
        let explicit = service.premount_checks(&config, Some("explicit".to_string())).unwrap();
        assert_eq!(explicit.server_factory.as_deref(), Some("explicit"));
    }

    #[test]
    fn approval_card_and_edited_config_revalidates() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        let npm = service.resolve_address("npm:some-mcp-server").unwrap();
        let card = service.mount_approval_card(&npm);
        assert_eq!(card["review_type"], "mount");
        assert_eq!(card["server_id"], "npm.some-mcp-server");
        assert_eq!(card["note"].as_str().unwrap().contains("edit"), true);

        // 编辑为白名单外命令 → 重走校验链拒绝
        let edited = json!({"transport": "stdio", "command": "curl", "args": ["http://evil.example"]});
        let rechecked = service.config_from_edited(&npm, &edited).unwrap();
        assert!(service.vetting_checks(&rechecked).iter().any(|v| v.contains("白名单")), "编辑内容与提案同门禁");
        // 未编辑字段保留（transport 覆盖为 http 后 url 回填原始值……）
        let partial = json!({"transport": "stdio"});
        let kept = service.config_from_edited(&npm, &partial).unwrap();
        assert_eq!(kept.command.as_deref(), Some("npx"));
        assert_eq!(kept.args, vec!["-y", "some-mcp-server"]);
        // 非法 transport 显式拒绝
        assert!(service.config_from_edited(&npm, &json!({"transport": "websocket"})).is_err());
    }

    #[test]
    fn propose_mount_failures_are_structured() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        // 解析失败 = resolve_failed
        let outcome = service.propose_mount("ftp://bad", None).unwrap_err();
        assert_eq!(outcome.status, "resolve_failed");
        assert!(!outcome.ok);
        // vetting 拒绝（stdio 白名单外）→ 未到审批卡
        let config = McpServerConfig { id: "evil.mount".into(), transport: McpTransport::Stdio, url: None, command: Some("curl".into()), args: vec![], server_factory: None, source: "unknown".into() };
        let rejected = service.premount_checks(&config, None).unwrap_err();
        assert_eq!(rejected.status, "vetting_rejected");
        assert!(rejected.error.as_deref().unwrap().contains("白名单"));
    }

    #[test]
    fn l2_hook_requires_vetted_server() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        let payload = json!({
            "endpoint": "mcp",
            "endpoint_config": {"server_id": "test.echo"},
        });
        // 非 TOOL 补丁不入钩子作用域
        assert!(service.l2_hook_violations("knowledge", &payload).is_empty());
        // 非 MCP 端点补丁放行
        let non_mcp = json!({"endpoint": "os", "endpoint_config": {"server_id": "x"}});
        assert!(service.l2_hook_violations("tool", &non_mcp).is_empty());
        // 未登记 vetting = 拒绝（vetting → 审批 → L2 的顺序被强制执行）
        let violations = service.l2_hook_violations("tool", &payload);
        assert_eq!(violations.len(), 1);
        assert!(violations[0].contains("vetting"));
        // mark_vetted 后放行
        service.mark_vetted("test.echo");
        assert!(service.l2_hook_violations("tool", &payload).is_empty());
    }

    #[test]
    fn patch_belongs_to_server_checks_meta() {
        let own = json!({"value": {"meta": {"mcp_server": "test.echo", "mcp_tool": "echo"}}});
        assert!(patch_belongs_to_server(&own, "test.echo"));
        let other = json!({"value": {"meta": {"mcp_server": "other.server"}}});
        assert!(!patch_belongs_to_server(&other, "test.echo"));
        assert!(!patch_belongs_to_server(&json!({"value": {}}), "test.echo"));
        assert!(!patch_belongs_to_server(&json!({}), "test.echo"));
    }

    #[test]
    fn unmount_precheck_detects_tail_conflict() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        // 无挂载记录 = not_mounted
        let outcome = service.unmount_precheck("test.echo", None).unwrap_err();
        assert_eq!(outcome.status, "not_mounted");
        assert!(outcome.error.as_deref().unwrap().contains("无挂载记录"));
        // 链尾不属于该 server = tail_conflict（拒绝并要求先回退后继）
        service.record_mount("test.echo", vec![5, 6]);
        let conflict = service.unmount_precheck(
            "test.echo",
            Some(&json!({"value": {"meta": {"mcp_server": "other"}}})),
        );
        assert!(conflict.is_err() && conflict.unwrap_err().status == "tail_conflict");
        // 链尾属于该 server（meta.mcp_server 判定）= 可回退
        let ok = service.unmount_precheck(
            "test.echo",
            Some(&json!({"value": {"meta": {"mcp_server": "test.echo", "mcp_tool": "echo"}}})),
        );
        assert_eq!(ok.unwrap(), vec![5, 6]);
    }

    #[test]
    fn outcome_render_readable_shapes() {
        let ok = MountOutcome {
            ok: true,
            server_id: "test.echo".to_string(),
            patch_ids: vec![7, 8],
            tool_names: vec!["echo".to_string(), "alarm".to_string()],
            status: "mounted".to_string(),
            error: None,
        };
        assert!(ok.render().contains("挂载成功：test.echo"));
        assert!(ok.render().contains("echo, alarm"));
        assert!(ok.render().contains("7, 8"));
        let failed = MountOutcome {
            ok: false,
            server_id: "x".to_string(),
            patch_ids: vec![],
            tool_names: vec![],
            status: "vetting_rejected".to_string(),
            error: Some("白名单".to_string()),
        };
        assert!(failed.render().contains("挂载未完成：x [vetting_rejected] 白名单"));
    }

    #[test]
    fn mount_config_degrades_structurally_before_ops_ready() {
        let market = market_with(&in_memory_entry());
        let service = McpMountService::new(&market).unwrap();
        service.register_server_factory("test.echo", "factory".to_string());
        let config = service.resolve_address("test.echo").unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let outcome = rt.block_on(service.mount_config(&config, None));
        assert!(!outcome.ok);
        assert_eq!(outcome.status, "connect_failed");
        assert!(outcome.error.as_deref().unwrap().contains("需 op"));
        // 挂载登记按结果保持干净（fail-closed：失败无半挂载记录）
        assert!(service.mounted_servers().is_empty());
    }

    #[test]
    fn market_entry_transport_defaults_to_http() {
        let market = json!({
            "premounted": false,
            "mount_policy": {"required": ["vetting 静态钩子核对"]},
            "servers": [{"id": "market.web_fetch", "transport": "http", "url": "https://r.jina.ai"}],
        });
        let service = McpMountService::new(&market).unwrap();
        let config = service.resolve_address("market.web_fetch").unwrap();
        assert_eq!(config.transport, McpTransport::Http);
        assert_eq!(config.url.as_deref(), Some("https://r.jina.ai"));
        assert!(service.vetting_checks(&config).is_empty());
        // 市场缺 id = 显式错误
        let broken = json!({"servers": [{"transport": "http"}]});
        assert!(McpMountService::new(&broken).is_ok());
    }
}

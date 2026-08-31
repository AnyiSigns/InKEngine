//! 环境装配域：三提供器（local / web_bridge / container）+ 域选择 +
//! ENVIRONMENT 补丁链活跃态应用。
//!
//! env.json → EnvironmentSpec → 三环境提供器 + 域选择：
//!
//! - **local**：本地形态默认可用——ensure 幂等（已就绪且声明一致 =
//!   复用既有实例；声明变更 = 旧实例销毁重建）、run 白名单命令
//!   （spec.meta.env_vars 并入运行环境 + 宿主 PATH）、destroy 幂等；
//! - **web_bridge**：浏览器桥形态（ensure 恒就绪、run 显式不支持）；
//! - **container**：[`SeedContainerProvider`]——ensure 幂等（镜像已存在
//!   复用）/run（docker run 白名单命令）/destroy 幂等（容器移除，镜像
//!   保留可重建）；本机 Docker 客户端缺失或守护进程不可达 = 结构化
//!   降级（[`ContainerUnavailable`]，错误码 ENV_004），绝不静默假装可用，
//!   探测结果缓存（不可达后不再重复探测）；
//! - **域选择**：[`EnvironmentDomain::ensure`] 按环境名选择提供器、
//!   失败 = 状态化句柄（不击穿调用方）；`restore` = 链恢复形态（基线
//!   env.json 叠加链补丁增量，链为权威）。
//!
//! 安全边界：环境运行/安装命令一律经白名单沙箱（fail-closed）；环境
//! 动作落审计（append-only：什么环境跑过什么命令，审计失败不阻断）。
//! 环境变更走补丁链留痕（environment 补丁），回退 = 声明回退 + 实例重建。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎交互（审计落库/引擎
//! 重建）经 [`crate::engine::host::call_engine_op`] 操作通道，
//! 装配编排发生在 [`super::boot`]。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use serde_json::Value as JsonValue;

use super::common::{
    now_epoch, object_map, run_command, truncate_chars, DomainError, ProcessResult,
};
use crate::engine::bridge::register_callback;
use crate::engine::host::call_engine_op;

// ── 环境状态（声明式枚举，防魔法字符串）──

pub const ENV_STATUS_READY: &str = "ready";
pub const ENV_STATUS_INSTALLING: &str = "installing";
pub const ENV_STATUS_FAILED: &str = "failed";
pub const ENV_STATUS_DESTROYED: &str = "destroyed";

/// 环境动作审计集合（append-only 留痕：什么环境跑过什么命令）。
pub const ENV_AUDIT_COLLECTION: &str = "env_audit";

/// 容器形态不可用（结构化解构错误码；降级路径统一携带）。
pub const ENV_ERROR_CONTAINER_UNAVAILABLE: &str = "ENV_004";

/// ENVIRONMENT 补丁应用目标名（补丁链自应用目标的注册名）。
pub const ENVIRONMENT_APPLY_TARGET: &str = "inkling.environment";

// 容器动作缺省超时（docker 拉取/构建/运行统一护栏，秒）
const CONTAINER_TIMEOUT: f64 = 120.0;

/// 本地环境动作超时（run/install 统一护栏，秒——H5 抽常量，与
/// CONTAINER_TIMEOUT 同为动作超时命名纪律）。
const ENV_ACTION_TIMEOUT_SECS: f64 = 30.0;

/// 本地环境动作输出截断上限（字符——超限经 [`truncate_chars`] 带标记截断）。
const ENV_ACTION_OUTPUT_MAX_CHARS: usize = 100_000;

// ── 域错误形态 ──

/// 容器环境不可用（Docker 客户端缺失/守护进程不可达的结构化降级）。
#[derive(Debug, Clone)]
pub struct ContainerUnavailable(pub String);

impl std::fmt::Display for ContainerUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 环境域错误（结构化分型：容器降级 / 声明非法 / 沙箱拒绝）。
#[derive(Debug)]
pub enum EnvError {
    ContainerUnavailable(ContainerUnavailable),
    GraphDefinition(String),
    SandboxViolation(String),
}

impl std::fmt::Display for EnvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ContainerUnavailable(e) => f.write_str(&e.0),
            Self::GraphDefinition(e) | Self::SandboxViolation(e) => f.write_str(e),
        }
    }
}

impl std::error::Error for EnvError {}

// ── 运行时类别（声明式枚举：本地/浏览器/容器）──

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Local,
    WebBridge,
    Container,
}

impl RuntimeKind {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "local" => Ok(Self::Local),
            "web_bridge" => Ok(Self::WebBridge),
            "container" => Ok(Self::Container),
            other => Err(DomainError::InvalidData(format!("环境 runtime 非法: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::WebBridge => "web_bridge",
            Self::Container => "container",
        }
    }
}

// ── 环境声明（纯数据：运行时清单 = 数据，随补丁链版本化）──

#[derive(Debug, Clone, PartialEq)]
pub struct EnvironmentSpec {
    pub name: String,
    pub runtime: RuntimeKind,
    pub tools: Vec<String>,
    pub install_cmds: Vec<String>,
    pub version: Option<String>,
    pub meta: HashMap<String, JsonValue>,
}

impl EnvironmentSpec {
    pub fn from_json(data: &JsonValue) -> Result<Self, DomainError> {
        let obj = data
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("环境声明须为对象".to_string()))?;
        let name = obj
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DomainError::InvalidData("环境声明缺 name（字符串）".to_string()))?;
        let runtime = RuntimeKind::parse(
            obj.get("runtime")
                .and_then(|v| v.as_str())
                .unwrap_or("local"),
        )?;
        Ok(Self {
            name: name.to_string(),
            runtime,
            tools: string_list(obj.get("tools")),
            install_cmds: string_list(obj.get("install_cmds")),
            version: obj.get("version").and_then(|v| v.as_str()).map(str::to_string),
            meta: object_map(obj.get("meta")),
        })
    }

    pub fn to_json(&self) -> JsonValue {
        let mut obj = serde_json::Map::new();
        obj.insert("name".to_string(), JsonValue::String(self.name.clone()));
        obj.insert("runtime".to_string(), JsonValue::String(self.runtime.as_str().to_string()));
        if !self.tools.is_empty() {
            obj.insert("tools".to_string(), JsonValue::Array(self.tools.iter().map(|t| JsonValue::String(t.clone())).collect()));
        }
        if !self.install_cmds.is_empty() {
            obj.insert("install_cmds".to_string(), JsonValue::Array(self.install_cmds.iter().map(|c| JsonValue::String(c.clone())).collect()));
        }
        if let Some(version) = &self.version {
            obj.insert("version".to_string(), JsonValue::String(version.clone()));
        }
        if !self.meta.is_empty() {
            obj.insert("meta".to_string(), JsonValue::Object(self.meta.iter().map(|(k, v)| (k.clone(), v.clone())).collect()));
        }
        JsonValue::Object(obj)
    }

    /// 环境变量声明（meta.env_vars 数据形态 → 字符串映射；随补丁链版本化）。
    pub fn env_vars(&self) -> HashMap<String, String> {
        self.meta
            .get("env_vars")
            .filter(|v| v.is_object())
            .and_then(|v| v.as_object())
            .map(|vars| {
                vars.iter()
                    .map(|(key, value)| {
                        let text = value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string());
                        (key.clone(), text)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

// ── 环境实例句柄 ──

/// 环境实例句柄（提供器 ensure 的产物，宿主持有用于运行/销毁）。
#[derive(Debug, Clone)]
pub struct EnvironmentHandle {
    pub env_id: String,
    pub spec: Arc<EnvironmentSpec>,
    pub status: String,
    pub workdir: Option<String>,
    pub error: Option<String>,
}

// ── 审计（append-only 留痕：审计失败不阻断环境动作）──

/// 环境动作审计落库通道（boot.rs 经引擎操作通道 engine.records_put 接线）。
pub type AuditSink = Arc<dyn Fn(JsonValue) -> Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

/// 环境动作记录构造（action/env/command/ok/ts + 可选 detail；截断防撑爆）。
pub fn audit_record(action: &str, env: &str, command: &str, ok: bool, detail: &str) -> JsonValue {
    let mut record = serde_json::json!({
        "action": action,
        "env": env,
        "command": truncate_chars(command, 500),
        "ok": ok,
        "ts": now_epoch(),
    });
    if !detail.is_empty() {
        record["detail"] = JsonValue::String(truncate_chars(detail, 500));
    }
    record
}

/// 审计记录键（时间戳 + 随机后缀；append-only 不覆盖）。
pub fn audit_key(record: &JsonValue) -> String {
    let ts = record.get("ts").and_then(|v| v.as_f64()).unwrap_or(0.0);
    format!("{ts:.3}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8])
}

async fn emit_audit(audit: &Option<AuditSink>, record: JsonValue) {
    if let Some(sink) = audit {
        sink(record).await;
    }
}

// ── 本地环境提供器（引擎实现语义之上的宿主形态）──

/// 本地环境提供器（默认形态：白名单安装 + 沙箱运行 + 环境变量声明应用）。
///
/// ensure 幂等（已就绪且声明一致 = 复用既有实例；声明变更 = 旧实例
/// 销毁重建——环境形态跟随声明）；run 时把 spec.meta.env_vars 并入
/// 运行沙箱环境，并注入宿主 PATH（裸命令名才能解析）；destroy 幂等。
#[derive(Clone)]
pub struct InkLocalProvider {
    allowlist: Vec<String>,
    envs_dir: PathBuf,
    audit: Option<AuditSink>,
    instances: Arc<RwLock<HashMap<String, Arc<EnvironmentHandle>>>>,
}

impl InkLocalProvider {
    pub fn new(allowlist: Vec<String>, envs_dir: PathBuf, audit: Option<AuditSink>) -> Self {
        Self {
            allowlist,
            envs_dir,
            audit,
            instances: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn ensure(&self, spec: &EnvironmentSpec) -> Result<Arc<EnvironmentHandle>, EnvError> {
        if spec.runtime != RuntimeKind::Local {
            return Err(EnvError::GraphDefinition(format!(
                "本地提供器不承接 {} 环境: {}",
                spec.runtime.as_str(),
                spec.name
            )));
        }
        // 已就绪且声明一致 = 复用（幂等）；声明已变更 = 旧实例销毁重建
        if let Some(existing) = self.instances.read().unwrap().get(&spec.name).cloned() {
            if existing.status == ENV_STATUS_READY {
                if existing.spec.as_ref() == spec {
                    return Ok(existing);
                }
                self.destroy(&existing).await;
            }
        }
        let missing: Vec<String> = spec
            .tools
            .iter()
            .filter(|tool| which(tool).is_none())
            .cloned()
            .collect();
        if !missing.is_empty() {
            if !spec.install_cmds.is_empty() {
                self.install(spec).await?; // 安装失败 = 结构化错误（域侧转失败句柄）
            } else {
                let handle = self.make_handle(
                    spec,
                    Some(ENV_STATUS_FAILED),
                    Some(format!("工具缺失且未声明安装命令: {missing:?}")),
                );
                self.instances
                    .write()
                    .unwrap()
                    .insert(spec.name.clone(), handle.clone());
                return Ok(handle);
            }
        }
        let handle = self.make_handle(spec, None, None);
        self.instances
            .write()
            .unwrap()
            .insert(spec.name.clone(), handle.clone());
        Ok(handle)
    }

    async fn install(&self, spec: &EnvironmentSpec) -> Result<(), EnvError> {
        let handle = self.make_handle(spec, Some(ENV_STATUS_INSTALLING), None);
        self.instances
            .write()
            .unwrap()
            .insert(spec.name.clone(), handle.clone());
        let workdir = handle.workdir.clone().unwrap_or_else(|| ".".to_string());
        if let Ok(dir) = PathBuf::from(&workdir).canonicalize() {
            let _ = std::fs::create_dir_all(dir);
        } else {
            let _ = std::fs::create_dir_all(&workdir);
        }
        let env = run_env(spec);
        for cmd in &spec.install_cmds {
            let mut parts = cmd.split_whitespace();
            let program = parts.next().unwrap_or("");
            let rest: Vec<String> = parts.map(str::to_string).collect();
            if program.is_empty() || !self.allowlist.iter().any(|item| item == program) {
                let violation = format!("安装命令不在白名单: {cmd:?}（fail-closed）");
                emit_audit(
                    &self.audit,
                    audit_record("install", &spec.name, &spec.install_cmds.join("; "), false, &violation),
                )
                .await;
                return Err(EnvError::GraphDefinition(violation));
            }
            let mut argv = vec![program.to_string()];
            argv.extend(rest);
            let result = run_command(
                &argv,
                Some(Path::new(&workdir)),
                Some(&env),
                ENV_ACTION_TIMEOUT_SECS,
                ENV_ACTION_OUTPUT_MAX_CHARS,
                "",
            )
            .await;
            if result.exit_code != 0 {
                let violation = format!(
                    "安装失败 [{cmd:?}]: exit={} {}",
                    result.exit_code,
                    truncate_chars(&result.stderr, 200)
                );
                emit_audit(
                    &self.audit,
                    audit_record("install", &spec.name, &spec.install_cmds.join("; "), false, &violation),
                )
                .await;
                return Err(EnvError::GraphDefinition(violation));
            }
        }
        emit_audit(
            &self.audit,
            audit_record("install", &spec.name, &spec.install_cmds.join("; "), true, ""),
        )
        .await;
        Ok(())
    }

    pub async fn destroy(&self, handle: &Arc<EnvironmentHandle>) {
        self.instances.write().unwrap().remove(&handle.spec.name);
    }

    pub async fn run(
        &self,
        handle: &Arc<EnvironmentHandle>,
        command: &str,
        args: &[String],
    ) -> Result<ProcessResult, EnvError> {
        if handle.status != ENV_STATUS_READY {
            return Ok(ProcessResult::failed(format!("环境未就绪: {}", handle.status)));
        }
        if !self.allowlist.iter().any(|item| item == command) {
            return Err(EnvError::SandboxViolation(format!("命令不在白名单: {command}")));
        }
        let workdir = handle
            .workdir
            .clone()
            .unwrap_or_else(|| ".".to_string());
        let _ = std::fs::create_dir_all(&workdir);
        let env = run_env(handle.spec.as_ref());
        let mut argv = vec![command.to_string()];
        argv.extend(args.iter().cloned());
        let result = run_command(
            &argv,
            Some(Path::new(&workdir)),
            Some(&env),
            ENV_ACTION_TIMEOUT_SECS,
            ENV_ACTION_OUTPUT_MAX_CHARS,
            "",
        )
        .await;
        emit_audit(
            &self.audit,
            audit_record(
                "run",
                &handle.spec.name,
                &format!("{command} {}", args.join(" ")).trim(),
                result.exit_code == 0,
                "",
            ),
        )
        .await;
        Ok(result)
    }

    fn make_handle(&self, spec: &EnvironmentSpec, status: Option<&str>, error: Option<String>) -> Arc<EnvironmentHandle> {
        Arc::new(EnvironmentHandle {
            env_id: spec.name.clone(),
            spec: Arc::new(spec.clone()),
            status: status.unwrap_or(ENV_STATUS_READY).to_string(),
            workdir: Some(self.envs_dir.join(&spec.name).to_string_lossy().into_owned()),
            error,
        })
    }
}

// ── 浏览器桥提供器（恒就绪；run 显式不支持）──

/// 浏览器端形态提供器（iframe 桥，无需后端环境）。
///
/// 浏览器天然隔离（sandbox 属性 + postMessage 协议），无安装/运行
/// 概念——ensure 恒就绪；run 显式不支持（浏览器端执行体由前端桥承载，
/// 不经后端子进程）。
#[derive(Clone)]
pub struct WebBridgeProvider;

impl WebBridgeProvider {
    pub async fn ensure(&self, spec: &EnvironmentSpec) -> Result<Arc<EnvironmentHandle>, EnvError> {
        if spec.runtime != RuntimeKind::WebBridge {
            return Err(EnvError::GraphDefinition(format!(
                "浏览器桥提供器不承接 {} 环境: {}",
                spec.runtime.as_str(),
                spec.name
            )));
        }
        Ok(Arc::new(EnvironmentHandle {
            env_id: spec.name.clone(),
            spec: Arc::new(spec.clone()),
            status: ENV_STATUS_READY.to_string(),
            workdir: None,
            error: None,
        }))
    }

    pub async fn run(
        &self,
        handle: &Arc<EnvironmentHandle>,
        _command: &str,
        _args: &[String],
    ) -> Result<ProcessResult, EnvError> {
        Err(EnvError::GraphDefinition(format!(
            "浏览器桥环境不支持后端子进程运行: {}",
            handle.spec.name
        )))
    }
}

// ── 容器提供器（出厂落地：镜像描述 = 数据，三动作幂等）──

/// Docker 探测通道（客户端存在 + 守护进程可达性探测；测试可注入桩）。
pub type DockerProbe = Arc<
    dyn Fn(Vec<String>, f64) -> Pin<Box<dyn std::future::Future<Output = ProcessResult> + Send>>
        + Send
        + Sync,
>;

/// 容器环境提供器（出厂落地：镜像描述 = 数据，三动作幂等）。
///
/// ensure：镜像已存在（docker image inspect）→ 复用；缺失且声明了
/// 构建上下文（meta.image.build_context）→ 构建；两者皆缺 → 显式失败。
/// run：docker run 执行白名单命令（输出/退出码/超时结构化返回）。
/// destroy：停止并移除容器（幂等；镜像保留——镜像描述是数据，重建
/// 成本 = 数据驱动）。
///
/// Docker 不可用（客户端缺失/守护进程不可达）= 结构化错误
/// （[`ContainerUnavailable`]），所有动作 fail-closed 不假装可用；
/// 守护进程探测结果缓存（不可达后不再重复探测）。
#[derive(Clone)]
pub struct SeedContainerProvider {
    docker_binary: Option<String>,
    daemon_ok: Arc<RwLock<Option<bool>>>,
    probe: DockerProbe,
    instances: Arc<RwLock<HashMap<String, String>>>,
    audit: Option<AuditSink>,
}

impl SeedContainerProvider {
    pub fn new(audit: Option<AuditSink>) -> Self {
        Self::with_probe(audit, default_docker_probe())
    }

    /// 注入探测通道（测试形态：免真实 Docker 断言降级/幂等语义）。
    pub fn with_probe(audit: Option<AuditSink>, probe: DockerProbe) -> Self {
        Self {
            // 测试形态固定用 docker 名义（探测通道已桩化，二进制名不参与判定）
            docker_binary: Some("docker".to_string()),
            daemon_ok: Arc::new(RwLock::new(None)),
            probe,
            instances: Arc::new(RwLock::new(HashMap::new())),
            audit,
        }
    }

    /// Docker 可用性门（客户端 + 守护进程探测；结果缓存）。
    async fn require_docker(&self) -> Result<(), EnvError> {
        {
            let cached = *self.daemon_ok.read().unwrap();
            match cached {
                Some(false) => {
                    return Err(EnvError::ContainerUnavailable(ContainerUnavailable(
                        "Docker 守护进程不可达（请确认 Docker Desktop 已启动）".to_string(),
                    )));
                }
                Some(true) => return Ok(()),
                None => {}
            }
        }
        let Some(binary) = self.docker_binary.clone() else {
            return Err(EnvError::ContainerUnavailable(ContainerUnavailable(
                "Docker 客户端未安装（容器形态不可用，local 为默认形态）".to_string(),
            )));
        };
        let result = (self.probe)(
            vec![
                binary,
                "version".to_string(),
                "--format".to_string(),
                "{{.Server.Version}}".to_string(),
            ],
            10.0,
        )
        .await;
        if result.exit_code != 0 || result.stdout.trim().is_empty() {
            *self.daemon_ok.write().unwrap() = Some(false);
            return Err(EnvError::ContainerUnavailable(ContainerUnavailable(
                "Docker 守护进程不可达（请确认 Docker Desktop 已启动）".to_string(),
            )));
        }
        *self.daemon_ok.write().unwrap() = Some(true);
        Ok(())
    }

    pub async fn ensure(&self, spec: &EnvironmentSpec) -> Result<Arc<EnvironmentHandle>, EnvError> {
        if spec.runtime != RuntimeKind::Container {
            return Err(EnvError::GraphDefinition(format!(
                "容器提供器不承接 {} 环境: {}",
                spec.runtime.as_str(),
                spec.name
            )));
        }
        self.require_docker().await?;
        let image = spec.meta.get("image").cloned().unwrap_or(JsonValue::Object(Default::default()));
        let image_name = image.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if image_name.is_empty() {
            return Ok(self.failed_handle(spec, "容器环境声明缺 meta.image.name（镜像描述 = 数据）"));
        }
        if self.image_exists(&image_name).await {
            return Ok(self.ready_handle(spec));
        }
        let build_context = image
            .get("build_context")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !build_context.is_empty() {
            let Some(binary) = self.docker_binary.clone() else {
                return Err(EnvError::ContainerUnavailable(ContainerUnavailable(
                    "Docker 客户端未安装（容器形态不可用，local 为默认形态）".to_string(),
                )));
            };
            let result = (self.probe)(
                vec![binary, "build".to_string(), "-t".to_string(), image_name.clone(), build_context],
                CONTAINER_TIMEOUT,
            )
            .await;
            if result.exit_code != 0 {
                let detail = truncate_chars(&result.stderr, 300);
                emit_audit(
                    &self.audit,
                    audit_record("build", &spec.name, "docker build", false, &detail),
                )
                .await;
                return Ok(self.failed_handle(spec, &format!("镜像构建失败: {detail}")));
            }
            emit_audit(&self.audit, audit_record("build", &spec.name, "docker build", true, "")).await;
            return Ok(self.ready_handle(spec));
        }
        Ok(self.failed_handle(
            spec,
            &format!("镜像 {image_name} 不存在且未声明 build_context（可经补丁链演化）"),
        ))
    }

    /// 销毁（幂等）：移除运行中的容器；镜像保留（数据形态可重建）。
    pub async fn destroy(&self, handle: &Arc<EnvironmentHandle>) -> Result<(), EnvError> {
        let container_id = self.instances.write().unwrap().remove(&handle.spec.name);
        if let (Some(container_id), Some(binary)) = (container_id, self.docker_binary.clone()) {
            let _ = (self.probe)(vec![binary, "rm".to_string(), "-f".to_string(), container_id], 30.0).await;
        }
        Ok(())
    }

    pub async fn run(
        &self,
        handle: &Arc<EnvironmentHandle>,
        command: &str,
        args: &[String],
    ) -> Result<ProcessResult, EnvError> {
        if handle.status != ENV_STATUS_READY {
            return Ok(ProcessResult::failed(format!("环境未就绪: {}", handle.status)));
        }
        self.require_docker().await?;
        let Some(binary) = self.docker_binary.clone() else {
            return Err(EnvError::ContainerUnavailable(ContainerUnavailable(
                "Docker 客户端未安装（容器形态不可用，local 为默认形态）".to_string(),
            )));
        };
        let image = handle
            .spec
            .meta
            .get("image")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let container_name = format!(
            "inkling-{}-{}",
            handle.spec.name,
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let mut argv = vec![
            binary,
            "run".to_string(),
            "--rm".to_string(),
            "--name".to_string(),
            container_name.clone(),
            image,
            command.to_string(),
        ];
        argv.extend(args.iter().cloned());
        let result = (self.probe)(argv, CONTAINER_TIMEOUT).await;
        self.instances
            .write()
            .unwrap()
            .insert(handle.spec.name.clone(), container_name);
        emit_audit(
            &self.audit,
            audit_record(
                "run",
                &handle.spec.name,
                &format!("{command} {}", args.join(" ")).trim(),
                result.exit_code == 0,
                "",
            ),
        )
        .await;
        Ok(result)
    }

    fn ready_handle(&self, spec: &EnvironmentSpec) -> Arc<EnvironmentHandle> {
        Arc::new(EnvironmentHandle {
            env_id: spec.name.clone(),
            spec: Arc::new(spec.clone()),
            status: ENV_STATUS_READY.to_string(),
            workdir: None,
            error: None,
        })
    }

    fn failed_handle(&self, spec: &EnvironmentSpec, error: &str) -> Arc<EnvironmentHandle> {
        Arc::new(EnvironmentHandle {
            env_id: spec.name.clone(),
            spec: Arc::new(spec.clone()),
            status: ENV_STATUS_FAILED.to_string(),
            workdir: None,
            error: Some(error.to_string()),
        })
    }

    async fn image_exists(&self, image_name: &str) -> bool {
        let Some(binary) = self.docker_binary.clone() else {
            return false;
        };
        let result = (self.probe)(
            vec![binary, "image".to_string(), "inspect".to_string(), image_name.to_string()],
            30.0,
        )
        .await;
        result.exit_code == 0
    }
}

fn default_docker_probe() -> DockerProbe {
    Arc::new(
        |argv: Vec<String>, timeout: f64| -> Pin<Box<dyn std::future::Future<Output = ProcessResult> + Send>> {
            Box::pin(async move { run_command(&argv, None, None, timeout, 4000, "容器动作超时（已 kill）").await })
        },
    )
}

/// Docker 可用性探测（客户端存在 + 守护进程可达；调用方据此决定
/// 降级路径/跳过容器全链路用例）。
pub fn docker_available() -> bool {
    let Some(binary) = which("docker") else {
        return false;
    };
    let output = std::process::Command::new(&binary)
        .args(["version", "--format", "{{.Server.Version}}"])
        .output();
    matches!(output, Ok(out) if out.status.success() && !out.stdout.is_empty())
}

// ── 环境提供器集合（三形态注册表）──

/// 环境提供器集合（出厂三形态枚举；按运行时类别分发，插拔替换由
/// boot 装配负责——域内零动态注册，默认形态语义不被覆盖）。
#[derive(Clone)]
pub struct ProviderSet {
    local: InkLocalProvider,
    container: SeedContainerProvider,
    web_bridge: WebBridgeProvider,
}

impl ProviderSet {
    pub fn new(
        envs_dir: PathBuf,
        run_allowlist: Vec<String>,
        audit: Option<AuditSink>,
        container_probe: Option<DockerProbe>,
    ) -> Self {
        Self {
            local: InkLocalProvider::new(run_allowlist, envs_dir, audit.clone()),
            container: match container_probe {
                Some(probe) => SeedContainerProvider::with_probe(audit.clone(), probe),
                None => SeedContainerProvider::new(audit.clone()),
            },
            web_bridge: WebBridgeProvider,
        }
    }

    /// 注册表清单（设置页「环境管理」数据源与域选择底座）。
    pub fn names(&self) -> Vec<&'static str> {
        vec!["local", "web_bridge", "container"]
    }

    pub async fn ensure(&self, spec: &EnvironmentSpec) -> Result<Arc<EnvironmentHandle>, EnvError> {
        match spec.runtime {
            RuntimeKind::Local => self.local.ensure(spec).await,
            RuntimeKind::Container => self.container.ensure(spec).await,
            RuntimeKind::WebBridge => self.web_bridge.ensure(spec).await,
        }
    }

    pub async fn destroy(&self, handle: &Arc<EnvironmentHandle>) -> Result<(), EnvError> {
        match handle.spec.runtime {
            RuntimeKind::Local => {
                self.local.destroy(handle).await;
                Ok(())
            }
            RuntimeKind::Container => self.container.destroy(handle).await,
            RuntimeKind::WebBridge => Ok(()),
        }
    }

    pub async fn run(
        &self,
        handle: &Arc<EnvironmentHandle>,
        command: &str,
        args: &[String],
    ) -> Result<ProcessResult, EnvError> {
        match handle.spec.runtime {
            RuntimeKind::Local => self.local.run(handle, command, args).await,
            RuntimeKind::Container => self.container.run(handle, command, args).await,
            RuntimeKind::WebBridge => self.web_bridge.run(handle, command, args).await,
        }
    }
}

// ── 域装配门面 ──

/// 环境装配域（env.json 装载 + 提供器注册表 + 域选择 + 补丁应用）。
///
/// 装配：三形态提供器注册；按环境名选择提供器 ensure/run/destroy。
/// 环境动作落审计（注入时）；补丁链应用目标 = 声明 → ensure（幂等），
/// 回退由补丁链驱动（声明回退 + 实例重建）。Clone 形态供应用目标
/// 回调闭包捕获（'static 跨调用保持，共享登记表状态）。
#[derive(Clone)]
pub struct EnvironmentDomain {
    baseline: HashMap<String, EnvironmentSpec>,
    specs: Arc<RwLock<HashMap<String, EnvironmentSpec>>>,
    providers: ProviderSet,
    handles: Arc<RwLock<HashMap<String, Arc<EnvironmentHandle>>>>,
}

impl EnvironmentDomain {
    pub fn new(
        env_data: &JsonValue,
        envs_dir: PathBuf,
        run_allowlist: Vec<String>,
        audit: Option<AuditSink>,
        container_probe: Option<DockerProbe>,
    ) -> Result<Self, DomainError> {
        let mut baseline = HashMap::new();
        let environments = env_data.get("environments").and_then(|v| v.as_array());
        for entry in environments.unwrap_or(&Vec::new()) {
            let spec = EnvironmentSpec::from_json(entry)?;
            baseline.insert(spec.name.clone(), spec);
        }
        Ok(Self {
            specs: Arc::new(RwLock::new(baseline.clone())),
            baseline,
            providers: ProviderSet::new(envs_dir, run_allowlist, audit, container_probe),
            handles: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// 已声明环境名（设置页「环境管理」数据源）。
    pub fn names(&self) -> Vec<String> {
        self.specs.read().unwrap().keys().cloned().collect()
    }

    pub fn provider_names(&self) -> Vec<&'static str> {
        self.providers.names()
    }

    pub fn spec(&self, name: &str) -> Option<EnvironmentSpec> {
        self.specs.read().unwrap().get(name).cloned()
    }

    pub fn handle(&self, name: &str) -> Option<Arc<EnvironmentHandle>> {
        self.handles.read().unwrap().get(name).cloned()
    }

    /// 按名选择环境并确保就绪（域选择入口；结构化降级不崩溃）。
    pub async fn ensure(&self, name: &str) -> Result<Arc<EnvironmentHandle>, EnvError> {
        let spec = self.specs.read().unwrap().get(name).cloned();
        let Some(spec) = spec else {
            return Err(EnvError::GraphDefinition(format!("环境未声明: {name}")));
        };
        Ok(self.ensure_spec(&spec).await)
    }

    /// 声明 → 提供器 ensure（失败 = 状态化句柄，不击穿调用方）。
    pub async fn ensure_spec(&self, spec: &EnvironmentSpec) -> Arc<EnvironmentHandle> {
        let handle = match self.providers.ensure(spec).await {
            Ok(handle) => handle,
            Err(EnvError::ContainerUnavailable(err)) => {
                self.failed_handle(spec, &format!("容器形态不可用: {err}"))
            }
            Err(EnvError::GraphDefinition(err)) => self.failed_handle(spec, &err),
            Err(EnvError::SandboxViolation(err)) => self.failed_handle(spec, &err),
        };
        self.handles
            .write()
            .unwrap()
            .insert(spec.name.clone(), handle.clone());
        handle
    }

    /// 在已就绪环境中运行白名单命令（未就绪/越权 = 结构化失败）。
    ///
    /// 沙箱拒绝（白名单外命令）与形态不支持（web_bridge 后端子进程）
    /// 一律落为结构化 ProcessResult，不裸抛击穿调用方。
    pub async fn run(&self, name: &str, command: &str, args: &[String]) -> ProcessResult {
        let handle = self.handles.read().unwrap().get(name).cloned();
        let Some(handle) = handle else {
            return ProcessResult::failed(format!("环境未就绪: {name}（请先 ensure）"));
        };
        if handle.status != ENV_STATUS_READY {
            return ProcessResult::failed(format!("环境未就绪: {name}（请先 ensure）"));
        }
        match self.providers.run(&handle, command, args).await {
            Ok(result) => result,
            Err(EnvError::SandboxViolation(violation)) => {
                ProcessResult::failed(format!("沙箱拒绝: {violation}"))
            }
            Err(EnvError::GraphDefinition(err)) => ProcessResult::failed(err),
            Err(EnvError::ContainerUnavailable(err)) => ProcessResult::failed(err.to_string()),
        }
    }

    /// 销毁环境实例（幂等；声明保留可重建）。
    pub async fn destroy(&self, name: &str) {
        let handle = self.handles.read().unwrap().get(name).cloned();
        let Some(handle) = handle else {
            return;
        };
        if let Ok(()) = self.providers.destroy(&handle).await {
            self.handles.write().unwrap().remove(name);
        }
    }

    /// 从集补丁链组装的环境段恢复活跃态（重启/回退后声明生效）。
    ///
    /// 声明全景 = 基线（env.json）叠加链补丁增量（链为权威，链值覆盖
    /// 基线）；回退 = 补丁撤销 → 回落基线声明 + 实例重建（ensure 的
    /// 声明变更销毁重建语义覆盖）。
    pub async fn restore(&self, patch_values: &HashMap<String, JsonValue>) {
        let merged = merge_environment_specs(&self.baseline, patch_values);
        *self.specs.write().unwrap() = merged;
        let all = self.specs.read().unwrap().clone();
        for spec in all.values() {
            let _ = self.ensure_spec(spec).await;
        }
    }

    fn failed_handle(&self, spec: &EnvironmentSpec, error: &str) -> Arc<EnvironmentHandle> {
        Arc::new(EnvironmentHandle {
            env_id: spec.name.clone(),
            spec: Arc::new(spec.clone()),
            status: ENV_STATUS_FAILED.to_string(),
            workdir: None,
            error: Some(error.to_string()),
        })
    }

    /// ENVIRONMENT 补丁链自应用目标注册（回调桥 + 目标登记两步）。
    ///
    /// 应用回调（live.environment_apply）实现声明 ensure 语义——补丁
    /// 落链时引擎侧回调委托 Rust 侧生效（解析声明 → 登记 → 确保就绪，
    /// 与 [`apply_environment_patch`] 同语义；回调桥为同步形态，ensure
    /// 的异步动作经独立当前线程运行时驱动）；目标登记经
    /// patch.apply_target_register 挂进补丁链自应用目标注册表
    /// （kind = environment，callback = live.environment_apply）。
    /// 重复注册同名 = 覆盖（幂等）。无引擎环境 = 回调桥/运行时未装配
    /// 的结构化错误（fail-closed，不静默假装已注册）。
    pub async fn register_apply_target(&self) -> Result<JsonValue, String> {
        let domain = self.clone();
        register_callback(
            "live.environment_apply",
            Box::new(move |payload: String| -> pyo3::PyResult<String> {
                let args: JsonValue = serde_json::from_str(&payload)
                    .map_err(|err| pyo3::exceptions::PyValueError::new_err(err.to_string()))?;
                let patch_payload = args
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                // 回调桥同步执行：ensure 的异步动作（本地/容器进程通道）
                // 经共享时序运行时驱动（H4：进程级单例复用，替代每次
                // 调用新建 current_thread runtime——声明解析失败 = 结构化
                // 拒绝（fail-closed），不 panic
                match apply_runtime().block_on(apply_environment_patch(&domain, &patch_payload)) {
                    Ok(name) => Ok(serde_json::json!({ "ok": true, "name": name }).to_string()),
                    Err(err) => Ok(serde_json::json!({ "ok": false, "reason": err.to_string() }).to_string()),
                }
            }),
        )
        .map_err(|err| format!("环境应用回调注册失败: {err}"))?;
        call_engine_op(
            "patch.apply_target_register",
            serde_json::json!({ "kind": "environment", "callback": "live.environment_apply" }),
        )
    }
}

/// 声明全景合并（基线 + 链补丁增量；链为权威，链值覆盖基线；非法
/// 增量跳过——恢复路径不因单条声明损坏而整体失败）。
pub fn merge_environment_specs(
    baseline: &HashMap<String, EnvironmentSpec>,
    patches: &HashMap<String, JsonValue>,
) -> HashMap<String, EnvironmentSpec> {
    let mut merged = baseline.clone();
    for (name, raw) in patches {
        if raw.is_object() {
            if let Ok(spec) = EnvironmentSpec::from_json(raw) {
                merged.insert(name.clone(), spec);
            }
        }
    }
    merged
}

/// ENVIRONMENT 补丁落链后的活跃态生效：声明 → ensure（幂等）。
///
/// 补丁链是权威记录，本钩子只做当前进程的活跃态同步（声明变更 =
/// 旧实例销毁重建由提供器 ensure 语义覆盖；重启经链组装恢复）。
/// 钩子本体经 [`EnvironmentDomain::register_apply_target`] 注册进补丁
/// 链自应用目标表（kind = environment，callback 委托本函数语义）。
pub async fn apply_environment_patch(
    domain: &EnvironmentDomain,
    payload: &JsonValue,
) -> Result<String, EnvError> {
    let spec = EnvironmentSpec::from_json(payload).map_err(|e| EnvError::GraphDefinition(e.to_string()))?;
    let name = spec.name.clone();
    domain.specs.write().unwrap().insert(name.clone(), spec.clone());
    domain.ensure_spec(&spec).await;
    Ok(name)
}

// ── 工具函数 ──

/// 环境应用回调共享时序运行时（H4：回调桥同步上下文内驱动 ensure 的
/// 异步动作；进程级单例复用，替代每次调用新建 current_thread runtime）。
fn apply_runtime() -> &'static tokio::runtime::Runtime {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("环境应用共享运行时创建失败")
    })
}

fn string_list(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 运行环境块（环境变量声明 + 宿主 PATH 注入；引擎不替宿主决定平台
/// 默认值——PATH 由宿主提供，裸命令名才能解析）。
fn run_env(spec: &EnvironmentSpec) -> HashMap<String, String> {
    let mut env = spec.env_vars();
    if !env.contains_key("PATH") {
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
    }
    env
}

/// PATH 命令查找（可用性判定入口）。
fn which(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{command}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    const SEED_ENV_JSON: &str = include_str!("../../../../../inkling/seed_data/env.json");

    fn seed_env() -> JsonValue {
        serde_json::from_str(SEED_ENV_JSON).unwrap()
    }

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkling-env-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn envs_dir(label: &str) -> (PathBuf, Scratch) {
        let dir = scratch(label);
        (dir.clone(), Scratch(dir))
    }

    /// 测试环境 Python 兜底：部分开发机 PATH 的 `python` 是 Windows 商店
    /// 占位桩（App Execution Alias，退出码 9009），导致 spawn python 的
    /// 用例误判为执行失败。此处把仓库 venv 真实解释器目录前插到进程 PATH，
    /// 保证子进程 `python` 可解析（与本 crate 构建的 PYO3_PYTHON 同源）。
    fn ensure_test_python_on_path() {
        use std::sync::Once;
        static ONCE: Once = Once::new();
        ONCE.call_once(|| {
            let prefixed = super::super::common::test_python_prefixed_path(
                &std::env::var("PATH").unwrap_or_default(),
            );
            std::env::set_var("PATH", prefixed);
        });
    }

    // ── env.json → 三环境声明 ──

    #[test]
    fn test_env_json_maps_to_three_specs() {
        let data = seed_env();
        let environments = data["environments"].as_array().unwrap();
        let mut specs = HashMap::new();
        for env in environments {
            let spec = EnvironmentSpec::from_json(env).unwrap();
            specs.insert(spec.name.clone(), spec);
        }
        assert_eq!(specs.len(), 3);
        assert!(specs.contains_key("inkling.local"));
        assert!(specs.contains_key("inkling.web_bridge"));
        assert!(specs.contains_key("inkling.container"));
        assert_eq!(specs["inkling.local"].runtime, RuntimeKind::Local);
        assert_eq!(specs["inkling.web_bridge"].runtime, RuntimeKind::WebBridge);
        assert_eq!(specs["inkling.container"].runtime, RuntimeKind::Container);
        // 容器镜像描述 = 数据（补丁链版本化形态）
        assert_eq!(
            specs["inkling.container"].meta["image"]["name"],
            "inkling/base:0.1.0"
        );
        // local 环境变量声明
        assert_eq!(specs["inkling.local"].env_vars()["INKLING_LOCAL_READY"], "1");
    }

    #[test]
    fn test_environment_domain_registry_three_providers() {
        let (dir, _keep) = envs_dir("registry");
        let domain = EnvironmentDomain::new(&seed_env(), dir.join("envs"), vec![], None, None).unwrap();
        let mut names = domain.names();
        names.sort();
        assert_eq!(
            names,
            vec!["inkling.container".to_string(), "inkling.local".to_string(), "inkling.web_bridge".to_string()]
        );
        assert_eq!(domain.provider_names(), vec!["local", "web_bridge", "container"]);
    }

    #[test]
    fn test_spec_validation_rejects_bad_runtime() {
        let err = EnvironmentSpec::from_json(&json!({"name": "x", "runtime": "docker"})).unwrap_err();
        assert!(err.to_string().contains("runtime"));
        let ok = EnvironmentSpec::from_json(&json!({"name": "x", "version": "0.1.0"})).unwrap();
        assert_eq!(ok.runtime, RuntimeKind::Local);
    }

    // ── 域选择 + 三形态语义 ──

    #[tokio::test]
    async fn test_local_env_ensure_run_destroy_idempotent() {
        ensure_test_python_on_path();
        let (dir, _keep) = envs_dir("local-loop");
        let domain = EnvironmentDomain::new(
            &seed_env(),
            dir.join("envs"),
            vec!["python".to_string(), "echo".to_string()],
            None,
            None,
        )
        .unwrap();
        let handle = domain.ensure("inkling.local").await.unwrap();
        assert_eq!(handle.status, ENV_STATUS_READY);
        let again = domain.ensure("inkling.local").await.unwrap();
        assert!(Arc::ptr_eq(&handle, &again), "ensure 幂等：已就绪返回既有实例");

        let result = domain
            .run(
                "inkling.local",
                "python",
                &["-c".to_string(), "import os; print(os.environ.get('INKLING_LOCAL_READY', 'missing'))".to_string()],
            )
            .await;
        assert_eq!(result.exit_code, 0, "运行失败: {}", result.stderr);
        assert!(result.stdout.contains("1"), "环境变量声明未应用: {}", result.stdout);

        domain.destroy("inkling.local").await;
        domain.destroy("inkling.local").await; // destroy 幂等（重复销毁静默成功）
        let stale = domain.run("inkling.local", "echo", &["x".to_string()]).await;
        assert_eq!(stale.exit_code, -1, "销毁后运行 = 明确失败");
        assert!(stale.stderr.contains("未就绪"));
    }

    #[tokio::test]
    async fn test_local_provider_run_rejects_non_allowlist() {
        let (dir, _keep) = envs_dir("local-allowlist");
        let domain = EnvironmentDomain::new(&seed_env(), dir.join("envs"), vec!["echo".to_string()], None, None).unwrap();
        let _ = domain.ensure("inkling.local").await;
        let result = domain.run("inkling.local", "curl", &["http://evil".to_string()]).await;
        assert_eq!(result.exit_code, -1);
        assert!(result.stderr.contains("白名单"), "拒绝原因应含白名单语义: {}", result.stderr);
    }

    #[tokio::test]
    async fn test_web_bridge_env_semantics() {
        let (dir, _keep) = envs_dir("web-bridge");
        let domain = EnvironmentDomain::new(&seed_env(), dir.join("envs"), vec![], None, None).unwrap();
        let handle = domain.ensure("inkling.web_bridge").await.unwrap();
        assert_eq!(handle.status, ENV_STATUS_READY);
        let result = domain.run("inkling.web_bridge", "echo", &["x".to_string()]).await;
        assert_eq!(result.exit_code, -1);
        assert!(result.stderr.contains("不支持"), "形态不支持应显式说明: {}", result.stderr);
    }

    // ── 容器提供器（无 Docker = 结构化降级；探测缓存）──

    #[tokio::test]
    async fn test_container_provider_structured_degrade_with_probe() {
        let (dir, _keep) = envs_dir("container-degrade");
        let calls = Arc::new(Mutex::new(0usize));
        let probe = fake_docker_probe(calls.clone(), 125, "cannot connect");
        let domain = EnvironmentDomain::new(
            &seed_env(),
            dir.join("envs"),
            vec![],
            None,
            Some(probe),
        )
        .unwrap();

        let handle = domain.ensure("inkling.container").await.unwrap();
        assert_eq!(handle.status, ENV_STATUS_FAILED, "降级 = 失败态而非假装可用");
        assert!(handle.error.as_deref().unwrap().contains("Docker"), "明确降级原因: {:?}", handle.error);

        // 第二次 ensure：探测结果已缓存（不再重复探测）
        let again = domain.ensure("inkling.container").await.unwrap();
        assert_eq!(again.status, ENV_STATUS_FAILED);
        assert_eq!(*calls.lock().unwrap(), 1, "守护进程探测结果应缓存");

        let result = domain.run("inkling.container", "echo", &["x".to_string()]).await;
        assert_eq!(result.exit_code, -1, "未就绪运行 = 明确失败");
        assert!(result.stderr.contains("未就绪"));

        domain.destroy("inkling.container").await; // destroy 幂等不崩溃
        domain.destroy("inkling.container").await;
    }

    #[tokio::test]
    async fn test_container_provider_direct_degrades() {
        let probe = fake_docker_probe(Arc::new(Mutex::new(0usize)), 125, "cannot connect");
        let provider = SeedContainerProvider::with_probe(None, probe);
        let spec = EnvironmentSpec {
            name: "inkling.container".to_string(),
            runtime: RuntimeKind::Container,
            tools: vec![],
            install_cmds: vec![],
            version: None,
            meta: HashMap::from([(
                "image".to_string(),
                json!({"name": "inkling/base:0.1.0", "build_context": null}),
            )]),
        };
        let err = provider.ensure(&spec).await.unwrap_err();
        assert!(matches!(err, EnvError::ContainerUnavailable(_)), "守护进程不可达应结构化升级");
        // runtime 不匹配 = 声明拒绝
        let wrong = EnvironmentSpec {
            runtime: RuntimeKind::Local,
            ..spec
        };
        let name_err = provider.ensure(&wrong).await.unwrap_err();
        assert!(matches!(name_err, EnvError::GraphDefinition(_)));
    }

    #[tokio::test]
    async fn test_container_provider_daemon_ok_but_image_missing_fails() {
        let (dir, _keep) = envs_dir("container-image-missing");
        let probe = fake_docker_probe(Arc::new(Mutex::new(0usize)), 0, "24.0.0");
        let provider = SeedContainerProvider::with_probe(None, probe);
        let spec = EnvironmentSpec {
            name: "inkling.container".to_string(),
            runtime: RuntimeKind::Container,
            tools: vec![],
            install_cmds: vec![],
            version: None,
            meta: HashMap::from([(
                "image".to_string(),
                json!({"name": "inkling/base:0.1.0", "build_context": null}),
            )]),
        };
        // 守护进程可达（version 探针通过），但镜像不存在且无构建上下文 → 显式失败
        let handle = provider.ensure(&spec).await.unwrap();
        assert_eq!(handle.status, ENV_STATUS_FAILED);
        assert!(handle.error.as_deref().unwrap().contains("build_context"));
        let _ = dir;
    }

    #[tokio::test]
    async fn test_container_provider_image_build_context_runs() {
        let probe = fake_docker_probe(Arc::new(Mutex::new(0usize)), 0, "24.0.0");
        let provider = SeedContainerProvider::with_probe(None, probe);
        let context = scratch("build-context");
        let _keep = Scratch(context.clone());
        let spec = EnvironmentSpec {
            name: "inkling.deploy".to_string(),
            runtime: RuntimeKind::Container,
            tools: vec!["python".to_string()],
            install_cmds: vec![],
            version: None,
            meta: HashMap::from([(
                "image".to_string(),
                json!({"name": "inkling/e2e:0.1.0", "build_context": context.to_string_lossy()}),
            )]),
        };
        let handle = provider.ensure(&spec).await.unwrap();
        assert_eq!(handle.status, ENV_STATUS_READY, "镜像构建路径应就绪: {:?}", handle.error);
        let result = provider.run(&handle, "python", &["app.py".to_string()]).await.unwrap();
        assert_eq!(result.exit_code, 0, "容器内运行应白名单放行");
    }

    fn fake_docker_probe(calls: Arc<Mutex<usize>>, version_exit: i32, version_stdout: &str) -> DockerProbe {
        let version_stdout = version_stdout.to_string();
        Arc::new(move |argv: Vec<String>, _timeout: f64| -> Pin<Box<dyn std::future::Future<Output = ProcessResult> + Send>> {
            let calls = calls.clone();
            let version_stdout = version_stdout.clone();
            Box::pin(async move {
                {
                    let mut guard = calls.lock().unwrap();
                    *guard += 1;
                }
                if argv.contains(&"version".to_string()) {
                    ProcessResult {
                        exit_code: version_exit,
                        stdout: version_stdout,
                        stderr: if version_exit == 0 {
                            String::new()
                        } else {
                            "cannot connect to the Docker daemon".to_string()
                        },
                        timed_out: false,
                    }
                } else if argv.contains(&"inspect".to_string()) {
                    // 镜像不存在（img 未落盘）；构建/运行路径按桩成功
                    ProcessResult::failed("image not found")
                } else {
                    ProcessResult { exit_code: 0, stdout: String::new(), stderr: String::new(), timed_out: false }
                }
            })
        })
    }

    // ── 链恢复形态与补丁应用 ──

    #[test]
    fn test_merge_specs_baseline_plus_patch_increments() {
        let baseline = HashMap::from([(
            "inkling.local".to_string(),
            EnvironmentSpec::from_json(&json!({
                "name": "inkling.local", "runtime": "local",
                "meta": {"env_vars": {"OLD": "1"}}, "version": "0.1.0",
            }))
            .unwrap(),
        )]);
        let mut patches = HashMap::new();
        patches.insert(
            "inkling.local".to_string(),
            json!({"name": "inkling.local", "runtime": "local", "version": "0.2.0", "meta": {}}),
        );
        // 非法增量（非 dict）= 跳过（链上损坏不阻断恢复）
        patches.insert("inkling.broken".to_string(), json!("not-an-object"));
        let merged = merge_environment_specs(&baseline, &patches);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged["inkling.local"].version.as_deref(), Some("0.2.0"));
    }

    #[tokio::test]
    async fn test_restore_applies_chain_values_and_ensures() {
        let (dir, _keep) = envs_dir("restore");
        let domain = EnvironmentDomain::new(
            &seed_env(),
            dir.join("envs"),
            vec!["python".to_string()],
            None,
            None,
        )
        .unwrap();
        let mut patches = HashMap::new();
        patches.insert(
            "inkling.local".to_string(),
            json!({"name": "inkling.local", "runtime": "local", "version": "0.2.0", "meta": {}}),
        );
        domain.restore(&patches).await;
        assert_eq!(domain.spec("inkling.local").unwrap().version.as_deref(), Some("0.2.0"));
        let handle = domain.handle("inkling.local").unwrap();
        assert_eq!(handle.status, ENV_STATUS_READY);
    }

    #[tokio::test]
    async fn test_environment_patch_declares_new_env() {
        let (dir, _keep) = envs_dir("patch-new-env");
        let domain = EnvironmentDomain::new(
            &seed_env(),
            dir.join("envs"),
            vec!["python".to_string()],
            None,
            None,
        )
        .unwrap();
        let payload = json!({
            "name": "inkling.sandbox",
            "runtime": "local",
            "tools": [],
            "install_cmds": [],
            "version": "0.1.0",
            "meta": {
                "versioned_by_patch_chain": true,
                "env_vars": {"INKLING_SANDBOX": "1"},
            },
        });
        let name = apply_environment_patch(&domain, &payload).await.unwrap();
        assert_eq!(name, "inkling.sandbox");
        assert!(domain.names().contains(&"inkling.sandbox".to_string()));
        let handle = domain.handle("inkling.sandbox").unwrap();
        assert_eq!(handle.status, ENV_STATUS_READY);
        // 声明保留可重建（销毁后再次 ensure 就绪）
        domain.destroy("inkling.sandbox").await;
        let again = domain.ensure("inkling.sandbox").await.unwrap();
        assert_eq!(again.status, ENV_STATUS_READY);
    }

    #[tokio::test]
    async fn test_ensure_unknown_env_is_structured_error() {
        let (dir, _keep) = envs_dir("unknown-env");
        let domain = EnvironmentDomain::new(&seed_env(), dir.join("envs"), vec![], None, None).unwrap();
        let err = domain.ensure("inkling.ghost").await.unwrap_err();
        assert!(err.to_string().contains("环境未声明"));
    }

    #[test]
    fn register_apply_target_fails_closed_without_engine() {
        // 无引擎环境（回调桥/运行时未装配）：回调注册或目标登记结构化
        // 失败，不返回占位文案、不静默假装已注册
        let _serial = crate::engine::host::bridge_guard();
        let (dir, _keep) = envs_dir("apply-target");
        let domain = EnvironmentDomain::new(&seed_env(), dir.join("envs"), vec![], None, None).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(domain.register_apply_target());
        assert!(err.is_err());
        assert!(!err.unwrap_err().contains("需 op"));
    }

    // ── 审计形态 ──

    #[test]
    fn test_audit_record_and_key_shapes() {
        let record = audit_record("run", "inkling.local", "python -c x", true, "");
        assert_eq!(record["action"], "run");
        assert_eq!(record["ok"], true);
        let key = audit_key(&record);
        assert!(key.contains('-'));
        let with_detail = audit_record("build", "inkling.container", "docker build", false, "镜像构建失败");
        assert_eq!(with_detail["detail"], "镜像构建失败");
    }
}

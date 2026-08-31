//! 构建管线域：白名单沙箱构建 + 内容寻址产物 + 冒烟门禁 + ARTIFACT 补丁链。
//!
//! build.json（数据声明）→ 宿主侧构建管线接线：
//!
//! - **builder 白名单沙箱构建**：构建命令白名单 = build.json（数据驱动），
//!   非白名单命令 fail-closed 拒绝；产物内容寻址（artifact_id = 类别 +
//!   内容哈希前缀），文件级 sha256 哈希可校验；
//! - **冒烟门禁**：产物 promote 前经探针自检（命令/期望退出码可配置 =
//!   数据驱动），失败不落产物记录、不发起补丁（保留现状 + 留痕）；
//! - **vetting_l2_hook 挂钩**：[`BuildDomain::vet_artifact_patch`] ——
//!   ARTIFACT 补丁（L2 档）部署前验证——产物目录哈希逐文件比对 +
//!   冒烟记录（meta.smoke.ok），验证失败拒绝落链；
//! - **artifact 补丁落链**：构建产物描述（artifact_id/kind/hashes/meta）
//!   → ARTIFACT 补丁提案（L2 人工审批）→ 补丁链；应用目标把产物声明的
//!   工具注册进工具表（产物挂载引擎）；
//! - **container 部署**：产物声明容器形态（deploy.image_prefix + 内容
//!   寻址 id = 镜像名），经环境作用域钩子运行（隔离边界，重执行件安全
//!   落地的通道；Docker 不可用时结构化降级）。
//!
//! 依赖纪律：本模块不直接调用其它域模块（环境动作经 [`EnvHost`] 钩子
//! 形态注入，装配由 [`super::boot`] 接线）；引擎交互经
//! [`crate::engine::host::call_engine_op`] 操作通道。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value as JsonValue;
use sha2::Digest;

use super::common::{run_command, DomainError};
use crate::engine::host::call_engine_op;

// ── 构建/冒烟/挂载失败的错误码（结构化可观测，防魔法字符串）──

/// 白名单外构建命令拒绝（fail-closed）。
pub const BUILD_ERROR_WHITELIST: &str = "BLD_001";
/// 构建命令失败/超时/产物缺失。
pub const BUILD_ERROR_FAILED: &str = "BLD_002";
/// 冒烟门禁未通过（不 promote）。
pub const BUILD_ERROR_SMOKE: &str = "BLD_003";
/// ARTIFACT 补丁部署前验证未通过。
pub const BUILD_ERROR_VETTING: &str = "BLD_004";

/// ARTIFACT 补丁应用目标名（补丁链自应用目标的注册名）。
pub const ARTIFACT_APPLY_TARGET: &str = "inkling.artifact";

/// 构建/冒烟失败（产物保留现状，不 promote）。
#[derive(Debug)]
pub enum BuildError {
    Whitelist(String),
    Failed(String),
    Spec(String),
}

impl BuildError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Whitelist(_) => BUILD_ERROR_WHITELIST,
            Self::Failed(_) => BUILD_ERROR_FAILED,
            Self::Spec(_) => BUILD_ERROR_FAILED,
        }
    }
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Whitelist(msg) | Self::Failed(msg) | Self::Spec(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for BuildError {}

// ── 构建声明与产物（数据形态）──

/// 构建产物类别（声明式枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildKind {
    JsBundle,
    PythonPackage,
    Service,
}

impl BuildKind {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "js_bundle" => Ok(Self::JsBundle),
            "python_package" => Ok(Self::PythonPackage),
            "service" => Ok(Self::Service),
            other => Err(DomainError::InvalidData(format!("构建产物类别非法: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::JsBundle => "js_bundle",
            Self::PythonPackage => "python_package",
            Self::Service => "service",
        }
    }
}

/// 构建声明（命令/产物清单数据驱动；白名单在构建入口强制）。
#[derive(Debug, Clone, PartialEq)]
pub struct BuildSpec {
    pub kind: BuildKind,
    pub command: String,
    pub args: Vec<String>,
    pub workdir: PathBuf,
    pub env: Option<HashMap<String, String>>,
    pub timeout: f64,
    pub output_paths: Vec<String>,
    pub meta: HashMap<String, JsonValue>,
}

impl BuildSpec {
    fn validate(&self) -> Result<(), BuildError> {
        if self.command.is_empty() {
            return Err(BuildError::Spec("构建声明缺 command（白名单命令）".to_string()));
        }
        if self.timeout <= 0.0 {
            return Err(BuildError::Spec(format!("构建超时须为正数: {}", self.timeout)));
        }
        for path in &self.output_paths {
            if path.is_empty() {
                return Err(BuildError::Spec(
                    "构建声明的 output_paths 须为非空相对路径清单".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn to_dict(&self) -> JsonValue {
        let mut obj = serde_json::Map::new();
        obj.insert("kind".to_string(), JsonValue::String(self.kind.as_str().to_string()));
        obj.insert("command".to_string(), JsonValue::String(self.command.clone()));
        obj.insert("workdir".to_string(), JsonValue::String(self.workdir.to_string_lossy().into_owned()));
        obj.insert("timeout".to_string(), JsonValue::from(self.timeout));
        if !self.args.is_empty() {
            obj.insert("args".to_string(), JsonValue::Array(self.args.iter().map(|a| JsonValue::String(a.clone())).collect()));
        }
        if !self.output_paths.is_empty() {
            obj.insert("output_paths".to_string(), JsonValue::Array(self.output_paths.iter().map(|p| JsonValue::String(p.clone())).collect()));
        }
        if !self.meta.is_empty() {
            obj.insert("meta".to_string(), JsonValue::Object(self.meta.iter().map(|(k, v)| (k.clone(), v.clone())).collect()));
        }
        JsonValue::Object(obj)
    }
}

/// 构建产物（内容寻址：产物 id = 文件内容哈希派生的标识）。
#[derive(Debug, Clone, PartialEq)]
pub struct BuildArtifact {
    pub artifact_id: String,
    pub kind: String,
    pub files: HashMap<String, String>,
    pub built_at: f64,
    pub meta: HashMap<String, JsonValue>,
}

impl BuildArtifact {
    pub fn to_dict(&self) -> JsonValue {
        serde_json::json!({
            "artifact_id": self.artifact_id,
            "kind": self.kind,
            "files": self.files,
            "built_at": self.built_at,
            "meta": self.meta,
        })
    }
}

/// 冒烟探针（构建产物 promote 前的启动/回归验证声明）。
#[derive(Debug, Clone, PartialEq)]
pub struct SmokeProbe {
    pub command: String,
    pub args: Vec<String>,
    pub timeout: f64,
    pub expect_exit: i32,
}

impl SmokeProbe {
    pub fn from_json(value: &JsonValue) -> Self {
        Self {
            command: value.get("command").and_then(|v| v.as_str()).unwrap_or("echo").to_string(),
            args: value.get("args").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            timeout: value.get("timeout").and_then(|v| v.as_f64()).unwrap_or(30.0),
            expect_exit: value.get("expect_exit").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
        }
    }
}

/// 冒烟结果（门禁判定依据）。
#[derive(Debug, Clone, PartialEq)]
pub struct SmokeResult {
    pub ok: bool,
    pub output: String,
    pub timed_out: bool,
    pub exit_code: i32,
}

// ── 构建域装配 ──

/// 构建管线域（build.json 数据 + 宿主侧 Builder + 补丁链/部署接线）。
///
/// 构建/冒烟/哈希校验/补丁验证均为宿主侧纯逻辑（经受限进程通道执行
/// 白名单命令）；补丁提案与应用目标经引擎操作通道挂接。Clone 形态供
/// 应用目标回调闭包捕获（'static 跨调用保持，共享登记表状态）。
#[derive(Clone)]
pub struct BuildDomain {
    allowlist: Vec<String>,
    default_timeout: f64,
    artifact_dir: PathBuf,
    default_probe: SmokeProbe,
    deploy: HashMap<String, JsonValue>,
    artifacts: Arc<RwLock<HashMap<String, BuildArtifact>>>,
    declared_tools: Arc<RwLock<HashMap<String, String>>>,
}

impl BuildDomain {
    /// 从 build.json 装载数据（构建白名单/超时/冒烟探针/部署形态声明）。
    pub fn new(build_data: &JsonValue, artifact_dir: PathBuf) -> Result<Self, DomainError> {
        let builder = build_data.get("builder").and_then(|v| v.as_object());
        let allowlist = builder
            .and_then(|b| b.get("allowlist"))
            .map(|v| string_list_from(v))
            .unwrap_or_default();
        let default_timeout = builder
            .and_then(|b| b.get("default_timeout"))
            .and_then(|v| v.as_f64())
            .unwrap_or(120.0);
        let empty_probe = JsonValue::Object(Default::default());
        let probe_cfg = build_data
            .get("smoke_probes")
            .and_then(|v| v.get("default"))
            .unwrap_or(&empty_probe);
        let deploy = build_data
            .get("deploy")
            .filter(|v| v.is_object())
            .and_then(|v| v.as_object())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
            .unwrap_or_default();
        Ok(Self {
            allowlist,
            default_timeout,
            artifact_dir,
            default_probe: SmokeProbe::from_json(probe_cfg),
            deploy,
            artifacts: Arc::new(RwLock::new(HashMap::new())),
            declared_tools: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    /// 构建白名单（数据驱动声明，构建与冒烟共用）。
    pub fn allowlist(&self) -> &[String] {
        &self.allowlist
    }

    /// 缺省冒烟探针（build.json smoke_probes.default）。
    pub fn default_probe(&self) -> &SmokeProbe {
        &self.default_probe
    }

    /// 产物声明构造（命令/产物清单数据驱动；白名单在 build 入口强制）。
    pub fn build_spec(
        &self,
        kind: BuildKind,
        command: &str,
        args: Vec<String>,
        workdir: PathBuf,
        output_paths: Vec<String>,
        meta: HashMap<String, JsonValue>,
    ) -> Result<BuildSpec, BuildError> {
        let spec = BuildSpec {
            kind,
            command: command.to_string(),
            args,
            env: None,
            workdir,
            timeout: self.default_timeout,
            output_paths,
            meta,
        };
        spec.validate()?;
        Ok(spec)
    }

    /// 执行构建（白名单/产物收口/内容寻址；耗时留痕）。
    ///
    /// 构建命令不在白名单 = fail-closed 拒绝（BLD_001）；命令失败/超时/
    /// 产物缺失 = BLD_002（不产出半成品记录）。
    pub async fn build(&self, spec: &BuildSpec) -> Result<BuildArtifact, BuildError> {
        spec.validate()?;
        if !self.allowlist.contains(&spec.command) {
            return Err(BuildError::Whitelist(format!(
                "构建命令不在白名单: {:?}（fail-closed）",
                spec.command
            )));
        }
        let workdir = std::fs::canonicalize(&spec.workdir).unwrap_or_else(|_| spec.workdir.clone());
        if !workdir.is_dir() {
            return Err(BuildError::Failed(format!("构建工作目录不存在: {}", workdir.to_string_lossy())));
        }
        let mut argv = vec![spec.command.clone()];
        argv.extend(spec.args.clone());
        let env = host_path_env();
        let result = run_command(&argv, Some(&workdir), Some(&env), spec.timeout, 100_000, "").await;
        if result.timed_out {
            return Err(BuildError::Failed(format!(
                "构建超时（>{}s）: {} {}",
                spec.timeout,
                spec.command,
                spec.args.join(" ")
            )));
        }
        if result.exit_code != 0 {
            let detail = if result.stderr.is_empty() { &result.stdout } else { &result.stderr };
            return Err(BuildError::Failed(format!(
                "构建失败: exit={} {}",
                result.exit_code,
                truncate_chars(detail, 300)
            )));
        }
        if spec.output_paths.is_empty() {
            return Err(BuildError::Spec("构建声明未指定 output_paths（无产物可收）".to_string()));
        }
        let mut files: HashMap<String, String> = HashMap::new();
        let mut digests: Vec<String> = Vec::new();
        for relative in &spec.output_paths {
            // 产物路径越界防护：拒绝绝对路径与 `..` 片段（声明可来自
            // 补丁链，路径穿越会让构建管线读取并落盘任意文件）
            let rel = Path::new(relative);
            if rel.is_absolute() || rel.components().any(|c| c.as_os_str() == "..") {
                return Err(BuildError::Spec(format!(
                    "产物路径越界（拒绝绝对路径/..）: {relative:?}"
                )));
            }
            let source = workdir.join(rel);
            if !source.is_file() {
                return Err(BuildError::Failed(format!("产物缺失: {relative}")));
            }
            let digest = sha256_file(&source);
            files.insert(relative.clone(), digest.clone());
            digests.push(digest);
        }
        // 内容寻址：产物 id = 类别 + 文件内容哈希前缀（同内容重建 = 同 id，防篡改切换）
        digests.sort();
        let content_hash = sha256_hex(digests.join("").as_bytes());
        let artifact_id = format!("{}-{}", spec.kind.as_str(), &content_hash[..16]);
        let target_dir = self.artifact_dir.join(&artifact_id);
        std::fs::create_dir_all(&target_dir).map_err(|err| {
            BuildError::Failed(format!("产物目录创建失败: {err}"))
        })?;
        for relative in &spec.output_paths {
            let source = workdir.join(relative);
            let dest = target_dir.join(relative);
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            copy_file_retry(&source, &dest).map_err(|err| {
                BuildError::Failed(format!("产物落盘失败: {relative} ({err})"))
            })?;
        }
        let artifact = BuildArtifact {
            artifact_id: artifact_id.clone(),
            kind: spec.kind.as_str().to_string(),
            files,
            built_at: now_epoch(),
            meta: HashMap::from([("spec".to_string(), spec.to_dict())]),
        };
        self.artifacts.write().unwrap().insert(artifact_id, artifact.clone());
        Ok(artifact)
    }

    /// 冒烟门禁（缺省探针 = build.json default；命令须在白名单内）。
    pub async fn smoke(&self, artifact: &BuildArtifact, probe: &SmokeProbe) -> SmokeResult {
        if !self.allowlist.contains(&probe.command) {
            return SmokeResult {
                ok: false,
                output: "冒烟命令不在白名单（fail-closed）".to_string(),
                timed_out: false,
                exit_code: -1,
            };
        }
        let cwd = self.artifact_dir(artifact);
        let mut argv = vec![probe.command.clone()];
        argv.extend(probe.args.clone());
        let env = host_path_env();
        let result = run_command(&argv, Some(&cwd), Some(&env), probe.timeout, 100_000, "").await;
        if result.timed_out {
            return SmokeResult {
                ok: false,
                output: result.stdout,
                timed_out: true,
                exit_code: -1,
            };
        }
        SmokeResult {
            ok: result.exit_code == probe.expect_exit,
            output: result.stdout,
            timed_out: false,
            exit_code: result.exit_code,
        }
    }

    /// 产物目录路径（部署/挂载读取；构建声明的输出对象）。
    pub fn artifact_dir(&self, artifact: &BuildArtifact) -> PathBuf {
        self.artifact_dir.join(&artifact.artifact_id)
    }

    /// 哈希校验（部署/回退前强制门禁）：产物目录内文件与声明一致。
    pub fn verify_hash(&self, artifact: &BuildArtifact, name: &str, digest: &str) -> bool {
        let Some(declared) = artifact.files.get(name) else {
            return false;
        };
        if declared != digest {
            return false;
        }
        let source = self.artifact_dir(artifact).join(name);
        if !source.is_file() {
            return false;
        }
        sha256_file(&source) == digest
    }

    // ── ARTIFACT 补丁链路 ──

    /// ARTIFACT 补丁部署前验证（vetting_l2_hook 挂钩）。
    ///
    /// 验证项（fail-closed）：产物在构建登记内、声明的文件哈希与产物
    /// 目录逐文件一致、冒烟记录为通过（meta.smoke.ok）。非 ARTIFACT
    /// 补丁不在本钩子作用域（放行，交给审批分级）。
    pub fn vet_artifact_patch(&self, proposal_kind: &str, payload: &JsonValue) -> Vec<String> {
        if proposal_kind != "artifact" {
            return Vec::new();
        }
        let artifact_id = payload.get("artifact_id").and_then(|v| v.as_str()).unwrap_or("");
        let artifact = self.artifacts.read().unwrap().get(artifact_id).cloned();
        let Some(artifact) = artifact else {
            return vec!["产物未在构建登记（artifact_id 不存在于本域产物目录）".to_string()];
        };
        let hashes = payload
            .get("hashes")
            .map(|v| {
                v.as_object()
                    .map(|m| m.iter().map(|(k, item)| (k.clone(), item.as_str().unwrap_or("").to_string())).collect::<Vec<_>>())
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        for (name, digest) in &hashes {
            if !self.verify_hash(&artifact, name, digest) {
                return vec![format!(
                    "产物哈希校验未通过: {name}（部署前门禁，fail-closed）"
                )];
            }
        }
        let smoke_ok = payload
            .get("meta")
            .and_then(|v| v.get("smoke"))
            .and_then(|v| v.get("ok"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !smoke_ok {
            return vec!["冒烟记录缺失或未通过（产物不得跳过冒烟门禁 promote）".to_string()];
        }
        Vec::new()
    }

    /// 构建产物 → ARTIFACT 补丁提案数据形态（内容寻址描述 + meta 载荷）。
    ///
    /// `declared_tool` 为产物声明的工具条目（meta.tool 形态，补丁挂载
    /// 引擎的声明依据）；`smoke` 为冒烟记录（promote 门禁的留痕姿态）。
    pub fn artifact_patch_payload(
        &self,
        artifact: &BuildArtifact,
        declared_tool: Option<&JsonValue>,
        smoke: Option<&SmokeResult>,
    ) -> JsonValue {
        let mut meta = serde_json::Map::new();
        meta.insert("built_at".to_string(), JsonValue::from(artifact.built_at));
        meta.insert("kind_label".to_string(), JsonValue::String(artifact.kind.clone()));
        meta.insert(
            "smoke".to_string(),
            serde_json::json!({
                "ok": smoke.map(|s| s.ok).unwrap_or(false),
                "output": smoke.map(|s| truncate_chars(&s.output, 500)).unwrap_or_default(),
            }),
        );
        if let Some(tool) = declared_tool {
            meta.insert("tool".to_string(), tool.clone());
        }
        serde_json::json!({
            "artifact_id": artifact.artifact_id,
            "kind": artifact.kind,
            "hashes": artifact.files.clone(),
            "meta": meta,
        })
    }

    /// 产物容器镜像名（镜像名 = 前缀 + 内容寻址 id，数据形态）。
    pub fn container_image_name(&self, artifact: &BuildArtifact) -> String {
        let prefix = self
            .deploy
            .get("image_prefix")
            .and_then(|v| v.as_str())
            .unwrap_or("inkling/artifact");
        format!("{prefix}:{}", artifact.artifact_id)
    }

    /// 容器部署环境补丁声明（镜像描述 = 数据：name/build_context + 内容
    /// 寻址版本；随 PatchKind.ENVIRONMENT 版本化，回退 = 声明回退）。
    pub fn deployment_env_payload(
        &self,
        artifact: &BuildArtifact,
        env_name: &str,
        command: &str,
    ) -> JsonValue {
        serde_json::json!({
            "name": env_name,
            "runtime": "container",
            "tools": [command],
            "install_cmds": [],
            "version": artifact.artifact_id,
            "meta": {
                "versioned_by_patch_chain": true,
                "image": {
                    "name": self.container_image_name(artifact),
                    "build_context": self.artifact_dir(artifact).to_string_lossy(),
                },
                "artifact_id": artifact.artifact_id,
            },
        })
    }

    /// 产物部署至容器环境（三步走：环境补丁落链 → 提供器 ensure →
    /// 白名单命令容器内运行）。
    ///
    /// 域间不直接互调：环境动作经 [`EnvHost`] 钩子、补丁落链经
    /// [`PatchApplier`] 钩子注入（boot.rs 装配接线；引擎侧操作通道
    /// patch.apply 已注册，环境补丁经 [`super::env`] 的应用目标生效）。
    /// 容器不可用 = 结构化失败（不崩溃不假部署）。
    pub async fn deploy_to_container(
        &self,
        artifact: &BuildArtifact,
        env_name: &str,
        command: &str,
        args: &[String],
        env_host: &dyn EnvHost,
        patch_host: &dyn PatchApplier,
    ) -> JsonValue {
        let image_name = self.container_image_name(artifact);
        let payload = self.deployment_env_payload(artifact, env_name, command);
        let patch_outcome = match patch_host.apply("environment", payload).await {
            Ok(outcome) => outcome,
            Err(err) => {
                return serde_json::json!({
                    "ok": false,
                    "status": "not_assembled",
                    "image_name": image_name,
                    "error": err,
                });
            }
        };
        let patch_id = patch_outcome.get("patch_id").cloned().unwrap_or(JsonValue::Null);
        if patch_outcome.get("applied").and_then(|v| v.as_bool()) != Some(true) {
            return serde_json::json!({
                "ok": false,
                "patch_id": patch_id,
                "status": patch_outcome.get("status").cloned().unwrap_or(JsonValue::String("rejected".into())),
                "image_name": image_name,
                "error": patch_outcome.get("reason").cloned().unwrap_or(JsonValue::String("环境补丁未批准".into())),
            });
        }
        let handle = match env_host.ensure(env_name).await {
            Ok(handle) => handle,
            Err(err) => {
                return serde_json::json!({
                    "ok": false,
                    "patch_id": patch_id,
                    "status": "container_unavailable",
                    "image_name": image_name,
                    "error": err,
                });
            }
        };
        if handle.get("status").and_then(|v| v.as_str()) != Some("ready") {
            return serde_json::json!({
                "ok": false,
                "patch_id": patch_id,
                "status": "container_unavailable",
                "image_name": image_name,
                "error": handle
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("容器环境未就绪"),
            });
        }
        let outcome = match env_host.run(env_name, command, args).await {
            Ok(outcome) => outcome,
            Err(err) => {
                return serde_json::json!({
                    "ok": false,
                    "patch_id": patch_id,
                    "status": "run_failed",
                    "image_name": image_name,
                    "error": err,
                });
            }
        };
        let exit_code = outcome.get("exit_code").and_then(|v| v.as_i64()).unwrap_or(-1);
        if exit_code == 0 {
            serde_json::json!({
                "ok": true,
                "patch_id": patch_id,
                "status": "deployed",
                "image_name": image_name,
                "exit_code": exit_code,
                "output": truncate_chars(
                    outcome.get("stdout").and_then(|v| v.as_str()).unwrap_or(""),
                    500,
                ),
            })
        } else {
            serde_json::json!({
                "ok": false,
                "patch_id": patch_id,
                "status": "run_failed",
                "image_name": image_name,
                "exit_code": exit_code,
                "output": truncate_chars(
                    outcome.get("stdout").and_then(|v| v.as_str()).unwrap_or(""),
                    500,
                ),
                "error": truncate_chars(
                    outcome.get("stderr").and_then(|v| v.as_str()).unwrap_or(""),
                    300,
                ),
            })
        }
    }

    /// 产物声明工具与链同步（回退/重启后：链内注册、链外移除）。
    ///
    /// 补丁链是权威记录：链内产物的声明工具注册进工具表（幂等），此前
    /// 已注册但已不在链内的声明工具移除（回退 = 挂载撤销）。注册经
    /// 引擎操作通道（declarative_register_definition / tool_registry_put）；
    /// 链外移除 = 声明式定义表（declarative_unregister_definition）与
    /// 统一工具表（engine.tool_registry_remove）双表同步移除。
    pub async fn sync_artifact_tools(
        &self,
        artifacts: &HashMap<String, JsonValue>,
    ) -> Result<(), String> {
        let mut in_chain: HashSet<String> = HashSet::new();
        for (artifact_id, payload) in artifacts {
            let Some(tool_json) = payload
                .get("meta")
                .and_then(|v| v.get("tool"))
                .filter(|v| v.is_object())
            else {
                continue;
            };
            let name = tool_json.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            call_engine_op(
                "engine.declarative_register_definition",
                serde_json::json!({ "spec": tool_json }),
            )?;
            call_engine_op("engine.tool_registry_put", serde_json::json!({ "spec": tool_json }))?;
            self.declared_tools
                .write()
                .unwrap()
                .insert(name.to_string(), artifact_id.clone());
            in_chain.insert(name.to_string());
        }
        let stale: Vec<String> = self
            .declared_tools
            .read()
            .unwrap()
            .keys()
            .filter(|name| !in_chain.contains(*name))
            .cloned()
            .collect();
        for name in stale {
            call_engine_op(
                "engine.declarative_unregister_definition",
                serde_json::json!({ "name": name }),
            )?;
            call_engine_op(
                "engine.tool_registry_remove",
                serde_json::json!({ "name": name }),
            )?;
            self.declared_tools.write().unwrap().remove(&name);
        }
        Ok(())
    }

    /// ARTIFACT 补丁落链后的活跃态生效：产物声明工具注册进工具表。
    ///
    /// 补丁链是权威记录（重启经链恢复：宿主 boot 从链组装注册声明工具）；
    /// 本钩子只做当前进程的活跃态同步——产物挂载引擎 = 工具表出现新声明。
    /// 经引擎操作通道（declarative_register_definition / tool_registry_put）。
    pub async fn apply_artifact_payload(&self, payload: &JsonValue) -> Result<(), String> {
        self.apply_artifact_payload_sync(payload)
    }

    /// ARTIFACT 补丁活跃态生效的同步形态（回调桥内同步执行用）。
    fn apply_artifact_payload_sync(&self, payload: &JsonValue) -> Result<(), String> {
        let artifact_id = payload.get("artifact_id").and_then(|v| v.as_str()).unwrap_or("");
        let Some(tool_json) = payload
            .get("meta")
            .and_then(|v| v.get("tool"))
            .filter(|v| v.is_object())
        else {
            return Ok(());
        };
        let name = tool_json.get("name").and_then(|v| v.as_str());
        call_engine_op(
            "engine.declarative_register_definition",
            serde_json::json!({ "spec": tool_json }),
        )?;
        call_engine_op("engine.tool_registry_put", serde_json::json!({ "spec": tool_json }))?;
        if let Some(name) = name {
            self.declared_tools
                .write()
                .unwrap()
                .insert(name.to_string(), artifact_id.to_string());
        }
        Ok(())
    }

    /// ARTIFACT 补丁链自应用目标注册（回调桥 + 目标登记两步）。
    ///
    /// 应用回调（live.artifact_apply）实现 [`Self::apply_artifact_payload`]
    /// 语义——补丁落链时引擎侧回调委托 Rust 侧生效；目标登记经
    /// patch.apply_target_register 挂进补丁链自应用目标注册表
    /// （kind = artifact，callback = live.artifact_apply）。重复注册
    /// 同名 = 覆盖（幂等）。无引擎环境 = 回调桥/运行时未装配的结构化
    /// 错误（fail-closed，不静默假装已注册）。
    pub async fn register_apply_target(&self) -> Result<JsonValue, String> {
        let domain = self.clone();
        crate::engine::bridge::register_callback(
            "live.artifact_apply",
            Box::new(move |payload: String| -> pyo3::PyResult<String> {
                let args: JsonValue = serde_json::from_str(&payload)
                    .map_err(|err| pyo3::exceptions::PyValueError::new_err(err.to_string()))?;
                let patch_payload = args
                    .get("payload")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({}));
                match domain.apply_artifact_payload_sync(&patch_payload) {
                    Ok(()) => Ok(serde_json::json!({ "ok": true }).to_string()),
                    Err(reason) => Ok(serde_json::json!({ "ok": false, "reason": reason }).to_string()),
                }
            }),
        )
        .map_err(|err| format!("产物应用回调注册失败: {err}"))?;
        call_engine_op(
            "patch.apply_target_register",
            serde_json::json!({ "kind": "artifact", "callback": "live.artifact_apply" }),
        )
    }

    /// 活跃产物登记（补丁/部署/校验取用）。
    pub fn artifacts(&self) -> HashMap<String, BuildArtifact> {
        self.artifacts.read().unwrap().clone()
    }

    /// 产物声明工具登记（工具名 → artifact_id；回退同步的移除依据）。
    pub fn declared_tools(&self) -> HashMap<String, String> {
        self.declared_tools.read().unwrap().clone()
    }
}

// ── 域间钩子形态（booot.rs 装配注入；省去跨域直接引用）──

/// 环境动作钩子（ensure/run 的结构化 JSON 形态；域间不直接互调，
/// 装配编排发生在 [`super::boot`]）。
pub trait EnvHost: Send + Sync {
    fn ensure(&self, name: &str) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>>;
    fn run(&self, name: &str, command: &str, args: &[String]) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>>;
}

/// 补丁提案应用钩子（kind + payload → 应用结果 JSON）。
pub trait PatchApplier: Send + Sync {
    fn apply(&self, kind: &str, payload: JsonValue) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>>;
}

// ── 工具函数 ──

fn sha256_file(path: &Path) -> String {
    let mut hasher = sha2::Sha256::new();
    if let Ok(mut handle) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buffer = [0u8; 1 << 20];
        loop {
            match handle.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    hasher.update(&buffer[..read]);
                }
                Err(_) => break,
            }
        }
    }
    shorten_sha256(hasher)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    shorten_sha256(hasher)
}

fn shorten_sha256<D: sha2::digest::Digest>(hasher: D) -> String {
    let digest = hasher.finalize();
    hex::encode(digest)
}

fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.len() <= max {
        text.to_string()
    } else {
        let mut head = text.to_string();
        head.truncate(max);
        head
    }
}

fn string_list_from(value: &JsonValue) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn host_path_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    if let Ok(path) = std::env::var("PATH") {
        env.insert(
            "PATH".to_string(),
            super::common::test_python_prefixed_path(&path),
        );
    }
    env
}

/// 文件拷贝（短重试）：Windows 文件系统扫描/索引器对新落盘文件存在
/// 瞬时独占锁（编译产物场景常见），重试缓解而非一次性失败。
fn copy_file_retry(source: &Path, dest: &Path) -> std::io::Result<()> {
    for attempt in 0..4 {
        match std::fs::copy(source, dest) {
            Ok(_) => return Ok(()),
            Err(err) if attempt < 3 => {
                std::thread::sleep(std::time::Duration::from_millis(50 * (attempt as u64 + 1)));
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkling-build-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn build_workspace(label: &str, fail_build: bool) -> PathBuf {
        let ws = scratch(label);
        if fail_build {
            std::fs::write(ws.join("build_artifact.py"), "raise SystemExit(7)\n").unwrap();
        } else {
            std::fs::write(
                ws.join("build_artifact.py"),
                "from pathlib import Path\nPath('app.py').write_text(\"print('hello artifact')\\n\", encoding='utf-8')\n",
            )
            .unwrap();
        }
        ws
    }

    #[tokio::test]
    async fn test_build_whitelist_passes_content_addressed() {
        let ws = build_workspace("pass", false);
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"], "default_timeout": 60}, "smoke_probes": {"default": {"command": "echo"}}}),
            ws.parent().unwrap().join("artifacts"),
        )
        .unwrap();
        let spec = domain
            .build_spec(BuildKind::Service, "python", vec!["build_artifact.py".to_string()], ws.clone(), vec!["app.py".to_string()], HashMap::new())
            .unwrap();
        let artifact = domain.build(&spec).await.unwrap();
        assert_eq!(artifact.kind, "service");
        assert!(artifact.artifact_id.starts_with("service-"));
        assert!(artifact.files.contains_key("app.py"));
        assert_eq!(artifact.files["app.py"].len(), 64, "sha256 hex 64 字符");
        // 内容寻址：同内容重建 → 同 id（幂等可复现）
        let again = domain.build(&spec).await.unwrap();
        assert_eq!(again.artifact_id, artifact.artifact_id);
        // 产物落盘可读（部署/挂载取用）
        assert!(domain.artifact_dir(&artifact).join("app.py").is_file());
        assert!(domain.verify_hash(&artifact, "app.py", &artifact.files["app.py"]));
    }

    #[tokio::test]
    async fn test_build_non_whitelist_rejected() {
        let ws = build_workspace("reject", false);
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"], "default_timeout": 60}}),
            ws.parent().unwrap().join("artifacts"),
        )
        .unwrap();
        let spec = domain
            .build_spec(BuildKind::Service, "curl", vec!["http://evil.example".to_string()], ws.clone(), vec!["app.py".to_string()], HashMap::new())
            .unwrap();
        let err = domain.build(&spec).await.unwrap_err();
        assert!(err.to_string().contains("白名单"));
        assert_eq!(domain.artifacts().len(), 0, "无半成品记录");
    }

    #[tokio::test]
    async fn test_build_failure_structured_no_artifact() {
        let ws = build_workspace("fail", true);
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"], "default_timeout": 60}}),
            ws.parent().unwrap().join("artifacts"),
        )
        .unwrap();
        let spec = domain
            .build_spec(BuildKind::Service, "python", vec!["build_artifact.py".to_string()], ws.clone(), vec!["app.py".to_string()], HashMap::new())
            .unwrap();
        let err = domain.build(&spec).await.unwrap_err();
        assert!(err.to_string().contains("构建失败"));
        assert_eq!(domain.artifacts().len(), 0);
    }

    #[tokio::test]
    async fn test_smoke_gate_pass_and_fail() {
        let ws = build_workspace("smoke", false);
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"], "default_timeout": 60}}),
            ws.parent().unwrap().join("artifacts"),
        )
        .unwrap();
        let spec = domain
            .build_spec(BuildKind::Service, "python", vec!["build_artifact.py".to_string()], ws.clone(), vec!["app.py".to_string()], HashMap::new())
            .unwrap();
        let artifact = domain.build(&spec).await.unwrap();
        let ok_probe = SmokeProbe { command: "python".to_string(), args: vec!["app.py".to_string()], timeout: 30.0, expect_exit: 0 };
        let result = domain.smoke(&artifact, &ok_probe).await;
        assert!(result.ok);
        assert!(result.output.contains("hello artifact"));

        let fail_probe = SmokeProbe { command: "python".to_string(), args: vec!["app.py".to_string()], timeout: 30.0, expect_exit: 1 };
        let failed = domain.smoke(&artifact, &fail_probe).await;
        assert!(!failed.ok);

        let rogue_probe = SmokeProbe { command: "curl".to_string(), args: vec![], timeout: 30.0, expect_exit: 0 };
        let rogue = domain.smoke(&artifact, &rogue_probe).await;
        assert!(!rogue.ok);
        assert!(rogue.output.contains("白名单"));
    }

    #[tokio::test]
    async fn test_artifact_vetting_hook_fail_closed() {
        let ws = build_workspace("vetting", false);
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"], "default_timeout": 60}}),
            ws.parent().unwrap().join("artifacts"),
        )
        .unwrap();
        let spec = domain
            .build_spec(BuildKind::Service, "python", vec!["build_artifact.py".to_string()], ws.clone(), vec!["app.py".to_string()], HashMap::new())
            .unwrap();
        let artifact = domain.build(&spec).await.unwrap();
        let smoke_probe = SmokeProbe { command: "python".to_string(), args: vec!["app.py".to_string()], timeout: 30.0, expect_exit: 0 };
        let smoke = domain.smoke(&artifact, &smoke_probe).await;
        assert!(smoke.ok, "冒烟探针应通过");
        let payload = domain.artifact_patch_payload(&artifact, Some(&json!({"name": "artifact_tool"})), Some(&smoke));

        // 非 ARTIFACT 补丁：超出本钩子作用域（放行）
        assert!(domain.vet_artifact_patch("environment", &payload).is_empty());
        // 记录齐全 + 冒烟通过 = 放行
        assert!(domain.vet_artifact_patch("artifact", &payload).is_empty());

        // 篡改哈希声明（模拟声明漂移）→ 部署前验证拒绝
        let mut tampered = payload.clone();
        tampered["hashes"] = json!({"app.py": "0".repeat(64)});
        let violations = domain.vet_artifact_patch("artifact", &tampered);
        assert_eq!(violations.len(), 1);
        assert!(violations[0].contains("哈希"));

        // 未登记产物 → 拒绝
        let mut ghost = payload.clone();
        ghost["artifact_id"] = json!("service-unknown");
        assert!(domain.vet_artifact_patch("artifact", &ghost)[0].contains("构建登记"));

        // 冒烟记录缺失/未通过 → 拒绝 promote
        let mut unsmoked = payload.clone();
        unsmoked["meta"] = json!({"smoke": {"ok": false, "output": ""}});
        let smoke_violation = domain.vet_artifact_patch("artifact", &unsmoked);
        assert!(smoke_violation[0].contains("冒烟"));
    }

    #[test]
    fn test_payload_shapes_artifact_and_deployment() {
        let ws = scratch("payloads");
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"]}, "deploy": {"image_prefix": "inkling/artifact"}}),
            ws.clone(),
        )
        .unwrap();
        let artifact = BuildArtifact {
            artifact_id: "service-abcdef1234567890".to_string(),
            kind: "service".to_string(),
            files: HashMap::from([("app.py".to_string(), "d".repeat(64))]),
            built_at: 1234.5,
            meta: HashMap::new(),
        };
        let payload = domain.artifact_patch_payload(&artifact, Some(&json!({"name": "artifact_tool"})), None);
        assert_eq!(payload["artifact_id"], "service-abcdef1234567890");
        assert_eq!(payload["meta"]["tool"]["name"], "artifact_tool");
        assert_eq!(payload["meta"]["smoke"]["ok"], false, "无冒烟记录 = 不通过");

        let dep = domain.deployment_env_payload(&artifact, "inkling.deploy.e2e", "python");
        assert_eq!(dep["runtime"], "container");
        assert_eq!(dep["version"], "service-abcdef1234567890");
        assert_eq!(dep["meta"]["image"]["name"], "inkling/artifact:service-abcdef1234567890");
        assert_eq!(dep["meta"]["versioned_by_patch_chain"], true);
        assert_eq!(domain.container_image_name(&artifact), "inkling/artifact:service-abcdef1234567890");
    }

    struct FakeEnv {
        ensure_status: &'static str,
        ensure_error: Option<String>,
        exit_code: i32,
        stdout: &'static str,
        stderr: &'static str,
    }

    impl EnvHost for FakeEnv {
        fn ensure(&self, _name: &str) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>> {
            let status = self.ensure_status;
            let error = self.ensure_error.clone();
            Box::pin(async move {
                if let Some(error) = error {
                    Ok(json!({"status": status, "error": error}))
                } else {
                    Ok(json!({"status": status}))
                }
            })
        }

        fn run(&self, _name: &str, _command: &str, _args: &[String]) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>> {
            let exit_code = self.exit_code;
            let stdout = self.stdout;
            let stderr = self.stderr;
            Box::pin(async move {
                Ok(json!({"exit_code": exit_code, "stdout": stdout, "stderr": stderr}))
            })
        }
    }

    struct FakePatch {
        applied: bool,
        status: &'static str,
    }

    impl PatchApplier for FakePatch {
        fn apply(&self, _kind: &str, _payload: JsonValue) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>> {
            let applied = self.applied;
            let status = self.status;
            Box::pin(async move {
                Ok(json!({"applied": applied, "status": status, "patch_id": 42}))
            })
        }
    }

    #[tokio::test]
    async fn test_deploy_to_container_flow_and_degrades() {
        let ws = scratch("deploy");
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"]}, "deploy": {"image_prefix": "inkling/artifact"}}),
            ws.clone(),
        )
        .unwrap();
        let artifact = BuildArtifact {
            artifact_id: "service-deadbeef12345678".to_string(),
            kind: "service".to_string(),
            files: HashMap::from([("app.py".to_string(), "d".repeat(64))]),
            built_at: 1.0,
            meta: HashMap::new(),
        };
        // 容器环境未就绪（结构化降级：不崩溃不假部署）
        let degraded = domain
            .deploy_to_container(
                &artifact,
                "inkling.deploy.e2e",
                "python",
                &["app.py".to_string()],
                &FakeEnv { ensure_status: "failed", ensure_error: Some("容器形态不可用: Docker 守护进程不可达".to_string()), exit_code: -1, stdout: "", stderr: "" },
                &FakePatch { applied: true, status: "applied" },
            )
            .await;
        assert_eq!(degraded["ok"], false);
        assert_eq!(degraded["status"], "container_unavailable");

        // 补丁被拒（审批否决/链拒绝）→ 不进入部署
        let rejected = domain
            .deploy_to_container(
                &artifact,
                "inkling.deploy.e2e",
                "python",
                &[],
                &FakeEnv { ensure_status: "ready", ensure_error: None, exit_code: 0, stdout: "ok", stderr: "" },
                &FakePatch { applied: false, status: "rejected" },
            )
            .await;
        assert_eq!(rejected["ok"], false);
        assert!(rejected["error"].as_str().is_some());

        // 全链路：补丁落链 → 环境就绪 → 容器内运行成功
        let deployed = domain
            .deploy_to_container(
                &artifact,
                "inkling.deploy.e2e",
                "python",
                &["app.py".to_string()],
                &FakeEnv { ensure_status: "ready", ensure_error: None, exit_code: 0, stdout: "容器闭环", stderr: "" },
                &FakePatch { applied: true, status: "applied" },
            )
            .await;
        assert_eq!(deployed["ok"], true);
        assert_eq!(deployed["status"], "deployed");
        assert_eq!(deployed["patch_id"], 42);
        assert_eq!(deployed["image_name"], "inkling/artifact:service-deadbeef12345678");
        assert_eq!(deployed["output"], "容器闭环");

        // 运行失败（退出码非 0）
        let run_failed = domain
            .deploy_to_container(
                &artifact,
                "inkling.deploy.e2e",
                "python",
                &["app.py".to_string()],
                &FakeEnv { ensure_status: "ready", ensure_error: None, exit_code: 7, stdout: "", stderr: "崩溃了" },
                &FakePatch { applied: true, status: "applied" },
            )
            .await;
        assert_eq!(run_failed["ok"], false);
        assert_eq!(run_failed["status"], "run_failed");
        assert_eq!(run_failed["error"], "崩溃了");
    }

    #[test]
    fn build_spec_validation_guards() {
        let domain = BuildDomain::new(&json!({"builder": {"allowlist": ["python"]}}), PathBuf::from(".")).unwrap();
        assert!(domain
            .build_spec(BuildKind::Service, "", vec![], PathBuf::from("."), vec!["a".to_string()], HashMap::new())
            .is_err());
        let bad_path = domain.build_spec(BuildKind::Service, "python", vec![], PathBuf::from("."), vec!["".to_string()], HashMap::new());
        assert!(bad_path.is_err());
    }

    #[test]
    fn register_apply_target_fails_closed_without_engine() {
        // 无引擎环境（回调桥/运行时未装配）：回调注册或目标登记结构化
        // 失败，不返回占位文案、不静默假装已注册
        let _serial = crate::engine::host::bridge_guard();
        let ws = scratch("apply-target");
        let _keep = Scratch(ws.clone());
        let domain = BuildDomain::new(
            &json!({"builder": {"allowlist": ["python"]}}),
            ws.join("artifacts"),
        )
        .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(domain.register_apply_target());
        assert!(err.is_err());
        assert!(!err.unwrap_err().contains("需 op"));
    }
}

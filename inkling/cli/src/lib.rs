//! InKling headless 驱动层：把桌面壳已具备的引擎能力（装配 / 回合 / op 通道 /
//! 记录读取）收束为可被外部程序调用的薄包装。
//!
//! 设计取向是「薄」：不重写引擎逻辑，只复用 inkling_shell_lib 暴露的
//! `EngineHost` 装配入口与 `call_engine_op` 操作通道，把调用结果装进统一的
//! JSON 信封（ok / error 结构化，fail-closed）。op 通道按同步 / 异步双注册
//! 表存在，本层以「先同步后异步」的回落策略覆盖两类 op，与既有调用约定一致。

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use inkling_shell_lib::engine::host::{
    call_engine_op, call_engine_op_async, BootOptions, EngineHost, PathAssemblyFlags,
    RoundRequest,
};

/// 派生仓库根：CLI crate 位于 `<repo>/inkling/cli`，正常上两级即仓库根
/// （含 `inkling/`、`ink_engine/` 与 `.venv`）。
///
/// 在 git worktree 下 crate 实际落位于 `<main>/.kilo/worktrees/<name>/inkling/cli`，
/// 而 Python 虚拟环境（含 `mcp` 等引擎依赖）只存在于主仓库根的 `.venv`；
/// 引擎装配按 `repo_root/.venv/Lib/site-packages` 注入 site-packages，故仓库根必须
/// 定位到「既含 `ink_engine` 又含 `.venv`」那一层（向上回溯直至命中，未命中则回落两级）。
pub fn repo_root_default() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut dir = manifest.as_path();
    loop {
        if dir.join("ink_engine").is_dir() && dir.join(".venv").is_dir() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => break,
        }
    }
    let fallback = manifest.join("../..");
    std::fs::canonicalize(&fallback).unwrap_or(fallback)
}

/// 装配引擎宿主：复用桌面壳的装配链路（行为准则层注入 + 路径装配七块全开），
/// 离线模型桩保证回合可在无真实模型下稳定抵达回复态。
///
/// 返回值在调用方持有期间维持运行时绑定（op 通道依赖该绑定），用毕应 `stop`。
pub fn boot_engine(repo_root: &Path, data_dir: &Path) -> Result<EngineHost, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|err| format!("数据目录创建失败 {}: {err}", data_dir.display()))?;
    let options = BootOptions {
        repo_root: repo_root.to_path_buf(),
        storage_uri: format!("sqlite:///{}", data_dir.join("inkling.sqlite").display()),
        data_dir: Some(data_dir.to_path_buf()),
        stub_script: Some(json!({
            "任务": {"reply": "（headless 回合已执行）"},
            "研究": {"reply": "（headless 研究回合已执行）"},
        })),
        default_reply: "（headless 回合已执行）".to_string(),
        path_assembly: PathAssemblyFlags {
            contract_enabled: true,
            edge_evidence_enabled: true,
            settle_hooks_enabled: true,
            pool_governance_enabled: true,
            assembler_enabled: true,
            multipath_enabled: true,
            fingerprint_cache_enabled: true,
        },
        safe_mode: false,
        bundled: false,
        embedder_model_dir: None,
    };
    EngineHost::boot(options)
}

/// 同步驱动异步引擎操作：当前线程内单运行时完成（与引擎线程亲和纪律一致）。
fn block_on_op_async(op: &str, args: Value) -> Result<Value, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("操作运行时创建失败: {err}"))?
        .block_on(call_engine_op_async(op, args))
}

/// 经 op 通道调用引擎操作：先试同步表，未命中再回落异步表。
///
/// 同步 / 异步 op 分属两张注册表，单路径无法覆盖全部 op；以同步注册表
/// 的「未注册」报错为信号切换异步，其余错误如实透传。
pub fn dispatch_op(op: &str, args: Value) -> Result<Value, String> {
    match call_engine_op(op, args.clone()) {
        Ok(value) => Ok(value),
        Err(err) if err.contains("未注册的同步引擎操作") => block_on_op_async(op, args),
        Err(err) => Err(err),
    }
}

/// 发起一次回合：装配 → 驱动 → 取事件流，归并为可断言的 JSON。
pub fn run_round(
    repo_root: &Path,
    data_dir: &Path,
    task: &str,
    trace_id: &str,
) -> Result<Value, String> {
    let host = boot_engine(repo_root, data_dir)?;
    let outcome = host
        .round(RoundRequest {
            input_text: task.to_string(),
            thread_id: format!("hl-{trace_id}"),
            round_id: format!("hlr-{trace_id}"),
            step_args: None,
            orchestrate: None,
            inject: None,
            auto_accept_review: true,
        })
        .map_err(|err| format!("回合驱动失败: {err}"))?;
    let _ = host.stop();
    Ok(json!({
        "reason": outcome.reason,
        "output": outcome.output,
        "event_count": outcome.events.len(),
        "events": outcome.events,
    }))
}

/// 单 op 调用：装配后透传参数到 op 通道，回传引擎原始结果。
pub fn run_op(
    repo_root: &Path,
    data_dir: &Path,
    op: &str,
    args_json: &str,
    _trace_id: &str,
) -> Result<Value, String> {
    let _host = boot_engine(repo_root, data_dir)?;
    let args: Value = serde_json::from_str(args_json)
        .map_err(|err| format!("op 参数 JSON 解析失败: {err}"))?;
    dispatch_op(op, args)
}

/// 审计导出：读取 `set_audit` 记录集合（引擎侧失败点 / 成本 / 提案经
/// 结算钩子落写的 append-only 审计）。
pub fn run_audit(
    repo_root: &Path,
    data_dir: &Path,
    action: &str,
    _trace_id: &str,
) -> Result<Value, String> {
    if action != "export" {
        return Err(format!("不支持的审计动作: {action}（仅 export）"));
    }
    let _host = boot_engine(repo_root, data_dir)?;
    dispatch_op("engine.records_list", json!({ "collection": "set_audit" }))
}

/// 结构化错误种类（对应信封 error.kind）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Boot,
    Op,
    Parse,
    Usage,
}

/// 统一 JSON 信封（ok / error 结构化，fail-closed）。
#[derive(Serialize)]
pub struct Envelope<'a> {
    pub ok: bool,
    pub trace_id: &'a str,
    pub command: &'a str,
    pub data: Option<Value>,
    pub error: Option<EnvelopeError<'a>>,
}

#[derive(Serialize)]
pub struct EnvelopeError<'a> {
    pub kind: &'a str,
    pub message: String,
}

//! InKling headless 驱动层：把桌面壳已具备的引擎能力（装配 / 回合 / op 通道 /
//! 记录读取）收束为可被外部程序调用的薄包装。
//!
//! 设计取向是「薄」：不重写引擎逻辑，只复用 inkling_shell_lib 暴露的
//! `EngineHost` 装配入口与 `call_engine_op` 操作通道，把调用结果装进统一的
//! JSON 信封（ok / error 结构化，fail-closed）。op 通道按同步 / 异步双注册
//! 表存在，本层以「先同步后异步」的回落策略覆盖两类 op，与既有调用约定一致。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use inkling_shell_lib::engine::host::{
    call_engine_op, call_engine_op_async, BootOptions, EngineHost, PathAssemblyFlags,
    RoundRequest,
};
use inkling_shell_lib::executors::{
    build_registry_from_declarations, load_tool_declarations, Authorization, PlatformBackend,
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

/// 装配引擎宿主：复用桌面壳的装配链路（行为准则层注入 + 路径装配七块全开）。
///
/// 模型接线：环境变量 INK_LLM_BASE_URL + INK_LLM_MODEL（可选
/// INK_LLM_API_KEY / INK_LLM_ADAPTER，与 inkling_host 同口径）配置时
/// 装配真实模型（headless 真实模型驱动入口）；未配置 = 离线模型桩，
/// 保证回合可在无真实模型下稳定抵达回复态。
///
/// 回合接线：装配后注册 os.dispatch 回调（引擎回合内 OS 工具调用转发到
/// 本进程执行器注册表，PlatformBackend 真实执行）并以仓库根授权工作区
/// （文件工具沙箱根，agent 可在仓库内读写）。headless 无审批交互面，
/// 授权语义由调用方显式声明（等同 CLI --approve）。
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
    let host = EngineHost::boot(options)?;
    wire_round_execution(repo_root)?;
    Ok(host)
}

/// headless 回合执行接线：os.dispatch 回调 + 工作区授权（幂等，可重复调用）。
///
/// - os.dispatch：引擎回合内 OS 工具（run_typecheck/run_test_web 等）经回调
///   桥转发到本进程执行器注册表（PlatformBackend 真实子进程执行）；
/// - workspace：以仓库根授权文件工具沙箱（agent 回合内读写仓库文件的
///   前置条件）；记录落 sqlite，重启后经引擎 load 恢复同一根。
fn wire_round_execution(repo_root: &Path) -> Result<(), String> {
    inkling_shell_lib::executors::register_headless_os_dispatch(TOOLS_DECL_JSON)?;
    let auth = dispatch_op(
        "workspace.authorize_headless",
        json!({ "root": repo_root.display().to_string() }),
    )?;
    if auth.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(format!("工作区授权失败: {auth}"));
    }
    Ok(())
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

/// 截断长文本（诊断行防护，避免整段文件内容刷屏）。
fn truncate(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// 回合内事件实时进度行（走 stderr 诊断通道，stdout 信封形态不变）。
///
/// - `reply_token` / `plan_token`：模型输出原样流式打印（实时可见 LLM 生成）；
/// - `tool_start`：工具名 + 截断参数（回合内自主调工具留痕）；
/// - 其余事件：类型 + 截断载荷摘要。
fn live_progress(event_json: &str) {
    let Ok(value) = serde_json::from_str::<Value>(event_json) else {
        eprintln!("[round] {}", truncate(event_json, 120));
        return;
    };
    let etype = value.get("type").and_then(Value::as_str).unwrap_or("?");
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    match etype {
        "reply_token" | "plan_token" => {
            if let Some(token) = payload
                .get("token")
                .or_else(|| payload.get("content"))
                .and_then(Value::as_str)
            {
                if !token.is_empty() {
                    eprint!("{token}");
                }
            }
        }
        "tool_start" => {
            let tool = payload.get("tool").and_then(Value::as_str).unwrap_or("?");
            let args = payload
                .get("args")
                .map(Value::to_string)
                .unwrap_or_default();
            eprintln!();
            eprintln!("[round] →tool {tool} args={}", truncate(&args, 120));
        }
        _ => {
            eprintln!();
            eprintln!(
                "[round] {etype} {}",
                truncate(&payload.to_string(), 150)
            );
        }
    }
}

/// 发起一次回合：装配 → 驱动 → 取事件流，归并为可断言的 JSON。
///
/// 装配后挂实时事件发射钩子：回合内事件到达即经 `live_progress` 打 stderr
/// 诊断行（模型流式输出 / 工具调用留痕），便于长回合观察；stdout 仍只出
/// 最终信封，驱动脚本解析形态不变。
pub fn run_round(
    repo_root: &Path,
    data_dir: &Path,
    task: &str,
    trace_id: &str,
) -> Result<Value, String> {
    let host = boot_engine(repo_root, data_dir)?;
    host.set_event_emitter(Some(Box::new(|event_json: &str| {
        live_progress(event_json);
    })));
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

/// OS 工具声明（桌面壳的运行期夹具，单一事实源；本层只读、不复制签名）。
const TOOLS_DECL_JSON: &str = include_str!("../../shell/src-tauri/fixtures/tools_os.json");

/// 单 OS 操作调用：声明驱动注册表 + 平台后端，绕开 GUI 但不绕开守卫。
///
/// 与桌面壳 `process_exec` / `device_mcp_call` 命令同一套执行器与守卫
/// （声明 ↔ 签名一致性校验 → 权限档 → 沙箱 → 后端副作用）；差异只在
/// 授权来源：壳内由引擎审批层判定后传 `approved`，headless 形态下由调用方
/// 显式 `--approve` 声明「已获授权」，缺省 false 即 review 档 fail-closed。
/// 引擎不装配（OS 操作不经引擎 op 通道），故本路径无 Python 依赖。
pub fn run_os_op(op: &str, args_json: &str, approved: bool) -> Result<Value, String> {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON)
        .map_err(|err| format!("工具声明解析失败: {err}"))?;
    let registry = build_registry_from_declarations(&declarations)
        .map_err(|err| format!("执行器注册契约校验失败: {err}"))?;
    let args: Value = serde_json::from_str(args_json)
        .map_err(|err| format!("os op 参数 JSON 解析失败: {err}"))?;
    let args_map: BTreeMap<String, Value> = args
        .as_object()
        .cloned()
        .ok_or_else(|| format!("os op 参数须为对象: {op}"))?
        .into_iter()
        .collect();
    let backend = PlatformBackend;
    let auth = Authorization { approved };
    let outcome = registry
        .run(op, &args_map, &backend, &auth)
        .map_err(|err| err.to_string())?;
    Ok(json!({
        "tool": op,
        "result": outcome.result,
        "sandbox": outcome.sandbox_checked,
    }))
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

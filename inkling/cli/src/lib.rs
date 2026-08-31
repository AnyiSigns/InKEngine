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
    build_registry_from_declarations, load_tool_declarations, Authorization, CallGate,
    PlatformBackend,
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

/// sqlite 存储 URI（C3 防御性规范化单一构造点）：Windows 反斜杠转正斜杠、
/// URI 路径特殊字符百分号编码，杜绝 `sqlite:///C:\Users\...` 反斜杠形态。
/// 引擎侧 storage.py 对反斜杠同样 replace 兜底（双端收敛）；本函数保证
/// URI 层形态合法。注：引擎侧以字面路径消费（aiosqlite 不反解 URI），
/// 编码仅服务 URI 层解析正确性——ASCII 常规路径（无空格/非 ASCII）零变化。
fn sqlite_uri(data_dir: &Path) -> String {
    let db_path = data_dir.join("inkling.sqlite");
    let normalized = db_path.to_string_lossy().replace('\\', "/");
    format!("sqlite:///{}", percent_encode_path(&normalized))
}

/// 路径段百分号编码：保留 RFC 3986 unreserved + `/` + `:`（盘符冒号），
/// 其余字节（空格、`#`/`?`/`%`、非 ASCII、控制字符）百分号编码。
fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'.'
            | b'_'
            | b'~'
            | b'/'
            | b':' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 装配引擎宿主：复用桌面壳的装配链路（行为准则层注入 + 路径装配七块全开）。
///
/// 模型接线：环境变量 INK_LLM_BASE_URL + INK_LLM_MODEL + INK_LLM_API_KEY
/// （与 inkling_host 同口径；本地无鉴权端点（Ollama/vLLM 类）也须设占位
/// key，H6 门禁三要素齐备才走真实模型）配置时装配真实模型（headless
/// 真实模型驱动入口）；未配置 = 离线模型桩，保证回合可在无真实模型下
/// 稳定抵达回复态。
///
/// 回合接线：装配后注册 os.dispatch 回调（引擎回合内 OS 工具调用转发到
/// 本进程执行器注册表，PlatformBackend 真实执行）并以工作区根授权文件
/// 工具沙箱（默认仓库根，可用 INKENGINE_WS_ROOT 覆盖到仓库外工作目录）。
/// headless 无审批交互面，授权语义由调用方显式声明（等同 CLI --approve）。
///
/// 返回值在调用方持有期间维持运行时绑定（op 通道依赖该绑定），用毕应 `stop`。
pub fn boot_engine(repo_root: &Path, data_dir: &Path) -> Result<EngineHost, CliError> {
    std::fs::create_dir_all(data_dir).map_err(|err| {
        CliError::boot(format!("数据目录创建失败 {}: {err}", data_dir.display()))
    })?;
    let options = BootOptions {
        repo_root: repo_root.to_path_buf(),
        storage_uri: sqlite_uri(data_dir),
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
        tool_provider: None,
    };
    let host = EngineHost::boot(options).map_err(CliError::boot)?;
    wire_round_execution(repo_root)?;
    Ok(host)
}

/// headless 回合执行接线：os.dispatch 回调 + 工作区授权（幂等，可重复调用）。
///
/// - os.dispatch：引擎回合内 OS 工具（shell_exec/launch_app 等）经回调
///   桥转发到本进程执行器注册表（PlatformBackend 真实子进程执行）；
/// - workspace：以工作区根授权文件工具沙箱（agent 回合内读写工作区文件的
///   前置条件）；根默认取仓库根，可用环境变量 `INKENGINE_WS_ROOT` 覆盖
///   （挂载到仓库外的工作目录，如实验工作点）；记录落 sqlite，重启后经
///   引擎 load 恢复同一根。
fn wire_round_execution(repo_root: &Path) -> Result<(), CliError> {
    inkling_shell_lib::executors::register_headless_os_dispatch(TOOLS_DECL_JSON)
        .map_err(|err| CliError::boot(format!("OS 分发注册失败: {err}")))?;
    let workspace_root = std::env::var("INKENGINE_WS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| repo_root.to_path_buf());
    let auth = dispatch_op(
        "workspace.authorize_headless",
        json!({ "root": workspace_root.display().to_string() }),
    )
    .map_err(|err| {
        if is_bridge_not_ready(&err) {
            // C13：authorize_headless 依赖 boot 装配时序（workspace 授权器
            // 就绪后才可调）；桥未就绪 = 可判别 NotBooted，而非笼统授权失败。
            CliError::not_booted(format!(
                "引擎桥未就绪（authorize_headless 依赖 boot 时序）: {err}"
            ))
        } else {
            CliError::boot(format!("工作区授权失败: {err}"))
        }
    })?;
    if auth.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(CliError::boot(format!("工作区授权失败: {auth}")));
    }
    Ok(())
}

/// C13：引擎桥未就绪判别（authorize_headless 的前置条件未满足时的
/// 引擎侧错误标记；未就绪 = NotBooted 错误，与授权失败可判别）。
fn is_bridge_not_ready(error: &str) -> bool {
    error.contains("工作区授权器未装配")
        || error.contains("引擎未装配")
        || error.contains("未注册的异步引擎操作")
}

/// 同步驱动异步引擎操作：当前线程内单运行时完成（与引擎线程亲和纪律一致）。
fn block_on_op_async(op: &str, args: Value) -> Result<Value, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| format!("操作运行时创建失败: {err}"))?
        .block_on(call_engine_op_async(op, args))
}

/// 同步 op 未注册哨兵判别（C6：引擎错误码判别的唯一收口点）。
///
/// 同步 / 异步 op 分属两张注册表，同步未命中即回落异步表；判据为引擎
/// 侧错误信封 `code=ENGINE_OP_UNREGISTERED`（host.rs parse_op_result
/// 将 bridge 结构化 `unregistered_op` 映射为该码），兼容旧文案过渡。
fn is_unregistered_sync_op(error: &str) -> bool {
    error.contains("ENGINE_OP_UNREGISTERED") || error.contains("未注册的同步引擎操作")
}

/// 经 op 通道调用引擎操作：先试同步表，未命中再回落异步表。
///
/// 同步 / 异步 op 分属两张注册表，单路径无法覆盖全部 op；以同步注册表
/// 的「未注册」报错为信号切换异步，其余错误如实透传。
pub fn dispatch_op(op: &str, args: Value) -> Result<Value, String> {
    match call_engine_op(op, args.clone()) {
        Ok(value) => Ok(value),
        Err(err) if is_unregistered_sync_op(&err) => block_on_op_async(op, args),
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
    thread_id: Option<String>,
    round_id: Option<String>,
    step_args: Option<&str>,
) -> Result<Value, CliError> {
    let host = boot_engine(repo_root, data_dir)?;
    host.set_event_emitter(Some(Box::new(|event_json: &str| {
        live_progress(event_json);
    })));
    let parsed_step_args: Option<serde_json::Value> = match step_args {
        Some(text) if !text.trim().is_empty() => Some(
            serde_json::from_str(text)
                .map_err(|err| CliError::usage(format!("--step-args JSON 解析失败: {err}")))?,
        ),
        _ => None,
    };
    let outcome = host
        .round(RoundRequest {
            input_text: task.to_string(),
            thread_id: thread_id.unwrap_or_else(|| format!("hl-{trace_id}")),
            round_id: round_id.unwrap_or_else(|| format!("hlr-{trace_id}")),
            step_args: parsed_step_args,
            orchestrate: None,
            inject: None,
            model: None,
            auto_accept_review: true,
        })
        .map_err(|err| CliError::boot(format!("回合驱动失败: {err}")))?;
    let _ = host.stop();
    Ok(json!({
        "reason": outcome.reason,
        "output": outcome.output,
        "event_count": outcome.events.len(),
        "events": outcome.events,
    }))
}

/// C5：宿主 Drop 守卫——`run_op`/`run_audit` 返回前确保 `host.stop()`
/// （引擎运行时 / 桥接 / SQLite 资源释放），错误路径同样不泄漏。
struct HostGuard(Option<EngineHost>);

impl Drop for HostGuard {
    fn drop(&mut self) {
        if let Some(host) = self.0.take() {
            let _ = host.stop();
        }
    }
}

/// 单 op 调用：装配后透传参数到 op 通道，回传引擎原始结果。
pub fn run_op(
    repo_root: &Path,
    data_dir: &Path,
    op: &str,
    args_json: &str,
    _trace_id: &str,
) -> Result<Value, CliError> {
    let _guard = HostGuard(Some(boot_engine(repo_root, data_dir)?));
    let args: Value = serde_json::from_str(args_json)
        .map_err(|err| CliError::parse(format!("op 参数 JSON 解析失败: {err}")))?;
    dispatch_op(op, args).map_err(CliError::op)
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
pub fn run_os_op(op: &str, args_json: &str, approved: bool) -> Result<Value, CliError> {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON)
        .map_err(|err| CliError::os_op(format!("工具声明解析失败: {err}")))?;
    let registry = build_registry_from_declarations(&declarations)
        .map_err(|err| CliError::os_op(format!("执行器注册契约校验失败: {err}")))?;
    let args: Value = serde_json::from_str(args_json)
        .map_err(|err| CliError::os_op(format!("os op 参数 JSON 解析失败: {err}")))?;
    let args_map: BTreeMap<String, Value> = args
        .as_object()
        .cloned()
        .ok_or_else(|| CliError::os_op(format!("os op 参数须为对象: {op}")))?
        .into_iter()
        .collect();
    // L7 端点闸门（executors/registry.rs `run` 契约）：调用闸门端点须与
    // 工具声明端点一致，否则沙箱级拒绝——headless 直调按工具自身声明的
    // 端点构造闸门（process_exec 与 device_mcp 两族工具均可驱动）。
    let gate = match registry.get(op) {
        Some(exec) => CallGate::new(exec.spec().endpoint),
        None => {
            return Err(CliError::os_op(format!("未知 OS 工具: {op}")));
        }
    };
    let backend = PlatformBackend;
    let auth = Authorization { approved };
    let outcome = registry
        .run(op, &args_map, &backend, &auth, &gate)
        .map_err(|err| CliError::os_op(err.to_string()))?;
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
) -> Result<Value, CliError> {
    if action != "export" {
        return Err(CliError::usage(format!(
            "不支持的审计动作: {action}（仅 export）"
        )));
    }
    let _guard = HostGuard(Some(boot_engine(repo_root, data_dir)?));
    dispatch_op("engine.records_list", json!({ "collection": "set_audit" })).map_err(CliError::op)
}

/// 结构化错误种类（对应信封 error.kind）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    Boot,
    Op,
    OsOp,
    Parse,
    Usage,
    NotBooted,
}

/// ErrorKind → 信封 kind 字面（单一映射，主入口与诊断共用）。
pub fn kind_str(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Boot => "boot",
        ErrorKind::Op => "op",
        ErrorKind::OsOp => "os_op",
        ErrorKind::Parse => "parse",
        ErrorKind::Usage => "usage",
        ErrorKind::NotBooted => "not_booted",
    }
}

/// 可判别驱动错误（携带 kind；主入口映射为信封 error.kind）。
#[derive(Debug)]
pub struct CliError {
    pub kind: ErrorKind,
    pub message: String,
}

impl CliError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn boot(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::Boot, message.to_string())
    }

    pub fn op(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::Op, message.to_string())
    }

    pub fn os_op(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::OsOp, message.to_string())
    }

    pub fn parse(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::Parse, message.to_string())
    }

    pub fn usage(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::Usage, message.to_string())
    }

    pub fn not_booted(message: impl std::fmt::Display) -> Self {
        Self::new(ErrorKind::NotBooted, message.to_string())
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_uri_normalizes_windows_backslashes() {
        // C3：Windows 反斜杠路径 → 正斜杠 URI 形态（引擎侧亦做 replace 兜底）
        let dir = PathBuf::from(r"C:\Users\Anyi\Documents\My Projects");
        let uri = sqlite_uri(&dir);
        assert!(uri.starts_with("sqlite:///C:/Users/Anyi/Documents/"), "反斜杠应转正斜杠: {uri}");
        assert!(uri.ends_with("/inkling.sqlite"), "URI 应以库文件名收尾: {uri}");
        assert!(!uri.contains('\\'), "URI 不应含反斜杠: {uri}");
    }

    #[test]
    fn sqlite_uri_percent_encodes_uri_illegal_chars() {
        // C3：`#`/空格等 URI 非法字符百分号编码（保留盘符冒号与分隔斜杠）
        let dir = PathBuf::from("C:/tmp#1/ink ling");
        let uri = sqlite_uri(&dir);
        assert!(!uri.contains('#'), "URI 片段标记应编码: {uri}");
        assert!(uri.contains("%23"), "`#` 应编码为 %23: {uri}");
        assert!(uri.contains("ink%20ling"), "空格应编码为 %20: {uri}");
        assert!(uri.contains("sqlite:///C:/tmp"), "盘符冒号与路径斜杠应保留: {uri}");
    }
}

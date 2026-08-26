//! 命令面安全集成测试（批 1 安全：决议 4 × L10）。
//!
//! 断言面：
//! 1. 审批台账生效：无服务端审批态时 review 档被拒（命令面不再直接注入
//!    approved，客户端无法自证授权）；
//! 2. 台账三路放行路径：审批卡决议（含参数指纹精确命中）/ 自动审批配置 /
//!    引擎通道放行态（os.dispatch 决议态登记）；
//! 3. 参数指纹裁决：同工具不同参数不共享批准（防「批准一次，任意调用」）；
//! 4. 路径沙箱 `..` 穿越拒绝（S1）；
//! 5. 用户可见结果脱敏（S10）；
//! 6. 拒绝路径统一携带错误码（S8）。
//!
//! 运行：cargo test（MockBackend 注入，零桌面依赖）。

use std::collections::BTreeMap;
use std::path::PathBuf;

use inkling_shell_lib::executors::backends::MockBackend;
use inkling_shell_lib::executors::impls::ExecError;
use inkling_shell_lib::executors::registry::build_registry_from_declarations;
use inkling_shell_lib::executors::tool_decl::load_tool_declarations;
use inkling_shell_lib::domain::security::{ErrorCode, WorkspaceGuard, resolve_process_exec};
use inkling_shell_lib::{ApprovalLedger, redact_workspace};

const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

fn args(pairs: &[(&str, serde_json::Value)]) -> BTreeMap<String, serde_json::Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn fixtures() -> (
    inkling_shell_lib::executors::tool_decl::ToolDeclarations,
    inkling_shell_lib::executors::registry::ExecutorRegistry,
    ApprovalLedger,
) {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).expect("夹具声明应可解析");
    let registry = build_registry_from_declarations(&declarations).expect("注册应成功");
    let ledger = ApprovalLedger::from_declarations(&declarations);
    (declarations, registry, ledger)
}

// ── 1. 审批台账生效（决议 4 × L10 核心断言）──

#[test]
fn review_tier_rejected_without_server_approval_state() {
    // 无服务端审批态（台账为空）：review 档被拒——命令面不再有 approved()
    // 注入面，客户端无法自证授权
    let (_, registry, ledger) = fixtures();
    let backend = MockBackend::new();

    for (tool, tool_args) in [
        ("ui_click", args(&[("x", 10.into()), ("y", 10.into()), ("button", "left".into())])),
        ("window_focus", args(&[("handle", "123".into())])),
        ("doc_parse", args(&[("path", "~/.inkling/workspace/a.pdf".into())])),
    ] {
        let auth = ledger.adjudicate(tool, &tool_args);
        assert!(!auth.approved, "{tool} 无审批态时不得放行");
        let err = registry.run(tool, &tool_args, &backend, &auth).unwrap_err();
        assert_eq!(err, ExecError::ApprovalRequired(tool.into()), "{tool} 应报需审批");
        assert!(backend.calls.lock().unwrap().is_empty(), "{tool} 不得触达后端");
    }
}

#[test]
fn approval_resolution_unlocks_exact_fingerprint() {
    // 审批卡决议（payload 携带 tool/args 线索）→ 仅精确指纹放行；
    // 同工具不同参数不共享批准（防「批准一次，任意调用」）
    let (_, registry, ledger) = fixtures();
    let backend = MockBackend::new();

    let approved_call = args(&[("x", 10.into()), ("y", 10.into()), ("button", "left".into())]);
    let other_call = args(&[("x", 999.into()), ("y", 999.into()), ("button", "left".into())]);

    // 引擎审批卡决议态登记（approval.gate_card_request 决议 accept）
    ledger.record_resolution(
        "card:ui_click",
        "accept",
        Some(&serde_json::json!({ "tool": "ui_click", "args": approved_call.clone() })),
    );

    let auth = ledger.adjudicate("ui_click", &approved_call);
    assert!(auth.approved, "台账决议命中的调用应放行");
    let outcome = registry.run("ui_click", &approved_call, &backend, &auth).expect("应执行");
    assert!(outcome.result.contains("left @ (10,10)"));

    // 参数指纹不同 → 不命中批准（台账裁决按实参精确匹配）
    let auth = ledger.adjudicate("ui_click", &other_call);
    assert!(!auth.approved, "不同参数不得共享批准");
    let err = registry.run("ui_click", &other_call, &backend, &auth).unwrap_err();
    assert_eq!(err, ExecError::ApprovalRequired("ui_click".into()));

    // reject 决议 = 不落批准态（裁决仍拒绝）
    let mut rejected = approved_call.clone();
    rejected.insert("button".into(), serde_json::Value::String("right".into()));
    ledger.record_resolution(
        "card:ui_click:right",
        "reject",
        Some(&serde_json::json!({ "tool": "ui_click", "args": rejected.clone() })),
    );
    let auth = ledger.adjudicate("ui_click", &rejected);
    assert!(!auth.approved, "reject 决议不得放行");
}

#[test]
fn auto_approve_config_passes_review_tier() {
    // 能力设置自动审批（security.auto_approve_set 同源）：登记工具直过
    let (_, registry, ledger) = fixtures();
    let backend = MockBackend::new();

    let call = args(&[("percent", 50.into())]);
    assert!(!ledger.adjudicate("set_volume", &call).approved);

    ledger.set_auto_approve(vec!["set_volume".into()], false);
    let auth = ledger.adjudicate("set_volume", &call);
    assert!(auth.approved, "自动审批登记工具应放行");
    let outcome = registry.run("set_volume", &call, &backend, &auth).expect("应执行");
    assert_eq!(outcome.result, "mock:volume 50");

    // 未登记工具不受影响
    let other = args(&[("app", "calc".into())]);
    assert!(!ledger.adjudicate("launch_app", &other).approved, "未登记工具仍须审批");

    // 全量自动审批开关
    ledger.set_auto_approve(vec![], true);
    assert!(ledger.adjudicate("launch_app", &other).approved);
}

#[test]
fn engine_dispatch_channel_records_and_passes() {
    // 引擎通道（os.dispatch）：引擎放行态登记入台账 → 同一裁决函数放行；
    // 台账由引擎审批卡决议态驱动，无硬编码 approved
    let (_, registry, ledger) = fixtures();
    let backend = MockBackend::new();

    let call = args(&[("x", 5.into()), ("y", 5.into()), ("button", "left".into())]);
    assert!(!ledger.adjudicate("ui_click", &call).approved, "未登记前不放行");
    ledger.record_engine_dispatch("ui_click", &call);
    let auth = ledger.adjudicate("ui_click", &call);
    assert!(auth.approved, "引擎放行态登记后应放行");
    let outcome = registry.run("ui_click", &call, &backend, &auth).expect("应执行");
    assert!(outcome.sandbox_checked);
}

#[test]
fn allow_tier_and_untiered_pass_without_approval() {
    // allow 档（声明直过）+ 未登记工具（挂载/补丁新增按声明直过）不需要审批
    let (_, _, ledger) = fixtures();
    let allow_call = args(&[("query", "os".into())]);
    assert!(ledger.adjudicate("system_query", &allow_call).approved);
    assert!(ledger.adjudicate("mcp_mounted_tool", &args(&[])).approved);
}

// ── 2. 路径沙箱 `..` 穿越（S1）──

#[test]
fn path_dotdot_traversal_rejected_in_open_file() {
    let (_, registry, ledger) = fixtures();
    let backend = MockBackend::new();
    // 预授权 open_file（审批层放行），把拒绝点收敛到沙箱层——`..` 穿越
    // 必须由路径根守卫拒绝，与审批态无关
    ledger.set_auto_approve(vec!["open_file".into()], false);

    for evil in [
        "~/../../etc/passwd",
        "~/.../././/../../win.ini",
        "~/.inkling/workspace/../..\\..\\Windows\\System32\\cmd.exe",
        "~/.inkling/workspace/../../.ssh/id_rsa",
    ] {
        let call = args(&[("path", evil.into())]);
        let auth = ledger.adjudicate("open_file", &call);
        assert!(auth.approved, "审批层应放行（沙箱层是拒绝点）: {evil}");
        let err = registry.run("open_file", &call, &backend, &auth).unwrap_err();
        assert!(
            matches!(err, ExecError::SandboxViolation(_)),
            "`..` 穿越必须被沙箱拒绝: {evil}（{err}）"
        );
    }
    assert!(backend.calls.lock().unwrap().is_empty(), "穿越调用不得触达后端");
}

// ── 3. 用户可见结果脱敏（S10）──

#[test]
fn redaction_replaces_workspace_absolute_path() {
    let root = PathBuf::from("C:/Users/test/.inkling/workspace");
    let text = format!(
        "exit 0\n[stdout]\ncwd: {}\npath: {}\\sub\\file.txt",
        root.display(),
        root.display()
    );
    let redacted = redact_workspace(&text, &root);
    assert!(!redacted.contains("C:"), "绝对路径不得残留: {redacted}");
    assert!(redacted.contains("<workspace>"), "占位替换缺失: {redacted}");
    assert!(redacted.contains("sub"), "相对子路径应保留: {redacted}");
    assert!(redacted.contains("file.txt"), "文件名应保留: {redacted}");
    // 正斜杠形态同样脱敏
    let slash_text = format!("cwd: {}/sub", root.to_string_lossy().replace('\\', "/"));
    assert!(!redact_workspace(&slash_text, &root).contains(".inkling/workspace"));
}

// ── 4. 拒绝路径统一携带错误码（S8）──

#[test]
fn workspace_guard_rejections_carry_error_codes() {
    let ws = std::env::temp_dir().join(format!("inkling-secface-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&ws).unwrap();
    let guard = WorkspaceGuard::default();

    // 未授权 → SEC_005
    let denied = guard.validate_file("read", "x", None).unwrap_err();
    assert!(denied.0.contains(ErrorCode::SANDBOX_UNAUTHORIZED), "缺 SEC_005: {}", denied.0);

    guard.authorize(&ws);
    std::fs::write(ws.join("inside.txt"), "ok").unwrap();
    std::fs::write(ws.parent().unwrap().join("outside.txt"), "x").unwrap();

    // 词法越界 → SEC_002
    let out = ws.parent().unwrap().join("outside.txt");
    let outside = guard.validate_file("read", &out.to_string_lossy(), None).unwrap_err();
    assert!(outside.0.contains(ErrorCode::SANDBOX_OUT_OF_ROOT), "缺 SEC_002: {}", outside.0);
    // `..` 穿越 → 解析后越界（词法根内、解析根外归 SEC_002/SEC_003 族）
    let traverse = format!("{}/../outside.txt", ws.to_string_lossy());
    let traversed = guard.validate_file("read", &traverse, None).unwrap_err();
    assert!(traversed.0.contains(ErrorCode::SANDBOX_OUT_OF_ROOT), "缺 SEC_002: {}", traversed.0);

    let _ = std::fs::remove_dir_all(&ws);
}

#[test]
fn process_exec_resolution_rejections_carry_error_codes() {
    let mut tiers = std::collections::HashMap::new();
    tiers.insert("launch_app".to_string(), "review".to_string());
    tiers.insert("shell_exec".to_string(), "deny".to_string());

    let mismatch = resolve_process_exec("launch_app", "evil", &tiers).unwrap_err();
    assert!(
        mismatch["error"].as_str().unwrap().contains(ErrorCode::COMMAND_ENUM_MISMATCH),
        "缺 SEC_009: {mismatch}"
    );
    let deny = resolve_process_exec("shell_exec", "shell_exec", &tiers).unwrap_err();
    assert!(
        deny["error"].as_str().unwrap().contains(ErrorCode::PERMISSION_DENIED),
        "缺 SEC_001: {deny}"
    );
}

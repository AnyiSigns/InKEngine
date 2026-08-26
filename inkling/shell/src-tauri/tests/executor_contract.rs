//! 执行器注册契约测试（宿主件自检矩阵行，免真实桌面）。
//!
//! 断言面：
//! 1. 工具声明 ↔ 执行器签名一致（名称/参数/权限/端点/沙箱模式逐项比对）；
//! 2. 权限守卫（deny 硬拦 / review 未授权拒绝 / allow 放行）——裁决经壳侧
//!    审批台账（决议 4 × L10：命令面不再直接注入 approved，无服务端审批态
//!    时 review 档被拒）；
//! 3. 沙箱守卫（命令白名单 / 路径根 / 数值边界 / 长度上限）；
//! 4. 注册表拒绝未知工具（禁硬编码回退）。
//!
//! 运行：cargo test（MockBackend 注入，零桌面依赖）。

use std::collections::BTreeMap;

use inkling_shell_lib::ApprovalLedger;
use inkling_shell_lib::executors::backends::MockBackend;
use inkling_shell_lib::executors::impls::{Authorization, ExecError};
use inkling_shell_lib::executors::registry::build_registry_from_declarations;
use inkling_shell_lib::executors::tool_decl::{
    Endpoint, ParamType, PermissionLevel, SandboxRule, ToolDecl, ToolDeclarations,
    load_tool_declarations,
};

const TOOLS_DECL_JSON: &str = include_str!("../fixtures/tools_os.json");

fn registry_with(declarations: &ToolDeclarations) -> inkling_shell_lib::executors::registry::ExecutorRegistry {
    build_registry_from_declarations(declarations).expect("声明 ↔ 执行器签名应一致")
}

fn args(pairs: &[(&str, serde_json::Value)]) -> BTreeMap<String, serde_json::Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

fn ledger_with(declarations: &ToolDeclarations) -> ApprovalLedger {
    ApprovalLedger::from_declarations(declarations)
}

/// 命令面裁决（决议 4）：授权面一律经壳侧审批台账 adjudicate 产出——
/// 测试不直接构造 approved 授权，与安全语义同向。
fn adjudicate(
    ledger: &ApprovalLedger,
    tool: &str,
    args: &BTreeMap<String, serde_json::Value>,
) -> Authorization {
    ledger.adjudicate(tool, args)
}

/// 预授权（review 档测试的放行路径）：先登记审批台账决议（引擎审批卡
/// 决议态驱动），再经 adjudicate 裁决——覆盖「台账生效 → 放行」全链。
fn pre_approved(
    ledger: &ApprovalLedger,
    tool: &str,
    args: &BTreeMap<String, serde_json::Value>,
) -> Authorization {
    ledger.record_resolution(
        "test",
        "accept",
        Some(&serde_json::json!({ "tool": tool, "args": args })),
    );
    adjudicate(ledger, tool, args)
}

#[test]
fn fixture_declarations_load_and_match_every_executor() {
    // 契约核心：夹具声明（= 定稿形态）全量注册成功 = 声明 ↔ 执行器签名逐项一致
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).expect("夹具声明应可解析");
    let registry = registry_with(&declarations);

    let declared: Vec<String> = declarations.tools.iter().map(|t| t.name.clone()).collect();
    let mut registered = registry.names();
    registered.sort();
    let mut declared_sorted = declared.clone();
    declared_sorted.sort();
    assert_eq!(registered, declared_sorted, "声明集合与注册集合必须一致（无缺漏/无多余）");
    assert!(registry.names().len() >= 7, "process_exec 七件 + 感知件须全部注册");
}

#[test]
fn seven_process_exec_tools_registered() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    for tool in ["launch_app", "open_file", "system_query", "set_volume", "set_brightness", "notify", "schedule"] {
        assert!(registry.get(tool).is_some(), "{tool} 应已注册");
        assert_eq!(
            registry.get(tool).unwrap().spec().endpoint,
            Endpoint::ProcessExec,
            "{tool} 端点应为 process_exec"
        );
    }
}

fn expect_registration_error(declarations: &ToolDeclarations) -> String {
    match build_registry_from_declarations(declarations) {
        Err(message) => message,
        Ok(_) => panic!("注册应失败（fail-closed）"),
    }
}

#[test]
fn undeclared_executor_is_rejected() {
    // 禁硬编码：实现表外的声明引用 = 注册失败（fail-closed）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let mut declarations = declarations;
    declarations.tools.push(ToolDecl {
        name: "hardcoded_ghost".into(),
        description: String::new(),
        permission: PermissionLevel::Allow,
        endpoint: Endpoint::ProcessExec,
        sandbox: SandboxRule::CommandAllowlist { allowlist: vec![] },
        params: vec![],
    });
    let message = expect_registration_error(&declarations);
    assert!(message.contains("hardcoded_ghost"));
}

#[test]
fn signature_mismatch_is_rejected() {
    // 声明与执行器参数签名不一致 = 注册失败（漂移在启动即暴露）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let mut declarations = declarations;
    for tool in &mut declarations.tools {
        if tool.name == "notify" {
            tool.params.push(inkling_shell_lib::executors::tool_decl::ParamDecl {
                name: "drifted_param".into(),
                param_type: ParamType::String,
                required: false,
            });
        }
    }
    let message = expect_registration_error(&declarations);
    assert!(message.contains("notify"));
}

#[test]
fn permission_mismatch_is_rejected() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let mut declarations = declarations;
    for tool in &mut declarations.tools {
        if tool.name == "system_query" {
            tool.permission = PermissionLevel::Review;
        }
    }
    let message = expect_registration_error(&declarations);
    assert!(message.contains("system_query"));
}

// ===== 权限守卫 =====

#[test]
fn review_tool_requires_approval() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();
    let call = args(&[("app", "notepad".into())]);

    // 无服务端审批态（台账为空）→ review 档被拒（决策 4×L10：命令面不再
    // 直接注入 approved；首次越界强制 L2 人工审批语义）
    let auth = adjudicate(&ledger, "launch_app", &call);
    assert!(!auth.approved, "无审批态时命令面不得放行 review 档");
    let err = registry
        .run("launch_app", &call, &backend, &auth)
        .unwrap_err();
    assert_eq!(err, ExecError::ApprovalRequired("launch_app".into()));
    assert!(
        backend.calls.lock().unwrap().is_empty(),
        "被拒调用不得触达后端"
    );

    // 审批台账决议（accept）后放行，且未触达后端（守卫先于副作用）
    let auth = pre_approved(&ledger, "launch_app", &call);
    assert!(auth.approved, "台账决议后应放行");
    let outcome = registry
        .run("launch_app", &call, &backend, &auth)
        .expect("台账批准后应放行");
    assert!(outcome.sandbox_checked);
}

#[test]
fn deny_level_tool_is_hard_blocked() {
    // deny 级语义：注册表内不存在（deny = 声明不落注册表）——未知工具即硬拦
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();
    let auth = adjudicate(&ledger, "unknown_tool", &args(&[]));
    let err = registry
        .run("unknown_tool", &args(&[]), &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::UnknownTool(_)));
}

#[test]
fn allow_tool_runs_without_approval() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();
    let auth = adjudicate(&ledger, "system_query", &args(&[("query", "os".into())]));
    assert!(auth.approved, "allow 档无需审批即放行");
    let outcome = registry
        .run("system_query", &args(&[("query", "os".into())]), &backend, &auth)
        .expect("allow 级不需要授权");
    assert_eq!(outcome.result, "mock:query os");
}

// ===== 进程模板工具（run_typecheck / run_test_*） =====

const PROCESS_TEMPLATE_TOOLS: [&str; 4] = ["run_typecheck", "run_test_cargo", "run_test_python", "run_test_web"];

#[test]
fn process_template_tools_registered_with_review_gate() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    for tool in PROCESS_TEMPLATE_TOOLS {
        let executor = registry.get(tool).unwrap_or_else(|| panic!("{tool} 应已注册"));
        assert_eq!(executor.spec().endpoint, Endpoint::ProcessExec, "{tool} 端点应为 process_exec");
        assert_eq!(executor.spec().permission, PermissionLevel::Review, "{tool} 权限应为 review");
        let template = match &executor.spec().sandbox {
            SandboxRule::ProcessTemplate { argv, timeout_secs, .. } => {
                assert!(!argv.is_empty(), "{tool} 模板不得为空");
                assert!(*timeout_secs > 0, "{tool} 超时必须为正");
                argv.clone()
            }
            other => panic!("{tool} 沙箱模式应为 process_template: {other:?}"),
        };
        // 无服务端审批态 → ApprovalRequired（review 档硬守，不注入 approved）
        let backend = MockBackend::new();
        let call = args(&[("command", tool.into())]);
        let auth = adjudicate(&ledger, tool, &call);
        assert!(!auth.approved, "无审批态时 review 档不得放行: {tool}");
        let err = registry.run(tool, &call, &backend, &auth).unwrap_err();
        assert_eq!(err, ExecError::ApprovalRequired(tool.into()));
        // 台账预授权后经后端执行钉死模板
        let auth = pre_approved(&ledger, tool, &call);
        let outcome = registry
            .run(tool, &call, &backend, &auth)
            .expect("台账批准后应放行");
        assert!(outcome.sandbox_checked);
        assert!(
            outcome.result.contains(&template.join(" ")),
            "{tool} 结果应含模板 argv: {}",
            outcome.result
        );
        assert!(
            backend
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|call| call.starts_with("run_process:")),
            "后端应记录进程模板调用"
        );
    }
}

#[test]
fn process_template_command_enum_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();
    // command 固定枚举不符 = 拒绝（与引擎侧 command_enum_mismatch 同语义）
    let call = args(&[("command", "run_typecheck".into())]);
    let auth = pre_approved(&ledger, "run_test_cargo", &call);
    let err = registry
        .run("run_test_cargo", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "command 枚举不符必须拒绝: {err}");
    // 缺 command = 参数非法
    let call = args(&[]);
    let auth = pre_approved(&ledger, "run_typecheck", &call);
    let err = registry
        .run("run_typecheck", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "缺 command 必须拒绝: {err}");
}

#[test]
fn process_template_wrong_sandbox_mode_rejected() {
    // 声明沙箱模式与执行器不一致 = 注册失败（fail-closed，漂移启动即暴露）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let mut declarations = declarations;
    for tool in &mut declarations.tools {
        if tool.name == "run_typecheck" {
            tool.sandbox = SandboxRule::CommandAllowlist { allowlist: vec!["tsc".into()] };
        }
    }
    let message = expect_registration_error(&declarations);
    assert!(message.contains("run_typecheck"), "模式漂移必须报错: {message}");
}

// ===== 受限筛选参数（filter：缩小范围重跑，值经字符集/前导符校验） =====

#[test]
fn process_template_filter_appends_per_declared_flag() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    // cargo：模板尾部追加 ["--", 筛选]
    let call = args(&[("command", "run_test_cargo".into()), ("filter", "parse_test".into())]);
    let auth = pre_approved(&ledger, "run_test_cargo", &call);
    let outcome = registry
        .run("run_test_cargo", &call, &backend, &auth)
        .expect("cargo 筛选应放行");
    assert!(outcome.result.contains("cargo test -- parse_test"), "{}", outcome.result);

    // pytest：追加 ["-k", 关键词表达式]（and/or/not 是字母组合，放行）
    let call = args(&[("command", "run_test_python".into()), ("filter", "parse and not live".into())]);
    let auth = pre_approved(&ledger, "run_test_python", &call);
    let outcome = registry
        .run("run_test_python", &call, &backend, &auth)
        .expect("pytest 关键词组合应放行");
    assert!(outcome.result.contains("pytest -k parse and not live"), "{}", outcome.result);

    // vitest：追加 ["-t", 测试名子串]
    let call = args(&[("command", "run_test_web".into()), ("filter", "settings_form".into())]);
    let auth = pre_approved(&ledger, "run_test_web", &call);
    let outcome = registry
        .run("run_test_web", &call, &backend, &auth)
        .expect("vitest 筛选应放行");
    assert!(outcome.result.contains("vitest run -t settings_form"), "{}", outcome.result);

    // 空白 filter = 视同未传（整跑）
    let call = args(&[("command", "run_test_cargo".into()), ("filter", "   ".into())]);
    let auth = pre_approved(&ledger, "run_test_cargo", &call);
    let outcome = registry
        .run("run_test_cargo", &call, &backend, &auth)
        .expect("空白筛选应整跑");
    assert!(outcome.result.contains("cargo test（exit 0）"), "{}", outcome.result);
}

#[test]
fn process_template_filter_injection_rejected() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    // 前导连字符 = 旗标注入（pytest --pdb 类交互面）→ 拒绝
    let call = args(&[("command", "run_test_python".into()), ("filter", "--pdb".into())]);
    let auth = pre_approved(&ledger, "run_test_python", &call);
    let err = registry
        .run("run_test_python", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "旗标注入必须拒绝: {err}");

    // 命令拼接符号 → 拒绝（纵深防御，即便未来引入 shell 层也不放大面）
    for evil in ["parse; rm -rf .", "parse && cargo clean", "parse$(whoami)", "a|b", "x>y"] {
        let call = args(&[("command", "run_test_cargo".into()), ("filter", evil.into())]);
        let auth = pre_approved(&ledger, "run_test_cargo", &call);
        let err = registry
            .run("run_test_cargo", &call, &backend, &auth)
            .unwrap_err();
        assert!(matches!(err, ExecError::BadArgs(_)), "拼接符号必须拒绝: {evil}");
    }

    // 超长 → 拒绝
    let call = args(&[("command", "run_test_web".into()), ("filter", "x".repeat(65).into())]);
    let auth = pre_approved(&ledger, "run_test_web", &call);
    let err = registry
        .run("run_test_web", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "超长筛选必须拒绝: {err}");
}

#[test]
fn process_template_filter_rejected_without_declared_slot() {
    // run_typecheck 无 filter 声明位：传筛选 = 拒绝（模板钉死不收自由面）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();
    let call = args(&[("command", "run_typecheck".into()), ("filter", "app".into())]);
    let auth = pre_approved(&ledger, "run_typecheck", &call);
    let err = registry
        .run("run_typecheck", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "无声明位必须拒绝: {err}");
}

// ===== 沙箱守卫 =====

#[test]
fn launch_app_command_allowlist_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("app", "powershell.exe".into())]);
    let auth = pre_approved(&ledger, "launch_app", &call);
    let err = registry
        .run("launch_app", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "白名单外应用必须拒绝: {err}");

    let call = args(&[("app", "calc".into())]);
    let auth = pre_approved(&ledger, "launch_app", &call);
    let outcome = registry
        .run("launch_app", &call, &backend, &auth)
        .expect("白名单内应放行");
    assert!(outcome.result.starts_with("mock:launch calc"));
}

#[test]
fn open_file_path_roots_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    // 相对路径拒绝
    let call = args(&[("path", "relative/evil.txt".into())]);
    let auth = pre_approved(&ledger, "open_file", &call);
    let err = registry
        .run("open_file", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "相对路径必须拒绝");

    // 挂载根外绝对路径拒绝
    let call = args(&[("path", "C:\\Windows\\System32\\cmd.exe".into())]);
    let auth = pre_approved(&ledger, "open_file", &call);
    let err = registry
        .run("open_file", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "挂载根外必须拒绝");

    // `..` 穿越拒绝（S1：词法 `..` 段一律拒绝，前缀组件匹配不可被绕过）
    for evil in [
        "~/../../etc/passwd",
        "~/.inkling/workspace/../../outside.txt",
        "~/.inkling/workspace/..\\..\\outside.txt",
    ] {
        let call = args(&[("path", evil.into())]);
        let auth = pre_approved(&ledger, "open_file", &call);
        let err = registry
            .run("open_file", &call, &backend, &auth)
            .unwrap_err();
        assert!(
            matches!(err, ExecError::SandboxViolation(_)),
            "`..` 穿越必须拒绝: {evil}"
        );
    }

    // 挂载根内放行（校验后按解析路径执行）
    let call = args(&[("path", "~/.inkling/workspace/notes.md".into())]);
    let auth = pre_approved(&ledger, "open_file", &call);
    let outcome = registry
        .run("open_file", &call, &backend, &auth)
        .expect("挂载根内应放行");
    assert!(outcome.result.contains("notes.md"));
}

#[test]
fn set_volume_bounds_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("percent", 150.into())]);
    let auth = pre_approved(&ledger, "set_volume", &call);
    let err = registry
        .run("set_volume", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "越界必须拒绝");

    let call = args(&[("percent", 42.into())]);
    let auth = pre_approved(&ledger, "set_volume", &call);
    let outcome = registry
        .run("set_volume", &call, &backend, &auth)
        .expect("边界内应放行");
    assert_eq!(outcome.result, "mock:volume 42");
}

#[test]
fn set_brightness_bounds_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("percent", (-5).into())]);
    let auth = pre_approved(&ledger, "set_brightness", &call);
    let err = registry
        .run("set_brightness", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "负值必须拒绝");
}

#[test]
fn schedule_bounds_and_required_args() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("seconds", 0.into()), ("action", "x".into())]);
    let auth = pre_approved(&ledger, "schedule", &call);
    let err = registry
        .run("schedule", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "0 秒越界必须拒绝");

    let call = args(&[("seconds", 10.into())]);
    let auth = pre_approved(&ledger, "schedule", &call);
    let err = registry
        .run("schedule", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "缺少 action 必须拒绝");

    let call = args(&[("seconds", 10.into()), ("action", "提醒".into())]);
    let auth = pre_approved(&ledger, "schedule", &call);
    let outcome = registry
        .run("schedule", &call, &backend, &auth)
        .expect("边界内应放行");
    assert!(outcome.result.starts_with("mock:job"));
}

#[test]
fn notify_length_caps_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let long_title = "超".repeat(200);
    let call = args(&[("title", long_title.into()), ("body", "正文".into())]);
    let auth = pre_approved(&ledger, "notify", &call);
    let err = registry
        .run("notify", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "超长标题必须拒绝");

    let call = args(&[("title", "InKling".into()), ("body", "补丁已沉淀".into())]);
    let auth = pre_approved(&ledger, "notify", &call);
    let outcome = registry
        .run("notify", &call, &backend, &auth)
        .expect("正常长度应放行");
    assert!(outcome.result.contains("InKling"));
}

#[test]
fn system_query_allowlist_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("query", "registry_dump".into())]);
    let auth = adjudicate(&ledger, "system_query", &call);
    let err = registry
        .run("system_query", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "白名单外查询面必须拒绝");
}

#[test]
fn device_tools_share_same_guards() {
    // 感知工具（device_mcp 端点）与 process_exec 同一套注册表/守卫，无第二条路径
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let call = args(&[("target", "webcam_stream".into())]);
    let auth = pre_approved(&ledger, "screen_query", &call);
    let err = registry
        .run("screen_query", &call, &backend, &auth)
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)));

    let call = args(&[("target", "resolution".into())]);
    let auth = pre_approved(&ledger, "screen_query", &call);
    let outcome = registry
        .run("screen_query", &call, &backend, &auth)
        .expect("白名单内应放行");
    assert_eq!(outcome.result, "mock:screen resolution");
}

#[test]
fn backend_side_effects_only_after_guards() {
    // 守卫失败时后端零调用（副作用最小化纪律；沙箱守卫为拒绝点——
    // 台账先行预授权，确保失败发生在沙箱层而非审批层）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let ledger = ledger_with(&declarations);
    let backend = MockBackend::new();

    let launch = args(&[("app", "evil.exe".into())]);
    let auth = pre_approved(&ledger, "launch_app", &launch);
    let _ = registry.run("launch_app", &launch, &backend, &auth);
    let volume = args(&[("percent", 200.into())]);
    let auth = pre_approved(&ledger, "set_volume", &volume);
    let _ = registry.run("set_volume", &volume, &backend, &auth);
    let evil_open = args(&[("path", "C:\\Windows\\evil.exe".into())]);
    let auth = pre_approved(&ledger, "open_file", &evil_open);
    let _ = registry.run("open_file", &evil_open, &backend, &auth);

    let calls = backend.calls.lock().unwrap();
    assert!(calls.is_empty(), "守卫拒绝的调用不得触达后端: {calls:?}");
}

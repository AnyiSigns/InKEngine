//! 执行器注册契约测试（宿主件自检矩阵行，免真实桌面）。
//!
//! 断言面：
//! 1. 工具声明 ↔ 执行器签名一致（名称/参数/权限/端点/沙箱模式逐项比对）；
//! 2. 权限守卫（deny 硬拦 / review 未授权拒绝 / allow 放行）；
//! 3. 沙箱守卫（命令白名单 / 路径根 / 数值边界 / 长度上限）；
//! 4. 注册表拒绝未知工具（禁硬编码回退）。
//!
//! 运行：cargo test（MockBackend 注入，零桌面依赖）。

use std::collections::BTreeMap;

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

fn approved() -> Authorization {
    Authorization { approved: true }
}

fn denied() -> Authorization {
    Authorization { approved: false }
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
    let backend = MockBackend::new();

    // review 级未授权 → ApprovalRequired（首次越界强制 L2 人工审批语义）
    let err = registry
        .run("launch_app", &args(&[("app", "notepad".into())]), &backend, &denied())
        .unwrap_err();
    assert_eq!(err, ExecError::ApprovalRequired("launch_app".into()));

    // 授权后放行，且未触达后端（守卫先于副作用）
    let outcome = registry
        .run("launch_app", &args(&[("app", "notepad".into())]), &backend, &approved())
        .expect("授权后应放行");
    assert!(outcome.sandbox_checked);
}

#[test]
fn deny_level_tool_is_hard_blocked() {
    // deny 级语义：注册表内不存在（deny = 声明不落注册表）——未知工具即硬拦
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();
    let err = registry
        .run("unknown_tool", &args(&[]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::UnknownTool(_)));
}

#[test]
fn allow_tool_runs_without_approval() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();
    let outcome = registry
        .run("system_query", &args(&[("query", "os".into())]), &backend, &denied())
        .expect("allow 级不需要授权");
    assert_eq!(outcome.result, "mock:query os");
}

// ===== 进程模板工具（run_typecheck / run_test_*） =====

const PROCESS_TEMPLATE_TOOLS: [&str; 4] = ["run_typecheck", "run_test_cargo", "run_test_python", "run_test_web"];

#[test]
fn process_template_tools_registered_with_review_gate() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    for tool in PROCESS_TEMPLATE_TOOLS {
        let executor = registry.get(tool).unwrap_or_else(|| panic!("{tool} 应已注册"));
        assert_eq!(executor.spec().endpoint, Endpoint::ProcessExec, "{tool} 端点应为 process_exec");
        assert_eq!(executor.spec().permission, PermissionLevel::Review, "{tool} 权限应为 review");
        let template = match &executor.spec().sandbox {
            SandboxRule::ProcessTemplate { argv, timeout_secs } => {
                assert!(!argv.is_empty(), "{tool} 模板不得为空");
                assert!(*timeout_secs > 0, "{tool} 超时必须为正");
                argv.clone()
            }
            other => panic!("{tool} 沙箱模式应为 process_template: {other:?}"),
        };
        // 未授权 → ApprovalRequired（review 档硬守）
        let backend = MockBackend::new();
        let err = registry
            .run(tool, &args(&[("command", tool.into())]), &backend, &denied())
            .unwrap_err();
        assert_eq!(err, ExecError::ApprovalRequired(tool.into()));
        // 授权后经后端执行钉死模板
        let outcome = registry
            .run(tool, &args(&[("command", tool.into())]), &backend, &approved())
            .expect("授权后应放行");
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
    let backend = MockBackend::new();
    // command 固定枚举不符 = 拒绝（与引擎侧 command_enum_mismatch 同语义）
    let err = registry
        .run("run_test_cargo", &args(&[("command", "run_typecheck".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "command 枚举不符必须拒绝: {err}");
    // 缺 command = 参数非法
    let err = registry
        .run("run_typecheck", &args(&[]), &backend, &approved())
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

// ===== 沙箱守卫 =====

#[test]
fn launch_app_command_allowlist_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("launch_app", &args(&[("app", "powershell.exe".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "白名单外应用必须拒绝: {err}");

    let outcome = registry
        .run("launch_app", &args(&[("app", "calc".into())]), &backend, &approved())
        .expect("白名单内应放行");
    assert!(outcome.result.starts_with("mock:launch calc"));
}

#[test]
fn open_file_path_roots_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    // 相对路径拒绝
    let err = registry
        .run("open_file", &args(&[("path", "relative/evil.txt".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "相对路径必须拒绝");

    // 挂载根外绝对路径拒绝
    let err = registry
        .run("open_file", &args(&[("path", "C:\\Windows\\System32\\cmd.exe".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "挂载根外必须拒绝");

    // 挂载根内放行
    let outcome = registry
        .run("open_file", &args(&[("path", "~/.inkling/workspace/notes.md".into())]), &backend, &approved())
        .expect("挂载根内应放行");
    assert!(outcome.result.contains("notes.md"));
}

#[test]
fn set_volume_bounds_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("set_volume", &args(&[("percent", 150.into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "越界必须拒绝");

    let outcome = registry
        .run("set_volume", &args(&[("percent", 42.into())]), &backend, &approved())
        .expect("边界内应放行");
    assert_eq!(outcome.result, "mock:volume 42");
}

#[test]
fn set_brightness_bounds_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("set_brightness", &args(&[("percent", (-5).into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "负值必须拒绝");
}

#[test]
fn schedule_bounds_and_required_args() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("schedule", &args(&[("seconds", 0.into()), ("action", "x".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "0 秒越界必须拒绝");

    let err = registry
        .run("schedule", &args(&[("seconds", 10.into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::BadArgs(_)), "缺少 action 必须拒绝");

    let outcome = registry
        .run("schedule", &args(&[("seconds", 10.into()), ("action", "提醒".into())]), &backend, &approved())
        .expect("边界内应放行");
    assert!(outcome.result.starts_with("mock:job"));
}

#[test]
fn notify_length_caps_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let long_title = "超".repeat(200);
    let err = registry
        .run("notify", &args(&[("title", long_title.into()), ("body", "正文".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "超长标题必须拒绝");

    let outcome = registry
        .run("notify", &args(&[("title", "InKling".into()), ("body", "补丁已沉淀".into())]), &backend, &approved())
        .expect("正常长度应放行");
    assert!(outcome.result.contains("InKling"));
}

#[test]
fn system_query_allowlist_enforced() {
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("system_query", &args(&[("query", "registry_dump".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)), "白名单外查询面必须拒绝");
}

#[test]
fn device_tools_share_same_guards() {
    // 感知工具（device_mcp 端点）与 process_exec 同一套注册表/守卫，无第二条路径
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let err = registry
        .run("screen_query", &args(&[("target", "webcam_stream".into())]), &backend, &approved())
        .unwrap_err();
    assert!(matches!(err, ExecError::SandboxViolation(_)));

    let outcome = registry
        .run("screen_query", &args(&[("target", "resolution".into())]), &backend, &approved())
        .expect("白名单内应放行");
    assert_eq!(outcome.result, "mock:screen resolution");
}

#[test]
fn backend_side_effects_only_after_guards() {
    // 守卫失败时后端零调用（副作用最小化纪律）
    let declarations = load_tool_declarations(TOOLS_DECL_JSON).unwrap();
    let registry = registry_with(&declarations);
    let backend = MockBackend::new();

    let _ = registry.run("launch_app", &args(&[("app", "evil.exe".into())]), &backend, &approved());
    let _ = registry.run("set_volume", &args(&[("percent", 200.into())]), &backend, &approved());
    let _ = registry.run("open_file", &args(&[("path", "C:\\Windows\\evil.exe".into())]), &backend, &approved());

    let calls = backend.calls.lock().unwrap();
    assert!(calls.is_empty(), "守卫拒绝的调用不得触达后端: {calls:?}");
}

//! headless 驱动的集成测试：每条子命令一条用例 + op 失败结构化 + op 通道直调等价。
//!
//! 测试通过 `CARGO_BIN_EXE_inkling_headless` 拉起真实二进制（独立进程，不触 GUI），
//! 解析其 stdout 的 JSON 信封做结构断言。等价用例在测试进程内直调同一驱动层
//! （boot_engine + dispatch_op），与二进制子进程走两条路径但产出应一致。

use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;

fn bin() -> PathBuf {
    // 集成测试二进制位于 `target/<profile>/deps/`，被驱动的 headless 二进制位于
    // 同层 `target/<profile>/`，据此由当前可执行文件位置反推（不依赖
    // `CARGO_BIN_EXE_*`，其在部分 crate 命名下不保证注入）。
    let exe = std::env::current_exe().expect("无法定位当前测试可执行文件");
    let bin_name = if cfg!(windows) {
        "inkling-headless.exe"
    } else {
        "inkling-headless"
    };
    exe.parent()
        .expect("deps 目录缺失")
        .parent()
        .expect("profile 目录缺失")
        .join(bin_name)
}

fn temp_data_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "inkling-cli-test-{}-{}",
        tag,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("临时数据目录创建失败");
    dir
}

fn run(args: &[&str], data_dir: &PathBuf) -> std::process::Output {
    let data_dir_arg = data_dir.to_string_lossy().into_owned();
    let mut full = vec!["--data-dir", data_dir_arg.as_str()];
    full.extend_from_slice(args);
    Command::new(bin())
        .args(&full)
        .output()
        .expect("二进制执行失败")
}

fn parse_envelope(output: &std::process::Output) -> Value {
    let text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(text.trim()).expect("stdout 非合法 JSON 信封")
}

#[test]
fn round_delivers_reply_envelope() {
    let data = temp_data_dir("round");
    let out = run(&["--round", "测试任务"], &data);
    assert!(out.status.success(), "回合应成功退出");
    let env = parse_envelope(&out);
    assert_eq!(env["ok"], true, "信封 ok 应为 true");
    assert_eq!(env["command"], "round", "command 字段应为 round");
    assert!(env["trace_id"].is_string(), "trace_id 应存在");
    assert_eq!(env["data"]["reason"], "reply", "回合应抵达回复态");
    assert!(env["data"]["events"].is_array(), "事件流应为数组");
    assert!(env["error"].is_null(), "成功时 error 应为 null");
}

#[test]
fn op_collect_specs_returns_array() {
    let data = temp_data_dir("op");
    let out = run(&["--op", "engine.collect_specs", "--args", "{}"], &data);
    assert!(out.status.success(), "op 调用应成功退出");
    let env = parse_envelope(&out);
    assert_eq!(env["ok"], true);
    assert_eq!(env["command"], "op");
    assert!(
        env["data"].is_array(),
        "engine.collect_specs 应返回工具清单数组"
    );
}

#[test]
fn op_unknown_returns_structured_error() {
    let data = temp_data_dir("op-err");
    let out = run(&["--op", "no.such.op", "--args", "{}"], &data);
    assert_eq!(out.status.code(), Some(1), "失败应退出码 1（fail-closed）");
    let env = parse_envelope(&out);
    assert_eq!(env["ok"], false, "失败信封 ok 应为 false");
    assert!(
        env["error"].is_object(),
        "失败应携带结构化 error 而非崩溃"
    );
    assert!(
        !env["error"]["message"].as_str().unwrap_or("").is_empty(),
        "error.message 应非空"
    );
    assert_eq!(env["data"], Value::Null, "失败时 data 应为 null");
}

#[test]
fn mutually_exclusive_flags_exit_usage_code_2() {
    // C7：互斥 flag 同时传入 = usage 错误，退出码 2（不再静默取第一个）
    let data = temp_data_dir("mutex");
    let out = run(&["--round", "x", "--op", "engine.collect_specs"], &data);
    assert_eq!(out.status.code(), Some(2), "互斥 flag = usage 错误退出码 2");
    let env = parse_envelope(&out);
    assert_eq!(env["ok"], false);
    assert_eq!(env["error"]["kind"], "usage", "信封 kind 应为 usage");
    assert!(
        env["error"]["message"].as_str().unwrap_or("").contains("互斥"),
        "错误文案应说明互斥"
    );
}

#[test]
fn audit_export_returns_array() {
    let data = temp_data_dir("audit");
    // 先跑一回合（同数据目录），为审计集合供给结算钩子落写
    let seeded = run(&["--round", "审计种子任务"], &data);
    assert!(seeded.status.success(), "审计种子回合应成功");

    let out = run(&["--audit", "export"], &data);
    assert!(out.status.success(), "审计导出应成功退出");
    let env = parse_envelope(&out);
    assert_eq!(env["ok"], true);
    assert_eq!(env["command"], "audit");
    assert!(
        env["data"].is_array(),
        "审计导出应返回记录数组（可空）"
    );
}

#[test]
fn op_direct_call_matches_cli_invocation() {
    // 测试进程内直调 op 通道（路径一）
    let _guard = inkling_shell_lib::engine::host::bridge_guard();
    let data = temp_data_dir("equiv");
    let host = inkling_cli::boot_engine(&inkling_cli::repo_root_default(), &data)
        .expect("直调装配失败");
    let direct = inkling_cli::dispatch_op("engine.collect_specs", serde_json::json!({}))
        .expect("直调 op 失败");
    host.stop().ok();

    // 二进制子进程经 --op 调用（路径二）
    let out = run(&["--op", "engine.collect_specs", "--args", "{}"], &data);
    assert!(out.status.success(), "CLI --op 应成功退出");
    let env = parse_envelope(&out);
    let cli_data = env["data"].clone();

    assert_eq!(
        direct, cli_data,
        "op 通道直调与 headless --op 应产出等价结果"
    );
}

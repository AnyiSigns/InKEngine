//! InKling headless 命令行入口：解析参数 → 调用驱动层 → 打印统一 JSON 信封。
//!
//! 四条驱动面：--round 发起回合、--op 单引擎 op 调用、--os-op 单 OS 操作调用
//! （转发桌面壳执行器注册表，守卫同源）、--audit 审计导出。
//! 任意一步失败均返回 ok=false 的结构化错误信封并退出码 1（fail-closed），
//! 参数用法错误（互斥 flag / 缺命令）退出码 2；不向 stdout 泄露半成品 JSON，
//! 诊断信息走 stderr 的 [headless] 通道（复用桌面壳既有的 eprintln 诊断约定，
//! trace_id 随行透传）。

use std::path::PathBuf;
use std::process::exit;

use clap::Parser;
use serde_json::Value;

use inkling_cli::{
    kind_str, repo_root_default, run_audit, run_op, run_os_op, run_round, CliError, Envelope,
    EnvelopeError, ErrorKind,
};

#[derive(Parser)]
#[command(name = "inkling-headless", about = "InKling headless 驱动界面（JSON 信封输出）")]
struct Cli {
    /// 发起一次回合（回合输入文本）
    #[arg(long)]
    round: Option<String>,

    /// 单 op 调用（引擎 op 名，如 engine.collect_specs / path.assemble）
    #[arg(long)]
    op: Option<String>,

    /// 审计动作（当前仅 export）
    #[arg(long)]
    audit: Option<String>,

    /// 单 OS 操作调用（桌面壳执行器名，如 window_list / ui_tree_query / ui_click）
    #[arg(long = "os-op")]
    os_op: Option<String>,

    /// 声明调用方已获授权（review 档 OS 操作需之；缺省 false = fail-closed）
    #[arg(long)]
    approve: bool,

    /// op 参数（JSON 字符串，缺省 {}）
    #[arg(long)]
    args: Option<String>,

    /// 运行数据目录（sqlite + 资源落盘；缺省每进程独立临时目录）
    #[arg(long)]
    data_dir: Option<PathBuf>,

    /// 仓库根（种子 / 引擎包解析基准；缺省自动推导）
    #[arg(long = "repo-root")]
    repo_root: Option<PathBuf>,

    /// 透传 trace_id（缺省自动生成）
    #[arg(long = "trace-id")]
    trace_id: Option<String>,

    /// 回合线程 id（缺省 hl-<trace_id>；固定后可测同线程多轮续链）
    #[arg(long = "thread-id")]
    thread_id: Option<String>,

    /// 回合 id（缺省 hlr-<trace_id>）
    #[arg(long = "round-id")]
    round_id: Option<String>,

    /// 回合步骤参数（JSON 字符串，缺省 {}）：计划步骤 spawn 子图的工具
    /// 参数模板（state.step_args → 各工具名对应的参数段）
    #[arg(long = "step-args")]
    step_args: Option<String>,
}

fn main() {
    let cli = Cli::parse();

    let trace_id = cli
        .trace_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());

    // C7：驱动参数互斥——多 flag 同时指定 = usage 错误（退出码 2），
    // 不再静默取第一个。
    let provided = [
        cli.round.is_some(),
        cli.op.is_some(),
        cli.os_op.is_some(),
        cli.audit.is_some(),
    ];
    let count = provided.iter().filter(|&&c| c).count();

    let command: &str = if cli.round.is_some() {
        "round"
    } else if cli.op.is_some() {
        "op"
    } else if cli.os_op.is_some() {
        "os_op"
    } else if cli.audit.is_some() {
        "audit"
    } else {
        "usage"
    };

    let repo_root = cli.repo_root.clone().unwrap_or_else(repo_root_default);
    let data_dir = cli.data_dir.clone().unwrap_or_else(|| {
        std::env::temp_dir()
            .join(format!("inkling-headless-{}", uuid::Uuid::new_v4().simple()))
    });

    let handled: Result<Value, CliError> = if count > 1 {
        Err(CliError::usage("互斥参数：--round / --op / --os-op / --audit 仅可指定其一"))
    } else {
        match command {
            "round" => run_round(
                &repo_root,
                &data_dir,
                cli.round.as_deref().unwrap(),
                &trace_id,
                cli.thread_id.clone(),
                cli.round_id.clone(),
                cli.step_args.as_deref(),
            ),
            "op" => run_op(
                &repo_root,
                &data_dir,
                cli.op.as_deref().unwrap(),
                cli.args.as_deref().unwrap_or("{}"),
                &trace_id,
            ),
            "os_op" => run_os_op(
                cli.os_op.as_deref().unwrap(),
                cli.args.as_deref().unwrap_or("{}"),
                cli.approve,
            ),
            "audit" => run_audit(
                &repo_root,
                &data_dir,
                cli.audit.as_deref().unwrap(),
                &trace_id,
            ),
            _ => Err(CliError::usage("需指定 --round / --op / --os-op / --audit 之一")),
        }
    };

    match &handled {
        Ok(_) => eprintln!(
            "[headless] trace_id={} command={} status=ok",
            trace_id, command
        ),
        Err(err) => eprintln!(
            "[headless] trace_id={} command={} status=error kind={} message={}",
            trace_id,
            command,
            kind_str(err.kind),
            err.message
        ),
    }

    // C7：usage 错误退出码 2（参数用法问题），其余失败退出码 1，成功 0。
    let exit_code = match &handled {
        Ok(_) => 0,
        Err(err) if err.kind == ErrorKind::Usage => 2,
        Err(_) => 1,
    };

    let envelope = match handled {
        Ok(data) => Envelope {
            ok: true,
            trace_id: &trace_id,
            command,
            data: Some(data),
            error: None,
        },
        Err(err) => Envelope {
            ok: false,
            trace_id: &trace_id,
            command,
            data: None,
            error: Some(EnvelopeError {
                kind: kind_str(err.kind),
                message: err.message,
            }),
        },
    };

    match serde_json::to_string_pretty(&envelope) {
        Ok(text) => println!("{text}"),
        Err(err) => {
            eprintln!("[headless] 信封序列化失败: {err}");
            exit(1);
        }
    }

    exit(exit_code);
}

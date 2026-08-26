//! InKling headless 命令行入口：解析参数 → 调用驱动层 → 打印统一 JSON 信封。
//!
//! 四条驱动面：--round 发起回合、--op 单引擎 op 调用、--os-op 单 OS 操作调用
//! （转发桌面壳执行器注册表，守卫同源）、--audit 审计导出。
//! 任意一步失败均返回 ok=false 的结构化错误信封并以退出码 1 收尾（fail-closed），
//! 不向 stdout 泄露半成品 JSON，诊断信息走 stderr 的 [headless] 通道（复用桌面壳
//! 既有的 eprintln 诊断约定，trace_id 随行透传）。

use std::path::PathBuf;
use std::process::exit;

use clap::Parser;
use serde_json::Value;

use inkling_cli::{
    repo_root_default, run_audit, run_op, run_os_op, run_round, Envelope, EnvelopeError, ErrorKind,
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
}

fn kind_str(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Boot => "boot",
        ErrorKind::Op => "op",
        ErrorKind::Parse => "parse",
        ErrorKind::Usage => "usage",
    }
}

fn to_cli_err(kind: ErrorKind, result: Result<Value, String>) -> Result<Value, (ErrorKind, String)> {
    result.map_err(|message| (kind, message))
}

fn main() {
    let cli = Cli::parse();

    let trace_id = cli
        .trace_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());

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

    let handled: Result<Value, (ErrorKind, String)> = match command {
        "round" => to_cli_err(
            ErrorKind::Boot,
            run_round(
                &repo_root,
                &data_dir,
                cli.round.as_deref().unwrap(),
                &trace_id,
            ),
        ),
        "op" => to_cli_err(
            ErrorKind::Op,
            run_op(
                &repo_root,
                &data_dir,
                cli.op.as_deref().unwrap(),
                cli.args.as_deref().unwrap_or("{}"),
                &trace_id,
            ),
        ),
        "os_op" => to_cli_err(
            ErrorKind::Op,
            run_os_op(
                cli.os_op.as_deref().unwrap(),
                cli.args.as_deref().unwrap_or("{}"),
                cli.approve,
            ),
        ),
        "audit" => to_cli_err(
            ErrorKind::Op,
            run_audit(
                &repo_root,
                &data_dir,
                cli.audit.as_deref().unwrap(),
                &trace_id,
            ),
        ),
        _ => Err((
            ErrorKind::Usage,
            "需指定 --round / --op / --os-op / --audit 之一".to_string(),
        )),
    };

    match &handled {
        Ok(_) => eprintln!(
            "[headless] trace_id={} command={} status=ok",
            trace_id, command
        ),
        Err((kind, message)) => eprintln!(
            "[headless] trace_id={} command={} status=error kind={} message={}",
            trace_id,
            command,
            kind_str(*kind),
            message
        ),
    }

    let envelope = match handled {
        Ok(data) => Envelope {
            ok: true,
            trace_id: &trace_id,
            command,
            data: Some(data),
            error: None,
        },
        Err((kind, message)) => Envelope {
            ok: false,
            trace_id: &trace_id,
            command,
            data: None,
            error: Some(EnvelopeError {
                kind: kind_str(kind),
                message,
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

    exit(if envelope.ok { 0 } else { 1 });
}

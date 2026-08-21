//! 协议 conformance 测试的进程辅助：spawn 真实二进制 + 喂 JSON 行。
//!
//! 经 CARGO_BIN_EXE_* 环境变量定位编译产物（cargo 集成测试内置机制），
//! 以管道接管 stdin/stdout，stderr 由独立线程排空并收集（管道缓冲有限，
//! 不排空会阻塞服务端；收集结果供日志通道断言用）。数据目录显式指向
//! 夹具目录（INKLING_SEED_DATA），保证测试不依赖运行环境的 seed_data。

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};

pub struct ExecProcess {
    pub stdin: Option<ChildStdin>,
    pub stdout: BufReader<ChildStdout>,
    /// stderr 结构化日志行（服务端 trace 通道，断言可观测性用）
    pub stderr_lines: Arc<Mutex<Vec<String>>>,
    pub child: Child,
}

pub fn spawn() -> ExecProcess {
    let fixtures = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let bin = env!("CARGO_BIN_EXE_inkling_exec");
    let mut child = Command::new(bin)
        .env("INKLING_SEED_DATA", fixtures)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn inkling_exec 失败");
    let stdin = child.stdin.take().expect("stdin 管道");
    let stdout = BufReader::new(child.stdout.take().expect("stdout 管道"));
    let stderr = child.stderr.take().expect("stderr 管道");
    let stderr_lines = Arc::new(Mutex::new(Vec::new()));
    let collector = Arc::clone(&stderr_lines);
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        // 逐行匹配而非 filter_map(Result::ok)：管道读错（Err）即停止收集，
        // 避免错误被无限吞掉造成空转（收集线程随管道关闭自然结束）
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if let Ok(mut lines) = collector.lock() {
                        lines.push(line);
                    }
                }
                Err(_) => break,
            }
        }
    });
    ExecProcess {
        stdin: Some(stdin),
        stdout,
        stderr_lines,
        child,
    }
}

impl ExecProcess {
    /// 写一行请求并读一行响应（成功路径与错误路径共用；响应为原始行）。
    pub fn roundtrip(&mut self, line: &str) -> String {
        let mut response = String::new();
        {
            let stdin = self.stdin.as_mut().expect("stdin 已关闭");
            writeln!(stdin, "{}", line).expect("写请求失败");
            stdin.flush().expect("flush 失败");
        }
        self.stdout
            .read_line(&mut response)
            .expect("读响应失败（服务端是否提前退出？）");
        response
    }

    /// 只写不读（通知语义：断言服务端不响应、不崩溃）。
    pub fn send_no_reply(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin 已关闭");
        writeln!(stdin, "{}", line).expect("写请求失败");
        stdin.flush().expect("flush 失败");
    }

    /// 关闭 stdin（EOF）→ 服务端应优雅退出，返回退出码。
    pub fn close_and_wait(&mut self) -> i32 {
        drop(self.stdin.take());
        self.child
            .wait()
            .map(|s| s.code().unwrap_or(-1))
            .expect("wait 失败")
    }

    pub fn stderr_logs(&self) -> Vec<String> {
        self.stderr_lines.lock().unwrap().clone()
    }
}

/// 响应行 → JSON 值（测试断言用；畸形响应直接 panic 暴露协议破损）。
pub fn parse_response(line: &str) -> inkling_exec::json::Value {
    inkling_exec::json::parse(line)
        .unwrap_or_else(|e| panic!("响应不是合法 JSON: {}（原始: {}）", e, line))
}

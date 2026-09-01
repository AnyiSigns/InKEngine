//! InKling 出厂自检编排：七门禁一键矩阵化报告。
//!
//! 单个命令跑七项门禁（schema 数据一致性 / cargo 三 crate /
//! frontend typecheck+vitest / 接线 e2e / 代码纪律 / 公开评测基准 /
//! 符号引用计数），输出每项的命令、状态、耗时与输出摘要；任一失败结构化
//! 显示并以非零退出码结束。
//!
//! 子命令：`schema` / `cargo` / `frontend` / `e2e` / `discipline` /
//! `benchmark` / `symbols` / `all`（默认）。
//! 门禁命令的事实源 = manifest.json `self_check` 表：`all` 聚合模式**真正执行**
//! 表内声明的命令（单一事实源不名不副实——声明命令与实际执行同一路径），
//! 子命令直调模式 = 该命令指向的同一门禁在本进程内执行（快速局部复验）。
//! 任一 manifest 命令缺表项即结构化失败，不允许静默跳过。

mod discipline;
mod process_util;
mod report;
mod schema;
mod symbols;
mod validator;

use report::GateResult;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 仓库根定位：显式 --root > 环境变量 > 编译期清单目录 > 工作目录逐级上溯。
fn resolve_repo_root(explicit: Option<&str>) -> PathBuf {
    let candidate = if let Some(root) = explicit {
        PathBuf::from(root)
    } else if let Ok(root) = std::env::var("INKLING_REPO_ROOT") {
        if !root.is_empty() {
            PathBuf::from(root)
        } else {
            builtin_repo_root()
        }
    } else {
        builtin_repo_root()
    };
    canonical_root(candidate)
}

fn builtin_repo_root() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let from_build = manifest_dir.join("../..");
    if looks_like_repo_root(&from_build) {
        return from_build;
    }
    let mut cursor = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    loop {
        if looks_like_repo_root(&cursor) {
            return cursor;
        }
        if !cursor.pop() {
            break;
        }
    }
    from_build
}

/// 规范化路径（去掉 .. 分量与 Windows 长路径前缀，展示与比对一致）。
fn canonical_root(path: PathBuf) -> PathBuf {
    let canonical = path.canonicalize().unwrap_or(path);
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        let stripped = text.strip_prefix(r"\\?\").unwrap_or(&text);
        PathBuf::from(stripped)
    }
    #[cfg(not(windows))]
    {
        canonical
    }
}

fn looks_like_repo_root(path: &Path) -> bool {
    path.join("inkling").join("manifest.json").is_file()
        && path.join("ink_engine").join("pyproject.toml").is_file()
}

/// 单门禁超时（秒）：cargo 首次构建/e2e 全量耗时较长，超时按失败
/// 结构化呈现（不裸抛、不悬挂）。
const TIMEOUT_CARGO_EXEC_SECS: u64 = 600;
const TIMEOUT_CARGO_SHELL_SECS: u64 = 1800;
const TIMEOUT_CARGO_SELF_SECS: u64 = 300;
const TIMEOUT_FRONTEND_SECS: u64 = 900;
const TIMEOUT_E2E_SECS: u64 = 2400;
const TIMEOUT_PROBE_SECS: u64 = 900;

/// 门禁失败修复指引（人类可读，出厂遇到红时的第一步方向）。
const GATE_HINTS: [(&str, &str); 7] = [
    (
        "schema",
        "seed_data 或 schema 定义问题：按上方 [FAIL] 违规清单定位修复后重跑",
    ),
    (
        "cargo_test",
        "Rust crate 问题：按 cargo 输出定位（编译/断言）；首次运行会自动构建",
    ),
    (
        "frontend",
        "TS 前端问题：npm --prefix inkling/frontend install 后重跑",
    ),
    (
        "e2e",
        "接线 e2e 问题：按 cargo 输出定位；引擎环境依赖仓库根 .venv（junction 或 PYO3_PYTHON）安装 ink_engine",
    ),
    (
        "discipline",
        "代码纪律违例：注释/文案含计划编号或推进字眼——改写为叙述句（信息量不降），禁用字眼清单见计划 B2 节",
    ),
    (
        "benchmark",
        "公开评测基准未达标：引擎基准（组装<500ms / 缓存≥60% / spawn<2s）或自举回归（既有引擎测试）失败；按 run_benchmarks 输出定位，先本地重跑 tools/benchmarks/run_benchmarks.py",
    ),
    (
        "symbols",
        "符号引用计数门禁存在孤儿：定义的 Python def/Rust pub 项在文件内仅出现 1 次——按 [ORPHAN] 列表补接线（同文件再调一次）或显式删除（删除走 git revert 重跑门禁验证）",
    ),
];

/// 自检命令事实源：manifest.json self_check 表（七门禁命令单一事实源；
/// `all` 聚合模式按此表真实执行，不重复声明命令）。
fn load_self_check_commands(manifest_path: &Path) -> Result<Vec<(String, String)>, String> {
    let text = std::fs::read_to_string(manifest_path)
        .map_err(|err| format!("manifest 读取失败: {err}"))?;
    let manifest: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| format!("manifest JSON 解析失败: {err}"))?;
    let self_check = manifest
        .get("self_check")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "manifest.json 缺 self_check 门禁表（出厂门禁入口无法聚合）".to_string())?;
    let mut commands = Vec::with_capacity(7);
    for key in ["schema", "cargo_test", "frontend", "e2e", "discipline", "benchmark", "symbols"] {
        let command = self_check
            .get(key)
            .and_then(serde_json::Value::as_object)
            .and_then(|entry| entry.get("command"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if command.is_empty() {
            return Err(format!("manifest.self_check.{key} 缺命令声明（命令单一事实源不完整）"));
        }
        commands.push((key.to_string(), command.to_string()));
    }
    Ok(commands)
}

fn gate_label(key: &str) -> &'static str {
    match key {
        "schema" => "数据 schema",
        "cargo_test" => "机制件 cargo test",
        "frontend" => "前端 typecheck+vitest",
        "e2e" => "接线 e2e 全量",
        "discipline" => "代码纪律（B2 零计划痕迹）",
        "benchmark" => "公开评测基准（P5.2）",
        "symbols" => "符号引用计数（E-P14 孤儿扫描）",
        _ => "未知门禁",
    }
}

/// 解析嵌入式引擎的解释器（PYO3_PYTHON > 仓库根 .venv > PATH 的 python）。
fn resolve_python_exe(repo_root: &Path) -> Option<PathBuf> {
    if let Ok(pyo3_python) = std::env::var("PYO3_PYTHON") {
        if !pyo3_python.is_empty() {
            let path = PathBuf::from(pyo3_python);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    #[cfg(windows)]
    {
        for relative in [".venv/Scripts/python.exe", ".venv/python.exe"] {
            let path = repo_root.join(relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let path = repo_root.join(".venv/bin/python");
        if path.is_file() {
            return Some(path);
        }
    }
    if std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(if cfg!(windows) { "python.exe" } else { "python" }))
                .any(|candidate| candidate.is_file())
        })
        .unwrap_or(false)
    {
        return Some(PathBuf::from(if cfg!(windows) { "python.exe" } else { "python" }));
    }
    None
}

/// Windows 下 pyo3 嵌入式解释器的运行时 DLL 目录（best-effort）：
/// 优先 .venv 的 pyvenv.cfg home（基座解释器目录含 python DLL），
/// 其次解释器所在目录（PYO3_PYTHON 直指基座解释器时成立）。
fn python_dll_dir(repo_root: &Path, python_exe: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for pyvenv in [repo_root.join(".venv/pyvenv.cfg"), python_exe.join("../../pyvenv.cfg")] {
        if let Ok(cfg) = std::fs::read_to_string(&pyvenv) {
            if let Some(home) = cfg
                .lines()
                .find_map(|line| line.trim().strip_prefix("home = "))
                .map(|home| PathBuf::from(home.trim()))
            {
                candidates.push(home);
            }
        }
    }
    if let Some(parent) = python_exe.parent() {
        candidates.push(parent.to_path_buf());
    }
    #[cfg(windows)]
    {
        candidates
            .into_iter()
            .find(|dir| dir.is_dir())
    }
    #[cfg(not(windows))]
    {
        let _ = candidates;
        None
    }
}

fn gate_discipline_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let started = Instant::now();
    let hits = discipline::run(repo_root);
    let seconds = started.elapsed().as_secs_f64();
    let passed = hits.is_empty();
    let detail = if passed {
        "代码纪律全绿：代码/测试/seed 文案内零计划编号与推进字眼，注释为叙述口吻".to_string()
    } else {
        let mut text = String::new();
        for hit in &hits {
            text.push_str(&format!("[FAIL] {hit}\n"));
        }
        text
    };
    let summary = if passed {
        detail.clone()
    } else {
        hits.first().cloned().unwrap_or_else(|| "代码纪律存在违例".to_string())
    };
    let result = GateResult {
        key: "discipline".to_string(),
        label: "代码纪律（B2 零计划痕迹）".to_string(),
        command: manifest_command.to_string(),
        passed,
        seconds,
        summary,
        tail: report::tail_lines(&detail),
    };
    (result, detail)
}

/// e2e 前置检查：解释器存在 + 引擎可导入；失败给修复指引。
fn e2e_preflight(repo_root: &Path) -> Result<PathBuf, String> {
    let Some(python_exe) = resolve_python_exe(repo_root) else {
        return Err(format!(
            "未找到可用的 Python 解释器：设 PYO3_PYTHON 指向仓库根 .venv 的 python（Windows: {}/.venv/Scripts/python.exe；或建 .venv junction 指向主仓 .venv）",
            repo_root.display()
        ));
    };
    let probe = process_util::run_command(
        &[
            python_exe.to_string_lossy().into_owned(),
            "-c".to_string(),
            "import ink_engine".to_string(),
        ],
        repo_root,
        Duration::from_secs(60),
        None,
    );
    if !probe.passed() {
        return Err(format!(
            "引擎不可导入（{}）：{}——修复指引：仓库根 .venv 安装引擎（pip install -e \"ink_engine[test,sqlite,llm,mcp]\"，pip 不稳时加 --proxy http://127.0.0.1:7890）",
            python_exe.display(),
            report::failure_summary(&probe.output)
        ));
    }
    Ok(python_exe.to_path_buf())
}

// ── 各门禁实现 ──

/// 符号引用计数门禁（E-P14）：扫描 ink_engine/core 与壳侧 Rust 的孤儿符号。
///
/// 轻量正则扫描（不依赖 syn/pyo3 解析），零重依赖可在本进程内热跑；
/// 误报由维护者按 [ORPHAN] 列表半自动甄别（补接线或显式删除）。
fn gate_symbols_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let started = Instant::now();
    let report = symbols::run(repo_root);
    let seconds = started.elapsed().as_secs_f64();
    let passed = report.is_clean();
    let summary = report.summary();
    let mut detail = String::new();
    if passed {
        detail.push_str(&format!(
            "[OK] 扫描 {} 个 Python 文件 + {} 个 Rust 文件，零孤儿符号\n",
            report.python_scanned, report.rust_scanned
        ));
    } else {
        detail.push_str(&report.render_issues());
    }
    let result = GateResult {
        key: "symbols".to_string(),
        label: gate_label("symbols").to_string(),
        command: manifest_command.to_string(),
        passed,
        seconds,
        summary,
        tail: report::tail_lines(&detail),
    };
    (result, detail)
}

/// 公开评测基准门禁：运行 tools/benchmarks/run_benchmarks.py 编排器。
///
/// 该脚本串联四类基准（引擎基准 / OS 操作 / 复杂项目 / 自举演示）。引擎基准与
/// 自举回归为硬门禁（非零退出即失败）；OS 与复杂基准在门禁内走离线/冒烟口径，
/// 真实达标率以 live 环境复核。脚本依赖 Python 解释器与可导入的 ink_engine
/// （与 e2e 门禁同一套解释器解析逻辑）。
fn gate_benchmark_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let Some(python_exe) = resolve_python_exe(repo_root) else {
        let summary = "未找到可用的 Python 解释器：设 PYO3_PYTHON 指向仓库根 .venv 的 python（Windows: .venv/Scripts/python.exe）".to_string();
        let result = GateResult {
            key: "benchmark".to_string(),
            label: "公开评测基准（P5.2）".to_string(),
            command: manifest_command.to_string(),
            passed: false,
            seconds: 0.0,
            summary: summary.clone(),
            tail: summary.clone(),
        };
        return (result, summary);
    };
    let script = repo_root
        .join("tools")
        .join("benchmarks")
        .join("run_benchmarks.py");
    let argv = vec![
        python_exe.to_string_lossy().into_owned(),
        script.to_string_lossy().into_owned(),
    ];
    let (result, full) = run_external_full(
        "benchmark",
        "公开评测基准（P5.2）",
        &argv.join(" "),
        &argv,
        repo_root,
        Duration::from_secs(TIMEOUT_PROBE_SECS),
        None,
    );
    (result, full)
}

/// 运行单个外部命令并结构化为门禁结果（返回完整输出供 --full 展示）。
fn run_external_full(
    key: &str,
    label: &str,
    command: &str,
    argv: &[String],
    repo_root: &Path,
    timeout: Duration,
    extra_path: Option<&Path>,
) -> (GateResult, String) {
    let started = Instant::now();
    let outcome = process_util::run_command(argv, repo_root, timeout, extra_path);
    let seconds = started.elapsed().as_secs_f64();
    let (passed, summary) = if outcome.spawn_error.is_some() {
        (false, outcome.output.clone())
    } else if outcome.timed_out {
        (
            false,
            format!("超时（> {:.0}s）", timeout.as_secs_f64()),
        )
    } else {
        let passed = outcome.passed();
        let summary = if passed {
            report::summarize(&outcome.output, key)
        } else {
            report::failure_summary(&outcome.output)
        };
        (passed, summary)
    };
    let result = GateResult {
        key: key.to_string(),
        label: label.to_string(),
        command: command.to_string(),
        passed,
        seconds,
        summary,
        tail: report::tail_lines(&outcome.output),
    };
    (result, outcome.output)
}

fn gate_schema_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let started = Instant::now();
    let report = schema::run(repo_root);
    let seconds = started.elapsed().as_secs_f64();
    let passed = report.issues.is_empty();
    let mut summary = if passed {
        report
            .facts
            .first()
            .cloned()
            .unwrap_or_else(|| "schema 全绿".to_string())
    } else {
        report
            .issues
            .first()
            .cloned()
            .unwrap_or_else(|| "schema 存在违规".to_string())
    };
    if summary.chars().count() > 120 {
        summary = summary.chars().take(120).collect();
    }
    let mut detail = String::new();
    for issue in &report.issues {
        detail.push_str(&format!("[FAIL] {issue}\n"));
    }
    if passed {
        for fact in &report.facts {
            detail.push_str(&format!("[OK] {fact}\n"));
        }
    }
    let result = GateResult {
        key: "schema".to_string(),
        label: gate_label("schema").to_string(),
        command: manifest_command.to_string(),
        passed,
        seconds,
        summary,
        tail: report::tail_lines(&detail),
    };
    (result, detail)
}



fn gate_cargo_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let crates = [
        ("exec", "inkling/exec/Cargo.toml", Duration::from_secs(TIMEOUT_CARGO_EXEC_SECS)),
        ("shell", "inkling/shell/src-tauri/Cargo.toml", Duration::from_secs(TIMEOUT_CARGO_SHELL_SECS)),
        ("self_check", "inkling/self_check/Cargo.toml", Duration::from_secs(TIMEOUT_CARGO_SELF_SECS)),
    ];
    // 壳 crate 测试内嵌 Python 引擎：Windows 下解释器 DLL 目录须入 PATH
    // （与 e2e 门禁同口径；找不到解释器时照常执行，由 cargo 输出定位）
    let dll_dir = resolve_python_exe(repo_root)
        .and_then(|python_exe| python_dll_dir(repo_root, &python_exe));
    let started = Instant::now();
    let mut parts: Vec<String> = Vec::new();
    let mut full = String::new();
    let mut all_passed = true;
    for (name, manifest_path, timeout) in crates {
        let argv = vec![
            "cargo".to_string(),
            "test".to_string(),
            "--manifest-path".to_string(),
            repo_root.join(manifest_path).to_string_lossy().into_owned(),
        ];
        let (result, crate_full) = run_external_full(
            "cargo_test",
            &format!("cargo test（{name}）"),
            &argv.join(" "),
            &argv,
            repo_root,
            timeout,
            dll_dir.as_deref(),
        );
        parts.push(format!(
            "{}: {}（{:.1}s）",
            name,
            if result.passed { "PASS" } else { "FAIL" },
            result.seconds
        ));
        if !result.passed {
            all_passed = false;
            parts.push(result.summary.clone());
        }
        full.push_str(&format!("===== crate {name} =====\n{crate_full}\n"));
    }
    let seconds = started.elapsed().as_secs_f64();
    let result = GateResult {
        key: "cargo_test".to_string(),
        label: gate_label("cargo_test").to_string(),
        command: manifest_command.to_string(),
        passed: all_passed,
        seconds,
        summary: parts.join("；"),
        tail: report::tail_lines(&parts.join("\n")),
    };
    (result, full)
}



fn gate_frontend_full(repo_root: &Path, manifest_command: &str) -> (GateResult, String) {
    let started = Instant::now();
    let mut parts: Vec<String> = Vec::new();
    let mut full = String::new();
    let mut all_passed = true;
    for (name, args) in [
        ("typecheck", vec!["npm", "--prefix", "inkling/frontend", "run", "typecheck"]),
        ("vitest", vec!["npm", "--prefix", "inkling/frontend", "run", "test"]),
    ] {
        let argv: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
        let (result, gate_full) = run_external_full(
            "frontend",
            &format!("frontend（{name}）"),
            &argv.join(" "),
            &argv,
            repo_root,
            Duration::from_secs(TIMEOUT_FRONTEND_SECS),
            None,
        );
        parts.push(format!(
            "{}: {}（{:.1}s）",
            name,
            if result.passed { "PASS" } else { "FAIL" },
            result.seconds
        ));
        if !result.passed {
            all_passed = false;
            parts.push(result.summary.clone());
        }
        full.push_str(&format!("===== frontend {name} =====\n{gate_full}\n"));
    }
    let seconds = started.elapsed().as_secs_f64();
    let result = GateResult {
        key: "frontend".to_string(),
        label: gate_label("frontend").to_string(),
        command: manifest_command.to_string(),
        passed: all_passed,
        seconds,
        summary: parts.join("；"),
        tail: report::tail_lines(&parts.join("\n")),
    };
    (result, full)
}



fn gate_e2e_full(repo_root: &Path, manifest_command: &str, live: bool) -> (GateResult, String) {
    let started = Instant::now();
    let mut parts: Vec<String> = Vec::new();
    let mut full = String::new();
    let python_exe = match e2e_preflight(repo_root) {
        Ok(python_exe) => {
            parts.push(format!(
                "前置检查: Python={} 引擎可导入",
                python_exe.display()
            ));
            python_exe
        }
        Err(err) => {
            let result = GateResult {
                key: "e2e".to_string(),
                label: gate_label("e2e").to_string(),
                command: manifest_command.to_string(),
                passed: false,
                seconds: started.elapsed().as_secs_f64(),
                summary: err.clone(),
                tail: err.clone(),
            };
            return (result, err);
        }
    };
    let dll_dir = python_dll_dir(repo_root, &python_exe);
    let argv = vec![
        "cargo".to_string(),
        "test".to_string(),
        "--manifest-path".to_string(),
        repo_root
            .join("inkling/shell/src-tauri/Cargo.toml")
            .to_string_lossy()
            .into_owned(),
    ];
    let (shell_result, shell_full) = run_external_full(
        "e2e",
        "壳 crate 全量测试",
        &argv.join(" "),
        &argv,
        repo_root,
        Duration::from_secs(TIMEOUT_E2E_SECS),
        dll_dir.as_deref(),
    );
    let mut passed = shell_result.passed;
    parts.push(format!("壳测试: {}", if passed { "PASS" } else { "FAIL" }));
    if !passed {
        parts.push(shell_result.summary.clone());
    }
    full.push_str(&format!("===== 壳 crate 全量测试 =====\n{shell_full}\n"));
    if live {
        parts.push("推理清洁度实弹探针（--live）：运行 tools/probe_reasoning_clean.py（需 .kilo/测试模型配置.txt 的 LLM key）".to_string());
        let probe_argv = vec![
            python_exe.to_string_lossy().into_owned(),
            "tools/probe_reasoning_clean.py".to_string(),
        ];
        let (probe_result, probe_full) = run_external_full(
            "e2e",
            "推理清洁度实弹探针",
            &probe_argv.join(" "),
            &probe_argv,
            repo_root,
            Duration::from_secs(TIMEOUT_PROBE_SECS),
            None,
        );
        passed = passed && probe_result.passed;
        parts.push(format!(
            "实弹探针: {}（{:.1}s）",
            if probe_result.passed { "PASS" } else { "FAIL" },
            probe_result.seconds
        ));
        if !probe_result.passed {
            parts.push(probe_result.summary.clone());
        }
        full.push_str(&format!("===== 实弹探针 =====\n{probe_full}\n"));
    } else {
        parts.push("实弹探针: 跳过（--live 显式运行；发布前手动跑一次）".to_string());
    }
    let seconds = started.elapsed().as_secs_f64();
    let result = GateResult {
        key: "e2e".to_string(),
        label: gate_label("e2e").to_string(),
        command: manifest_command.to_string(),
        passed,
        seconds,
        summary: parts.join("；"),
        tail: report::tail_lines(&parts.join("\n")),
    };
    (result, full)
}

// ── 入口 ──

struct Args {
    gate: String,
    live: bool,
    full: bool,
    json: bool,
    root: Option<String>,
}

fn parse_args() -> Args {
    let mut args = Args {
        gate: "all".to_string(),
        live: false,
        full: false,
        json: false,
        root: None,
    };
    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--live" => args.live = true,
            "--full" => args.full = true,
            "--json" => args.json = true,
            "--root" => {
                if let Some(root) = raw.next() {
                    args.root = Some(root);
                }
            }
            other => {
                if other.starts_with("--root=") {
                    args.root = Some(other["--root=".len()..].to_string());
                } else if ["schema", "cargo", "cargo_test", "frontend", "e2e", "discipline", "benchmark", "symbols", "all"]
                    .contains(&other)
                {
                    args.gate = other.to_string();
                }
            }
        }
    }
    args
}

/// 聚合模式的门禁子进程超时（外层保险；内层门禁自带更细粒度的子超时）。
fn gate_spawn_timeout_secs(key: &str) -> u64 {
    match key {
        "schema" => TIMEOUT_CARGO_SELF_SECS + 120,
        "cargo_test" => TIMEOUT_CARGO_EXEC_SECS + TIMEOUT_CARGO_SHELL_SECS + TIMEOUT_CARGO_SELF_SECS + 600,
        "frontend" => TIMEOUT_FRONTEND_SECS + 300,
        "e2e" => TIMEOUT_E2E_SECS + TIMEOUT_PROBE_SECS + 300,
        "discipline" => 600,
        "benchmark" => TIMEOUT_PROBE_SECS + 300,
        "symbols" => 120,
        _ => 600,
    }
}

/// 真正执行 manifest `self_check` 表声明的门禁命令（命令单一事实源）：
/// 退出码 = PASS/FAIL 判定，内层进程输出 = 门禁明细（--full 可见完整输出）。
/// `--live` 仅透传给 e2e 门禁（推理清洁度实弹探针）。
fn run_manifest_gate(
    repo_root: &Path,
    key: &str,
    command: &str,
    live: bool,
) -> (GateResult, String) {
    let mut argv: Vec<String> = command.split_whitespace().map(String::from).collect();
    if key == "e2e" && live {
        argv.push("--live".to_string());
    }
    let timeout = Duration::from_secs(gate_spawn_timeout_secs(key));
    let started = Instant::now();
    let outcome = process_util::run_command(&argv, repo_root, timeout, None);
    let seconds = started.elapsed().as_secs_f64();
    let passed = outcome.spawn_error.is_none() && !outcome.timed_out && outcome.passed();
    let (summary, detail) = if let Some(spawn_error) = &outcome.spawn_error {
        let text = format!("门禁命令启动失败: {spawn_error}");
        (text.clone(), text)
    } else if outcome.timed_out {
        let text = format!("门禁命令超时（> {:.0}s）", timeout.as_secs_f64());
        (text.clone(), text)
    } else if passed {
        let summary = report::summarize(&outcome.output, key);
        (summary, outcome.output.clone())
    } else {
        let summary = report::failure_summary(&outcome.output);
        (summary, outcome.output.clone())
    };
    let result = GateResult {
        key: key.to_string(),
        label: gate_label(key).to_string(),
        command: command.to_string(),
        passed,
        seconds,
        summary,
        tail: report::tail_lines(&detail),
    };
    (result, detail)
}

fn main() {
    let args = parse_args();
    let repo_root = resolve_repo_root(args.root.as_deref());
    let manifest_path = repo_root.join("inkling/manifest.json");
    let commands = match load_self_check_commands(&manifest_path) {
        Ok(commands) => commands,
        Err(err) => {
            eprintln!("[self_check] 门禁配置读取失败: {err}");
            std::process::exit(2);
        }
    };
    let command_of = |manifest_key: &str| -> &str {
        commands
            .iter()
            .find(|(key, _)| key == manifest_key)
            .map(|(_, command)| command.as_str())
            .unwrap_or("（manifest 缺该门禁命令声明）")
    };

    print!(
        "InKling 出厂自检矩阵（七门禁一键）\n入口：inkling/self_check（Rust 编排）｜ 仓库根: {}\n门禁命令 = manifest.json self_check（单一事实源，聚合模式真实执行）\n\n",
        repo_root.display()
    );

    let mut results: Vec<GateResult> = Vec::new();
    let mut full_outputs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut run_gate = |result: GateResult, full: String| {
        if !result.passed {
            full_outputs.insert(result.key.clone(), full);
        }
        results.push(result);
    };

    // 子命令直调 = manifest 命令指向的同一门禁在本进程内执行（快速局部复验）。
    // W-8 修复：manifest key（cargo_test）与子命令名（cargo）双名同义，两种
    // 写法都可直调（manifest.json 是单一事实源，key 形态不被破坏）。
    let manifest_key_of = |sub: &str| -> &'static str {
        match sub {
            "schema" => "schema",
            "cargo" | "cargo_test" => "cargo_test",
            "frontend" => "frontend",
            "e2e" => "e2e",
            "discipline" => "discipline",
            "benchmark" => "benchmark",
            "symbols" => "symbols",
            _ => "schema",
        }
    };
    if args.gate != "all" {
        let key = manifest_key_of(args.gate.as_str());
        let command = command_of(key);
        let (result, full) = match args.gate.as_str() {
            "schema" => gate_schema_full(&repo_root, command),
            "cargo" | "cargo_test" => gate_cargo_full(&repo_root, command),
            "frontend" => gate_frontend_full(&repo_root, command),
            "e2e" => gate_e2e_full(&repo_root, command, args.live),
            "discipline" => gate_discipline_full(&repo_root, command),
            "benchmark" => gate_benchmark_full(&repo_root, command),
            "symbols" => gate_symbols_full(&repo_root, command),
            _ => unreachable!("parse_args 只接受已知子命令"),
        };
        run_gate(result, full);
    } else {
        // 聚合模式：真正执行 manifest self_check 表声明的全部命令
        for (key, command) in &commands {
            let (result, full) = run_manifest_gate(&repo_root, key, command, args.live);
            run_gate(result, full);
        }
    }

    for result in &results {
        println!(
            "== 门禁 {}（{}）: {}",
            result.label, result.key, result.command
        );
        println!(
            "   状态 {} ｜ 耗时 {:6.1}s ｜ {}",
            if result.passed { "PASS" } else { "FAIL" },
            result.seconds,
            result.summary
        );
        if !result.passed {
            println!("   —— 失败输出尾部（--full 查看完整输出）——");
            if args.full {
                for line in result.tail.lines() {
                    println!("   | {line}");
                }
                println!("   —— 完整输出 ——");
                if let Some(full) = full_outputs.get(&result.key) {
                    for line in full.lines() {
                        println!("   | {line}");
                    }
                }
            } else {
                for line in result.tail.lines() {
                    println!("   | {line}");
                }
            }
            let hint = GATE_HINTS
                .iter()
                .find(|(key, _)| *key == result.key)
                .map(|(_, hint)| *hint)
                .unwrap_or("见门禁输出");
            println!("   —— 修复方向：{hint}");
        }
    }

    println!("\n{}", report::render_matrix(&results));

    if args.json {
        let json_report = serde_json::json!({
            "repo_root": repo_root.to_string_lossy(),
            "gates": results,
            "overall": if results.iter().all(|result| result.passed) { "pass" } else { "fail" },
        });
        println!("\n{}", serde_json::to_string_pretty(&json_report).unwrap_or_default());
    }

    let failed: Vec<&GateResult> = results.iter().filter(|result| !result.passed).collect();
    if !failed.is_empty() {
        println!("\n自检未全绿：");
        for result in &failed {
            println!("  - FAIL {}：{}", result.label, result.summary);
            let hint = GATE_HINTS
                .iter()
                .find(|(key, _)| *key == result.key)
                .map(|(_, hint)| *hint)
                .unwrap_or("见门禁输出");
            println!("    修复方向：{hint}");
        }
        std::process::exit(1);
    }
    println!("\n自检全绿：七门禁全部 PASS（schema 数据一致性 / cargo 三 crate / frontend / 接线 e2e / 代码纪律 / 公开评测基准 / 符号引用计数）");
}



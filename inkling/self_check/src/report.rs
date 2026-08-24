//! 报告渲染：矩阵化定宽表 + 输出摘要/失败行提取（结构化可读）。

/// 输出摘要长度上限（超长截断，保持矩阵可读）。
const SUMMARY_MAX: usize = 120;

/// 从 `N passed` 文本提取通过数（0 缺省；N 与 passed 为相邻 token）。
fn passed_count(line: &str) -> usize {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (index, token) in tokens.iter().enumerate() {
        let cleaned = token.trim_end_matches([';', ',']);
        if cleaned == "passed" && index > 0 {
            if let Ok(count) = tokens[index - 1].trim_end_matches([';', ',']).parse::<usize>() {
                return count;
            }
        }
    }
    0
}

/// 输出摘要：优先匹配已知结论行（cargo/pytest/tsc/schema），缺省取
/// 末尾非空行——失败门禁另有失败行提取，两者不混淆。
///
/// cargo 多段 `test result`（lib/集成/doc）取通过数最大的一段，避免
/// doc-test 的「0 passed」误导摘要；typecheck 零错且无输出的门禁按
/// 门禁语义给规范摘要（tsc 成功时无结论行是常态）。
pub fn summarize(output: &str, key: &str) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let result_lines: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line.contains("test result:"))
        .collect();
    if !result_lines.is_empty() {
        let best = result_lines
            .iter()
            .max_by_key(|line| passed_count(line))
            .copied()
            .unwrap_or("");
        if passed_count(best) > 0 || result_lines.len() == 1 {
            return truncate(best);
        }
    }
    for line in lines.iter().rev() {
        if line.contains("Found 0 errors") {
            return truncate(line);
        }
        if line.starts_with("全绿：") || line.contains("schema 校验通过") {
            return truncate(line);
        }
        if line.contains("passed") && line.contains("skipped") {
            return truncate(line);
        }
        if line.contains("passed") && line.contains("failed") {
            return truncate(line);
        }
    }
    if key == "frontend" {
        return "typecheck 零错（tsc 无结论行，退出码 0）".to_string();
    }
    lines
        .last()
        .map(|line| truncate(line))
        .unwrap_or_else(|| "（无输出）".to_string())
}

/// 失败摘要：取错误/失败类行（保持可读，截断）。
pub fn failure_summary(output: &str) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let hit = lines
        .iter()
        .copied()
        .find(|line| is_failure_line(line))
        .unwrap_or_else(|| lines.last().copied().unwrap_or(""));
    truncate(hit)
}

fn is_failure_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    ["error", "failed", "failures", "exception", "not found"]
        .iter()
        .any(|marker| lower.contains(marker))
        && !line.starts_with("::")
}

/// 截断到摘要上限（中文字符按字符数计，不劈半）。
fn truncate(text: &str) -> String {
    text.chars().take(SUMMARY_MAX).collect()
}

/// 门禁结果（矩阵行 + JSON 报告共用的数据形态）。
#[derive(Debug, serde::Serialize)]
pub struct GateResult {
    pub key: String,
    pub label: String,
    pub command: String,
    pub passed: bool,
    pub seconds: f64,
    pub summary: String,
    pub tail: String,
}

/// 门禁失败尾部留痕（最近 12 行，定位用）。
pub fn tail_lines(output: &str) -> String {
    output.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
}

/// 矩阵化报告（定宽文本表：门禁/命令/状态/耗时/摘要）。
pub fn render_matrix(results: &[GateResult]) -> String {
    let headers = ["门禁", "命令", "状态", "耗时", "输出摘要"];
    let rows: Vec<Vec<String>> = results
        .iter()
        .map(|result| {
            vec![
                format!("{}（{}）", result.label, result.key),
                result.command.clone(),
                if result.passed { "PASS".to_string() } else { "FAIL".to_string() },
                format!("{:6.1}s", result.seconds),
                result.summary.clone(),
            ]
        })
        .collect();
    let mut widths: Vec<usize> = headers.iter().map(|header| header.chars().count()).collect();
    for row in &rows {
        for (index, cell) in row.iter().enumerate() {
            widths[index] = widths[index].max(cell.chars().count());
        }
    }
    let border = |widths: &[usize]| {
        let mut line = String::from("+");
        for width in widths {
            line.push_str(&"-".repeat(width + 2));
            line.push('+');
        }
        line
    };
    let render_row = |cells: &[String], widths: &[usize]| {
        let mut line = String::from("|");
        for (index, cell) in cells.iter().enumerate() {
            line.push_str(&format!(" {:<width$} ", cell, width = widths[index]));
            line.push('|');
        }
        line
    };
    let mut out = Vec::new();
    out.push(border(&widths));
    out.push(render_row(&headers.map(|header| header.to_string()).to_vec(), &widths));
    out.push(border(&widths));
    for row in &rows {
        out.push(render_row(row, &widths));
    }
    out.push(border(&widths));
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passed_count_parses_adjacent_tokens() {
        assert_eq!(passed_count("test result: ok. 360 passed; 0 failed; 2 skipped"), 360);
        assert_eq!(passed_count("test result: ok. 0 passed; 0 failed; 1 ignored"), 0);
        assert_eq!(passed_count("no numbers here"), 0);
    }

    #[test]
    fn summarize_takes_max_passed_result_line() {
        let output = "running 3 tests\n\
                      test result: ok. 0 passed; 0 failed; 1 ignored\n\
                      test result: ok. 17 passed; 0 failed\n\
                      test result: ok. 9 passed; 0 failed\n";
        assert!(summarize(output, "cargo").contains("17 passed"));
    }

    #[test]
    fn summarize_frontend_canonical_when_silent() {
        assert_eq!(
            summarize("", "frontend"),
            "typecheck 零错（tsc 无结论行，退出码 0）"
        );
        assert!(summarize("Found 0 errors in 42 files", "frontend").contains("Found 0 errors"));
    }

    #[test]
    fn failure_summary_picks_error_line() {
        let output = "   Compiling foo v0.1.0\n\
                      error[E0308]: mismatched types\n\
                      --> src/main.rs:1:5\n";
        assert!(failure_summary(output).contains("mismatched types"));
    }

    #[test]
    fn tail_keeps_last_twelve_lines() {
        let output = (1..=20).map(|n| format!("line {n}")).collect::<Vec<_>>().join("\n");
        let tail = tail_lines(&output);
        assert_eq!(tail.lines().count(), 12);
        assert!(tail.starts_with("line 9"));
    }
}

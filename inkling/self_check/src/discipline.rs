//! 代码纪律门禁：代码文件内零计划痕迹 + 叙述口吻（B2 的可执行形态）。
//!
//! 扫描范围：引擎包、壳侧源码、前端源码、seed 数据、seeds、仓库内 markdown
//! （计划目录除外）。命中即失败，与既有自检门禁并列；违例须改写为叙述句，
//! 注释信息量不得下降。
//!
//! 门禁按「文本 + 标识符」分别匹配，并保留行内豁免：误报豁免面包括
//! 十六进制颜色、CSS/类名、版本号与型号、量化标记（Q8 等）、ruff 规则
//! 码（E402/B017/C4 等）、既有术语（E2E）。豁免按行上下文判定，命中
//! 豁免条件时该行跳过对应模式。

use std::path::Path;

/// 匹配模式（按字面正则语义手写扫描，零第三方依赖）。
#[derive(Debug, Clone, Copy)]
struct Pattern {
    label: &'static str,
    matcher: fn(line: &str) -> bool,
}

fn has_plan_coord(line: &str) -> bool {
    // P0.1 / P1.4 / P7.2 类坐标：P + 数字 + .数字
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'P' && bytes[i + 1].is_ascii_digit() {
            let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if prev_ok
                && j < bytes.len()
                && bytes[j] == b'.'
                && j + 1 < bytes.len()
                && bytes[j + 1].is_ascii_digit()
            {
                return true;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    false
}

fn has_cp_coord(line: &str) -> bool {
    // CP0 / CP1.1 / CP7 类坐标（CP 后跟数字，前边界非字母数字）
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'C'
            && bytes[i + 1] == b'P'
            && bytes[i + 2].is_ascii_digit()
        {
            let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            if prev_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn has_section_marker(line: &str) -> bool {
    // §N 章节坐标（文档引用一律改叙述句）
    line.contains('§')
}

fn has_letter_number_code(line: &str) -> bool {
    // [A-E] + 1-2 位数字（A1/B2/D4/E2 类）；三位的 ruff 码（E402/B017）不命中；
    // 行含 noqa/规则集/ruff 字样时豁免（规则码清单语境）；C0 控制字符类为
    // 技术术语（控制字符类别名），同行豁免
    if line.contains("noqa")
        || line.contains("规则集")
        || line.contains("ruff")
        || line.contains("控制字符")
        || line.contains("控制符")
    {
        return false;
    }
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        let ch = bytes[i];
        if (b'A'..=b'E').contains(&ch) && bytes[i + 1].is_ascii_digit() {
            let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let digits = j - (i + 1);
            let next_ok = j >= bytes.len() || !bytes[j].is_ascii_alphanumeric();
            if prev_ok && next_ok && digits <= 2 {
                return true;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    false
}

fn has_q_code(line: &str) -> bool {
    // Q 系列决策号（Q1-Q12）；量化标记（Q8 量化等）同行豁免
    if line.contains("量化") {
        return false;
    }
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'Q' && bytes[i + 1].is_ascii_digit() {
            let prev_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let next_ok = j >= bytes.len() || !bytes[j].is_ascii_alphanumeric();
            if prev_ok && next_ok {
                return true;
            }
            i = j;
            continue;
        }
        i += 1;
    }
    false
}

fn has_batch_rhythm(line: &str) -> bool {
    // 推进节奏：本批/后续批/批 N（运行时「批次」聚合语义不在禁列；
    // 「审批一等」类词组中 批 前有汉字，不算推进节奏）
    if line.contains("本批") || line.contains("后续批") {
        return true;
    }
    let batch_byte = "批".as_bytes()[0];
    let digits_cn = "一二三四五六七八九十";
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == batch_byte {
            // 前驱为汉字 = 词组（审批一等/分批），不算推进节奏
            if i > 0 && bytes[i - 1] >= 0x80 {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\t') {
                j += 1;
            }
            let mut k = j;
            while k < bytes.len() && bytes[k].is_ascii_digit() {
                k += 1;
            }
            if k > j {
                return true;
            }
            if j < bytes.len() && digits_cn.contains(bytes[j] as char) {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn has_plan_rhythm(line: &str) -> bool {
    // 计划推进复合词（裸「计划/阶段」为引擎领域词，不在禁列）
    ["计划阶段", "实施步骤", "实施批次", "待实施", "暂缓", "里程碑"]
        .iter()
        .any(|word| line.contains(word))
}

fn has_numbered_ref(line: &str, keyword: &str) -> bool {
    let Some(pos) = line.find(keyword) else {
        return false;
    };
    let rest = line[pos + keyword.len()..].trim_start();
    rest.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

fn has_decision_ref(line: &str) -> bool {
    // 决策 N（空格分隔的编号引用）
    has_numbered_ref(line, "决策")
}

fn has_redline_ref(line: &str) -> bool {
    has_numbered_ref(line, "红线")
}

fn has_plan_timestamp(line: &str) -> bool {
    // 计划文件名时间戳（1787 开头共 13 位数字）
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 12 < bytes.len() {
        if bytes[i..i + 4] == *b"1787" && bytes[i + 4..i + 13].iter().all(|b| b.is_ascii_digit()) {
            return true;
        }
        i += 1;
    }
    false
}

fn has_todo_placeholder(line: &str) -> bool {
    // 计划占位（TODO/FIXME 作计划占位；叙述口吻下待办须写成行为契约）
    line.contains("TODO") || line.contains("FIXME")
}

const PATTERNS: [Pattern; 10] = [
    Pattern { label: "计划坐标（Px.y）", matcher: has_plan_coord },
    Pattern { label: "计划坐标（CPn）", matcher: has_cp_coord },
    Pattern { label: "章节坐标（§n）", matcher: has_section_marker },
    Pattern { label: "字母数字编号（A1/B2/D4）", matcher: has_letter_number_code },
    Pattern { label: "决策编号（Qn）", matcher: has_q_code },
    Pattern { label: "推进节奏（本批/批 N）", matcher: has_batch_rhythm },
    Pattern { label: "推进节奏（计划阶段/待实施等）", matcher: has_plan_rhythm },
    Pattern { label: "计划引用（决策 N）", matcher: has_decision_ref },
    Pattern { label: "计划引用（红线 N）", matcher: has_redline_ref },
    Pattern { label: "计划文件时间戳", matcher: has_plan_timestamp },
];

/// 是否纳入扫描（目录/文件）：排除构建产物、依赖、计划目录；文件另按
/// 扩展名过滤（目录只按排除表）。
fn should_scan(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.contains("/target/")
        || text.contains("/node_modules/")
        || text.contains("/__pycache__/")
        || text.contains("/.venv/")
        || text.contains("/dist/")
        || text.contains("/.git/")
        || text.contains("/.kilo/plans/")
        || text.contains("/.kilo/worktrees/")
        || text.contains("/resources/")
        || text.contains("/smoke_out/")
        || text.ends_with(".pyc")
    {
        return false;
    }
    if path.is_dir() {
        return true;
    }
    let scanned = [".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".json", ".md"];
    scanned.iter().any(|ext| text.ends_with(ext))
}

/// 扫描单个文件，返回违例行（文件:行号: 模式标签）。
fn scan_file(path: &Path) -> Vec<String> {
    let mut hits = Vec::new();
    if !should_scan(path) {
        return hits;
    }
    let Ok(source) = std::fs::read_to_string(path) else {
        return hits;
    };
    for (index, line) in source.lines().enumerate() {
        for pattern in &PATTERNS {
            if (pattern.matcher)(line) {
                hits.push(format!("{}:{}: {}", path.display(), index + 1, pattern.label));
            }
        }
    }
    hits
}

/// 仓库根扫描（返回违例清单；空 = 全绿）。
pub fn run(repo_root: &Path) -> Vec<String> {
    let mut hits = Vec::new();
    let walk = |dir: &Path, results: &mut Vec<String>| {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if should_scan(&path) {
                        stack.push(path);
                    }
                } else if should_scan(&path) {
                    results.extend(scan_file(&path));
                }
            }
        }
    };
    for dir in [
        repo_root.join("ink_engine"),
        repo_root.join("inkling/shell/src-tauri/src"),
        repo_root.join("inkling/frontend/src"),
        repo_root.join("inkling/seed_data"),
        repo_root.join("seeds"),
    ] {
        if dir.is_dir() {
            walk(&dir, &mut hits);
        }
    }
    // 仓库内 markdown（计划目录除外）：根级与各模块 docs 面（仅 *.md）
    let mut walk_md = |dir: &Path, results: &mut Vec<String>| {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if should_scan(&path) {
                        stack.push(path);
                    }
                } else if should_scan(&path) && path.to_string_lossy().ends_with(".md") {
                    results.extend(scan_file(&path));
                }
            }
        }
    };
    for dir in [
        repo_root.to_path_buf(),
        repo_root.join("ink_engine/docs"),
        repo_root.join("inkling/docs"),
    ] {
        if dir.is_dir() {
            walk_md(&dir, &mut hits);
        }
    }
    hits
}

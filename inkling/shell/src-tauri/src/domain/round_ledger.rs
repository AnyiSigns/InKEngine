//! 过程摘要链：回合账本（壳侧纯归约，零 LLM、零引擎改动、可审计）。
//!
//! 每回合 = 确定性归约：回合事件（tool_start / tool_end / plan_start /
//! spawn_start / error）+ TurnMetrics + 审计事件 → 结构化「回合账本」
//! （JSON 落记忆目录）。归约不调模型，壳侧纯函数，引擎零改动、零成本。
//!
//! 账本 = 压缩前的事实快照；LLM 合并（便宜档）由引擎侧 `ledger.merge`
//! op 复用同一摘要替换形态，本模块只负责「事实快照的生产与留存」。摘要
//! 链 append-only 可回溯；账本目录按「N 周或 N MB」上限滚动（与
//! fingerprint_cache 容量淘汰同语义），旧账本归档压缩、超限最旧删除。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value as JsonValue};

/// 账本数据契约版本。
const LEDGER_SCHEMA: &str = "round_ledger/1";

/// 摘要链数据契约版本。
const SUMMARY_SCHEMA: &str = "round_ledger_summary/1";

/// 账本文件名前缀（后接 thread_round）。
const LEDGER_FILE_PREFIX: &str = "ledger_";

/// 摘要链文件名前缀（后接 thread）。
const SUMMARY_CHAIN_PREFIX: &str = "summary_chain_";

/// 默认账本目录容量上限（字节）。
pub const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// 默认账本留存年龄上限（天）。
pub const DEFAULT_MAX_AGE_DAYS: i64 = 90;

/// 摘要链保留条数（append-only 但留容量界）。
pub const SUMMARY_CHAIN_KEEP: usize = 200;

/// 摘要链自动合并阈值：自上次合并后新增账本 ≥ 此值才触发一次合并
/// （回合收尾静默触发；避免每回合重复压缩导致摘要质量衰减）。
pub const AUTO_MERGE_THRESHOLD: usize = 10;

/// 合并标记文件名（记录上次合并覆盖的最新账本 round_id；推进后
/// 只合并增量账本，不重复压缩旧账本）。
const MERGE_MARKER_PREFIX: &str = "merge_marker_";

/// 归约保留的事件类型（其余回合事件不进账本，账本只存事实要点）。
///
/// 口径对齐（防漂移）：与引擎 `memory_extract.ROUND_FACT_EVENTS`
/// 一致——执行轨迹事实 + 确认类事实。确认类必须保留：`memory.extract`
/// 从账本 events 里按确认事件抽记忆，账本漏确认类 → 记忆永远抽不到。
/// 契约守卫：`ledger.fact_rules` op 导出引擎权威集合，壳侧装配期校验
/// 本常量为其子集（lib.rs check_ledger_fact_rules + 测试断言）。
pub(crate) const RECOGNIZED_EVENTS: &[&str] = &[
    "tool_start",
    "tool_end",
    "plan_start",
    "spawn_start",
    "error",
    "node_error",
    "tool_error",
    "validation_error",
    "accept",
    "edit",
    "reject",
    "user_correction",
    "user_confirm",
];

/// 单条账本事件（确定性归约后的事实要点）。
#[derive(Debug, Clone)]
struct LedgerEvent {
    kind: String,
    detail: JsonValue,
    at: i64,
}

/// 回合账本（结构化事实快照）。
pub struct RoundLedger {
    thread_id: String,
    round_id: String,
    created_at: i64,
    intent: Option<String>,
    conclusion: Option<String>,
    events: Vec<LedgerEvent>,
    turn_metrics: JsonValue,
    audit_events: Vec<JsonValue>,
    summary: Option<String>,
}

/// 文件名安全化（非字母数字统一为下划线，防路径穿越）。
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '_' })
        .collect()
}

/// 账本目录（记忆目录下的 round_ledgers 子目录）。
pub fn ledger_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("round_ledgers")
}

/// 单账本文件路径。
fn ledger_path(dir: &Path, thread_id: &str, round_id: &str) -> PathBuf {
    dir.join(format!(
        "{}{}_{}.json",
        LEDGER_FILE_PREFIX,
        sanitize(thread_id),
        sanitize(round_id)
    ))
}

/// 摘要链文件路径（按线程 append-only）。
fn summary_chain_path(dir: &Path, thread_id: &str) -> PathBuf {
    dir.join(format!(
        "{}{}.jsonl",
        SUMMARY_CHAIN_PREFIX,
        sanitize(thread_id)
    ))
}

/// 确定性归约：从原始回合事件抽出事实要点，组装回合账本。
///
/// 仅保留识别集内的事件类型（tool_start / tool_end / plan_start /
/// spawn_start / error），附时间戳；intent / conclusion / turn_metrics /
/// 审计事件原样留存。纯函数，不调模型。
pub fn reduce_round(
    thread_id: &str,
    round_id: &str,
    intent: Option<&str>,
    conclusion: Option<&str>,
    events: &[JsonValue],
    turn_metrics: &JsonValue,
    audit_events: &JsonValue,
) -> RoundLedger {
    let now = chrono::Utc::now().timestamp();
    let mut kept: Vec<LedgerEvent> = Vec::new();
    for ev in events {
        let etype = match ev.get("type").and_then(|v| v.as_str()) {
            Some(s) => s,
            None => continue,
        };
        if !RECOGNIZED_EVENTS.contains(&etype) {
            continue;
        }
        let detail = ev
            .get("payload")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let at = ev
            .get("timestamp")
            .and_then(|v| v.as_i64())
            .or_else(|| detail.get("timestamp").and_then(|v| v.as_i64()))
            .unwrap_or(now);
        kept.push(LedgerEvent {
            kind: etype.to_string(),
            detail,
            at,
        });
    }
    let audit = audit_events
        .as_array()
        .cloned()
        .unwrap_or_default();
    RoundLedger {
        thread_id: thread_id.to_string(),
        round_id: round_id.to_string(),
        created_at: now,
        intent: intent.map(str::to_string),
        conclusion: conclusion.map(str::to_string),
        events: kept,
        turn_metrics: turn_metrics.clone(),
        audit_events: audit,
        summary: None,
    }
}

impl RoundLedger {
    /// 序列化为 JSON（结构化账本，可审计）。
    pub fn to_json(&self) -> JsonValue {
        json!({
            "schema": LEDGER_SCHEMA,
            "thread_id": self.thread_id,
            "round_id": self.round_id,
            "created_at": self.created_at,
            "intent": self.intent,
            "conclusion": self.conclusion,
            "events": self.events.iter().map(|e| json!({
                "kind": e.kind,
                "at": e.at,
                "detail": e.detail,
            })).collect::<Vec<_>>(),
            "turn_metrics": self.turn_metrics,
            "audit_events": self.audit_events,
            "summary": self.summary,
        })
    }

    /// 序列化为 Markdown（人读摘要，落记忆目录可读性）。
    pub fn to_markdown(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "# 回合账本 {}\n\n- 线程: {}\n- 回合: {}\n- 时间: {}\n",
            self.round_id, self.thread_id, self.round_id, self.created_at
        ));
        if let Some(intent) = &self.intent {
            out.push_str(&format!("- 意图: {intent}\n"));
        }
        if let Some(conclusion) = &self.conclusion {
            out.push_str(&format!("- 结论: {conclusion}\n"));
        }
        out.push_str("\n## 事件\n\n");
        for e in &self.events {
            out.push_str(&format!("- [{}] {}: {}\n", e.at, e.kind, e.detail));
        }
        out
    }
}

/// 写账本到目录（JSON 落盘），返回文件路径。
pub fn write_ledger(dir: &Path, ledger: &RoundLedger) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("账本目录创建失败: {err}"))?;
    let path = ledger_path(dir, &ledger.thread_id, &ledger.round_id);
    let text = serde_json::to_string_pretty(&ledger.to_json())
        .map_err(|err| format!("账本序列化失败: {err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("账本写入失败: {err}"))?;
    Ok(path)
}

/// 列出某线程下全部账本 JSON（用于合并前的事实快照汇总）。
pub fn load_ledger_jsons(dir: &Path, thread_id: &str) -> Vec<JsonValue> {
    let prefix = format!("{}{}_", LEDGER_FILE_PREFIX, sanitize(thread_id));
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with(&prefix) && name.ends_with(".json") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                    out.push(value);
                }
            }
        }
    }
    out
}

/// 列出目录下出现的全部线程 id（滚动全量用）。
///
/// R9：文件名是 sanitize 后的形态（`-` 变 `_`，有损），优先读账本 JSON
/// 内的原始 `thread_id` 还原真实 id；JSON 缺失/解析失败回退文件名形态
/// （仅供滚动等内部用途——内部再经 sanitize 幂等自洽，不做跨层契约）。
pub fn list_thread_ids(dir: &Path) -> Vec<String> {
    let mut ids = std::collections::BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if let Some(rest) = name.strip_prefix(LEDGER_FILE_PREFIX) {
                if let Some(stem) = rest.strip_suffix(".json") {
                    if let Some((tid, _)) = stem.rsplit_once('_') {
                        let original = std::fs::read_to_string(&path)
                            .ok()
                            .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
                            .and_then(|v| {
                                v.get("thread_id")
                                    .and_then(JsonValue::as_str)
                                    .map(str::to_string)
                            });
                        ids.insert(original.unwrap_or_else(|| tid.to_string()));
                    }
                }
            }
        }
    }
    ids.into_iter().collect()
}

/// 追加一条摘要到线程摘要链（append-only）。
pub fn append_summary(dir: &Path, thread_id: &str, summary: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("摘要链目录创建失败: {err}"))?;
    let path = summary_chain_path(dir, thread_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("摘要链打开失败: {err}"))?;
    let record = json!({
        "schema": SUMMARY_SCHEMA,
        "at": chrono::Utc::now().timestamp(),
        "summary": summary,
    });
    let line = serde_json::to_string(&record).map_err(|err| format!("摘要序列化失败: {err}"))?;
    writeln!(file, "{line}").map_err(|err| format!("摘要链写入失败: {err}"))?;
    Ok(())
}

/// 读取线程摘要链（按时间序全部条目）。
pub fn load_summary_chain(dir: &Path, thread_id: &str) -> Vec<String> {
    let path = summary_chain_path(dir, thread_id);
    if !path.is_file() {
        return Vec::new();
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// 摘要链容量滚动：仅保留最近 `keep_last` 条（append-only 但留容量界）。
pub fn roll_summary_chain(dir: &Path, thread_id: &str, keep_last: usize) -> Result<usize, String> {
    let chain = load_summary_chain(dir, thread_id);
    if chain.len() <= keep_last {
        return Ok(0);
    }
    let total = chain.len();
    let keep: Vec<String> = chain.into_iter().rev().take(keep_last).collect::<Vec<_>>().into_iter().rev().collect();
    let path = summary_chain_path(dir, thread_id);
    let mut file = std::fs::File::create(&path).map_err(|err| format!("摘要链重写失败: {err}"))?;
    for line in &keep {
        writeln!(file, "{line}").map_err(|err| format!("摘要链重写失败: {err}"))?;
    }
    Ok(total - keep.len())
}

/// 读取合并标记（上次自动合并覆盖的最新账本 round_id；无标记 = 从未合并）。
pub fn load_merge_marker(dir: &Path, thread_id: &str) -> Option<String> {
    let path = dir.join(format!("{}{}.json", MERGE_MARKER_PREFIX, sanitize(thread_id)));
    let text = std::fs::read_to_string(&path).ok()?;
    let value = serde_json::from_str::<JsonValue>(&text).ok()?;
    value
        .get("last_ledger_round_id")
        .and_then(JsonValue::as_str)
        .map(String::from)
}

/// 推进合并标记（记录本次合并覆盖的最新账本 round_id）。
pub fn save_merge_marker(dir: &Path, thread_id: &str, last_round_id: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("合并标记目录创建失败: {err}"))?;
    let path = dir.join(format!("{}{}.json", MERGE_MARKER_PREFIX, sanitize(thread_id)));
    let record = json!({ "last_ledger_round_id": last_round_id });
    let text = serde_json::to_string(&record).map_err(|err| format!("合并标记序列化失败: {err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("合并标记落盘失败: {err}"))
}

/// 自上次合并之后的新增账本（按 created_at 时间序；标记账本已被容量滚动
/// 删除 = 全部视为新账本）。
pub fn new_ledgers_since_marker(dir: &Path, thread_id: &str) -> Vec<JsonValue> {
    let mut ledgers = load_ledger_jsons(dir, thread_id);
    ledgers.sort_by_key(|l| l.get("created_at").and_then(JsonValue::as_i64).unwrap_or(0));
    match load_merge_marker(dir, thread_id) {
        Some(last) => {
            let idx = ledgers
                .iter()
                .position(|l| l.get("round_id").and_then(JsonValue::as_str) == Some(last.as_str()));
            match idx {
                Some(i) => ledgers[i + 1..].to_vec(),
                None => ledgers,
            }
        }
        None => ledgers,
    }
}

/// 账本文件记录（滚动用：路径 + mtime + 大小；round_id 由文件名解析，
/// 不整读文件内容）。
struct LedgerFileRecord {
    path: PathBuf,
    mtime: i64,
    size: u64,
}

/// 收集某线程全部账本文件（按 mtime 升序）。
///
/// R7：round_id 只用于定位合并标记文件（marker 保护语义），改由文件名
/// 解析（`ledger_<sanitize(thread)>_<sanitize(round)>.json`）——不再整读
/// 每个文件内容，滚动 O(文件数) 内完成。
fn scan_thread_files(dir: &Path, thread_id: &str) -> Result<Vec<LedgerFileRecord>, String> {
    let prefix = format!("{}{}_", LEDGER_FILE_PREFIX, sanitize(thread_id));
    let mut files: Vec<LedgerFileRecord> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|err| format!("账本目录读取失败: {err}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with(&prefix) && name.ends_with(".json") {
            let meta =
                std::fs::metadata(&path).map_err(|err| format!("账本元信息读取失败: {err}"))?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            files.push(LedgerFileRecord {
                path,
                mtime,
                size: meta.len(),
            });
        }
    }
    files.sort_by_key(|record| record.mtime);
    Ok(files)
}

/// 合并标记对应账本文件名（`ledger_<sanitize(thread)>_<sanitize(round)>.json`）。
///
/// R7：标记匹配按「文件名相等」判定，不做 round_id 内容还原——文件名
/// 里的 round 段是 sanitize 形态（`-` 等已损），与标记里原始 id 逐字符
/// 比较会错配；对同一原始 round 的账本与标记，两侧 sanitize 后必同形。
fn merge_marker_file_name(thread_id: &str, round_id: &str) -> String {
    format!(
        "{}{}_{}.json",
        LEDGER_FILE_PREFIX,
        sanitize(thread_id),
        sanitize(round_id)
    )
}

/// 账本容量滚动实现（合并安全边界可选）。
///
/// `protect_after` 提供时 = 仅滚「已合并入摘要链」的账本：合并标记
/// （`merge_marker_<thread>.json` 指向的 round_id）之前的文件可淘汰，
/// 标记之后（未合并新账本）原样保留——容量滚动不吞待压缩事实；合并标记
/// 对应文件本身已在链中，可淘汰。未提供 = 全量可淘汰（旧语义）。
fn roll_impl(
    dir: &Path,
    thread_id: &str,
    max_bytes: u64,
    max_age_days: i64,
    protect_after: Option<&str>,
) -> Result<usize, String> {
    let records = scan_thread_files(dir, thread_id)?;
    let mut removable = vec![true; records.len()];
    if let Some(marker_round) = protect_after {
        let marker_name = merge_marker_file_name(thread_id, marker_round);
        let marker_idx = records
            .iter()
            .position(|record| {
                record
                    .path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|name| name == marker_name)
                    .unwrap_or(false)
            });
        let Some(idx) = marker_idx else {
            return Ok(0);
        };
        for removable_flag in removable.iter_mut().skip(idx + 1) {
            *removable_flag = false;
        }
    }
    let cutoff = chrono::Utc::now().timestamp() - max_age_days * 86400;
    let mut removed = 0usize;
    // 年龄淘汰后一次性归约出「可淘汰存活」的总字节与条数；后续体积滚动
    // 删除时递减（R7：不再每轮全量 sum + 线性扫最旧）。
    let mut alive = 0usize;
    let mut total: u64 = 0;
    for (index, record) in records.iter().enumerate() {
        if !removable[index] {
            continue;
        }
        if record.mtime <= cutoff {
            if std::fs::remove_file(&record.path).is_ok() {
                removed += 1;
                removable[index] = false;
                continue;
            }
        }
        alive += 1;
        total += record.size;
    }
    // 体积滚动：按 mtime 升序单调下移游标删最旧（records 已排序，删除
    // 只发生在游标前方，无需重扫）。
    let mut cursor = 0usize;
    while total > max_bytes && alive > 1 {
        while cursor < records.len() && !removable[cursor] {
            cursor += 1;
        }
        if cursor >= records.len() {
            break;
        }
        let record = &records[cursor];
        if std::fs::remove_file(&record.path).is_ok() {
            removed += 1;
        }
        removable[cursor] = false;
        total = total.saturating_sub(record.size);
        alive -= 1;
        cursor += 1;
    }
    Ok(removed)
}

/// 账本容量滚动：按年龄（最旧先删）与体积（超限最旧删）淘汰，返回删除数。
///
/// 与 fingerprint_cache 容量淘汰同语义：先清过期（> max_age_days），再按
/// 体积上限从最旧开始删，直到总字节 ≤ max_bytes 或清空。
pub fn roll_ledgers(
    dir: &Path,
    thread_id: &str,
    max_bytes: u64,
    max_age_days: i64,
) -> Result<usize, String> {
    roll_impl(dir, thread_id, max_bytes, max_age_days, None)
}

/// 账本容量滚动（回合收尾接线版）：只滚「已合并入摘要链」的账本。
///
/// 合并标记（`merge_marker_<thread>.json`）之后 = 尚未经 `ledger.merge`
/// 压缩的账本，原样保留；无合并标记（从未合并）= 全部保留。滚动在回合
/// 收尾（自动合并推进标记后）调用，容量界生效且不吞未合并事实。
pub fn roll_ledgers_merged(
    dir: &Path,
    thread_id: &str,
    max_bytes: u64,
    max_age_days: i64,
) -> Result<usize, String> {
    match load_merge_marker(dir, thread_id) {
        Some(marker_round) => {
            roll_impl(dir, thread_id, max_bytes, max_age_days, Some(&marker_round))
        }
        None => Ok(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_events() -> Vec<JsonValue> {
        vec![
            json!({"type":"user_message","payload":{"content":"做X"}}),
            json!({"type":"tool_start","payload":{"tool":"write_file","tool_call_id":"c1"}}),
            json!({"type":"tool_end","payload":{"tool":"write_file","path":"a.rs","success":true}}),
            json!({"type":"plan_start","payload":{"plan":"p"}}),
            json!({"type":"spawn_start","payload":{"target":"t"}}),
            json!({"type":"error","payload":{"message":"boom"}}),
            json!({"type":"accept","payload":{"message":"用户确认"}}),
            json!({"type":"reply","payload":{"content":"完成"}}),
        ]
    }

    #[test]
    fn reduce_keeps_only_recognized_events() {
        let ledger = reduce_round(
            "th1",
            "r1",
            Some("做X"),
            Some("完成"),
            &sample_events(),
            &json!({}),
            &json!([]),
        );
        let kinds: Vec<&str> = ledger.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["tool_start", "tool_end", "plan_start", "spawn_start", "error", "accept"]
        );
        assert_eq!(ledger.intent.as_deref(), Some("做X"));
        assert_eq!(ledger.conclusion.as_deref(), Some("完成"));
    }

    #[test]
    fn reduce_keeps_confirmation_events_for_memory_extract() {
        // 口径契约：确认类事件必须保留进账本——memory.extract 从账本
        // events 里按确认事件抽记忆，账本漏确认类 = 记忆永远抽不到
        //（引擎权威集合 = memory_extract.ROUND_FACT_EVENTS）。
        let events: Vec<JsonValue> = vec![
            json!({"type":"user_correction","payload":{"message":"改成这样"}}),
            json!({"type":"edit","payload":{"message":"修订"}}),
            json!({"type":"user_confirm","payload":{"message":"确认"}}),
            json!({"type":"reject","payload":{"message":"拒绝"}}),
            json!({"type":"tool_error","payload":{"message":"工具异常"}}),
            json!({"type":"user_message","payload":{"content":"噪音"}}),
        ];
        let ledger = reduce_round(
            "th1", "r1", None, None, &events, &json!({}), &json!([]),
        );
        let kinds: Vec<&str> = ledger.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["user_correction", "edit", "user_confirm", "reject", "tool_error"]
        );
    }

    #[test]
    fn recognized_events_are_subset_of_engine_fact_rules() {
        // 契约守卫（静态）：壳侧归约保留集 ⊆ 引擎 ROUND_FACT_EVENTS——
        // 引擎权威集合演进时此处显式同步（ledger.fact_rules op 运行时
        // 校验同一约束；此处为编译期静态断言，防误删）。
        assert!(RECOGNIZED_EVENTS.iter().all(|kind| {
            matches!(
                *kind,
                "tool_start"
                    | "tool_end"
                    | "plan_start"
                    | "spawn_start"
                    | "error"
                    | "node_error"
                    | "tool_error"
                    | "validation_error"
                    | "accept"
                    | "edit"
                    | "reject"
                    | "user_correction"
                    | "user_confirm"
            )
        }));
        // 确认类在保留集内（memory.extract 抽取点的存在性断言）
        for confirmation in ["accept", "edit", "reject", "user_correction", "user_confirm"] {
            assert!(
                RECOGNIZED_EVENTS.contains(&confirmation),
                "确认类事件 {confirmation} 必须保留进账本（记忆抽取依赖）"
            );
        }
    }

    #[test]
    fn reduce_is_pure_no_model() {
        let a = reduce_round("t", "r", None, None, &sample_events(), &json!({}), &json!([]));
        let b = reduce_round("t", "r", None, None, &sample_events(), &json!({}), &json!([]));
        assert_eq!(a.to_json(), b.to_json());
    }

    #[test]
    fn write_and_read_ledger_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("rl_test_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        let ledger = reduce_round("th", "r1", None, None, &sample_events(), &json!({"a":1}), &json!([]));
        let path = write_ledger(&dir, &ledger).unwrap();
        assert!(path.is_file());
        let loaded = load_ledger_jsons(&dir, "th");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["round_id"], "r1");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_thread_ids_restores_original_ids() {
        // R9：sanitize 把 `-` 变 `_`，list_thread_ids 应读账本 JSON 的
        // 原始 thread_id 还原（thread-<uuid> 形态），而非有损文件名形态。
        let tmp = std::env::temp_dir().join(format!("rl_ids_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        let original = "thread-abc-123".to_string();
        let ledger = reduce_round(&original, "r1", None, None, &sample_events(), &json!({}), &json!([]));
        write_ledger(&dir, &ledger).unwrap();
        let ids = list_thread_ids(&dir);
        assert_eq!(ids, vec![original], "应还原原始 thread id（含连字符）");
        // 损坏 JSON：回退文件名形态（内部滚动自洽）
        std::fs::write(dir.join("ledger_broken_r2.json"), "not json").unwrap();
        let ids = list_thread_ids(&dir);
        assert!(ids.contains(&"broken".to_string()), "坏 JSON 回退文件名形态");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn summary_chain_append_and_load_and_roll() {
        let tmp = std::env::temp_dir().join(format!("rl_sc_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        append_summary(&dir, "th", "摘要一").unwrap();
        append_summary(&dir, "th", "摘要二").unwrap();
        let chain = load_summary_chain(&dir, "th");
        assert_eq!(chain.len(), 2);
        let removed = roll_summary_chain(&dir, "th", 1).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(load_summary_chain(&dir, "th").len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn merge_marker_tracks_incremental_ledgers() {
        // 自动合并阈值：无标记 = 全部账本为新账本；标记推进后只取增量。
        let tmp = std::env::temp_dir().join(format!("rl_mm_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        for i in 1..=4 {
            let ledger = reduce_round("th", &format!("r{i}"), None, None, &sample_events(), &json!({}), &json!([]));
            write_ledger(&dir, &ledger).unwrap();
        }
        // 未合并过：全部为新账本（按时间序 r1..r4）
        let first = new_ledgers_since_marker(&dir, "th");
        assert_eq!(first.iter().map(|l| l["round_id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec!["r1", "r2", "r3", "r4"]);
        // 合并到 r3：推进标记后只返回 r4
        save_merge_marker(&dir, "th", "r3").unwrap();
        assert_eq!(load_merge_marker(&dir, "th").as_deref(), Some("r3"));
        let delta = new_ledgers_since_marker(&dir, "th");
        assert_eq!(delta.iter().map(|l| l["round_id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec!["r4"]);
        // 标记账本被滚动删除：全部视为新账本（不丢数据）
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ledger = reduce_round("th", "r9", None, None, &sample_events(), &json!({}), &json!([]));
        write_ledger(&dir, &ledger).unwrap();
        let after_roll = new_ledgers_since_marker(&dir, "th");
        assert_eq!(after_roll.len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn roll_ledgers_by_size_keeps_newest() {
        let tmp = std::env::temp_dir().join(format!("rl_roll_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let l1 = reduce_round("th", "r1", None, None, &sample_events(), &json!({}), &json!([]));
        let l2 = reduce_round("th", "r2", None, None, &sample_events(), &json!({}), &json!([]));
        let l3 = reduce_round("th", "r3", None, None, &sample_events(), &json!({}), &json!([]));
        let p1 = write_ledger(&dir, &l1).unwrap();
        let p2 = write_ledger(&dir, &l2).unwrap();
        let p3 = write_ledger(&dir, &l3).unwrap();
        // 同秒写入时 mtime 可能并列，显式拉开时间序保证「最旧两条」确定性
        set_mtime_ago(&p1, 3);
        set_mtime_ago(&p2, 2);
        set_mtime_ago(&p3, 1);
        // 体积上限 1 字节：从最旧开始删，仅留最新一条
        let removed = roll_ledgers(&dir, "th", 1, DEFAULT_MAX_AGE_DAYS).unwrap();
        assert_eq!(removed, 2, "应删掉两条最旧账本");
        assert!(!p1.exists() && !p2.exists(), "最旧两条应被删");
        assert!(p3.exists(), "最新账本应保留");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn roll_ledgers_by_age_removes_stale() {
        let tmp = std::env::temp_dir().join(format!("rl_age_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let l1 = reduce_round("th", "r1", None, None, &sample_events(), &json!({}), &json!([]));
        let p1 = write_ledger(&dir, &l1).unwrap();
        set_mtime_ago(&p1, 100);
        // max_age_days=0：cutoff=now，所有账本均满龄 → 全部清掉
        let removed = roll_ledgers(&dir, "th", DEFAULT_MAX_BYTES, 0).unwrap();
        assert!(removed >= 1, "超龄账本应被删");
        assert!(!p1.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn roll_merged_keeps_unmerged_and_referenced() {
        // 合并安全滚动：标记（r3）之后未合并账本保留，已合并旧账本按上限淘汰
        let tmp = std::env::temp_dir().join(format!("rl_mrg_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let mut paths = Vec::new();
        for i in 1..=4 {
            let ledger = reduce_round("th", &format!("r{i}"), None, None, &sample_events(), &json!({}), &json!([]));
            let path = write_ledger(&dir, &ledger).unwrap();
            paths.push(path);
        }
        // mtime 拉开时间序（同秒写入抖动消除）：r1 最旧
        set_mtime_ago(&paths[0], 8);
        set_mtime_ago(&paths[1], 6);
        set_mtime_ago(&paths[2], 4);
        set_mtime_ago(&paths[3], 2);
        save_merge_marker(&dir, "th", "r3").unwrap();
        // 体积上限 1 字节：只滚已合并（r1/r2 淘汰、标记 r3 保留）、未合并 r4 保留
        let removed = roll_ledgers_merged(&dir, "th", 1, DEFAULT_MAX_AGE_DAYS).unwrap();
        assert_eq!(removed, 2, "仅已合并旧账本被淘汰");
        assert!(!paths[0].exists(), "r1（已合并最旧）应被删");
        assert!(!paths[1].exists(), "r2（已合并）应被删");
        assert!(paths[2].exists(), "r3（合并标记引用）应保留");
        assert!(paths[3].exists(), "r4（未合并）应保留");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn roll_merged_without_marker_keeps_all() {
        // 从未合并过 = 全部账本视为未合并：容量滚动不删任何文件
        let tmp = std::env::temp_dir().join(format!("rl_mrk_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        let ledger = reduce_round("th", "r1", None, None, &sample_events(), &json!({}), &json!([]));
        let path = write_ledger(&dir, &ledger).unwrap();
        let removed = roll_ledgers_merged(&dir, "th", 1, DEFAULT_MAX_AGE_DAYS).unwrap();
        assert_eq!(removed, 0, "无标记 = 无已合并账本，不滚动");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn roll_merged_skips_when_marker_file_rolled_away() {
        // 标记账本已被（外部）删除 = 剩余全部视为新账本，不滚
        let tmp = std::env::temp_dir().join(format!("rl_mrkw_{}", uuid::Uuid::new_v4().simple()));
        let dir = ledger_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 1..=3 {
            let ledger = reduce_round("th", &format!("r{i}"), None, None, &sample_events(), &json!({}), &json!([]));
            write_ledger(&dir, &ledger).unwrap();
        }
        save_merge_marker(&dir, "th", "r1").unwrap();
        std::fs::remove_file(dir.join("ledger_th_r1.json")).unwrap();
        let removed = roll_ledgers_merged(&dir, "th", 1, DEFAULT_MAX_AGE_DAYS).unwrap();
        assert_eq!(removed, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 测试辅助：把文件 mtime 拨回 n 秒前（显式时间序，消除同秒写入抖动）。
    fn set_mtime_ago(path: &std::path::Path, seconds_ago: u64) {
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let target = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now_secs - seconds_ago);
        let file = std::fs::OpenOptions::new().write(true).open(path).expect("打开账本写 mtime");
        file.set_modified(target).expect("mtime 回拨");
    }
}

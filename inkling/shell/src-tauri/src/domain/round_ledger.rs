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
const RECOGNIZED_EVENTS: &[&str] = &[
    "tool_start",
    "tool_end",
    "plan_start",
    "spawn_start",
    "error",
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
    let prefix = format!("{}{}_", LEDGER_FILE_PREFIX, sanitize(thread_id));
    let mut files: Vec<(PathBuf, i64, u64)> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|err| format!("账本目录读取失败: {err}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name.starts_with(&prefix) && name.ends_with(".json") {
            let meta = std::fs::metadata(&path).map_err(|err| format!("账本元信息读取失败: {err}"))?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            files.push((path, mtime, meta.len()));
        }
    }
    files.sort_by_key(|(_, mtime, _)| *mtime);
    let cutoff = chrono::Utc::now().timestamp() - max_age_days * 86400;
    let mut removed = 0usize;
    let mut i = 0;
    while i < files.len() {
        if files[i].1 <= cutoff {
            let _ = std::fs::remove_file(&files[i].0);
            files.remove(i);
            removed += 1;
        } else {
            i += 1;
        }
    }
    let mut total: u64 = files.iter().map(|(_, _, s)| *s).sum();
    // 体积淘汰从最旧开始删；最新一条始终保留（单文件超限不误删，界 = 账本条数有界）
    while total > max_bytes && files.len() > 1 {
        let (p, _, s) = files.remove(0);
        let _ = std::fs::remove_file(&p);
        total -= s;
        removed += 1;
    }
    Ok(removed)
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
            vec!["tool_start", "tool_end", "plan_start", "spawn_start", "error"]
        );
        assert_eq!(ledger.intent.as_deref(), Some("做X"));
        assert_eq!(ledger.conclusion.as_deref(), Some("完成"));
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

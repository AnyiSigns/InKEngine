//! 演化收敛管制域（数据驱动：review.json 收敛配置 → 冷却判定钩子）。
//!
//! 收敛管制 = 演化方向的前置闸门：同一演化目标（补丁类型 × 落点路径）
//! 在近期审计窗口内的变更次数达到收敛上限（review.json max_rounds）后
//! 进入冷却期——目标冻结，AI 据此换方向而非反复撞闸（演化不收敛 =
//! 反复折腾同一目标）。
//!
//! 数据来源 = 评审配置（max_rounds：评审轮次上限的演化侧复用——评审
//! 与演化共用同一「有界收敛」语义：反复折腾有限次后必须换方向/收口）。
//!
//! 冷却判定基于集演化审计（append-only，历史不撒谎）：记录即证据，
//! 回退不删记录——被回退的目标同样计入变更次数（折腾过就是折腾过）。
//! 本模块为纯逻辑（记录清单 + 提案形态 → 判定结果），无引擎交互。

use serde_json::Value as JsonValue;

use super::common::DomainError;

/// 审计扫描窗口（与自指提案的前置扫描同量级：只看近期记录，防长跑
/// 审计膨胀拖慢冷却判定）。
const AUDIT_SCAN_LIMIT: usize = 100;

/// 收敛上限缺省值（review.json max_rounds 缺省时；评审默认轮次上限同源）。
const DEFAULT_MAX_ROUNDS: usize = 2;

/// 补丁类型（演化对象清单：界面/主题/工具/规则/知识/harness/事件/环境/产物）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchKind {
    Ui,
    Theme,
    Tool,
    Rule,
    Knowledge,
    Harness,
    EventType,
    Environment,
    Artifact,
}

impl PatchKind {
    /// 枚举值字符串（与补丁链协议同源）。
    pub fn value(&self) -> &'static str {
        match self {
            PatchKind::Ui => "ui",
            PatchKind::Theme => "theme",
            PatchKind::Tool => "tool",
            PatchKind::Rule => "rule",
            PatchKind::Knowledge => "knowledge",
            PatchKind::Harness => "harness",
            PatchKind::EventType => "event_type",
            PatchKind::Environment => "environment",
            PatchKind::Artifact => "artifact",
        }
    }

    /// 字符串 → 补丁类型（未知值 = None；工具路径传字符串、
    /// 管线路径传枚举——统一归一）。
    pub fn parse(kind: &str) -> Option<PatchKind> {
        match kind {
            "ui" => Some(PatchKind::Ui),
            "theme" => Some(PatchKind::Theme),
            "tool" => Some(PatchKind::Tool),
            "rule" => Some(PatchKind::Rule),
            "knowledge" => Some(PatchKind::Knowledge),
            "harness" => Some(PatchKind::Harness),
            "event_type" => Some(PatchKind::EventType),
            "environment" => Some(PatchKind::Environment),
            "artifact" => Some(PatchKind::Artifact),
            _ => None,
        }
    }
}

/// 补丁落点推导：类型 × payload → 集状态路径（与链路径同源）。
///
/// 每类补丁落集状态的一个路径段（同名键整体替换）——冷却判定与
/// 链落点不会两套口径。payload 缺失必需键 = Err（调用方回退类型级键）。
fn patch_path(kind: PatchKind, payload: &JsonValue) -> Result<Vec<String>, String> {
    let required = |key: &str| -> Result<String, String> {
        payload
            .get(key)
            .and_then(JsonValue::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("补丁缺 {key}"))
    };
    match kind {
        PatchKind::Ui => {
            let spec = payload.get("spec").filter(|v| v.is_object());
            let name = spec
                .and_then(|s| s.get("name"))
                .and_then(JsonValue::as_str)
                .unwrap_or("boot.panel");
            Ok(vec!["ui".to_string(), name.to_string()])
        }
        PatchKind::Theme => Ok(vec!["theme".to_string()]),
        PatchKind::Tool => Ok(vec!["tools".to_string(), required("name")?]),
        PatchKind::Rule => {
            let rule = payload.get("rule").filter(|v| v.is_object());
            let rule_id = rule
                .and_then(|r| r.get("id"))
                .and_then(JsonValue::as_str)
                .or_else(|| payload.get("rule_id").and_then(JsonValue::as_str));
            match rule_id {
                Some(id) => Ok(vec!["rules".to_string(), id.to_string()]),
                None => Err("rule 补丁缺规则 id".into()),
            }
        }
        PatchKind::Knowledge => {
            let entry = payload.get("entry").filter(|v| v.is_object());
            let entry_id = entry
                .and_then(|e| e.get("id"))
                .and_then(JsonValue::as_str)
                .or_else(|| payload.get("entry_id").and_then(JsonValue::as_str));
            match entry_id {
                Some(id) => Ok(vec!["knowledge".to_string(), id.to_string()]),
                None => Err("knowledge 补丁缺条目 id".into()),
            }
        }
        PatchKind::Harness => {
            let definition = payload.get("definition").filter(|v| v.is_object());
            let name = definition
                .and_then(|d| d.get("name"))
                .and_then(JsonValue::as_str)
                .ok_or_else(|| "harness 补丁缺定义 name".to_string())?;
            Ok(vec!["harness".to_string(), name.to_string()])
        }
        PatchKind::EventType => Ok(vec!["event_types".to_string(), required("name")?]),
        PatchKind::Environment => Ok(vec!["environments".to_string(), required("name")?]),
        PatchKind::Artifact => {
            Ok(vec!["artifacts".to_string(), required("artifact_id")?])
        }
    }
}

/// 提案 → 演化目标键（补丁类型 × 落点路径；payload 非法 = 类型级键）。
fn target_key(kind: &str, payload: &JsonValue) -> String {
    let Some(normalized) = PatchKind::parse(kind) else {
        return format!("{kind}/*");
    };
    match patch_path(normalized, payload) {
        Ok(path) => path.join("/"),
        Err(_) => format!("{}/*", normalized.value()),
    }
}

/// 审计记录 → 演化目标键（记录 kind/payload 重算，与提案同口径）。
///
/// 记录形态非法（kind 非字符串 / payload 非对象 / 未知类型）返回空串
/// ——冷却判定按「同目标」匹配，空键永不命中任何目标。
fn target_key_from_record(record: &JsonValue) -> String {
    let raw_kind = record.get("kind").and_then(JsonValue::as_str);
    let payload = record.get("payload").filter(|v| v.is_object());
    match (raw_kind, payload) {
        (Some(kind), Some(payload)) => target_key(kind, payload),
        _ => String::new(),
    }
}

/// 收敛判定结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ConvergenceAssessment {
    /// True = 放行提案；False = 目标处于冷却期，拒绝。
    pub allowed: bool,
    /// 判定状态（ok = 正常放行；cooling = 冷却期拒绝）。
    pub state: String,
    /// 命中的演化目标键（类型 × 落点路径，可读可审计）。
    pub target: String,
    /// 判定说明（冷却时含恢复条件，AI 据此换策略）。
    pub reason: String,
}

/// 数据驱动收敛管制钩子：同目标近期变更 ≥ max_rounds → 冷却拒绝。
///
/// assess 语义（引擎协议）：records = 集演化审计（audit_log 产物）、
/// kind/payload = 提案的类型与内容——同目标计数含被回退的变更
/// （审计 append-only，历史不撒谎）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataConvergenceHook {
    pub max_rounds: usize,
}

impl DataConvergenceHook {
    /// 按审计记录与提案形态判定（纯逻辑，无 IO）。
    pub fn assess(&self, records: &[JsonValue], kind: &str, payload: &JsonValue) -> ConvergenceAssessment {
        let target = target_key(kind, payload);
        let window_start = records.len().saturating_sub(AUDIT_SCAN_LIMIT);
        let touched = records[window_start..]
            .iter()
            .filter(|record| {
                record.get("kind").and_then(JsonValue::as_str) == Some(kind)
                    && target_key_from_record(record) == target
            })
            .count();
        if touched >= self.max_rounds {
            return ConvergenceAssessment {
                allowed: false,
                state: "cooling".to_string(),
                target: target.clone(),
                reason: format!(
                    "目标 {target} 近期变更 {touched} 次（收敛上限 {}，见评审收敛配置）\
                     ——冷却期拒绝，请换方向或等收敛窗口重置",
                    self.max_rounds
                ),
            };
        }
        ConvergenceAssessment {
            allowed: true,
            state: "ok".to_string(),
            target,
            reason: String::new(),
        }
    }
}

/// review.json → 收敛钩子（数据缺失/非法 = 回落引擎默认，不击穿装配）。
///
/// 数据源 = 评审收敛配置（max_rounds）；上限取 max(raw, 1)
/// （0/负数声明 = 至少 1 次即冷却，防零上限误伤全部提案）。
pub fn build_convergence_provider(
    review_data: &JsonValue,
) -> Result<DataConvergenceHook, DomainError> {
    // 整型解析（0/负数声明钳制到 1，防零上限误伤全部提案）；
    // 缺失/非法回落引擎默认，不击穿装配。
    let raw = match review_data.get("max_rounds").and_then(JsonValue::as_i64) {
        Some(value) => value.max(1) as usize,
        None => DEFAULT_MAX_ROUNDS,
    };
    Ok(DataConvergenceHook { max_rounds: raw })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    fn review_data() -> JsonValue {
        let path = repo_root()
            .join("inkling")
            .join("seed_data")
            .join("review.json");
        let text = std::fs::read_to_string(path).expect("seed 文件读取失败");
        serde_json::from_str(&text).expect("seed 文件 JSON 非法")
    }

    fn audit_record(kind: &str, payload: JsonValue) -> JsonValue {
        serde_json::json!({
            "kind": kind,
            "payload": payload,
            "status": "applied",
            "created_at": 0.0,
        })
    }

    #[test]
    fn convergence_max_rounds_driven_by_review_data() {
        let review = review_data();
        let hook = build_convergence_provider(&review).expect("收敛配置解析失败");
        assert_eq!(hook.max_rounds, 2, "review.json max_rounds=2 数据驱动");
    }

    #[test]
    fn convergence_max_rounds_falls_back_and_guards_zero() {
        let hook = build_convergence_provider(&serde_json::json!({})).unwrap();
        assert_eq!(hook.max_rounds, DEFAULT_MAX_ROUNDS);
        // 0/负数声明 → 至少 1 次即冷却（防零上限误伤全部提案）
        let zero = build_convergence_provider(&serde_json::json!({ "max_rounds": 0 })).unwrap();
        assert_eq!(zero.max_rounds, 1);
        let negative =
            build_convergence_provider(&serde_json::json!({ "max_rounds": -3 })).unwrap();
        assert_eq!(negative.max_rounds, 1);
    }

    #[test]
    fn assess_allows_below_limit_and_cools_at_limit() {
        let hook = DataConvergenceHook { max_rounds: 2 };
        let records = vec![
            audit_record("tool", serde_json::json!({ "name": "collect_material" })),
            audit_record("tool", serde_json::json!({ "name": "collect_material" })),
        ];
        let ok = hook.assess(&records[..1], "tool", &serde_json::json!({ "name": "collect_material" }));
        assert!(ok.allowed);
        assert_eq!(ok.state, "ok");
        assert_eq!(ok.target, "tools/collect_material");
        let cooling = hook.assess(&records, "tool", &serde_json::json!({ "name": "collect_material" }));
        assert!(!cooling.allowed);
        assert_eq!(cooling.state, "cooling");
        assert!(cooling.reason.contains("冷却期拒绝"));
        assert!(cooling.reason.contains("tools/collect_material"));
    }

    #[test]
    fn assess_counts_only_same_target() {
        let hook = DataConvergenceHook { max_rounds: 2 };
        let records = vec![
            audit_record("tool", serde_json::json!({ "name": "collect_material" })),
            audit_record("tool", serde_json::json!({ "name": "distill_knowledge" })),
            audit_record("knowledge", serde_json::json!({ "entry": { "id": "k1" } })),
        ];
        // 同类型同目标 1 次 < 2 → 放行
        let ok = hook.assess(&records, "tool", &serde_json::json!({ "name": "collect_material" }));
        assert!(ok.allowed);
        // 不同类型（knowledge）不计入 tool 目标
        let ok = hook.assess(&records, "knowledge", &serde_json::json!({ "entry": { "id": "k2" } }));
        assert!(ok.allowed);
    }

    #[test]
    fn target_key_covers_all_patch_kinds() {
        assert_eq!(
            target_key("tool", &serde_json::json!({ "name": "fetch_web" })),
            "tools/fetch_web"
        );
        assert_eq!(
            target_key("knowledge", &serde_json::json!({ "entry": { "id": "k1" } })),
            "knowledge/k1"
        );
        assert_eq!(
            target_key("knowledge", &serde_json::json!({ "entry_id": "k2" })),
            "knowledge/k2"
        );
        assert_eq!(
            target_key("rule", &serde_json::json!({ "rule": { "id": "r1" } })),
            "rules/r1"
        );
        assert_eq!(
            target_key("rule", &serde_json::json!({ "rule_id": "r2" })),
            "rules/r2"
        );
        assert_eq!(
            target_key("harness", &serde_json::json!({ "definition": { "name": "h1" } })),
            "harness/h1"
        );
        assert_eq!(
            target_key("event_type", &serde_json::json!({ "name": "e1" })),
            "event_types/e1"
        );
        assert_eq!(
            target_key("environment", &serde_json::json!({ "name": "dev" })),
            "environments/dev"
        );
        assert_eq!(
            target_key("artifact", &serde_json::json!({ "artifact_id": "a1" })),
            "artifacts/a1"
        );
        assert_eq!(target_key("theme", &serde_json::json!({})), "theme");
        assert_eq!(
            target_key("ui", &serde_json::json!({})),
            "ui/boot.panel",
            "ui 缺 spec 回落默认面板名"
        );
        assert_eq!(
            target_key("ui", &serde_json::json!({ "spec": { "name": "panel_a" } })),
            "ui/panel_a"
        );
    }

    #[test]
    fn target_key_falls_back_on_invalid_kind_or_payload() {
        assert_eq!(target_key("bogus", &serde_json::json!({})), "bogus/*");
        assert_eq!(target_key("tool", &serde_json::json!({})), "tool/*");
        assert_eq!(target_key("artifact", &serde_json::json!({})), "artifact/*");
    }

    #[test]
    fn audit_window_limits_scan_to_recent_records() {
        // 150 条记录：前 60 条同目标 tool/x，后 90 条 tool/y——
        // 窗口只扫最近 100 条（tool/x 仅 10 条在窗内）
        let mut records = Vec::new();
        for _ in 0..60 {
            records.push(audit_record("tool", serde_json::json!({ "name": "x" })));
        }
        for _ in 0..90 {
            records.push(audit_record("tool", serde_json::json!({ "name": "y" })));
        }
        let hook = DataConvergenceHook { max_rounds: 11 };
        // 全程计数 = 60 ≥ 11（应冷却），窗内计数 = 10 < 11（放行）——窗口生效
        let ok = hook.assess(&records, "tool", &serde_json::json!({ "name": "x" }));
        assert!(ok.allowed, "窗口外变更不计入近期计数");
        let cooling = hook.assess(&records, "tool", &serde_json::json!({ "name": "y" }));
        assert!(!cooling.allowed, "窗内 90 条 ≥ 11 应冷却");
    }

    #[test]
    fn malformed_records_never_hit_a_target() {
        let hook = DataConvergenceHook { max_rounds: 1 };
        let records = vec![
            serde_json::json!({ "kind": 3, "payload": { "name": "x" } }), // kind 非字符串
            serde_json::json!({ "kind": "tool", "payload": "not-an-object" }),
            serde_json::json!({ "kind": "revert" }), // 回退记录（无 payload/未知类型）
            audit_record("bogus", serde_json::json!({})), // 未知类型记录
        ];
        let ok = hook.assess(&records, "tool", &serde_json::json!({ "name": "x" }));
        assert!(ok.allowed, "非法记录不参与同目标计数");
        assert_eq!(target_key_from_record(&records[0]), "");
        assert_eq!(target_key_from_record(&records[1]), "");
    }
}

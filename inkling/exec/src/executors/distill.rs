//! 蒸馏执行体：信号序列 → 结构化知识（绑定 signals.json 五类信号映射）。
//!
//! 镜像引擎 DeterministicDistiller（ink_engine/core/knowledge_signals.py）：
//! - 信号五类（pitfall/user_correction/insight/gap/repeated_root_cause）
//!   及其「可蒸馏」标记来自 signals.json（五类信号→蒸馏器映射，数据单一
//!   事实源；kind 增删只改数据）；
//! - 压缩语义：只保留成功路径结论（user_correction 修正反例优先，insight
//!   次之），踩坑信号汇总进 note（教训来源），试错分支丢弃；
//! - 产物形态 = 引擎教训条目声明：
//!   {"kind": "insight", "insight": {"message", "context", "note"}}——
//!   教训是经验文本无谓词实现，M3 集成时可直接过引擎闸门（L1 形式校验、
//!   L2 对无执行语义教训跳过规则执行）落知识集；
//! - 产物溯源取 primary.source（E23：消息与来源同源，防溯源失真）；
//! - 按需触发（复杂度/干预双阈值，signals.json distill 配置）——双阈值
//!   保守语义：两项都低 = 普通回合不蒸馏（防蒸馏垃圾进垃圾出）。

use crate::json::{object_from_pairs, Object, Value};
use crate::tool::{integer_schema, string_schema, ToolError, ToolErrorKind};

/// 引擎知识条目 kind 常量（与 knowledge_set.py KIND_INSIGHT 对齐）。
pub const KIND_INSIGHT: &str = "insight";

/// 踩坑信号进教训 note 的上限（E24：魔法数字提常量，signals.json
/// distill.pitfall_note_limit 可覆盖——数据驱动与同文件其它阈值一致）。
const DEFAULT_PITFALL_NOTE_LIMIT: usize = 3;

/// 来源可信度缺省排序（真实 signals.json 无 source_ranking 时的回落，
/// 与引擎 knowledge_signals._SOURCE_RANK 一致：user > model > dialog > web）。
const DEFAULT_SOURCE_RANKING: [(&str, i64); 4] =
    [("web", 1), ("dialog", 2), ("model", 3), ("user", 4)];

pub fn schema() -> Value {
    let signal_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("kind".to_string(), string_schema("信号类别"));
                props.insert("message".to_string(), string_schema("信号内容"));
                props.insert(
                    "source".to_string(),
                    string_schema("来源（web/dialog/model/user）"),
                );
                props.insert("context".to_string(), string_schema("关联上下文"));
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![
                Value::String("kind".to_string()),
                Value::String("message".to_string()),
            ]),
        ),
    ]);
    crate::tool::schema_of(
        vec![
            (
                "signals",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    ("items", signal_schema),
                    ("description", Value::String("待蒸馏信号序列".to_string())),
                ]),
            ),
            (
                "complexity",
                integer_schema("任务复杂度（蒸馏按需触发判定用）"),
            ),
            (
                "interventions",
                integer_schema("用户干预次数（蒸馏按需触发判定用）"),
            ),
        ],
        vec!["signals"],
    )
}

/// signals.json 蒸馏配置（信号→蒸馏器映射 + 触发阈值 + 来源可信度排序）。
struct SignalsConfig {
    /// kind → 是否可蒸馏（信号→蒸馏器映射的运行时形态）
    distillable: Vec<(String, bool)>,
    enabled: bool,
    complexity_threshold: i64,
    intervention_threshold: i64,
    /// 来源名 → 可信度排序值（数值大优先）
    source_ranking: Vec<(String, i64)>,
    fallback_source: String,
    /// 踩坑信号进 note 的上限（E24：数据可覆盖）
    pitfall_note_limit: usize,
}

fn load_config() -> Result<SignalsConfig, String> {
    let value = crate::data::load_json_file("signals.json")?;
    let obj = value
        .as_object()
        .ok_or_else(|| "signals.json 声明非法: 期望对象".to_string())?;
    // signal_kinds 双侧兼容（E2）：夹具是对象 {kind: {distillable}}，真实
    // 种子是数组 [{kind, name, distiller, produced_kind}]——可蒸馏标记 =
    // 显式 distillable 布尔，或 produced_kind 非 null（真实形态：非 null
    // 即该信号会产出知识条目）
    let mut distillable = Vec::new();
    match obj.get("signal_kinds") {
        Some(Value::Object(kinds)) => {
            for (kind, meta) in kinds.iter() {
                let flag = meta
                    .as_object()
                    .and_then(|m| m.get_bool("distillable"))
                    .unwrap_or(false);
                distillable.push((kind.to_string(), flag));
            }
        }
        Some(Value::Array(items)) => {
            for item in items {
                let meta = item
                    .as_object()
                    .ok_or_else(|| "signal_kinds 条目须为对象".to_string())?;
                let kind = meta
                    .get_str("kind")
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| "signal_kinds 条目缺 kind".to_string())?;
                let flag = meta
                    .get_bool("distillable")
                    .unwrap_or_else(|| meta.get("produced_kind").is_some_and(|v| !v.is_null()));
                distillable.push((kind.to_string(), flag));
            }
        }
        _ => return Err("signals.json 缺 signal_kinds（对象或清单形态）".to_string()),
    }
    if distillable.is_empty() {
        return Err("signals.json 的 signal_kinds 不能为空".to_string());
    }
    let distill = obj
        .get_object("distill")
        .ok_or_else(|| "signals.json 缺 distill 配置".to_string())?;
    let mut source_ranking = Vec::new();
    if let Some(ranking) = distill.get_object("source_ranking") {
        for (name, rank) in ranking.iter() {
            if let Some(rank) = rank.as_f64() {
                source_ranking.push((name.to_string(), rank as i64));
            }
        }
    }
    // 真实种子无 source_ranking：回落缺省排序（与引擎 _SOURCE_RANK 对齐）
    if source_ranking.is_empty() {
        source_ranking = DEFAULT_SOURCE_RANKING
            .iter()
            .map(|(name, rank)| (name.to_string(), *rank))
            .collect();
    }
    Ok(SignalsConfig {
        distillable,
        enabled: distill.get_bool("enabled").unwrap_or(true),
        complexity_threshold: distill.get_i64("complexity_threshold").unwrap_or(5),
        intervention_threshold: distill.get_i64("intervention_threshold").unwrap_or(1),
        source_ranking,
        fallback_source: distill
            .get_str("fallback_source")
            .unwrap_or("model")
            .to_string(),
        pitfall_note_limit: distill
            .get_i64("pitfall_note_limit")
            .map(|v| v.max(0) as usize)
            .unwrap_or(DEFAULT_PITFALL_NOTE_LIMIT),
    })
}

/// 单条输入信号（已校验形态）。
struct Signal {
    kind: String,
    message: String,
    source: String,
    context: Object,
}

/// 信号类别合法性校验（kind 必须在 signals.json 声明集内）。
fn validate_signals(raw: &Value, config: &SignalsConfig) -> Result<Vec<Signal>, ToolError> {
    let items = raw.as_array().ok_or_else(|| {
        ToolError::new(ToolErrorKind::InvalidParams, "signals 须为清单".to_string())
    })?;
    let valid_kinds: Vec<&str> = config.distillable.iter().map(|(k, _)| k.as_str()).collect();
    let valid_sources: Vec<&str> = config
        .source_ranking
        .iter()
        .map(|(s, _)| s.as_str())
        .collect();
    let mut signals = Vec::with_capacity(items.len());
    for item in items {
        let obj = item.as_object().ok_or_else(|| {
            ToolError::new(ToolErrorKind::InvalidParams, "信号条目须为对象".to_string())
        })?;
        let kind = obj
            .get_str("kind")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::new(ToolErrorKind::InvalidParams, "信号缺 kind".to_string())
            })?;
        if !valid_kinds.contains(&kind) {
            return Err(ToolError::new(
                ToolErrorKind::InvalidParams,
                format!("未知信号类别: {}（仅 {:?}）", kind, valid_kinds),
            ));
        }
        let message = obj
            .get_str("message")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "信号缺 message（字符串）".to_string(),
                )
            })?;
        let source = obj
            .get_str("source")
            .unwrap_or(config.fallback_source.as_str());
        if !valid_sources.contains(&source) {
            return Err(ToolError::new(
                ToolErrorKind::InvalidParams,
                format!("未知信号来源: {}（仅 {:?}）", source, valid_sources),
            ));
        }
        signals.push(Signal {
            kind: kind.to_string(),
            message: message.to_string(),
            source: source.to_string(),
            context: obj.get_object("context").cloned().unwrap_or_default(),
        });
    }
    Ok(signals)
}

/// distill_knowledge：参数 {signals, complexity?, interventions?}。
///
/// 产物：{ok, should_distill, source, data}——data 为 null 表示无可沉淀
/// （全部噪音/无成功路径结论，不产出空知识）；非 null 时为引擎教训条目
/// 声明形态 {"kind": "insight", "insight": {"message", "context", "note"}}。
/// source 取 primary.source（E23：消息与来源同源，杜绝溯源失真）。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let config = load_config().map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;
    let raw_signals = args
        .get("signals")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 signals".to_string()))?;
    let signals = validate_signals(raw_signals, &config)?;
    let complexity = args.get_i64("complexity").unwrap_or(0);
    let interventions = args.get_i64("interventions").unwrap_or(0);

    // 按需触发判定：开关关闭恒 False；开启后走双阈值保守语义
    let should_distill = config.enabled
        && (complexity >= config.complexity_threshold
            || interventions >= config.intervention_threshold);
    if !should_distill {
        return Ok(object_from_pairs(vec![
            ("ok", Value::Bool(true)),
            ("should_distill", Value::Bool(false)),
            (
                "reason",
                Value::String(if config.enabled {
                    format!(
                        "复杂度 {} < {} 且干预 {} < {}（双阈值保守：普通回合不蒸馏）",
                        complexity,
                        config.complexity_threshold,
                        interventions,
                        config.intervention_threshold
                    )
                } else {
                    "蒸馏开关关闭（signals.json distill.enabled=false）".to_string()
                }),
            ),
            ("source", Value::String(config.fallback_source.clone())),
            ("data", Value::Null),
        ]));
    }

    // 可蒸馏信号：仅 user_correction / insight（映射来自 signals.json）
    let usable: Vec<&Signal> = signals
        .iter()
        .filter(|s| {
            config
                .distillable
                .iter()
                .any(|(kind, flag)| *flag && kind == &s.kind)
        })
        .collect();
    if usable.is_empty() {
        return Ok(object_from_pairs(vec![
            ("ok", Value::Bool(true)),
            ("should_distill", Value::Bool(true)),
            (
                "reason",
                Value::String("无可蒸馏信号（无成功路径结论，不产出空知识）".to_string()),
            ),
            ("source", Value::String(config.fallback_source.clone())),
            ("data", Value::Null),
        ]));
    }

    // 修正反例优先（用户反例 = 最可靠规则素材），洞见次之
    let primary = usable
        .iter()
        .find(|s| s.kind == "user_correction")
        .unwrap_or(&usable[0]);
    let pitfalls: Vec<&str> = signals
        .iter()
        .filter(|s| s.kind == "pitfall")
        .take(config.pitfall_note_limit)
        .map(|s| s.message.as_str())
        .collect();
    let note = pitfalls.join("; ");

    let mut insight = Object::new();
    insight.insert(
        "message".to_string(),
        Value::String(primary.message.clone()),
    );
    insight.insert(
        "context".to_string(),
        Value::Object(primary.context.clone()),
    );
    insight.insert("note".to_string(), Value::String(note));

    let mut data = Object::new();
    data.insert("kind".to_string(), Value::String(KIND_INSIGHT.to_string()));
    data.insert("insight".to_string(), Value::Object(insight));

    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("should_distill", Value::Bool(true)),
        (
            "reason",
            Value::String(format!(
                "蒸馏产出：{}（{} 条可蒸馏信号）",
                primary.message,
                usable.len()
            )),
        ),
        ("source", Value::String(primary.source.clone())),
        ("data", Value::Object(data)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn distill(signals_json: &str) -> Value {
        let args = parse(&format!(
            r#"{{"signals": {}, "complexity": 6, "interventions": 2}}"#,
            signals_json
        ))
        .unwrap();
        run(&args).unwrap()
    }

    #[test]
    fn distills_insight_shape_aligned_with_engine() {
        let out = distill(
            r#"[
            {"kind": "insight", "message": "知识沉淀需证据留痕", "source": "model", "context": {"node": "research"}},
            {"kind": "pitfall", "message": "无证据直接落库被拒", "source": "web"}
        ]"#,
        );
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get_bool("should_distill"), Some(true));
        let data = obj.get_object("data").unwrap();
        assert_eq!(data.get_str("kind"), Some("insight"));
        let insight = data.get_object("insight").unwrap();
        assert_eq!(insight.get_str("message"), Some("知识沉淀需证据留痕"));
        assert_eq!(insight.get_str("note"), Some("无证据直接落库被拒"));
        // 来源取最可信：model(3) > web(1)
        assert_eq!(obj.get_str("source"), Some("model"));
    }

    #[test]
    fn user_correction_takes_priority_and_source() {
        let out = distill(
            r#"[
            {"kind": "insight", "message": "洞见甲", "source": "model"},
            {"kind": "user_correction", "message": "反例：必须附来源", "source": "user"}
        ]"#,
        );
        let obj = out.as_object().unwrap();
        let data = obj.get_object("data").unwrap();
        let insight = data.get_object("insight").unwrap();
        assert_eq!(insight.get_str("message"), Some("反例：必须附来源"));
        assert_eq!(obj.get_str("source"), Some("user"));
    }

    #[test]
    fn all_pitfalls_yield_null_data() {
        let out = distill(
            r#"[
            {"kind": "pitfall", "message": "踩坑一", "source": "model"}
        ]"#,
        );
        let obj = out.as_object().unwrap();
        assert_eq!(obj.get("data"), Some(&Value::Null));
    }

    #[test]
    fn unknown_kind_rejected() {
        let args =
            parse(r#"{"signals": [{"kind": "hacker", "message": "x"}], "complexity": 6}"#).unwrap();
        let err = run(&args).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::InvalidParams);
    }

    #[test]
    fn low_complexity_skips_distill() {
        let args = parse(r#"{"signals": [], "complexity": 1, "interventions": 0}"#).unwrap();
        let out = run(&args).unwrap();
        assert_eq!(
            out.as_object().unwrap().get_bool("should_distill"),
            Some(false)
        );
    }

    #[test]
    fn missing_source_falls_back_and_unknown_source_rejected() {
        // E2：source 缺省回落 fallback_source；未知来源结构化拒绝
        let config = SignalsConfig {
            distillable: vec![("insight".to_string(), true)],
            enabled: true,
            complexity_threshold: 5,
            intervention_threshold: 1,
            source_ranking: DEFAULT_SOURCE_RANKING
                .iter()
                .map(|(n, r)| (n.to_string(), *r))
                .collect(),
            fallback_source: "model".to_string(),
            pitfall_note_limit: 3,
        };
        let raw = crate::json::parse(r#"[{"kind": "insight", "message": "x"}]"#).unwrap();
        let signals = validate_signals(&raw, &config).unwrap();
        assert_eq!(signals[0].source, "model");
        let bad =
            crate::json::parse(r#"[{"kind": "insight", "message": "x", "source": "hacker"}]"#)
                .unwrap();
        assert!(validate_signals(&bad, &config).is_err());
    }
}

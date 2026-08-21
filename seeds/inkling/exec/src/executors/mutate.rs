//! 变异执行体：反思式变体生成（镜像引擎 DeterministicMutation）。
//!
//! 变异语义与 ink_engine/core/evolution.py 的 DeterministicMutation 对齐：
//! - 每次变异 = 一条可解释的结构化修订（修订原因 = 失败日志原文）；
//! - 变异输入 = 失败日志（反思式：近期的失败，非成功轨迹）；无失败日志
//!   不产出无依据变异（返回空并说明）；
//! - 变异体数量按失败率/调用频率动态决定（高失败率多探索：每条日志一个
//!   定向修订变体，受 max_variants 上限约束；低失败率一次一个）；
//! - 变异体与母体共享 id 前缀（同一知识的不同版本，随补丁链分支）：
//!   id = "{母体 id}:v{n}"，title 追加「（变异）」；
//! - 变异体 data = 母体 data + "_mutation": {"based_on": 日志, "variant_of":
//!   母体 id}——留痕字段随补丁链可审计、可回退。
//!   产物是否保留由引擎三层闸门（L1/L2/L3）判定，本执行体只产出候选。

use crate::json::{object_from_pairs, Object, Value};
use crate::tool::{integer_schema, number_schema, string_schema, ToolError, ToolErrorKind};

/// 高失败率档位阈值（与引擎 evolution.py _HIGH_FAILURE_RATE 对齐）。
const HIGH_FAILURE_RATE: f64 = 0.3;
/// 变体数量上限出厂默认（与引擎 _MAX_VARIANTS 对齐）。
const DEFAULT_MAX_VARIANTS: i64 = 3;
/// 低失败率时的基础变体数量（与引擎 _BASE_VARIANTS 对齐）。
const BASE_VARIANTS: i64 = 1;

pub fn schema() -> Value {
    let entry_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("id".to_string(), string_schema("母体条目 id"));
                props.insert(
                    "level".to_string(),
                    string_schema("层级（work/project/user）"),
                );
                props.insert("kind".to_string(), string_schema("条目类别"));
                props.insert("data".to_string(), string_schema("条目数据（变异基底）"));
                props.insert("source".to_string(), string_schema("来源"));
                props.insert("credibility".to_string(), number_schema("可信度（0-1）"));
                props.insert("title".to_string(), string_schema("标题"));
                props.insert(
                    "tags".to_string(),
                    object_from_pairs(vec![("description", Value::String("标签清单".to_string()))]),
                );
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![
                Value::String("id".to_string()),
                Value::String("data".to_string()),
            ]),
        ),
    ]);
    crate::tool::schema_of(
        vec![
            ("entry", entry_schema),
            (
                "failure_logs",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    (
                        "items",
                        object_from_pairs(vec![("type", Value::String("string".to_string()))]),
                    ),
                    (
                        "description",
                        Value::String("近期失败日志（反思式变异输入）".to_string()),
                    ),
                ]),
            ),
            ("max_variants", integer_schema("变体数量上限（默认 3）")),
            (
                "failure_rate",
                number_schema("母体失败率（≥0.3 高失败率 → 多探索）"),
            ),
            (
                "usage_count",
                integer_schema("母体调用次数（动态数量判定用）"),
            ),
        ],
        vec!["entry", "failure_logs"],
    )
}

/// inkling_mutate：参数 {entry: {id, data, ...}, failure_logs, max_variants?,
/// failure_rate?, usage_count?}。
///
/// 产物：{ok, variants: [知识条目数据], count}——variants 为空表示无失败
/// 日志（无从反思）或全部被上限截断。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let entry = args
        .get_object("entry")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 entry".to_string()))?;
    let entry_id = entry
        .get_str("id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "entry 缺 id".to_string()))?;
    let entry_data = entry
        .get("data")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "entry 缺 data".to_string()))?;
    let entry_data = entry_data.as_object().cloned().ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::InvalidParams,
            "entry.data 须为对象".to_string(),
        )
    })?;

    let raw_logs = args.get("failure_logs").ok_or_else(|| {
        ToolError::new(ToolErrorKind::InvalidParams, "缺 failure_logs".to_string())
    })?;
    let logs: Vec<&str> = raw_logs
        .as_array()
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::InvalidParams,
                "failure_logs 须为清单".to_string(),
            )
        })?
        .iter()
        .map(|l| {
            l.as_str().ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "failure_logs 条目须为字符串".to_string(),
                )
            })
        })
        .collect::<Result<_, _>>()?;
    if logs.is_empty() {
        return Ok(object_from_pairs(vec![
            ("ok", Value::Bool(true)),
            (
                "reason",
                Value::String("无失败日志（无从反思，不产出无依据变异）".to_string()),
            ),
            ("variants", Value::Array(vec![])),
            ("count", Value::Number(0.0)),
        ]));
    }

    // 变体数量：高失败率 → 每条日志一个定向修订变体（受上限约束）；
    // 低失败率 → 基础单变体（低活跃控知识膨胀）
    let max_variants = args
        .get_i64("max_variants")
        .unwrap_or(DEFAULT_MAX_VARIANTS)
        .max(1);
    let failure_rate = args.get_f64("failure_rate").unwrap_or(0.0);
    let variant_limit = if failure_rate >= HIGH_FAILURE_RATE {
        (max_variants as usize).min(logs.len().max(BASE_VARIANTS as usize))
    } else {
        BASE_VARIANTS as usize
    };
    let selected = &logs[..variant_limit.min(logs.len())];

    let mut variants = Vec::with_capacity(selected.len());
    for (i, log) in selected.iter().enumerate() {
        let mut variant_data = entry_data.clone();
        // 变异留痕：随补丁链可审计（基于哪条失败日志、谁是母体）
        let mut mutation = Object::new();
        mutation.insert("based_on".to_string(), Value::String(log.to_string()));
        mutation.insert(
            "variant_of".to_string(),
            Value::String(entry_id.to_string()),
        );
        variant_data.insert("_mutation".to_string(), Value::Object(mutation));

        let mut variant = Object::new();
        variant.insert(
            "id".to_string(),
            Value::String(format!("{}:v{}", entry_id, i + 1)),
        );
        variant.insert(
            "level".to_string(),
            Value::String(entry.get_str("level").unwrap_or("work").to_string()),
        );
        variant.insert(
            "kind".to_string(),
            Value::String(entry.get_str("kind").unwrap_or("rule").to_string()),
        );
        variant.insert("data".to_string(), Value::Object(variant_data));
        variant.insert(
            "source".to_string(),
            Value::String(entry.get_str("source").unwrap_or("model").to_string()),
        );
        variant.insert(
            "credibility".to_string(),
            entry
                .get_f64("credibility")
                .map(Value::Number)
                .unwrap_or(Value::Number(0.5)),
        );
        let title = entry.get_str("title").unwrap_or("");
        variant.insert(
            "title".to_string(),
            Value::String(if title.is_empty() {
                "（变异）".to_string()
            } else {
                format!("{}（变异）", title)
            }),
        );
        variant.insert(
            "tags".to_string(),
            entry
                .get("tags")
                .cloned()
                .unwrap_or_else(|| Value::Array(vec![])),
        );
        variants.push(Value::Object(variant));
    }

    let count = variants.len();
    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        (
            "reason",
            Value::String(format!(
                "反思式变异：{} 条失败日志 → {} 个变体（失败率 {:.2}）",
                logs.len(),
                variants.len(),
                failure_rate
            )),
        ),
        ("variants", Value::Array(variants)),
        ("count", Value::Number(count as f64)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn variant_shape_matches_engine_contract() {
        let args = parse(
            r#"{
                "entry": {"id": "e1", "level": "work", "kind": "rule", "data": {"path": "a"}, "title": "规则一", "tags": ["t"]},
                "failure_logs": ["误判一", "误判二"],
                "failure_rate": 0.5,
                "max_variants": 3
            }"#,
        )
        .unwrap();
        let out = run(&args).unwrap();
        let obj = out.as_object().unwrap();
        let variants = obj.get_array("variants").unwrap();
        assert_eq!(variants.len(), 2);
        let variant = variants[0].as_object().unwrap();
        assert_eq!(variant.get_str("id"), Some("e1:v1"));
        assert_eq!(variant.get_str("title"), Some("规则一（变异）"));
        let data = variant.get_object("data").unwrap();
        let mutation = data.get_object("_mutation").unwrap();
        assert_eq!(mutation.get_str("based_on"), Some("误判一"));
        assert_eq!(mutation.get_str("variant_of"), Some("e1"));
        assert_eq!(data.get_str("path"), Some("a"));
    }

    #[test]
    fn no_logs_yields_no_variants() {
        let args = parse(r#"{"entry": {"id": "e1", "data": {}}, "failure_logs": []}"#).unwrap();
        let out = run(&args).unwrap();
        assert_eq!(
            out.as_object().unwrap().get("variants"),
            Some(&Value::Array(vec![]))
        );
    }

    #[test]
    fn low_failure_rate_yields_single_variant() {
        let args = parse(
            r#"{
                "entry": {"id": "e1", "data": {}},
                "failure_logs": ["a", "b", "c"],
                "failure_rate": 0.1
            }"#,
        )
        .unwrap();
        let out = run(&args).unwrap();
        assert_eq!(out.as_object().unwrap().get_f64("count"), Some(1.0));
    }
}

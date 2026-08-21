//! 评分执行体：引用质量 + 交叉验证（绑定 samples.json 基准事实）。
//!
//! 确定性评分四维度：引用可验证性（quote 须出现在所引来源文本中）、
//! 引用完备性（每个断言至少一条引用）、交叉验证（断言与样例库 facts
//! 基准事实的重叠度）、证据覆盖率（既有引用又被基准事实支持的断言
//! 占比）。总分为四维加权均值（权重可经参数覆盖，缺省出厂口径）。
//! 交叉验证是「样例库 = 数据 ↔ 执行件绑定」的运行时落点：samples.json
//! 的 facts 是交叉验证的基准，测试断言两者不漂移。

use crate::json::{object_from_pairs, Object, Value};
use crate::tool::{number_schema, string_schema, ToolError, ToolErrorKind};

/// 出厂默认权重（总和 1.0：引用可验证性/完备性/交叉验证各 0.3，覆盖率 0.1）。
const DEFAULT_WEIGHTS: [(&str, f64); 4] = [
    ("citation_completeness", 0.3),
    ("quote_accuracy", 0.3),
    ("cross_validation", 0.3),
    ("coverage", 0.1),
];

pub fn schema() -> Value {
    let claim_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("text".to_string(), string_schema("断言文本"));
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![Value::String("text".to_string())]),
        ),
    ]);
    let citation_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("claim_index".to_string(), number_schema("断言下标"));
                props.insert("source_id".to_string(), string_schema("来源 id"));
                props.insert("quote".to_string(), string_schema("引用原文"));
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![
                Value::String("claim_index".to_string()),
                Value::String("source_id".to_string()),
                Value::String("quote".to_string()),
            ]),
        ),
    ]);
    let source_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("id".to_string(), string_schema("来源 id"));
                props.insert("title".to_string(), string_schema("来源标题"));
                props.insert("text".to_string(), string_schema("来源正文"));
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![
                Value::String("id".to_string()),
                Value::String("text".to_string()),
            ]),
        ),
    ]);
    crate::tool::schema_of(
        vec![
            (
                "answer",
                object_from_pairs(vec![
                    ("type", Value::String("object".to_string())),
                    (
                        "properties",
                        Value::Object({
                            let mut props = crate::json::Object::new();
                            props.insert("text".to_string(), string_schema("候选答案文本"));
                            props.insert("claims".to_string(), {
                                let mut s = object_from_pairs(vec![(
                                    "type",
                                    Value::String("array".to_string()),
                                )]);
                                if let Value::Object(o) = &mut s {
                                    o.insert("items".to_string(), claim_schema);
                                }
                                s
                            });
                            props.insert("citations".to_string(), {
                                let mut s = object_from_pairs(vec![(
                                    "type",
                                    Value::String("array".to_string()),
                                )]);
                                if let Value::Object(o) = &mut s {
                                    o.insert("items".to_string(), citation_schema);
                                }
                                s
                            });
                            props
                        }),
                    ),
                    (
                        "required",
                        Value::Array(vec![Value::String("claims".to_string())]),
                    ),
                ]),
            ),
            (
                "sources",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    ("items", source_schema),
                    (
                        "description",
                        Value::String("引用来源文本（可验证性基准）".to_string()),
                    ),
                ]),
            ),
            (
                "weights",
                object_from_pairs(vec![(
                    "description",
                    Value::String("四维度权重覆盖（缺省 = 出厂默认口径，总和 1.0）".to_string()),
                )]),
            ),
        ],
        vec!["answer"],
    )
}

/// 归一化：小写 + 折叠空白（交叉验证的宽松匹配基准）。
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_space && !out.is_empty() {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(ch.to_lowercase().next().unwrap_or(ch));
            prev_space = false;
        }
    }
    out.trim_end().to_string()
}

/// 断言是否被基准事实支持：断言文本归一化后包含于任一事实陈述。
fn cross_validated(claim: &str, facts: &[&str]) -> bool {
    let needle = normalize(claim);
    if needle.is_empty() {
        return false;
    }
    facts.iter().any(|f| normalize(f).contains(&needle))
}

/// inkling_score：参数 {answer: {claims, citations?}, sources?, weights?}。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let answer = args
        .get_object("answer")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 answer".to_string()))?;
    let claims: Vec<&str> = answer
        .get_array("claims")
        .ok_or_else(|| {
            ToolError::new(ToolErrorKind::InvalidParams, "缺 answer.claims".to_string())
        })?
        .iter()
        .map(|c| {
            c.as_object()
                .and_then(|o| o.get_str("text"))
                .ok_or_else(|| {
                    ToolError::new(ToolErrorKind::InvalidParams, "claim 缺 text".to_string())
                })
        })
        .collect::<Result<_, _>>()?;
    if claims.is_empty() {
        return Err(ToolError::new(
            ToolErrorKind::InvalidParams,
            "claims 不能为空".to_string(),
        ));
    }

    // 引用表：claim_index → (source_id, quote)
    let citations: Vec<(usize, String, String)> = match answer.get_array("citations") {
        Some(items) => items
            .iter()
            .map(|c| {
                let obj = c.as_object().ok_or_else(|| {
                    ToolError::new(
                        ToolErrorKind::InvalidParams,
                        "citation 须为对象".to_string(),
                    )
                })?;
                let index = obj.get_i64("claim_index").ok_or_else(|| {
                    ToolError::new(
                        ToolErrorKind::InvalidParams,
                        "citation 缺 claim_index".to_string(),
                    )
                })?;
                if index < 0 || index as usize >= claims.len() {
                    return Err(ToolError::new(
                        ToolErrorKind::InvalidParams,
                        format!("citation 的 claim_index 越界: {}", index),
                    ));
                }
                let source_id = obj
                    .get_str("source_id")
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorKind::InvalidParams,
                            "citation 缺 source_id".to_string(),
                        )
                    })?;
                let quote = obj
                    .get_str("quote")
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorKind::InvalidParams,
                            "citation 缺 quote".to_string(),
                        )
                    })?;
                Ok((index as usize, source_id.to_string(), quote.to_string()))
            })
            .collect::<Result<_, _>>()?,
        None => Vec::new(),
    };

    // 来源表：id → 正文
    let mut sources: Object = Object::new();
    if let Some(items) = args.get_array("sources") {
        for item in items {
            let obj = item.as_object().ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "sources 条目须为对象".to_string(),
                )
            })?;
            let id = obj.get_str("id").filter(|s| !s.is_empty()).ok_or_else(|| {
                ToolError::new(ToolErrorKind::InvalidParams, "source 缺 id".to_string())
            })?;
            let text = obj.get_str("text").ok_or_else(|| {
                ToolError::new(ToolErrorKind::InvalidParams, "source 缺 text".to_string())
            })?;
            sources.insert(id.to_string(), Value::String(text.to_string()));
        }
    }

    // 权重解析：缺省出厂口径；提供时须为四维之一且为正
    let mut weights: Vec<(&str, f64)> = DEFAULT_WEIGHTS.to_vec();
    if let Some(raw) = args.get_object("weights") {
        for (name, value) in raw.iter() {
            if !weights.iter().any(|(w, _)| *w == name) {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("未知评分维度: {}（仅 citation_completeness/quote_accuracy/cross_validation/coverage）", name),
                ));
            }
            let score = value.as_f64().ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("权重 {} 须为数值", name),
                )
            })?;
            if score <= 0.0 {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("权重 {} 须为正数", name),
                ));
            }
            weights.iter_mut().find(|(w, _)| *w == name).unwrap().1 = score;
        }
    }

    // 基准事实（样例库数据绑定）：samples.json facts → 交叉验证基准
    let samples = crate::data::load_json_file("samples.json")
        .map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;
    let facts: Vec<String> = samples
        .as_object()
        .and_then(|o| o.get_array("facts"))
        .unwrap_or(&[])
        .iter()
        .filter_map(|f| f.as_object().and_then(|o| o.get_str("statement")))
        .map(|s| s.to_string())
        .collect();
    let fact_refs: Vec<&str> = facts.iter().map(String::as_str).collect();

    // 引用可验证性：quote 是所引来源正文的子串（宽松：去掉首尾空白后比较）
    let verified_citations: Vec<bool> = citations
        .iter()
        .map(|(_, source_id, quote)| {
            sources
                .get_str(source_id)
                .map(|text| {
                    let t = text.trim();
                    let q = quote.trim();
                    !q.is_empty() && (t.contains(q) || normalize(t).contains(&normalize(q)))
                })
                .unwrap_or(false)
        })
        .collect();

    // 引用完备性：每个断言是否至少一条引用
    let cited_claims: Vec<bool> = (0..claims.len())
        .map(|i| citations.iter().any(|(idx, _, _)| *idx == i))
        .collect();

    // 交叉验证：断言被样例库基准事实支持
    let validated_claims: Vec<bool> = claims
        .iter()
        .map(|c| cross_validated(c, &fact_refs))
        .collect();

    // 证据覆盖率：既有引用又被基准支持
    let covered_claims: Vec<bool> = (0..claims.len())
        .map(|i| cited_claims[i] && validated_claims[i])
        .collect();

    let total_claims = claims.len() as f64;
    let ratio = |items: &[bool]| {
        if items.is_empty() {
            0.0
        } else {
            items.iter().filter(|b| **b).count() as f64 / total_claims
        }
    };
    let citation_completeness = ratio(&cited_claims);
    let quote_accuracy = if citations.is_empty() {
        0.0
    } else {
        verified_citations.iter().filter(|v| **v).count() as f64 / citations.len() as f64
    };
    let cross_validation = ratio(&validated_claims);
    let coverage = ratio(&covered_claims);

    let weight_sum: f64 = weights.iter().map(|(_, w)| w).sum();
    let total = (citation_completeness * weight_of(&weights, "citation_completeness")
        + quote_accuracy * weight_of(&weights, "quote_accuracy")
        + cross_validation * weight_of(&weights, "cross_validation")
        + coverage * weight_of(&weights, "coverage"))
        / weight_sum;

    let checks = Value::Array(vec![
        object_from_pairs(vec![
            ("name", Value::String("citation_completeness".to_string())),
            ("score", Value::Number(citation_completeness)),
            ("note", Value::String("带引用的断言占比".to_string())),
        ]),
        object_from_pairs(vec![
            ("name", Value::String("quote_accuracy".to_string())),
            ("score", Value::Number(quote_accuracy)),
            (
                "note",
                Value::String(if citations.is_empty() {
                    "无引用可验证".to_string()
                } else {
                    "quote 在来源正文中可验证的引用占比".to_string()
                }),
            ),
        ]),
        object_from_pairs(vec![
            ("name", Value::String("cross_validation".to_string())),
            ("score", Value::Number(cross_validation)),
            (
                "note",
                Value::String("被样例库基准事实支持的断言占比".to_string()),
            ),
        ]),
        object_from_pairs(vec![
            ("name", Value::String("coverage".to_string())),
            ("score", Value::Number(coverage)),
            (
                "note",
                Value::String("既有引用又被基准支持的断言占比".to_string()),
            ),
        ]),
    ]);

    let claim_details: Vec<Value> = (0..claims.len())
        .map(|i| {
            object_from_pairs(vec![
                ("index", Value::Number(i as f64)),
                ("text", Value::String(claims[i].to_string())),
                ("cited", Value::Bool(cited_claims[i])),
                ("cross_validated", Value::Bool(validated_claims[i])),
                ("covered", Value::Bool(covered_claims[i])),
            ])
        })
        .collect();
    let citation_details: Vec<Value> = citations
        .iter()
        .zip(verified_citations.iter())
        .map(|((idx, source_id, quote), verified)| {
            object_from_pairs(vec![
                ("claim_index", Value::Number(*idx as f64)),
                ("source_id", Value::String(source_id.clone())),
                ("quote", Value::String(quote.clone())),
                ("verified", Value::Bool(*verified)),
            ])
        })
        .collect();

    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("total", Value::Number(total)),
        ("checks", checks),
        (
            "details",
            object_from_pairs(vec![
                ("claims", Value::Array(claim_details)),
                ("citations", Value::Array(citation_details)),
                ("facts_used", Value::Number(facts.len() as f64)),
            ]),
        ),
    ]))
}

fn weight_of(weights: &[(&str, f64)], name: &str) -> f64 {
    weights
        .iter()
        .find(|(w, _)| *w == name)
        .map(|(_, w)| *w)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_whitespace_and_case() {
        assert_eq!(normalize("  A  B \n C "), "a b c");
    }

    #[test]
    fn cross_validates_against_facts() {
        let facts = vec!["自进化系统把使用中积累的理解沉淀为可信的知识"];
        assert!(cross_validated("沉淀为可信的知识", &facts));
        assert!(!cross_validated("完全无关的断言", &facts));
    }
}

//! 评审执行体：维度加权打分 + 阈值判定 + 收敛决策（绑定 review.json）。
//!
//! 镜像引擎语义（ink_engine/core/scoring.py 的 WeightedScorer 与
//! core/review.py 的 MaxRoundsConvergencePolicy）：
//! - 加权均值 total = Σ(score_i × weight_i) / Σ(weight_i)；
//! - 维度达标线：低于配置 threshold 的维度进 failing_dimensions；
//! - 通过判定：total ≥ pass_threshold 且 total ≥ overall_threshold（配置
//!   了时）——与引擎「评审器阈值 + 策略阈值双重门槛」同构；
//! - 收敛决策：有达标候选 → 收敛取最高分；未达标且达轮次上限 → 呈交
//!   现状交卡回路；否则取分数前 beam 个候选再生成。
//!   维度得分可显式传入（宿主/LLM 评审提供），缺省用确定性启发式口径
//!   （零 LLM 可测试）。review.json 是维度的单一事实源：维度增删/阈值
//!   调整只改数据，执行体零改动。

use crate::json::{object_from_pairs, Object, Value};
use crate::tool::{integer_schema, number_schema, string_schema, ToolError, ToolErrorKind};

pub fn schema() -> Value {
    let candidate_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("text".to_string(), string_schema("候选文本"));
                props.insert(
                    "claims".to_string(),
                    object_from_pairs(vec![(
                        "description",
                        Value::String("断言清单（完备性启发式用）".to_string()),
                    )]),
                );
                props.insert(
                    "citations".to_string(),
                    object_from_pairs(vec![(
                        "description",
                        Value::String("引用清单（证据启发式用）".to_string()),
                    )]),
                );
                props.insert("topic".to_string(), string_schema("主题（相关性启发式用）"));
                props
            }),
        ),
    ]);
    let dimension_score_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        (
            "properties",
            Value::Object({
                let mut props = crate::json::Object::new();
                props.insert("candidate_index".to_string(), number_schema("候选下标"));
                props.insert("name".to_string(), string_schema("维度名"));
                props.insert("score".to_string(), number_schema("得分（0-1）"));
                props
            }),
        ),
        (
            "required",
            Value::Array(vec![
                Value::String("candidate_index".to_string()),
                Value::String("name".to_string()),
                Value::String("score".to_string()),
            ]),
        ),
    ]);
    crate::tool::schema_of(
        vec![
            (
                "candidates",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    ("items", candidate_schema),
                    ("description", Value::String("待评审候选清单".to_string())),
                ]),
            ),
            (
                "dimension_scores",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    ("items", dimension_score_schema),
                    (
                        "description",
                        Value::String("显式维度得分（缺省 = 确定性启发式默认口径）".to_string()),
                    ),
                ]),
            ),
            ("round_no", integer_schema("当前再生成轮次（收敛决策用）")),
        ],
        vec!["candidates"],
    )
}

/// review.json 解析出的评审配置（维度 = 数据，单一事实源）。
struct ReviewConfig {
    dimensions: Vec<Dimension>,
    overall_threshold: Option<f64>,
    pass_threshold: f64,
    max_rounds: i64,
    beam_width: usize,
    web_verify_enabled: bool,
}

struct Dimension {
    name: String,
    weight: f64,
    threshold: Option<f64>,
}

fn load_config() -> Result<ReviewConfig, String> {
    let value = crate::data::load_json_file("review.json")?;
    let obj = value
        .as_object()
        .ok_or_else(|| "review.json 声明非法: 期望对象".to_string())?;
    let raw_dimensions = obj
        .get_array("dimensions")
        .ok_or_else(|| "review.json 缺 dimensions 清单".to_string())?;
    let mut dimensions = Vec::with_capacity(raw_dimensions.len());
    let mut names: Vec<&str> = Vec::new();
    for raw in raw_dimensions {
        let dim = raw
            .as_object()
            .ok_or_else(|| "维度声明非法: 期望对象".to_string())?;
        let name = dim
            .get_str("name")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "维度声明缺 name".to_string())?;
        if names.contains(&name) {
            return Err(format!("维度名重复: {}", name));
        }
        names.push(name);
        let weight = dim
            .get_f64("weight")
            .ok_or_else(|| format!("维度 {} 缺 weight", name))?;
        if weight <= 0.0 {
            return Err(format!("维度 {} 的权重必须为正: {}", name, weight));
        }
        let threshold = dim.get_f64("threshold").filter(|t| *t >= 0.0 && *t <= 1.0);
        dimensions.push(Dimension {
            name: name.to_string(),
            weight,
            threshold,
        });
    }
    if dimensions.is_empty() {
        return Err("review.json 的 dimensions 不能为空".to_string());
    }
    let clamp_01 = |v: f64, what: &str| -> Result<f64, String> {
        if (0.0..=1.0).contains(&v) {
            Ok(v)
        } else {
            Err(format!("{} 必须在 [0, 1] 内: {}", what, v))
        }
    };
    let pass_threshold = clamp_01(
        obj.get_f64("pass_threshold").unwrap_or(0.75),
        "pass_threshold",
    )?;
    let overall_threshold = obj
        .get_f64("overall_threshold")
        .map(|v| clamp_01(v, "overall_threshold"))
        .transpose()?;
    let max_rounds = obj.get_i64("max_rounds").unwrap_or(2).max(0);
    let beam_width = obj.get_i64("beam_width").unwrap_or(1).max(1) as usize;
    Ok(ReviewConfig {
        dimensions,
        overall_threshold,
        pass_threshold,
        max_rounds,
        beam_width,
        web_verify_enabled: obj.get_bool("web_verify_enabled").unwrap_or(false),
    })
}

// -- 确定性启发式默认口径（零 LLM 可测试；显式得分提供时被覆盖） ----------

fn heuristic_evidence(candidate: &Object) -> f64 {
    let citations = candidate
        .get_array("citations")
        .map(|c| c.len())
        .unwrap_or(0);
    match citations {
        0 => 0.4,
        n if n >= 3 => 1.0,
        n => n as f64 / 3.0,
    }
}

fn heuristic_relevance(candidate: &Object) -> f64 {
    let Some(topic) = candidate.get_str("topic") else {
        return 0.7;
    };
    let text = candidate.get_str("text").unwrap_or("");
    let words: Vec<&str> = topic.split_whitespace().collect();
    if words.is_empty() {
        return 0.7;
    }
    let hit = words.iter().filter(|w| text.contains(**w)).count();
    hit as f64 / words.len() as f64
}

fn heuristic_clarity(candidate: &Object) -> f64 {
    let len = candidate.get_str("text").map(|t| t.len()).unwrap_or(0);
    if len >= 80 {
        0.9
    } else if len >= 20 {
        0.7
    } else {
        0.4
    }
}

fn heuristic_completeness(candidate: &Object) -> f64 {
    let claims = candidate.get_array("claims").map(|c| c.len()).unwrap_or(0);
    match claims {
        0 => 0.3,
        n if n >= 3 => 0.9,
        _ => 0.7,
    }
}

// -- 加权打分（WeightedScorer 同语义） ------------------------------------

struct Review {
    candidate_index: usize,
    score: f64,
    passed: bool,
    feedback: String,
    failing: Vec<String>,
    dimension_scores: Vec<(String, f64)>,
}

fn score_candidate(
    candidate_index: usize,
    candidate: &Object,
    config: &ReviewConfig,
    explicit: Option<&Object>,
) -> Result<Review, ToolError> {
    // 显式得分：提供即用（该候选全部配置维度须齐全——口径漂移宁可报错
    // 不静默忽略，与引擎 WeightedScorer 一致）；未提供走启发式默认口径
    let mut scores: Vec<(String, f64)> = Vec::with_capacity(config.dimensions.len());
    let mut heuristic_used = false;
    if let Some(explicit) = explicit {
        let mut names: Vec<&str> = Vec::new();
        for (name, value) in explicit.iter() {
            if !config.dimensions.iter().any(|d| d.name == name) {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!(
                        "未知打分维度: {}（配置 {:?}）",
                        name,
                        config_dim_names(config)
                    ),
                ));
            }
            let score = value.as_f64().ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("维度 {} 得分须为数值", name),
                )
            })?;
            if !(0.0..=1.0).contains(&score) {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("维度 {} 得分必须在 [0, 1] 内: {}", name, score),
                ));
            }
            names.push(name);
            scores.push((name.to_string(), score));
        }
        for dim in &config.dimensions {
            if !names.contains(&dim.name.as_str()) {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!(
                        "未提供维度 {} 的得分（配置 {:?}）",
                        dim.name,
                        config_dim_names(config)
                    ),
                ));
            }
        }
    } else {
        for dim in &config.dimensions {
            let score = match dim.name.as_str() {
                "evidence" => heuristic_evidence(candidate),
                "relevance" => heuristic_relevance(candidate),
                "clarity" => heuristic_clarity(candidate),
                "completeness" => heuristic_completeness(candidate),
                // 未知维度名出现在配置里 = 数据漂移：报错让数据侧修复
                other => {
                    return Err(ToolError::new(
                        ToolErrorKind::ToolError,
                        format!(
                            "review.json 含执行体未知维度: {}（数据漂移，须修数据）",
                            other
                        ),
                    ))
                }
            };
            scores.push((dim.name.clone(), score));
        }
        heuristic_used = true;
    }

    let weight_sum: f64 = config.dimensions.iter().map(|d| d.weight).sum();
    let mut weighted = 0.0;
    let mut failing = Vec::new();
    for dim in &config.dimensions {
        let score = scores
            .iter()
            .find(|(n, _)| *n == dim.name)
            .map(|(_, s)| *s)
            .unwrap_or(0.0);
        weighted += score * dim.weight;
        if dim.threshold.is_some_and(|t| score < t) {
            failing.push(dim.name.clone());
        }
    }
    let total = weighted / weight_sum;
    let passed =
        total >= config.pass_threshold && config.overall_threshold.is_none_or(|t| total >= t);

    let mut feedback_parts: Vec<String> = failing
        .iter()
        .map(|name| {
            let dim = config.dimensions.iter().find(|d| &d.name == name).unwrap();
            let score = scores
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, s)| *s)
                .unwrap_or(0.0);
            format!(
                "维度 {} 得分 {:.2} 低于达标线 {:.2}",
                name,
                score,
                dim.threshold.unwrap_or(0.0)
            )
        })
        .collect();
    if heuristic_used {
        feedback_parts.push("维度得分为确定性启发式默认口径（未显式提供）".to_string());
    }
    Ok(Review {
        candidate_index,
        score: total,
        passed,
        feedback: feedback_parts.join("；"),
        failing,
        dimension_scores: scores,
    })
}

fn config_dim_names(config: &ReviewConfig) -> Vec<String> {
    config.dimensions.iter().map(|d| d.name.clone()).collect()
}

// -- 收敛决策（MaxRoundsConvergencePolicy 同语义） ------------------------

struct Decision {
    converged: bool,
    accepted_indices: Vec<usize>,
    regenerate_indices: Vec<usize>,
    notes: Vec<String>,
}

fn decide(reviews: &[Review], config: &ReviewConfig, round_no: i64) -> Decision {
    if reviews.is_empty() {
        return Decision {
            converged: false,
            accepted_indices: Vec::new(),
            regenerate_indices: Vec::new(),
            notes: vec!["无候选可评审".to_string()],
        };
    }
    // 达标者取最高分（同分取靠前者——与引擎 max 语义一致）
    if let Some(best) = reviews.iter().filter(|r| r.passed).max_by(|a, b| {
        a.score
            .partial_cmp(&b.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        return Decision {
            converged: true,
            accepted_indices: vec![best.candidate_index],
            regenerate_indices: Vec::new(),
            notes: vec![format!(
                "候选[{}] 达标（{:.2}），收敛",
                best.candidate_index, best.score
            )],
        };
    }
    if round_no >= config.max_rounds {
        let best = reviews
            .iter()
            .max_by(|a, b| {
                a.score
                    .partial_cmp(&b.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap();
        return Decision {
            converged: false,
            accepted_indices: Vec::new(),
            regenerate_indices: Vec::new(),
            notes: vec![format!(
                "达轮次上限（{}/{}），呈交现状，最优候选[{}] 得分 {:.2}",
                round_no, config.max_rounds, best.candidate_index, best.score
            )],
        };
    }
    let mut ranked: Vec<&Review> = reviews.iter().collect();
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let picks: Vec<usize> = ranked
        .iter()
        .take(config.beam_width)
        .map(|r| r.candidate_index)
        .collect();
    Decision {
        converged: false,
        accepted_indices: Vec::new(),
        regenerate_indices: picks.clone(),
        notes: vec![format!(
            "第 {} 轮未达标，再生成候选 {:?}",
            round_no + 1,
            picks
        )],
    }
}

/// inkling_review：参数 {candidates, dimension_scores?, round_no?}。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let raw_candidates = args
        .get_array("candidates")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 candidates".to_string()))?;
    let config = load_config().map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;

    // 显式维度得分索引：candidate_index → {name: score}
    let mut explicit: Vec<Option<Object>> = vec![None; raw_candidates.len()];
    if let Some(items) = args.get_array("dimension_scores") {
        for item in items {
            let obj = item.as_object().ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "dimension_scores 条目须为对象".to_string(),
                )
            })?;
            let index = obj.get_i64("candidate_index").ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "dimension_scores 缺 candidate_index".to_string(),
                )
            })?;
            if index < 0 || index as usize >= raw_candidates.len() {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("dimension_scores 的 candidate_index 越界: {}", index),
                ));
            }
            let name = obj
                .get_str("name")
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    ToolError::new(
                        ToolErrorKind::InvalidParams,
                        "dimension_scores 缺 name".to_string(),
                    )
                })?;
            let score = obj.get_f64("score").ok_or_else(|| {
                ToolError::new(
                    ToolErrorKind::InvalidParams,
                    "dimension_scores 缺 score".to_string(),
                )
            })?;
            if !(0.0..=1.0).contains(&score) {
                return Err(ToolError::new(
                    ToolErrorKind::InvalidParams,
                    format!("维度 {} 得分必须在 [0, 1] 内: {}", name, score),
                ));
            }
            let slot = &mut explicit[index as usize];
            if slot.is_none() {
                *slot = Some(Object::new());
            }
            slot.as_mut()
                .unwrap()
                .insert(name.to_string(), Value::Number(score));
        }
    }

    let mut reviews = Vec::with_capacity(raw_candidates.len());
    for (i, raw) in raw_candidates.iter().enumerate() {
        let candidate = raw.as_object().ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::InvalidParams,
                "candidates 条目须为对象".to_string(),
            )
        })?;
        reviews.push(score_candidate(
            i,
            candidate,
            &config,
            explicit[i].as_ref(),
        )?);
    }
    let round_no = args.get_i64("round_no").unwrap_or(0);
    let decision = decide(&reviews, &config, round_no);

    let review_values: Vec<Value> = reviews
        .iter()
        .map(|r| {
            object_from_pairs(vec![
                ("candidate_index", Value::Number(r.candidate_index as f64)),
                ("score", Value::Number(r.score)),
                ("passed", Value::Bool(r.passed)),
                ("feedback", Value::String(r.feedback.clone())),
                (
                    "failing_dimensions",
                    Value::Array(r.failing.iter().map(|n| Value::String(n.clone())).collect()),
                ),
                (
                    "dimension_scores",
                    Value::Object({
                        let mut obj = Object::new();
                        for (name, score) in &r.dimension_scores {
                            obj.insert(name.clone(), Value::Number(*score));
                        }
                        obj
                    }),
                ),
            ])
        })
        .collect();

    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("reviews", Value::Array(review_values)),
        (
            "decision",
            object_from_pairs(vec![
                ("converged", Value::Bool(decision.converged)),
                (
                    "accepted_indices",
                    Value::Array(
                        decision
                            .accepted_indices
                            .iter()
                            .map(|i| Value::Number(*i as f64))
                            .collect(),
                    ),
                ),
                (
                    "regenerate_indices",
                    Value::Array(
                        decision
                            .regenerate_indices
                            .iter()
                            .map(|i| Value::Number(*i as f64))
                            .collect(),
                    ),
                ),
                (
                    "notes",
                    Value::Array(
                        decision
                            .notes
                            .iter()
                            .map(|n| Value::String(n.clone()))
                            .collect(),
                    ),
                ),
            ]),
        ),
        (
            "config",
            object_from_pairs(vec![
                ("pass_threshold", Value::Number(config.pass_threshold)),
                (
                    "overall_threshold",
                    config
                        .overall_threshold
                        .map(Value::Number)
                        .unwrap_or(Value::Null),
                ),
                ("max_rounds", Value::Number(config.max_rounds as f64)),
                ("beam_width", Value::Number(config.beam_width as f64)),
                ("web_verify_enabled", Value::Bool(config.web_verify_enabled)),
            ]),
        ),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn weighted_total_matches_hand_calculation() {
        let args = parse(
            r#"{
                "candidates": [{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a", "b", "c"]}],
                "dimension_scores": [
                    {"candidate_index": 0, "name": "evidence", "score": 0.9},
                    {"candidate_index": 0, "name": "relevance", "score": 0.8},
                    {"candidate_index": 0, "name": "clarity", "score": 0.8},
                    {"candidate_index": 0, "name": "completeness", "score": 0.8}
                ]
            }"#,
        )
        .unwrap();
        let out = run(&args).unwrap();
        let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
        let score = reviews[0].as_object().unwrap().get_f64("score").unwrap();
        // 0.4*0.9 + 0.3*0.8 + 0.2*0.8 + 0.1*0.8 = 0.84（review.json 权重）
        assert!((score - 0.84).abs() < 1e-9, "实际 {}", score);
        let decision = out.as_object().unwrap().get_object("decision").unwrap();
        assert_eq!(decision.get_bool("converged"), Some(true));
    }

    #[test]
    fn below_threshold_is_not_passed() {
        let args = parse(
            r#"{
                "candidates": [{"text": "okokokokokokokokokokokokokokokokokokokok", "claims": ["a", "b"]}],
                "dimension_scores": [
                    {"candidate_index": 0, "name": "evidence", "score": 0.2},
                    {"candidate_index": 0, "name": "relevance", "score": 0.8},
                    {"candidate_index": 0, "name": "clarity", "score": 0.8},
                    {"candidate_index": 0, "name": "completeness", "score": 0.8}
                ]
            }"#,
        )
        .unwrap();
        let out = run(&args).unwrap();
        let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
        let review = reviews[0].as_object().unwrap();
        assert_eq!(review.get_bool("passed"), Some(false));
        let failing = review.get_array("failing_dimensions").unwrap();
        assert_eq!(failing.len(), 1);
        assert_eq!(failing[0].as_str(), Some("evidence"));
        let decision = out.as_object().unwrap().get_object("decision").unwrap();
        assert_eq!(decision.get_bool("converged"), Some(false));
        assert_eq!(
            decision
                .get_array("regenerate_indices")
                .unwrap()
                .first()
                .and_then(|v| v.as_f64()),
            Some(0.0)
        );
    }

    #[test]
    fn unknown_dimension_is_rejected() {
        let args = parse(
            r#"{
                "candidates": [{"text": "x"}],
                "dimension_scores": [
                    {"candidate_index": 0, "name": "magic", "score": 0.9}
                ]
            }"#,
        )
        .unwrap();
        assert!(run(&args).is_err());
    }
}

//! 推演评估域：review.json 打分配置 → 确定性维度打分器（facts 交叉验证）。
//!
//! 评审/推演共用的打分语义：
//! - review.json 声明维度与权重（citation_quality/cross_validation/
//!   consistency/readability）与通过阈值；
//! - samples.json 顶层 facts = 评分交叉验证锚点：分支携带的事实命中数
//!   参与 cross_validation 维度打分（数据驱动，不写死打分逻辑）；
//! - 维度得分确定性由分支状态携带（state 内 `score:<维度名>`），
//!   缺省中性分——离线评测可完全复现。
//!
//! 本模块只做「配置解析 + 确定性打分」两件事，均无引擎交互：
//! 评估器装配（权重求值/轮次收敛）由装配侧按本模块产物接线。

use std::collections::BTreeMap;

use serde_json::Value as JsonValue;

use super::common::DomainError;

/// 缺省中性分（分支未携带维度得分时的占位；review.json neutral_score 同源）。
pub const NEUTRAL_SCORE: f64 = 0.5;

/// 总分达标线缺省值（review.json pass_threshold 缺失时回落；引擎默认同值）。
pub const DEFAULT_PASS_THRESHOLD: f64 = 0.75;

/// 一个打分维度（配置数据）。
#[derive(Debug, Clone, PartialEq)]
pub struct ScoreDimension {
    pub name: String,
    pub weight: f64,
}

/// 打分配置（维度 + 权重 + 总分达标线，可序列化数据形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct ScoringConfig {
    pub dimensions: Vec<ScoreDimension>,
    pub overall_threshold: f64,
}

impl ScoringConfig {
    /// 配置覆盖的全部维度名（打分产出必须覆盖全部维度）。
    pub fn dimension_names(&self) -> Vec<&str> {
        self.dimensions.iter().map(|d| d.name.as_str()).collect()
    }
}

/// review.json → 打分配置（维度/权重/通过阈值）。
///
/// 维度缺 name 的条目跳过（声明即数据，坏条目不击穿装配）；
/// 权重缺省 1.0；pass_threshold 缺省回落引擎默认值。
pub fn build_review_scoring_config(review_data: &JsonValue) -> Result<ScoringConfig, DomainError> {
    let mut dimensions = Vec::new();
    if let Some(list) = review_data.get("dimensions").and_then(JsonValue::as_array) {
        for dim in list {
            let Some(name) = dim.get("name").and_then(JsonValue::as_str) else {
                continue;
            };
            let weight = dim.get("weight").and_then(JsonValue::as_f64).unwrap_or(1.0);
            dimensions.push(ScoreDimension {
                name: name.to_string(),
                weight,
            });
        }
    }
    if dimensions.is_empty() {
        return Err(DomainError::InvalidData(
            "review.json 打分配置缺 dimensions（维度清单为空）".into(),
        ));
    }
    let overall_threshold = review_data
        .get("pass_threshold")
        .and_then(JsonValue::as_f64)
        .unwrap_or(DEFAULT_PASS_THRESHOLD);
    Ok(ScoringConfig {
        dimensions,
        overall_threshold,
    })
}

/// 事实锚点维度打分器：分支状态驱动 + 交叉验证锚点。
///
/// 每个分支（SimulateSpec.state）可携带：
/// - `score:<维度名>`：该维度的确定性得分（0-1）；
/// - `facts_hit`：与基准事实重合的断言数——cross_validation
///   维度按命中率打分（未携带 = 中性分）。
/// 产出覆盖配置的全部维度；契约为同步调用（评估器不做 await）。
#[derive(Debug, Clone)]
pub struct FactDimensionScorer {
    facts: Vec<String>,
    config: ScoringConfig,
}

impl FactDimensionScorer {
    /// 构造打分器（facts = 基准事实断言清单，交叉验证锚点）。
    pub fn new(facts: Vec<String>, config: ScoringConfig) -> Self {
        Self { facts, config }
    }

    /// 按分支状态打分（overlay 为签名兼容位，本轮次不参与取值）。
    pub fn score(&self, state: &JsonValue, _overlay: &JsonValue) -> BTreeMap<String, f64> {
        let facts_len = self.facts.len().max(1) as f64;
        let mut scores = BTreeMap::new();
        for dim in &self.config.dimensions {
            let key = format!("score:{}", dim.name);
            let value = state
                .get(key.as_str())
                .and_then(JsonValue::as_f64)
                .unwrap_or(NEUTRAL_SCORE);
            scores.insert(dim.name.clone(), value);
        }
        if scores.contains_key("cross_validation") {
            if let Some(hit) = state.get("facts_hit").and_then(JsonValue::as_f64) {
                let ratio = (hit / facts_len).min(1.0);
                scores.insert("cross_validation".to_string(), ratio);
            }
        }
        scores
    }
}

/// facts 断言清单 → 事实锚点打分器（review.json 配置数据驱动）。
pub fn dimension_scorer_with_facts(facts: Vec<String>, config: ScoringConfig) -> FactDimensionScorer {
    FactDimensionScorer::new(facts, config)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    fn seed_file(name: &str) -> JsonValue {
        let path = repo_root().join("inkling").join("seed_data").join(name);
        let text = std::fs::read_to_string(path).expect("seed 文件读取失败");
        serde_json::from_str(&text).expect("seed 文件 JSON 非法")
    }

    fn review_data() -> JsonValue {
        seed_file("review.json")
    }

    fn sample_facts() -> Vec<String> {
        seed_file("samples.json")["facts"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f.get("statement").and_then(JsonValue::as_str))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn review_config_mirrors_seed_data() {
        let config = build_review_scoring_config(&review_data()).expect("配置解析失败");
        assert_eq!(config.dimensions.len(), 4);
        let weights: Vec<f64> = config.dimensions.iter().map(|d| d.weight).collect();
        assert_eq!(weights, vec![0.35, 0.25, 0.25, 0.15]);
        assert_eq!(config.overall_threshold, 0.75);
        let names = config.dimension_names();
        assert_eq!(
            names,
            vec!["citation_quality", "cross_validation", "consistency", "readability"]
        );
    }

    #[test]
    fn review_config_rejects_empty_dimensions() {
        let err = build_review_scoring_config(&serde_json::json!({ "pass_threshold": 0.75 }))
            .expect_err("空维度清单应报错");
        assert!(err.to_string().contains("dimensions"));
    }

    #[test]
    fn scorer_reads_state_scores_and_defaults_to_neutral() {
        let config = build_review_scoring_config(&review_data()).unwrap();
        let scorer = dimension_scorer_with_facts(sample_facts(), config);
        let state = serde_json::json!({
            "score:citation_quality": 0.9,
            // cross_validation/consistency/readability 未携带 → 中性分
        });
        let scores = scorer.score(&state, &serde_json::json!({}));
        assert_eq!(scores.get("citation_quality"), Some(&0.9));
        assert_eq!(scores.get("cross_validation"), Some(&NEUTRAL_SCORE));
        assert_eq!(scores.get("consistency"), Some(&NEUTRAL_SCORE));
        assert_eq!(scores.get("readability"), Some(&NEUTRAL_SCORE));
        assert_eq!(scores.len(), 4, "打分产出覆盖配置全部维度");
    }

    #[test]
    fn cross_validation_scored_by_facts_hit_ratio() {
        let config = build_review_scoring_config(&review_data()).unwrap();
        let facts = sample_facts();
        assert_eq!(facts.len(), 4, "samples.json 顶层 facts 为 4 条");
        let scorer = dimension_scorer_with_facts(facts, config);

        // 命中 2/4 → 0.5
        let state = serde_json::json!({ "facts_hit": 2 });
        let scores = scorer.score(&state, &serde_json::json!({}));
        assert_eq!(scores.get("cross_validation"), Some(&0.5));

        // 命中 4/4 → 1.0（上限）
        let state = serde_json::json!({ "facts_hit": 4 });
        let scores = scorer.score(&state, &serde_json::json!({}));
        assert_eq!(scores.get("cross_validation"), Some(&1.0));

        // 未携带 facts_hit → 中性分（交叉验证锚点缺席不惩罚）
        let scores = scorer.score(&serde_json::json!({}), &serde_json::json!({}));
        assert_eq!(scores.get("cross_validation"), Some(&NEUTRAL_SCORE));
    }

    #[test]
    fn cross_validation_ratio_capped_and_guards_empty_facts() {
        let config = build_review_scoring_config(&review_data()).unwrap();
        // 空 facts 清单 → 分母为 1（不除零）
        let scorer = dimension_scorer_with_facts(vec![], config);
        let scores = scorer.score(&serde_json::json!({ "facts_hit": 3 }), &serde_json::json!({}));
        assert_eq!(scores.get("cross_validation"), Some(&1.0));
    }

    #[test]
    fn scorer_is_deterministic_with_real_seed_facts() {
        let config = build_review_scoring_config(&review_data()).unwrap();
        let scorer = dimension_scorer_with_facts(sample_facts(), config);
        let state = serde_json::json!({
            "score:citation_quality": 0.8,
            "score:cross_validation": 0.6,
            "score:consistency": 0.7,
            "score:readability": 0.9,
            "facts_hit": 3,
        });
        let first = scorer.score(&state, &serde_json::json!({}));
        let second = scorer.score(&state, &serde_json::json!({}));
        assert_eq!(first, second, "同状态打分确定性可复现");
        // facts_hit 3/4 → cross_validation 0.75（状态携带值被锚点覆盖）
        assert_eq!(first.get("cross_validation"), Some(&0.75));
    }
}

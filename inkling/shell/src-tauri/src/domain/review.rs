//! review 域：评审-收敛管线（引擎 core.review 机制的产品化接线）。
//!
//! review.json（维度/阈值/轮次/Beam/中性分）数据驱动；评审器与再生成
//! 器为 LLM 实现（host 注入模型链），失败一律 fail-open 中性分——
//! 评审是 best-effort 增强，不阻断主流程（不达标交闸门/人工裁决）。
//!
//! 实现约定：
//! - [`LLMReviewer`]：逐候选评审（dimensions 权重注入提示），LLM 异常
//!   → 中性分（passed=False，不抛错）；
//! - [`LLMRegenerator`]：按评审反馈改进单个候选（失败返回原稿——不
//!   降级）；
//! - [`converge_candidates`]：评审 → 收敛决策 → 再生成循环
//!   （轮次上限硬护栏），历史可审计。
//!
//! 依赖纪律：本模块不直接调用其它域模块；LLM 调用经
//! [`ReviewLlm`] 钩子注入（boot.rs 把模型链接进钩子——域侧零模型耦合）。

use std::collections::HashMap;
use std::pin::Pin;

use serde_json::{json, Value as JsonValue};

use super::common::DomainError;

// ── 常量（与引擎 review 模块默认对齐）──

/// 自动再生成轮次上限（超限呈交现状 + 评审意见，卡回路人类裁决兜底）。
pub const DEFAULT_MAX_ROUNDS: usize = 2;
/// 评审通过阈值（0-1 质量分；评审器自身也用它判定 passed）。
pub const DEFAULT_PASS_THRESHOLD: f64 = 0.75;
/// 未收敛时继续再生成的候选数（Beam 宽度：取前 K 个最优候选迭代）。
pub const DEFAULT_BEAM_WIDTH: usize = 1;
/// 评审未产出结论时的中性分（fail-open：保守不通过，交卡回路人类裁决）。
pub const NEUTRAL_SCORE: f64 = 0.5;

// ── LLM 钩子（模型链注入点；域侧零模型耦合）──

/// 评审/再生成的 LLM 调用钩子（prompt 进、回复文本出；异常 = 中性降级）。
pub trait ReviewLlm: Send + Sync {
    fn invoke(
        &self,
        prompt: &str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>>;
}

// ── 评审数据形态 ──

/// 单个段落的质量评分（段落级混合的输入）。
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphScore {
    pub candidate_index: usize,
    pub paragraph_index: usize,
    pub score: f64,
    pub reason: String,
}

/// 单个候选的一次评审结果。
#[derive(Debug, Clone, PartialEq)]
pub struct CandidateReview {
    pub candidate_index: usize,
    pub score: f64,
    pub passed: bool,
    pub feedback: String,
    pub paragraphs: Vec<ParagraphScore>,
    pub uncertain_claims: Vec<String>,
}

impl CandidateReview {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "candidate_index": self.candidate_index,
            "score": self.score,
            "passed": self.passed,
            "feedback": self.feedback,
            "paragraphs": self.paragraphs.iter().map(|p| json!({
                "candidate_index": p.candidate_index,
                "paragraph_index": p.paragraph_index,
                "score": p.score,
                "reason": p.reason,
            })).collect::<Vec<_>>(),
            "uncertain_claims": self.uncertain_claims,
        })
    }
}

/// 收敛策略的一轮决策结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ConvergenceDecision {
    pub converged: bool,
    pub accepted_indices: Vec<usize>,
    pub regenerate_indices: Vec<usize>,
    pub notes: Vec<String>,
}

/// 一轮评审-再生成的完整留痕（循环历史可审计）。
#[derive(Debug, Clone, PartialEq)]
pub struct ConvergenceRound {
    pub round_no: usize,
    pub reviews: Vec<CandidateReview>,
    pub decision: ConvergenceDecision,
    pub regenerated: Vec<String>,
}

/// 评审-收敛循环的最终结果。
#[derive(Debug, Clone, PartialEq)]
pub struct ConvergenceResult {
    pub candidates: Vec<String>,
    pub reviews: Vec<CandidateReview>,
    pub converged: bool,
    pub rounds: usize,
    pub notes: Vec<String>,
    pub history: Vec<ConvergenceRound>,
}

impl ConvergenceResult {
    /// 当前候选集中得分最高者下标（reviews 空时取 0）。
    pub fn best_index(&self) -> usize {
        let mut best = 0usize;
        let mut best_score = f64::MIN;
        for review in &self.reviews {
            if review.score > best_score {
                best_score = review.score;
                best = review.candidate_index;
            }
        }
        best
    }
}

// ── 收敛策略（轮次上限硬护栏）──

/// 默认收敛策略：达阈值即收敛，否则 Beam 再生成，直到轮次上限。
///
/// 规则：1. 存在 passed 且 score ≥ threshold 的候选 → 收敛（取最高分）；
/// 2. 未收敛但已到轮次上限 → 停止（converged=False，呈交现状）；
/// 3. 否则取分数前 K（Beam 宽度）个候选继续再生成。
pub struct MaxRoundsConvergencePolicy {
    pub threshold: f64,
    pub beam: usize,
    pub max_rounds: usize,
    rounds_used: usize,
}

impl MaxRoundsConvergencePolicy {
    pub fn new(threshold: f64, beam: usize, max_rounds: usize) -> Result<Self, DomainError> {
        if !(0.0..=1.0).contains(&threshold) {
            return Err(DomainError::InvalidData(format!(
                "评审阈值必须在 [0, 1] 内: {threshold}"
            )));
        }
        if beam < 1 {
            return Err(DomainError::InvalidData(format!("Beam 宽度必须为正: {beam}")));
        }
        Ok(Self {
            threshold,
            beam,
            max_rounds,
            rounds_used: 0,
        })
    }

    /// 有效轮次 = 调用方轮次与内部计数的较大者（内部计数单调自增）。
    fn effective_round(&mut self, round_no: usize) -> usize {
        self.rounds_used = self.rounds_used.max(round_no);
        self.rounds_used
    }

    pub fn decide(
        &mut self,
        reviews: &[CandidateReview],
        round_no: usize,
    ) -> ConvergenceDecision {
        let round_no = self.effective_round(round_no);
        if reviews.is_empty() {
            return ConvergenceDecision {
                converged: false,
                accepted_indices: Vec::new(),
                regenerate_indices: Vec::new(),
                notes: vec!["无候选可评审".to_string()],
            };
        }
        // threshold 是策略层二次门槛：评审器按自身阈值预计算 passed，
        // 策略 threshold 与之独立——宿主收紧 threshold 须真实生效
        let passed: Vec<&CandidateReview> = reviews
            .iter()
            .filter(|r| r.passed && r.score >= self.threshold)
            .collect();
        if !passed.is_empty() {
            let best = passed
                .iter()
                .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap();
            return ConvergenceDecision {
                converged: true,
                accepted_indices: vec![best.candidate_index],
                regenerate_indices: Vec::new(),
                notes: vec![format!(
                    "候选[{}] 达标（{:.2}），收敛",
                    best.candidate_index, best.score
                )],
            };
        }
        if round_no >= self.max_rounds {
            let best = reviews
                .iter()
                .max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal))
                .unwrap();
            return ConvergenceDecision {
                converged: false,
                accepted_indices: Vec::new(),
                regenerate_indices: Vec::new(),
                notes: vec![format!(
                    "达轮次上限（{}/{}），呈交现状，最优候选[{}] 得分 {:.2}",
                    round_no, self.max_rounds, best.candidate_index, best.score
                )],
            };
        }
        let mut ranked: Vec<&CandidateReview> = reviews.iter().collect();
        ranked.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        let picks: Vec<usize> = ranked
            .iter()
            .take(self.beam)
            .map(|r| r.candidate_index)
            .collect();
        ConvergenceDecision {
            converged: false,
            accepted_indices: Vec::new(),
            regenerate_indices: picks.clone(),
            notes: vec![format!("第 {} 轮未达标，再生成候选 {picks:?}", round_no + 1)],
        }
    }
}

// ── LLM 评审器 / 再生成器 ──

/// LLM 评审器（逐候选评审；评审失败 → 中性分 passed=False，不抛错）。
pub struct LLMReviewer<'a> {
    llm: &'a dyn ReviewLlm,
    dimensions: Vec<JsonValue>,
    pass_threshold: f64,
    neutral: f64,
}

impl<'a> LLMReviewer<'a> {
    pub fn new(
        llm: &'a dyn ReviewLlm,
        dimensions: Vec<JsonValue>,
        pass_threshold: f64,
        neutral: f64,
    ) -> Self {
        Self {
            llm,
            dimensions,
            pass_threshold,
            neutral,
        }
    }

    pub async fn review(
        &self,
        candidates: &[String],
    ) -> Vec<CandidateReview> {
        let mut results: Vec<CandidateReview> = Vec::with_capacity(candidates.len());
        for (index, content) in candidates.iter().enumerate() {
            let prompt = review_prompt(&self.dimensions, content);
            let (score, paragraphs, uncertain, feedback) = match self.llm.invoke(&prompt).await {
                Ok(reply) => match parse_review_json(&reply, index, self.neutral) {
                    Ok((score, paragraphs, uncertain, feedback)) => (score, paragraphs, uncertain, feedback),
                    Err(_) => (self.neutral, Vec::new(), Vec::new(), String::new()),
                },
                Err(_) => (self.neutral, Vec::new(), Vec::new(), String::new()),
            };
            let clamped = score.clamp(0.0, 1.0);
            results.push(CandidateReview {
                candidate_index: index,
                score: clamped,
                passed: clamped >= self.pass_threshold,
                feedback,
                paragraphs,
                uncertain_claims: uncertain,
            });
        }
        results
    }
}

/// LLM 再生成器（按评审反馈改进；失败返回原稿——不降级）。
pub struct LLMRegenerator<'a> {
    llm: &'a dyn ReviewLlm,
}

impl<'a> LLMRegenerator<'a> {
    pub fn new(llm: &'a dyn ReviewLlm) -> Self {
        Self { llm }
    }

    pub async fn regenerate(&self, candidate: &str, feedback: &str) -> String {
        let prompt = regenerate_prompt(candidate, feedback);
        match self.llm.invoke(&prompt).await {
            Ok(reply) => {
                let text = reply.trim();
                if text.is_empty() {
                    candidate.to_string()
                } else {
                    text.to_string()
                }
            }
            Err(_) => candidate.to_string(),
        }
    }
}

// ── 提示与 JSON 容错 ──

/// 评审提示（维度/要求注入后拼到候选文稿后）。
const REVIEW_PROMPT_TEMPLATE: &str = concat!(
    "你是评审器。按下列维度给候选文稿打质量分（每维 0-1，总分 0-1 加权）：\n",
    "{dimensions}\n",
    "要求：输出严格 JSON，格式：\n",
    "{{\"score\": <0-1 数值>, \"reason\": \"<一句话理由>\", ",
    "\"paragraphs\": [{{\"index\": 0, \"score\": 0.8, \"reason\": \"...\"}}], ",
    "\"uncertain_claims\": [\"<存疑声明>\", ...]}}\n",
    "候选文稿：\n{content}\n"
);

/// 再生成提示（原候选 + 反馈 → 改进稿）。
const REGENERATE_PROMPT_TEMPLATE: &str = concat!(
    "根据评审反馈改进候选文稿。只输出改进后的文稿本体：\n\n",
    "原稿：\n{content}\n\n评审反馈：\n{feedback}\n"
);

/// 评审 JSON 围栏（LLM 可能包夹 ```json 围栏）。
const JSON_FENCES: [&str; 2] = ["```json", "```"];

/// 评审提示构造（dimensions 渲染进提示行）。
pub fn review_prompt(dimensions: &[JsonValue], content: &str) -> String {
    REVIEW_PROMPT_TEMPLATE
        .replace("{dimensions}", &dimension_lines(dimensions))
        .replace("{content}", content)
}

/// 再生成提示构造。
pub fn regenerate_prompt(content: &str, feedback: &str) -> String {
    REGENERATE_PROMPT_TEMPLATE
        .replace("{content}", content)
        .replace("{feedback}", feedback)
}

/// 维度清单渲染（name/weight/note → 提示行）。
pub fn dimension_lines(dimensions: &[JsonValue]) -> String {
    if dimensions.is_empty() {
        return "- 统一质量（0-1）：准确性、可读性、可复用性".to_string();
    }
    dimensions
        .iter()
        .filter(|d| d.is_object())
        .map(|d| {
            let name = d.get("name").and_then(JsonValue::as_str).unwrap_or("dim");
            let weight = d.get("weight").and_then(JsonValue::as_f64).unwrap_or(1.0);
            let note = d.get("note").and_then(JsonValue::as_str).unwrap_or("");
            format!("- {name}（权重 {weight:.2}）：{note}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从 LLM 输出提取评审 JSON（剥围栏；失败返回可读错误）。
pub fn extract_json(text: &str) -> Result<JsonValue, String> {
    let mut cleaned = text.trim().to_string();
    for fence in JSON_FENCES {
        cleaned = cleaned.replace(fence, "");
    }
    let start = cleaned.find('{');
    let end = cleaned.rfind('}');
    let (Some(start), Some(end)) = (start, end) else {
        return Err("评审输出无可解析 JSON".to_string());
    };
    if end <= start {
        return Err("评审输出无可解析 JSON".to_string());
    }
    serde_json::from_str(&cleaned[start..=end]).map_err(|err| format!("评审 JSON 解析失败: {err}"))
}

/// 评审 JSON 解析（score/paragraphs/uncertain_claims 字段；容错形态）。
pub fn parse_review_json(
    text: &str,
    candidate_index: usize,
    neutral: f64,
) -> Result<(f64, Vec<ParagraphScore>, Vec<String>, String), String> {
    let obj = extract_json(text)?;
    let Some(map) = obj.as_object() else {
        return Err("评审 JSON 须为对象".to_string());
    };
    let score = map
        .get("score")
        .and_then(JsonValue::as_f64)
        .unwrap_or(neutral);
    let mut paragraphs: Vec<ParagraphScore> = Vec::new();
    if let Some(list) = map.get("paragraphs").and_then(JsonValue::as_array) {
        for item in list {
            let Some(pmap) = item.as_object() else { continue };
            paragraphs.push(ParagraphScore {
                candidate_index,
                paragraph_index: pmap
                    .get("index")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0) as usize,
                score: pmap.get("score").and_then(JsonValue::as_f64).unwrap_or(0.0),
                reason: pmap
                    .get("reason")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    let uncertain: Vec<String> = map
        .get("uncertain_claims")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(JsonValue::as_str)
                .filter(|c| !c.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let feedback = map
        .get("reason")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    Ok((score, paragraphs, uncertain, feedback))
}

// ── 评审-收敛循环 ──

/// 评审 → 收敛决策 → 再生成循环（轮次上限硬护栏；历史可审计）。
///
/// review.json（pass_threshold/max_rounds/beam_width/neutral_score/
/// dimensions）数据驱动；`llm` 缺省（None）= 无评审器，返回中性分
/// 一轮结果 fail-open（评审是 best-effort 增强，不阻断主流程）。
pub async fn converge_candidates(
    llm: Option<&dyn ReviewLlm>,
    review_data: &JsonValue,
    candidates: &[String],
) -> ConvergenceResult {
    let pass_threshold = review_data
        .get("pass_threshold")
        .and_then(JsonValue::as_f64)
        .unwrap_or(DEFAULT_PASS_THRESHOLD);
    let max_rounds = review_data
        .get("max_rounds")
        .and_then(JsonValue::as_u64)
        .unwrap_or(DEFAULT_MAX_ROUNDS as u64) as usize;
    let beam = review_data
        .get("beam_width")
        .and_then(JsonValue::as_u64)
        .unwrap_or(DEFAULT_BEAM_WIDTH as u64) as usize;
    let neutral = review_data
        .get("neutral_score")
        .and_then(JsonValue::as_f64)
        .unwrap_or(NEUTRAL_SCORE);
    let dimensions: Vec<JsonValue> = review_data
        .get("dimensions")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    converge_with(
        llm,
        candidates,
        &dimensions,
        pass_threshold,
        max_rounds,
        beam,
        neutral,
    )
    .await
}

/// 循环实体（参数展开形态；单测/宿主可直控参数）。
pub async fn converge_with(
    llm: Option<&dyn ReviewLlm>,
    candidates: &[String],
    dimensions: &[JsonValue],
    pass_threshold: f64,
    max_rounds: usize,
    beam: usize,
    neutral: f64,
) -> ConvergenceResult {
    let mut policy = match MaxRoundsConvergencePolicy::new(pass_threshold, beam, max_rounds) {
        Ok(policy) => policy,
        Err(_) => {
            let reviews = neutral_reviews(candidates, neutral);
            return ConvergenceResult {
                candidates: candidates.to_vec(),
                reviews,
                converged: false,
                rounds: 0,
                notes: vec!["评审配置非法（阈值/Beam 边界）".to_string()],
                history: Vec::new(),
            };
        }
    };
    let mut current: Vec<String> = candidates.to_vec();
    let mut history: Vec<ConvergenceRound> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut rounds = 0usize;
    loop {
        let reviews = match llm {
            Some(llm) => {
                LLMReviewer::new(llm, dimensions.to_vec(), pass_threshold, neutral)
                    .review(&current)
                    .await
            }
            None => neutral_reviews(&current, neutral),
        };
        let decision = policy.decide(&reviews, rounds);
        if decision.converged {
            notes.extend(decision.notes.clone());
            history.push(ConvergenceRound {
                round_no: rounds,
                reviews,
                decision,
                regenerated: Vec::new(),
            });
            return ConvergenceResult {
                candidates: current,
                reviews: history
                    .last()
                    .map(|r| r.reviews.clone())
                    .unwrap_or_default(),
                converged: true,
                rounds,
                notes,
                history,
            };
        }
        let indices = decision.regenerate_indices.clone();
        if indices.is_empty() || rounds >= max_rounds {
            notes.extend(decision.notes.clone());
            history.push(ConvergenceRound {
                round_no: rounds,
                reviews,
                decision,
                regenerated: Vec::new(),
            });
            return ConvergenceResult {
                candidates: current,
                reviews: history
                    .last()
                    .map(|r| r.reviews.clone())
                    .unwrap_or_default(),
                converged: false,
                rounds,
                notes,
                history,
            };
        }
        let mut regenerated: Vec<String> = Vec::with_capacity(indices.len());
        if let Some(llm) = llm {
            let regenerator = LLMRegenerator::new(llm);
            for index in &indices {
                let candidate = current.get(*index).cloned().unwrap_or_default();
                let feedback = reviews
                    .iter()
                    .find(|r| r.candidate_index == *index)
                    .map(|r| r.feedback.clone())
                    .unwrap_or_default();
                regenerated.push(regenerator.regenerate(&candidate, &feedback).await);
            }
            for (index, text) in indices.iter().zip(regenerated.iter()) {
                if *index < current.len() {
                    current[*index] = text.clone();
                }
            }
        }
        history.push(ConvergenceRound {
            round_no: rounds,
            reviews,
            decision,
            regenerated,
        });
        rounds += 1;
    }
}

fn neutral_reviews(candidates: &[String], neutral: f64) -> Vec<CandidateReview> {
    candidates
        .iter()
        .enumerate()
        .map(|(index, _)| CandidateReview {
            candidate_index: index,
            score: neutral,
            passed: false,
            feedback: String::new(),
            paragraphs: Vec::new(),
            uncertain_claims: Vec::new(),
        })
        .collect()
}

// ── 管线构建（模型缺省 = None：按无评审处理）──

/// 评审管线构建：模型缺省 → None（调用方按无评审处理，fail-open）。
pub fn build_review_pipeline<'a>(
    llm: Option<&'a dyn ReviewLlm>,
    review_data: &'a JsonValue,
) -> Option<ReviewPipeline<'a>> {
    llm.map(|llm| ReviewPipeline {
        llm,
        review_data: review_data.clone(),
    })
}

/// 评审管线（绑定模型链与 review.json 数据；宿主直接调用）。
pub struct ReviewPipeline<'a> {
    llm: &'a dyn ReviewLlm,
    review_data: JsonValue,
}

impl ReviewPipeline<'_> {
    pub async fn run(&self, candidates: &[String]) -> ConvergenceResult {
        converge_candidates(Some(self.llm), &self.review_data, candidates).await
    }
}

/// 评审配置打包：review.json → 参数字典（装配侧观测形态）。
pub fn review_config(review_data: &JsonValue) -> HashMap<String, JsonValue> {
    HashMap::from([
        ("pass_threshold".to_string(), json!(review_data.get("pass_threshold").and_then(JsonValue::as_f64).unwrap_or(DEFAULT_PASS_THRESHOLD))),
        ("max_rounds".to_string(), json!(review_data.get("max_rounds").and_then(JsonValue::as_u64).unwrap_or(DEFAULT_MAX_ROUNDS as u64))),
        ("beam_width".to_string(), json!(review_data.get("beam_width").and_then(JsonValue::as_u64).unwrap_or(DEFAULT_BEAM_WIDTH as u64))),
        ("neutral_score".to_string(), json!(review_data.get("neutral_score").and_then(JsonValue::as_f64).unwrap_or(NEUTRAL_SCORE))),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_data_extra() -> JsonValue {
        json!({
            "dimensions": [{"name": "citation_quality", "weight": 0.35, "note": "引用质量"}],
            "pass_threshold": 0.75,
            "max_rounds": 2,
            "beam_width": 1,
            "neutral_score": 0.5,
            "web_verify": {"enabled": true, "hook": "web_verifier"},
        })
    }

    const JSON_PASS: &str = r#"{"score": 0.95, "reason": "达标", "paragraphs": [], "uncertain_claims": []}"#;
    const JSON_FAIL: &str = r#"{"score": 0.4, "reason": "不达标", "paragraphs": [], "uncertain_claims": ["存疑声明"]}"#;

    struct ScriptedLlm {
        script: Vec<(String, String)>,
        calls: std::sync::atomic::AtomicUsize,
        fail: bool,
    }

    impl ScriptedLlm {
        fn new(script: Vec<(&str, &str)>) -> Self {
            Self {
                script: script
                    .into_iter()
                    .map(|(needle, reply)| (needle.to_string(), reply.to_string()))
                    .collect(),
                calls: std::sync::atomic::AtomicUsize::new(0),
                fail: false,
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl ReviewLlm for ScriptedLlm {
        fn invoke(
            &self,
            prompt: &str,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + '_>> {
            if self.fail {
                return Box::pin(async move { Err("模型接口故障".to_string()) });
            }
            let script = self.script.clone();
            let prompt = prompt.to_string();
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move {
                for (needle, reply) in script {
                    if prompt.contains(&needle) {
                        return Ok(reply);
                    }
                }
                Err("未命中的模型调用".to_string())
            })
        }
    }

    #[test]
    fn extract_json_strips_fences_and_tolerates_wrapping() {
        let fenced = format!("```json\n{JSON_PASS}\n```");
        let parsed = extract_json(&fenced).unwrap();
        assert_eq!(parsed["score"], 0.95);
        // 前后噪音也可提取（find/rfind 语义）
        let noisy = format!("好的，评审如下：{JSON_PASS} 欢迎继续。");
        assert_eq!(extract_json(&noisy).unwrap()["reason"], "达标");
        // 无 JSON = 显式失败（不静默回中性之外）
        assert!(extract_json("没有 JSON?").is_err());
    }

    #[test]
    fn parse_review_json_maps_fields_and_clamps() {
        let (score, paragraphs, uncertain, feedback) = parse_review_json(
            r#"{"score": 1.7, "reason": "超分", "paragraphs": [{"index": 1, "score": 0.8, "reason": "好"}], "uncertain_claims": ["A", "", "B"]}"#,
            2,
            0.5,
        )
        .unwrap();
        assert_eq!(score, 1.7);
        assert_eq!(paragraphs.len(), 1);
        assert_eq!(paragraphs[0].candidate_index, 2);
        assert_eq!(paragraphs[0].paragraph_index, 1);
        assert_eq!(uncertain, vec!["A".to_string(), "B".to_string()], "空声明剔除");
        assert_eq!(feedback, "超分");
        // 缺 score = 中性分水位；非对象 = 失败
        let (score, ..) = parse_review_json(r#"{"reason": "无分"}"#, 0, 0.5).unwrap();
        assert_eq!(score, 0.5);
        assert!(parse_review_json(r#"[1, 2]"#, 0, 0.5).is_err());
    }

    #[test]
    fn dimension_lines_renders_weights_or_fallback() {
        let lines = dimension_lines(&[json!({"name": "citation_quality", "weight": 0.35, "note": "引用质量"})]);
        assert!(lines.contains("citation_quality（权重 0.35）：引用质量"));
        let fallback = dimension_lines(&[]);
        assert!(fallback.contains("统一质量"));
        // 非对象维度跳过
        let mixed = dimension_lines(&[json!({"name": "a", "weight": 1.0}), json!("bad")]);
        assert_eq!(mixed.matches("bad").count(), 0);
    }

    #[test]
    fn prompts_contain_dimensions_and_feedback() {
        let prompt = review_prompt(&[json!({"name": "d1", "weight": 0.5})], "候选正文");
        assert!(prompt.contains("d1（权重 0.50）"));
        assert!(prompt.contains("候选正文"));
        assert!(prompt.contains("输出严格 JSON"));
        let regenerate = regenerate_prompt("原稿", "反馈内容");
        assert!(regenerate.contains("原稿"));
        assert!(regenerate.contains("反馈内容"));
    }

    #[tokio::test]
    async fn policy_decides_converge_on_first_round() {
        let mut policy = MaxRoundsConvergencePolicy::new(0.75, 1, 2).unwrap();
        let reviews = vec![CandidateReview {
            candidate_index: 0,
            score: 0.95,
            passed: true,
            feedback: "达标".to_string(),
            paragraphs: vec![],
            uncertain_claims: vec![],
        }];
        let decision = policy.decide(&reviews, 0);
        assert!(decision.converged);
        assert_eq!(decision.accepted_indices, vec![0]);
        // 空评审集 = 收敛失败（绝不把空集当已收敛）
        let empty = policy.decide(&[], 0);
        assert!(!empty.converged);
        assert!(empty.notes.iter().any(|n| n.contains("无候选")));
        // 阈值是二次门槛：passed 但 score 低于宿主阈值不收敛
        let low_score = CandidateReview {
            candidate_index: 0,
            score: 0.8,
            passed: true,
            feedback: "达标".to_string(),
            paragraphs: vec![],
            uncertain_claims: vec![],
        };
        let mut strict = MaxRoundsConvergencePolicy::new(0.9, 1, 2).unwrap();
        let soft = strict.decide(&[low_score], 0);
        assert!(!soft.converged, "宿主收紧阈值须真实生效");
        // 参数边界校验
        assert!(MaxRoundsConvergencePolicy::new(1.5, 1, 2).is_err());
        assert!(MaxRoundsConvergencePolicy::new(0.75, 0, 2).is_err());
    }

    #[tokio::test]
    async fn converge_first_round_accepted() {
        let llm = ScriptedLlm::new(vec![("你是评审器", JSON_PASS)]);
        let result = converge_candidates(Some(&llm), &review_data_extra(), &["候选文稿".to_string()]).await;
        assert!(result.converged);
        assert_eq!(result.rounds, 0);
        assert!(result.reviews[0].passed);
        assert_eq!(result.best_index(), 0);
        assert_eq!(result.candidates[0], "候选文稿");
        assert_eq!(llm.call_count(), 1, "prompt 注入（dimensions 渲染进消息）");
    }

    #[tokio::test]
    async fn converge_hard_cap_submits_current_state() {
        let llm = ScriptedLlm::new(vec![("你是评审器", JSON_FAIL)]);
        let result = converge_candidates(Some(&llm), &review_data_extra(), &["候选文稿".to_string()]).await;
        assert!(!result.converged);
        assert_eq!(result.rounds, 2, "两轮再生成后达轮次上限");
        assert!(result.notes.iter().any(|n| n.contains("轮次上限")));
        assert_eq!(result.reviews.last().unwrap().score, 0.4);
        // 历史可审计：3 轮评审记录（评审 + 2 次再生成）
        assert_eq!(result.history.len(), 3);
    }

    #[tokio::test]
    async fn converge_fail_open_on_bad_json_and_llm_error() {
        // 坏 JSON：中性分 fail-open（不抛错，passed=False）
        let llm = ScriptedLlm::new(vec![("你是评审器", "没有 JSON?")]);
        let result = converge_candidates(Some(&llm), &review_data_extra(), &["候选文稿".to_string()]).await;
        assert!(!result.converged);
        assert_eq!(result.reviews.last().unwrap().score, NEUTRAL_SCORE);
        assert!(!result.reviews.last().unwrap().passed);
        // LLM 调用异常：同走中性分
        let broken = ScriptedLlm {
            script: Vec::new(),
            calls: std::sync::atomic::AtomicUsize::new(0),
            fail: true,
        };
        let failed = converge_candidates(Some(&broken), &review_data_extra(), &["x".to_string()]).await;
        assert_eq!(failed.reviews[0].score, NEUTRAL_SCORE);
        assert!(!failed.reviews[0].passed);
        // llm 缺省 = 无评审器：中性分一轮结果
        let none = converge_candidates(None, &review_data_extra(), &["x".to_string()]).await;
        assert!(!none.converged);
        assert_eq!(none.reviews[0].score, NEUTRAL_SCORE);
    }

    #[tokio::test]
    async fn regenerator_improves_and_falls_back_to_original() {
        let llm = ScriptedLlm::new(vec![("根据评审反馈", "改进后的文稿")]);
        let regenerator = LLMRegenerator::new(&llm);
        let improved = regenerator.regenerate("原稿", "反馈").await;
        assert_eq!(improved, "改进后的文稿");
        // 空回复 = 回落原稿（不降级为空串）
        let empty = ScriptedLlm::new(vec![("根据评审反馈", "   ")]);
        let regenerator = LLMRegenerator::new(&empty);
        assert_eq!(regenerator.regenerate("原稿", "反馈").await, "原稿");
        // 异常 = 回落原稿
        let broken = ScriptedLlm { script: vec![], calls: std::sync::atomic::AtomicUsize::new(0), fail: true };
        let regenerator = LLMRegenerator::new(&broken);
        assert_eq!(regenerator.regenerate("原稿", "反馈").await, "原稿");
    }

    #[tokio::test]
    async fn build_pipeline_none_when_model_missing() {
        let llm = ScriptedLlm::new(vec![("你是评审器", JSON_PASS)]);
        let data = review_data_extra();
        let pipeline = build_review_pipeline(Some(&llm), &data).expect("有模型 = 管线就绪");
        let result = pipeline.run(&["候选文稿".to_string()]).await;
        assert!(result.converged);
        assert!(result.reviews[0].passed);
        // 无模型 = None（调用方按无评审处理，fail-open）
        assert!(build_review_pipeline(None, &review_data_extra()).is_none());
    }

    #[test]
    fn review_config_reads_seed_thresholds() {
        let config = review_config(&json!({
            "pass_threshold": 0.75, "max_rounds": 2, "beam_width": 1, "neutral_score": 0.5,
        }));
        assert_eq!(config["pass_threshold"], json!(0.75));
        assert_eq!(config["max_rounds"], json!(2));
        // 缺省值回退
        let defaults = review_config(&json!({}));
        assert_eq!(defaults["pass_threshold"], json!(DEFAULT_PASS_THRESHOLD));
        assert_eq!(defaults["max_rounds"], json!(DEFAULT_MAX_ROUNDS));
        assert_eq!(defaults["neutral_score"], json!(NEUTRAL_SCORE));
    }

    #[test]
    fn converge_invalid_config_falls_back_cold() {
        // 阈值越界 = 配置非法（fail-open 冷结果：不崩溃）
        let bad = json!({"pass_threshold": 2.0, "max_rounds": 2, "beam_width": 1, "neutral_score": 0.5});
        let llm = ScriptedLlm::new(vec![("你是评审器", JSON_PASS)]);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(converge_candidates(Some(&llm), &bad, &["x".to_string()]));
        assert!(!result.converged);
        assert!(result.notes.iter().any(|n| n.contains("配置非法")));
    }
}

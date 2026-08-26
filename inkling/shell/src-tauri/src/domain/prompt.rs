//! prompt 域：boot_prompt 行为准则层注入 + 策略层/推演档位提示词变体 +
//! 交错推理引导语 + 工具名映射表中间态。
//!
//! 行为准则层注入形态：把 boot_prompt.json 拆成 soul/行为准则/产品事实
//! 三段结构，并附带「目标设定」展开块——目标设定体积 ≥ 10 倍于工具
//! 清单体积（工具清单只占注入的很小一部分，行为准则层是对话基调的主体）。
//! 展开块由「场景 × 准则句式」矩阵确定性生成（无重复行、有界、可测）。
//!
//! 变体提示词：策略层打标（确定性任务→spawn、不确定性→simulate）、
//! 推演档位（关/轻探测/全量）与交错推理引导语一行（引导语不引用任何
//! 工具标识符——推理过程的书写语言与工具无关）。
//!
//! 工具名映射表中间态：中文名（描述首句的行为意图标签）↔ 工具名的
//! 对照清单，作为策略层上下文的素材；标签抽取规则与 tools 域的兜底
//! 首层同源（描述首句），本模块独立实现不跨域调用。

use std::path::Path;

use serde_json::Value as JsonValue;

use super::common::DomainError;

/// boot 提示词数据文件名（seed_data 清单之一）。
pub const BOOT_PROMPT_FILE: &str = "boot_prompt.json";

/// 目标设定体积下限倍数（相对工具清单体积）。
pub const BEHAVIOR_GUIDE_MIN_RATIO: usize = 10;

/// 优先档位：描述首句的行为意图前置词（抽取后剥离）。
const DESCRIPTION_INTENT_PREFIX: &str = "行为意图：";

/// 策略层打标准则（确定性任务 → spawn 标注）。
pub const STRATEGY_VARIANT_DETERMINISTIC: &str = "打标分类准则：任务走法确定（如规范要求的固定步骤）时，把子树标注为 spawn 分组并行展开，不要逐节点模拟；确定性任务不设 simulate 探测档。";

/// 策略层打标准则（不确定性任务 → simulate）。
pub const STRATEGY_VARIANT_UNCERTAIN: &str = "打标分类准则：任务走法不确定（取舍/风险/未知分支）时，保留 simulate 探测档——先模拟出候选树与得失，再经决策点收敛，不得跳过探测直接定结论。";

/// 推演档位 = 关（直接按计划执行，不展开探测）。
pub const TIER_PROMPT_OFF: &str = "推演档位：关——直接按计划执行，不展开探测；受控计划即唯一路径。";

/// 推演档位 = 轻探测（关键决策点最小成本探测）。
pub const TIER_PROMPT_LITE: &str = "推演档位：轻探测——只在决策点做最小成本探测（每个决策点至多一条探测分支，探测深度=1），其余按计划直行。";

/// 推演档位 = 全量（spawn 分组先 simulate 后决策）。
pub const TIER_PROMPT_FULL: &str = "推演档位：全量——全部 spawn 分组先 simulate（候选树展开 → 模拟决策 → 收敛），再落计划执行；模拟结果随计划留痕。";

/// 交错推理引导语（一行；不引用工具标识符）。
pub const INTERLEAVED_REASONING_LINE: &str = "推理过程中，请先在心中把前提假设与结论链走一遍，再用自然语言写下依据";

/// boot_prompt 数据形态（seed_data/boot_prompt.json）。
#[derive(Debug, Clone, PartialEq)]
pub struct BootPromptData {
    pub name: String,
    pub version: u32,
    pub prompt: String,
}

/// 读取 boot_prompt.json（seed_root = seed_data 所在目录，装配时注入）。
pub fn load_boot_prompt(seed_root: &Path) -> Result<BootPromptData, DomainError> {
    let path = seed_root.join(BOOT_PROMPT_FILE);
    let text = std::fs::read_to_string(&path).map_err(|err| {
        DomainError::Storage(format!("boot_prompt 读取失败 {}: {err}", path.display()))
    })?;
    let value: JsonValue = serde_json::from_str(&text)
        .map_err(|err| DomainError::InvalidData(format!("boot_prompt JSON 非法: {err}")))?;
    let prompt = value
        .get("prompt")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| DomainError::InvalidData("boot_prompt 缺 prompt 字段".to_string()))?;
    Ok(BootPromptData {
        name: value
            .get("name")
            .and_then(JsonValue::as_str)
            .unwrap_or("inkling.boot_prompt")
            .to_string(),
        version: value.get("version").and_then(JsonValue::as_u64).unwrap_or(1) as u32,
        prompt: prompt.to_string(),
    })
}

/// 行为准则层（三段结构：身份与立场 / 行为准则 / 产品事实）。
#[derive(Debug, Clone, PartialEq)]
pub struct BehaviorLayers {
    pub soul: String,
    pub principles: String,
    pub product_facts: String,
}

/// boot_prompt 文本 → 三段结构（按句号切分；首句 = 身份与立场，
/// 末句 = 产品事实，中间 = 行为准则）。
pub fn behavior_layers(prompt: &str) -> BehaviorLayers {
    let sentences: Vec<String> = prompt
        .split('。')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            if s.ends_with('。') {
                s.to_string()
            } else {
                format!("{s}。")
            }
        })
        .collect();
    if sentences.is_empty() {
        return BehaviorLayers {
            soul: String::new(),
            principles: prompt.to_string(),
            product_facts: String::new(),
        };
    }
    if sentences.len() == 1 {
        return BehaviorLayers {
            soul: sentences[0].clone(),
            principles: String::new(),
            product_facts: String::new(),
        };
    }
    let soul = sentences[0].clone();
    let product_facts = sentences[sentences.len() - 1].clone();
    let principles = sentences[1..sentences.len() - 1].join("");
    BehaviorLayers {
        soul,
        principles,
        product_facts,
    }
}

/// 工具名映射表条目（中文名 ↔ 工具名；供策略层上下文）。
#[derive(Debug, Clone, PartialEq)]
pub struct NamePair {
    pub tool: String,
    pub zh: String,
}

/// 描述首句 → 中文行为意图标签（独立实现；与 tools 域首层兜底同源）。
pub fn zh_label_from_description(description: &str) -> Option<String> {
    let first_line = description.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() {
        return None;
    }
    let without_prefix = first_line
        .strip_prefix(DESCRIPTION_INTENT_PREFIX)
        .unwrap_or(first_line)
        .trim();
    let label = without_prefix
        .split("——")
        .next()
        .unwrap_or(without_prefix)
        .split('：')
        .next()
        .unwrap_or(without_prefix)
        .trim();
    if label.is_empty() {
        None
    } else {
        Some(label.to_string())
    }
}

/// tools.json → 工具名映射表中间态（中文标签 ↔ 工具名，按名排序）。
pub fn tool_name_map(tools_data: &JsonValue) -> Vec<NamePair> {
    let mut pairs: Vec<NamePair> = tools_data
        .get("tools")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|tool| {
                    let name = tool.get("name")?.as_str()?.to_string();
                    let zh = tool
                        .get("description")
                        .and_then(JsonValue::as_str)
                        .and_then(zh_label_from_description)
                        .unwrap_or_else(|| name.clone());
                    Some(NamePair { tool: name, zh })
                })
                .collect()
        })
        .unwrap_or_default();
    pairs.sort_by(|a, b| a.tool.cmp(&b.tool));
    pairs
}

/// 映射表 → 注入文本（策略层上下文的工具清单形态）。
pub fn tool_name_map_text(pairs: &[NamePair]) -> String {
    if pairs.is_empty() {
        return String::new();
    }
    let mut lines = Vec::with_capacity(pairs.len());
    lines.push("【工具清单（中文名 ↔ 工具名）】".to_string());
    for pair in pairs {
        lines.push(format!("- {}（{}）", pair.zh, pair.tool));
    }
    lines.join("\n")
}

/// 行为准则层目标设定的展开矩阵（场景 × 准则句式，组合无重复）。
const GENERATION_SCENARIOS: [&str; 12] = [
    "用户初次使用",
    "知识沉淀入库",
    "评审与取舍",
    "外部工具挂载",
    "失败与回退",
    "跨会话记忆",
    "情报检索取证",
    "开发构建循环",
    "文档与办公文件处理",
    "屏幕与视觉理解",
    "窗口与界面操作",
    "外部生态接入",
];

/// 准则展开视角（同一场景同一准则的三个行动侧面，行内容不同）。
const GENERATION_PERSPECTIVES: [&str; 3] = [
    "按此准则落实为具体动作",
    "以准则为边界，不越界行事",
    "执行过程留痕、结果可回看",
];

const GENERATION_PRINCIPLE_TS: [&str; 16] = [
    "先理解任务意图再动手，不跳过必要的确认",
    "经审批、可审计、可回退的变更才落地",
    "证据不足时保留不确定性，不臆断",
    "优先复用既有事实，缺失时主动检索",
    "失败信号回流为经验，同坑不踩第二次",
    "边界由数据声明，不静默扩大授权",
    "结论须经得起复核，引用附来源",
    "对用户意图做最小确认，不反复追问",
    "变更先快照，回退路径清晰可走",
    "确定性任务直达收敛，不空转探测",
    "不确定性任务先模拟后决策，不拍脑袋",
    "每次演化都留痕，链上可追溯可回放",
    "工具只是执行手段，选型服从目标",
    "信息先分级，敏感内容不越权展示",
    "长任务分步推进，中间结果可见",
    "尊重用户已有认知，不重复说教",
];

/// 场景化准则行（场景 × 准则句式 × 行动视角；组合无重复行）。
fn generation_line(scene: &str, principle: &str, perspective: &str) -> String {
    format!("在{scene}的情形下：{principle}（{perspective}）。")
}

/// 行为准则层注入产物（三段结构 + 目标设定展开 + 工具清单）。
#[derive(Debug, Clone, PartialEq)]
pub struct BehaviorInjection {
    pub soul: String,
    pub principles: String,
    pub product_facts: String,
    pub goal_text: String,
    pub catalog_text: String,
    pub guide_len: usize,
    pub catalog_len: usize,
}

impl BehaviorInjection {
    /// 目标设定 / 工具清单体积比（≥ [`BEHAVIOR_GUIDE_MIN_RATIO`]
    /// 为目标；工具清单为空时视为无穷大）。
    pub fn ratio(&self) -> f64 {
        if self.catalog_len == 0 {
            f64::INFINITY
        } else {
            self.guide_len as f64 / self.catalog_len as f64
        }
    }

    /// 注入全文（三段 + 目标设定展开；工具清单置于其后作对照）。
    pub fn render(&self) -> String {
        format!(
            "【身份与立场】\n{}\n\n【行为准则】\n{}\n\n【产品事实】\n{}\n\n【目标设定】\n{}\n\n【工具清单（供定位，不作为行为规范）】\n{}",
            self.soul, self.principles, self.product_facts, self.goal_text, self.catalog_text
        )
    }

    /// 目标设定体积是否达标（≥10 倍工具清单体积）。
    pub fn meets_ratio(&self) -> bool {
        self.ratio() >= BEHAVIOR_GUIDE_MIN_RATIO as f64
    }
}

/// 组合行为准则层注入：三段结构 + 确定性展开到目标设定体积达标。
///
/// 展开方式（有界、确定、行内容互不相同）：按「场景 × 准则句式 ×
/// 行动视角」矩阵依序生成场景化准则行（8×16×3 = 384 行），直到目标
/// 设定体积 ≥ 10 × 工具清单体积；矩阵内行不重复，单次遍历即有界。
pub fn compose_behavior_injection(layers: &BehaviorLayers, catalog_text: &str) -> BehaviorInjection {
    let catalog_len = catalog_text.len();
    let target_len = catalog_len * BEHAVIOR_GUIDE_MIN_RATIO;
    let mut lines: Vec<String> = Vec::new();
    for scene in GENERATION_SCENARIOS {
        for principle in GENERATION_PRINCIPLE_TS {
            for perspective in GENERATION_PERSPECTIVES {
                if total_len(&lines) >= target_len {
                    break;
                }
                lines.push(generation_line(scene, principle, perspective));
            }
            if total_len(&lines) >= target_len {
                break;
            }
        }
        if total_len(&lines) >= target_len {
            break;
        }
    }
    if !lines.is_empty() {
        lines.pop();
    }
    let goal_text = format!(
        "目标：构建可信的自进化认知伙伴——把使用中积累的理解沉淀为可审计、可回退的知识。\n{}",
        lines.join("\n")
    );
    let guide_len = goal_text.chars().count();
    BehaviorInjection {
        soul: layers.soul.clone(),
        principles: layers.principles.clone(),
        product_facts: layers.product_facts.clone(),
        goal_text,
        catalog_text: catalog_text.to_string(),
        guide_len,
        catalog_len,
    }
}

fn total_len(lines: &[String]) -> usize {
    lines.iter().map(|l| l.chars().count()).sum()
}

/// 回合行为层（行为准则层注入的完整形态）：soul + 行为准则 + 产品事实
/// + 目标设定展开 + 打标分类准则（确定性/不确定性双变体）+ 推演档位
/// 说明 + 交错推理引导语 + 工具名映射表。
///
/// 装配期一次性组成（纯函数），随五源装配进每回合上下文（行为源
/// 高权重全保留，不被预算裁剪）——「系统提示谈意图、工具描述谈动作」
/// 的纪律落点：本块不引用任何工具标识符，工具名映射表仅作对照。
pub fn compose_round_behavior(
    prompt: &str,
    tools_data: &serde_json::Value,
    tier: ReasoningTier,
) -> String {
    let layers = behavior_layers(prompt);
    let pairs = tool_name_map(tools_data);
    let catalog = tool_name_map_text(&pairs);
    let injection = compose_behavior_injection(&layers, &catalog);
    let mut parts: Vec<String> = vec![injection.render()];
    parts.push(strategy_prompt_variant(false).to_string());
    parts.push(strategy_prompt_variant(true).to_string());
    parts.push(reasoning_tier_prompt(tier).to_string());
    parts.push(interleaved_reasoning_guide().to_string());
    if !pairs.is_empty() {
        parts.push(format!("工具名对照表（用于理解对话中提到的工具，行动请按行为准则执行）：\n{}", catalog));
    }
    parts.join("\n\n")
}

/// 策略层提示词变体（打标分类准则；按任务确定性选择）。
pub fn strategy_prompt_variant(uncertain: bool) -> &'static str {
    if uncertain {
        STRATEGY_VARIANT_UNCERTAIN
    } else {
        STRATEGY_VARIANT_DETERMINISTIC
    }
}

/// 推演档位（声明式枚举；提示词变体按档位取用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningTier {
    Off,
    LiteProbe,
    Full,
}

impl ReasoningTier {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "off" => Ok(Self::Off),
            "lite" | "lite_probe" => Ok(Self::LiteProbe),
            "full" => Ok(Self::Full),
            other => Err(DomainError::InvalidData(format!("推演档位非法: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::LiteProbe => "lite_probe",
            Self::Full => "full",
        }
    }
}

/// 推演档位提示词变体（关/轻探测/全量 → 注入文本）。
pub fn reasoning_tier_prompt(tier: ReasoningTier) -> &'static str {
    match tier {
        ReasoningTier::Off => TIER_PROMPT_OFF,
        ReasoningTier::LiteProbe => TIER_PROMPT_LITE,
        ReasoningTier::Full => TIER_PROMPT_FULL,
    }
}

/// 交错推理引导语（一行）；不引用任何工具标识符。
pub fn interleaved_reasoning_guide() -> &'static str {
    INTERLEAVED_REASONING_LINE
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
    }

    fn seed_root() -> PathBuf {
        repo_root().join("inkling/seed_data")
    }

    fn seed_file(name: &str) -> JsonValue {
        let text = std::fs::read_to_string(seed_root().join(name)).expect("seed 文件读取失败");
        serde_json::from_str(&text).expect("seed 文件 JSON 非法")
    }

    #[test]
    fn boot_prompt_seed_loads_and_layers_split() {
        let data = load_boot_prompt(&seed_root()).expect("boot_prompt 装载失败");
        assert_eq!(data.name, "inkling.boot_prompt");
        assert!(data.version >= 1);
        let layers = behavior_layers(&data.prompt);
        assert!(!layers.soul.is_empty(), "身份与立场非空");
        assert!(!layers.principles.is_empty(), "行为准则非空");
        assert!(!layers.product_facts.is_empty(), "产品事实非空");
        assert!(layers.soul.contains("InKling"), "身份段应含产品名");
        assert!(layers.product_facts.contains("中文"), "产品事实段保留作答基调");
        assert!(layers.principles.contains("审批"), "行为准则段含治理基调");
    }

    #[test]
    fn tool_name_map_from_seed_is_sorted_and_labeled() {
        let tools = seed_file("tools.json");
        let pairs = tool_name_map(&tools);
        assert_eq!(pairs.len(), 40, "工具清单 40 条");
        assert_eq!(pairs[0].tool, "collect_material");
        let collect = pairs.iter().find(|p| p.tool == "collect_material").unwrap();
        assert_eq!(collect.zh, "把研究素材采集回来");
        let fetch = pairs.iter().find(|p| p.tool == "fetch").unwrap();
        assert_eq!(fetch.zh, "网络抓取");
        let text = tool_name_map_text(&pairs);
        assert!(text.contains("fetch"));
        assert!(text.contains("网络抓取"));
    }

    #[test]
    fn injection_meets_tenfold_ratio_with_real_seed() {
        let data = load_boot_prompt(&seed_root()).expect("boot_prompt 装载失败");
        let layers = behavior_layers(&data.prompt);
        let tools = seed_file("tools.json");
        let pairs = tool_name_map(&tools);
        let catalog = tool_name_map_text(&pairs);
        let injection = compose_behavior_injection(&layers, &catalog);
        assert!(
            injection.meets_ratio(),
            "目标设定体积应 ≥10 倍工具清单: guide={} catalog={}",
            injection.guide_len,
            injection.catalog_len
        );
        assert!(injection.ratio() >= 10.0);
        let rendered = injection.render();
        assert!(rendered.contains("【身份与立场】"));
        assert!(rendered.contains("【行为准则】"));
        assert!(rendered.contains("【产品事实】"));
        assert!(rendered.contains("【目标设定】"));
        assert!(rendered.contains("【工具清单"));
    }

    #[test]
    fn injection_with_empty_catalog_has_infinity_ratio() {
        let layers = behavior_layers("你是 InKling。观察、沉淀、可回退。用中文作答。");
        let injection = compose_behavior_injection(&layers, "");
        assert!(injection.ratio().is_infinite());
        assert!(injection.render().contains("【目标设定】"));
    }

    #[test]
    fn strategy_variants_cover_both_kinds() {
        assert!(strategy_prompt_variant(false).contains("spawn"));
        assert!(strategy_prompt_variant(false).contains("确定性"));
        assert!(strategy_prompt_variant(true).contains("simulate"));
        assert!(strategy_prompt_variant(true).contains("不确定"));
        assert!(strategy_prompt_variant(true).contains("探测"));
    }

    #[test]
    fn reasoning_tier_variants_and_parse() {
        assert_eq!(reasoning_tier_prompt(ReasoningTier::Off), TIER_PROMPT_OFF);
        assert_eq!(reasoning_tier_prompt(ReasoningTier::LiteProbe), TIER_PROMPT_LITE);
        assert_eq!(reasoning_tier_prompt(ReasoningTier::Full), TIER_PROMPT_FULL);
        assert_eq!(ReasoningTier::parse("lite").unwrap(), ReasoningTier::LiteProbe);
        assert_eq!(ReasoningTier::parse("full").unwrap(), ReasoningTier::Full);
        assert!(ReasoningTier::parse("bogus").is_err());
        assert_eq!(ReasoningTier::LiteProbe.as_str(), "lite_probe");
    }

    #[test]
    fn interleaved_line_mentions_no_tool_identifiers() {
        let line = interleaved_reasoning_guide();
        assert!(!line.is_empty());
        for forbidden in ["grep", "fetch", "call_engine", "tool", "工具名", "spawn"] {
            assert!(!line.contains(forbidden), "引导语不得引用工具标识符: {forbidden}");
        }
        assert!(line.contains("推理"));
        assert!(line.contains("自然语言"));
    }

    #[test]
    fn zh_label_extraction_rules() {
        let description = "行为意图：网络抓取——经 http_fetch 端点以 GET 取回网页原文。\n\n使用时机：回答需要…";
        assert_eq!(zh_label_from_description(description).as_deref(), Some("网络抓取"));
        assert_eq!(zh_label_from_description("没有前缀的标签"), Some("没有前缀的标签".to_string()));
        assert_eq!(zh_label_from_description(""), None);
    }
}

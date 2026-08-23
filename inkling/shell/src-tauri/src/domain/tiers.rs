//! 模型层挡位域：tiers.json 双挡位按挡位建链 + 缺省回退 + 推理档解析。
//!
//! 挡位机制语义（与引擎挡位原语对齐）：
//! - `tier_key`：未知挡位名归一为主挡位（防拼写错误静默换挡）；
//! - `resolve_tier_config`：缺挡位配置回落主挡位配置；
//! - `build_tier_chains`：每挡位一条模型链（主配置 + 备用链），
//!   未配置的挡位返回 None——调用方按缺省回退取主挡位链。
//!
//! 本模块把 tiers.json（挡位声明 + 缺省回退语义）与宿主注入的实际
//! 模型连接配置（base_url/模型/密钥引用归宿主职责）装配成挡位链的
//! 数据形态；模型链构造（适配器工厂/重试策略）是引擎机制，由装配侧
//! 经引擎桥接线。
//!
//! 推理强度档位（按模型声明的数据驱动形态）：模型配置数据携带
//! `reasoning_profile` 声明（param = 厂商参数名；tiers = 档位名 → 参数
//! 值映射；default = 默认档）。`param=null` = 该模型无推理档（不注入）；
//! 无声明 = 零注入（防厂商对未知参数报错）。档位值经宿主协议代理注入
//! LLM 调用参数，引擎零改动。

use std::collections::BTreeMap;

use serde_json::Value as JsonValue;

/// 未知挡位的回落锚点（tiers.json fallback.unknown_tier_falls_to 同源）。
pub const DEFAULT_TIER: &str = "main";

/// 缺省挡位声明（装配注入前的出厂形态：main/router 双挡）。
const DEFAULT_TIER_NAMES: [&str; 2] = ["main", "router"];

/// 单挡位的模型配置形态。
///
/// - `tier`：归一化后的挡位名（未知已回落主挡位）；
/// - `config`：主配置；None = 该挡位无配置（调用方走错误兜底）；
/// - `fallbacks`：备用配置列表（与主配置同形态，模型链备用链）。
#[derive(Debug, Clone, PartialEq)]
pub struct TierConfig {
    pub tier: String,
    pub config: Option<JsonValue>,
    pub fallbacks: Vec<JsonValue>,
}

/// 挡位名 → 配置键前缀；未知或 None 回落主挡位（防拼写错误静默换挡）。
pub fn tier_key(tier: &str, declared: &[String]) -> String {
    if declared.iter().any(|name| name == tier) {
        tier.to_string()
    } else {
        DEFAULT_TIER.to_string()
    }
}

/// 从用户模型配置解析指定挡位的配置形态（纯函数，可单测）。
///
/// 解析规则：
/// 1. 主配置 = `<tier>_config`，缺省回退 `main_config`；
/// 2. 备用列表 = `<tier>_fallback_configs`，兼容历史嵌套
///    `config["fallback_configs"]`；
/// 3. 全部缺失 → `config=None`（调用方按无配置处理，不抛错）。
pub fn resolve_tier_config(
    model_config: &JsonValue,
    tier: &str,
    declared: &[String],
) -> TierConfig {
    let key = tier_key(tier, declared);
    let primary_key = format!("{key}_config");
    let fallback_key = format!("{key}_fallback_configs");
    let cfg = model_config
        .get(primary_key.as_str())
        .or_else(|| model_config.get("main_config"))
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| JsonValue::Object(serde_json::Map::new()));
    let fallbacks = model_config
        .get(fallback_key.as_str())
        .cloned()
        .filter(|v| v.is_array())
        .or_else(|| {
            cfg.get("fallback_configs")
                .cloned()
                .filter(|v| v.is_array())
        })
        .map(|v| {
            v.as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(JsonValue::is_object)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let has_config = cfg.is_object() && !cfg.as_object().map(|m| m.is_empty()).unwrap_or(true);
    TierConfig {
        tier: key,
        config: if has_config { Some(cfg) } else { None },
        fallbacks,
    }
}

/// 一条模型链的数据形态（主配置 + 备用链配置的按序清单）。
///
/// 构造（适配器工厂/重试策略）与调用是引擎机制；本数据形态供装配侧
/// 经引擎桥驱动真实链构造。
#[derive(Debug, Clone, PartialEq)]
pub struct TierChain {
    /// 链配置按序清单（第一个为主配置，其余为备用配置）。
    pub configs: Vec<JsonValue>,
}

/// tiers.json 挡位清单 → 每挡位一条模型链（配置缺失 = 该挡位 None）。
///
/// 宿主注入的 model_config 含实际连接配置（挡位配置键形态与引擎
/// 解析对齐：`<tier>_config` + `<tier>_fallback_configs`）；未配置的
/// 挡位返回 None——调用方按缺省回退取主挡位链。
pub fn build_tier_chains(
    tiers_data: &JsonValue,
    model_config: &JsonValue,
) -> BTreeMap<String, Option<TierChain>> {
    let declared: Vec<String> = tiers_data
        .get("tiers")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut chains = BTreeMap::new();
    for tier in &declared {
        let resolved = resolve_tier_config(model_config, tier, &declared);
        let chain = resolved.config.map(|primary| TierChain {
            configs: std::iter::once(primary).chain(resolved.fallbacks).collect(),
        });
        chains.insert(tier.clone(), chain);
    }
    chains
}

/// 按挡位取链；未知挡位或缺省回退（回退语义与 tiers.json 一致）。
///
/// 规则：
/// 1. 未知挡位名 → 归一为主挡位（防拼写错误静默换挡）；
/// 2. 该挡位未建链（配置缺失）→ 回落主挡位链；
/// 3. 主挡位也未建链 → None（调用方按配置缺失兜底，与引擎节点
///    容错语义一致）。
pub fn resolve_tier_chain<'a>(
    chains: &'a BTreeMap<String, Option<TierChain>>,
    tier: Option<&str>,
    default_tier: &str,
) -> Option<&'a TierChain> {
    let declared: Vec<String> = chains.keys().cloned().collect();
    let key = match tier {
        Some(name) if chains.contains_key(name) => name.to_string(),
        Some(name) => tier_key(name, &declared),
        None => DEFAULT_TIER.to_string(),
    };
    let chain = chains.get(&key).and_then(|c| c.as_ref());
    if chain.is_none() && key != default_tier {
        return chains.get(default_tier).and_then(|c| c.as_ref());
    }
    chain
}

/// 挡位调用统计钩子：按挡位累加 LLM 调用次数，供回合级观测。
///
/// 用法（宿主回合收尾）：每次按挡位发起调用后 `record(tier)`，
/// 回合结束 `snapshot()` 汇入回合指标。单回合单执行流内使用。
#[derive(Debug, Clone, Default)]
pub struct TierCallStats {
    /// 生效中的挡位声明（record 归一化依据；缺省出厂双挡）。
    declared: Vec<String>,
    counts: BTreeMap<String, usize>,
}

impl TierCallStats {
    /// 新建统计钩子（缺省挡位声明 = main/router 出厂双挡）。
    pub fn new() -> Self {
        Self {
            declared: DEFAULT_TIER_NAMES.iter().map(|s| s.to_string()).collect(),
            counts: BTreeMap::new(),
        }
    }

    /// 以数据声明的挡位集合建统计钩子（tiers.json 装配注入后使用）。
    pub fn with_tiers(declared: Vec<String>) -> Self {
        let mut names = declared;
        if !names.iter().any(|n| n == DEFAULT_TIER) {
            names.push(DEFAULT_TIER.to_string());
        }
        Self {
            declared: names,
            counts: BTreeMap::new(),
        }
    }

    /// 累加一次（或多次）某挡位的调用数；未知挡位归一后记录。
    pub fn record(&mut self, tier: Option<&str>, count: usize) {
        if count == 0 {
            return;
        }
        let key = tier_key(tier.unwrap_or(""), &self.declared);
        *self.counts.entry(key).or_default() += count;
    }

    /// 当前计数快照（{挡位: 次数}，未调用过的挡位不出现）。
    pub fn snapshot(&self) -> BTreeMap<String, usize> {
        self.counts.clone()
    }

    /// 清零（新回合复用实例时调用）。
    pub fn reset(&mut self) {
        self.counts.clear();
    }

    /// 合并另一实例的计数（嵌套图/子图回流场景汇总）。
    pub fn merge(&mut self, other: &TierCallStats) {
        for (tier, count) in &other.counts {
            *self.counts.entry(tier.clone()).or_default() += count;
        }
    }
}

/// 推理强度档声明（按模型声明，模型配置数据 `reasoning_profile` 字段）。
///
/// - `param`：厂商参数名（OpenAI 系 `reasoning_effort`、Qwen 系
///   `enable_thinking` 等，各厂商各自声明）；None = 该模型无推理档；
/// - `tiers`：档位名 → 参数值映射（如 轻/标准/强 → low/medium/high）；
/// - `default`：默认档位名（换模型未记忆档位时回落）。
#[derive(Debug, Clone, PartialEq)]
pub struct ReasoningProfile {
    pub param: Option<String>,
    pub tiers: BTreeMap<String, String>,
    pub default: Option<String>,
}

/// 从模型配置解析推理档声明。
///
/// 解析规则：
/// - 配置无 `reasoning_profile` 声明 → None（零注入，不触碰模型参数）；
/// - `param` 为 null → 声明为无推理档（UI 隐藏档位控制器，不注入）；
/// - `tiers`/`default` 按字符串映射解析（非字符串值忽略）。
pub fn parse_reasoning_profile(config: &JsonValue) -> Option<ReasoningProfile> {
    let raw = config.get("reasoning_profile")?;
    if !raw.is_object() {
        return None;
    }
    let param = match raw.get("param") {
        Some(JsonValue::String(name)) => Some(name.clone()),
        _ => None,
    };
    let tiers = raw
        .get("tiers")
        .and_then(JsonValue::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|v| (name.clone(), v.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    let default = raw
        .get("default")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    Some(ReasoningProfile {
        param,
        tiers,
        default,
    })
}

/// 按当前档位解析注入参数（param 名, 档位值）。
///
/// 解析规则：档位命中 `tiers` 映射 → 该值；未命中回落 `default` 档；
/// 仍无命中 → None（零注入）。`param=null`（无推理档）恒返回 None。
pub fn resolve_reasoning_param(profile: &ReasoningProfile, tier: &str) -> Option<(String, String)> {
    let param = profile.param.clone()?;
    let value = profile
        .tiers
        .get(tier)
        .or_else(|| {
            profile
                .default
                .as_ref()
                .and_then(|d| profile.tiers.get(d))
        })
        .cloned()?;
    Some((param, value))
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

    fn tiers_data() -> JsonValue {
        seed_file("tiers.json")
    }

    fn declared_of(tiers: &JsonValue) -> Vec<String> {
        tiers["tiers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect()
    }

    /// 宿主注入的实际模型连接配置（stub 适配器，离线确定性）。
    fn model_config() -> JsonValue {
        serde_json::json!({
            "main_config": {
                "adapter": "stub", "model_id": "main-model", "base_url": "http://stub.local",
            },
            "router_config": {
                "adapter": "stub", "model_id": "router-model", "base_url": "http://stub.local",
            },
        })
    }

    #[test]
    fn tiers_json_declares_main_and_router() {
        let tiers = tiers_data();
        let declared = declared_of(&tiers);
        assert_eq!(declared, vec!["main".to_string(), "router".to_string()]);
        assert_eq!(tiers["default_tier"], "main");
    }

    #[test]
    fn two_tiers_chains_built_from_seed_declaration() {
        let tiers = tiers_data();
        let chains = build_tier_chains(&tiers, &model_config());
        let names: Vec<&str> = chains.keys().map(|s| s.as_str()).collect();
        assert_eq!(names, vec!["main", "router"]);
        let main = chains.get("main").and_then(|c| c.as_ref()).expect("主挡位应建链");
        assert_eq!(main.configs.len(), 1);
        assert_eq!(main.configs[0]["model_id"], "main-model");
        let router = chains.get("router").and_then(|c| c.as_ref()).expect("路由挡位应建链");
        assert_eq!(router.configs[0]["model_id"], "router-model");
    }

    #[test]
    fn unknown_tier_falls_back_to_main() {
        let tiers = tiers_data();
        let chains = build_tier_chains(&tiers, &model_config());
        let chain = resolve_tier_chain(&chains, Some("bogus_tier"), DEFAULT_TIER)
            .expect("未知挡位应回落主挡位");
        assert_eq!(chain.configs[0]["model_id"], "main-model");
        let none_tier = resolve_tier_chain(&chains, None, DEFAULT_TIER)
            .expect("None 挡位应回落主挡位");
        assert_eq!(none_tier.configs[0]["model_id"], "main-model");
    }

    #[test]
    fn missing_tier_config_falls_back_to_main_config() {
        let tiers = tiers_data();
        let sparse = serde_json::json!({
            "main_config": { "adapter": "stub", "model_id": "main-model", "base_url": "http://stub.local" },
        });
        let chains = build_tier_chains(&tiers, &sparse);
        // 缺 router 配置 → 回落 main_config 建链（resolve_tier_config 语义）
        for tier in ["main", "router"] {
            let chain = chains
                .get(tier)
                .and_then(|c| c.as_ref())
                .unwrap_or_else(|| panic!("挡位应回落建链: {tier}"));
            assert_eq!(chain.configs[0]["model_id"], "main-model");
        }
        // 全缺配置 = 无链（调用方按配置缺失兜底）
        let empty = build_tier_chains(&tiers, &serde_json::json!({}));
        assert!(empty["main"].is_none());
        assert!(resolve_tier_chain(&empty, Some("router"), DEFAULT_TIER).is_none());
    }

    #[test]
    fn fallback_configs_become_chain_slots() {
        let tiers = tiers_data();
        let with_fallbacks = serde_json::json!({
            "main_config": { "adapter": "stub", "model_id": "main-model" },
            "main_fallback_configs": [
                { "adapter": "stub", "model_id": "backup-model" },
                { "adapter": "stub", "model_id": "backup-model-2" },
            ],
        });
        let chains = build_tier_chains(&tiers, &with_fallbacks);
        let main = chains.get("main").and_then(|c| c.as_ref()).unwrap();
        assert_eq!(main.configs.len(), 3, "主配置 + 两条备用链");
        assert_eq!(main.configs[1]["model_id"], "backup-model");
    }

    #[test]
    fn tier_call_stats_observability() {
        let mut stats = TierCallStats::new();
        stats.record(Some("router"), 2);
        stats.record(Some("main"), 1);
        stats.record(Some("bogus"), 3); // 未知挡位归一 main
        let snapshot = stats.snapshot();
        assert_eq!(snapshot.get("router"), Some(&2));
        assert_eq!(snapshot.get("main"), Some(&4));
        let mut other = TierCallStats::new();
        other.record(Some("router"), 1);
        stats.merge(&other);
        assert_eq!(stats.snapshot().get("router"), Some(&3));
        stats.reset();
        assert!(stats.snapshot().is_empty());
    }

    #[test]
    fn tier_call_stats_follows_data_declared_tiers() {
        let mut stats = TierCallStats::with_tiers(vec!["main".to_string(), "router".to_string()]);
        stats.record(Some("audit"), 1); // 未声明挡位归一 main
        assert_eq!(stats.snapshot().get("main"), Some(&1));
    }

    #[test]
    fn reasoning_profile_absent_means_zero_injection() {
        let config = serde_json::json!({ "model_id": "plain-model" });
        assert!(parse_reasoning_profile(&config).is_none());
    }

    #[test]
    fn reasoning_profile_param_null_means_no_tier() {
        let config = serde_json::json!({
            "reasoning_profile": { "param": null, "tiers": { "light": "low" }, "default": "light" }
        });
        let profile = parse_reasoning_profile(&config).expect("声明应可解析");
        assert_eq!(profile.param, None, "param=null = 无推理档");
        assert!(resolve_reasoning_param(&profile, "light").is_none());
    }

    #[test]
    fn reasoning_profile_resolves_tier_and_default() {
        let config = serde_json::json!({
            "reasoning_profile": {
                "param": "reasoning_effort",
                "tiers": { "light": "low", "strong": "high" },
                "default": "light",
            }
        });
        let profile = parse_reasoning_profile(&config).expect("声明应可解析");
        assert_eq!(profile.param.as_deref(), Some("reasoning_effort"));
        let (param, value) = resolve_reasoning_param(&profile, "strong").expect("档位命中");
        assert_eq!(param, "reasoning_effort");
        assert_eq!(value, "high");
        // 未命中档位 → 回落默认档
        let (_, fallback) = resolve_reasoning_param(&profile, "unknown").expect("默认档回落");
        assert_eq!(fallback, "low");
    }

    #[test]
    fn reasoning_profile_unknown_tier_without_default_is_zero_injection() {
        let config = serde_json::json!({
            "reasoning_profile": { "param": "enable_thinking", "tiers": { "on": "true" } }
        });
        let profile = parse_reasoning_profile(&config).unwrap();
        assert!(resolve_reasoning_param(&profile, "missing").is_none());
    }
}

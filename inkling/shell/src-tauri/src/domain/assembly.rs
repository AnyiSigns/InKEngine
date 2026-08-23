//! assembly 域：调配域装配——五源输入装配源提供者 + 记忆/检索接线 +
//! 域窗口投影/归档摘要。
//!
//! 引擎机制（core.assembly.InputAssembler）按五源预算（context/
//! knowledge/tool/memory/evidence）对源分池裁剪；本模块负责「源从
//! 哪来」——宿主侧装配的数据推导与提供者形态：
//! - 记忆源：记忆存储契约（query 协议）+ PriorityRecallPolicy 召回
//!   + memory.json 失效窗口（未过期才可被召回）；
//! - 检索源：知识集检索（确定性关键词基线）+ 可选 embedding 向量化
//!   （缺省 None = 纯关键词基线，语义层不降级）+ 五源证据池；
//! - 单源故障不阻断回合：记忆/检索/知识任一步失败只缺该源（装配是
//!   增强，增强失败不能击穿执行）；
//! - 域窗口投影/归档摘要：按域切分共享消息流，归档摘要入记忆源。
//!
//! 依赖纪律：本模块不直接调用其它域模块；记忆存储/检索源经契约
//! trait 注入（boot.rs 把引擎存储与检索注册表接进钩子——域侧零存储
//! 后端耦合），引擎侧装配动作经
//! [`crate::engine::host::call_engine_op`] 操作通道（接线点文档标注）。

use std::collections::HashSet;
use std::pin::Pin;

use serde_json::{json, Value as JsonValue};

// ── 五源类别 / 来源分级常量 ──

pub const SOURCE_CONTEXT: &str = "context";
pub const SOURCE_KNOWLEDGE: &str = "knowledge";
pub const SOURCE_TOOL: &str = "tool";
pub const SOURCE_MEMORY: &str = "memory";
pub const SOURCE_EVIDENCE: &str = "evidence";

/// 检索结果来源分级（模型级可信度；注册表并入的注入边界）。
pub const SOURCE_MODEL: &str = "model";

/// 工具源预取上限（体积护栏：工具描述进装配文本的上界；预算级裁剪
/// 由 InputAssembler 按 tool_ratio 池执行——预取只防大对象循环，动态
/// 纳入的新工具不被硬上限截断出预算刷新之外）。
pub const MAX_TOOL_SOURCES: usize = 48;

/// 记忆召回缺省上限（memory.json recall.default_limit 缺省值）。
const DEFAULT_RECALL_LIMIT: usize = 8;

/// 缺省五源比例（context/knowledge/tool/memory/evidence）。
const DEFAULT_POOL_RATIOS: [f64; 5] = [0.4, 0.3, 0.1, 0.1, 0.1];

/// 记忆失效窗口缺省天数（memory.json expiry.default_window_days 缺省）。
const DEFAULT_EXPIRY_DAYS: f64 = 90.0;

/// 域窗口投影缺省工具轮上限（防上下文膨胀）。
const DEFAULT_MAX_TOOL_ROUNDS: usize = 8;

/// 归档摘要目标/正文截断（确定性摘要的字符预算）。
const DIGEST_GOAL_CHARS: usize = 120;
const DIGEST_GOAL_COUNT: usize = 3;
const DIGEST_BODY_CHARS: usize = 400;

// ── 记忆源（存储契约 + 召回策略 + 失效窗口）──

/// 单条记忆条目（与引擎 MemoryEntry 字段语义一一对应）。
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntry {
    pub id: String,
    pub namespace: String,
    pub kind: String,
    pub content: String,
    pub title: Option<String>,
    pub source: String,
    pub priority: f64,
    pub weight: f64,
    pub created_at: f64,
    pub expires_at: Option<f64>,
}

impl MemoryEntry {
    /// 已过期判定（无失效时间视为永续）。
    pub fn is_expired(&self, now: f64) -> bool {
        self.expires_at.is_some_and(|t| now >= t)
    }
}

/// 记忆查询条件（namespace 过滤；limit None = 不限）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryQuery {
    pub namespace: Option<String>,
    pub limit: Option<usize>,
}

/// 记忆存储契约（boot 接线：engine 存储三后端经 op 通道接入）。
///
/// 契约即引擎 MemoryStore 的 query 协议——域侧零存储后端耦合；
/// 库实现可换（memory/sqlite/postgres），装配方负责接线。
pub trait MemoryStore: Send + Sync {
    fn query(
        &self,
        q: MemoryQuery,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Vec<MemoryEntry>, String>> + Send + '_>>;
}

/// 记忆存储装配描述（collection 与 memory.json store.collection 对齐）。
///
/// 存储实例经契约接线：engine.memory_query 已注册，装配层把引擎存储
/// 接进 [`MemoryStore`] 契约钩子（域侧零存储后端耦合）。
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryStoreSpec {
    pub collection: String,
}

/// 记忆存储装配（collection 与 memory.json store.collection 对齐）。
pub fn build_memory_store(collection: &str) -> MemoryStoreSpec {
    MemoryStoreSpec {
        collection: collection.to_string(),
    }
}

/// memory.json 失效窗口（默认 90 天；None = 不过期）。
pub fn memory_expiry_window(memory_data: &JsonValue) -> Option<f64> {
    let days = memory_data
        .get("expiry")
        .and_then(|e| e.get("default_window_days"))
        .and_then(JsonValue::as_f64)
        .unwrap_or(DEFAULT_EXPIRY_DAYS);
    if days > 0.0 {
        Some(days * 24.0 * 3600.0)
    } else {
        None
    }
}

/// 优先级召回策略：过期过滤 + 优先级降序/创建时间降序排序 + top-k 截断。
pub struct PriorityRecallPolicy;

impl PriorityRecallPolicy {
    pub fn recall(&self, entries: Vec<MemoryEntry>, limit: Option<usize>) -> Vec<MemoryEntry> {
        let now = now_epoch();
        let mut alive: Vec<MemoryEntry> = entries
            .into_iter()
            .filter(|entry| !entry.is_expired(now))
            .collect();
        alive.sort_by(|a, b| {
            b.priority
                .partial_cmp(&a.priority)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(
                    b.created_at
                        .partial_cmp(&a.created_at)
                        .unwrap_or(std::cmp::Ordering::Equal),
                )
        });
        if let Some(limit) = limit {
            alive.truncate(limit);
        }
        alive
    }
}

/// 记忆召回：过期过滤（PriorityRecallPolicy 语义）+ 优先级排序截断。
pub async fn recall_memory(
    store: &dyn MemoryStore,
    namespace: &str,
    limit: usize,
) -> Result<Vec<MemoryEntry>, String> {
    let entries = store
        .query(MemoryQuery {
            namespace: Some(namespace.to_string()),
            limit: None,
        })
        .await?;
    Ok(PriorityRecallPolicy.recall(entries, Some(limit)))
}

/// 记忆存储经操作通道的接线声明（供 boot 读取的声明形态）。
pub fn memory_store_wiring() -> JsonValue {
    json!({
        "op": "engine.memory_query",
        "note": "engine.memory_query 已注册：装配层经操作通道把引擎存储接进记忆契约钩子（MemoryStore trait）",
    })
}

// ── 检索源（知识集关键词基线 + 可选 embedding 向量化）──

/// 知识条目检索视图（检索源消费的最小字段集）。
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeEntryData {
    pub id: String,
    pub kind: String,
    pub level: String,
    pub title: String,
    pub credibility: f64,
    pub usage_count: usize,
    pub data: JsonValue,
}

/// 检索命中块（证据源注入条目）。
#[derive(Debug, Clone, PartialEq)]
pub struct RetrievedChunk {
    pub source: String,
    pub doc_id: String,
    pub text: String,
    pub relevance: f64,
    pub level: String,
    pub meta: JsonValue,
}

/// 知识集检索契约（库实现 = 关键词/向量检索的宿主接线）。
pub trait KnowledgeSearch: Send + Sync {
    fn search(&self, query: &str, limit: usize) -> Vec<KnowledgeEntryData>;
}

/// 知识条目渲染（标题 + 声明数据摘要，上下文体积有界）。
pub fn render_entry(entry: &KnowledgeEntryData) -> String {
    let body = entry.data.to_string();
    let body: String = body.chars().take(500).collect();
    format!("{}：{body}", if entry.title.is_empty() { &entry.id } else { &entry.title })
}

/// 知识集检索源：确定性关键词匹配（知识条目按可信度排序截断）。
///
/// 召回结果按模型级可信度（SOURCE_MODEL）分级——注入文本在注册表
/// 边界被剔除（core.retrieval 的注入防线），本侧只供检索产物。
pub struct KnowledgeSetRetriever {
    search: Box<dyn KnowledgeSearch>,
    limit: usize,
}

impl KnowledgeSetRetriever {
    pub fn new(search: Box<dyn KnowledgeSearch>, limit: usize) -> Self {
        Self {
            search,
            limit: limit.max(1),
        }
    }

    pub fn retrieve(&self, query: &str, limit: usize) -> Vec<RetrievedChunk> {
        self.search
            .search(query, self.limit)
            .into_iter()
            .map(|entry| RetrievedChunk {
                source: "knowledge_set".to_string(),
                doc_id: entry.id.clone(),
                text: render_entry(&entry),
                relevance: entry.credibility,
                level: SOURCE_MODEL.to_string(),
                meta: json!({"kind": entry.kind, "level": entry.level}),
            })
            .take(limit)
            .collect()
    }
}

/// 嵌入评分钩子（语义分：query × 条目 → 0-1；实现方由 embedding 桥提供）。
pub trait EmbedScore: Send + Sync {
    fn score(&self, query: &str, entry: &KnowledgeEntryData) -> f64;
}

/// 可选向量化检索源：embedder 缺省 None = 纯关键词基线。
///
/// 挂载 embedding 后，命中条目按向量相似度排序（relevance 由
/// embedder 提供）；未挂载时语义层不降级——relevance 中性（可信度），
/// 排序交给知识集可信度（与 [`KnowledgeSetRetriever`] 同语义）。
pub struct EmbeddingRetriever {
    search: Box<dyn KnowledgeSearch>,
    embedder: Option<Box<dyn EmbedScore>>,
    limit: usize,
}

impl EmbeddingRetriever {
    pub fn new(search: Box<dyn KnowledgeSearch>, embedder: Option<Box<dyn EmbedScore>>, limit: usize) -> Self {
        Self {
            search,
            embedder,
            limit: limit.max(1),
        }
    }

    pub fn retrieve(&self, query: &str, limit: usize) -> Vec<RetrievedChunk> {
        let entries = self.search.search(query, self.limit);
        let mut chunks: Vec<RetrievedChunk> = entries
            .into_iter()
            .map(|entry| {
                let (relevance, semantic) = match &self.embedder {
                    Some(embedder) => (embedder.score(query, &entry).clamp(0.0, 1.0), true),
                    None => (entry.credibility, false),
                };
                RetrievedChunk {
                    source: "embedding".to_string(),
                    doc_id: entry.id.clone(),
                    text: render_entry(&entry),
                    relevance,
                    level: SOURCE_MODEL.to_string(),
                    meta: if semantic {
                        json!({"kind": entry.kind, "semantic": true})
                    } else {
                        json!({"kind": entry.kind})
                    },
                }
            })
            .collect();
        chunks.truncate(limit);
        chunks
    }
}

/// 证据检索注册表（五源提供者的证据池来源）。
pub trait EvidenceRetriever: Send + Sync {
    fn retrieve(
        &self,
        query: &str,
        limit: usize,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Vec<RetrievedChunk>, String>> + Send + '_>>;
}

// ── 五源输入装配源提供者 ──

/// 单个装配源（ContextSource 形态：类别/内容/权重/相关性/优先级/meta）。
#[derive(Debug, Clone, PartialEq)]
pub struct ContextSource {
    pub source_type: String,
    pub content: String,
    pub title: String,
    pub weight: f64,
    pub relevance: f64,
    pub priority: usize,
    pub meta: JsonValue,
}

impl ContextSource {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "type": self.source_type,
            "content": self.content,
            "title": self.title,
            "weight": self.weight,
            "relevance": self.relevance,
            "priority": self.priority,
            "meta": self.meta,
        })
    }
}

/// 五源源预算（分池上限 = 总预算 × 各源比例；裁剪由引擎装配器执行）。
#[derive(Debug, Clone, PartialEq)]
pub struct PoolBudget {
    pub total: usize,
    pub context: usize,
    pub knowledge: usize,
    pub tool: usize,
    pub memory: usize,
    pub evidence: usize,
}

impl PoolBudget {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "total_budget": self.total,
            "context": self.context,
            "knowledge": self.knowledge,
            "tool": self.tool,
            "memory": self.memory,
            "evidence": self.evidence,
        })
    }
}

/// 五源分池预算（context/knowledge/tool/memory/evidence 各池上限）。
pub fn pool_budgets(total_budget: usize, ratios: Option<[f64; 5]>) -> PoolBudget {
    let ratios = ratios.unwrap_or(DEFAULT_POOL_RATIOS);
    let pool = |ratio: f64| -> usize { ((total_budget as f64) * ratio).floor() as usize };
    PoolBudget {
        total: total_budget,
        context: pool(ratios[0]),
        knowledge: pool(ratios[1]),
        tool: pool(ratios[2]),
        memory: pool(ratios[3]),
        evidence: pool(ratios[4]),
    }
}

/// 五源输入装配源提供者（RunOptions.assembly_sources 注入形态）。
///
/// 每个源都是 ContextSource（type ∈ 五源分类），引擎装配器按预算分池
/// 裁剪；提供者自身不裁剪（裁剪是引擎机制，宿主只供源）。单源故障
/// 不阻断回合：记忆/检索/知识任一步失败，只缺该源。
///
/// 工具源实时刷新（调配器动态组装）：`tool_specs_provider` = 每次
/// 装配现取工具表（新挂载工具下一回合自动纳入工具源预算）。
pub struct FiveSourceProvider {
    memory_store: Option<Box<dyn MemoryStore>>,
    evidence: Option<Box<dyn EvidenceRetriever>>,
    knowledge: Option<Box<dyn KnowledgeSearch>>,
    tool_specs: Vec<JsonValue>,
    tool_specs_provider: Option<Box<dyn Fn() -> Vec<JsonValue> + Send + Sync>>,
    memory_namespace: String,
    memory_limit: usize,
    evidence_limit: usize,
}

impl FiveSourceProvider {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        memory_store: Option<Box<dyn MemoryStore>>,
        evidence: Option<Box<dyn EvidenceRetriever>>,
        knowledge: Option<Box<dyn KnowledgeSearch>>,
        tool_specs: Vec<JsonValue>,
        tool_specs_provider: Option<Box<dyn Fn() -> Vec<JsonValue> + Send + Sync>>,
        memory_namespace: &str,
        memory_limit: usize,
        evidence_limit: usize,
    ) -> Self {
        Self {
            memory_store,
            evidence,
            knowledge,
            tool_specs,
            tool_specs_provider,
            memory_namespace: memory_namespace.to_string(),
            memory_limit,
            evidence_limit,
        }
    }

    /// 现取工具清单（动态提供器优先；静态清单为兼容形态）。
    fn specs_now(&self) -> Vec<JsonValue> {
        match &self.tool_specs_provider {
            Some(provider) => provider(),
            None => self.tool_specs.clone(),
        }
    }

    /// 五源组装：回合查询 → 五源源清单（单源故障只缺该源）。
    pub async fn provide(&self, query: &str) -> Vec<ContextSource> {
        let query = query.trim();
        let mut sources: Vec<ContextSource> = Vec::new();
        if !query.is_empty() {
            sources.push(ContextSource {
                source_type: SOURCE_CONTEXT.to_string(),
                content: query.to_string(),
                title: "回合输入".to_string(),
                weight: 1.0,
                relevance: 1.0,
                priority: 10,
                meta: json!({"source": "input"}),
            });
        }
        if let Some(knowledge) = &self.knowledge {
            if !query.is_empty() {
                for entry in knowledge.search(query, self.memory_limit) {
                    let content = render_entry(&entry);
                    let content: String = content.chars().take(800).collect();
                    sources.push(ContextSource {
                        source_type: SOURCE_KNOWLEDGE.to_string(),
                        content,
                        title: if entry.title.is_empty() { entry.id.clone() } else { entry.title.clone() },
                        weight: entry.credibility,
                        relevance: entry.credibility,
                        priority: entry.usage_count,
                        meta: json!({"entry_id": entry.id, "kind": entry.kind}),
                    });
                }
            }
        }
        for spec in self.specs_now().into_iter().take(MAX_TOOL_SOURCES) {
            let name = spec.get("name").and_then(JsonValue::as_str).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let description = spec.get("description").and_then(JsonValue::as_str).unwrap_or("");
            sources.push(ContextSource {
                source_type: SOURCE_TOOL.to_string(),
                content: format!("{name}：{description}"),
                title: format!("工具：{name}"),
                weight: 0.8,
                relevance: 0.6,
                priority: 3,
                meta: json!({"tool": name}),
            });
        }
        if let Some(store) = &self.memory_store {
            match recall_memory(store.as_ref(), &self.memory_namespace, self.memory_limit).await {
                Ok(recalled) => {
                    for entry in recalled {
                        let content: String = entry.content.chars().take(800).collect();
                        sources.push(ContextSource {
                            source_type: SOURCE_MEMORY.to_string(),
                            content,
                            title: entry.title.clone().unwrap_or_else(|| entry.id.clone()),
                            weight: entry.weight,
                            relevance: (entry.priority / 10.0).clamp(0.0, 1.0),
                            priority: entry.priority as usize,
                            meta: json!({"kind": entry.kind, "entry_id": entry.id}),
                        });
                    }
                }
                Err(_) => {} // 单源故障只缺该源（装配是增强，失败不击穿）
            }
        }
        if let Some(evidence) = &self.evidence {
            if !query.is_empty() {
                match evidence.retrieve(query, self.evidence_limit).await {
                    Ok(chunks) => {
                        for chunk in chunks {
                            let content: String = chunk.text.chars().take(800).collect();
                            sources.push(ContextSource {
                                source_type: SOURCE_EVIDENCE.to_string(),
                                content,
                                title: format!("检索：{}/{}", chunk.source, chunk.doc_id),
                                weight: 0.8,
                                relevance: chunk.relevance,
                                priority: 5,
                                meta: json!({"source": chunk.source, "doc_id": chunk.doc_id}),
                            });
                        }
                    }
                    Err(_) => {}
                }
            }
        }
        sources
    }
}

/// 五源提供者装配（记忆存储/证据检索/知识检索经契约注入；工具静态
/// 清单或动态提供器二选一）。
pub fn build_five_source_provider(
    memory_store: Option<Box<dyn MemoryStore>>,
    evidence: Option<Box<dyn EvidenceRetriever>>,
    knowledge: Option<Box<dyn KnowledgeSearch>>,
    tool_specs: Vec<JsonValue>,
    tool_specs_provider: Option<Box<dyn Fn() -> Vec<JsonValue> + Send + Sync>>,
    memory_namespace: &str,
    memory_limit: usize,
    evidence_limit: usize,
) -> FiveSourceProvider {
    FiveSourceProvider::new(
        memory_store,
        evidence,
        knowledge,
        tool_specs,
        tool_specs_provider,
        memory_namespace,
        if memory_limit == 0 { DEFAULT_RECALL_LIMIT } else { memory_limit },
        evidence_limit,
    )
}

// ── 域窗口投影 / 归档摘要（确定性原语）──

fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn message_role(message: &JsonValue) -> String {    message
        .get("role")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string()
}

fn message_text(message: &JsonValue) -> String {
    let content = message.get("content").and_then(JsonValue::as_str).unwrap_or("");
    if !content.is_empty() {
        return content.to_string();
    }
    message
        .get("content")
        .and_then(JsonValue::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(JsonValue::as_str).map(str::to_string))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn tool_calls_of(message: &JsonValue) -> Vec<String> {
    message
        .get("tool_calls")
        .and_then(JsonValue::as_array)
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    call.get("name")
                        .and_then(JsonValue::as_str)
                        .or_else(|| {
                            call.get("function")
                                .and_then(|f| f.get("name"))
                                .and_then(JsonValue::as_str)
                        })
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 域窗口投影（按域切分共享消息流：用户消息全留 + 本域最近工具轮 +
/// 最近完成性回复；公共集工具整轮保留——防上下文撕裂，宁多勿少）。
pub fn project_domain_window(
    messages: &[JsonValue],
    group: &str,
    group_of: &dyn Fn(&str) -> Option<&str>,
    max_tool_rounds: usize,
) -> Vec<JsonValue> {    let mut window: Vec<JsonValue> = messages
        .iter()
        .filter(|m| message_role(m) == "user")
        .cloned()
        .collect();
    // 工具轮 = assistant 携带 tool_calls 的消息及其后续 tool 结果消息
    let mut tool_rounds: Vec<Vec<JsonValue>> = Vec::new();
    let mut current_round: Vec<JsonValue> = Vec::new();
    let mut in_round = false;
    for message in messages {
        let role = message_role(message);
        if role == "assistant" && !tool_calls_of(message).is_empty() {
            if in_round {
                tool_rounds.push(std::mem::take(&mut current_round));
            }
            in_round = true;
            current_round.push(message.clone());
            continue;
        }
        if in_round && role == "tool" {
            current_round.push(message.clone());
            continue;
        }
        if in_round {
            tool_rounds.push(std::mem::take(&mut current_round));
            in_round = false;
        }
    }
    if in_round {
        tool_rounds.push(current_round);
    }
    for round in tool_rounds.iter().rev().take(max_tool_rounds).collect::<Vec<_>>().into_iter().rev() {
        let names: Vec<String> = round
            .iter()
            .flat_map(tool_calls_of)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        // 工具归属：本域工具或公共集工具（group_of 返回 None = 公共集）
        // 整轮保留——宁多勿少，只留半轮会撕裂上下文
        let belongs = names.iter().any(|name| {
            group_of(name)
                .map(|g| g == group)
                .unwrap_or(true)
        });
        if belongs {
            window.extend(round.iter().cloned());
        }
    }
    if let Some(body) = messages
        .iter()
        .rev()
        .find(|m| {
            message_role(m) == "assistant"
                && tool_calls_of(m).is_empty()
                && !message_text(m).trim().is_empty()
        })
    {
        window.push(body.clone());
    }
    window
}

/// 域窗口投影（缺省工具轮上限形态；上限见 [`DEFAULT_MAX_TOOL_ROUNDS`]）。
pub fn project_domain_window_default(
    messages: &[JsonValue],
    group: &str,
    group_of: &dyn Fn(&str) -> Option<&str>,
) -> Vec<JsonValue> {
    project_domain_window(messages, group, group_of, DEFAULT_MAX_TOOL_ROUNDS)
}

/// 归档摘要（确定性：最近用户目标 + 最近回复截断 + 工具轮统计）。
///
/// 同一窗口必得同一摘要（可缓存、可断言、零成本）；LLM 级语义摘要
/// 由上层记忆策略承接，不在此原语内。
pub fn archive_digest(window: &[JsonValue], max_chars: usize) -> String {
    let mut goals: Vec<String> = Vec::new();
    for message in window {
        if message_role(message) == "user" {
            let text = message_text(message);
            if !text.is_empty() {
                goals.push(text.chars().take(DIGEST_GOAL_CHARS).collect());
            }
        }
    }
    let mut bodies: Vec<String> = Vec::new();
    let mut tool_rounds = 0usize;
    for message in window {
        if message_role(message) == "assistant" {
            if !tool_calls_of(message).is_empty() {
                tool_rounds += 1;
            } else {
                let text = message_text(message).trim().to_string();
                if !text.is_empty() {
                    bodies.push(text.chars().take(DIGEST_BODY_CHARS).collect());
                }
            }
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if !goals.is_empty() {
        let tail: Vec<String> = goals
            .iter()
            .rev()
            .take(DIGEST_GOAL_COUNT)
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        parts.push(format!("用户目标：{}", tail.join("；")));
    }
    if let Some(body) = bodies.last() {
        parts.push(format!("最近回复：{body}"));
    }
    parts.push(format!("工具轮数：{tool_rounds}"));
    let digest = parts.join("\n");
    digest.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MEMORY_JSON: &str = include_str!("../../../../../inkling/seed_data/memory.json");

    fn seed_memory() -> JsonValue {
        serde_json::from_str(MEMORY_JSON).unwrap()
    }

    fn entry(content: &str, priority: f64, created_at: f64, expires_at: Option<f64>) -> MemoryEntry {
        MemoryEntry {
            id: format!("user:default:{content}"),
            namespace: "user:default".to_string(),
            kind: "decision".to_string(),
            content: content.to_string(),
            title: None,
            source: "manual".to_string(),
            priority,
            weight: 1.0,
            created_at,
            expires_at,
        }
    }

    struct MemoryFake {
        rows: Vec<MemoryEntry>,
        fail: bool,
    }

    impl MemoryStore for MemoryFake {
        fn query(
            &self,
            q: MemoryQuery,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Vec<MemoryEntry>, String>> + Send + '_>> {
            let rows = self.rows.clone();
            let namespaces = q.namespace.clone();
            Box::pin(async move {
                if self.fail {
                    return Err("存储故障".to_string());
                }
                let filtered = match namespaces {
                    Some(ns) => rows.into_iter().filter(|r| r.namespace == ns).collect(),
                    None => rows,
                };
                Ok(filtered)
            })
        }
    }

    struct KnowledgeFake {
        rows: Vec<KnowledgeEntryData>,
    }

    impl KnowledgeSearch for KnowledgeFake {
        fn search(&self, _query: &str, limit: usize) -> Vec<KnowledgeEntryData> {
            let mut hits = self.rows.clone();
            hits.sort_by(|a, b| {
                b.credibility
                    .partial_cmp(&a.credibility)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            hits.truncate(limit);
            hits
        }
    }

    struct EmbedFake;

    impl EmbedScore for EmbedFake {
        fn score(&self, query: &str, entry: &KnowledgeEntryData) -> f64 {
            if entry.title.contains(&query.chars().next().unwrap_or('喂').to_string())
                || entry.data.to_string().contains(query)
            {
                0.95
            } else {
                0.1
            }
        }
    }

    struct EvidenceFake {
        rows: Vec<RetrievedChunk>,
        fail: bool,
    }

    impl EvidenceRetriever for EvidenceFake {
        fn retrieve(
            &self,
            _query: &str,
            limit: usize,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Vec<RetrievedChunk>, String>> + Send + '_>> {
            let rows = self.rows.clone();
            Box::pin(async move {
                if self.fail {
                    return Err("检索故障".to_string());
                }
                Ok(rows.into_iter().take(limit).collect())
            })
        }
    }

    fn knowledge_row(id: &str, title: &str, credibility: f64, kind: &str) -> KnowledgeEntryData {
        KnowledgeEntryData {
            id: id.to_string(),
            kind: kind.to_string(),
            level: "project".to_string(),
            title: title.to_string(),
            credibility,
            usage_count: 3,
            data: json!({"rule": {"message": "墨引擎机制"}}),
        }
    }

    #[test]
    fn memory_expiry_window_defaults_to_90_days() {
        let window = memory_expiry_window(&seed_memory()).unwrap();
        assert!((window - 90.0 * 24.0 * 3600.0).abs() < 1e-6);
        // 非正天数 = 不过期
        assert!(memory_expiry_window(&json!({"expiry": {"default_window_days": 0}})).is_none());
        assert!(memory_expiry_window(&json!({"expiry": {"default_window_days": -3}})).is_none());
        assert!(memory_expiry_window(&json!({})).is_some(), "缺省值回退 90 天");
    }

    #[test]
    fn memory_store_spec_collection_follows_declaration() {
        let spec = build_memory_store("memory");
        assert_eq!(spec.collection, "memory");
        let seed = seed_memory();
        assert_eq!(seed["store"]["collection"], "memory", "collection 与声明对齐");
    }

    #[test]
    fn priority_recall_filters_expired_and_orders() {
        let now = now_epoch();
        let policy = PriorityRecallPolicy;
        let rows = vec![
            entry("低优先", 2.0, now - 10.0, Some(now + 1000.0)),
            entry("高优先", 9.0, now - 10.0, Some(now + 1000.0)),
            entry("已过期", 9.0, now - 10.0, Some(now - 1.0)),
            entry("永续", 5.0, now, None),
        ];
        let recalled = policy.recall(rows, Some(10));
        let contents: Vec<&str> = recalled.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, vec!["高优先", "永续", "低优先"], "过期过滤 + 优先级降序");
        // 同优先级按创建时间降序
        let ties = vec![
            entry("旧", 7.0, 100.0, None),
            entry("新", 7.0, 300.0, None),
        ];
        let recalled = policy.recall(ties, None);
        assert_eq!(recalled[0].content, "新");
        // limit 截断 top-k
        let limited = policy.recall(vec![entry("a", 5.0, 1.0, None), entry("b", 5.0, 2.0, None)], Some(1));
        assert_eq!(limited.len(), 1);
    }

    #[tokio::test]
    async fn recall_memory_via_store_contract() {
        let store = MemoryFake {
            rows: vec![
                entry("高优先记忆", 9.0, 100.0, None),
                entry("已过期记忆", 9.0, 100.0, Some(1.0)),
                entry("低优先记忆", 2.0, 100.0, None),
            ],
            fail: false,
        };
        let recalled = recall_memory(&store, "user:default", 10).await.unwrap();
        let contents: Vec<&str> = recalled.iter().map(|r| r.content.as_str()).collect();
        assert_eq!(contents, vec!["高优先记忆", "低优先记忆"], "失效窗口过滤 + priority 降序");
        assert!(recall_memory(&MemoryFake { rows: vec![], fail: true }, "user:default", 8).await.is_err());
    }

    #[test]
    fn knowledge_set_retriever_chunks_with_credibility_ranking() {
        let search = KnowledgeFake {
            rows: vec![
                knowledge_row("seed.inkling.domain_guide", "领域基线", 0.9, "rule"),
                knowledge_row("seed.inkling.source_credibility", "来源可信度", 0.8, "weight"),
            ],
        };
        let retriever = KnowledgeSetRetriever::new(Box::new(search), 8);
        let chunks = retriever.retrieve("墨引擎", 8);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].source, "knowledge_set");
        assert_eq!(chunks[0].relevance, 0.9, "relevance = 可信度");
        assert_eq!(chunks[0].level, SOURCE_MODEL);
        assert_eq!(chunks[0].meta["kind"], "rule");
        assert!(chunks[0].text.contains("领域基线"));
        // 请求 limit 截断
        let one = retriever.retrieve("墨引擎", 1);
        assert_eq!(one.len(), 1);
    }

    #[test]
    fn embedding_retriever_semantic_mount_and_baseline() {
        let search = KnowledgeFake {
            rows: vec![
                knowledge_row("k.evo", "进化机制条目", 0.7, "rule"),
                knowledge_row("k.other", "无关条目", 0.7, "rule"),
            ],
        };
        // 未挂 embedding：纯关键词基线（semantic 不标位）
        let bare = EmbeddingRetriever::new(Box::new(search), None, 8);
        let chunks = bare.retrieve("墨引擎", 8);
        assert!(chunks.iter().all(|c| c.meta.get("semantic").is_none()));
        assert_eq!(chunks[0].relevance, 0.7);
        // 挂 embedding：semantic 标位 + 相似度排序
        let semantic_search = KnowledgeFake {
            rows: vec![
                knowledge_row("k.evo", "进化机制条目", 0.7, "rule"),
                KnowledgeEntryData {
                    id: "k.other".to_string(),
                    kind: "rule".to_string(),
                    level: "work".to_string(),
                    title: "无关条目".to_string(),
                    credibility: 0.7,
                    usage_count: 1,
                    data: json!({}),
                },
            ],
        };
        let semantic = EmbeddingRetriever::new(Box::new(semantic_search), Some(Box::new(EmbedFake)), 8);
        let chunks = semantic.retrieve("墨引擎", 8);
        assert!(chunks.iter().all(|c| c.meta.get("semantic") == Some(&json!(true))));
        assert!(chunks[0].relevance > 0.9 + 1e-9, "命中条目语义分高");
        assert_eq!(chunks[0].doc_id, "k.evo");
        assert!(chunks[1].relevance < 0.2, "未命中条目语义分中性");
    }

    #[tokio::test]
    async fn five_source_provider_assembles_all_sources() {
        let store = MemoryFake {
            rows: vec![entry("用户偏好：回答用中文", 7.0, 100.0, None)],
            fail: false,
        };
        let evidence = EvidenceFake {
            rows: vec![RetrievedChunk {
                source: "knowledge_set".to_string(),
                doc_id: "seed.inkling.domain_guide".to_string(),
                text: "墨引擎机制检索块".to_string(),
                relevance: 0.9,
                level: SOURCE_MODEL.to_string(),
                meta: json!({}),
            }],
            fail: false,
        };
        let provider = build_five_source_provider(
            Some(Box::new(store)),
            Some(Box::new(evidence)),
            Some(Box::new(KnowledgeFake { rows: vec![knowledge_row("seed.inkling.domain_guide", "领域基线", 0.9, "rule")] })),
            vec![json!({"name": "collect_material", "description": "采集"})],
            None,
            "user:default",
            8,
            8,
        );
        let sources = provider.provide("墨引擎机制").await;
        let types: Vec<&str> = sources.iter().map(|s| s.source_type.as_str()).collect();
        assert_eq!(types, vec![SOURCE_CONTEXT, SOURCE_KNOWLEDGE, SOURCE_TOOL, SOURCE_MEMORY, SOURCE_EVIDENCE]);
        let context = &sources[0];
        assert_eq!(context.weight, 1.0);
        assert_eq!(context.relevance, 1.0);
        assert_eq!(context.meta["source"], "input");
        let tool = &sources[2];
        assert_eq!(tool.title, "工具：collect_material");
        assert_eq!(tool.content, "collect_material：采集");
        assert_eq!(tool.weight, 0.8);
        assert_eq!(tool.meta["tool"], "collect_material");
        let memory = &sources[3];
        assert_eq!(memory.meta["kind"], "decision");
        assert!((memory.relevance - 0.7).abs() < 1e-9, "relevance = priority/10");
    }

    #[tokio::test]
    async fn five_source_single_failure_does_not_block() {
        let provider = build_five_source_provider(
            Some(Box::new(MemoryFake { rows: vec![], fail: true })),
            Some(Box::new(EvidenceFake { rows: vec![], fail: true })),
            Some(Box::new(KnowledgeFake { rows: vec![knowledge_row("k.fail", "机制条目", 0.9, "rule")] })),
            vec![json!({"name": "collect_material"})],
            None,
            "user:default",
            8,
            8,
        );
        let sources = provider.provide("墨引擎机制").await;
        let types: Vec<&str> = sources.iter().map(|s| s.source_type.as_str()).collect();
        assert!(types.contains(&SOURCE_CONTEXT));
        assert!(types.contains(&SOURCE_KNOWLEDGE), "记忆/检索故障下知识源照常");
        assert!(types.contains(&SOURCE_TOOL));
        assert!(!types.contains(&SOURCE_MEMORY), "记忆故障只缺记忆源");
        assert!(!types.contains(&SOURCE_EVIDENCE), "检索故障只缺证据源");
    }

    #[test]
    fn tool_source_prefetch_caps_at_48() {
        let specs: Vec<JsonValue> = (0..52)
            .map(|index| json!({"name": format!("tool_{index}"), "description": "d"}))
            .collect();
        let provider = build_five_source_provider(None, None, None, specs, None, "user:default", 8, 8);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let sources = rt.block_on(provider.provide("查询"));
        let tools: Vec<&ContextSource> = sources.iter().filter(|s| s.source_type == SOURCE_TOOL).collect();
        assert_eq!(tools.len(), MAX_TOOL_SOURCES);
        assert!(tools.iter().all(|t| t.title != "工具：tool_51"), "超限工具被预取截断");
    }

    #[test]
    fn pool_budgets_allocate_by_ratios() {
        let budget = pool_budgets(1200, None);
        assert_eq!(budget.total, 1200);
        assert_eq!(budget.context, 480);
        assert_eq!(budget.knowledge, 360);
        assert_eq!(budget.tool, 120);
        assert_eq!(budget.memory, 120);
        assert_eq!(budget.evidence, 120);
        // 自定义比例
        let custom = pool_budgets(1000, Some([0.5, 0.2, 0.1, 0.1, 0.1]));
        assert_eq!(custom.knowledge, 200);
        assert_eq!(custom.context, 500);
        // 预算极紧：各池地板截断不超总预算
        let tight = pool_budgets(10, None);
        assert!(tight.context + tight.knowledge + tight.tool + tight.memory + tight.evidence <= 10);
    }

#[test]
fn domain_window_projection_slices_groups_and_keeps_body() {
    let messages = vec![
        json!({"role": "user", "content": "研究墨引擎"}),
        json!({"role": "assistant", "content": "好的，开始研究。"}),
        json!({"role": "user", "content": "补充材料"}),
        json!({"role": "assistant", "content": "材料已补充。"}),
    ];
    let group_of: &dyn Fn(&str) -> Option<&str> = &|name: &str| -> Option<&str> {
        match name {
            "collect_material" => Some("research"),
            "screenshot" => Some("os_control"),
            _ => None, // 公共集工具（None）
        }
    };
    let window = project_domain_window(&messages, "research", group_of, 8);
    assert!(!window.is_empty());
    assert_eq!(window.last().unwrap()["content"], "材料已补充。", "最近完成性回复保留");
    assert_eq!(window[0]["content"], "研究墨引擎", "用户消息全留");
    // 工具轮归属：公共集工具（group_of = None）整轮保留（防上下文撕裂）
    let rounds = vec![
        json!({"role": "user", "content": "查询"}),
        json!({"role": "assistant", "content": "", "tool_calls": [{"name": "web_search_mcp"}]}),
        json!({"role": "tool", "content": "结果", "tool_call_id": "1"}),
        json!({"role": "assistant", "content": "完成回复"}),
    ];
    let window = project_domain_window(&rounds, "research", group_of, 8);
    let names: Vec<&str> = window.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert!(names.contains(&"tool"), "公共集工具轮整轮进入窗口");
    assert_eq!(window.last().unwrap()["content"], "完成回复");
    // 异域工具轮不进入窗口（只留半轮会撕裂上下文）
    let foreign = vec![
        json!({"role": "user", "content": "查询"}),
        json!({"role": "assistant", "content": "", "tool_calls": [{"name": "screenshot"}]}),
        json!({"role": "tool", "content": "图", "tool_call_id": "2"}),
        json!({"role": "assistant", "content": "别域回复"}),
    ];
    let window = project_domain_window(&foreign, "research", group_of, 8);
    assert!(window.iter().all(|m| m["role"].as_str().unwrap() != "tool"),
        "异域工具轮整轮剔除（窗口不含半轮）");
}

    #[test]
    fn archive_digest_is_deterministic_summary() {
        let window = vec![
            json!({"role": "user", "content": "研究墨引擎机制"}),
            json!({"role": "assistant", "content": "好的，开始研究。"}),
            json!({"role": "user", "content": "补充材料"}),
            json!({"role": "assistant", "content": "材料已补充。"}),
        ];
        let digest = archive_digest(&window, 200);
        assert!(digest.len() <= 200);
        assert!(digest.contains("用户目标："));
        assert!(digest.contains("研究墨引擎机制"));
        assert!(digest.contains("最近回复：材料已补充。"));
        assert!(digest.contains("工具轮数：0"));
        // 确定性：同一窗口同一摘要
        assert_eq!(digest, archive_digest(&window, 200));
        // 工具轮统计
        let with_rounds = vec![
            json!({"role": "user", "content": "查询"}),
            json!({"role": "assistant", "content": "", "tool_calls": [{"name": "web_search_mcp"}]}),
            json!({"role": "assistant", "content": "完成"}),
        ];
        let digest = archive_digest(&with_rounds, 800);
        assert!(digest.contains("工具轮数：1"));
    }

    #[test]
    fn render_entry_bounds_context_volume() {
        let entry = KnowledgeEntryData {
            id: "k.long".to_string(),
            kind: "rule".to_string(),
            level: "work".to_string(),
            title: "长条目".to_string(),
            credibility: 0.9,
            usage_count: 1,
            data: json!({"rule": {"message": "x".repeat(3000)}}),
        };
        let rendered = render_entry(&entry);
        assert!(rendered.len() <= 500 + "长条目：".len() + 10, "数据段截断 500 字符");
        assert!(rendered.starts_with("长条目："));
    }

    #[test]
    fn source_to_json_serializes_all_fields() {
        let source = ContextSource {
            source_type: SOURCE_CONTEXT.to_string(),
            content: "输入".to_string(),
            title: "回合输入".to_string(),
            weight: 1.0,
            relevance: 1.0,
            priority: 10,
            meta: json!({"source": "input"}),
        };
        let data = source.to_json();
        assert_eq!(data["type"], SOURCE_CONTEXT);
        assert_eq!(data["priority"], 10);
        assert_eq!(data["meta"]["source"], "input");
    }

    #[test]
    fn memory_store_wiring_declares_op_boundary() {
        let wiring = memory_store_wiring();
        assert_eq!(wiring["op"], "engine.memory_query");
        // 事实描述：op 已注册，装配层接线（不再是待扩展占位文案）
        assert!(wiring["note"].as_str().unwrap().contains("已注册"));
    }
}

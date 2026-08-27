//! session 域：会话 CRUD（records 通道会话记录 + checkpoint 索引）+
//! 标题生成 + 分支树（chain_rebase 多叶映射）。
//!
//! 存储契约映射：会话记录 = 引擎 records 通道的 `sessions` 集合
//! （key = thread_id，data = SessionMeta 形态）；分支树 = 同一
//! thread 的 checkpoint 版本链（多叶 = 编辑重发/由此分支产出的新叶）。
//! 两者都持久化在引擎存储里——重启后列表/分支/标题不丢（重启持久
//! 由引擎存储后端承担，本模块只做映射与动作编排）。
//!
//! 标题生成：首回合 ≥2 条消息后触发（router 轻挡 + 标题提示词 →
//! ≤12 字候选；候选缺失/超长时降级 = 时间戳）。
//!
//! 依赖纪律：本模块不直接调用其它域模块；引擎交互（记录读写/分支
//! 动作）经 [`crate::engine::host::call_engine_op_async`] 操作通道。

use serde_json::Value as JsonValue;

use super::common::DomainError;
use crate::engine::host::call_engine_op_async;

/// 会话记录集合名（引擎 records 通道）。
pub const SESSION_COLLECTION: &str = "sessions";

/// 会话标题最大字符数（≤12 字约束）。
pub const SESSION_TITLE_MAX_CHARS: usize = 12;

/// 标题生成触发条件（首回合消息数下限）。
pub const TITLE_TRIGGER_MESSAGE_COUNT: usize = 2;

/// 标题候选截断上限（候选超长时按字截断，字符计数不按字节）。
pub const TITLE_CANDIDATE_MAX_CHARS: usize = 12;

/// 标题生成提示词（系统面：中文 ≤12 字、禁用标点枝蔓、失败降级）。
pub const TITLE_PROMPT_SYSTEM: &str = "你是会话标题编辑。为这段对话生成一个中文标题：不超过 12 字，描述会话主题，不加引号标点，不重复用户原话，不出现工具名。";

/// 标题生成的采样温度（低值稳，标题重确定性不重发散）。
pub const TITLE_TEMPERATURE: f64 = 0.5;

/// 会话元数据（records 通道的数据形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionMeta {
    pub thread_id: String,
    pub title: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub message_count: usize,
    pub current_leaf: Option<i64>,
    pub rename_count: usize,
    pub deleted: bool,
}

/// records 数据 → SessionMeta（字段缺失/形态非法 = 结构化错误）。
pub fn session_meta_from_record(record: &JsonValue) -> Result<SessionMeta, DomainError> {
    let thread_id = record
        .get("thread_id")
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| DomainError::InvalidData("会话记录缺 thread_id".to_string()))?
        .to_string();
    let title = record
        .get("title")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    Ok(SessionMeta {
        thread_id,
        title,
        created_at: record.get("created_at").and_then(JsonValue::as_f64).unwrap_or(0.0),
        updated_at: record.get("updated_at").and_then(JsonValue::as_f64).unwrap_or(0.0),
        message_count: record
            .get("message_count")
            .and_then(JsonValue::as_u64)
            .unwrap_or(0) as usize,
        current_leaf: record.get("current_leaf").and_then(JsonValue::as_i64),
        rename_count: record
            .get("rename_count")
            .and_then(JsonValue::as_u64)
            .unwrap_or(0) as usize,
        deleted: record
            .get("deleted")
            .and_then(JsonValue::as_bool)
            .unwrap_or(false),
    })
}

/// SessionMeta → records 数据形态。
pub fn session_meta_to_record(meta: &SessionMeta) -> JsonValue {
    serde_json::json!({
        "thread_id": meta.thread_id,
        "title": meta.title,
        "created_at": meta.created_at,
        "updated_at": meta.updated_at,
        "message_count": meta.message_count,
        "current_leaf": meta.current_leaf,
        "rename_count": meta.rename_count,
        "deleted": meta.deleted,
    })
}

/// 新建会话（时间戳取当前；标题留空待标题生成触发）。
pub fn new_session(thread_id: &str) -> SessionMeta {
    let now = now_epoch();
    SessionMeta {
        thread_id: thread_id.to_string(),
        title: String::new(),
        created_at: now,
        updated_at: now,
        message_count: 0,
        current_leaf: None,
        rename_count: 0,
        deleted: false,
    }
}

/// 会话列表（records 清单 → 排序元数据；已删除排除，按更新时间倒序）。
pub fn list_sessions_meta(records: &[JsonValue]) -> Result<Vec<SessionMeta>, DomainError> {
    let mut sessions: Vec<SessionMeta> = records
        .iter()
        .map(session_meta_from_record)
        .collect::<Result<Vec<_>, _>>()?;
    sessions.sort_by(|a, b| {
        b.updated_at
            .partial_cmp(&a.updated_at)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    sessions.retain(|s| !s.deleted);
    Ok(sessions)
}

/// 重命名会话（标题 ≤12 字约束；空标题拒绝；重复重命名计数）。
pub fn rename_session(meta: &mut SessionMeta, new_title: &str) -> Result<(), DomainError> {
    let normalized = normalize_title(new_title, "").ok_or_else(|| {
        DomainError::InvalidData("会话标题不能为空（标题生成降级为时间戳）".to_string())
    })?;
    meta.title = normalized;
    meta.rename_count += 1;
    meta.updated_at = now_epoch();
    Ok(())
}

/// 标题候选归一化（≤12 字；换行折叠；空候选 → None 走降级）。
pub fn normalize_title(candidate: &str, fallback: &str) -> Option<String> {
    let folded: String = candidate
        .chars()
        .filter(|c| !c.is_whitespace() || *c == ' ')
        .collect();
    let trimmed = folded.trim();
    let limit = trimmed.chars().take(SESSION_TITLE_MAX_CHARS).collect::<String>();
    let limit = limit.trim().to_string();
    if limit.is_empty() {
        if fallback.is_empty() {
            None
        } else {
            Some(fallback.to_string())
        }
    } else {
        Some(limit)
    }
}

/// 降级标题（时间戳形态；标题生成失败时的兜底）。
pub fn fallback_title() -> String {
    use chrono::Local;
    Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// 标题生成：首回合 ≥2 条消息后触发。
///
/// `messages` = 回合消息清单（role/content 形态）；`router_candidate`
/// = router 轻挡 + 标题提示词产出的候选（≤12 字）；候选缺失/非法时
/// 降级为时间戳。消息不足触发条件 → None（不生成，等待继续对话）。
pub fn title_from_messages(
    messages: &[JsonValue],
    router_candidate: Option<&str>,
    fallback: &str,
) -> Option<String> {
    if messages.len() < TITLE_TRIGGER_MESSAGE_COUNT {
        return None;
    }
    let candidate = router_candidate.unwrap_or("");
    Some(normalize_title(candidate, fallback).unwrap_or_else(|| fallback.to_string()))
}

fn now_epoch() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// ── 分支树（checkpoint 版本链的多叶映射）──

/// 分支节点（版本链行的叶形态；checkpoint_id 作叶标识）。
#[derive(Debug, Clone, PartialEq)]
pub struct BranchNode {
    pub leaf: i64,
    pub parent: Option<i64>,
    pub reason: Option<String>,
}

/// 分支树（链行 → 叶/父关系；current = 当前叶，叶行 = 无子行）。
#[derive(Debug, Clone, PartialEq)]
pub struct BranchTree {
    pub session_id: String,
    pub nodes: Vec<BranchNode>,
    pub current_leaf: Option<i64>,
}

impl BranchTree {
    /// 指定叶的父叶（回退目标；根叶无敌）。
    pub fn parent_of(&self, leaf: i64) -> Option<i64> {
        self.nodes
            .iter()
            .find(|n| n.leaf == leaf)
            .and_then(|n| n.parent)
    }

    /// 叶是否存在。
    pub fn contains(&self, leaf: i64) -> bool {
        self.nodes.iter().any(|n| n.leaf == leaf)
    }
}

/// checkpoint 链索引 → 分支树（chain_rebase 多叶映射）。
///
/// `chain` = 引擎 checkpoint 链索引行（checkpoint_id/parent_id/reason
/// 形态；按 id 倒序）。多叶判定：叶 = 没有任何行以其为父的链行
/// （编辑重发/由此分支 fork 出的新叶）；当前叶 = 最大 checkpoint_id
/// 的行（链尾恒保留，见链压缩语义）。
pub fn branch_tree_from_chain_index(
    chain: &[JsonValue],
    session_id: &str,
) -> Result<BranchTree, DomainError> {
    let mut rows: Vec<(i64, Option<i64>, Option<String>)> = Vec::new();
    for row in chain {
        let id = row
            .get("checkpoint_id")
            .or_else(|| row.get("id"))
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| DomainError::InvalidData("链索引行缺 checkpoint_id".to_string()))?;
        let parent = row
            .get("parent_id")
            .and_then(JsonValue::as_i64)
            .filter(|p| *p != 0);
        let reason = row
            .get("reason")
            .and_then(JsonValue::as_str)
            .map(str::to_string);
        rows.push((id, parent, reason));
    }
    if rows.is_empty() {
        return Ok(BranchTree {
            session_id: session_id.to_string(),
            nodes: Vec::new(),
            current_leaf: None,
        });
    }
    let parent_ids: std::collections::HashSet<i64> =
        rows.iter().filter_map(|(_, parent, _)| *parent).collect();
    let ids: Vec<i64> = rows.iter().map(|(id, _, _)| *id).collect();
    let current_leaf = *ids.iter().max().expect("rows 非空保证存在最大叶");
    let mut nodes: Vec<BranchNode> = rows
        .iter()
        .map(|(id, parent, reason)| BranchNode {
            leaf: *id,
            parent: *parent,
            reason: reason.clone(),
        })
        .collect();
    nodes.sort_by_key(|node| std::cmp::Reverse(node.leaf));
    // R12：`current_leaf = 最大 checkpoint_id` 恒为叶（链尾保留语义），
    // 删除冗余条件——叶判定只依赖 parent_ids，不存在需单独保链尾的情况。
    nodes.retain(|node| !parent_ids.contains(&node.leaf));
    Ok(BranchTree {
        session_id: session_id.to_string(),
        nodes,
        current_leaf: Some(current_leaf),
    })
}

/// 叶切换（编辑重发/由此分支 → 新叶落点；目标为树内任意叶 → 切回）。
///
/// 目标叶不在树内 = 拒绝（防切到不存在的 checkpoint）。
pub fn switch_leaf(tree: &BranchTree, target_leaf: i64) -> Result<i64, DomainError> {
    if !tree.contains(target_leaf) {
        return Err(DomainError::InvalidData(format!(
            "目标叶不存在于分支树: {target_leaf}"
        )));
    }
    Ok(target_leaf)
}

/// 回退（当前叶 → 其父叶；根叶无父 = 拒绝回退）。
pub fn revert_leaf(tree: &BranchTree) -> Result<i64, DomainError> {
    let current = tree
        .current_leaf
        .ok_or_else(|| DomainError::InvalidData("分支树无当前叶（链为空）".to_string()))?;
    let parent = tree
        .parent_of(current)
        .ok_or_else(|| DomainError::InvalidData(format!("当前叶 {current} 为根叶，无可回退")))?;
    Ok(parent)
}

// ── 引擎交互（op 通道；未注册 op 显式声明）──

/// 拉取会话记录清单（引擎 records 通道；重启后持久恢复入口）。
pub async fn fetch_sessions() -> Result<Vec<SessionMeta>, String> {
    let records = call_engine_op_async(
        "engine.records_list",
        serde_json::json!({ "collection": SESSION_COLLECTION }),
    )
    .await?;
    let list = records
        .as_array()
        .ok_or_else(|| "会话记录返回非数组".to_string())?;
    list_sessions_meta(list).map_err(|err| err.to_string())
}

/// 保存会话记录（引擎 records 通道；新建/切换/重命名/标题落库共用）。
pub async fn save_session(meta: &SessionMeta) -> Result<(), String> {
    call_engine_op_async(
        "engine.records_put",
        serde_json::json!({
            "collection": SESSION_COLLECTION,
            "key": meta.thread_id,
            "data": session_meta_to_record(meta),
        }),
    )
    .await?;
    Ok(())
}

/// 删除会话（记录移除 + 版本链清理）。
///
/// 记录移除经 engine.records_delete（墓碑标记：删除留痕可追溯），
/// 版本链清理经 engine.storage_delete_thread（checkpoint + 事件裁剪）。
pub async fn delete_session(thread_id: &str) -> Result<(), String> {
    call_engine_op_async(
        "engine.records_delete",
        serde_json::json!({
            "collection": SESSION_COLLECTION,
            "key": thread_id,
        }),
    )
    .await?;
    call_engine_op_async(
        "engine.storage_delete_thread",
        serde_json::json!({ "thread_id": thread_id }),
    )
    .await?;
    Ok(())
}

/// 分支动作（叶切换/切回原叶/回退/fork 新叶）经 op 通道下发。
///
/// 动作下发前经本模块的纯逻辑判定（[`switch_leaf`] / [`revert_leaf`]）
/// ——判定通过才发起：
/// - switch → engine.thread_resume（按目标叶 checkpoint 续跑）；
/// - revert → engine.thread_revert（回退到父叶，删除其后检查点）；
/// - branch → engine.thread_branch（以目标叶为父 fork 新叶，空状态
///   增量；带编辑内容的 fork 形态见 [`fork_branch`]）。
pub async fn branch_action(
    tree: &BranchTree,
    action: &str,
    target_leaf: Option<i64>,
) -> Result<i64, String> {
    match action {
        "switch" => {
            let leaf = target_leaf
                .ok_or_else(|| "切换动作缺目标叶".to_string())
                .and_then(|leaf| switch_leaf(tree, leaf).map_err(|err| err.to_string()))?;
            call_engine_op_async(
                "engine.thread_resume",
                serde_json::json!({
                    "thread_id": tree.session_id,
                    "checkpoint_id": leaf,
                    "input": "",
                }),
            )
            .await?;
            Ok(leaf)
        }
        "revert" => {
            let target = revert_leaf(tree).map_err(|err| err.to_string())?;
            call_engine_op_async(
                "engine.thread_revert",
                serde_json::json!({
                    "thread_id": tree.session_id,
                    "target_id": target,
                }),
            )
            .await?;
            Ok(target)
        }
        "branch" => {
            let parent = target_leaf
                .ok_or_else(|| "分支动作缺父叶".to_string())
                .and_then(|leaf| switch_leaf(tree, leaf).map_err(|err| err.to_string()))?;
            fork_branch(tree, parent, serde_json::json!({})).await
        }
        other => Err(format!("未知分支动作: {other}")),
    }
}

/// 分支（fork 新叶）：以树内父叶为锚点 fork 出新叶，携带状态增量
/// （编辑重发/由此分支产出的编辑内容随 state_patch 注入）。
///
/// 父叶须在树内（[`switch_leaf`] 校验）；引擎侧以父叶检查点状态为
/// 基底合并增量，返回新叶 checkpoint_id。
pub async fn fork_branch(
    tree: &BranchTree,
    parent_leaf: i64,
    state_patch: serde_json::Value,
) -> Result<i64, String> {
    switch_leaf(tree, parent_leaf).map_err(|err| err.to_string())?;
    let created = call_engine_op_async(
        "engine.thread_branch",
        serde_json::json!({
            "thread_id": tree.session_id,
            "parent_id": parent_leaf,
            "state_patch": state_patch,
        }),
    )
    .await?;
    created
        .get("checkpoint_id")
        .and_then(JsonValue::as_i64)
        .ok_or_else(|| "分支未返回新叶 checkpoint_id".to_string())
}

// ── 分支树拉取 / 标题生成（回合后宿主动作）──

/// 新会话线程 id（引擎线程标识的宿主生成形态；前缀可读 + 随机后缀）。
pub fn new_thread_id() -> String {
    format!("thread-{}", uuid::Uuid::new_v4().simple())
}

/// 拉取会话分支树（engine.thread_chain_index → [`BranchTree`]）。
///
/// 无链记录 = 空树（新建会话的初始形态，可安全切换/回退判定）。
pub async fn fetch_branch_tree(thread_id: &str) -> Result<BranchTree, String> {
    let chain = call_engine_op_async(
        "engine.thread_chain_index",
        serde_json::json!({ "thread_id": thread_id }),
    )
    .await?;
    let rows = chain
        .as_array()
        .ok_or_else(|| "分支树数据非数组".to_string())?;
    branch_tree_from_chain_index(rows, thread_id).map_err(|err| err.to_string())
}

/// 从最新检查点提取回合消息（角色/内容形态；无检查点 = 空清单）。
///
/// 标题生成与消息计数共用同一数据源（检查点状态是消息的持久化形态）。
pub fn checkpoint_messages(checkpoint: &JsonValue) -> Vec<JsonValue> {
    checkpoint
        .get("state")
        .and_then(|state| state.get("messages"))
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default()
}

/// 拉取会话最新检查点（engine.thread_latest_checkpoint；无记录 = None）。
pub async fn fetch_latest_checkpoint(thread_id: &str) -> Result<Option<JsonValue>, String> {
    let latest = call_engine_op_async(
        "engine.thread_latest_checkpoint",
        serde_json::json!({ "thread_id": thread_id }),
    )
    .await?;
    if latest.is_null() {
        Ok(None)
    } else {
        Ok(Some(latest))
    }
}

/// 标题生成消息清单（router 轻挡输入形态：系统 + 用户消息）。
///
/// 用户消息 = 会话消息压缩面（首条/末条上下文 + 消息条数锚点），
/// 逐条消息不整体灌入（标题只需要主题，不需要全文）。
pub fn title_messages(messages: &[JsonValue]) -> Vec<JsonValue> {
    let mut user_parts: Vec<String> = Vec::new();
    if let Some(first) = messages.iter().find(|m| {
        m.get("role").and_then(JsonValue::as_str) == Some("user")
    }) {
        if let Some(content) = first.get("content").and_then(JsonValue::as_str) {
            user_parts.push(content.chars().take(60).collect::<String>());
        }
    }
    if let Some(content) = messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(JsonValue::as_str) == Some("user"))
        .and_then(|m| m.get("content"))
        .and_then(JsonValue::as_str)
    {
        user_parts.push(content.chars().take(60).collect::<String>());
    }
    let unique: Vec<&str> = user_parts
        .iter()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let body = format!(
        "本次会话共 {} 条消息。开头：{}。最近：{}。",
        messages.len(),
        unique.first().map(|s| s.to_string()).unwrap_or_default(),
        unique.last().map(|s| s.to_string()).unwrap_or_default()
    );
    vec![
        serde_json::json!({ "role": "system", "content": TITLE_PROMPT_SYSTEM }),
        serde_json::json!({ "role": "user", "content": body }),
    ]
}

/// 生成标题候选（router 轻挡 + 标题提示词 → ≤12 字中文候选）。
///
/// 候选来源：router 模型经 [`title_messages`] 轻调；无候选/解析失败 →
/// None（调用方降级时间戳，标题生成失败不阻塞回合）。
pub async fn title_candidate(messages: &[JsonValue]) -> Result<Option<String>, String> {
    let prompt_messages = title_messages(messages);
    let reply = crate::engine::host::call_engine_op_async(
        "engine.router_light_complete",
        serde_json::json!({ "messages": prompt_messages }),
    )
    .await?;
    let content = reply
        .get("content")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty());
    Ok(content
        .and_then(|text| normalize_title(text, ""))
        .filter(|text| !text.is_empty()))
}

/// 回合后刷新：消息计数/更新时间落库 + 首回合标题生成。
///
/// 触发条件（标题生成）：会话无标题（未手动重命名）且最新检查点消息
/// ≥ 2 条；候选成功 → 落库；失败 → 时间戳降级（不阻塞，不重试）。
pub async fn refresh_session_after_round(thread_id: &str) -> Result<JsonValue, String> {
    let checkpoint = fetch_latest_checkpoint(thread_id).await?;
    let messages = checkpoint
        .as_ref()
        .map(checkpoint_messages)
        .unwrap_or_default();
    let meta = fetch_session_meta(thread_id).await?;

    let mut updated = meta.unwrap_or_else(|| new_session(thread_id));
    updated.message_count = messages.len();
    updated.updated_at = now_epoch();
    // R13：刷新时同步写回 SessionMeta.current_leaf（与 branch_tree 的
    // current_leaf 语义一致——resume/回退锚点不因刷新偏差）。
    sync_current_leaf(&mut updated, &checkpoint);
    if !updated.deleted {
        if updated.title.is_empty() && messages.len() >= TITLE_TRIGGER_MESSAGE_COUNT {
            let candidate = title_candidate(&messages).await.unwrap_or(None);
            let title = candidate.unwrap_or_else(fallback_title);
            updated.title = normalize_title(&title, "").unwrap_or_else(fallback_title);
        }
        save_session(&updated).await?;
    }
    Ok(session_meta_to_record(&updated))
}

/// 从最新检查点回填 current_leaf（R13：无检查点 = 不改写，保持既有值）。
fn sync_current_leaf(meta: &mut SessionMeta, checkpoint: &Option<JsonValue>) {
    if let Some(cp) = checkpoint {
        if let Some(id) = cp.get("checkpoint_id").and_then(JsonValue::as_i64) {
            meta.current_leaf = Some(id);
        }
    }
}

/// 读取单条会话记录（补丁链/重命名前读取；无记录 = None）。
pub async fn fetch_session_meta(thread_id: &str) -> Result<Option<SessionMeta>, String> {
    let record = call_engine_op_async(
        "engine.records_get",
        serde_json::json!({ "collection": SESSION_COLLECTION, "key": thread_id }),
    )
    .await?;
    if record.is_null() {
        Ok(None)
    } else {
        session_meta_from_record(&record).map(Some).map_err(|err| err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(thread_id: &str, title: &str, updated_at: f64, deleted: bool) -> JsonValue {
        serde_json::json!({
            "thread_id": thread_id,
            "title": title,
            "created_at": updated_at - 10.0,
            "updated_at": updated_at,
            "message_count": 3,
            "current_leaf": 2i64,
            "rename_count": 0,
            "deleted": deleted,
        })
    }

    #[test]
    fn session_record_roundtrip_mapping() {
        let meta = SessionMeta {
            thread_id: "t-1".to_string(),
            title: "装配机制调研".to_string(),
            created_at: 100.0,
            updated_at: 200.0,
            message_count: 4,
            current_leaf: Some(7),
            rename_count: 1,
            deleted: false,
        };
        let record = session_meta_to_record(&meta);
        let back = session_meta_from_record(&record).expect("回解析成功");
        assert_eq!(back, meta);
        assert!(session_meta_from_record(&serde_json::json!({})).is_err());
    }

    #[test]
    fn session_list_sorts_and_excludes_deleted() {
        let records = vec![
            record("t-1", "旧会话", 100.0, false),
            record("t-2", "新会话", 300.0, false),
            record("t-3", "已删除", 400.0, true),
        ];
        let sessions = list_sessions_meta(&records).expect("列表成功");
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].thread_id, "t-2", "按更新时间倒序");
    }

    #[test]
    fn rename_enforces_twelve_char_limit() {
        let mut meta = new_session("t-1");
        rename_session(&mut meta, "装配机制调研与踩坑记录超长标题").expect("重命名成功");
        assert_eq!(meta.title.chars().count(), SESSION_TITLE_MAX_CHARS);
        assert_eq!(meta.rename_count, 1);
        assert!(rename_session(&mut meta, "   ").is_err());
        let trimmed = normalize_title("  装配机制  ", "");
        assert_eq!(trimmed.as_deref(), Some("装配机制"));
    }

    #[test]
    fn title_generation_requires_two_messages_and_falls_back() {
        let one = [serde_json::json!({"role": "user", "content": "你好"})];
        assert_eq!(title_from_messages(&one, Some("你好呀"), ""), None, "消息不足不触发");
        let two = [
            serde_json::json!({"role": "user", "content": "调研墨引擎"}),
            serde_json::json!({"role": "assistant", "content": "好的"}),
        ];
        let title = title_from_messages(&two, Some("墨引擎调研"), "2026-08-23 12:00")
            .expect("触发标题生成");
        assert_eq!(title, "墨引擎调研");
        let degraded = title_from_messages(&two, None, "2026-08-23 12:00").expect("降级时间戳");
        assert_eq!(degraded, "2026-08-23 12:00");
        let cropped = title_from_messages(&two, Some("这个标题超长超过了十二个字啊"), "fallback")
            .expect("裁剪");
        assert_eq!(cropped.chars().count(), SESSION_TITLE_MAX_CHARS);
    }

    #[test]
    fn branch_tree_maps_multi_leaf_chain() {
        let chain = serde_json::json!([
            {"checkpoint_id": 3, "parent_id": 1, "event_seq": 30, "reason": "reply"},
            {"checkpoint_id": 2, "parent_id": 1, "event_seq": 22, "reason": "reply"},
            {"checkpoint_id": 1, "parent_id": null, "event_seq": 10, "reason": null},
        ]);
        let tree = branch_tree_from_chain_index(chain.as_array().unwrap(), "t-1").expect("树映射成功");
        assert_eq!(tree.session_id, "t-1");
        assert_eq!(tree.current_leaf, Some(3), "当前叶 = 链尾");
        assert_eq!(tree.nodes.len(), 2, "多叶 = 两个无子行（3 与 2）");
        assert!(tree.contains(3));
        assert!(tree.contains(2));
        assert!(!tree.contains(1));
        assert_eq!(tree.parent_of(3), Some(1));
    }

    #[test]
    fn branch_switch_and_revert_semantics() {
        let chain = serde_json::json!([
            {"checkpoint_id": 3, "parent_id": 1, "reason": "reply"},
            {"checkpoint_id": 2, "parent_id": 1, "reason": "reply"},
            {"checkpoint_id": 1, "parent_id": null, "reason": null},
        ]);
        let tree = branch_tree_from_chain_index(chain.as_array().unwrap(), "t-1").unwrap();
        // 叶切换：切回另一叶（原叶 2）
        assert_eq!(switch_leaf(&tree, 2).expect("切回原叶"), 2);
        assert!(switch_leaf(&tree, 99).is_err(), "不存在的叶拒绝");
        // 回退：当前叶 3 → 父叶 1（根叶为回退锚点）
        assert_eq!(revert_leaf(&tree).expect("回退到根叶"), 1);
    }

    #[test]
    fn revert_at_root_leaf_is_rejected() {
        let chain = serde_json::json!([
            {"checkpoint_id": 5, "parent_id": null, "reason": "reply"},
        ]);
        let tree = branch_tree_from_chain_index(chain.as_array().unwrap(), "t-2").unwrap();
        assert!(revert_leaf(&tree).is_err(), "根叶不可回退");
        let empty = branch_tree_from_chain_index(&[], "t-3").unwrap();
        assert!(revert_leaf(&empty).is_err());
    }

    #[test]
    fn op_facades_fail_closed_without_engine() {
        // 无引擎环境：分支动作/会话删除经操作通道失败 = 结构化错误
        // （运行时未装配），不再返回占位文案
        let _serial = crate::engine::host::bridge_guard();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let chain = serde_json::json!([
            {"checkpoint_id": 3, "parent_id": 1, "reason": "reply"},
            {"checkpoint_id": 1, "parent_id": null, "reason": null},
        ]);
        let tree = branch_tree_from_chain_index(chain.as_array().unwrap(), "t-4").unwrap();
        let result = runtime.block_on(branch_action(&tree, "switch", Some(3)));
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("需 op"));
        let deleted = runtime.block_on(delete_session("t-4"));
        assert!(deleted.is_err());
        assert!(!deleted.unwrap_err().contains("需 op"));
        // fork 新叶（追加式接线）：同样结构化失败，不含占位文案
        let forked = runtime.block_on(fork_branch(&tree, 1, serde_json::json!({"note": "x"})));
        assert!(forked.is_err());
        assert!(!forked.unwrap_err().contains("需 op"));
        // 父叶不在树内 = 域侧拒绝（不触碰通道）
        let rejected = runtime.block_on(fork_branch(&tree, 99, serde_json::json!({})));
        assert!(rejected.is_err());
    }

    #[test]
    fn refresh_syncs_current_leaf_from_checkpoint() {
        // R13：刷新时从最新检查点回填 current_leaf（与分支树语义一致）
        let checkpoint = serde_json::json!({
            "checkpoint_id": 9,
            "state": { "messages": [{ "role": "user", "content": "a" }] },
        });
        let mut meta = new_session("t-leaf");
        sync_current_leaf(&mut meta, &Some(checkpoint));
        assert_eq!(meta.current_leaf, Some(9), "刷新应回填当前叶");
        // 无检查点 = 不改写
        let mut kept = SessionMeta { current_leaf: Some(3), ..new_session("t-keep") };
        sync_current_leaf(&mut kept, &None);
        assert_eq!(kept.current_leaf, Some(3), "无检查点保持既有叶");
    }

    #[test]
    fn checkpoint_messages_extract_state_messages() {
        let checkpoint = serde_json::json!({
            "checkpoint_id": 3,
            "state": {
                "messages": [
                    {"role": "user", "content": "调研墨引擎"},
                    {"role": "assistant", "content": "好的"},
                ],
                "reply": "好的",
            },
        });
        let messages = checkpoint_messages(&checkpoint);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "调研墨引擎");
        let bare = checkpoint_messages(&serde_json::json!({}));
        assert!(bare.is_empty(), "缺 state.messages = 空清单");
    }

    #[test]
    fn title_candidate_normalizes_and_truncates() {
        // normalize_title 已收敛：此处验证候选 → ≤12 字 + 空候选降级链路
        let candidate = normalize_title("这个标题超长超过了十二个字啊", "");
        assert_eq!(candidate.unwrap().chars().count(), SESSION_TITLE_MAX_CHARS);
        assert_eq!(normalize_title("  ", ""), None, "空白候选 = None");
        assert_eq!(
            normalize_title("墨引擎调研", "2026-08-23 12:00"),
            Some("墨引擎调研".to_string())
        );
        let messages = checkpoint_messages(&serde_json::json!({
            "state": {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}
        }));
        assert_eq!(
            title_from_messages(&messages, Some("墨引擎调研"), "fallback"),
            Some("墨引擎调研".to_string()),
            "候选命中用候选（fallback 只在候选缺失时生效）"
        );
        // 引擎通道未装配：标题候选 fail-closed（不 stub、不占位）
        let _serial = crate::engine::host::bridge_guard();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let messages = checkpoint_messages(&serde_json::json!({
            "state": {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]}
        }));
        let result = runtime.block_on(title_candidate(&messages));
        assert!(result.is_err(), "router 通道未装配 = 显式报错");
        let refreshed = runtime.block_on(refresh_session_after_round("t-none"));
        assert!(refreshed.is_err(), "回合后刷新未装配 = 显式报错");
    }

    #[test]
    fn new_thread_id_is_unique_and_prefixed() {
        let a = new_thread_id();
        let b = new_thread_id();
        assert!(a.starts_with("thread-"));
        assert_ne!(a, b);
    }

    #[test]
    fn title_messages_carry_system_prompt_and_compressed_context() {
        let messages = vec![
            serde_json::json!({ "role": "user", "content": "帮我调研墨引擎的引用质量校验" }),
            serde_json::json!({ "role": "assistant", "content": "好的，开始调研" }),
            serde_json::json!({ "role": "user", "content": "重点看看取证评分公式" }),
        ];
        let list = title_messages(&messages);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["role"], "system");
        assert!(list[0]["content"].as_str().unwrap().contains("12 字"));
        assert_eq!(list[1]["role"], "user");
        let content = list[1]["content"].as_str().unwrap();
        assert!(content.contains("共 3 条消息"), "条数锚点在压缩面内: {content}");
        assert!(content.contains("调研墨引擎的引用质量校验"), "首条用户消息入压缩面");
        assert!(content.contains("取证评分公式"), "末条用户消息入压缩面");
        assert_eq!(TITLE_CANDIDATE_MAX_CHARS, 12);
        let empty = title_messages(&[]);
        assert_eq!(empty.len(), 2, "空会话也给骨架（降级路径）");
        assert!(empty[1]["content"].as_str().unwrap().contains("开头："));
    }
}

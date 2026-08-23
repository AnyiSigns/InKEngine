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
    let current_leaf = Some(*ids.iter().max().unwrap());
    let mut nodes: Vec<BranchNode> = rows
        .iter()
        .map(|(id, parent, reason)| BranchNode {
            leaf: *id,
            parent: *parent,
            reason: reason.clone(),
        })
        .collect();
    nodes.sort_by(|a, b| b.leaf.cmp(&a.leaf));
    nodes.retain(|node| !parent_ids.contains(&node.leaf) || node.leaf == current_leaf.unwrap());
    Ok(BranchTree {
        session_id: session_id.to_string(),
        nodes,
        current_leaf,
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
}

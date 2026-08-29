//! 回合步骤记录域：引擎事件流 → 步骤序列累积（checkpoint 恢复形态）。
//!
//! 回合（用户消息边界）/ 步骤（step_id）/ 回合步骤序列是历史回放的单一
//! 事实来源：实时事件发射顺序 = 录制顺序 = 回放顺序。累积器维护「当前
//! 回合」的步骤数组，宿主把它写入 checkpoint 通道（中断回合续流）并在
//! 回合完成时快照落库——落库与传输是装配侧职责，本模块纯内存、无副作用。
//!
//! 步骤记录形状：`{"step_id", "type", "payload"}`。step_id 在回合内稳定
//! 唯一（前端渲染 key 与 SSE 配对更新依赖此稳定性）：
//! - thinking/plan/review_card/memory_hit/suggestions/error 按类计数
//!   （`think:1` / `plan:1` / `card:1` ...）；
//! - tool 按 tool_call_id（`tool:<id>`，无 id 回退计数）；
//! - node 按 node_id（`node:<node_id>`；携带进度序号时按
//!   `node:<node_id>:<序号>` 分卡，同 id 的 node_start 复用更新）；
//! - reply_token 按回复段计数（工具卡/审批卡/节点卡出现即切新段）；
//! - user 固定 `user`（回合边界，单条）。
//!
//! 领域中立：节点展示标签由宿主经 `node_labels` 注入，其余语义对各类
//! agent 通用。中止语义（事件弧关断）：`abort_current_round` 只撕当前
//! 回合——收尾 = CANCELLED 快照 + checkpoint 续跑（引擎中止经操作
//! 通道由装配侧接线），本模块只负责事件形态与步骤记录。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value as JsonValue};

/// 工具展示名解析器（tool 名 → 中文展示标题的可注入挂点）。
///
/// 解析规则装配侧注入（工具表快照的四层兜底标签解析）；本模块只消费
/// 挂点，不持有工具表——步骤记录对工具行的展示语义零耦合。
pub type ToolTitleResolver = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// step_id 长度上限：超长 node_id / tool_call_id 会撑爆存储行与前端
/// 渲染 key，统一在追加时截断（回合内唯一性由前缀 + 计数/调用 id 保证）。
const STEP_ID_MAX_CHARS: usize = 200;

/// 按类计数的步骤类型：step_id = <前缀>:<该类序号>，从种子恢复时需重建计数。
const COUNTED_KINDS: [&str; 6] = [
    "thinking",
    "plan",
    "review_card",
    "memory_hit",
    "suggestions",
    "error",
];

/// 回复段落计数键（reply_token 步骤共用一个计数器，与步骤 type 名不同）。
const REPLY_COUNT_KEY: &str = "reply";

/// memory_hit 可挂载的宿主卡类型（就近附着到最近一张思考/规划卡）。
const MEMORY_ATTACH_KINDS: [&str; 2] = ["plan", "thinking"];

/// 步骤记录（step_id/type/payload 三元组，JSON 值形态便于快照直出）。
type StepRecord = JsonValue;

/// 回合步骤累积器（纯内存，无副作用，可单测）。
///
/// 从 checkpoint 种子（seed）恢复中断回合：计数由已有步骤反推，保证
/// 续流回合的 step_id 与中断前连续（前端按 step_id 增量更新既有卡片）。
#[derive(Debug, Clone)]
pub struct RoundSteps {
    node_labels: BTreeMap<String, String>,
    steps: Vec<StepRecord>,
    index: HashMap<String, usize>,
    counts: BTreeMap<String, usize>,
    reply_open: bool,
}

impl RoundSteps {
    /// 新建累积器（seed = 中断回合已有步骤；node_labels = 节点展示标签
    /// 覆盖表，命中即以表内标签替代调用方传入的 label）。
    pub fn new(
        _round_id: &str,
        seed: Option<Vec<JsonValue>>,
        node_labels: Option<BTreeMap<String, String>>,
    ) -> Self {
        let mut steps: Vec<StepRecord> = Vec::new();
        for raw in seed.unwrap_or_default() {
            let Some(obj) = raw.as_object() else { continue };
            let mut record = obj.clone();
            let payload = record
                .get("payload")
                .and_then(JsonValue::as_object)
                .cloned()
                .unwrap_or_default();
            record.insert("payload".into(), JsonValue::Object(payload));
            steps.push(JsonValue::Object(record));
        }
        let mut index = HashMap::new();
        for (pos, step) in steps.iter().enumerate() {
            if let Some(id) = step.get("step_id").and_then(JsonValue::as_str) {
                index.insert(id.to_string(), pos);
            }
        }
        let mut acc = Self {
            node_labels: node_labels.unwrap_or_default(),
            steps,
            index,
            counts: BTreeMap::new(),
            reply_open: false,
        };
        acc.restore_counts();
        acc
    }

    /// 从种子步骤反推各类计数（续流 step_id 与中断前连续，不重号）。
    ///
    /// node 步骤的 step_id 由 node_id（可含序号）决定，不占计数。tool
    /// 步骤只在「无 tool_call_id 回退计数」形态（`tool:<纯数字>`）时占
    /// 计数——带 id 的工具卡由 tool_call_id 保证唯一。计数取序号最大值
    /// 而非条数：中断回合里两种形态可能混存，按最大值续号才不会与种子
    /// 内已有 `tool:<n>` 撞号。
    fn restore_counts(&mut self) {
        let snapshots: Vec<(String, String)> = self
            .steps
            .iter()
            .filter_map(|step| {
                let kind = step.get("type").and_then(JsonValue::as_str)?;
                let step_id = step.get("step_id").and_then(JsonValue::as_str)?;
                Some((kind.to_string(), step_id.to_string()))
            })
            .collect();
        for (kind, step_id) in snapshots {
            if COUNTED_KINDS.contains(&kind.as_str()) {
                *self.counts.entry(kind).or_default() += 1;
            } else if kind == "tool" {
                if let Some(suffix) = step_id.strip_prefix("tool:") {
                    if suffix.chars().all(|c| c.is_ascii_digit()) {
                        let value = suffix.parse::<usize>().unwrap_or(0);
                        let entry = self.counts.entry("tool".to_string()).or_default();
                        *entry = (*entry).max(value);
                    }
                }
            } else if kind == "reply_token" {
                *self.counts.entry(REPLY_COUNT_KEY.to_string()).or_default() += 1;
                self.reply_open = true;
            }
        }
    }

    /// 当前回合步骤序列（快照/回放形态）。
    pub fn steps(&self) -> Vec<JsonValue> {
        self.steps.clone()
    }

    /// 最近一个步骤（无步骤 = None）。
    pub fn last_step(&self) -> Option<JsonValue> {
        self.steps.last().cloned()
    }

    /// 最近一个步骤的 step_id（无步骤 = 空串）。
    pub fn last_step_id(&self) -> String {
        self.last_step()
            .and_then(|s| s.get("step_id").and_then(JsonValue::as_str).map(str::to_string))
            .unwrap_or_default()
    }

    // ── 内部原语 ──

    fn next_count(&mut self, kind: &str) -> String {
        let entry = self.counts.entry(kind.to_string()).or_default();
        *entry += 1;
        entry.to_string()
    }

    /// 追加步骤并返回其**最终** step_id（截断后的值）。
    ///
    /// 同 step_id 复用：同一 id 再次出现（如 tool:A 结束后重发同
    /// tool_call_id、条件边回路二次进入同名节点）时更新既有记录而非
    /// 追加重复卡，保证回放/前端 key 唯一、配对操作命中同一张卡。
    fn append(&mut self, step_type: &str, step_id: &str, payload: JsonValue) -> String {
        let final_id = truncate_id(step_id);
        if let Some(&pos) = self.index.get(&final_id) {
            let record = &mut self.steps[pos];
            let merged = merge_payload(record, payload);
            *record = merged;
            return final_id;
        }
        let record = json!({
            "step_id": final_id,
            "type": step_type,
            "payload": payload,
        });
        self.index.insert(final_id.clone(), self.steps.len());
        self.steps.push(record);
        final_id
    }

    /// 移除最后一个步骤并同步索引（空思考/空规划卡丢弃用）。
    fn pop_last(&mut self) -> Option<String> {
        let record = self.steps.pop()?;
        if let Some(id) = record.get("step_id").and_then(JsonValue::as_str) {
            self.index.remove(id);
            return Some(id.to_string());
        }
        None
    }

    /// 按 step_id 更新既有记录 payload（浅合并，新值覆盖旧值）。
    fn update(&mut self, step_id: &str, patch: JsonValue) {
        if let Some(&pos) = self.index.get(step_id) {
            let merged = merge_payload(&self.steps[pos], patch);
            self.steps[pos] = merged;
        }
    }

    /// 按 step_id 取 payload（未命中 = 空对象）。
    fn step_payload(&self, step_id: &str) -> JsonValue {
        self.index
            .get(step_id)
            .and_then(|&pos| self.steps[pos].get("payload").cloned())
            .filter(|v| v.is_object())
            .unwrap_or_else(|| json!({}))
    }

    /// 最近一个指定类型的步骤的数组下标（低频路径：回合边界/工具卡/
    /// 节点卡复用判定）。
    fn last_by_type(&self, step_type: &str) -> Option<usize> {
        self.steps.iter().rposition(|step| {
            step.get("type").and_then(JsonValue::as_str) == Some(step_type)
        })
    }

    /// 关闭当前回复段：后续 reply_token 另起新段。
    fn close_reply(&mut self) {
        self.reply_open = false;
    }

    /// 流式文本卡（思考/规划）收尾：内容非空置 completed，空卡丢弃。
    ///
    /// 空卡不残留（与前端空卡自动移除一致，回放不渲染空卡）；仅当末步
    /// 就是该类卡时生效——中途插入其它步骤即视为已收尾，返回 ""。
    fn end_streaming_card(&mut self, step_type: &str) -> String {
        let is_last = self
            .steps
            .last()
            .map(|s| s.get("type").and_then(JsonValue::as_str) == Some(step_type))
            .unwrap_or(false);
        if !is_last {
            return String::new();
        }
        let step_id = self
            .steps
            .last()
            .and_then(|s| s.get("step_id").and_then(JsonValue::as_str))
            .unwrap_or_default()
            .to_string();
        let content = self
            .steps
            .last()
            .and_then(|s| s.get("payload"))
            .and_then(|p| p.get("content"))
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        if content.trim().is_empty() {
            self.pop_last();
            return step_id;
        }
        if let Some(pos) = self.index.get(&step_id) {
            let merged = merge_payload(&self.steps[*pos], json!({ "status": "completed" }));
            self.steps[*pos] = merged;
        }
        step_id
    }

    /// 节点 step_id：带序号即分卡（批量任务每项一卡），否则同 id 复用。
    fn node_step_id(node_id: &str, index: usize) -> String {
        let step_id = if index > 0 {
            format!("node:{node_id}:{index}")
        } else {
            format!("node:{node_id}")
        };
        truncate_id(&step_id)
    }

    /// 批量进度内嵌（第 n/total 项）；缺任一维度即无进度。
    fn progress_from(extra: &JsonValue) -> Option<JsonValue> {
        let index = extra.get("chapter_index").and_then(JsonValue::as_u64).unwrap_or(0);
        let total = extra.get("chapter_total").and_then(JsonValue::as_u64).unwrap_or(0);
        if total > 0 && index > 0 {
            return Some(json!({ "step": "write", "n": index, "total": total }));
        }
        None
    }

    // ── 回合边界 ──

    /// 回合边界用户消息步骤（幂等：已存在则不重复记录）。
    pub fn user(&mut self, content: &str) -> String {
        if let Some(pos) = self.last_by_type("user") {
            return self.steps[pos]
                .get("step_id")
                .and_then(JsonValue::as_str)
                .unwrap_or("user")
                .to_string();
        }
        self.close_reply();
        self.append("user", "user", json!({ "content": content }))
    }

    // ── 回复流 ──

    /// 回复流累积：当前段追加；无打开段时新建 reply 步骤。
    pub fn reply_token(&mut self, token: &str) -> String {
        let open = self.reply_open
            && self
                .steps
                .last()
                .map(|s| s.get("type").and_then(JsonValue::as_str) == Some("reply_token"))
                .unwrap_or(false);
        if open {
            let pos = self.steps.len() - 1;
            let content = self.steps[pos]
                .get("payload")
                .and_then(|p| p.get("content"))
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            let merged = merge_payload(&self.steps[pos], json!({ "content": content + token }));
            self.steps[pos] = merged;
            return self.steps[pos]
                .get("step_id")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string();
        }
        let step_id = format!("reply:{}", self.next_count(REPLY_COUNT_KEY));
        self.append("reply_token", &step_id, json!({ "content": token }));
        self.reply_open = true;
        step_id
    }

    // ── 思考卡 / 规划卡 ──

    pub fn thinking_start(&mut self) -> String {
        self.close_reply();
        let step_id = format!("think:{}", self.next_count("thinking"));
        self.append(
            "thinking",
            &step_id,
            json!({ "status": "running", "content": "" }),
        )
    }

    pub fn thinking_token(&mut self, token: &str) {
        let is_last = self
            .steps
            .last()
            .map(|s| s.get("type").and_then(JsonValue::as_str) == Some("thinking"))
            .unwrap_or(false);
        if is_last {
            let pos = self.steps.len() - 1;
            let content = self.steps[pos]
                .get("payload")
                .and_then(|p| p.get("content"))
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            let merged = merge_payload(&self.steps[pos], json!({ "content": content + token }));
            self.steps[pos] = merged;
        }
    }

    /// 思考卡收尾（空思考被丢弃时仍返回其原 step_id，供事件层携带）。
    pub fn thinking_end(&mut self) -> String {
        self.end_streaming_card("thinking")
    }

    pub fn plan_start(&mut self) -> String {
        self.close_reply();
        let step_id = format!("plan:{}", self.next_count("plan"));
        self.append("plan", &step_id, json!({ "status": "running", "content": "" }))
    }

    pub fn plan_token(&mut self, token: &str) {
        let is_last = self
            .steps
            .last()
            .map(|s| s.get("type").and_then(JsonValue::as_str) == Some("plan"))
            .unwrap_or(false);
        if is_last {
            let pos = self.steps.len() - 1;
            let content = self.steps[pos]
                .get("payload")
                .and_then(|p| p.get("content"))
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .to_string();
            let merged = merge_payload(&self.steps[pos], json!({ "content": content + token }));
            self.steps[pos] = merged;
        }
    }

    /// 规划卡收尾（与 thinking_end 同语义：空规划返回原 step_id）。
    pub fn plan_end(&mut self) -> String {
        self.end_streaming_card("plan")
    }

    // ── 记忆命中（挂所属步骤） ──

    /// 记忆命中：挂到最近一张规划/思考卡，否则独立 memory 步骤。
    ///
    /// 同 id 命中幂等（重复注入不重复挂载），返回承载步骤的 step_id。
    pub fn memory_hit(&mut self, hits: Vec<JsonValue>) -> String {
        let attach_pos = self
            .steps
            .iter()
            .rposition(|step| {
                step.get("type")
                    .and_then(JsonValue::as_str)
                    .map(|t| MEMORY_ATTACH_KINDS.contains(&t))
                    .unwrap_or(false)
            });
        let Some(pos) = attach_pos else {
            let step_id = format!("memory:{}", self.next_count("memory_hit"));
            return self.append(
                "memory_hit",
                &step_id,
                json!({ "hits": hits, "attach_step_id": "" }),
            );
        };
        let attach_id = self.steps[pos]
            .get("step_id")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        let memories = self.steps[pos]
            .get("payload")
            .and_then(|p| p.get("memories"))
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let mut known: Vec<String> = memories
            .iter()
            .filter_map(|m| m.get("id").and_then(JsonValue::as_str).map(str::to_string))
            .collect();
        let mut merged = memories;
        for hit in hits {
            let id = hit.get("id").and_then(JsonValue::as_str).map(str::to_string);
            match id {
                Some(id) if known.contains(&id) => {}
                Some(id) => {
                    known.push(id);
                    merged.push(hit);
                }
                None => merged.push(hit),
            }
        }
        let payload_merge = merge_payload(&self.steps[pos], json!({ "memories": merged }));
        self.steps[pos] = payload_merge;
        attach_id
    }

    // ── 工具卡 ──

    /// 工具卡开始。同 tool_call_id 复用既有卡并复位 running（审批
    /// resume 重发同一工具调用时不产生重复卡）。
    ///
    /// `title` = 工具展示名（经可注入解析器解析的标题；None = 不落
    /// title 字段，展示层按既有兜底链渲染）。
    pub fn tool_start(&mut self, category: &str, tool_call_id: &str, title: Option<&str>) -> String {
        self.close_reply();
        if !tool_call_id.is_empty() {
            if let Some(pos) = self.last_by_type("tool") {
                let same_call = self.steps[pos]
                    .get("payload")
                    .and_then(|p| p.get("tool_call_id"))
                    .and_then(JsonValue::as_str)
                    == Some(tool_call_id);
                if same_call {
                    let mut patch = json!({
                        "category": category,
                        "status": "running",
                        "success": null,
                    });
                    if let Some(title) = title {
                        patch["title"] = json!(title);
                    }
                    let merged = merge_payload(&self.steps[pos], patch);
                    self.steps[pos] = merged;
                    return self.steps[pos]
                        .get("step_id")
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
            }
            let step_id = format!("tool:{tool_call_id}");
            let mut payload = json!({
                "category": category,
                "tool_call_id": tool_call_id,
                "status": "running",
            });
            if let Some(title) = title {
                payload["title"] = json!(title);
            }
            return self.append("tool", &step_id, payload);
        }
        let step_id = format!("tool:{}", self.next_count("tool"));
        let mut payload = json!({
            "category": category,
            "tool_call_id": "",
            "status": "running",
        });
        if let Some(title) = title {
            payload["title"] = json!(title);
        }
        self.append("tool", &step_id, payload)
    }

    /// 工具卡收尾。返回命中的 step_id（供事件层配对更新），未命中返回 ""。
    pub fn tool_end(&mut self, tool_call_id: &str, success: bool) -> String {
        let status = if success { "done" } else { "error" };
        if !tool_call_id.is_empty() {
            for pos in (0..self.steps.len()).rev() {
                let is_tool = self.steps[pos]
                    .get("type")
                    .and_then(JsonValue::as_str)
                    == Some("tool");
                let same_call = self.steps[pos]
                    .get("payload")
                    .and_then(|p| p.get("tool_call_id"))
                    .and_then(JsonValue::as_str)
                    == Some(tool_call_id);
                if is_tool && same_call {
                    let merged = merge_payload(
                        &self.steps[pos],
                        json!({ "status": status, "success": success }),
                    );
                    self.steps[pos] = merged;
                    return self.steps[pos]
                        .get("step_id")
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_string();
                }
            }
            return String::new();
        }
        // 无 tool_call_id：只认末步工具卡（无从配对更早的卡）
        if let Some(pos) = self.last_by_type("tool") {
            let merged =
                merge_payload(&self.steps[pos], json!({ "status": status, "success": success }));
            self.steps[pos] = merged;
            return self.steps[pos]
                .get("step_id")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string();
        }
        String::new()
    }

    /// 审批卡到达：把匹配的写工具卡置 pending（等待审批）。返回命中的 step_id。
    pub fn tool_pending(&mut self, tool_call_id: &str) -> String {
        for pos in (0..self.steps.len()).rev() {
            let is_tool = self.steps[pos]
                .get("type")
                .and_then(JsonValue::as_str)
                == Some("tool");
            let same_call = self.steps[pos]
                .get("payload")
                .and_then(|p| p.get("tool_call_id"))
                .and_then(JsonValue::as_str)
                == Some(tool_call_id);
            if is_tool && same_call {
                let merged = merge_payload(&self.steps[pos], json!({ "status": "pending" }));
                self.steps[pos] = merged;
                return self.steps[pos]
                    .get("step_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
        String::new()
    }

    // ── 节点卡 ──

    /// 节点卡开始。extra 携带进度序号（chapter_index/chapter_total）时
    /// 按序号分卡并内嵌进度。
    ///
    /// 同 step_id 复用时只刷新状态/进度，保留首次标签——节点内部多环节
    /// 各自 start 不覆盖对外展示名。
    pub fn node_start(&mut self, node_id: &str, label: &str, extra: JsonValue) -> String {
        self.close_reply();
        let chapter_index = extra
            .get("chapter_index")
            .and_then(JsonValue::as_u64)
            .unwrap_or(0) as usize;
        let step_id = Self::node_step_id(node_id, chapter_index);
        let progress = Self::progress_from(&extra);
        if let Some(pos) = self.last_by_type("node") {
            let same_id = self.steps[pos]
                .get("step_id")
                .and_then(JsonValue::as_str)
                == Some(step_id.as_str());
            if same_id {
                let mut patch = json!({ "status": "running" });
                if let Some(progress) = progress {
                    patch["progress"] = progress;
                }
                let merged = merge_payload(&self.steps[pos], patch);
                self.steps[pos] = merged;
                return self.steps[pos]
                    .get("step_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
        let display_label = self
            .node_labels
            .get(node_id)
            .filter(|label| !label.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if label.is_empty() {
                    node_id.to_string()
                } else {
                    label.to_string()
                }
            });
        let mut payload = json!({
            "node_id": node_id,
            "label": display_label,
            "status": "running",
        });
        if let Some(progress) = progress {
            payload["progress"] = progress;
        }
        self.append("node", &step_id, payload)
    }

    /// 节点卡流式内容追加（按 node_id + 序号定位既有卡）。
    pub fn node_stream(&mut self, node_id: &str, index: usize, token: &str) -> String {
        let step_id = Self::node_step_id(node_id, index);
        let payload = self.step_payload(&step_id);
        let content = payload.get("content").and_then(JsonValue::as_str).unwrap_or("");
        let merged = json!({ "content": content.to_string() + token });
        self.update(&step_id, merged);
        step_id
    }

    /// 节点卡收尾（completed + 可选 token 数）。
    pub fn node_end(&mut self, node_id: &str, index: usize, tokens: Option<i64>) -> String {
        let step_id = Self::node_step_id(node_id, index);
        let mut patch = json!({ "status": "completed" });
        if let Some(tokens) = tokens {
            patch["tokens"] = json!(tokens);
        }
        self.update(&step_id, patch);
        step_id
    }

    /// 节点卡失败（failed + 原因）。
    pub fn node_fail(&mut self, node_id: &str, index: usize, reason: &str) -> String {
        let step_id = Self::node_step_id(node_id, index);
        self.update(&step_id, json!({ "status": "failed", "reason": reason }));
        step_id
    }

    // ── 子任务卡（spawn_start / spawn_end）──

    /// 子任务卡开始。step_id = `spawn:<node_id>`（同 id 复用，与节点卡同口径）。
    pub fn spawn_start(&mut self, node_id: &str, label: &str, extra: JsonValue) -> String {
        self.close_reply();
        let step_id = format!("spawn:{node_id}");
        if let Some(pos) = self.last_by_type("spawn") {
            let same_id = self.steps[pos]
                .get("step_id")
                .and_then(JsonValue::as_str)
                == Some(step_id.as_str());
            if same_id {
                let mut patch = json!({ "status": "running" });
                if !label.is_empty() {
                    patch["label"] = json!(label);
                }
                let merged = merge_payload(&self.steps[pos], patch);
                self.steps[pos] = merged;
                return self.steps[pos]
                    .get("step_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string();
            }
        }
        let display_label = self
            .node_labels
            .get(node_id)
            .filter(|label| !label.is_empty())
            .cloned()
            .unwrap_or_else(|| {
                if label.is_empty() {
                    node_id.to_string()
                } else {
                    label.to_string()
                }
            });
        let mut payload = json!({
            "node_id": node_id,
            "label": display_label,
            "status": "running",
        });
        if let Some(spawns) = extra.get("spawns") {
            payload["spawns"] = spawns.clone();
        }
        self.append("spawn", &step_id, payload)
    }

    /// 子任务卡收尾（completed）。
    pub fn spawn_end(&mut self, node_id: &str) -> String {
        let step_id = format!("spawn:{node_id}");
        self.update(&step_id, json!({ "status": "completed" }));
        step_id
    }

    // ── 审批卡 ──

    /// 审批卡步骤。payload 携带 tool_call_id 时连带把该工具卡置 pending。
    pub fn review_card(&mut self, payload: JsonValue) -> String {
        self.close_reply();
        let step_id = format!("card:{}", self.next_count("review_card"));
        let appended = self.append("review_card", &step_id, json!({ "payload": payload.clone() }));
        if let Some(call_id) = payload.get("tool_call_id").and_then(JsonValue::as_str) {
            self.tool_pending(call_id);
        }
        appended
    }

    // ── 建议 / 错误 ──

    pub fn suggestions(&mut self, items: Vec<JsonValue>) -> String {
        let step_id = format!("suggestions:{}", self.next_count("suggestions"));
        self.append("suggestions", &step_id, json!({ "items": items }))
    }

    pub fn error(&mut self, content: &str) -> String {
        let step_id = format!("error:{}", self.next_count("error"));
        self.append("error", &step_id, json!({ "content": content }))
    }
}

/// step_id 截断（超长 node_id/tool_call_id 收敛，回合内唯一性由前缀保证）。
fn truncate_id(step_id: &str) -> String {
    step_id.chars().take(STEP_ID_MAX_CHARS).collect()
}

/// payload 浅合并（新值覆盖旧值；旧 payload 保底为空对象）。
fn merge_payload(record: &JsonValue, patch: JsonValue) -> JsonValue {
    let mut payload = record
        .get("payload")
        .and_then(JsonValue::as_object)
        .cloned()
        .unwrap_or_default();
    if let JsonValue::Object(patch) = patch {
        for (key, value) in patch {
            payload.insert(key, value);
        }
    }
    let mut record = record.clone();
    if let JsonValue::Object(map) = &mut record {
        map.insert("payload".into(), JsonValue::Object(payload));
    }
    record
}

/// 回合中止信号（宿主回合驱动与步骤记录层共享的原子握手）。
///
/// 中止 = 当前回合的「撕票」：前端停止按钮 → 信号置位（停止接收新
/// 步骤/新事件）+ 引擎侧在途 run 取消（经操作通道）；信号跨回合复用
/// （换新回合时重置），中止的回合边界对后续回合零影响。
#[derive(Debug, Default, Clone)]
pub struct RoundAbortSignal {
    aborted: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
}

impl RoundAbortSignal {
    /// 新建信号（未中止态）。
    pub fn new() -> Self {
        Self::default()
    }

    /// 中止当前回合（置位 + 回合闸门自增）。
    pub fn abort(&self) {
        self.aborted.store(true, Ordering::SeqCst);
        self.epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// 是否处于中止态。
    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::SeqCst)
    }

    /// 新回合边界（清中止态；epoch 单调不减）。
    pub fn begin_round(&self) {
        self.aborted.store(false, Ordering::SeqCst);
    }

    /// 当前回合闸门（中止次数的单调计数；供诊断/审计）。
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
}

/// 回合步骤传输：引擎事件流 → 步骤序列（回合记录器；种子由 checkpoint 提供）。
///
/// 事件类型未命中 = 不记录；累积异常零噪声（记录失败不影响主流程，
/// 观测不影响执行）。
#[derive(Clone)]
pub struct RoundStepsTransport {
    round_id: String,
    steps: RoundSteps,
    /// 事件弧关断标记：中止后本传输不再累积新步骤（后续事件透传不记录）。
    aborted: bool,
    /// 工具展示名解析挂点（tool_start 载荷的 title 字段来源）。
    title_source: Option<ToolTitleResolver>,
    /// 回合中止信号（与宿主回合驱动共享；None = 无信号握手）。
    abort_signal: Option<RoundAbortSignal>,
}

impl std::fmt::Debug for RoundStepsTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoundStepsTransport")
            .field("round_id", &self.round_id)
            .field("aborted", &self.aborted)
            .field("title_source", &self.title_source.is_some())
            .field("abort_signal", &self.abort_signal)
            .finish_non_exhaustive()
    }
}

impl RoundStepsTransport {
    /// 新建传输（seed = 中断回合已有步骤；node_labels = 节点标签覆盖表）。
    pub fn new(
        round_id: &str,
        seed: Option<Vec<JsonValue>>,
        node_labels: Option<BTreeMap<String, String>>,
    ) -> Self {
        Self::with_engine_handles(round_id, seed, node_labels, None, None)
    }

    /// 新建传输并装配引擎互动挂件（title 解析挂点 + 回合中止信号）。
    ///
    /// `title_source` = 工具展示名解析器（None = 不落 title 字段）；
    /// `abort_signal` = 中止信号（None = 仅本地事件弧，不握手）。
    pub fn with_engine_handles(
        round_id: &str,
        seed: Option<Vec<JsonValue>>,
        node_labels: Option<BTreeMap<String, String>>,
        title_source: Option<ToolTitleResolver>,
        abort_signal: Option<RoundAbortSignal>,
    ) -> Self {
        Self {
            round_id: round_id.to_string(),
            steps: RoundSteps::new(round_id, seed, node_labels),
            aborted: false,
            title_source,
            abort_signal,
        }
    }

    /// 新回合边界（换累积器；旧回合快照由消费方先行落库）。
    pub fn begin_round(&mut self, round_id: &str) {
        self.round_id = round_id.to_string();
        self.steps = RoundSteps::new(round_id, None, None);
        self.aborted = false;
        if let Some(signal) = &self.abort_signal {
            signal.begin_round();
        }
    }

    /// 当前回合步骤序列（checkpoint/回放形态的边界快照）。
    pub fn snapshot(&self) -> Vec<JsonValue> {
        self.steps.steps()
    }

    /// 当前回合 id（中止通知/恢复锚点引用）。
    pub fn round_id(&self) -> &str {
        &self.round_id
    }

    /// 是否处于事件弧关断（中止）状态。
    pub fn is_aborted(&self) -> bool {
        self.aborted
    }

    /// 中止当前回合（事件弧关断语义，只撕当前回合）。
    ///
    /// 只做本记录层形态：关闭事件弧（后续事件不再累积进步骤序列），
    /// 供前端停止按钮即时反馈；引擎中止（取消在途 run → CANCELLED
    /// 快照 → checkpoint 续跑）经操作通道由装配侧接线调用。
    /// 本操作只置位原子标记，无可失败路径——直接返回 `()`（R14：
    /// 删除恒 `Ok(())` 的摆设错误类型）。
    pub fn abort_current_round(&mut self) {
        self.aborted = true;
        if let Some(signal) = &self.abort_signal {
            signal.abort();
        }
    }

    /// 当前回合中止信号（中止通知/恢复锚点引用；无信号 = None）。
    pub fn abort_signal(&self) -> Option<&RoundAbortSignal> {
        self.abort_signal.as_ref()
    }

    /// 协议事件 → 步骤累积（事件类型未命中 = 不记录）。
    ///
    /// 中止状态下事件透传不累积；解析异常零噪声跳过（观测不影响执行）。
    ///
    /// R7：除本地事件弧外，同时轮询共享中止信号——`round_abort` 置位的
    /// 是 slot 克隆的 `aborted` 标记（本记录器另一克隆不感知），共享
    /// `abort_signal` 才是跨克隆唯一真源；本地 feed 循环 / 事件发射回调
    /// 均经此处感知中止，中止后事件一律不再累积。
    pub fn feed(&mut self, event: &JsonValue) {
        if self.aborted {
            return;
        }
        if let Some(signal) = &self.abort_signal {
            if signal.is_aborted() {
                return;
            }
        }
        let Some(etype) = event.get("type").and_then(JsonValue::as_str) else {
            return;
        };
        let payload = event.get("payload").filter(|v| v.is_object());
        let Some(payload) = payload else {
            return;
        };
        let source = payload
            .get("tool")
            .or_else(|| payload.get("name"))
            .or_else(|| payload.get("node"))
            .or_else(|| event.get("node"))
            .and_then(JsonValue::as_str)
            .unwrap_or("");
        match etype {
            "user" => {
                let content = payload.get("content").and_then(JsonValue::as_str).unwrap_or("");
                self.steps.user(content);
            }
            "thinking_start" => {
                self.steps.thinking_start();
            }
            "thinking_token" => {
                let token = payload.get("token").and_then(JsonValue::as_str).unwrap_or("");
                self.steps.thinking_token(token);
            }
            "thinking_end" => {
                self.steps.thinking_end();
            }
            "plan_start" => {
                self.steps.plan_start();
            }
            "plan_token" => {
                let token = payload.get("token").and_then(JsonValue::as_str).unwrap_or("");
                self.steps.plan_token(token);
            }
            "plan_end" => {
                self.steps.plan_end();
            }
            "tool_start" => {
                let call_id = payload
                    .get("tool_call_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                let title = self
                    .title_source
                    .as_ref()
                    .and_then(|resolver| resolver(source))
                    .or_else(|| {
                        payload
                            .get("title")
                            .and_then(JsonValue::as_str)
                            .filter(|t| !t.trim().is_empty())
                            .map(str::to_string)
                    });
                self.steps.tool_start(source, call_id, title.as_deref());
            }
            "tool_end" => {
                let call_id = payload
                    .get("tool_call_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                let success = match payload.get("success") {
                    None => true,
                    Some(JsonValue::Bool(value)) => *value,
                    Some(_) => false,
                };
                self.steps.tool_end(call_id, success);
            }
            "tool_pending" => {
                let call_id = payload
                    .get("tool_call_id")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                self.steps.tool_pending(call_id);
            }
            "review_card" => {
                self.steps.review_card(payload.clone());
            }
            "reply_token" => {
                let token = payload
                    .get("token")
                    .or_else(|| payload.get("content"))
                    .and_then(JsonValue::as_str)
                    .unwrap_or("");
                self.steps.reply_token(token);
            }
            "memory_hit" => {
                let hits = match payload.get("hits") {
                    Some(JsonValue::Array(list)) => list.clone(),
                    Some(item) => vec![item.clone()],
                    None => Vec::new(),
                };
                self.steps.memory_hit(hits);
            }
            "node_start" => {
                let label = payload.get("label").and_then(JsonValue::as_str).unwrap_or(source);
                let extra = payload
                    .get("extra")
                    .cloned()
                    .filter(|v| v.is_object())
                    .unwrap_or_else(|| json!({}));
                self.steps.node_start(source, label, extra);
            }
            "node_stream" => {
                let index = payload
                    .get("index")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0) as usize;
                let token = payload.get("token").and_then(JsonValue::as_str).unwrap_or("");
                self.steps.node_stream(source, index, token);
            }
            "node_end" => {
                let index = payload
                    .get("index")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0) as usize;
                let tokens = payload.get("tokens").and_then(JsonValue::as_i64);
                self.steps.node_end(source, index, tokens);
            }
            "node_fail" => {
                let index = payload
                    .get("index")
                    .and_then(JsonValue::as_u64)
                    .unwrap_or(0) as usize;
                let reason = payload
                    .get("reason")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("节点失败");
                self.steps.node_fail(source, index, reason);
            }
            "spawn_start" => {
                let node_id = payload.get("node_id").and_then(JsonValue::as_str).unwrap_or(source);
                let label = payload.get("label").and_then(JsonValue::as_str).unwrap_or(node_id);
                self.steps.spawn_start(node_id, label, payload.clone());
            }
            "spawn_end" => {
                let node_id = payload.get("node_id").and_then(JsonValue::as_str).unwrap_or(source);
                self.steps.spawn_end(node_id);
            }
            "suggestions" => {
                let items = match payload.get("items") {
                    Some(JsonValue::Array(list)) => list.clone(),
                    Some(item) => vec![item.clone()],
                    None => Vec::new(),
                };
                self.steps.suggestions(items);
            }
            "error" => {
                let content = payload
                    .get("content")
                    .or_else(|| payload.get("message"))
                    .and_then(JsonValue::as_str)
                    .unwrap_or("错误");
                self.steps.error(content);
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(etype: &str, payload: JsonValue) -> JsonValue {
        json!({ "type": etype, "payload": payload })
    }

    fn by_type<'a>(steps: &'a [JsonValue], kind: &str) -> Vec<&'a JsonValue> {
        steps
            .iter()
            .filter(|s| s.get("type").and_then(JsonValue::as_str) == Some(kind))
            .collect()
    }

    #[test]
    fn transport_accumulates_protocol() {
        let mut recorder = RoundStepsTransport::new("round-1", None, None);
        recorder.feed(&event("user", json!({ "content": "研究墨引擎" })));
        recorder.feed(&event("user", json!({ "content": "研究墨引擎" }))); // 幂等
        recorder.feed(&event("thinking_start", json!({})));
        recorder.feed(&event("thinking_token", json!({ "token": "先检索" })));
        recorder.feed(&event("thinking_token", json!({ "token": "再蒸馏" })));
        recorder.feed(&event("thinking_end", json!({})));
        recorder.feed(&event("plan_start", json!({})));
        recorder.feed(&event("plan_end", json!({}))); // 空规划卡丢弃
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "collect_material", "tool_call_id": "tc-1" }),
        ));
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "collect_material", "tool_call_id": "tc-1" }),
        )); // 复用卡
        recorder.feed(&event("tool_end", json!({ "tool_call_id": "tc-1", "success": true })));
        recorder.feed(&event(
            "review_card",
            json!({ "tool_call_id": "tc-2", "review_type": "gate", "node_id": "x", "node_label": "审批" }),
        ));
        recorder.feed(&event("error", json!({ "content": "失败留痕" })));

        let steps = recorder.snapshot();
        let types: Vec<&str> = steps
            .iter()
            .map(|s| s["type"].as_str().unwrap())
            .collect();
        assert_eq!(types, vec!["user", "thinking", "tool", "review_card", "error"]);
        assert_eq!(by_type(&steps, "user").len(), 1, "user 幂等：回合边界单条");
        assert!(!types.contains(&"plan"), "空规划卡被丢弃");

        let thinking = &steps[1];
        assert_eq!(thinking["payload"]["content"], "先检索再蒸馏");
        assert_eq!(thinking["payload"]["status"], "completed");

        let tool = &steps[2];
        assert_eq!(tool["payload"]["status"], "done");
        assert_eq!(tool["payload"]["tool_call_id"], "tc-1");
        assert_eq!(tool["step_id"], "tool:tc-1");
        assert_eq!(steps[3]["step_id"], "card:1");
        assert_eq!(steps[4]["step_id"], "error:1");
    }

    #[test]
    fn transport_seed_restore_continues_ids() {
        let seed = vec![
            json!({ "step_id": "user", "type": "user", "payload": { "content": "上一轮" } }),
            json!({ "step_id": "think:1", "type": "thinking", "payload": { "status": "completed", "content": "既有思考" } }),
            json!({ "step_id": "card:1", "type": "review_card", "payload": { "payload": { "review_type": "gate" } } }),
        ];
        let mut recorder = RoundStepsTransport::new("round-2", Some(seed), None);
        recorder.feed(&event("thinking_start", json!({})));
        recorder.feed(&event("thinking_token", json!({ "token": "续流" })));
        recorder.feed(&event("thinking_end", json!({})));
        recorder.feed(&event("tool_start", json!({ "tool": "search", "tool_call_id": "" })));
        let snapshot = recorder.snapshot();
        let ids: Vec<&str> = snapshot
            .iter()
            .map(|s| s["step_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["user", "think:1", "card:1", "think:2", "tool:1"]);
        recorder.feed(&event(
            "review_card",
            json!({ "review_type": "gate", "node_id": "y", "node_label": "再审批" }),
        ));
        assert_eq!(recorder.snapshot().last().unwrap()["step_id"], "card:2");
    }

    #[test]
    fn tool_reuse_resets_status_and_success() {
        let mut recorder = RoundStepsTransport::new("round-3", None, None);
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "fetch", "tool_call_id": "tc-9" }),
        ));
        recorder.feed(&event("tool_end", json!({ "tool_call_id": "tc-9", "success": false })));
        // 审批 resume 重发同一工具调用 → 复用卡并复位 running
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "fetch", "tool_call_id": "tc-9" }),
        ));
        let steps = recorder.snapshot();
        assert_eq!(by_type(&steps, "tool").len(), 1, "同 tool_call_id 不产生重复卡");
        let tool = &steps[0];
        assert_eq!(tool["payload"]["status"], "running");
        assert!(tool["payload"]["success"].is_null(), "复位 success 为 null");
        assert_eq!(tool["step_id"], "tool:tc-9");
    }

    #[test]
    fn tool_end_without_call_id_pairs_last_tool_card() {
        let mut recorder = RoundStepsTransport::new("round-4", None, None);
        recorder.feed(&event("tool_start", json!({ "tool": "grep", "tool_call_id": "" })));
        recorder.feed(&event("tool_end", json!({ "tool_call_id": "", "success": true })));
        let steps = recorder.snapshot();
        assert_eq!(steps[0]["step_id"], "tool:1");
        assert_eq!(steps[0]["payload"]["status"], "done");
        assert_eq!(steps[0]["payload"]["success"], true);
    }

    #[test]
    fn node_cards_split_by_chapter_index_and_carry_progress() {
        let mut recorder = RoundStepsTransport::new("round-5", None, None);
        recorder.feed(&event(
            "node_start",
            json!({
                "node": "write_chapter",
                "label": "撰写章节",
                "extra": { "chapter_index": 2, "chapter_total": 3 },
            }),
        ));
        recorder.feed(&event(
            "node_stream",
            json!({ "node": "write_chapter", "index": 2, "token": "第一章" }),
        ));
        recorder.feed(&event(
            "node_end",
            json!({ "node": "write_chapter", "index": 2, "tokens": 4 }),
        ));
        // 无进度序号的同节点另起一张卡（index=0 形态）
        recorder.feed(&event(
            "node_start",
            json!({ "node": "write_chapter", "label": "撰写章节" }),
        ));
        recorder.feed(&event(
            "node_fail",
            json!({ "node": "write_chapter", "index": 0, "reason": "生成中断" }),
        ));
        let steps = recorder.snapshot();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["step_id"], "node:write_chapter:2");
        assert_eq!(steps[0]["payload"]["label"], "撰写章节");
        assert_eq!(steps[0]["payload"]["progress"], json!({ "step": "write", "n": 2, "total": 3 }));
        assert_eq!(steps[0]["payload"]["status"], "completed");
        assert_eq!(steps[0]["payload"]["tokens"], 4);
        assert_eq!(steps[1]["step_id"], "node:write_chapter");
        assert_eq!(steps[1]["payload"]["status"], "failed");
        assert_eq!(steps[1]["payload"]["reason"], "生成中断");
    }

    #[test]
    fn node_labels_override_display_names() {
        let mut labels = BTreeMap::new();
        labels.insert("collect_material".to_string(), "采集材料".to_string());
        let mut recorder = RoundStepsTransport::new("round-6", None, Some(labels));
        recorder.feed(&event(
            "node_start",
            json!({ "node": "collect_material", "label": "内部环节名" }),
        ));
        let steps = recorder.snapshot();
        assert_eq!(steps[0]["payload"]["label"], "采集材料", "宿主注入标签优先");
    }

    #[test]
    fn memory_hit_attaches_to_last_thinking_card_and_dedupes() {
        let mut recorder = RoundStepsTransport::new("round-7", None, None);
        recorder.feed(&event("thinking_start", json!({})));
        recorder.feed(&event("memory_hit", json!({ "hits": [{ "id": "m1" }, { "id": "m2" }] })));
        recorder.feed(&event("memory_hit", json!({ "hits": [{ "id": "m1" }] })));
        let steps = recorder.snapshot();
        assert_eq!(by_type(&steps, "memory_hit").len(), 0, "命中挂到思考卡不独立成卡");
        let thinking = &steps[0];
        assert_eq!(thinking["payload"]["memories"].as_array().unwrap().len(), 2, "同 id 命中幂等");
        // 无思考/规划卡时独立 memory 步骤
        let mut standalone = RoundStepsTransport::new("round-8", None, None);
        standalone.feed(&event("memory_hit", json!({ "hits": [{ "id": "m9" }] })));
        let steps = standalone.snapshot();
        assert_eq!(steps[0]["type"], "memory_hit");
        assert_eq!(steps[0]["step_id"], "memory:1");
    }

    #[test]
    fn reply_segments_split_on_tool_and_review_cards() {
        let mut recorder = RoundStepsTransport::new("round-9", None, None);
        recorder.feed(&event("reply_token", json!({ "token": "第一" })));
        recorder.feed(&event("reply_token", json!({ "token": "段" })));
        recorder.feed(&event("tool_start", json!({ "tool": "grep", "tool_call_id": "" })));
        recorder.feed(&event("reply_token", json!({ "token": "第二段" })));
        let steps = recorder.snapshot();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0]["step_id"], "reply:1");
        assert_eq!(steps[0]["payload"]["content"], "第一段");
        assert_eq!(steps[2]["step_id"], "reply:2", "工具卡出现即切新段");
        assert_eq!(steps[2]["payload"]["content"], "第二段");
    }

    #[test]
    fn abort_closes_event_arc_and_stops_accumulation() {
        let mut recorder = RoundStepsTransport::new("round-10", None, None);
        recorder.feed(&event("user", json!({ "content": "发起回合" })));
        recorder.abort_current_round();
        assert!(recorder.is_aborted());
        recorder.feed(&event("thinking_start", json!({})));
        recorder.feed(&event("reply_token", json!({ "token": "不应记录" })));
        let steps = recorder.snapshot();
        assert_eq!(steps.len(), 1, "中止后事件不再累积");
        // 新回合 begin_round 解除关断
        recorder.begin_round("round-11");
        assert!(!recorder.is_aborted());
        recorder.feed(&event("user", json!({ "content": "新回合" })));
        assert_eq!(recorder.snapshot().len(), 1);
    }

    #[test]
    fn feed_ignores_unknown_event_types() {
        let mut recorder = RoundStepsTransport::new("round-12", None, None);
        recorder.feed(&event("unknown_event", json!({ "content": "x" })));
        recorder.feed(&json!({ "type": 42, "payload": {} }));
        recorder.feed(&json!({}));
        assert!(recorder.snapshot().is_empty(), "未命中事件类型不记录");
    }

    #[test]
    fn step_id_truncated_at_limit() {
        let mut recorder = RoundStepsTransport::new("round-13", None, None);
        let long_id = "x".repeat(300);
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "grep", "tool_call_id": long_id }),
        ));
        let steps = recorder.snapshot();
        let step_id = steps[0]["step_id"].as_str().unwrap();
        assert_eq!(step_id.chars().count(), 200, "step_id 截断到上限");
        assert!(step_id.starts_with("tool:x"));
    }

    #[test]
    fn begin_round_swaps_accumulator() {
        let mut recorder = RoundStepsTransport::new("round-14", None, None);
        recorder.feed(&event("user", json!({ "content": "回合 A" })));
        recorder.begin_round("round-15");
        assert_eq!(recorder.round_id(), "round-15");
        assert!(recorder.snapshot().is_empty(), "新回合换累积器");
    }

    #[test]
    fn tool_title_resolver_fills_payload_title() {
        let resolver: ToolTitleResolver = Arc::new(|name| {
            if name == "fetch" {
                Some("网络抓取".to_string())
            } else {
                None
            }
        });
        let mut recorder = RoundStepsTransport::with_engine_handles(
            "round-16",
            None,
            None,
            Some(resolver),
            None,
        );
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "fetch", "tool_call_id": "call-1" }),
        ));
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "grep", "tool_call_id": "call-2" }),
        ));
        let steps = recorder.snapshot();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["payload"]["title"], "网络抓取", "解析命中落 title");
        assert!(
            steps[1]["payload"].get("title").is_none(),
            "解析未命中不落 title（展示层走兜底链）"
        );
    }

    #[test]
    fn tool_title_prefers_resolver_over_inline_title() {
        let resolver: ToolTitleResolver = Arc::new(|_name| Some("解析器标题".to_string()));
        let mut recorder = RoundStepsTransport::with_engine_handles(
            "round-17",
            None,
            None,
            Some(resolver),
            None,
        );
        recorder.feed(&event(
            "tool_start",
            json!({ "tool": "grep", "tool_call_id": "", "title": "载荷标题" }),
        ));
        let steps = recorder.snapshot();
        assert_eq!(steps[0]["payload"]["title"], "解析器标题");
    }

    #[test]
    fn abort_signal_handshake_resets_on_new_round() {
        let signal = RoundAbortSignal::new();
        let mut recorder = RoundStepsTransport::with_engine_handles(
            "round-18",
            None,
            None,
            None,
            Some(signal.clone()),
        );
        recorder.abort_current_round();
        assert!(signal.is_aborted(), "信号与记录层同步握手");
        assert_eq!(signal.epoch(), 1);
        recorder.begin_round("round-19");
        assert!(!signal.is_aborted(), "换回合清中止态");
        assert_eq!(signal.epoch(), 1, "闸门计数单调");
        recorder.abort_current_round();
        assert_eq!(signal.epoch(), 2);
    }

    #[test]
    fn feed_polls_shared_abort_signal_across_clones() {
        // R7：round_abort 只改 slot 克隆的本地 aborted；另一克隆的 feed
        // 必须经共享 abort_signal 感知中止，中止后事件不再累积。
        let signal = RoundAbortSignal::new();
        let mut primary = RoundStepsTransport::with_engine_handles(
            "round-20",
            None,
            None,
            None,
            Some(signal.clone()),
        );
        let mut twin = RoundStepsTransport::with_engine_handles(
            "round-20",
            None,
            None,
            None,
            Some(signal.clone()),
        );
        primary.feed(&event("user", json!({ "content": "第一回合" })));
        twin.feed(&event("user", json!({ "content": "第一回合" })));
        // 对 primary（slot 克隆）中止：只置位 primary 本地弧 + 共享信号
        primary.abort_current_round();
        assert!(signal.is_aborted(), "共享信号应置位");
        // twin（round_send 收尾 feed 用的另一克隆）经共享信号感知中止
        twin.feed(&event("thinking_start", json!({})));
        twin.feed(&event("reply_token", json!({ "token": "不应记录" })));
        let steps = twin.snapshot();
        assert_eq!(steps.len(), 1, "共享信号中止后 feed 不再累积");
    }
}

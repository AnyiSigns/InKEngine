//! 策略层域：任务分类 + 受控输出计划解析 + spawn 分组/决策点标注 +
//! 弱模型自动降档。
//!
//! 策略层是回合规划前的「轻挡」：从任务文本出发得出一份受控计划
//! （计划 JSON 的约束域 = workflow 节点集），由 router 挡模型生成，
//! 解析失败即 fail-closed 回落确定性流程（workflow.json 线性链），
//! 不把模型幻觉带进执行。
//!
//! 数据形态（与策略层提示词约定一致）：
//! - 计划 JSON：`{ entry, steps[{node, note, inputs}], spawn_groups[],
//!   decision_points[{id, kind, label}], simulate }`；
//! - spawn 分组 = 并行子任务标注（确定性任务直接 spawn、不确定性
//!   任务先 simulate 再决策——打标准则在 [`super::prompt`] 的变体提示词）；
//! - 决策点 = 计划内的受限标注（approval/branch/revert）。
//!
//! 弱模型降档：模型能力不足时只保留计划本身（不 spawn、不 simulate）——
//! 降档是权限收敛而非降级异常，计划仍完整可执行。
//!
//! 依赖纪律：本模块不直接调用其它域模块；router 轻挡的模型调用由
//! 装配侧经引擎模型链注入（本模块只做计划产物的纯逻辑判定）。

use serde_json::Value as JsonValue;

use super::common::DomainError;
use crate::engine::host::call_engine_op_async;

/// 任务类别（确定性分类的输出形态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskKind {
    DirectAnswer,
    Research,
    Development,
}

impl TaskKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::DirectAnswer => "直答",
            Self::Research => "研究",
            Self::Development => "开发",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DirectAnswer => "direct_answer",
            Self::Research => "research",
            Self::Development => "development",
        }
    }
}

/// 开发任务触发词（任务文本命中 = 开发类别；先于研究判定）。
const DEV_KEYWORDS: [&str; 14] = [
    "开发",
    "实现",
    "修复",
    "编码",
    "写一个",
    "写个",
    "写代码",
    "编写",
    "构建",
    "调试",
    "重构",
    "造一个",
    "做出一个",
    "做一个",
];

/// 研究任务触发词（任务文本命中 = 研究类别）。
const RESEARCH_KEYWORDS: [&str; 12] = [
    "研究",
    "调研",
    "调查",
    "检索",
    "查证",
    "搜集",
    "收集资料",
    "背景查",
    "找找看",
    "查一查",
    "了解",
    "学习",
];

/// 决策点的受限类别（计划 JSON 只能出现这三类）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionKind {
    Approval,
    Branch,
    Revert,
}

impl DecisionKind {
    pub fn parse(value: &str) -> Result<Self, DomainError> {
        match value {
            "approval" => Ok(Self::Approval),
            "branch" => Ok(Self::Branch),
            "revert" => Ok(Self::Revert),
            other => Err(DomainError::InvalidData(format!("决策点类别非法: {other:?}"))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Branch => "branch",
            Self::Revert => "revert",
        }
    }
}

/// 计划执行模式（弱模型降档后的收敛形态）。
///
/// - `PlanOnly`：只走计划步骤（直线）；
/// - `PlanSpawn`：计划步骤 + spawn 分组（子任务并行展开）；
/// - `PlanSpawnSimulate`：计划步骤 + spawn 分组 + simulate 探测
///   （不确定性任务先模拟出候选再决策）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanMode {
    PlanOnly,
    PlanSpawn,
    PlanSpawnSimulate,
}

impl PlanMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PlanOnly => "plan_only",
            Self::PlanSpawn => "plan_spawn",
            Self::PlanSpawnSimulate => "plan_spawn_simulate",
        }
    }
}

/// spawn 分组标注（子任务展开的限定形态：组内节点并行 or 串行）。
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnGroup {
    pub id: String,
    pub nodes: Vec<String>,
    pub parallel: bool,
    pub label: String,
}

/// 决策点标注（计划内的受限机会点：审批/分支/回退）。
#[derive(Debug, Clone, PartialEq)]
pub struct DecisionPoint {
    pub id: String,
    pub kind: DecisionKind,
    pub label: String,
}

/// 计划步骤（单节点 + 输入声明；node 必须在约束节点集内）。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanStep {
    pub node: String,
    pub inputs: Vec<String>,
    pub note: String,
}

/// 受控计划（约束域 = workflow 节点集；来源标注 + 执行模式）。
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub entry: Option<String>,
    pub steps: Vec<PlanStep>,
    pub spawn_groups: Vec<SpawnGroup>,
    pub decision_points: Vec<DecisionPoint>,
    pub mode: PlanMode,
    pub source: PlanSource,
}

/// 计划来源（router 受控输出 / 确定性回落）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanSource {
    Router,
    Deterministic,
}

/// 计划解析失败（fail-closed 依据：违规项清单，逐条可读）。
#[derive(Debug, Clone)]
pub struct PlanParseFailure {
    pub violations: Vec<String>,
}

impl PlanParseFailure {
    fn new(violations: Vec<String>) -> Self {
        Self { violations }
    }

    pub fn is_empty(&self) -> bool {
        self.violations.is_empty()
    }
}

/// 确定性计划（fail-closed 回落形态）：按 workflow 节点序的线性链。
///
/// 直答 = 无节点执行（entry=None）；研究/开发 = 全节点链（顺序执行，
/// 无 spawn 分组、无 simulate）。节点集为空 = 直答形态（无链可走）。
pub fn deterministic_plan(kind: TaskKind, nodes: &[WorkflowNode]) -> Plan {
    match kind {
        TaskKind::DirectAnswer => Plan {
            entry: None,
            steps: Vec::new(),
            spawn_groups: Vec::new(),
            decision_points: Vec::new(),
            mode: PlanMode::PlanOnly,
            source: PlanSource::Deterministic,
        },
        TaskKind::Research | TaskKind::Development => {
            let steps = nodes
                .iter()
                .map(|node| PlanStep {
                    node: node.id.clone(),
                    inputs: Vec::new(),
                    note: node.note.clone(),
                })
                .collect::<Vec<_>>();
            let entry = if nodes.is_empty() {
                None
            } else {
                nodes
                    .iter()
                    .find(|n| n.is_entry)
                    .or_else(|| nodes.first())
                    .map(|n| n.id.clone())
            };
            Plan {
                entry,
                steps,
                spawn_groups: Vec::new(),
                decision_points: Vec::new(),
                mode: PlanMode::PlanOnly,
                source: PlanSource::Deterministic,
            }
        }
    }
}

/// workflow 节点（约束域的数据形态：id/kind/note + 入口标记）。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowNode {
    pub id: String,
    pub kind: String,
    pub note: String,
    pub is_entry: bool,
}

/// 从 workflow.json 解析节点集（约束域 + 入口）。
pub fn parse_workflow_nodes(workflow_data: &JsonValue) -> Vec<WorkflowNode> {
    let entry = workflow_data
        .get("entry")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    workflow_data
        .get("nodes")
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|node| {
                    let id = node.get("id")?.as_str()?.to_string();
                    let is_entry = id == entry;
                    let kind = node
                        .get("type")
                        .or_else(|| node.get("kind"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let note = node
                        .get("config")
                        .and_then(|c| c.get("note"))
                        .or_else(|| node.get("note"))
                        .and_then(JsonValue::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some(WorkflowNode {
                        id,
                        kind,
                        note,
                        is_entry,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 任务分类（确定性关键词判定；开发 = 强信号先于研究）。
///
/// 分类不是意图猜测而是「后续流程的粗略走法」：命中开发词 = 开发
/// （写代码/构建/修复），命中研究词 = 研究（检索/查证/学习），
/// 均未命中 = 直答。结果仅影响确定性回落的链形态。
pub fn classify_task(text: &str) -> TaskKind {
    let dev_hits = DEV_KEYWORDS.iter().filter(|kw| text.contains(**kw)).count();
    let research_hits = RESEARCH_KEYWORDS
        .iter()
        .filter(|kw| text.contains(**kw))
        .count();
    if dev_hits > 0 {
        TaskKind::Development
    } else if research_hits > 0 {
        TaskKind::Research
    } else {
        TaskKind::DirectAnswer
    }
}

/// 解析 router 轻挡的计划 JSON（受控校验，fail-closed）。
///
/// 校验项（全部命中才收下，任一违规即拒绝整份计划）：
/// 1. JSON 形态合法且为对象；
/// 2. 节点/入口/分组节点全部在约束节点集内（越界 = 拒绝）；
/// 3. 分组 id/步骤节点不得重复；
/// 4. 决策点类别 ∈ {approval, branch, revert}；
/// 5. simulate 只允许在存在 spawn 分组时声明（避免「模拟空转」）；
/// 6. 无步骤且无入口 = 非法（直答形态由计划声明 steps 为空数组 +
///    entry=null 显式表达，缺字段仍视为非法）。
///
/// 返回失败时携带逐条违规（留痕可读，不静默吞掉模型越界）。
pub fn parse_plan_json(plan_text: &str, node_set: &[String]) -> Result<Plan, PlanParseFailure> {
    let value: JsonValue = match serde_json::from_str(plan_text) {
        Ok(value) => value,
        Err(err) => {
            return Err(PlanParseFailure::new(vec![format!(
                "计划输出非合法 JSON: {err}"
            )]));
        }
    };
    parse_plan_value(&value, node_set)
}

/// 以 JSON 值形态解析计划（parse_plan_json 的取值侧；测试与
/// 装配侧共用同一校验路径）。
pub fn parse_plan_value(value: &JsonValue, node_set: &[String]) -> Result<Plan, PlanParseFailure> {
    let mut violations: Vec<String> = Vec::new();
    let steps = value
        .get("steps")
        .filter(|v| v.is_array())
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let declared_steps = value.get("steps").is_some();
    let entry = value.get("entry");
    if !declared_steps || entry.is_none() {
        violations.push("计划缺步骤清单/入口声明（缺字段视为非法）".to_string());
    }
    let entry = entry
        .and_then(JsonValue::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut nodes_in_plan: Vec<String> = Vec::new();
    let mut parsed_steps: Vec<PlanStep> = Vec::new();
    for step in &steps {
        let node = match step.get("node").and_then(JsonValue::as_str) {
            Some(node) => node.to_string(),
            None => {
                violations.push("步骤缺 node 字段".to_string());
                continue;
            }
        };
        if !node_set.iter().any(|n| n == &node) {
            violations.push(format!("步骤节点越界（不在约束节点集）: {node}"));
        }
        if nodes_in_plan.contains(&node) {
            violations.push(format!("步骤节点重复: {node}"));
        }
        nodes_in_plan.push(node.clone());
        let inputs = step
            .get("inputs")
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let note = step
            .get("note")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        parsed_steps.push(PlanStep { node, inputs, note });
    }
    if let Some(entry_value) = entry.as_deref() {
        if !node_set.iter().any(|n| n == entry_value) {
            violations.push(format!("入口节点越界: {entry_value}"));
        }
        if steps.is_empty() {
            violations.push("声明了入口但无步骤（空计划非法）".to_string());
        }
    } else if steps.is_empty() && !violations.iter().any(|v| v.contains("缺步骤清单")) {
        violations.push("既无入口也无步骤（直答形态须显式表达）".to_string());
    }
    let mut spawn_groups: Vec<SpawnGroup> = Vec::new();
    let mut spawn_ids: Vec<String> = Vec::new();
    let groups = value
        .get("spawn_groups")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    for group in groups {
        let id = match group.get("id").and_then(JsonValue::as_str) {
            Some(id) => id.to_string(),
            None => {
                violations.push("spawn 分组缺 id".to_string());
                continue;
            }
        };
        if spawn_ids.contains(&id) {
            violations.push(format!("spawn 分组 id 重复: {id}"));
        }
        spawn_ids.push(id.clone());
        let members = group
            .get("nodes")
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for member in &members {
            if !node_set.iter().any(|n| n == member) {
                violations.push(format!("spawn 分组节点越界: {member}"));
            }
        }
        if members.is_empty() {
            violations.push(format!("spawn 分组节点为空: {id}"));
        }
        let label = group
            .get("label")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        spawn_groups.push(SpawnGroup {
            id,
            nodes: members,
            parallel: group.get("parallel").and_then(JsonValue::as_bool).unwrap_or(false),
            label,
        });
    }
    let mut decision_points: Vec<DecisionPoint> = Vec::new();
    let decisions = value
        .get("decision_points")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    for decision in decisions {
        let id = match decision.get("id").and_then(JsonValue::as_str) {
            Some(id) => id.to_string(),
            None => {
                violations.push("决策点缺 id".to_string());
                continue;
            }
        };
        let kind = match decision
            .get("kind")
            .and_then(JsonValue::as_str)
            .and_then(|k| DecisionKind::parse(k).ok())
        {
            Some(kind) => kind,
            None => {
                violations.push(format!(
                    "决策点类别非法: {:?}",
                    decision.get("kind")
                ));
                continue;
            }
        };
        let label = decision
            .get("label")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        decision_points.push(DecisionPoint { id, kind, label });
    }
    let simulate = value.get("simulate").and_then(JsonValue::as_bool).unwrap_or(false);
    let mode = if spawn_groups.is_empty() {
        if simulate {
            violations.push("simulate 只能在存在 spawn 分组时声明".to_string());
        }
        PlanMode::PlanOnly
    } else if simulate {
        PlanMode::PlanSpawnSimulate
    } else {
        PlanMode::PlanSpawn
    };
    if !violations.is_empty() {
        return Err(PlanParseFailure::new(violations));
    }
    Ok(Plan {
        entry,
        steps: parsed_steps,
        spawn_groups,
        decision_points,
        mode,
        source: PlanSource::Router,
    })
}

/// 计划编排（策略层入口）：router 轻挡输出可用则用，非法即回落确定性。
///
/// `router_output` = router 轻挡的原始回复文本（计划 JSON 字符串）；
/// None = 轻挡未产出（超时/模型缺失）也回落。fail-closed 语义：
/// 计划解析失败绝不带病执行，回落的确定性计划不产生 spawn/模拟。
pub fn plan_for_task(
    task_text: &str,
    nodes: &[WorkflowNode],
    router_output: Option<&str>,
) -> Plan {
    let node_set: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    if let Some(text) = router_output {
        if let Ok(plan) = parse_plan_json(text, &node_set) {
            return plan;
        }
    }
    deterministic_plan(classify_task(task_text), nodes)
}

/// 弱模型自动降档：只保留计划本身（不 spawn、不 simulate）。
///
/// 降档规则：清空 spawn 分组、模式归 PlanOnly；步骤/入口/决策点保留
/// （决策点标注是计划文档的一部分，非执行动作，降档不丢）。
pub fn downgrade_plan(plan: &Plan) -> Plan {
    Plan {
        entry: plan.entry.clone(),
        steps: plan.steps.clone(),
        spawn_groups: Vec::new(),
        decision_points: plan.decision_points.clone(),
        mode: PlanMode::PlanOnly,
        source: plan.source,
    }
}

/// 计划 → 数据形态（图装配/落盘/事件载荷共用；缺失字段按缺省补）。
pub fn plan_json(plan: &Plan) -> JsonValue {
    serde_json::json!({
        "entry": plan.entry,
        "steps": plan.steps.iter().map(|step| serde_json::json!({
            "node": step.node,
            "inputs": step.inputs,
            "note": step.note,
        })).collect::<Vec<_>>(),
        "spawn_groups": plan.spawn_groups.iter().map(|group| serde_json::json!({
            "id": group.id,
            "nodes": group.nodes,
            "parallel": group.parallel,
            "label": group.label,
        })).collect::<Vec<_>>(),
        "decision_points": plan.decision_points.iter().map(|point| serde_json::json!({
            "id": point.id,
            "kind": point.kind.as_str(),
            "label": point.label,
        })).collect::<Vec<_>>(),
        "mode": plan.mode.as_str(),
        "source": match plan.source {
            PlanSource::Router => "router",
            PlanSource::Deterministic => "deterministic",
        },
    })
}

/// 计划文本 → 计划（装配侧经 router 挡位执行调用后的收敛入口）。
///
/// router 轻挡的调用（任务文本 + 节点集 → 计划 JSON）是产品侧的
/// 装配决策：把 router 挡模型经引擎模型链发起单次轻调用
/// （[`router_light_complete`]），回复文本喂回本函数。
pub fn converge_plan(task_text: &str, nodes: &[WorkflowNode], router_reply: Option<&str>) -> Plan {
    plan_for_task(task_text, nodes, router_reply)
}

/// router 挡位单次轻调用（消息清单 → 模型轻回复）。
///
/// 轻调用经操作通道 engine.router_light_complete 发起（messages 为
/// role/content 形态消息清单，system 提示词 + 任务文本组合由调用方
/// 组装）；回复文本喂回 [`converge_plan`] 收敛为受控计划。
pub async fn router_light_complete(messages: Vec<JsonValue>) -> Result<String, String> {
    let reply = call_engine_op_async(
        "engine.router_light_complete",
        serde_json::json!({ "messages": messages }),
    )
    .await?;
    reply
        .get("content")
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| "路由轻调用未返回回复文本".to_string())
}

/// 策略层计划的 spawn 分组标注（子任务展开的可见形态）。
pub fn spawn_groupings(plan: &Plan) -> Vec<SpawnGroup> {
    plan.spawn_groups.clone()
}

/// 策略层计划的决策点标注（受限机会点的可见形态）。
pub fn decision_markers(plan: &Plan) -> Vec<DecisionPoint> {
    plan.decision_points.clone()
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

    fn workflow_nodes() -> Vec<WorkflowNode> {
        parse_workflow_nodes(&seed_file("workflow.json"))
    }

    fn node_ids(nodes: &[WorkflowNode]) -> Vec<String> {
        nodes.iter().map(|n| n.id.clone()).collect()
    }

    #[test]
    fn workflow_seed_yields_six_node_constraint_domain() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        assert_eq!(ids.len(), 6);
        assert!(ids.contains(&"collect_material".to_string()));
        assert!(ids.contains(&"distill_knowledge".to_string()));
        let entry = nodes.iter().find(|n| n.is_entry).expect("有入口节点");
        assert_eq!(entry.id, "collect_material");
    }

    #[test]
    fn classify_task_kinds_are_deterministic() {
        assert_eq!(classify_task("帮我写一个贪吃蛇游戏"), TaskKind::Development);
        assert_eq!(classify_task("修复这个崩溃 bug"), TaskKind::Development);
        assert_eq!(classify_task("调研墨引擎的清单机制"), TaskKind::Research);
        assert_eq!(classify_task("研究一下这个仓库的结构"), TaskKind::Research);
        assert_eq!(classify_task("今天天气怎么样"), TaskKind::DirectAnswer);
        assert_eq!(classify_task("你好"), TaskKind::DirectAnswer);
    }

    #[test]
    fn router_plan_within_constraints_is_accepted() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [
                {"node": "collect_material", "note": "抓取", "inputs": ["url"]},
                {"node": "parse_material", "note": "抽取", "inputs": ["material"]}
            ],
            "spawn_groups": [
                {"id": "g1", "nodes": ["collect_material", "parse_material"], "parallel": true, "label": "并行入料"}
            ],
            "decision_points": [
                {"id": "d1", "kind": "approval", "label": "评审把关"}
            ],
            "simulate": false
        }"#;
        let plan = parse_plan_json(plan_text, &ids).expect("受控计划应被接受");
        assert_eq!(plan.source, PlanSource::Router);
        assert_eq!(plan.mode, PlanMode::PlanSpawn);
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.spawn_groups.len(), 1);
        assert_eq!(plan.spawn_groups[0].nodes.len(), 2);
        assert_eq!(plan.decision_points[0].kind, DecisionKind::Approval);
    }

    #[test]
    fn router_plan_with_simulate_needs_groups() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [{"node": "collect_material", "inputs": []}],
            "spawn_groups": [
                {"id": "g1", "nodes": ["collect_material", "validate_material"], "parallel": false, "label": "探测"}
            ],
            "simulate": true
        }"#;
        let plan = parse_plan_json(plan_text, &ids).expect("带分组的 simulate 合法");
        assert_eq!(plan.mode, PlanMode::PlanSpawnSimulate);
    }

    #[test]
    fn out_of_domain_node_fails_closed() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [{"node": "not_a_workflow_node", "inputs": []}]
        }"#;
        let failure = parse_plan_json(plan_text, &ids).expect_err("越界节点必须拒绝");
        assert!(failure.violations.iter().any(|v| v.contains("越界")));
        let simulate_plan = r#"{
            "entry": "collect_material",
            "steps": [{"node": "collect_material", "inputs": []}],
            "simulate": true
        }"#;
        let failure = parse_plan_json(simulate_plan, &ids).expect_err("空转 simulate 必须拒绝");
        assert!(failure.violations.iter().any(|v| v.contains("simulate")));
    }

    #[test]
    fn malformed_and_missing_fields_fail_closed() {
        let ids = node_ids(&workflow_nodes());
        let failure = parse_plan_json("{not json", &ids).expect_err("非法 JSON 拒绝");
        assert!(failure.violations[0].contains("JSON"));
        let missing = parse_plan_json("{}", &ids).expect_err("缺步骤/入口拒绝");
        assert!(missing.violations.iter().any(|v| v.contains("入口")));
        let duplicate = r#"{
            "entry": "collect_material",
            "steps": [
                {"node": "collect_material", "inputs": []},
                {"node": "collect_material", "inputs": []}
            ]
        }"#;
        let failure = parse_plan_json(duplicate, &ids).expect_err("重复节点拒绝");
        assert!(failure.violations.iter().any(|v| v.contains("重复")));
        let bad_kind = r#"{
            "entry": "collect_material",
            "steps": [{"node": "collect_material", "inputs": []}],
            "decision_points": [{"id": "d1", "kind": "teleport", "label": "传送"}]
        }"#;
        let failure = parse_plan_json(bad_kind, &ids).expect_err("非法决策点类别拒绝");
        assert!(failure.violations.iter().any(|v| v.contains("决策点")));
    }

    #[test]
    fn router_plan_within_node_set_but_foreign_decision_rejected() {
        let ids = node_ids(&workflow_nodes());
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [
                {"node": "collect_material", "inputs": []},
                {"node": "parse_material", "inputs": []},
                {"node": "validate_material", "inputs": []}
            ],
            "spawn_groups": [
                {"id": "g1", "nodes": ["collect_material", "parse_material"], "parallel": true, "label": "入料"}
            ]
        }"#;
        let plan = parse_plan_json(plan_text, &ids).expect("计划应被接受");
        assert_eq!(plan.mode, PlanMode::PlanSpawn);
    }

    #[test]
    fn deterministic_fallback_for_each_kind() {
        let nodes = workflow_nodes();
        let research = deterministic_plan(TaskKind::Research, &nodes);
        assert_eq!(research.source, PlanSource::Deterministic);
        assert_eq!(research.mode, PlanMode::PlanOnly);
        assert_eq!(research.steps.len(), 6, "研究 = 全链");
        assert_eq!(research.entry.as_deref(), Some("collect_material"));
        assert!(research.spawn_groups.is_empty(), "确定性流程不含 spawn");

        let direct = deterministic_plan(TaskKind::DirectAnswer, &nodes);
        assert_eq!(direct.entry, None);
        assert!(direct.steps.is_empty());
    }

    #[test]
    fn plan_for_task_falls_back_on_bad_router_output() {
        let nodes = workflow_nodes();
        let bad = plan_for_task("调研知识链机制", &nodes, Some("{oops"));
        assert_eq!(bad.source, PlanSource::Deterministic);
        assert_eq!(bad.steps.len(), 6);
        let foreign = plan_for_task(
            "调研知识链机制",
            &nodes,
            Some(r#"{"entry": "collect_material", "steps": [{"node": "evil_node", "inputs": []}]}"#),
        );
        assert_eq!(foreign.source, PlanSource::Deterministic, "越界计划回落确定性");
        let none = plan_for_task("调研知识链机制", &nodes, None);
        assert_eq!(none.source, PlanSource::Deterministic);
    }

    #[test]
    fn downgrade_plan_strips_spawn_and_simulate() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [{"node": "collect_material", "inputs": []}],
            "spawn_groups": [
                {"id": "g1", "nodes": ["collect_material", "parse_material"], "parallel": true, "label": "入料"}
            ],
            "decision_points": [{"id": "d1", "kind": "branch", "label": "分叉"}],
            "simulate": true
        }"#;
        let plan = parse_plan_json(plan_text, &ids).expect("计划合法");
        let downgraded = downgrade_plan(&plan);
        assert_eq!(downgraded.mode, PlanMode::PlanOnly);
        assert!(downgraded.spawn_groups.is_empty(), "弱模型不 spawn");
        assert_eq!(downgraded.steps.len(), 1, "步骤保留");
        assert_eq!(downgraded.decision_points.len(), 1, "决策点标注保留");
        assert_eq!(plan_json(&downgraded)["mode"], "plan_only");
    }

    #[test]
    fn plan_json_roundtrip_preserves_shape() {
        let nodes = workflow_nodes();
        let ids = node_ids(&nodes);
        let plan_text = r#"{
            "entry": "collect_material",
            "steps": [{"node": "collect_material", "inputs": ["url"], "note": "入料"}],
            "decision_points": [{"id": "d1", "kind": "approval", "label": "审批"}]
        }"#;
        let plan = parse_plan_json(plan_text, &ids).expect("计划合法");
        let json = plan_json(&plan);
        assert_eq!(json["entry"], "collect_material");
        assert_eq!(json["steps"][0]["node"], "collect_material");
        assert_eq!(json["decision_points"][0]["kind"], "approval");
        assert_eq!(json["source"], "router");
        let back = parse_plan_value(&json, &ids).expect("数据形态回解析合法");
        assert_eq!(back.steps.len(), plan.steps.len());
    }

    #[test]
    fn empty_node_set_degrades_to_direct_answer() {
        let nodes: Vec<WorkflowNode> = Vec::new();
        let plan = deterministic_plan(TaskKind::Research, &nodes);
        assert_eq!(plan.entry, None);
        assert!(plan.steps.is_empty());
        let task_plan = plan_for_task("调研…", &nodes, None);
        assert_eq!(task_plan.source, PlanSource::Deterministic);
    }

    #[test]
    fn router_light_call_fails_closed_without_engine() {
        // 无引擎环境：路由轻调用经操作通道失败 = 结构化错误（运行时
        // 未装配），不再返回占位文案
        let _serial = crate::engine::host::bridge_guard();
        let messages = vec![serde_json::json!({"role": "user", "content": "调研"})];
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(router_light_complete(messages));
        assert!(err.is_err());
        assert!(!err.unwrap_err().contains("需 op"));
    }
}

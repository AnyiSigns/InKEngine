//! canary 域：候选图/架构变更的试跑编排 + 结果判定（通过才落链、
//! 失败拒绝并留痕原因）。
//!
//! 试跑语义：候选图以 stub 回合试跑（stub LLM + 图实例化），复用
//! 引擎既有的 run/resume 回合语义（经 op 通道发起）；本模块承担
//! 试跑编排的宿主侧签名与结果判定：
//! - **合法**：图实例化检查通过（节点/边/入口/出口引用完整）；
//! - **无崩溃**：试跑事件流无 error 事件、终止原因非 error；
//! - **关键路径可走通** = 试跑回合达到终态（reply/done），且
//!   关键路径节点在事件流中可见（plan 声明或节点事件触达）。
//!
//! 结果判定为纯逻辑（可单测）：给的试跑产物（reason + events）→
//! [`CanaryVerdict`]；判定不通过即拒绝（不落链）+ 原因留痕。
//!
//! 依赖纪律：本模块不直接调用其它域模块；stub 回合的引擎交互经
//! [`CanaryRoundDriver`] 钩子注入（装配接线），引擎直调形态 =
//! [`run_canary_via_engine`]（经 engine.canary_stub_round 操作通道）；
//! 试跑断言只依赖事件协议形态（event_types.json 的字段契约）。

use std::pin::Pin;

use serde_json::Value as JsonValue;

use super::common::DomainError;
use crate::engine::host::call_engine_op_async;

/// 试跑判定视作「达到终态」的终止原因（与引擎回合终止原语对齐）。
pub const STUB_TERMINAL_REASONS: [&str; 3] = ["reply", "done", "terminate"];

/// 试跑判定视作「崩溃」的终止原因。
pub const STUB_CRASH_REASONS: [&str; 2] = ["error", "crash"];

/// 试跑声明：候选图 + 关键路径（走通与否的判定对象）。
#[derive(Debug, Clone, PartialEq)]
pub struct CanarySpec {
    /// 候选图数据结构（graph.json 形态：nodes 集合 + edges 引用）。
    pub graph: JsonValue,
    /// 入口节点（试跑起始锚点）。
    pub entry: String,
    /// 关键路径（节点 id 序；试跑后这些节点须在事件流可见）。
    pub key_path: Vec<String>,
    /// stub 模型回复（确定性试跑的物质化形态）。
    pub stub_reply: String,
    /// 工作流规格（workflow.json 形态：引擎侧 stub 回合按 graph +
    /// workflow 建图实例化）。graph.json 只引用工作流名（config 段），
    /// 不携带规格数据，故由装配侧显式注入；缺省 None = 未装配。
    pub workflow: Option<JsonValue>,
}

/// 图状态检查结果（违规清单；空 = 图合法可实例化）。
pub fn validate_canary_graph(graph: &JsonValue) -> Result<Vec<String>, DomainError> {
    let mut violations: Vec<String> = Vec::new();
    let nodes = graph.get("nodes");
    let node_ids: Vec<String> = match nodes {
        Some(JsonValue::Array(list)) => list
            .iter()
            .filter_map(|n| n.get("id").and_then(JsonValue::as_str).map(str::to_string))
            .collect(),
        Some(JsonValue::Object(map)) => map
            .keys()
            .filter(|k| !k.is_empty())
            .cloned()
            .collect(),
        _ => {
            return Err(DomainError::InvalidData(
                "候选图缺 nodes（须为数组或对象形态）".to_string(),
            ));
        }
    };
    if node_ids.is_empty() {
        violations.push("候选图节点集为空".to_string());
    }
    let unique: std::collections::HashSet<&String> = node_ids.iter().collect();
    if unique.len() != node_ids.len() {
        violations.push("候选图节点 id 重复".to_string());
    }
    let entry = graph
        .get("entry")
        .or_else(|| graph.get("start"))
        .and_then(JsonValue::as_str)
        .unwrap_or("");
    if entry.is_empty() {
        violations.push("候选图缺入口（entry/start）".to_string());
    } else if !node_ids.iter().any(|n| n == entry) {
        violations.push(format!("入口节点不在节点集内: {entry}"));
    }
    for edge in edges_of(graph) {
        for target in edge {
            if !node_ids.iter().any(|n| *n == target) {
                violations.push(format!("边引用未知节点: {target}"));
            }
        }
    }
    if let Some(exits) = graph.get("exits").and_then(JsonValue::as_array) {
        for exit in exits {
            let name = exit.as_str().unwrap_or("");
            if !name.is_empty() && !node_ids.iter().any(|n| n == name) {
                violations.push(format!("出口节点不在节点集内: {name}"));
            }
        }
    }
    Ok(violations)
}

/// 边的目标节点清单（数组形态 nodes 的 edges 与对象形态 edges 兼容）。
fn edges_of(graph: &JsonValue) -> Vec<Vec<String>> {
    let mut targets: Vec<Vec<String>> = Vec::new();
    match graph.get("edges") {
        Some(JsonValue::Array(list)) => {
            for edge in list {
                let mut hop = Vec::new();
                if let Some(target) = edge.get("target").and_then(JsonValue::as_str) {
                    hop.push(target.to_string());
                }
                if let Some(from) = edge.get("source").and_then(JsonValue::as_str) {
                    hop.push(from.to_string());
                }
                if !hop.is_empty() {
                    targets.push(hop);
                }
            }
        }
        Some(JsonValue::Object(map)) => {
            for value in map.values() {
                if let Some(list) = value.as_array() {
                    for item in list {
                        if let Some(target) = item.get("target").and_then(JsonValue::as_str) {
                            targets.push(vec![target.to_string()]);
                        }
                    }
                }
            }
        }
        _ => {}
    }
    targets
}

/// CanarySpec 装配：图数据 → 试跑声明（入口取图声明；关键路径缺省 =
/// 节点集内全部节点，按声明顺序）。
pub fn canary_spec_from(graph: JsonValue, key_path: Option<Vec<String>>, stub_reply: &str) -> Result<CanarySpec, DomainError> {
    validate_canary_graph(&graph)?;
    let entry = graph
        .get("entry")
        .or_else(|| graph.get("start"))
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let all_nodes: Vec<String> = match graph.get("nodes") {
        Some(JsonValue::Array(list)) => list
            .iter()
            .filter_map(|n| n.get("id").and_then(JsonValue::as_str).map(str::to_string))
            .collect(),
        Some(JsonValue::Object(map)) => map.keys().cloned().collect(),
        _ => Vec::new(),
    };
    let key_path = key_path
        .filter(|paths| !paths.is_empty())
        .unwrap_or(all_nodes);
    Ok(CanarySpec {
        graph,
        entry,
        key_path,
        stub_reply: stub_reply.to_string(),
        workflow: None,
    })
}

/// 试跑结果判定（合法 / 无崩溃 / 关键路径可走通 = 通过）。
///
/// `reason` = 试跑回合终止原因；`events` = 试跑事件流（引擎事件协议
/// 形态）。判定全绿才 passed；每项未满足都记入 reasons（拒绝留痕，
/// 不静默降级）。图非法（前置检查违规）也列为拒绝原因之一。
pub fn judge_canary_outcome(
    reason: &str,
    events: &[JsonValue],
    spec: &CanarySpec,
    graph_violations: &[String],
) -> CanaryVerdict {
    let mut reasons: Vec<String> = Vec::new();
    for violation in graph_violations {
        reasons.push(format!("图非法: {violation}"));
    }
    let crashed = graph_violations.is_empty()
        && (STUB_CRASH_REASONS.iter().any(|r| r == &reason)
            || events.iter().any(|event| {
                event
                    .get("type")
                    .or_else(|| event.get("name"))
                    .and_then(JsonValue::as_str)
                    .map(|name| name == "error" || name == "tool_error")
                    .unwrap_or(false)
            }));
    if crashed {
        reasons.push("试跑崩溃（error 事件/原因）".to_string());
    }
    let terminal = STUB_TERMINAL_REASONS.iter().any(|r| r == &reason);
    if !terminal {
        reasons.push(format!(
            "试跑未达终态（终止原因: {reason:?}；预期: reply/done）"
        ));
    }
    let key_path_reached = key_path_visible(spec, events);
    if !key_path_reached {
        reasons.push("关键路径未走通（关键节点在事件流不可见）".to_string());
    }
    CanaryVerdict {
        passed: reasons.is_empty(),
        reasons,
        crashed,
        terminal,
        key_path_reached,
    }
}

/// 关键路径节点是否在事件流可见（plan 声明或节点事件触达）。
fn key_path_visible(spec: &CanarySpec, events: &[JsonValue]) -> bool {
    if spec.key_path.is_empty() {
        return true;
    }
    let visible: std::collections::HashSet<String> = events
        .iter()
        .flat_map(|event| event_mentions(event))
        .collect();
    spec.key_path
        .iter()
        .all(|node| visible.contains(node))
}

/// 单事件提及的节点清单（事件字段 node/node_id/节点事件 type 或
/// plan_start 的计划步骤节点）。
fn event_mentions(event: &JsonValue) -> Vec<String> {
    let mut mentions = Vec::new();
    if let Some(node) = event.get("node").and_then(JsonValue::as_str) {
        mentions.push(node.to_string());
    }
    if let Some(node_id) = event.get("node_id").and_then(JsonValue::as_str) {
        mentions.push(node_id.to_string());
    }
    if let Some(plan) = event.get("plan").filter(|p| p.is_object()) {
        if let Some(steps) = plan.get("steps").and_then(JsonValue::as_array) {
            for step in steps {
                if let Some(node) = step.get("node").and_then(JsonValue::as_str) {
                    mentions.push(node.to_string());
                }
            }
        }
        if let Some(entry) = plan.get("entry").and_then(JsonValue::as_str) {
            mentions.push(entry.to_string());
        }
    }
    if let Some(branch) = event.get("branch").and_then(|b| b.get("node")).and_then(JsonValue::as_str) {
        mentions.push(branch.to_string());
    }
    mentions
}

/// 试跑判定（结构化结果：通过/拒绝理由/崩溃/终态/关键路径）。
#[derive(Debug, Clone, PartialEq)]
pub struct CanaryVerdict {
    pub passed: bool,
    pub reasons: Vec<String>,
    pub crashed: bool,
    pub terminal: bool,
    pub key_path_reached: bool,
}

/// 试跑驱动钩子（stub 回合经此发起；装配接线到引擎 op 通道的
/// stub 试跑形态）。
pub trait CanaryRoundDriver: Send + Sync {
    fn run_stub_round(
        &self,
        spec: &CanarySpec,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>>;
}

/// 试跑编排（宿主侧入口）：图检查 → stub 回合 → 结果判定。
///
/// stub 回合经 `driver` 发起（装配注入）；驱动失败（装配未接线/
/// 引擎不可用）视为试跑拒绝 + 原因留痕（不替代判定）。
pub async fn orchestrate_canary(
    spec: &CanarySpec,
    driver: &dyn CanaryRoundDriver,
) -> CanaryRunOutcome {
    let graph_violations = validate_canary_graph(&spec.graph).unwrap_or_else(|err| vec![err.to_string()]);
    if !graph_violations.is_empty() {
        let verdict = judge_canary_outcome("", &[], spec, &graph_violations);
        return CanaryRunOutcome {
            verdict,
            events: Vec::new(),
            reason: "rejected".to_string(),
        };
    }
    let run = driver.run_stub_round(spec).await;
    match run {
        Ok(outcome) => {
            let reason = outcome
                .get("reason")
                .and_then(JsonValue::as_str)
                .unwrap_or("error")
                .to_string();
            let events: Vec<JsonValue> = outcome
                .get("events")
                .and_then(JsonValue::as_array)
                .cloned()
                .unwrap_or_default();
            let verdict = judge_canary_outcome(&reason, &events, spec, &graph_violations);
            CanaryRunOutcome {
                verdict,
                events,
                reason,
            }
        }
        Err(err) => CanaryRunOutcome {
            verdict: CanaryVerdict {
                passed: false,
                reasons: vec![format!("试跑驱动失败: {err}")],
                crashed: true,
                terminal: false,
                key_path_reached: false,
            },
            events: Vec::new(),
            reason: "driver_error".to_string(),
        },
    }
}

/// 试跑执行结果（判定 + 事件流 + 终止原因；判定拒绝时 reason 留痕）。
#[derive(Debug, Clone, PartialEq)]
pub struct CanaryRunOutcome {
    pub verdict: CanaryVerdict,
    pub events: Vec<JsonValue>,
    pub reason: String,
}

/// 经引擎 op 通道发起 stub 试跑回合（run/resume 既有语义）。
///
/// 引擎侧 stub 回合 = stub LLM + 候选图实例化，复用
/// `execute_round_to_reply` 的回合驱动；接线名称：
/// engine.canary_stub_round（graph + workflow 建图实例化，入参从
/// CanarySpec 取：graph/entry（试跑输入）/stub_reply（缺省回复））。
/// workflow 未注入（CanarySpec.workflow = None）= 结构化错误——图数据
/// 不含工作流规格，无法实例化步骤节点，不静默降级。
pub async fn run_canary_via_engine(
    spec: &CanarySpec,
) -> Result<JsonValue, String> {
    let workflow = spec
        .workflow
        .clone()
        .ok_or_else(|| "试跑声明缺 workflow 数据（stub 回合须携带工作流规格）".to_string())?;
    call_engine_op_async(
        "engine.canary_stub_round",
        serde_json::json!({
            "graph": spec.graph.clone(),
            "workflow": workflow,
            "input": spec.entry.clone(),
            "default_reply": spec.stub_reply.clone(),
        }),
    )
    .await
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

    fn research_graph() -> JsonValue {
        seed_file("graph.json")
    }

    fn event(event_type: &str, extra: serde_json::Value) -> JsonValue {
        let mut value = serde_json::json!({ "type": event_type });
        if let serde_json::Value::Object(map) = &mut value {
            for (key, item) in extra.as_object().cloned().unwrap_or_default() {
                map.insert(key, item);
            }
        }
        value
    }

    #[test]
    fn seed_graph_is_valid_and_maps_to_spec() {
        let graph = research_graph();
        let viols = validate_canary_graph(&graph).expect("图数据形态应可检查");
        assert!(viols.is_empty(), "graph.json 应合法: {:?}", viols);
        let spec = canary_spec_from(graph, None, "stub 缺省回复").expect("试跑声明装配成功");
        assert_eq!(spec.entry, "research_orchestrator");
        assert_eq!(spec.key_path.len(), 3, "缺省关键路径 = 全节点集");
    }

    #[test]
    fn dangling_edge_and_missing_entry_are_rejected() {
        let graph = serde_json::json!({
            "entry": "ghost_entry",
            "nodes": [
                {"id": "collect", "type": "collect"},
                {"id": "parse", "type": "parse"}
            ],
            "edges": [
                {"source": "collect", "target": "unknown_target"}
            ]
        });
        let viols = validate_canary_graph(&graph).expect("形态合法（内容违规走清单）");
        assert_eq!(viols.len(), 2, "入口越界 + 边引用未知节点: {:?}", viols);
        assert!(viols.iter().any(|v| v.contains("入口")));
        assert!(viols.iter().any(|v| v.contains("未知节点")));
    }

    #[test]
    fn graph_without_nodes_is_invalid_structurally() {
        let graph = serde_json::json!({ "entry": "x" });
        assert!(validate_canary_graph(&graph).is_err());
    }

    #[test]
    fn clean_run_reaches_terminal_and_key_path() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["research_orchestrator".to_string(), "tool_pipeline".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let events = vec![
            event("plan_start", serde_json::json!({"plan": {"entry": "research_orchestrator", "steps": [{"node": "research_orchestrator"}, {"node": "tool_pipeline"}]}})),
            event("thinking_start", serde_json::json!({"node": "tool_pipeline"})),
            event("reply_token", serde_json::json!({"text": "闭环"})),
        ];
        let verdict = judge_canary_outcome("reply", &events, &spec, &[]);
        assert!(verdict.passed, "干净试跑应通过: {:?}", verdict.reasons);
        assert!(verdict.terminal);
        assert!(!verdict.crashed);
        assert!(verdict.key_path_reached);
    }

    #[test]
    fn crash_event_rejects_run() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["research_orchestrator".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let events = vec![
            event("plan_start", serde_json::json!({"plan": {"entry": "research_orchestrator", "steps": [{"node": "research_orchestrator"}], "nodes": []}})),
            event("error", serde_json::json!({"node": "research_orchestrator", "message": "谓词引擎初始化失败"})),
        ];
        let verdict = judge_canary_outcome("error", &events, &spec, &[]);
        assert!(!verdict.passed);
        assert!(verdict.crashed);
        assert!(verdict.reasons.iter().any(|r| r.contains("崩溃")));
    }

    #[test]
    fn non_terminal_reason_rejects_even_without_crash() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["research_orchestrator".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let events = vec![event(
            "thinking_start",
            serde_json::json!({"node": "research_orchestrator"}),
        )];
        let verdict = judge_canary_outcome("interrupted", &events, &spec, &[]);
        assert!(!verdict.passed);
        assert!(!verdict.crashed, "中断不等于崩溃");
        assert!(verdict.reasons.iter().any(|r| r.contains("终态")));
    }

    #[test]
    fn missing_key_path_node_rejects_clean_run() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["end".to_string(), "tool_pipeline".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let events = vec![
            event("plan_start", serde_json::json!({"plan": {"entry": "research_orchestrator", "steps": [{"node": "tool_pipeline"}], "nodes": []}})),
            event("reply_token", serde_json::json!({"text": "ok"})),
        ];
        let verdict = judge_canary_outcome("reply", &events, &spec, &[]);
        assert!(!verdict.passed);
        assert!(!verdict.terminal || !verdict.key_path_reached);
        assert!(verdict.reasons.iter().any(|r| r.contains("关键路径")));
    }

    #[test]
    fn graph_violations_reject_even_with_clean_run() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["research_orchestrator".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let gang = vec!["节点集空".to_string()];
        let verdict = judge_canary_outcome("reply", &[], &spec, &gang);
        assert!(!verdict.passed);
        assert!(verdict.reasons.iter().any(|r| r.contains("非法")));
    }

    struct FakeDriver {
        outcome: Result<JsonValue, String>,
    }

    impl CanaryRoundDriver for FakeDriver {
        fn run_stub_round(
            &self,
            _spec: &CanarySpec,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<JsonValue, String>> + Send + '_>> {
            let outcome = self.outcome.clone();
            Box::pin(async move { outcome })
        }
    }

    #[tokio::test]
    async fn orchestration_passes_on_clean_driver_run() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["tool_pipeline".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let driver = FakeDriver {
            outcome: Ok(serde_json::json!({
                "reason": "reply",
                "events": [
                    {"type": "plan_start", "plan": {"entry": "research_orchestrator", "steps": [{"node": "tool_pipeline"}]}},
                    {"type": "reply_token", "text": "闭环"},
                ],
            })),
        };
        let outcome = orchestrate_canary(&spec, &driver).await;
        assert!(outcome.verdict.passed, "编排应通过: {:?}", outcome.verdict.reasons);
        assert_eq!(outcome.reason, "reply");
        assert!(!outcome.events.is_empty());
    }

    #[tokio::test]
    async fn orchestration_rejects_driver_failure_with_reason() {
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["tool_pipeline".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let driver = FakeDriver {
            outcome: Err("引擎未装配".to_string()),
        };
        let outcome = orchestrate_canary(&spec, &driver).await;
        assert!(!outcome.verdict.passed);
        assert_eq!(outcome.reason, "driver_error");
        assert!(outcome.verdict.reasons[0].contains("驱动失败"));
    }

    #[tokio::test]
    async fn orchestration_rejects_illegal_graph_before_round() {
        let spec = CanarySpec {
            graph: serde_json::json!({
                "entry": "ghost",
                "nodes": [{"id": "collect", "type": "collect"}],
                "edges": [{"source": "collect", "target": "ghost"}],
            }),
            entry: "ghost".to_string(),
            key_path: vec!["collect".to_string()],
            stub_reply: "ok".to_string(),
            workflow: None,
        };
        let driver = FakeDriver {
            outcome: Ok(serde_json::json!({"reason": "reply", "events": []})),
        };
        let outcome = orchestrate_canary(&spec, &driver).await;
        assert!(!outcome.verdict.passed);
        assert!(outcome.verdict.reasons.iter().any(|r| r.contains("非法")));
        assert_eq!(outcome.reason, "rejected");
        assert!(outcome.events.is_empty(), "图非法不发起试跑");
    }

    #[test]
    fn op_channel_fails_closed_without_engine() {
        // 无引擎环境：stub 回合经操作通道失败 = 结构化错误（运行时
        // 未装配），不再返回占位文案
        let _serial = crate::engine::host::bridge_guard();
        let spec = CanarySpec {
            graph: research_graph(),
            entry: "research_orchestrator".to_string(),
            key_path: vec!["tool_pipeline".to_string()],
            stub_reply: "ok".to_string(),
            workflow: Some(seed_file("workflow.json")),
        };
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(run_canary_via_engine(&spec));
        assert!(result.is_err());
        assert!(!result.unwrap_err().contains("需 op"));
        // 缺 workflow = 域侧结构化错误（图数据不含工作流规格，不静默降级）
        let bare = CanarySpec {
            workflow: None,
            ..spec.clone()
        };
        let err = runtime.block_on(run_canary_via_engine(&bare));
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("workflow"));
    }
}

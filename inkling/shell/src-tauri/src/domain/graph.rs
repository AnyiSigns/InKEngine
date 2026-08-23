//! graph 域：通用图配方——workflow.json 泛型解析 + 节点类型注册映射 +
//! 回合图装配侧「图配方描述数据 + 校验」。
//!
//! 引擎图 DSL 以函数式节点为最小单元；本模块把两个通用节点类型
//! （research_orchestrator / tool_pipeline）的注册映射与节点行为的数据
//! 形态落地为确定性描述——图 = 数据，AI 可改图拓扑（HARNESS 补丁）。
//! 引擎侧的 Graph 构造经 `crate::engine::host::call_engine_op` 操作通道
//! 或由 boot.rs 装配接线，本模块只产出图配方描述数据与校验结论，
//! 不在本侧构造引擎对象。
//!
//! 装配侧回合图形态（与 legacy graph_recipe.build_round_graph 同语义）：
//! graph.json（入口/边/出口）+ workflow.json 节点实例化——工作流步骤
//! 以 tool_pipeline 类型物化（节点 id = 工具名），末步骤连到图出口，
//! 计划步引用这些节点名即可执行。
//!
//! 依赖纪律：本模块不直接调用其它域模块；节点注册/建图经
//! [`crate::engine::host::call_engine_op`] 操作通道（接线点文档标注）。

use std::collections::HashSet;

use serde_json::{json, Value as JsonValue};

use super::common::DomainError;

// ── 图节点类型名（graph.json 引用；与引擎注册表约定同源）──

/// 研究编排节点类型（返回 __plan__/__spawn__/__simulate__ 保留键）。
pub const TYPE_ORCHESTRATOR: &str = "research_orchestrator";
/// 工具流水线编排节点类型（统一工具分发，按配置执行或消费 pending）。
pub const TYPE_TOOL_PIPELINE: &str = "tool_pipeline";

// ── 编排脚本的状态通道键（回合入口状态注入，测试/宿主驱动确定性编排）──

/// 编排脚本通道（plan/spawns/simulate 保留键的载体）。
pub const STATE_ORCHESTRATE: &str = "orchestrate";
/// 步骤参数通道（按工具名分段的参数声明）。
pub const STATE_STEP_ARGS: &str = "step_args";
/// 工具结果通道（工具名 → 结果文本）。
pub const STATE_RESULTS: &str = "results";
/// 消息流通道（工具结果以 tool 角色消息回填）。
pub const STATE_MESSAGES: &str = "messages";
/// 待执行工具调用清单通道（工具调用留痕内联行的队列）。
pub const STATE_PENDING: &str = "pending";

/// 工具结果回填消息流的截断上限（上下文体积有界）。
pub const TOOL_RESULT_MAX_CHARS: usize = 4000;

// ── 工作流规格（workflow.json 泛型解析形态）──

/// 工作流节点声明（类型名透传，配置原样保留）。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowNodeSpec {
    pub id: String,
    pub type_name: String,
    pub config: JsonValue,
}

impl WorkflowNodeSpec {
    pub fn from_json(data: &JsonValue) -> Result<Self, DomainError> {
        let obj = data
            .as_object()
            .ok_or_else(|| DomainError::InvalidData("workflow 节点须为对象".to_string()))?;
        let id = obj
            .get("id")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| DomainError::InvalidData("workflow 节点缺 id（字符串）".to_string()))?;
        Ok(Self {
            id: id.to_string(),
            type_name: obj
                .get("type")
                .and_then(JsonValue::as_str)
                .unwrap_or(TYPE_TOOL_PIPELINE)
                .to_string(),
            config: obj
                .get("config")
                .cloned()
                .filter(|v| v.is_object())
                .unwrap_or_else(|| json!({})),
        })
    }
}

/// 工作流边声明（来源节点 → 目标节点）。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowEdgeSpec {
    pub source: String,
    pub target: String,
}

/// 工作流规格：节点清单 + 边清单 + 可选显式入口。
#[derive(Debug, Clone, PartialEq)]
pub struct WorkflowSpec {
    pub name: String,
    pub nodes: Vec<WorkflowNodeSpec>,
    pub edges: Vec<WorkflowEdgeSpec>,
    pub entry: Option<String>,
}

impl WorkflowSpec {
    pub fn to_json(&self) -> JsonValue {
        json!({
            "name": self.name,
            "nodes": self.nodes.iter().map(|n| json!({
                "id": n.id,
                "type": n.type_name,
                "config": n.config,
            })).collect::<Vec<_>>(),
            "edges": self.edges.iter().map(|e| json!({
                "source": e.source,
                "target": e.target,
            })).collect::<Vec<_>>(),
            "entry": self.entry,
        })
    }
}

/// workflow.json → WorkflowSpec（节点类型名透传，配置原样保留）。
pub fn workflow_spec_from_data(data: &JsonValue) -> Result<WorkflowSpec, DomainError> {
    let obj = data
        .as_object()
        .ok_or_else(|| DomainError::InvalidData("workflow.json 须为对象".to_string()))?;
    let mut nodes = Vec::new();
    let mut seen = HashSet::new();
    for raw in obj.get("nodes").and_then(JsonValue::as_array).unwrap_or(&Vec::new()) {
        let node = WorkflowNodeSpec::from_json(raw)?;
        if !seen.insert(node.id.clone()) {
            return Err(DomainError::InvalidData(format!(
                "workflow 节点 id 重复: {}",
                node.id
            )));
        }
        nodes.push(node);
    }
    let mut edges = Vec::new();
    for raw in obj.get("edges").and_then(JsonValue::as_array).unwrap_or(&Vec::new()) {
        let source = raw
            .get("source")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| DomainError::InvalidData("workflow 边缺 source".to_string()))?
            .to_string();
        let target = raw
            .get("target")
            .and_then(JsonValue::as_str)
            .ok_or_else(|| DomainError::InvalidData("workflow 边缺 target".to_string()))?
            .to_string();
        edges.push(WorkflowEdgeSpec { source, target });
    }
    Ok(WorkflowSpec {
        name: obj
            .get("name")
            .and_then(JsonValue::as_str)
            .unwrap_or("workflow")
            .to_string(),
        nodes,
        edges,
        entry: obj.get("entry").and_then(JsonValue::as_str).map(str::to_string),
    })
}

/// 工作流规格校验（建图前的确定性检查目标）。
///
/// 校验项（与引擎工作流编译的建图期校验对齐，本侧先做数据级前置）：
/// 节点 id 重复/边引用未知节点/入口指向未知节点——发现即返回违规清单。
pub fn validate_workflow(spec: &WorkflowSpec) -> Vec<String> {
    let mut errors = Vec::new();
    let mut ids: HashSet<&str> = HashSet::new();
    for node in &spec.nodes {
        if !ids.insert(node.id.as_str()) {
            errors.push(format!("节点 id 重复: {}", node.id));
        }
    }
    for edge in &spec.edges {
        if !ids.contains(edge.source.as_str()) {
            errors.push(format!("边引用未知节点: {} -> {}", edge.source, edge.target));
        }
        if !ids.contains(edge.target.as_str()) {
            errors.push(format!("边引用未知节点: {} -> {}", edge.source, edge.target));
        }
    }
    if let Some(entry) = &spec.entry {
        if !ids.contains(entry.as_str()) {
            errors.push(format!("入口节点不存在: {entry}"));
        }
    }
    errors
}

// ── 节点类型注册映射（声明形记录：装配侧据此接线 op）──

/// 两个通用节点类型的注册映射（类型名 → 声明形描述数据）。
///
/// 描述数据含「节点行为语义」的可读形态——装配侧经操作通道把类型
/// 工厂挂进引擎注册表（注册幂等：重复登记无害）；节点执行时持有的
/// 工具表/流水线经实时持有者取用（挂载/补丁演化后重建引擎即刷新）。
pub fn node_type_definitions(workflow: &WorkflowSpec) -> JsonValue {
    json!({
        "nodes": [
            {
                "type": TYPE_ORCHESTRATOR,
                "default_plan": true,
                "plan_steps": orchestrator_default_plan(workflow),
                "note": "研究编排节点：返回 __plan__/__spawn__/__simulate__ 保留键；plan 的约束域 = workflow.json",
            },
            {
                "type": TYPE_TOOL_PIPELINE,
                "config_roles": ["pipeline", "terminal"],
                "note": "工具流水线编排节点：统一工具分发（内省/自指/声明式三路由），按配置执行或消费 pending",
            },
        ],
    })
}

/// 编排缺省规划（state.orchestrate 脚本缺席时按工作流节点序产出）。
///
/// `__plan__` 数据形态 = 每步一个节点的顺序步骤清单。
pub fn orchestrator_default_plan(workflow: &WorkflowSpec) -> JsonValue {
    JsonValue::Array(
        workflow
            .nodes
            .iter()
            .map(|node| json!({ "nodes": [node.id] }))
            .collect(),
    )
}

/// 工具结果消息（tool 角色，回填消息流供模型/展示消费）。
pub fn tool_result_message(text: &str, tool_call_id: &str) -> JsonValue {
    let mut content = text.to_string();
    if content.len() > TOOL_RESULT_MAX_CHARS {
        content.truncate(TOOL_RESULT_MAX_CHARS);
        content.push_str("\n…（已截断）");
    }
    json!({
        "role": "tool",
        "content": content,
        "tool_call_id": tool_call_id,
    })
}

/// 工具参数解析（state.step_args 同名项或配置缺省值，缺省 = 空对象）。
pub fn pipeline_args_for(config: &JsonValue, state: &JsonValue) -> JsonValue {
    let tool = config.get("tool").and_then(JsonValue::as_str);
    let some_tool = tool.map(str::to_string);
    let step_args = state
        .get(STATE_STEP_ARGS)
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(tool_name) = some_tool {
        if let Some(args) = step_args.get(&tool_name) {
            if args.is_object() || args.is_array() {
                return args.clone();
            }
        }
    }
    config
        .get("args")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

/// 待执行清单头项（state.pending 首项；命名工具调用留痕的消费形态）。
#[derive(Debug, Clone, PartialEq)]
pub struct PendingCall {
    pub name: String,
    pub args: JsonValue,
    pub call_id: String,
}

/// 消费 pending 首项：参数可以是对象或 JSON 字符串（工具留痕的两种形态）。
pub fn pipeline_pending_head(state: &JsonValue) -> Option<PendingCall> {
    let pending = state.get(STATE_PENDING)?.as_array()?;
    let call = pending.first()?.as_object()?;
    let name = call
        .get("name")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    if name.is_empty() {
        return None;
    }
    let mut args = call
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(text) = args.as_str() {
        args = serde_json::from_str(text).unwrap_or_else(|_| json!({}));
    }
    let call_id = call
        .get("id")
        .and_then(JsonValue::as_str)
        .unwrap_or(&name)
        .to_string();
    Some(PendingCall { name, args, call_id })
}

/// 待执行清单消费的增量（消息流回填 + pending 出队；头项非工具形态
/// 或清单空 = 无增量）。
pub fn pipeline_pending_delta(state: &JsonValue, tool_text: &str) -> JsonValue {
    let Some(head) = pipeline_pending_head(state) else {
        return json!({});
    };
    let mut messages = state
        .get(STATE_MESSAGES)
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    messages.push(tool_result_message(tool_text, &head.call_id));
    let mut pending = state
        .get(STATE_PENDING)
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    if pending.is_empty() {
        return json!({});
    }
    pending.remove(0);
    json!({
        STATE_MESSAGES: messages,
        STATE_PENDING: pending,
    })
}

/// 工具结果回填增量（配置指定工具形态：state.results 的更新段）。
pub fn pipeline_results_delta(state: &JsonValue, tool: &str, text: &str) -> JsonValue {
    let mut results = state
        .get(STATE_RESULTS)
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Some(map) = results.as_object_mut() {
        map.insert(tool.to_string(), JsonValue::String(text.to_string()));
    }
    json!({ STATE_RESULTS: results })
}

// ── 回合图装配侧描述（graph.json + workflow.json → 图配方描述数据）──

/// 回合图配方描述（装配侧产出的数据形态；引擎侧 Graph 构造经 op 通道）。
#[derive(Debug, Clone, PartialEq)]
pub struct RoundGraphRecipe {
    /// graph.json 原始数据（入口/边/出口；类型按注册表解析）。
    pub graph: JsonValue,
    /// 工作流规格（节点/边/入口的解析产物）。
    pub workflow: WorkflowSpec,
    /// 工作流步骤节点的 tool_pipeline 实例化清单（config.tool = 节点 id）。
    pub pipeline_nodes: Vec<WorkflowNodeSpec>,
    /// 步骤链边（按工作流边序衔接）。
    pub workflow_edges: Vec<WorkflowEdgeSpec>,
    /// 末步骤连到图出口的边（图出口缺失 = None）。
    pub exit_edge: Option<WorkflowEdgeSpec>,
}

impl RoundGraphRecipe {
    /// 消息流入口状态（回合注入形态：orchestrate 脚本 + step_args 通道）。
    pub fn entry_state(&self) -> JsonValue {
        json!({ STATE_ORCHESTRATE: json!({ "plan": orchestrator_default_plan(&self.workflow) }) })
    }
}

/// 按 graph.json 建回合图 + workflow.json 节点实例化的装配侧描述。
///
/// 建图步骤（与 legacy build_round_graph 同语义）：
/// 1. graph.json 数据形态确认（入口/边/出口，类型按注册表解析）；
/// 2. workflow.json 每个步骤节点以 tool_pipeline 类型物化
///    （config.tool = 节点 id，即领域工具名），步骤链边按工作流边序
///    衔接，末步骤连到图出口——计划步引用这些节点名即可执行。
///
/// 校验失败 = 数据级错误显式返回（不静默建残缺图）。
pub fn build_round_graph(
    graph_data: &JsonValue,
    workflow_data: &JsonValue,
) -> Result<RoundGraphRecipe, DomainError> {
    let graph_obj = graph_data
        .as_object()
        .ok_or_else(|| DomainError::InvalidData("graph.json 须为对象".to_string()))?;
    if graph_obj.get("entry").and_then(JsonValue::as_str).is_none() {
        return Err(DomainError::InvalidData("graph.json 缺 entry（图入口节点）".to_string()));
    }
    let workflow = workflow_spec_from_data(workflow_data)?;
    let workflow_errors = validate_workflow(&workflow);
    if !workflow_errors.is_empty() {
        return Err(DomainError::InvalidData(format!(
            "workflow.json 校验未通过: {}",
            workflow_errors.join("；")
        )));
    }
    let pipeline_nodes: Vec<WorkflowNodeSpec> = workflow
        .nodes
        .iter()
        .map(|node| WorkflowNodeSpec {
            id: node.id.clone(),
            type_name: TYPE_TOOL_PIPELINE.to_string(),
            config: json!({ "tool": node.id, "note": "工作流步骤节点：以工具名执行" }),
        })
        .collect();
    let exit_edge = if workflow.nodes.is_empty() {
        None
    } else {
        graph_obj
            .get("exits")
            .and_then(JsonValue::as_array)
            .and_then(|exits| exits.first())
            .and_then(JsonValue::as_str)
            .map(|exit| WorkflowEdgeSpec {
                source: workflow
                    .nodes
                    .last()
                    .map(|n| n.id.clone())
                    .unwrap_or_default(),
                target: exit.to_string(),
            })
    };
    Ok(RoundGraphRecipe {
        graph: graph_data.clone(),
        workflow_edges: workflow.edges.clone(),
        pipeline_nodes,
        workflow,
        exit_edge,
    })
}

// ── 节点注册 / 建图（引擎操作通道接线点）──

/// 把两个通用节点类型注册进引擎装配注册表（幂等：重复登记无害）。
///
/// 注册只发生一次（注册表对重复登记 fail-fast，防静默覆盖）；工具表
/// 与流水线持有者在每次建图时刷新——节点执行时取到的是实时工具表与
/// 实时流水线。
///
/// 接线点：引擎侧节点类型注册经操作通道完成——
/// 需 op: graph.register_node_types（节点类型注册待通道扩展）。
pub async fn register_node_types(recipe: &RoundGraphRecipe) -> Result<JsonValue, String> {
    let _ = recipe;
    // 操作通道注册后经 call_engine_op 转发：
    // call_engine_op("graph.register_node_types", node_type_definitions(&recipe.workflow))
    Err(
        "需 op: graph.register_node_types —— 节点类型注册待引擎操作通道扩展后接线（boot.rs 装配）"
            .to_string(),
    )
}

/// 按图配方描述数据在引擎侧构造回合图。
///
/// 图构造经操作通道（建图校验在引擎侧触发完整编译校验）：
/// 需 op: graph.build_round_graph（引擎 Graph 构造待通道扩展）。
pub async fn build_round_graph_engine(recipe: &RoundGraphRecipe) -> Result<JsonValue, String> {
    let _ = recipe;
    Err(
        "需 op: graph.build_round_graph —— 引擎 Graph 构造待操作通道扩展后接线（boot.rs 装配）"
            .to_string(),
    )
}

// ── 工具函数 ──

fn string_list_from(value: &JsonValue) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GRAPH_JSON: &str = include_str!("../../../../../inkling/seed_data/graph.json");
    const WORKFLOW_JSON: &str = include_str!("../../../../../inkling/seed_data/workflow.json");

    fn seed_graph() -> JsonValue {
        serde_json::from_str(GRAPH_JSON).unwrap()
    }

    fn seed_workflow() -> JsonValue {
        serde_json::from_str(WORKFLOW_JSON).unwrap()
    }

    #[test]
    fn workflow_spec_parses_seed_data_generically() {
        let spec = workflow_spec_from_data(&seed_workflow()).unwrap();
        assert_eq!(spec.name, "inkling.research_workflow");
        assert_eq!(spec.nodes.len(), 6);
        assert_eq!(spec.edges.len(), 5);
        assert_eq!(spec.entry.as_deref(), Some("collect_material"));
        assert_eq!(spec.nodes[0].id, "collect_material");
        assert_eq!(spec.nodes[0].type_name, "collect_material");
        assert_eq!(spec.nodes[0].config["note"], "采集（文本/URL 取回）");
        // 类型缺省回落 tool_pipeline（泛型解析的缺省规则）
        let bare = json!({"name": "bare", "nodes": [{"id": "step_a"}]});
        let bare_spec = workflow_spec_from_data(&bare).unwrap();
        assert_eq!(bare_spec.nodes[0].type_name, TYPE_TOOL_PIPELINE);
    }

    #[test]
    fn workflow_parse_rejects_duplicate_and_missing_shape() {
        let dup = json!({"nodes": [{"id": "a"}, {"id": "a"}]});
        let err = workflow_spec_from_data(&dup).unwrap_err();
        assert!(err.to_string().contains("重复"));
        let missing = json!({"nodes": [{"type": "x"}]});
        assert!(workflow_spec_from_data(&missing).is_err());
    }

    #[test]
    fn workflow_validation_finds_dangling_edges_and_bad_entry() {
        let spec = workflow_spec_from_data(&json!({
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [{"source": "a", "target": "ghost"}],
            "entry": "nope",
        }))
        .unwrap();
        let errors = validate_workflow(&spec);
        assert!(errors.iter().any(|e| e.contains("ghost")));
        assert!(errors.iter().any(|e| e.contains("入口")));
        let clean = workflow_spec_from_data(&seed_workflow()).unwrap();
        assert!(validate_workflow(&clean).is_empty());
    }

    #[test]
    fn orchestrator_default_plan_is_stepwise_sequence() {
        let spec = workflow_spec_from_data(&seed_workflow()).unwrap();
        let plan = orchestrator_default_plan(&spec);
        assert_eq!(plan.as_array().unwrap().len(), 6);
        assert_eq!(plan[0], json!({"nodes": ["collect_material"]}));
        assert_eq!(plan[5], json!({"nodes": ["distill_knowledge"]}));
    }

    #[test]
    fn node_type_definitions_carry_two_generic_types() {
        let spec = workflow_spec_from_data(&seed_workflow()).unwrap();
        let defs = node_type_definitions(&spec);
        let nodes = defs["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(defs["nodes"][0]["type"], TYPE_ORCHESTRATOR);
        assert_eq!(defs["nodes"][1]["type"], TYPE_TOOL_PIPELINE);
        assert_eq!(
            defs["nodes"][0]["plan_steps"].as_array().unwrap().len(),
            spec.nodes.len()
        );
    }

    #[test]
    fn tool_result_message_is_tool_role_and_truncated() {
        let message = tool_result_message("执行完成", "call-1");
        assert_eq!(message["role"], "tool");
        assert_eq!(message["tool_call_id"], "call-1");
        assert_eq!(message["content"], "执行完成");
        let long = "x".repeat(5000);
        let truncated = tool_result_message(&long, "call-2");
        assert!(
            truncated["content"].as_str().unwrap().chars().count() <= TOOL_RESULT_MAX_CHARS + 10,
            "截断后体积有界"
        );
        assert!(truncated["content"].as_str().unwrap().contains("已截断"));
    }

    #[test]
    fn pipeline_args_resolution_prefers_step_args_then_config() {
        let config = json!({"tool": "collect_material", "args": {"fallback": true}});
        let state_with_args = json!({"step_args": {"collect_material": {"source": "text"}}});
        assert_eq!(
            pipeline_args_for(&config, &state_with_args),
            json!({"source": "text"})
        );
        assert_eq!(
            pipeline_args_for(&config, &json!({})),
            json!({"fallback": true})
        );
        // URL 其它工具的 step_args 不串台：回落配置缺省
        assert_eq!(
            pipeline_args_for(&config, &json!({"step_args": {"other": {}}})),
            json!({"fallback": true})
        );
        // 无配置缺省且 step_args 无命中 = 空对象
        let bare_config = json!({"tool": "collect_material"});
        assert_eq!(pipeline_args_for(&bare_config, &json!({})), json!({}));
    }

    #[test]
    fn pipeline_pending_head_parses_call_and_string_arguments() {
        let state = json!({
            "pending": [{"name": "python_exec", "id": "call-9", "arguments": "{\"code\": \"print(1)\"}"}]
        });
        let head = pipeline_pending_head(&state).expect("应有头项");
        assert_eq!(head.name, "python_exec");
        assert_eq!(head.args, json!({"code": "print(1)"}));
        assert_eq!(head.call_id, "call-9");
        // 非对象 arguments 兜底为空对象
        let broken = json!({"pending": [{"name": "x", "arguments": "not json"}]});
        assert_eq!(pipeline_pending_head(&broken).unwrap().args, json!({}));
        // 空清单 / 缺 name = 无头项
        assert!(pipeline_pending_head(&json!({"pending": []})).is_none());
        assert!(pipeline_pending_head(&json!({"pending": [{"id": "no-name"}]})).is_none());
    }

    #[test]
    fn pipeline_pending_delta_dequeues_and_fills_messages() {
        let state = json!({
            "messages": [{"role": "user", "content": "请执行"}],
            "pending": [{"name": "collect_material", "id": "c1"}],
        });
        let delta = pipeline_pending_delta(&state, "材料已取回");
        let messages = delta[STATE_MESSAGES].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "c1");
        assert_eq!(delta[STATE_PENDING].as_array().unwrap().len(), 0);
        // 空清单 = 无增量（不产半截消息流）
        assert_eq!(pipeline_pending_delta(&json!({"pending": []}), "x"), json!({}));
    }

    #[test]
    fn pipeline_results_delta_accumulates_by_tool() {
        let state = json!({"results": {"parse_material": "已解析"}});
        let delta = pipeline_results_delta(&state, "collect_material", "已取回");
        assert_eq!(delta[STATE_RESULTS]["collect_material"], "已取回");
        assert_eq!(delta[STATE_RESULTS]["parse_material"], "已解析");
    }

    #[test]
    fn round_graph_recipe_assembles_seed_shapes() {
        let recipe = build_round_graph(&seed_graph(), &seed_workflow()).unwrap();
        assert_eq!(recipe.workflow.nodes.len(), 6);
        assert_eq!(recipe.pipeline_nodes.len(), 6);
        assert_eq!(recipe.pipeline_nodes[0].type_name, TYPE_TOOL_PIPELINE);
        assert_eq!(recipe.pipeline_nodes[0].config["tool"], "collect_material");
        assert_eq!(recipe.workflow_edges.len(), 5);
        // 末步骤连到图出口（exits[0] = end）
        let exit = recipe.exit_edge.as_ref().expect("应有出口边");
        assert_eq!(exit.source, "distill_knowledge");
        assert_eq!(exit.target, "end");
        // 入口状态：缺省 plan = 顺序步骤清单
        let state = recipe.entry_state();
        assert_eq!(
            state[STATE_ORCHESTRATE]["plan"].as_array().unwrap().len(),
            6
        );
    }

    #[test]
    fn round_graph_recipe_validation_errors() {
        // 图缺 entry = 数据级错误
        let err = build_round_graph(&json!({"nodes": {}}), &seed_workflow()).unwrap_err();
        assert!(err.to_string().contains("entry"));
        // 工作流悬空边 = 校验错误
        let bad_workflow = json!({
            "nodes": [{"id": "a"}],
            "edges": [{"source": "a", "target": "b"}],
        });
        let err = build_round_graph(&seed_graph(), &bad_workflow).unwrap_err();
        assert!(err.to_string().contains("校验未通过"));
        // 无节点工作流：无出口边（不产残缺边）
        let empty_workflow = json!({"nodes": []});
        let recipe = build_round_graph(&seed_graph(), &empty_workflow).unwrap();
        assert!(recipe.exit_edge.is_none());
    }

    #[test]
    fn register_node_types_is_wiring_point_not_implemented() {
        // 接线点语义：操作通道扩展前显式失败（不静默假装已注册）
        let recipe = build_round_graph(&seed_graph(), &seed_workflow()).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt.block_on(register_node_types(&recipe));
        assert!(err.is_err());
        let err = rt.block_on(build_round_graph_engine(&recipe));
        assert!(err.is_err());
    }

    #[test]
    fn string_list_helper_ignores_non_strings() {
        assert_eq!(string_list_from(&json!(["a", 1, null, "b"])), vec!["a", "b"]);
    }
}

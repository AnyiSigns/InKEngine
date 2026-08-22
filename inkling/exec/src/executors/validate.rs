//! 校验执行体：声明式规则引擎（谓词 ↔ rules.json 数据绑定）。
//!
//! 与引擎 ink_engine/core/rules.py 同构：规则 = 纯数据（谓词名 + 参数），
//! 执行语义 = 注册谓词。谓词名是数据与执行件的绑定锚点——rules.json 里
//! 引用的每个谓词名都必须在这里有实现（tests/binding.rs 做不漂移断言）。
//! 执行语义对齐引擎：target_path 点分取值、iterate_items 逐条、谓词异常
//! fail-open 跳过并留痕（broken = 规则失效，样例闸门据此拒绝静默失效
//! 的规则）、未知谓词 = 声明错误显式报错而非静默跳过。

use crate::json::{object_from_pairs, Object, Value};
use crate::tool::ToolError;
use crate::tool::ToolErrorKind;

/// 已实现谓词名清单（绑定锚点：rules.json 引用的谓词 ⊆ 此清单）。
pub const KNOWN_PREDICATES: &[&str] = &[
    "present",
    "absent",
    "equals",
    "not_equals",
    "compare",
    "in_enum",
    "not_in_enum",
    "contains",
    "not_contains",
    "unique_pairs",
    "truthy",
    "falsy",
    "state_transition",
];

pub fn schema() -> Value {
    crate::tool::schema_of(
        vec![
            (
                "data",
                object_from_pairs(vec![
                    ("type", Value::String("object".to_string())),
                    ("description", Value::String("待校验的数据对象".to_string())),
                ]),
            ),
            (
                "context",
                object_from_pairs(vec![
                    ("type", Value::String("object".to_string())),
                    (
                        "description",
                        Value::String("评估上下文（透传谓词）".to_string()),
                    ),
                ]),
            ),
            (
                "rule_set",
                crate::tool::string_schema("规则集名（缺省 = 数据文件中的规则集）"),
            ),
        ],
        vec!["data"],
    )
}

/// 一条规则违规（可序列化，审核卡 conflicts 字段的可对齐单元）。
#[derive(Debug, Clone)]
struct Issue {
    rule_id: String,
    kind: String,
    severity: String,
    message: String,
    entity_type: Option<String>,
    entity_id: Option<Value>,
}

/// 谓词执行失败（fail-open：跳过该规则并留痕，不阻断整体评估）。
#[derive(Debug)]
struct PredicateError(String);

/// 谓词签名：目标值 + 规则 config + 评估 context → 违规清单。
type Predicate = fn(&Value, &Object, &Object) -> Result<Vec<Issue>, PredicateError>;

struct Rule {
    id: String,
    predicate: String,
    config: Object,
    rule_type: String,
    target_path: Option<String>,
    iterate_items: bool,
    severity: String,
    kind: String,
    entity_type: Option<String>,
}

struct RuleSet {
    name: String,
    rules: Vec<Rule>,
}

/// 规则评估结果（违规 + 跳过/失效留痕——fail-open 可审计）。
#[derive(Debug)]
struct CheckResult {
    issues: Vec<Issue>,
    skipped: Vec<(String, String)>,
    broken: Vec<(String, String)>,
    checked: usize,
}

impl CheckResult {
    fn has_hard_conflict(&self) -> bool {
        self.issues.iter().any(|i| i.severity == "error")
    }
}

// -- 数据形态解析（RuleSet.from_dict 同语义：构造即校验） ---------------

fn parse_rule_set(value: &Value) -> Result<RuleSet, String> {
    let obj = value
        .as_object()
        .ok_or_else(|| "规则集声明非法: 期望对象".to_string())?;
    let name = obj
        .get_str("name")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "规则集缺 name（字符串）".to_string())?;
    let raw_rules = obj
        .get_array("rules")
        .ok_or_else(|| "规则集缺 rules 清单".to_string())?;
    let mut rules = Vec::with_capacity(raw_rules.len());
    let mut seen: Vec<String> = Vec::new();
    for raw in raw_rules {
        let rule = parse_rule(raw)?;
        if seen.contains(&rule.id) {
            return Err(format!("规则集 {} 规则 id 重复: {}", name, rule.id));
        }
        seen.push(rule.id.clone());
        if !KNOWN_PREDICATES.contains(&rule.predicate.as_str()) {
            return Err(format!(
                "规则集 {} 引用了未注册的谓词: {}（规则 {}）",
                name, rule.predicate, rule.id
            ));
        }
        rules.push(rule);
    }
    Ok(RuleSet {
        name: name.to_string(),
        rules,
    })
}

fn parse_rule(raw: &Value) -> Result<Rule, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "规则声明非法: 期望对象".to_string())?;
    let rule_id = obj
        .get_str("id")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "规则声明缺 id（字符串）".to_string())?;
    let predicate = obj
        .get_str("predicate")
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("规则 {} 缺 predicate（字符串）", rule_id))?;
    let config = match obj.get("config") {
        Some(Value::Object(o)) => o.clone(),
        Some(_) => {
            return Err(format!("规则 {} 的 config 须为 dict", rule_id));
        }
        None => Object::new(),
    };
    let rule_type = obj.get_str("type").unwrap_or("constraint");
    if rule_type != "constraint" && rule_type != "transition" {
        return Err(format!(
            "规则 {} 的类型非法: {:?}（仅 constraint/transition）",
            rule_id, rule_type
        ));
    }
    let severity = obj.get_str("severity").unwrap_or("error");
    if severity != "error" && severity != "warning" {
        return Err(format!(
            "规则 {} 的严重度非法: {:?}（仅 error/warning）",
            rule_id, severity
        ));
    }
    let target_path = obj.get_str("target_path").map(|s| s.to_string());
    let iterate_items = obj.get_bool("iterate_items").unwrap_or(false);
    Ok(Rule {
        id: rule_id.to_string(),
        predicate: predicate.to_string(),
        config,
        rule_type: rule_type.to_string(),
        target_path,
        iterate_items,
        severity: severity.to_string(),
        kind: obj.get_str("kind").unwrap_or("rule").to_string(),
        entity_type: obj.get_str("entity_type").map(|s| s.to_string()),
    })
}

// -- 点分路径取值（与引擎 _get_path 同语义） ----------------------------

/// 点分路径取值：对象键/数组下标逐段解析；缺失或非法返回 None
/// （「字段缺失 = 规则不适用」由引擎跳过）。下划线前缀段拒绝访问
/// （受限数据访问，不暴露内部字段——与引擎一致）。
fn get_path<'a>(target: &'a Value, path: Option<&str>) -> Option<&'a Value> {
    let path = path?;
    if path.is_empty() {
        return Some(target);
    }
    let mut current = target;
    for segment in path.split('.') {
        if segment.starts_with('_') {
            return None;
        }
        match current {
            Value::Object(obj) => {
                current = obj.get(segment)?;
            }
            Value::Array(items) => {
                let index: usize = segment.parse().ok()?;
                current = items.get(index)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

// -- 内置通用谓词（确定性、零 LLM 调用，与引擎谓词语义一一对应） ---------

fn issue(config: &Object, default_message: &str) -> Issue {
    Issue {
        rule_id: String::new(),
        kind: String::new(),
        severity: String::new(),
        message: config
            .get_str("message")
            .unwrap_or(default_message)
            .to_string(),
        entity_type: None,
        entity_id: config.get("entity_id").cloned(),
    }
}

fn set_rule_meta(mut issue: Issue, rule: &Rule) -> Issue {
    issue.rule_id = rule.id.clone();
    issue.kind = rule.kind.clone();
    issue.severity = rule.severity.clone();
    issue.entity_type = rule.entity_type.clone();
    issue
}

fn pred_present(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let path = config.get_str("path");
    if get_path(target, path).is_none() {
        Ok(vec![issue(
            config,
            &format!("字段缺失: {}", path.unwrap_or("<root>")),
        )])
    } else {
        Ok(vec![])
    }
}

fn pred_absent(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let path = config.get_str("path");
    if get_path(target, path).is_some() {
        Ok(vec![issue(
            config,
            &format!("字段不应存在: {}", path.unwrap_or("<root>")),
        )])
    } else {
        Ok(vec![])
    }
}

fn pred_equals(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let path = config.get_str("path");
    let expected = config
        .get("value")
        .ok_or_else(|| PredicateError("equals 谓词缺 value 取值".to_string()))?;
    let actual = get_path(target, path);
    if actual.is_some_and(|v| Value::value_cmp_eq(v, expected)) {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 不等于期望值 {:?}",
                path.unwrap_or("<root>"),
                expected
            ),
        )])
    }
}

fn pred_not_equals(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let path = config.get_str("path");
    let forbidden = config
        .get("value")
        .ok_or_else(|| PredicateError("not_equals 谓词缺 value 取值".to_string()))?;
    let actual = get_path(target, path);
    if actual.is_some_and(|v| Value::value_cmp_eq(v, forbidden)) {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 等于禁止值 {:?}",
                path.unwrap_or("<root>"),
                forbidden
            ),
        )])
    } else {
        Ok(vec![])
    }
}

fn pred_compare(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let op = config
        .get_str("op")
        .ok_or_else(|| PredicateError("compare 谓词缺 op".to_string()))?;
    if !matches!(op, "lt" | "lte" | "gt" | "gte" | "eq" | "ne") {
        return Err(PredicateError(format!("compare 谓词的 op 非法: {:?}", op)));
    }
    let left = get_path(target, config.get_str("path"));
    let right = if let Some(other) = config.get_str("other_path") {
        get_path(target, Some(other))
    } else {
        config.get("value")
    };
    // 任一侧缺失/不可比较 = 规则不适用（跳过，不误报）
    let (Some(l), Some(r)) = (left, right) else {
        return Ok(vec![]);
    };
    let matched = match (l, r) {
        (Value::Number(x), Value::Number(y)) => match op {
            "lt" => x < y,
            "lte" => x <= y,
            "gt" => x > y,
            "gte" => x >= y,
            "eq" => x == y,
            _ => x != y,
        },
        // 非数值形态走深比较（eq/ne 可用；有序比较 = 类型不可比，跳过）
        _ => match op {
            "eq" => Value::value_cmp_eq(l, r),
            "ne" => !Value::value_cmp_eq(l, r),
            _ => return Ok(vec![]),
        },
    };
    if matched {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} ({:?}) 不满足 {} {:?}",
                config.get_str("path").unwrap_or("<root>"),
                l,
                op,
                r
            ),
        )])
    }
}

fn enum_values(config: &Object, what: &str) -> Result<Vec<Value>, PredicateError> {
    match config.get("values") {
        Some(Value::Array(items)) if !items.is_empty() => Ok(items.clone()),
        _ => Err(PredicateError(format!("{} 谓词缺非空 values 清单", what))),
    }
}

fn pred_in_enum(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let values = enum_values(config, "in_enum")?;
    let value = get_path(target, config.get_str("path"));
    if value.is_some_and(|v| values.iter().any(|item| Value::value_cmp_eq(item, v))) {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 取值 {:?} 不在合法集内",
                config.get_str("path").unwrap_or("<root>"),
                value
            ),
        )])
    }
}

fn pred_not_in_enum(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let values = enum_values(config, "not_in_enum")?;
    let value = get_path(target, config.get_str("path"));
    if value.is_some_and(|v| values.iter().any(|item| Value::value_cmp_eq(item, v))) {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 取值 {:?} 在禁止集内",
                config.get_str("path").unwrap_or("<root>"),
                value
            ),
        )])
    } else {
        Ok(vec![])
    }
}

fn contains_hit(haystack: &Value, needle: &Value) -> bool {
    match (haystack, needle) {
        (Value::String(h), Value::String(n)) => h.contains(n.as_str()),
        (Value::Array(items), n) => items.iter().any(|i| Value::value_cmp_eq(i, n)),
        // 对象「包含」= 键包含（与引擎 dict 语义一致）
        (Value::Object(obj), Value::String(k)) => obj.get(k).is_some(),
        _ => false,
    }
}

fn pred_contains(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let haystack = get_path(target, config.get_str("path"));
    let needle = config
        .get("value")
        .ok_or_else(|| PredicateError("contains 谓词缺 value 取值".to_string()))?;
    if haystack.is_some_and(|h| contains_hit(h, needle)) {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 不含 {:?}",
                config.get_str("path").unwrap_or("<root>"),
                needle
            ),
        )])
    }
}

fn pred_not_contains(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let haystack = get_path(target, config.get_str("path"));
    let needle = config
        .get("value")
        .ok_or_else(|| PredicateError("not_contains 谓词缺 value 取值".to_string()))?;
    if haystack.is_some_and(|h| contains_hit(h, needle)) {
        Ok(vec![issue(
            config,
            &format!(
                "字段 {} 含禁止值 {:?}",
                config.get_str("path").unwrap_or("<root>"),
                needle
            ),
        )])
    } else {
        Ok(vec![])
    }
}

fn pred_unique_pairs(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let keys = match config.get("keys") {
        Some(Value::Array(items))
            if !items.is_empty() && items.iter().all(|k| k.as_str().is_some()) =>
        {
            items
                .iter()
                .map(|k| k.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        }
        _ => {
            return Err(PredicateError(
                "unique_pairs 谓词缺非空字符串 keys 清单".to_string(),
            ))
        }
    };
    let Value::Array(items) = target else {
        return Ok(vec![]); // 非集合形态 = 规则不适用
    };
    let entity_key = config
        .get_str("entity_id_key")
        .unwrap_or_else(|| keys.last().map(String::as_str).unwrap_or(""))
        .to_string();
    let mut seen: Vec<Vec<u8>> = Vec::new();
    let mut issues = Vec::new();
    for item in items {
        let mut pair = Vec::with_capacity(keys.len() * 8);
        let mut missing = false;
        for key in &keys {
            match get_path(item, Some(key)) {
                Some(v) => pair.extend_from_slice(&v.canonical_bytes()),
                None => {
                    // 键字段缺失的条目不参与唯一性（缺键 = 数据不完整）
                    missing = true;
                    break;
                }
            }
        }
        if missing {
            continue;
        }
        if seen.contains(&pair) {
            let entity = get_path(item, Some(&entity_key))
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => crate::json::serialize(other),
                })
                .map(Value::String);
            issues.push(Issue {
                rule_id: String::new(),
                kind: String::new(),
                severity: String::new(),
                message: format!("条目组合 {:?} 重复登记", pair),
                entity_type: None,
                entity_id: entity,
            });
        } else {
            seen.push(pair);
        }
    }
    Ok(issues)
}

fn pred_truthy(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let value = get_path(target, config.get_str("path"));
    if value.is_some_and(|v| !is_falsy(v)) {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!("字段 {} 应为真", config.get_str("path").unwrap_or("<root>")),
        )])
    }
}

/// 假值判定（与 Python 真值语义对齐：空串/空集合/0/null/布尔假）。
fn is_falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => *n == 0.0,
        Value::String(s) => s.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(obj) => obj.is_empty(),
    }
}

fn pred_falsy(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    let value = get_path(target, config.get_str("path"));
    if value.is_some_and(is_falsy) {
        Ok(vec![])
    } else {
        Ok(vec![issue(
            config,
            &format!("字段 {} 应为假", config.get_str("path").unwrap_or("<root>")),
        )])
    }
}

fn pred_state_transition(
    target: &Value,
    config: &Object,
    _ctx: &Object,
) -> Result<Vec<Issue>, PredicateError> {
    // 状态清单键为 states（与引擎 state_transition 谓词 config 契约一致）
    let states = match config.get("states") {
        Some(Value::Array(items)) if !items.is_empty() => items.clone(),
        _ => {
            return Err(PredicateError(
                "state_transition 谓词缺非空 states 清单".to_string(),
            ))
        }
    };
    let valid_states: Vec<String> = states
        .iter()
        .filter_map(|s| s.as_str().map(|s| s.to_string()))
        .collect();
    let terminal: Vec<String> = match config.get("terminal_states") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|s| s.as_str().map(|s| s.to_string()))
            .collect(),
        _ => Vec::new(),
    };
    let allowed: Vec<(String, String)> = match config.get("allowed") {
        Some(Value::Object(obj)) => {
            let mut pairs = Vec::new();
            for (from, dsts) in obj.iter() {
                if let Some(items) = dsts.as_array() {
                    for dst in items {
                        if let Some(d) = dst.as_str() {
                            pairs.push((from.to_string(), d.to_string()));
                        }
                    }
                }
            }
            pairs
        }
        _ => Vec::new(),
    };
    let to_state = match get_path(target, config.get_str("to_path")) {
        Some(Value::String(s)) => s.clone(),
        _ => return Ok(vec![]), // 目标状态缺失 = 规则不适用
    };
    // 判定顺序与引擎 StateMachine.is_illegal_transition 一致：
    // 1. 目标状态不在合法集 → 非法；2. 前态是终态 → 非法；
    // 3. 声明了白名单且前态非初始（None）且不在白名单 → 非法
    let illegal = if !valid_states.contains(&to_state) {
        true
    } else {
        match get_path(target, config.get_str("from_path")) {
            Some(Value::String(from)) => {
                terminal.contains(from)
                    || (!allowed.is_empty()
                        && !allowed.iter().any(|(f, t)| *f == *from && *t == to_state))
            }
            _ => false, // 初始写入（无前态）不受白名单约束
        }
    };
    if illegal {
        let from = get_path(target, config.get_str("from_path"))
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => crate::json::serialize(other),
            })
            .unwrap_or_else(|| "无前态".to_string());
        Ok(vec![issue(
            config,
            &format!("非法状态转换: {} -> {}（违反状态机规则）", from, to_state),
        )])
    } else {
        Ok(vec![])
    }
}

// -- 谓词注册表 ----------------------------------------------------------

fn predicate_of(name: &str) -> Option<Predicate> {
    match name {
        "present" => Some(pred_present),
        "absent" => Some(pred_absent),
        "equals" => Some(pred_equals),
        "not_equals" => Some(pred_not_equals),
        "compare" => Some(pred_compare),
        "in_enum" => Some(pred_in_enum),
        "not_in_enum" => Some(pred_not_in_enum),
        "contains" => Some(pred_contains),
        "not_contains" => Some(pred_not_contains),
        "unique_pairs" => Some(pred_unique_pairs),
        "truthy" => Some(pred_truthy),
        "falsy" => Some(pred_falsy),
        "state_transition" => Some(pred_state_transition),
        _ => None,
    }
}

// -- 评估引擎（与引擎 RuleEngine.evaluate 同语义） ------------------------

fn evaluate(rule_set: &RuleSet, data: &Value, context: &Object) -> CheckResult {
    let mut issues = Vec::new();
    let mut skipped = Vec::new();
    let mut broken = Vec::new();
    let mut checked = 0usize;
    for rule in &rule_set.rules {
        // 引擎同语义：非 constraint/transition 类型的声明不可执行（解析期
        // 已拒绝，此处防御性留痕——声明数据若绕过解析直接进评估不静默）
        if rule.rule_type != "constraint" && rule.rule_type != "transition" {
            skipped.push((
                rule.id.clone(),
                format!("规则类型不可执行: {}", rule.rule_type),
            ));
            continue;
        }
        let Some(predicate) = predicate_of(&rule.predicate) else {
            skipped.push((
                rule.id.clone(),
                format!("未知谓词: {}（声明错误，应建图期暴露）", rule.predicate),
            ));
            broken.push((rule.id.clone(), format!("未知谓词: {}", rule.predicate)));
            continue;
        };
        let target = get_path(data, rule.target_path.as_deref());
        if target.is_none() && rule.target_path.is_some() {
            skipped.push((
                rule.id.clone(),
                format!(
                    "目标路径不存在: {}",
                    rule.target_path.as_deref().unwrap_or("")
                ),
            ));
            continue;
        }
        let target = target.unwrap_or(data);
        if rule.iterate_items {
            let items = match target {
                Value::Object(obj) => obj.iter().map(|(_, v)| v).collect::<Vec<_>>(),
                Value::Array(list) => list.iter().collect::<Vec<_>>(),
                _ => {
                    skipped.push((
                        rule.id.clone(),
                        "目标非集合（iterate_items 需集合形态）".to_string(),
                    ));
                    continue;
                }
            };
            checked += 1;
            for item in items {
                evaluate_once(
                    predicate,
                    item,
                    rule,
                    context,
                    &mut issues,
                    &mut skipped,
                    &mut broken,
                );
            }
        } else {
            checked += 1;
            evaluate_once(
                predicate,
                target,
                rule,
                context,
                &mut issues,
                &mut skipped,
                &mut broken,
            );
        }
    }
    CheckResult {
        issues,
        skipped,
        broken,
        checked,
    }
}

fn evaluate_once(
    predicate: Predicate,
    target: &Value,
    rule: &Rule,
    context: &Object,
    issues: &mut Vec<Issue>,
    skipped: &mut Vec<(String, String)>,
    broken: &mut Vec<(String, String)>,
) {
    match predicate(target, &rule.config, context) {
        Ok(raw_issues) => {
            for raw in raw_issues {
                // 缺 message = 谓词产出畸形（规则失效留痕）
                if raw.message.is_empty() {
                    let reason = "谓词违规缺 message";
                    skipped.push((rule.id.clone(), reason.to_string()));
                    broken.push((rule.id.clone(), reason.to_string()));
                    continue;
                }
                issues.push(set_rule_meta(raw, rule));
            }
        }
        Err(PredicateError(reason)) => {
            // fail-open：谓词异常跳过该规则并留痕（增强护栏不是写门禁）
            let note = format!("谓词执行异常（fail-open 跳过）: {}", reason);
            skipped.push((rule.id.clone(), note.clone()));
            broken.push((rule.id.clone(), note));
        }
    }
}

// -- 工具入口 ------------------------------------------------------------

/// inkling_validate：参数 {data: 对象, context?: 对象, rule_set?: 名称}。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let data = args.get("data").ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::InvalidParams,
            "缺 data（待校验对象）".to_string(),
        )
    })?;
    let context = args.get_object("context").cloned().unwrap_or_default();

    let rules_value = crate::data::load_json_file("rules.json")
        .map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;
    let rule_set =
        parse_rule_set(&rules_value).map_err(|e| ToolError::new(ToolErrorKind::ToolError, e))?;

    let result = evaluate(&rule_set, data, &context);
    let issues: Vec<Value> = result
        .issues
        .iter()
        .map(|i| {
            let mut pairs = vec![
                ("rule_id", Value::String(i.rule_id.clone())),
                ("kind", Value::String(i.kind.clone())),
                ("severity", Value::String(i.severity.clone())),
                ("message", Value::String(i.message.clone())),
            ];
            if let Some(entity_type) = &i.entity_type {
                pairs.push(("entity_type", Value::String(entity_type.clone())));
            }
            if let Some(entity_id) = &i.entity_id {
                pairs.push(("entity_id", entity_id.clone()));
            }
            object_from_pairs(pairs)
        })
        .collect();
    let skipped: Vec<Value> = result
        .skipped
        .iter()
        .map(|(id, reason)| {
            Value::Array(vec![
                Value::String(id.clone()),
                Value::String(reason.clone()),
            ])
        })
        .collect();
    let broken: Vec<Value> = result
        .broken
        .iter()
        .map(|(id, reason)| {
            Value::Array(vec![
                Value::String(id.clone()),
                Value::String(reason.clone()),
            ])
        })
        .collect();

    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("rule_set", Value::String(rule_set.name)),
        ("checked", Value::Number(result.checked as f64)),
        ("issues", Value::Array(issues)),
        ("skipped", Value::Array(skipped)),
        ("broken", Value::Array(broken)),
        ("has_hard_conflict", Value::Bool(result.has_hard_conflict())),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn check(data: &str) -> CheckResult {
        let rules_value = crate::data::load_json_file("rules.json").unwrap();
        let rule_set = parse_rule_set(&rules_value).unwrap();
        evaluate(&rule_set, &parse(data).unwrap(), &Object::new())
    }

    #[test]
    fn valid_entry_passes_all_rules() {
        let data = r#"{
            "title": "溯源方法论", "title_length": 6, "kind": "insight",
            "source": "model", "evidence": "证据", "text": "普通文本。",
            "credibility": 0.8, "count": 2, "limit": 5,
            "tags": [{"tag": "方法"}, {"tag": "溯源"}],
            "from_state": "draft", "to_state": "reviewing"
        }"#;
        let result = check(data);
        assert!(result.issues.is_empty(), "违规: {:?}", result.issues);
        assert!(result.broken.is_empty(), "失效: {:?}", result.broken);
    }

    #[test]
    fn missing_title_reports_completeness() {
        let result = check(r#"{"kind": "rule", "source": "model", "evidence": "证据"}"#);
        assert!(result.issues.iter().any(|i| i.kind == "completeness"));
    }

    #[test]
    fn terminal_escape_reports_lifecycle() {
        let result = check(r#"{"from_state": "archived", "to_state": "reviewing"}"#);
        assert!(result.issues.iter().any(|i| i.kind == "lifecycle"));
    }

    #[test]
    fn duplicate_tags_reports_schema() {
        let result = check(r#"{"tags": [{"tag": "机制"}, {"tag": "机制"}]}"#);
        assert!(result.issues.iter().any(|i| i.kind == "schema"));
    }
}

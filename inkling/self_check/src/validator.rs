//! JSON Schema 子集检查器（零依赖，覆盖 seed_data 全部 schema 关键字）。
//!
//! 支持关键字：type（含联合类型数组）/ properties / required /
//! additionalProperties（false = 多余字段违规）/ items / minItems /
//! maxItems / uniqueItems / enum / const / pattern / minLength /
//! minimum / maximum / $ref（仅 "#/definitions/<名>" 形态，随 schema 内联）。
//! 未知关键字忽略（schema 演进宽容），与引擎侧 SchemaValidator 的
//! 校验哲学同构；校验顺序固定为：类型 → 枚举/常量 → 字符串约束 →
//! 数值边界 → 对象结构 → 数组结构，违规消息带数据路径可直接定位修复。

use serde_json::Value;
use std::collections::HashMap;

/// Schema 定义本身非法（$ref 指向不存在的 definitions 等）。
#[derive(Debug)]
pub struct SchemaError(pub String);

impl std::fmt::Display for SchemaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// JSON Schema 子集校验器：schema 以 `serde_json::Value` 形态传入，
/// 对实例做深度校验，违规逐条写入 `out`。
pub struct MiniValidator {
    defs: HashMap<String, Value>,
}

impl MiniValidator {
    pub fn new(schema: &Value) -> Result<Self, SchemaError> {
        let defs = match schema.get("definitions") {
            Some(Value::Object(map)) => map
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
            _ => HashMap::new(),
        };
        let validator = Self { defs };
        // 根节点 $ref 立即解析（schema 定义合法性在构造期确认）
        validator.resolve(schema)?;
        Ok(validator)
    }

    fn resolve<'a>(&'a self, node: &'a Value) -> Result<&'a Value, SchemaError> {
        let Some(reference) = node.get("$ref").and_then(Value::as_str) else {
            return Ok(node);
        };
        let name = reference
            .strip_prefix("#/definitions/")
            .ok_or_else(|| SchemaError(format!("不支持的 $ref 形态: {reference:?}（仅 #/definitions/<名>）")))?;
        self.defs
            .get(name)
            .ok_or_else(|| SchemaError(format!("$ref 指向不存在的 definitions: {name:?}")))
    }

    /// 按单节点 schema 校验实例，违规消息追加到 `out`（空 = 通过）。
    pub fn validate(&self, instance: &Value, node: &Value, path: &str, out: &mut Vec<String>) {
        let schema = match self.resolve(node) {
            Ok(schema) => schema,
            Err(err) => {
                out.push(format!("{path}: schema 定义非法——{err}"));
                return;
            }
        };
        let path_text = if path.is_empty() { "$" } else { path };

        let raw_type = schema.get("type");
        if let Some(raw_type) = raw_type {
            let expected: Vec<&str> = match raw_type {
                Value::String(kind) => vec![kind.as_str()],
                Value::Array(kinds) => kinds
                    .iter()
                    .filter_map(Value::as_str)
                    .collect(),
                _ => Vec::new(),
            };
            if !expected.is_empty() && !expected.iter().any(|kind| type_ok(instance, kind)) {
                out.push(format!(
                    "{path_text} 类型错误: 期望 {raw_type}，收到 {}",
                    kind_name(instance)
                ));
                return;
            }
        }

        if let Some(constant) = schema.get("const") {
            if instance != constant {
                out.push(format!(
                    "{path_text} 取值错误: 期望常量 {constant:?}，收到 {instance:?}"
                ));
            }
        }
        if let Some(Value::Array(choices)) = schema.get("enum") {
            if !choices.contains(instance) {
                out.push(format!(
                    "{path_text} 取值非法: {instance:?}（仅允许 {choices:?}）"
                ));
            }
        }

        if let Some(text) = instance.as_str() {
            if let Some(min_len) = schema.get("minLength").and_then(Value::as_u64) {
                if (text.chars().count() as u64) < min_len {
                    out.push(format!(
                        "{path_text} 字符串过短: {} < {min_len}（空值/过短边界）",
                        text.chars().count()
                    ));
                }
            }
            if let Some(Value::String(pattern)) = schema.get("pattern") {
                if !pattern_matches(pattern, text) {
                    out.push(format!(
                        "{path_text} 不满足模式约束: {pattern:?}（实际 {:?}）",
                        text.chars().take(40).collect::<String>()
                    ));
                }
            }
        }

        if is_number(instance) {
            if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64) {
                if number_f64(instance) < minimum {
                    out.push(format!("{path_text} 低于下限: {} < {minimum}", number_f64(instance)));
                }
            }
            if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64) {
                if number_f64(instance) > maximum {
                    out.push(format!("{path_text} 超过上限: {} > {maximum}", number_f64(instance)));
                }
            }
        }

        if let Value::Object(map) = instance {
            if let Some(Value::Array(required)) = schema.get("required") {
                for field in required.iter().filter_map(Value::as_str) {
                    if !map.contains_key(field) {
                        out.push(format!("{path_text} 缺失必填字段: {field}"));
                    }
                }
            }
            let props = schema.get("properties").and_then(Value::as_object);
            if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                let declared: Vec<&String> = props
                    .map(|p| p.keys().collect())
                    .unwrap_or_default();
                let extras: Vec<&String> = map.keys().filter(|k| !declared.contains(k)).collect();
                if !extras.is_empty() {
                    out.push(format!(
                        "{path_text} 存在未声明字段（多余字段）: {extras:?}"
                    ));
                }
            }
            if let Some(props) = props {
                for (key, value) in map.iter() {
                    if let Some(sub_schema) = props.get(key) {
                        self.validate(value, sub_schema, &format!("{path_text}.{key}"), out);
                    }
                }
            }
        }

        if let Value::Array(items) = instance {
            if let Some(min_items) = schema.get("minItems").and_then(Value::as_u64) {
                if (items.len() as u64) < min_items {
                    out.push(format!(
                        "{path_text} 数组过短（空值边界）: {} < {min_items}",
                        items.len()
                    ));
                }
            }
            if let Some(max_items) = schema.get("maxItems").and_then(Value::as_u64) {
                if (items.len() as u64) > max_items {
                    out.push(format!(
                        "{path_text} 数组过长: {} > {max_items}",
                        items.len()
                    ));
                }
            }
            if schema.get("uniqueItems") == Some(&Value::Bool(true)) && !unique_items(items) {
                out.push(format!("{path_text} 存在重复元素"));
            }
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    self.validate(item, item_schema, &format!("{path_text}[{index}]"), out);
                }
            }
        }
    }
}

fn type_ok(instance: &Value, kind: &str) -> bool {
    match kind {
        "object" => instance.is_object(),
        "array" => instance.is_array(),
        "string" => instance.is_string(),
        "boolean" => instance.is_boolean(),
        "number" => is_number(instance),
        "integer" => is_integer(instance),
        "null" => instance.is_null(),
        _ => false,
    }
}

fn is_number(value: &Value) -> bool {
    matches!(value, Value::Number(_))
}

fn is_integer(value: &Value) -> bool {
    value.as_i64().is_some() || value.as_u64().is_some()
}

fn number_f64(value: &Value) -> f64 {
    value.as_f64().unwrap_or(f64::NAN)
}

fn kind_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// 唯一性判定：数组元素两两不等（JSON 值相等语义）。
fn unique_items(items: &[Value]) -> bool {
    for (index, item) in items.iter().enumerate() {
        if items.iter().skip(index + 1).any(|other| other == item) {
            return false;
        }
    }
    true
}

// ── 模式匹配子集（覆盖 seed_data 全部 pattern 关键字）──
//
// 支持形态：^ 开头锚 / $ 结尾锚 / 字面字符（含 \. 转义）/ 字符类
// [a-z0-9_-]（区间 + 连字符）/ 量词 *、+、{n}。判定 = 全串匹配
// （与 re.fullmatch 语义一致，pattern 均带首尾锚）。

#[derive(Debug, Clone, PartialEq)]
enum Atom {
    Literal(char),
    Class(Vec<char>),
}

#[derive(Debug, Clone)]
struct Piece {
    atom: Atom,
    quant: Quant,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Quant {
    One,
    Star,
    Plus,
    Repeat(usize),
}

fn parse_pattern(pattern: &str) -> Result<Vec<Piece>, String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut index = 0;
    let mut pieces = Vec::new();
    while index < chars.len() {
        let atom = match chars[index] {
            '^' if index == 0 => {
                index += 1;
                continue;
            }
            '$' if index == chars.len() - 1 => {
                index += 1;
                continue;
            }
            '\\' => {
                index += 1;
                let literal = *chars
                    .get(index)
                    .ok_or_else(|| format!("pattern 尾部孤立转义: {pattern}"))?;
                index += 1;
                Atom::Literal(literal)
            }
            '[' => {
                index += 1;
                let mut members = Vec::new();
                let mut closed = false;
                while index < chars.len() {
                    let c = chars[index];
                    if c == ']' {
                        closed = true;
                        index += 1;
                        break;
                    }
                    // 区间形态 起始-终止（'a-z'、'0-9'）；'-' 后跟 ']' 或单字符时按字面处理
                    if index + 2 < chars.len() && chars[index + 1] == '-' && chars[index + 2] != ']' {
                        let start = c;
                        let end = chars[index + 2];
                        if start > end {
                            return Err(format!("pattern 字符类区间倒置: {pattern}"));
                        }
                        for code in (start as u32)..=(end as u32) {
                            if let Some(expanded) = char::from_u32(code) {
                                members.push(expanded);
                            }
                        }
                        index += 3;
                        continue;
                    }
                    members.push(c);
                    index += 1;
                }
                if !closed {
                    return Err(format!("pattern 字符类未闭合: {pattern}"));
                }
                Atom::Class(members)
            }
            other => {
                index += 1;
                Atom::Literal(other)
            }
        };
        let quant = match chars.get(index) {
            Some('*') => {
                index += 1;
                Quant::Star
            }
            Some('+') => {
                index += 1;
                Quant::Plus
            }
            Some('{') => {
                let mut end = index + 1;
                while end < chars.len() && chars[end] != '}' {
                    end += 1;
                }
                if end >= chars.len() {
                    return Err(format!("pattern 量词未闭合: {pattern}"));
                }
                let body: String = chars[index + 1..end].iter().collect();
                let count: usize = body
                    .parse()
                    .map_err(|_| format!("pattern 量词非法: {pattern}"))?;
                index = end + 1;
                Quant::Repeat(count)
            }
            _ => Quant::One,
        };
        pieces.push(Piece { atom, quant });
    }
    Ok(pieces)
}

fn atom_matches(atom: &Atom, ch: char) -> bool {
    match atom {
        Atom::Literal(expected) => *expected == ch,
        Atom::Class(members) => members.contains(&ch),
    }
}

/// 子集模式匹配：全串判定（^…$ 锚定语义）。
pub fn pattern_matches(pattern: &str, text: &str) -> bool {
    let Ok(pieces) = parse_pattern(pattern) else {
        return false;
    };
    let chars: Vec<char> = text.chars().collect();
    let mut states = vec![false; chars.len() + 1];
    states[0] = true;
    for piece in &pieces {
        let mut next = vec![false; chars.len() + 1];
        match piece.quant {
            Quant::One => {
                for pos in 0..chars.len() {
                    if states[pos] && atom_matches(&piece.atom, chars[pos]) {
                        next[pos + 1] = true;
                    }
                }
            }
            Quant::Repeat(count) => {
                for start in 0..=chars.len() {
                    if !states[start] {
                        continue;
                    }
                    let mut end = start;
                    for _ in 0..count {
                        if end < chars.len() && atom_matches(&piece.atom, chars[end]) {
                            end += 1;
                        } else {
                            break;
                        }
                    }
                    if end - start == count {
                        next[end] = true;
                    }
                }
            }
            Quant::Star | Quant::Plus => {
                let min = if piece.quant == Quant::Plus { 1 } else { 0 };
                for start in 0..=chars.len() {
                    if !states[start] {
                        continue;
                    }
                    let mut end = start;
                    while end < chars.len() && atom_matches(&piece.atom, chars[end]) {
                        end += 1;
                    }
                    for reached in (start + min)..=end {
                        next[reached] = true;
                    }
                }
            }
        }
        states = next;
    }
    states[chars.len()]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pattern_subset_matches_expected_forms() {
        assert!(pattern_matches("^[a-z][a-z0-9_]*$", "collect_material"));
        assert!(pattern_matches("^[a-z][a-z0-9_-]*$", "inkling-exec"));
        assert!(!pattern_matches("^[a-z][a-z0-9_]*$", "9abc"));
        assert!(!pattern_matches("^[a-z][a-z0-9_]*$", "has-dash"));
        assert!(pattern_matches("^[0-9]+\\.[0-9]+\\.[0-9]+$", "0.1.0"));
        assert!(!pattern_matches("^[0-9]+\\.[0-9]+\\.[0-9]+$", "0.1"));
        assert!(pattern_matches("^#[0-9a-fA-F]{6}$", "#09090b"));
        assert!(!pattern_matches("^#[0-9a-fA-F]{6}$", "#09090"));
        assert!(pattern_matches("^[a-z]+$", "abc"));
        assert!(!pattern_matches("^[a-z]+$", ""));
    }

    fn fixture_validator() -> MiniValidator {
        MiniValidator::new(&json!({
            "type": "object",
            "required": ["name", "count"],
            "additionalProperties": false,
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "count": {"type": "integer", "minimum": 0},
                "mode": {"type": "string", "enum": ["a", "b"]},
                "items": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string"}},
                "child": {"$ref": "#/definitions/child"}
            },
            "definitions": {"child": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}}
        }))
        .expect("夹具 schema 应合法")
    }

    fn violations(validator: &MiniValidator, schema: &Value, instance: &Value) -> Vec<String> {
        let mut out = Vec::new();
        validator.validate(instance, schema, "fixture", &mut out);
        out
    }

    #[test]
    fn positive_ok_yields_no_violation() {
        let validator = fixture_validator();
        let schema = &serde_json::json!({
            "type": "object",
            "required": ["name", "count"],
            "additionalProperties": false,
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "count": {"type": "integer", "minimum": 0},
                "mode": {"type": "string", "enum": ["a", "b"]},
                "items": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string"}},
                "child": {"$ref": "#/definitions/child"}
            },
            "definitions": {"child": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}}
        });
        let instance = json!({"name": "x", "count": 0, "mode": "a", "items": ["i"], "child": {"id": "c"}});
        assert_eq!(violations(&validator, schema, &instance), Vec::<String>::new());
    }

    #[test]
    fn negative_fixtures_hit_exactly_once() {
        let validator = fixture_validator();
        let schema = &serde_json::json!({
            "type": "object",
            "required": ["name", "count"],
            "additionalProperties": false,
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "count": {"type": "integer", "minimum": 0},
                "mode": {"type": "string", "enum": ["a", "b"]},
                "items": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string"}},
                "child": {"$ref": "#/definitions/child"}
            },
            "definitions": {"child": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}}
        });
        let cases = [
            (json!({"count": 1}), "missing_required"),
            (json!({"name": "x", "count": 1, "extra": true}), "extra_field"),
            (json!({"name": 1, "count": 1}), "wrong_type"),
            (json!({"name": "x", "count": 1, "mode": "z"}), "enum_violation"),
            (json!({"name": "", "count": 1}), "empty_string"),
            (json!({"name": "x", "count": -1}), "below_minimum"),
            (json!({"name": "x", "count": 1, "items": []}), "empty_array"),
            (json!({"name": "x", "count": 1, "items": ["a", "a"]}), "duplicate_items"),
            (json!({"name": "x", "count": 1, "child": {}}), "ref_missing_required"),
        ];
        for (instance, label) in cases {
            let hits = violations(&validator, schema, &instance);
            assert_eq!(hits.len(), 1, "夹具 {label} 应精确命中 1 条违规: {hits:?}");
        }
    }

    #[test]
    fn bad_ref_is_rejected() {
        let result = MiniValidator::new(&json!({"$ref": "#/definitions/ghost"}));
        assert!(result.is_err(), "指向不存在 definitions 的 $ref 应报错");
    }

    #[test]
    fn union_type_and_number_vs_integer() {
        let union_schema = json!({"type": ["object", "null"]});
        let validator = MiniValidator::new(&union_schema).expect("合法");
        assert_eq!(violations(&validator, &union_schema, &json!({"a": 1})), Vec::<String>::new());
        assert_eq!(violations(&validator, &union_schema, &json!(null)), Vec::<String>::new());
        assert_eq!(violations(&validator, &union_schema, &json!("s")).len(), 1);

        let number_schema = json!({"type": "number"});
        let number_check = MiniValidator::new(&number_schema).expect("合法");
        assert_eq!(violations(&number_check, &number_schema, &json!(1.5)), Vec::<String>::new());
        let integer_schema = json!({"type": "integer"});
        let integer_check = MiniValidator::new(&integer_schema).expect("合法");
        assert_eq!(violations(&integer_check, &integer_schema, &json!(1.5)).len(), 1);
        assert_eq!(violations(&integer_check, &integer_schema, &json!(7)), Vec::<String>::new());
        assert_eq!(violations(&integer_check, &integer_schema, &json!(true)).len(), 1);
    }
}

//! 解析执行体：按声明式抽取规格从文本中结构化抽取字段。
//!
//! 规格 = 数据（调用方声明），执行语义 = 本执行体：between（两标记间
//! 首段）、line_prefix（首个匹配行）、count（非重叠出现次数）、contains
//! （布尔包含）。全部为确定性字符串运算（无正则、无 LLM），输出
//! fields/matched/missing 三态——缺失字段显式标记（null + missing 清单），
//! 让下游可以区分「字段不存在」与「抽取为空」。

use crate::json::{object_from_pairs, Value};
use crate::tool::{boolean_schema, string_schema, ToolError, ToolErrorKind};

pub fn schema() -> Value {
    let mut field_props = crate::json::Object::new();
    field_props.insert("name".to_string(), string_schema("字段名"));
    field_props.insert(
        "kind".to_string(),
        object_from_pairs(vec![
            ("type", Value::String("string".to_string())),
            (
                "enum",
                Value::Array(
                    ["between", "line_prefix", "count", "contains"]
                        .iter()
                        .map(|s| Value::String(s.to_string()))
                        .collect(),
                ),
            ),
            ("description", Value::String("抽取方式".to_string())),
        ]),
    );
    field_props.insert("start".to_string(), string_schema("between：起始标记"));
    field_props.insert("end".to_string(), string_schema("between：结束标记"));
    field_props.insert("prefix".to_string(), string_schema("line_prefix：行前缀"));
    field_props.insert(
        "include_prefix".to_string(),
        boolean_schema("line_prefix：结果是否含前缀"),
    );
    field_props.insert(
        "needle".to_string(),
        string_schema("count/contains：查找串"),
    );
    let field_schema = object_from_pairs(vec![
        ("type", Value::String("object".to_string())),
        ("properties", Value::Object(field_props)),
        (
            "required",
            Value::Array(vec![
                Value::String("name".to_string()),
                Value::String("kind".to_string()),
            ]),
        ),
    ]);
    crate::tool::schema_of(
        vec![
            ("text", string_schema("待解析文本")),
            (
                "spec",
                object_from_pairs(vec![
                    ("type", Value::String("array".to_string())),
                    ("items", field_schema),
                    ("description", Value::String("抽取规格清单".to_string())),
                ]),
            ),
        ],
        vec!["text", "spec"],
    )
}

/// 一条抽取规格（声明数据）。
struct FieldSpec {
    name: String,
    kind: String,
    start: Option<String>,
    end: Option<String>,
    prefix: Option<String>,
    include_prefix: bool,
    needle: Option<String>,
}

fn parse_specs(raw: &Value) -> Result<Vec<FieldSpec>, String> {
    let items = raw.as_array().ok_or_else(|| "spec 须为清单".to_string())?;
    let mut specs = Vec::with_capacity(items.len());
    let mut seen: Vec<&str> = Vec::new();
    for item in items {
        let obj = item
            .as_object()
            .ok_or_else(|| "spec 条目须为对象".to_string())?;
        let name = obj
            .get_str("name")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "spec 条目缺 name".to_string())?;
        if seen.contains(&name) {
            return Err(format!("spec 字段名重复: {}", name));
        }
        seen.push(name);
        let kind = obj
            .get_str("kind")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("字段 {} 缺 kind", name))?;
        if !matches!(kind, "between" | "line_prefix" | "count" | "contains") {
            return Err(format!(
                "字段 {} 的 kind 非法: {}（仅 between/line_prefix/count/contains）",
                name, kind
            ));
        }
        // E27：count/contains 的空 needle 语义相反（count=0 但 contains=true），
        // 声明期直接拒绝——空串查找是声明错误，不是合法规格
        if matches!(kind, "count" | "contains") {
            let needle = obj.get_str("needle");
            if needle.is_none() || needle.unwrap_or("").is_empty() {
                return Err(format!(
                    "字段 {} 的 {} 缺非空 needle",
                    name, kind
                ));
            }
        }
        specs.push(FieldSpec {
            name: name.to_string(),
            kind: kind.to_string(),
            start: obj.get_str("start").map(|s| s.to_string()),
            end: obj.get_str("end").map(|s| s.to_string()),
            prefix: obj.get_str("prefix").map(|s| s.to_string()),
            include_prefix: obj.get_bool("include_prefix").unwrap_or(false),
            needle: obj.get_str("needle").map(|s| s.to_string()),
        });
    }
    Ok(specs)
}

fn extract_between(text: &str, start: &str, end: &str) -> Option<String> {
    let start_idx = text.find(start)?;
    let from = start_idx + start.len();
    let end_idx = text[from..].find(end)?;
    Some(text[from..from + end_idx].to_string())
}

fn extract_line_prefix(text: &str, prefix: &str, include_prefix: bool) -> Option<String> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(if include_prefix {
                line.to_string()
            } else {
                rest.to_string()
            });
        }
    }
    None
}

fn count_occurrences(text: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    // 非重叠计数：逐次前进（线性总代价，无 O(n²) 回退）
    let mut count = 0;
    let mut from = 0;
    while let Some(idx) = text[from..].find(needle) {
        count += 1;
        from += idx + needle.len();
    }
    count
}

/// inkling_parse：参数 {text, spec: [{name, kind, ...}]}。
pub fn run(args: &Value) -> Result<Value, ToolError> {
    let args = args
        .as_object()
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "参数须为对象".to_string()))?;
    let text = args
        .get_str("text")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 text".to_string()))?;
    let raw_spec = args
        .get("spec")
        .ok_or_else(|| ToolError::new(ToolErrorKind::InvalidParams, "缺 spec".to_string()))?;
    let specs =
        parse_specs(raw_spec).map_err(|e| ToolError::new(ToolErrorKind::InvalidParams, e))?;

    let mut fields = crate::json::Object::new();
    let mut matched = Vec::new();
    let mut missing = Vec::new();
    for spec in &specs {
        let value: Option<Value> = match spec.kind.as_str() {
            "between" => {
                let (start, end) = match (&spec.start, &spec.end) {
                    (Some(s), Some(e)) => (s, e),
                    _ => {
                        return Err(ToolError::new(
                            ToolErrorKind::InvalidParams,
                            format!("字段 {} 的 between 缺 start/end", spec.name),
                        ))
                    }
                };
                extract_between(text, start, end).map(Value::String)
            }
            "line_prefix" => {
                let prefix = spec
                    .prefix
                    .as_ref()
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorKind::InvalidParams,
                            format!("字段 {} 的 line_prefix 缺 prefix", spec.name),
                        )
                    })?
                    .clone();
                extract_line_prefix(text, &prefix, spec.include_prefix).map(Value::String)
            }
            "count" => {
                let needle = spec
                    .needle
                    .as_ref()
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorKind::InvalidParams,
                            format!("字段 {} 的 count 缺 needle", spec.name),
                        )
                    })?
                    .clone();
                Some(Value::Number(count_occurrences(text, &needle) as f64))
            }
            "contains" => {
                let needle = spec
                    .needle
                    .as_ref()
                    .ok_or_else(|| {
                        ToolError::new(
                            ToolErrorKind::InvalidParams,
                            format!("字段 {} 的 contains 缺 needle", spec.name),
                        )
                    })?
                    .clone();
                Some(Value::Bool(text.contains(&needle)))
            }
            _ => unreachable!("kind 已在 parse_specs 校验"),
        };
        match value {
            Some(v) => {
                fields.insert(spec.name.clone(), v);
                matched.push(Value::String(spec.name.clone()));
            }
            None => {
                fields.insert(spec.name.clone(), Value::Null);
                missing.push(Value::String(spec.name.clone()));
            }
        }
    }
    Ok(object_from_pairs(vec![
        ("ok", Value::Bool(true)),
        ("fields", Value::Object(fields)),
        ("matched", Value::Array(matched)),
        ("missing", Value::Array(missing)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    #[test]
    fn extracts_fields() {
        let args = parse(
            r#"{
                "text": "标题: 溯源\n正文: 知识沉淀为可信知识。知识再沉淀。",
                "spec": [
                    {"name": "title", "kind": "line_prefix", "prefix": "标题: "},
                    {"name": "body", "kind": "between", "start": "正文: ", "end": "知识。"},
                    {"name": "mentions", "kind": "count", "needle": "知识"},
                    {"name": "has_keyword", "kind": "contains", "needle": "沉淀"},
                    {"name": "absent", "kind": "between", "start": "没有", "end": "这段"}
                ]
            }"#,
        )
        .unwrap();
        let out = run(&args).unwrap();
        let obj = out.as_object().unwrap();
        let fields = obj.get_object("fields").unwrap();
        assert_eq!(fields.get_str("title"), Some("溯源"));
        assert_eq!(fields.get_str("body"), Some("知识沉淀为可信"));
        assert_eq!(fields.get_f64("mentions"), Some(3.0));
        assert_eq!(fields.get_bool("has_keyword"), Some(true));
        assert_eq!(fields.get("absent"), Some(&Value::Null));
        assert_eq!(obj.get_array("matched").unwrap().len(), 4);
        assert_eq!(obj.get_array("missing").unwrap().len(), 1);
    }

    #[test]
    fn rejects_duplicate_field_names() {
        let args = parse(
            r#"{"text": "x", "spec": [{"name": "a", "kind": "count", "needle": "x"}, {"name": "a", "kind": "contains", "needle": "x"}]}"#,
        )
        .unwrap();
        assert!(run(&args).is_err());
    }

    #[test]
    fn rejects_empty_needle() {
        // E27：count/contains 空 needle 声明期拒绝（count=0 与 contains=true
        // 语义相反，空串查找是声明错误）
        let args = parse(
            r#"{"text": "x", "spec": [{"name": "a", "kind": "count", "needle": ""}]}"#,
        )
        .unwrap();
        assert!(run(&args).is_err());
        let args = parse(
            r#"{"text": "x", "spec": [{"name": "a", "kind": "contains"}]}"#,
        )
        .unwrap();
        assert!(run(&args).is_err());
    }
}

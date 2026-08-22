//! 执行体注册表与工具错误（插拔式：新执行体 = 新增文件 + 此处登记）。
//!
//! 与 ts_seed_pack 先例同构：执行体是「名字 + 描述 + 入参 schema + 执行
//! 函数」的登记项，tools/list 输出登记项，tools/call 按名分派。tools.json
//! 数据文件与注册表是同一契约的双侧声明——绑定测试断言双侧不漂移。

use crate::json::{object_from_pairs, Value};

/// 结构化工具错误（映射为 JSON-RPC 错误对象：kind → 错误码）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolError {
    pub kind: ToolErrorKind,
    pub message: String,
}

impl ToolError {
    pub fn new(kind: ToolErrorKind, message: String) -> Self {
        ToolError { kind, message }
    }
}

/// 错误类别（协议层映射为 JSON-RPC 错误码——错误码只在协议层出现，
/// 执行体用类别表达语义，禁止散落魔法数字）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolErrorKind {
    /// 参数非法（-32602 INVALID_PARAMS）。
    InvalidParams,
    /// 领域执行失败（-32000 工具执行错误）。
    ToolError,
}

/// 一个执行体登记项。
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub run: fn(&Value) -> Result<Value, ToolError>,
}

/// 登记表（插入序 = tools/list 输出序；MCP 协议对顺序无要求，稳定即可）。
pub fn registry() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "inkling_collect",
            description: "采集：文本直取或 URL 取回（http 明文 + 大小上限保护 + 超时 + 重定向上限；https 需宿主 web_bridge 代理）",
            input_schema: crate::executors::collect::schema(),
            run: crate::executors::collect::run,
        },
        ToolDef {
            name: "inkling_parse",
            description: "解析：按声明式抽取规格（between/line_prefix/count/contains）从文本中结构化抽取字段",
            input_schema: crate::executors::parse::schema(),
            run: crate::executors::parse::run,
        },
        ToolDef {
            name: "inkling_validate",
            description: "校验：以 rules.json 规则集对数据对象执行确定性规则谓词评估（谓词名/违规形态与引擎规则引擎对齐，含样例闸门同语义的 fail-open 留痕）",
            input_schema: crate::executors::validate::schema(),
            run: crate::executors::validate::run,
        },
        ToolDef {
            name: "inkling_score",
            description: "评分：候选答案的引用质量（引用可验证性）+ 交叉验证（断言与样例库基准事实重叠度）确定性评分",
            input_schema: crate::executors::score::schema(),
            run: crate::executors::score::run,
        },
        ToolDef {
            name: "inkling_review",
            description: "评审：按 review.json 维度配置加权打分 + 阈值判定 + 收敛决策（镜像引擎 WeightedScorer 与 MaxRoundsConvergencePolicy 语义）",
            input_schema: crate::executors::review::schema(),
            run: crate::executors::review::run,
        },
        ToolDef {
            name: "inkling_distill",
            description: "蒸馏：按 signals.json 五类信号→蒸馏器映射把信号序列压缩为结构化知识（{kind: insight, insight: {message, context, note}} 引擎教训条目形态），丢弃试错分支",
            input_schema: crate::executors::distill::schema(),
            run: crate::executors::distill::run,
        },
        ToolDef {
            name: "inkling_mutate",
            description: "变异：反思式变体生成（失败日志 → 变异体知识数据，镜像引擎 DeterministicMutation——_mutation 留痕 + 动态变体数量），产物须过三层闸门才保留",
            input_schema: crate::executors::mutate::schema(),
            run: crate::executors::mutate::run,
        },
    ]
}

/// 供工具参数校验复用：把参数对象转成注册表 schema（tools.json 绑定测试
/// 用同一构造源，保证数据文件与注册表语义一致）。
pub fn schema_of(props: Vec<(&str, Value)>, required: Vec<&str>) -> Value {
    let mut obj = crate::json::Object::new();
    obj.insert("type".to_string(), Value::String("object".to_string()));
    let mut properties = crate::json::Object::new();
    for (name, schema) in props {
        properties.insert(name.to_string(), schema);
    }
    obj.insert("properties".to_string(), Value::Object(properties));
    obj.insert(
        "required".to_string(),
        Value::Array(
            required
                .into_iter()
                .map(|r| Value::String(r.to_string()))
                .collect(),
        ),
    );
    Value::Object(obj)
}

pub fn string_schema(description: &str) -> Value {
    object_from_pairs(vec![
        ("type", Value::String("string".to_string())),
        ("description", Value::String(description.to_string())),
    ])
}

pub fn integer_schema(description: &str) -> Value {
    object_from_pairs(vec![
        ("type", Value::String("integer".to_string())),
        ("description", Value::String(description.to_string())),
    ])
}

pub fn number_schema(description: &str) -> Value {
    object_from_pairs(vec![
        ("type", Value::String("number".to_string())),
        ("description", Value::String(description.to_string())),
    ])
}

pub fn boolean_schema(description: &str) -> Value {
    object_from_pairs(vec![
        ("type", Value::String("boolean".to_string())),
        ("description", Value::String(description.to_string())),
    ])
}

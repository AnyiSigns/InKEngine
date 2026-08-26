//! 执行体注册表与工具错误（插拔式：新执行体 = 新增文件 + 此处登记）。
//!
//! 与 ts_seed_pack 先例同构：执行体是「名字 + 描述 + 入参 schema + 执行
//! 函数」的登记项，tools/list 输出登记项，tools/call 按名分派。工具名与
//! 参数形态以 seed_data/tools.json 声明为准（决议 1：seed 为真源，exec
//! 适配）——引擎 mcp_client.py 按声明名 dispatch，注册表必须回应当声明
//! 名（collect_material 等），参数按声明形态适配。tools.json 数据文件与
//! 注册表是同一契约的双侧声明——绑定测试断言双侧不漂移。
//!
//! 注册表经 OnceLock 惰性构建缓存（E19）：tools/list 与 tools/call 不再
//! 每次调用重建整张表（7 个登记项虽小，但构建成本与并发无关、纯浪费）。

use std::sync::OnceLock;

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

/// 一个执行体登记项（全静态数据，可入 OnceLock 缓存）。
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    pub run: fn(&Value) -> Result<Value, ToolError>,
}

/// 工具声明名（与 seed_data/tools.json 的 inkling_exec 工具一一对应，
/// 绑定测试断言双侧不漂移）。改名必须双侧同步。
pub const DECLARED_TOOL_NAMES: [&str; 7] = [
    "collect_material",
    "parse_material",
    "validate_material",
    "score_material",
    "review_material",
    "distill_knowledge",
    "mutate_knowledge",
];

/// 登记表（插入序 = tools/list 输出序；MCP 协议对顺序无要求，稳定即可）。
/// OnceLock 缓存：全静态数据，进程生命周期内只构建一次（E19）。
fn build_registry() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "collect_material",
            description: "采集：把研究素材采集回来（文本直取或 URL 取回，产物是未经解析的原始材料，只入料不加工）",
            input_schema: crate::executors::collect::schema(),
            run: crate::executors::collect::run,
        },
        ToolDef {
            name: "parse_material",
            description: "解析：按声明式抽取规格（between/line_prefix/count/contains）从文本中结构化抽取字段",
            input_schema: crate::executors::parse::schema(),
            run: crate::executors::parse::run,
        },
        ToolDef {
            name: "validate_material",
            description: "校验：以 rules.json 规则集对数据对象执行确定性规则谓词评估（谓词名/违规形态与引擎规则引擎对齐，含样例闸门同语义的 fail-open 留痕）",
            input_schema: crate::executors::validate::schema(),
            run: crate::executors::validate::run,
        },
        ToolDef {
            name: "score_material",
            description: "评分：候选答案的引用质量（引用可验证性）+ 交叉验证（断言与样例库基准事实重叠度）确定性评分",
            input_schema: crate::executors::score::schema(),
            run: crate::executors::score::run,
        },
        ToolDef {
            name: "review_material",
            description: "评审：按 review.json 维度配置加权打分 + 阈值判定 + 收敛决策（镜像引擎 WeightedScorer 与 MaxRoundsConvergencePolicy 语义）",
            input_schema: crate::executors::review::schema(),
            run: crate::executors::review::run,
        },
        ToolDef {
            name: "distill_knowledge",
            description: "蒸馏：按 signals.json 信号→蒸馏器映射把信号序列压缩为结构化知识（{kind: insight, insight: {message, context, note}} 引擎教训条目形态），丢弃试错分支",
            input_schema: crate::executors::distill::schema(),
            run: crate::executors::distill::run,
        },
        ToolDef {
            name: "mutate_knowledge",
            description: "变异：反思式变体生成（失败日志 → 变异体知识数据，镜像引擎 DeterministicMutation——_mutation 留痕 + 动态变体数量），产物须过三层闸门才保留",
            input_schema: crate::executors::mutate::schema(),
            run: crate::executors::mutate::run,
        },
    ]
}

/// 注册表（协议层 tools/list 与 tools/call 的唯一事实源；OnceLock 缓存）。
pub fn registry() -> &'static Vec<ToolDef> {
    static REGISTRY: OnceLock<Vec<ToolDef>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry)
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

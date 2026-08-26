//! 数据绑定不漂移测试：谓词 ↔ rules.json / samples.json / signals.json /
//! review.json / tools.json 的双侧一致性（M1 验收「评分/评审/蒸馏/变异产物
//! 与数据绑定不漂移」的断言载体）。
//!
//! 绑定路径说明：本测试读 exec/tests/fixtures/（镜像 M0 数据契约语义的
//! 本地夹具）；把 INKLING_SEED_DATA 指向真实数据目录（inkling/seed_data）
//! 即可切换绑定对象——测试必须双侧全绿（夹具 + 真实种子门禁，E26）。
//! 夹具 = 数据契约的临时宿主，数据文件增删字段只会让绑定断言更严。

use inkling_exec::data;
use inkling_exec::executors::{collect, distill, mutate, review, score, validate};
use inkling_exec::json::{self, Value};

fn load(name: &str) -> Value {
    data::load_json_file(name).unwrap_or_else(|e| panic!("{}", e))
}

fn run_tool(tool: fn(&Value) -> Result<Value, inkling_exec::tool::ToolError>, args: &str) -> Value {
    let parsed = json::parse(args).unwrap_or_else(|e| panic!("参数 JSON 非法: {}", e));
    tool(&parsed).unwrap_or_else(|e| panic!("工具执行失败: {:?}", e))
}

// -- 真实种子门禁自验证 ---------------------------------------------------

#[test]
fn gate_resolves_real_seed_when_env_set() {
    // E26：INKLING_SEED_DATA 设置时必须真的解析到真实目录（防夹具回落
    // 让门禁静默跑夹具——夹具回落仅测试/调试构建是开发便利不是门禁）
    let env = std::env::var(data::ENV_SEED_DATA).unwrap_or_default();
    if env.trim().is_empty() {
        eprintln!("[skip] 未设置 {}，跳过门禁自验证", data::ENV_SEED_DATA);
        return;
    }
    let dir = data::resolve_data_dir().unwrap_or_else(|e| panic!("{}", e));
    let resolved = std::fs::canonicalize(&dir).unwrap();
    let expected = std::path::Path::new(&env);
    let expected = if expected.is_absolute() {
        expected.to_path_buf()
    } else {
        std::env::current_dir().unwrap().join(expected)
    };
    let expected = std::fs::canonicalize(expected).unwrap();
    assert_eq!(
        resolved,
        expected,
        "{} 解析须命中真实目录（当前 {}）",
        data::ENV_SEED_DATA,
        resolved.display()
    );
    // 真实种子工具数应远大于 exec 的 7 个（含 shell 侧工具）
    let tools = load("tools.json");
    let declared = tools.as_object().unwrap().get_array("tools").unwrap();
    assert!(declared.len() > 7, "真实种子应含 shell 侧工具（>7）");
}

// -- tools.json ↔ 注册表（决议 1：seed 为真源，exec 注册表按声明名） --------

/// 工具入参 schema 键：夹具用 inputSchema（MCP 2.x 声明形态），真实种子
/// 用 parameters——双侧都要锚定（值形态演进，键集才是绑定契约）。
fn tool_schema(obj: &inkling_exec::json::Object) -> Option<&inkling_exec::json::Object> {
    obj.get_object("inputSchema")
        .or_else(|| obj.get_object("parameters"))
}

/// 从声明清单筛出 exec 注册表工具（真实种子含 shell 侧工具，按名过滤）。
fn exec_tools(declared: &[Value]) -> Vec<&Value> {
    let registry = inkling_exec::executors::registry();
    let names: Vec<&str> = registry.iter().map(|d| d.name).collect();
    let mut matched: Vec<&Value> = declared
        .iter()
        .filter(|t| {
            t.as_object()
                .and_then(|o| o.get_str("name"))
                .is_some_and(|n| names.contains(&n))
        })
        .collect();
    // 按注册表声明顺序排列（协议输出顺序稳定，双侧锚点一致）
    matched.sort_by_key(|t| {
        let n = t.as_object().unwrap().get_str("name").unwrap();
        names.iter().position(|r| *r == n).unwrap()
    });
    matched
}

#[test]
fn tools_json_matches_registry() {
    let tools_json = load("tools.json");
    let declared: Vec<Value> = tools_json
        .as_object()
        .unwrap()
        .get_array("tools")
        .unwrap()
        .to_vec();
    assert!(!declared.is_empty(), "tools.json 不能为空");
    let registry = inkling_exec::executors::registry();
    let matched = exec_tools(&declared);
    assert_eq!(
        matched.len(),
        registry.len(),
        "声明工具（exec 侧）数与注册表数不一致——声明名未在注册表中登记"
    );
    for (declared_tool, def) in matched.iter().zip(registry.iter()) {
        let obj = declared_tool.as_object().unwrap();
        let name = obj.get_str("name").unwrap();
        assert_eq!(name, def.name, "工具名错位（声明与注册表顺序不一致）");
        let schema = tool_schema(obj).unwrap();
        // schema 契约：声明侧与注册表侧的必填字段集一致
        let declared_required: Vec<&str> = schema
            .get_array("required")
            .map(|r| r.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let registry_required: Vec<&str> = def
            .input_schema
            .as_object()
            .unwrap()
            .get_array("required")
            .map(|r| r.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        assert_eq!(
            declared_required, registry_required,
            "工具 {} 的 required 漂移",
            name
        );
        // properties 键集一致（值形态允许演进，键 = 绑定锚点）
        let declared_props: Vec<&str> = schema
            .get_object("properties")
            .map(|p| p.iter().map(|(k, _)| k).collect())
            .unwrap_or_default();
        let registry_props: Vec<&str> = def
            .input_schema
            .as_object()
            .unwrap()
            .get_object("properties")
            .map(|p| p.iter().map(|(k, _)| k).collect())
            .unwrap_or_default();
        let mut d = declared_props.clone();
        d.sort_unstable();
        let mut r = registry_props.clone();
        r.sort_unstable();
        assert_eq!(d, r, "工具 {} 的 properties 键漂移", name);
    }
    // 每个注册表声明名都必须真实存在于 tools.json（注册别名不许静默消失）
    for def in registry.iter() {
        assert!(
            declared.iter().any(|t| {
                t.as_object()
                    .and_then(|o| o.get_str("name"))
                    == Some(def.name)
            }),
            "注册表工具 {} 未在 tools.json 中声明",
            def.name
        );
    }
}

// -- rules.json ↔ 谓词实现 ----------------------------------------------

#[test]
fn rules_json_predicates_all_implemented() {
    let rules_json = load("rules.json");
    let rules = rules_json.as_object().unwrap().get_array("rules").unwrap();
    assert!(!rules.is_empty(), "rules.json 不能为空");
    for rule in rules {
        let obj = rule.as_object().unwrap();
        let predicate = obj.get_str("predicate").unwrap();
        assert!(
            validate::is_known_predicate(predicate),
            "rules.json 引用了未实现的谓词: {}（规则 {}）",
            predicate,
            obj.get_str("id").unwrap_or("?")
        );
    }
    // 规则 id 唯一（防重复 id 导致留痕/夹具断言锚点漂移）
    let mut ids: Vec<&str> = rules
        .iter()
        .filter_map(|r| r.as_object().unwrap().get_str("id"))
        .collect();
    ids.sort_unstable();
    let mut unique = ids.clone();
    unique.dedup();
    assert_eq!(ids.len(), unique.len(), "rules.json 规则 id 重复");
}

// -- samples.json ↔ 规则集（样例闸门：夹具 + 真实种子全绿非谈判项） --------

#[test]
fn samples_fixture_gate_all_green() {
    let samples = load("samples.json");
    let cases = samples.as_object().unwrap().get_array("cases").unwrap();
    assert!(!cases.is_empty(), "samples.json 不能为空");
    let mut checked = 0usize;
    for case in cases {
        let obj = case.as_object().unwrap();
        let case_id = obj.get_str("id").unwrap();
        let data = obj.get("data").unwrap();
        let expected_pass = obj.get_bool("expected_pass").unwrap_or(true);
        let expected_kinds: Vec<&str> = obj
            .get_array("expected_kinds")
            .map(|k| k.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let unexpected_kinds: Vec<&str> = obj
            .get_array("unexpected_kinds")
            .map(|k| k.iter().filter_map(|v| v.as_str()).collect())
            .unwrap_or_default();
        let args = format!(
            r#"{{"data": {}, "context": {}}}"#,
            json::serialize(data),
            obj.get("context")
                .map(json::serialize)
                .unwrap_or_else(|| "{}".to_string())
        );
        let out = run_tool(validate::run, &args);
        let result = out.as_object().unwrap();
        let issues = result.get_array("issues").unwrap();
        let broken = result.get_array("broken").unwrap();
        let kinds: Vec<&str> = issues
            .iter()
            .filter_map(|i| i.as_object().unwrap().get_str("kind"))
            .collect();
        let missing: Vec<&str> = expected_kinds
            .iter()
            .filter(|k| !kinds.contains(k))
            .copied()
            .collect();
        let unexpected_hit: Vec<&str> = unexpected_kinds
            .iter()
            .filter(|k| kinds.contains(k))
            .copied()
            .collect();
        let passed = if expected_pass {
            issues.is_empty() && broken.is_empty()
        } else {
            !issues.is_empty()
                && missing.is_empty()
                && unexpected_hit.is_empty()
                && broken.is_empty()
        };
        assert!(
            passed,
            "样例闸门失败 [{}]：期望通过={}，实际违规={:?}（缺类别 {:?}，禁止类别命中 {:?}，失效 {:?}）",
            case_id, expected_pass, kinds, missing, unexpected_hit, broken
        );
        checked += 1;
    }
    assert!(
        checked >= 10,
        "样例密度不足（当前 {} 例，起点领域种子密度目标 ≥10）",
        checked
    );
}

// -- rules 子集（E9：声明了就必须生效） ------------------------------------

#[test]
fn validate_rules_subset_binds() {
    let rules_json = load("rules.json");
    let rules = rules_json.as_object().unwrap().get_array("rules").unwrap();
    let ids: Vec<&str> = rules
        .iter()
        .filter_map(|r| r.as_object().unwrap().get_str("id"))
        .collect();
    assert!(ids.len() >= 2);
    // 夹具与真实种子前两条规则都能在下方 data 上评估（checked 应精确 = 2）：
    // 夹具 = present(title 缺失) + compare(title_length 在)；真实 = has_fields +
    // in_enum（material 形状齐全）。数据按顶层是否带 name 区分两套形态。
    let has_name = rules_json.as_object().unwrap().get_str("name").is_some();
    let data = if has_name {
        r#"{"title_length": 4}"#
    } else {
        r#"{"material": {"title": "t", "text": "x", "source": "web"}}"#
    };
    let args = json::parse(&format!(
        r#"{{"data": {}, "rules": ["{}", "{}"]}}"#,
        data, ids[0], ids[1]
    ))
    .unwrap();
    let out = validate::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(
        obj.get_f64("checked"),
        Some(2.0),
        "rules 子集只评估指定 2 条（{}）",
        ids[0..2].join("/")
    );
    // 未知规则 id fail-closed 拒绝（E9：防调用方以为子集裁决实际跑全量）
    let bad = json::parse(r#"{"data": {}, "rules": ["no_such_rule"]}"#).unwrap();
    let err = validate::run(&bad).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::InvalidParams);
}

// -- review.json ↔ 评审执行体（维度/阈值绑定，双侧数据驱动） ----------------

#[test]
fn review_thresholds_bind_to_review_json() {
    let review_json = load("review.json");
    let config = review_json.as_object().unwrap();
    let dimensions = config.get_array("dimensions").unwrap();
    assert!(!dimensions.is_empty());
    let dim_names: Vec<&str> = dimensions
        .iter()
        .map(|d| d.as_object().unwrap().get_str("name").unwrap())
        .collect();
    let has_thresholds = dimensions
        .iter()
        .all(|d| d.as_object().unwrap().get_f64("threshold").is_some());
    let pass_threshold = config.get_f64("pass_threshold").unwrap();
    let max_rounds = config.get_i64("max_rounds").unwrap();
    // 手工加权：0.9/0.8/0.8/0.8 × 权重（数据驱动，维度名来自 review.json）
    let weights: Vec<f64> = dimensions
        .iter()
        .map(|d| d.as_object().unwrap().get_f64("weight").unwrap())
        .collect();
    let weight_sum: f64 = weights.iter().sum();
    let high_scores = [0.9, 0.8, 0.8, 0.8];
    assert_eq!(
        dim_names.len(),
        high_scores.len(),
        "维度数须为 4（与测试高分序列等长）"
    );
    let total_high: f64 = weights
        .iter()
        .zip(high_scores.iter())
        .map(|(w, s)| w * s)
        .sum::<f64>()
        / weight_sum;
    assert!(
        total_high >= pass_threshold,
        "数据口径自洽性：高分样例总分 {:.2} 应 ≥ 通过阈值 {:.2}",
        total_high,
        pass_threshold
    );
    let scores_json = |vals: &[f64]| -> String {
        dim_names
            .iter()
            .enumerate()
            .map(|(i, n)| format!(r#"{{"candidate_index": 0, "name": "{}", "score": {}}}"#, n, vals[i]))
            .collect::<Vec<_>>()
            .join(", ")
    };
    // 高分候选 → passed=true、收敛
    let args = format!(
        r#"{{"candidates": [{{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}}], "dimension_scores": [{}]}}"#,
        scores_json(&high_scores)
    );
    let out = run_tool(review::run, &args);
    let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
    let review0 = reviews[0].as_object().unwrap();
    assert!((review0.get_f64("score").unwrap() - total_high).abs() < 1e-9);
    assert_eq!(review0.get_bool("passed"), Some(true));
    let decision = out.as_object().unwrap().get_object("decision").unwrap();
    assert_eq!(decision.get_bool("converged"), Some(true));
    assert_eq!(decision.get_array("accepted_indices").unwrap().len(), 1);
    // 低分候选 → passed=false；配置含阈值时 failing_dimensions 应命中首维
    let low_scores = [0.2, 0.8, 0.8, 0.8];
    let args = format!(
        r#"{{"candidates": [{{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}}], "dimension_scores": [{}]}}"#,
        scores_json(&low_scores)
    );
    let out = run_tool(review::run, &args);
    let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
    let review0 = reviews[0].as_object().unwrap();
    assert_eq!(review0.get_bool("passed"), Some(false));
    if has_thresholds {
        let failing = review0.get_array("failing_dimensions").unwrap();
        assert!(
            failing.iter().any(|f| f.as_str() == Some(dim_names[0])),
            "低分候选应命中 {} 维度达标线",
            dim_names[0]
        );
    }
    // 轮次上限绑定：round_no >= max_rounds 时不再再生、呈交现状
    let args = format!(
        r#"{{"candidates": [{{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}}], "dimension_scores": [{}], "round_no": {}}}"#,
        scores_json(&low_scores),
        max_rounds
    );
    let out = run_tool(review::run, &args);
    let decision = out.as_object().unwrap().get_object("decision").unwrap();
    assert_eq!(decision.get_bool("converged"), Some(false));
    assert!(decision.get_array("regenerate_indices").unwrap().is_empty());
    assert!(!decision.get_array("notes").unwrap().is_empty());
}

// -- signals.json ↔ 蒸馏执行体（五类信号映射绑定，对象/数组双侧兼容） -------

#[test]
fn signals_json_kinds_bind_to_distill() {
    let signals_json = load("signals.json");
    // E2 兼容：夹具 signal_kinds 是对象 {kind: {...}}，真实种子是数组
    // [{kind, name, distiller, produced_kind}, ...]
    let mut kind_names: Vec<String> = match signals_json
        .as_object()
        .unwrap()
        .get("signal_kinds")
        .unwrap()
    {
        Value::Object(kinds) => kinds.iter().map(|(k, _)| k.to_string()).collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i.as_object().and_then(|o| o.get_str("kind")))
            .map(String::from)
            .collect(),
        _ => panic!("signal_kinds 形态未知（须为对象或数组）"),
    };
    kind_names.sort_unstable();
    assert_eq!(
        kind_names,
        vec![
            "gap".to_string(),
            "insight".to_string(),
            "pitfall".to_string(),
            "repeated_root_cause".to_string(),
            "user_correction".to_string()
        ],
        "五类信号必须完整且命名与引擎对齐"
    );
    // 全部五类信号都须被接受（分类路由入口不漂移）
    let args = format!(
        r#"{{"signals": [{}], "complexity": 6, "interventions": 1}}"#,
        kind_names
            .iter()
            .map(|k| format!(r#"{{"kind": "{}", "message": "测试"}}"#, k))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let out = run_tool(distill::run, &args);
    assert_eq!(
        out.as_object().unwrap().get_bool("should_distill"),
        Some(true)
    );
    // 未知类别被结构化拒绝（错误码 = 参数非法）
    let bad = json::parse(r#"{"signals": [{"kind": "hacker", "message": "x"}], "complexity": 6}"#)
        .unwrap();
    let err = distill::run(&bad).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::InvalidParams);
}

#[test]
fn distill_product_matches_engine_contract() {
    // 产物形态断言（与引擎 DeterministicDistiller 对齐）：
    // data = {"kind": "insight", "insight": {"message", "context", "note"}}
    // source 取 primary.source（E23：消息与来源同源）
    let args = json::parse(
        r#"{"signals": [
            {"kind": "insight", "message": "知识沉淀需证据留痕", "source": "dialog", "context": {"node": "research"}},
            {"kind": "pitfall", "message": "无证据落库被拒", "source": "web"},
            {"kind": "pitfall", "message": "缺引用被打回", "source": "web"}
        ], "complexity": 6, "interventions": 0}"#,
    )
    .unwrap();
    let out = distill::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_str("source"), Some("dialog"));
    let data = obj.get_object("data").unwrap();
    assert_eq!(data.get_str("kind"), Some("insight"));
    let insight = data.get_object("insight").unwrap();
    assert_eq!(insight.get_str("message"), Some("知识沉淀需证据留痕"));
    assert_eq!(
        insight.get_str("note"),
        Some("无证据落库被拒; 缺引用被打回")
    );
    assert_eq!(
        insight.get_object("context").unwrap().get_str("node"),
        Some("research")
    );
}

// -- samples.json facts ↔ 评分执行体（交叉验证绑定） -----------------------

#[test]
fn score_cross_validation_binds_to_samples_facts() {
    let samples = load("samples.json");
    let facts = samples.as_object().unwrap().get_array("facts").unwrap();
    assert!(!facts.is_empty());
    let statement = facts[0].as_object().unwrap().get_str("statement").unwrap();
    // 断言与第一条基准事实重叠 → 交叉验证命中；无关断言 → 不命中
    let claim = statement.split('的').next().unwrap_or(statement);
    let args = format!(
        r#"{{"answer": {{"claims": [{{"text": "{}"}}, {{"text": "完全无关的断言文本"}}], "citations": []}}}}"#,
        claim
    );
    let out = run_tool(score::run, &args);
    let details = out.as_object().unwrap().get_object("details").unwrap();
    let claim_details = details.get_array("claims").unwrap();
    assert_eq!(
        claim_details[0]
            .as_object()
            .unwrap()
            .get_bool("cross_validated"),
        Some(true)
    );
    assert_eq!(
        claim_details[1]
            .as_object()
            .unwrap()
            .get_bool("cross_validated"),
        Some(false)
    );
}

#[test]
fn score_quote_accuracy_verifies_citations() {
    let args = json::parse(
        r#"{
            "answer": {
                "claims": [{"text": "断言甲"}, {"text": "断言乙"}],
                "citations": [
                    {"claim_index": 0, "source_id": "s1", "quote": "正确引用原文"},
                    {"claim_index": 1, "source_id": "s2", "quote": "不存在的内容"}
                ]
            },
            "sources": [
                {"id": "s1", "text": "正文包含正确引用原文以及更多内容。"},
                {"id": "s2", "text": "正文不含引用内容。"}
            ]
        }"#,
    )
    .unwrap();
    let out = score::run(&args).unwrap();
    let checks = out.as_object().unwrap().get_array("checks").unwrap();
    let quote = checks
        .iter()
        .find(|c| c.as_object().unwrap().get_str("name") == Some("quote_accuracy"))
        .unwrap()
        .as_object()
        .unwrap();
    assert_eq!(quote.get_f64("score"), Some(0.5));
    let details = out.as_object().unwrap().get_object("details").unwrap();
    let citations = details.get_array("citations").unwrap();
    assert_eq!(
        citations[0].as_object().unwrap().get_bool("verified"),
        Some(true)
    );
    assert_eq!(
        citations[1].as_object().unwrap().get_bool("verified"),
        Some(false)
    );
}

// -- 变异执行体产物契约 ---------------------------------------------------

#[test]
fn mutate_product_matches_engine_contract() {
    let args = json::parse(
        r#"{
            "entry": {"id": "e9", "level": "work", "kind": "rule", "data": {"path": "a"}, "title": "规则九", "tags": ["t"]},
            "failure_logs": ["日志一", "日志二"],
            "failure_rate": 0.5,
            "max_variants": 3
        }"#,
    )
    .unwrap();
    let out = mutate::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    let variants = obj.get_array("variants").unwrap();
    assert_eq!(variants.len(), 2);
    for (i, variant) in variants.iter().enumerate() {
        let v = variant.as_object().unwrap();
        assert_eq!(v.get_str("id"), Some(format!("e9:v{}", i + 1).as_str()));
        assert_eq!(v.get_str("title"), Some("规则九（变异）"));
        assert_eq!(v.get_str("level"), Some("work"));
        assert_eq!(v.get_str("kind"), Some("rule"));
        let data = v.get_object("data").unwrap();
        let mutation = data.get_object("_mutation").unwrap();
        assert_eq!(mutation.get_str("variant_of"), Some("e9"));
        assert_eq!(
            mutation.get_str("based_on"),
            Some(format!("日志{}", ["一", "二"][i]).as_str())
        );
    }
    // 无失败日志 → 无变异（引擎同语义：不产出无依据变异）
    let args = json::parse(r#"{"entry": {"id": "e9", "data": {}}, "failure_logs": []}"#).unwrap();
    let out = mutate::run(&args).unwrap();
    assert!(out
        .as_object()
        .unwrap()
        .get_array("variants")
        .unwrap()
        .is_empty());
}

// -- 采集执行体：文本直取（保留路径） --------------------------------------

#[test]
fn collect_text_size_cap() {
    let args = json::parse(r#"{"text": "0123456789", "max_bytes": 5}"#).unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("truncated"), Some(true));
    assert_eq!(obj.get_str("content"), Some("01234"));
    assert_eq!(obj.get_str("source"), Some("text"));
    // 未超限不截断
    let args = json::parse(r#"{"text": "0123456789"}"#).unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("truncated"), Some(false));
    assert_eq!(obj.get_str("content"), Some("0123456789"));
}

// -- 采集执行体：URL 取回（决议 9：走宿主 web_bridge 代理，禁直接出网） ------

#[test]
fn collect_url_mode_fails_closed() {
    // http(s) URL 采集经宿主 web_bridge 代理（域名白名单/禁重定向/截断/
    // 超时整体收口）；代理契约未接线前 fail-closed 返回结构化错误，
    // 绝不直连（TcpStream 客户端已删除，SSRF/CRLF 注入面随之下线）
    for url in [
        "http://example.com/doc",
        "https://example.com/doc",
        "http://127.0.0.1:1/x",
    ] {
        let args = json::parse(&format!(r#"{{"url": "{}"}}"#, url)).unwrap();
        let err = collect::run(&args).unwrap_err();
        assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::ToolError);
        assert!(
            err.message.contains("web_bridge"),
            "url 模式报错须指引宿主 web_bridge（{}）: {}",
            url,
            err.message
        );
        assert!(
            err.message.contains("E-P7") || err.message.contains("代理"),
            "错误须含契约未定稿说明: {}",
            err.message
        );
    }
    // 非 http(s) scheme 拒绝（不交给代理）
    let args = json::parse(r#"{"url": "ftp://example.com/x"}"#).unwrap();
    let err = collect::run(&args).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::ToolError);
    // url/text 互斥与必填其一（参数适配契约）
    let args = json::parse(r#"{"url": "http://a.b/", "text": "x"}"#).unwrap();
    let err = collect::run(&args).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::InvalidParams);
    let args = json::parse(r#"{}"#).unwrap();
    let err = collect::run(&args).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::InvalidParams);
}

// -- E26 补强：inf/超范围数字（E3 拒绝）+ 通知带 id（协议层） ----------------

#[test]
fn json_rejects_out_of_range_numbers() {
    // E3：1e400 语法合法但超出可表示范围——解析期显式拒绝（序列化成
    // null 会静默丢数据，fail-fast 优先）
    assert!(json::parse("1e400").is_err());
    assert!(json::parse("[1e400]").is_err());
}

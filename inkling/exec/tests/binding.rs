//! 数据绑定不漂移测试：谓词 ↔ rules.json / samples.json / signals.json /
//! review.json / tools.json 的双侧一致性（M1 验收「评分/评审/蒸馏/变异产物
//! 与数据绑定不漂移」的断言载体）。
//!
//! 绑定路径说明：本测试读 exec/tests/fixtures/（镜像 M0 数据契约语义的
//! 本地夹具）。M0 的 seeds/inkling/seed_data/ 落盘后，把
//! INKLING_SEED_DATA 指向真实数据目录即可切换绑定对象——测试本身零改动
//! （data.rs 的解析顺序保证）。夹具 = 数据契约的临时宿主，集成以 M0
//! 定稿为准；数据文件增删字段只会让绑定断言更严，不会静默失效。

use inkling_exec::data;
use inkling_exec::executors::{collect, distill, mutate, review, score, validate};
use inkling_exec::json::{self, Value};
use std::io::{Read, Write};

fn load(name: &str) -> Value {
    data::load_json_file(name).unwrap_or_else(|e| panic!("{}", e))
}

fn run_tool(tool: fn(&Value) -> Result<Value, inkling_exec::tool::ToolError>, args: &str) -> Value {
    let parsed = json::parse(args).unwrap_or_else(|e| panic!("参数 JSON 非法: {}", e));
    tool(&parsed).unwrap_or_else(|e| panic!("工具执行失败: {:?}", e))
}

// -- tools.json ↔ 注册表 -------------------------------------------------

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
    assert_eq!(declared.len(), registry.len(), "声明工具数与注册表数不一致");
    for (declared_tool, def) in declared.iter().zip(registry.iter()) {
        let obj = declared_tool.as_object().unwrap();
        let name = obj.get_str("name").unwrap();
        assert_eq!(name, def.name, "工具名错位（声明与注册表顺序不一致）");
        let schema = obj.get_object("inputSchema").unwrap();
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
            validate::KNOWN_PREDICATES.contains(&predicate),
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

// -- samples.json ↔ 规则集（样例闸门：fixture 全绿非谈判项） ---------------

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

// -- review.json ↔ 评审执行体（维度/阈值绑定） ----------------------------

#[test]
fn review_thresholds_bind_to_review_json() {
    let review_json = load("review.json");
    let config = review_json.as_object().unwrap();
    let dimensions = config.get_array("dimensions").unwrap();
    assert!(!dimensions.is_empty());
    let pass_threshold = config.get_f64("pass_threshold").unwrap();
    let max_rounds = config.get_i64("max_rounds").unwrap();
    // 手工加权：0.9/0.8/0.8/0.8 × 权重（数据驱动，不写死具体维度值）
    let weights: Vec<f64> = dimensions
        .iter()
        .map(|d| d.as_object().unwrap().get_f64("weight").unwrap())
        .collect();
    let weight_sum: f64 = weights.iter().sum();
    let high_scores = [0.9, 0.8, 0.8, 0.8];
    let total_high: f64 = weights
        .iter()
        .zip(high_scores.iter())
        .map(|(w, s)| w * s)
        .sum::<f64>()
        / weight_sum;
    assert!(
        total_high >= pass_threshold,
        "夹具口径自洽性：高分样例总分 {:.2} 应 ≥ 通过阈值 {:.2}",
        total_high,
        pass_threshold
    );
    // 高分候选 → passed=true、收敛
    let args = r#"{"candidates": [{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}], "dimension_scores": [{"candidate_index": 0, "name": "evidence", "score": 0.9}, {"candidate_index": 0, "name": "relevance", "score": 0.8}, {"candidate_index": 0, "name": "clarity", "score": 0.8}, {"candidate_index": 0, "name": "completeness", "score": 0.8}]}"#.to_string();
    let out = run_tool(review::run, &args);
    let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
    let review0 = reviews[0].as_object().unwrap();
    assert!((review0.get_f64("score").unwrap() - total_high).abs() < 1e-9);
    assert_eq!(review0.get_bool("passed"), Some(true));
    let decision = out.as_object().unwrap().get_object("decision").unwrap();
    assert_eq!(decision.get_bool("converged"), Some(true));
    assert_eq!(decision.get_array("accepted_indices").unwrap().len(), 1);
    // 低证据候选 → passed=false + failing_dimensions 含 evidence
    let args = r#"{"candidates": [{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}], "dimension_scores": [{"candidate_index": 0, "name": "evidence", "score": 0.2}, {"candidate_index": 0, "name": "relevance", "score": 0.8}, {"candidate_index": 0, "name": "clarity", "score": 0.8}, {"candidate_index": 0, "name": "completeness", "score": 0.8}]}"#.to_string();
    let out = run_tool(review::run, &args);
    let reviews = out.as_object().unwrap().get_array("reviews").unwrap();
    let review0 = reviews[0].as_object().unwrap();
    assert_eq!(review0.get_bool("passed"), Some(false));
    let failing = review0.get_array("failing_dimensions").unwrap();
    assert!(
        failing.iter().any(|f| f.as_str() == Some("evidence")),
        "低证据候选应命中 evidence 维度达标线"
    );
    // 轮次上限绑定：round_no >= max_rounds 时不再再生、呈交现状
    let args = format!(
        r#"{{"candidates": [{{"text": "xxxxxxxxxxxxxxxxxxxx", "claims": ["a","b","c"]}}], "dimension_scores": [{{"candidate_index": 0, "name": "evidence", "score": 0.2}}, {{"candidate_index": 0, "name": "relevance", "score": 0.8}}, {{"candidate_index": 0, "name": "clarity", "score": 0.8}}, {{"candidate_index": 0, "name": "completeness", "score": 0.8}}], "round_no": {}}}"#,
        max_rounds
    );
    let out = run_tool(review::run, &args);
    let decision = out.as_object().unwrap().get_object("decision").unwrap();
    assert_eq!(decision.get_bool("converged"), Some(false));
    assert!(decision.get_array("regenerate_indices").unwrap().is_empty());
    assert!(!decision.get_array("notes").unwrap().is_empty());
}

// -- signals.json ↔ 蒸馏执行体（五类信号映射绑定） -------------------------

#[test]
fn signals_json_kinds_bind_to_distill() {
    let signals_json = load("signals.json");
    let kinds = signals_json
        .as_object()
        .unwrap()
        .get_object("signal_kinds")
        .unwrap();
    let mut kind_names: Vec<&str> = kinds.iter().map(|(k, _)| k).collect();
    kind_names.sort_unstable();
    assert_eq!(
        kind_names,
        vec![
            "gap",
            "insight",
            "pitfall",
            "repeated_root_cause",
            "user_correction"
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

// -- 采集执行体：文本大小上限保护 -----------------------------------------

#[test]
fn collect_text_size_cap() {
    let args = json::parse(r#"{"source": "text", "text": "0123456789", "max_bytes": 5}"#).unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("truncated"), Some(true));
    assert_eq!(obj.get_str("content"), Some("01234"));
    // 未超限不截断
    let args = json::parse(r#"{"source": "text", "text": "0123456789"}"#).unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("truncated"), Some(false));
    assert_eq!(obj.get_str("content"), Some("0123456789"));
}

// -- 采集执行体：URL 取回（本地 HTTP 服务端，真实走 TCP 链路） -------------

/// 起一个本地 HTTP 服务端：按请求顺序返回 canned 响应（响应 = 状态行 +
/// 头 + 体原文，测试自己构造，不依赖任何网络库）。listener 归服务线程
/// 持有，端口在测试进程存活期间保持绑定。
fn local_server(responses: Vec<&'static str>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("绑定本地端口失败");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for response in responses {
            let (mut stream, _) = listener.accept().expect("接受连接失败");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
                // 收到完整请求行 + 头即视为请求结束（简化：读到 \r\n\r\n）
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            stream.write_all(response.as_bytes()).expect("写响应失败");
        }
    });
    format!("http://127.0.0.1:{}", port)
}

#[test]
fn collect_url_fetches_over_http() {
    let base = local_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nhello world",
    ]);
    let args = json::parse(&format!(
        r#"{{"source": "url", "url": "{}/doc", "timeout_ms": 3000}}"#,
        base
    ))
    .unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("ok"), Some(true));
    assert_eq!(obj.get_f64("status"), Some(200.0));
    assert_eq!(obj.get_str("content"), Some("hello world"));
    assert_eq!(obj.get_str("content_type"), Some("text/plain"));
    assert_eq!(obj.get_bool("truncated"), Some(false));
    assert!(obj.get_str("url").unwrap().ends_with("/doc"));
}

#[test]
fn collect_url_follows_redirect() {
    let base = local_server(vec![
        "HTTP/1.1 301 Moved Permanently\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nfinal",
    ]);
    let args = json::parse(&format!(
        r#"{{"source": "url", "url": "{}/start", "timeout_ms": 3000, "max_redirects": 3}}"#,
        base
    ))
    .unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_f64("status"), Some(200.0));
    assert_eq!(obj.get_str("content"), Some("final"));
}

#[test]
fn collect_url_handles_chunked_encoding() {
    let base = local_server(vec![
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
    ]);
    let args = json::parse(&format!(
        r#"{{"source": "url", "url": "{}/chunked", "timeout_ms": 3000}}"#,
        base
    ))
    .unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_str("content"), Some("hello world"));
    assert_eq!(obj.get_bool("truncated"), Some(false));
}

#[test]
fn collect_url_respects_size_cap() {
    let base = local_server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello world",
    ]);
    let args = json::parse(&format!(
        r#"{{"source": "url", "url": "{}/big", "timeout_ms": 3000, "max_bytes": 5}}"#,
        base
    ))
    .unwrap();
    let out = collect::run(&args).unwrap();
    let obj = out.as_object().unwrap();
    assert_eq!(obj.get_bool("truncated"), Some(true), "超限须截断并标记");
    assert_eq!(obj.get_str("content"), Some("hello"));
}

#[test]
fn collect_url_rejects_unsupported_schemes() {
    let args = json::parse(r#"{"source": "url", "url": "https://example.com"}"#).unwrap();
    let err = collect::run(&args).unwrap_err();
    assert_eq!(err.kind, inkling_exec::tool::ToolErrorKind::ToolError);
    assert!(
        err.message.contains("web_bridge"),
        "https 报错须指引宿主 web_bridge"
    );
}

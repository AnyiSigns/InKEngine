"""路径组装器单测：三层产出 + 修复算子矩阵 + 负面草稿矩阵 + 集成闭环。

覆盖（按任务矩阵）：
- 单元：schema 反推 goal→候选链（多源汇聚合法）、beam 排序目标相关度
  优先（实验定稿）、安全档剪枝、top-k 确定性序、多径判据复用
  edge_evidence（信号只读）、冷启动指数与探索模式判定；
- 修复算子：replace_node / add_branch / remove_node / reroute_edge 各自
  可达性，修复驱动轮序与不可达返回 None（→ 全量重组装兜底）；
- 负面草稿矩阵：不可达收尾结点 → 算法修复替换断言；修复也不可达 → 全量
  算法兜底；固执 stub 连续 3 次同一非法草稿 → 重试上限 2 后强制兜底；
  空响应/非 JSON → 不重试直接兜底；
- 集成（stub 草稿源）：组装 → 校验通过 → 产物 to_dict/from_dict 合法 +
  canary 试跑走通 + 候选事件类型注册 + 审计记录落库断言；
- 开关：enabled=False 零生效（无候选/无回调/无草稿调用）。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from conftest import make_engine

from ink_engine.core.contracts import PathAssemblyConfig
from ink_engine.core.edge_evidence import (
    EdgeEvidence,
    EdgeEvidenceStore,
    EdgeKey,
)
from ink_engine.core.event_types import (
    EVENT_ASSEMBLY_CANDIDATE,
    EVENT_STATUS_REGISTERED,
    EventTypeRegistry,
    assembly_candidate_event_spec,
    register_path_assembly_event_types,
)
from ink_engine.core.fingerprint import graph_fingerprint, request_fingerprint
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.path_assembler import (
    CANDIDATE_SOURCE_ALGORITHM,
    InMemoryPoolRetriever,
    PathAssembler,
    add_branch,
    parse_draft_chain,
    remove_node,
    repair_chain,
    replace_node,
    reroute_edge,
    validate_chain,
)
from ink_engine.core.registry import NodeTypeRegistry
from ink_engine.core.schema_validator import (
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)
from ink_engine.core.state import StateSchema

ENTRY = ("user_query",)
DUMMY_NOW = 1_800_000_000.0


def _field(name: str, required: bool = False, kind: str = FIELD_STRING) -> SchemaField:
    return SchemaField(name=name, required=required, kind=kind)


def _spec(name: str, *fields: SchemaField) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(fields))


def _contract(inputs: tuple[str, ...] = (), outputs: tuple[str, ...] = (),
              *, safety_tier: int = 0, version: int = 1):
    input_schema = _spec("in", *(_field(n, required=True) for n in inputs))
    output_schema = _spec("out", *(_field(n) for n in outputs))
    from ink_engine.core.contracts import NodeContract

    return NodeContract(
        input_schema=input_schema,
        output_schema=output_schema,
        safety_tier=safety_tier,
        version=version,
    )


# ── 结点池（实验同源：10 结点，多源汇聚 + 双答案收尾）─────────────

POOL_SPECS: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
    ("intent_parse", (), ("intent", "domains")),
    ("domain_router", ("intent",), ("spec", "query")),
    ("web_search", ("query",), ("search_results",)),
    ("code_gen", ("spec",), ("code",)),
    ("code_gen_v2", ("spec",), ("code",)),
    ("test_gen", ("code",), ("tests",)),
    ("doc_gen", ("spec", "code"), ("doc",)),
    ("qa_check", ("code", "tests"), ("quality_report",)),
    ("report_assemble", ("search_results", "quality_report", "doc"), ("answer",)),
    ("answer_direct", ("search_results",), ("answer",)),
)

DEFAULT_VERSIONS: dict[str, int] = {}


def _stub_node(config: dict[str, Any] | None = None):
    async def node(ctx):
        return {}

    return node


def make_registry(
    pool_specs: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = POOL_SPECS,
    *,
    safety_tier: dict[str, int] | None = None,
    versions: dict[str, int] | None = None,
) -> NodeTypeRegistry:
    """测试注册表（契约随类型登记；工厂为无副作用 stub——canary 可跑通）。"""
    registry = NodeTypeRegistry()
    tiers = safety_tier or {}
    vers = versions or {}
    for type_name, inputs, outputs in pool_specs:
        registry.register(
            type_name,
            lambda config, _t=type_name: _stub_node(config),
            contract=_contract(
                inputs, outputs,
                safety_tier=tiers.get(type_name, 0),
                version=vers.get(type_name, 1),
            ),
        )
    return registry


def pool_of(registry: NodeTypeRegistry) -> dict[str, Any]:
    return {name: registry.contract_for(name) for name in registry.types()}


def _request(
    goal_fields: tuple[str, ...],
    *,
    entry: tuple[str, ...] = ENTRY,
    domain: str = "code",
    tier: int = 0,
    provider: Any = None,
    top_k: int = 2,
    state_schema: StateSchema | None = None,
) -> Any:
    from ink_engine.core.path_assembler import AssemblyRequest

    return AssemblyRequest(
        goal_schema=_spec("goal", *(_field(f, required=True) for f in goal_fields)),
        entry_fields=entry,
        domain=domain,
        max_safety_tier=tier,
        draft_provider=provider,
        top_k=top_k,
        state_schema=state_schema,
    )


class FixedDraftProvider:
    """固定文本草稿源（模拟模型行为：计调用次数，可断言重试/兜底）。"""

    def __init__(self, *texts: str) -> None:
        self._texts = list(texts)
        self.calls: list[Any] = []

    async def draft(self, context: Any) -> str:
        self.calls.append(context)
        return self._texts[min(len(self.calls) - 1, len(self._texts) - 1)]


def make_assembler(
    registry: NodeTypeRegistry | None = None,
    *,
    store: EdgeEvidenceStore | None = None,
    retriever: Any = None,
    config: PathAssemblyConfig | None = None,
    sink: Any = None,
    now: float | None = DUMMY_NOW,
) -> PathAssembler:
    return PathAssembler(
        registry=registry or make_registry(),
        evidence_store=store,
        retriever=retriever,
        config=config,
        sink=sink,
        now=now,
    )


# ── 单元：schema 反推 / 目标字段 ──────────────────────────────────

def test_goal_fields_prefer_required_then_declared():
    """目标字段 = 必填字段优先；无必填 = 全部声明字段；空 = 无字段。"""
    from ink_engine.core.path_assembler import AssemblyRequest

    required_only = AssemblyRequest(
        goal_schema=_spec("g", _field("a", required=True), _field("b"))
    )
    assert required_only.goal_fields() == ("a",)
    all_declared = AssemblyRequest(
        goal_schema=_spec("g", _field("a"), _field("b"))
    )
    assert all_declared.goal_fields() == ("a", "b")
    assert AssemblyRequest().goal_fields() == ()


async def test_assemble_empty_goal_returns_empty_with_reason():
    """目标 schema 未声明字段 = 空结果 + 原因（不误组装）。"""
    registry = make_registry()
    result = await make_assembler(registry).assemble(
        _request(())
    )
    assert result.is_empty
    assert "未声明字段" in (result.fallback_reason or "")


async def test_algorithm_solves_goal_with_multi_source_convergence():
    """schema 反推：goal → 候选链；qa_check 多源汇聚（code+tests）合法。"""
    result = await make_assembler().assemble(
        _request(("code", "tests", "quality_report"))
    )
    assert not result.is_empty
    top = result.candidates[0]
    assert "qa_check" in top.chain
    assert "code_gen" in top.chain
    assert "test_gen" in top.chain
    ok, reasons = validate_chain(
        top.chain,
        pool=pool_of(make_registry()),
        goal_fields=("code", "tests", "quality_report"),
        entry_fields=ENTRY,
    )
    assert ok, reasons


async def test_candidates_ranked_deterministically():
    """排序确定性：同输入两次组装同序（证据分 → 链长 → 链序）。"""
    result_a = await make_assembler().assemble(_request(("answer",)))
    result_b = await make_assembler().assemble(_request(("answer",)))
    assert [c.chain for c in result_a.candidates] == [c.chain for c in result_b.candidates]
    # 零证据并列时链长升序（便宜路径优先的确定性体现）
    assert result_a.candidates[0].chain[-1] == "answer_direct"


async def test_safety_tier_clips_high_tier_nodes():
    """安全档剪枝：目标安全档 2 的结点不进低档路径（默认 0 最严）。"""
    registry = make_registry(safety_tier={"answer_direct": 0, "report_assemble": 2})
    strict = await make_assembler(registry).assemble(
        _request(("answer",), tier=0, top_k=3)
    )
    loose = await make_assembler(registry).assemble(
        _request(("answer",), tier=2, top_k=20)
    )
    assert all("report_assemble" not in c.chain for c in strict.candidates)
    assert "answer_direct" in strict.candidates[0].chain
    # 放行档位抬高后高安全结点可入链（高安全结点不可进低信任路径）
    assert any("report_assemble" in c.chain for c in loose.candidates)
    ok, _ = validate_chain(
        strict.candidates[0].chain,
        pool=pool_of(registry),
        goal_fields=("answer",),
        entry_fields=ENTRY,
        max_safety_tier=0,
    )
    assert ok


async def test_stats_reported():
    """统计口径：beam 扩展/评分计算量/修复/草稿调用次数随结果携带。"""
    result = await make_assembler().assemble(_request(("answer",)))
    assert result.stats["beam_extensions"] > 0
    assert result.stats["edge_score_calls"] > 0
    assert result.stats["repair_attempts"] == 0
    assert result.stats["llm_attempts"] == 0


async def test_cold_start_triggers_exploration():
    """冷启动：零证据 = 指数 0 → 探索模式。"""
    result = await make_assembler().assemble(_request(("answer",)))
    assert result.cold_start_index == 0.0
    assert result.exploration_mode is True


# ── 单元：beam 排序目标相关度优先（实验定稿）─────────────────────

def test_beam_order_goal_relevance_first():
    """beam 排序 = 目标相关度优先：字段多但零目标相关的分支被挤出 beam。

    对照实验发现 1（v2 贪婪按覆盖字段数排序的 deadlock）：字段丰富的
    无关分支会抢占 beam，目标相关分支被挤出——排序必须目标相关度优先。
    """
    from ink_engine.core.path_assembler import _forward_search

    tiny_pool = {
        "rich": _contract((), ("x", "y")),  # 产出 2 字段但零目标相关
        "goal_provider": _contract((), ("dz",)),
        "plain": _contract((), ("a_out",)),
    }
    found = _forward_search(
        ("dz",), (), tiny_pool, beam_width=1, max_depth=4
    )
    assert found and found[0] == ("goal_provider",)  # 目标相关分支先在 beam 中胜出
    assert any(chain[0] == "goal_provider" for chain in found)  # 解未因字段多分支挤没
    assert not any(chain == ("rich",) or chain == ("plain",) for chain in found)


async def test_beam_keeps_parallel_branch_competitor_search():
    """beam 保活并行分支：market_report 目标下 competitor 链不被挤出。"""
    v3_like = make_registry(
        (
            ("intent_parse", ("user_query",), ("intent", "domains")),
            ("task_planner", ("intent",), ("spec", "query")),
            ("frontend_gen", ("spec",), ("frontend_code",)),
            ("backend_gen", ("spec",), ("backend_code",)),
            ("api_design", ("spec",), ("api_spec",)),
            ("unit_tests", ("frontend_code", "backend_code"), ("unit_tests",)),
            (
                "integration_tests",
                ("frontend_code", "backend_code", "api_spec"),
                ("integration_tests",),
            ),
            (
                "security_review",
                ("frontend_code", "backend_code", "api_spec"),
                ("security_report",),
            ),
            ("competitor_search", ("query",), ("competitor_data",)),
            ("market_analysis", ("competitor_data", "domains"), ("market_report",)),
            ("quality_check", ("unit_tests", "integration_tests", "security_report"),
             ("quality_report",)),
            ("report_assemble", ("market_report", "quality_report"), ("answer",)),
            ("answer_direct", ("competitor_data",), ("answer",)),
        )
    )
    result = await make_assembler(v3_like).assemble(
        _request(("market_report", "answer"), entry=("user_query",), top_k=3)
    )
    assert not result.is_empty
    chains = [c.chain for c in result.candidates]
    assert any("competitor_search" in c for c in chains)
    assert any("market_analysis" in c for c in chains)
    # 每个候选都合法（分支链没有被挤掉导致目标覆盖失败）
    for chain in chains:
        ok, reasons = validate_chain(
            chain,
            pool=pool_of(v3_like),
            goal_fields=("market_report", "answer"),
            entry_fields=("user_query",),
        )
        assert ok, reasons


# ── 单元：修复算子各算子可达性 ────────────────────────────────────

def test_replace_node_replaces_unreachable_tail():
    """替换算子（T2 型）：report_assemble 不可达收尾 → 替换为 answer_direct。"""
    pool = pool_of(make_registry())
    chain = ("intent_parse", "domain_router", "web_search", "report_assemble")
    ok, reasons = validate_chain(chain, pool=pool, goal_fields=("answer",),
                                 entry_fields=ENTRY)
    assert not ok  # 前置前置——草稿确实非法
    assert any("输入字段不可达" in r for r in reasons)
    repaired = replace_node(chain, pool=pool, goal_fields=("answer",), entry_fields=ENTRY)
    assert repaired == ("intent_parse", "domain_router", "web_search", "answer_direct")
    ok, reasons = validate_chain(repaired, pool=pool, goal_fields=("answer",),
                                 entry_fields=ENTRY)
    assert ok, reasons


def test_add_branch_fills_gap():
    """补链算子：qa_check 缺 tests 前置 → 补 test_gen 链（多源汇聚）。"""
    pool = pool_of(make_registry())
    chain = ("intent_parse", "domain_router", "code_gen", "qa_check")
    repaired = add_branch(chain, pool=pool, goal_fields=("quality_report",),
                          entry_fields=ENTRY)
    assert repaired == ("intent_parse", "domain_router", "code_gen", "test_gen", "qa_check")
    assert validate_chain(repaired, pool=pool,
                          goal_fields=("quality_report",), entry_fields=ENTRY)[0]


def test_add_branch_appends_goal_producer():
    """补链算子（目标缺口）：目标字段无生产者 → 链尾追加生产链；无法生产 = None。"""
    pool = pool_of(make_registry())
    chain = ("intent_parse", "domain_router", "web_search")
    repaired = add_branch(chain, pool=pool, goal_fields=("answer",), entry_fields=ENTRY)
    assert repaired == ("intent_parse", "domain_router", "web_search", "answer_direct")
    # 池中无 answer 生产者模拟：goal 字段不可生产 → None
    missing_pool = {
        "intent_parse": pool["intent_parse"],
        "domain_router": pool["domain_router"],
    }
    assert add_branch(chain, pool=missing_pool, goal_fields=("answer",),
                      entry_fields=ENTRY) is None


def test_remove_node_prunes_redundant_tail():
    """剪枝算子：冗余尾结点（产出无后继需求也不补目标）删除。"""
    pool = pool_of(make_registry())
    chain = ("intent_parse", "domain_router", "code_gen", "test_gen", "qa_check",
             "web_search")
    # 校验链合法（web_search 冗余但可达）
    assert validate_chain(chain, pool=pool, goal_fields=("quality_report",),
                          entry_fields=ENTRY)[0]
    repaired = remove_node(chain, pool=pool, goal_fields=("quality_report",),
                           entry_fields=ENTRY)
    assert repaired == ("intent_parse", "domain_router", "code_gen", "test_gen",
                        "qa_check")


def test_reroute_edge_reorders_producer_before_consumer():
    """改接算子：生产者后置错位 → 移动结点使覆盖顺序成立。"""
    pool = pool_of(make_registry())
    chain = ("intent_parse", "domain_router", "test_gen", "code_gen")
    assert validate_chain(chain, pool=pool, goal_fields=("tests",),
                          entry_fields=ENTRY)[0] is False
    repaired = reroute_edge(chain, pool=pool, goal_fields=("tests",),
                            entry_fields=ENTRY)
    assert repaired == ("intent_parse", "domain_router", "code_gen", "test_gen")
    assert validate_chain(repaired, pool=pool, goal_fields=("tests",),
                          entry_fields=ENTRY)[0]


def test_repair_driver_fixes_and_keeps_valid():
    """修复驱动：不可达草稿 → 修复到合法；已合法链 = 原样返回（不动手）。"""
    pool = pool_of(make_registry())
    broken = ("intent_parse", "domain_router", "web_search", "report_assemble")
    fixed = repair_chain(broken, pool=pool, goal_fields=("answer",), entry_fields=ENTRY)
    assert fixed == ("intent_parse", "domain_router", "web_search", "answer_direct")
    valid = ("intent_parse", "domain_router", "web_search", "answer_direct")
    assert repair_chain(valid, pool=pool, goal_fields=("answer",),
                        entry_fields=ENTRY) == valid


def test_repair_driver_unfixable_returns_none():
    """修复也不可达 → None（调用方走全量算法重组装兜底）。"""
    pool = pool_of(make_registry())
    broken = ("intent_parse", "bogus_node", "answer_direct")
    assert repair_chain(broken, pool=pool, goal_fields=("answer",),
                        entry_fields=ENTRY) is None


# ── 单元：草稿解析 ───────────────────────────────────────────────

def test_parse_draft_chain_variants():
    """草稿解析：json/fence/空白/字符串数组；空或非 JSON = None。"""
    assert parse_draft_chain('["a","b"]') == ("a", "b")
    assert parse_draft_chain('```json\n["a"]\n```') == ("a",)
    assert parse_draft_chain(None) is None
    assert parse_draft_chain("") is None
    assert parse_draft_chain("这是计划文字") is None
    assert parse_draft_chain('{"main": ["a"]}') is None
    assert parse_draft_chain('["a", 3]') is None


# ── 单元：多径判据复用 edge_evidence ──────────────────────────────

async def test_multipath_signal_cold_start_triggers():
    """多径信号：零证据（样本不足）→ 触发（冷启动自然落入触发分支）。"""
    result = await make_assembler().assemble(_request(("answer",)))
    assert result.multipath_signal is True


async def test_multipath_signal_strong_evidence_no_trigger():
    """多径信号：证据强（N≥5 且分差≥0.15）绝不触发。"""
    registry = make_registry()
    store = EdgeEvidenceStore(":memory:")
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="web_search", dst_type="answer_direct",
                        context_domain="code"),
            success_count=30, fail_count=0, avg_cost=1.0,
            last_used_at=DUMMY_NOW, created_at=DUMMY_NOW,
        )
    )
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="qa_check", dst_type="report_assemble",
                        context_domain="code"),
            success_count=5, fail_count=0, avg_cost=9.0,
            last_used_at=DUMMY_NOW, created_at=DUMMY_NOW,
        )
    )
    result = await make_assembler(registry, store=store).assemble(
        _request(("answer",))
    )
    assert result.candidates[0].chain[-1] == "answer_direct"  # 证据分高者优先
    assert result.multipath_signal is False
    await store.close()


async def test_cold_start_index_with_evidence():
    """冷启动指数：部分边有证据 → 指数 > 0；全证据 → 探索模式判定关闭。"""
    registry = make_registry()
    store = EdgeEvidenceStore(":memory:")
    await store.put(
        EdgeEvidence(
            key=EdgeKey(src_type="web_search", dst_type="answer_direct",
                        context_domain="code"),
            success_count=40, fail_count=0,
            last_used_at=DUMMY_NOW, created_at=DUMMY_NOW,
        )
    )
    result = await make_assembler(registry, store=store).assemble(
        _request(("answer",))
    )
    assert result.cold_start_index > 0.0
    assert result.cold_start_index < 1.0  # 未全证据
    assert result.exploration_mode is True  # 指数仍 < 0.3
    await store.close()


# ── 负面草稿矩阵（stub 草稿源驱动全链路）─────────────────────────

def _draft_envelope(**overrides):
    from ink_engine.core.path_assembler import AssemblyEnvelope

    return AssemblyEnvelope(llm_draft=True, **overrides)


async def test_draft_valid_chain_used_and_audited():
    """草稿合法：校验通过 → 进候选；审计记录落库（候选清单 + 指纹）。"""
    records: list[dict[str, Any]] = []
    provider = FixedDraftProvider(
        '["intent_parse","domain_router","code_gen","test_gen","qa_check"]'
    )
    result = await make_assembler(sink=records.append).assemble(
        _request(("code", "tests", "quality_report"), provider=provider),
        envelope=_draft_envelope(),
    )
    assert result.llm_attempts == 1
    assert not result.is_empty
    assert len(records) == 1
    record = records[0]
    assert record["domain"] == "code"
    assert record["fingerprint"] == result.fingerprint
    # 目标字段 = 必填字段（按名排序的确定性序）
    assert record["goal_fields"] == ["code", "quality_report", "tests"]
    assert record["candidates"]
    assert record["candidates"][0]["rank"] == 1
    assert record["llm_attempts"] == 1
    assert result.fingerprint == graph_fingerprint(result.candidates[0].graph)


async def test_draft_t2_unreachable_tail_repaired_by_algorithm():
    """T2 型不可达收尾结点 → 算法修复替换（report_assemble → answer_direct）。"""
    provider = FixedDraftProvider(
        '["intent_parse","domain_router","web_search","report_assemble"]'
    )
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider, top_k=3),
        envelope=_draft_envelope(),
    )
    assert result.llm_attempts == 1
    assert result.fallback_reason is None
    # 修复发生过（修复器替换不可达收尾结点），且没有任何候选因草稿而非法
    assert result.stats["repair_attempts"] == 1
    assert any(c.chain[-1] == "answer_direct" for c in result.candidates)
    for candidate in result.candidates:
        ok, reasons = validate_chain(
            candidate.chain,
            pool=pool_of(make_registry()),
            goal_fields=("answer",),
            entry_fields=ENTRY,
        )
        assert ok, reasons


async def test_draft_unfixable_falls_back_to_full_algorithm():
    """修复也不可达 → 全量算法重组装兜底（草稿路径不产出候选）。"""
    provider = FixedDraftProvider('["intent_parse","bogus_node"]')
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert not result.is_empty
    assert all(
        c.source == CANDIDATE_SOURCE_ALGORITHM for c in result.candidates
    )
    assert result.candidates[0].repaired is False
    assert "重试耗尽" in (result.fallback_reason or "")


async def test_draft_stubborn_same_invalid_three_times_force_fallback():
    """固执 stub 连续 3 次同一非法草稿 → 重试上限 2 后强制算法兜底（不无限循环）。"""
    provider = FixedDraftProvider('["intent_parse","stubborn_node"]')
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert len(provider.calls) == 3  # 首次 + 重试上限 2 次
    assert result.llm_attempts == 3
    assert result.stats["repair_attempts"] == 3  # 每次非法草稿都先试算法修复
    assert not result.is_empty
    assert "重试耗尽" in (result.fallback_reason or "")


async def test_draft_empty_response_no_retry_direct_fallback():
    """空响应 → 不重试直接兜底（仅 1 次调用）。"""
    provider = FixedDraftProvider("")
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert len(provider.calls) == 1
    assert result.llm_attempts == 1
    assert "解析失败" in (result.fallback_reason or "")
    assert not result.is_empty


async def test_draft_non_json_no_retry_direct_fallback():
    """非 JSON 草稿 → 不重试直接兜底（仅 1 次调用）。"""
    provider = FixedDraftProvider("我觉得可以先检索再做答……")
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert len(provider.calls) == 1
    assert result.llm_attempts == 1
    assert "解析失败" in (result.fallback_reason or "")


# ── 集成：产物序列化 + canary 试跑 + 事件类型注册 ────────────────

async def test_integration_candidate_roundtrip_and_canary_run():
    """集成：组装 → 产物 to_dict/from_dict(validate=True) 合法 → canary 试跑走通。"""
    provider = FixedDraftProvider(
        '["intent_parse","domain_router","code_gen","test_gen","qa_check"]'
    )
    registry = make_registry()
    result = await make_assembler(registry).assemble(
        _request(("code", "tests", "quality_report"), provider=provider),
        envelope=_draft_envelope(),
    )
    assert not result.is_empty
    candidate = result.candidates[0]
    data = candidate.to_dict()["graph"]
    rebuilt = Graph.from_dict(data, registry=registry, validate=True)
    assert rebuilt.digest() == candidate.graph.digest()
    assert rebuilt.entry == candidate.chain[0]
    assert rebuilt.exits == {candidate.chain[-1]}
    engine = make_engine(rebuilt)
    _state, run_result = await engine._execute(
        state={},
        thread_id="t-assembly",
        round_id=None,
        resume_from=None,
        trace_id="trace-assembly",
        queue=None,
    )
    assert run_result.reason == TerminateReason.REPLY


async def test_integration_candidate_event_type_registered():
    """观察出口：组装候选事件类型注册进注册表并可判定（宽松校验）。"""
    registry = EventTypeRegistry()
    spec = assembly_candidate_event_spec()
    assert spec.name == EVENT_ASSEMBLY_CANDIDATE
    register_path_assembly_event_types(registry)
    registered = registry.get(EVENT_ASSEMBLY_CANDIDATE)
    assert registered is not None
    assert registered == spec
    verdict = registry.classify(
        EVENT_ASSEMBLY_CANDIDATE,
        {"domain": "code", "ts": DUMMY_NOW, "fingerprint": "abc"},
    )
    assert verdict.status == EVENT_STATUS_REGISTERED
    assert verdict.violations == ()
    missing_domain = registry.classify(EVENT_ASSEMBLY_CANDIDATE, {"ts": DUMMY_NOW})
    assert any("domain" in v for v in missing_domain.violations)


async def test_flag_disabled_zero_effect():
    """开关关闭（enabled=False）零生效：无候选/无草稿调用/无审计回调。"""
    provider = FixedDraftProvider('["intent_parse"]')
    records: list[dict[str, Any]] = []
    assembler = make_assembler(
        config=PathAssemblyConfig(),  # enabled=False（默认关）
        sink=records.append,
    )
    result = await assembler.assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert result.is_empty
    assert provider.calls == []
    assert records == []
    assert result.stats == {}
    assert result.llm_attempts == 0


async def test_flag_enabled_round_trip():
    """开关形态序列化往返后 enabled 语义一致（与装配开关对齐）。"""
    config = PathAssemblyConfig.from_dict(PathAssemblyConfig(enabled=True).to_dict())
    assert config.enabled is True
    result = await make_assembler(config=config).assemble(
        _request(("answer",)),
    )
    assert not result.is_empty


async def test_integration_retriever_protocol_injected():
    """候选缩小消费 Retriever 协议：注入内存检索器与默认兜底等价可用。"""
    registry = make_registry()
    retriever = InMemoryPoolRetriever(pool_of(registry))
    result = await make_assembler(registry, retriever=retriever).assemble(
        _request(("answer",)),
    )
    assert not result.is_empty
    # 草稿层窗口经检索器缩小（草稿源可见摘要 = 检索 top-N）
    provider = FixedDraftProvider('["intent_parse","domain_router","web_search","answer_direct"]')
    draft_result = await make_assembler(registry, retriever=retriever).assemble(
        _request(("answer",), provider=provider),
        envelope=_draft_envelope(),
    )
    assert draft_result.llm_attempts == 1
    seen = provider.calls[0].node_summaries
    assert len(seen) > 0  # 窗口非空且为契约摘要形态
    assert seen[0].type_name
    assert seen[0].outputs is not None


# ── 组装指令入口（assemble_plan + canary 兼容验证链路）────────────

async def test_assemble_plan_unwired_default_zero_effect():
    """未挂载默认运行期 = 机制未装配：返回空结果，零候选零审计。"""
    from ink_engine.core.path_assembler import (
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    previous = get_default_assembly_runtime()
    set_default_assembly_runtime(None)
    try:
        records: list[dict[str, Any]] = []
        result = await assemble_plan(
            _request(("answer",)), audit_sink=records.append
        )
        assert result.is_empty
        assert result.audit == ()
        assert records == []
    finally:
        set_default_assembly_runtime(previous)


async def test_assemble_plan_runtime_canary_and_audit():
    """指令入口：组装 + canary 验证链路（重建 + 单回合）+ 审计留痕。"""
    from ink_engine.core.path_assembler import (
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    previous = get_default_assembly_runtime()
    runtime = PathAssemblyRuntime(
        registry=make_registry(),
        config=PathAssemblyConfig(enabled=True),
        canary=True,
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        records: list[dict[str, Any]] = []
        result = await assemble_plan(
            _request(("answer",)), audit_sink=records.append
        )
        assert not result.is_empty
        assert len(result.canary) == len(result.candidates)
        for verdict in result.canary:
            assert verdict.ok is True, verdict
            assert verdict.executed is True
            assert verdict.terminal == TerminateReason.REPLY
        # 审计留痕：组装记录 + 每条候选 canary 结论
        assert len(records) == 1 + len(result.candidates)
        assert records[0]["domain"] == "code"
        assert records[0]["fingerprint"] == result.fingerprint
        for record in records[1:]:
            assert record["verdict"]["ok"] is True
    finally:
        set_default_assembly_runtime(previous)


async def test_assemble_plan_runtime_disabled_zero_effect():
    """指令入口开关关闭：零候选/零验证/零审计回调（与只读组装同语义）。"""
    from ink_engine.core.path_assembler import (
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    previous = get_default_assembly_runtime()
    runtime = PathAssemblyRuntime(
        registry=make_registry(),
        config=PathAssemblyConfig(),  # enabled=False
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        records: list[dict[str, Any]] = []
        result = await assemble_plan(
            _request(("answer",)), audit_sink=records.append
        )
        assert result.is_empty
        assert result.canary == ()
        assert records == []
    finally:
        set_default_assembly_runtime(previous)


async def test_assembly_request_json_roundtrip():
    """请求数据形态：to_dict/from_dict 往返（运行态注入件分列补挂）。"""
    from ink_engine.core.path_assembler import AssemblyRequest

    request = _request(
        ("answer",), entry=("user_query",), domain="code", tier=2, top_k=3
    )
    data = request.to_dict()
    assert data["domain"] == "code"
    assert data["max_safety_tier"] == 2
    assert data["entry_fields"] == ["user_query"]
    rebuilt = AssemblyRequest.from_dict(data)
    assert rebuilt.goal_fields() == tuple(sorted(request.goal_fields()))
    assert rebuilt.entry_fields == request.entry_fields
    assert rebuilt.max_safety_tier == 2
    assert rebuilt.top_k == 3
    roundtrip = AssemblyRequest.from_dict(rebuilt.to_dict())
    assert roundtrip.goal_fields() == rebuilt.goal_fields()


async def test_canary_round_rejects_broken_execution():
    """canary 单回合：结点异常收尾（error）= 验证失败（执行前风险前置）。"""
    from ink_engine.core.path_assembler import canary_round

    graph = Graph(name="broken", entry="boom")

    async def boom(ctx):
        raise RuntimeError("测试注入的结点故障")

    graph.add_node("boom", boom)
    graph.add_exit("boom")
    round_result = await canary_round(graph)
    assert round_result.ok is False
    assert round_result.reason == TerminateReason.ERROR


async def test_canary_instantiate_rebuilds_candidate():
    """canary 重建级验证：候选产物 to_dict → from_dict(validate=True) 同指纹。"""
    from ink_engine.core.path_assembler import canary_instantiate

    registry = make_registry()
    result = await make_assembler(registry).assemble(_request(("answer",)))
    data = result.candidates[0].to_dict()["graph"]
    rebuilt = canary_instantiate(data, registry=registry)
    assert rebuilt.digest() == result.candidates[0].graph.digest()


# ── ENG9a-3：预算信封全程透传（assemble_plan 入口）────────────────

async def test_assemble_plan_envelope_reaches_draft_layer():
    """envelope 透传（默认路径同样生效）：llm_draft 开关经模块级入口到达
    草稿层——use_draft=true 触发 draft_provider 断言（ENG9a-3）。"""
    from ink_engine.core.path_assembler import (
        AssemblyEnvelope,
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    previous = get_default_assembly_runtime()
    runtime = PathAssemblyRuntime(
        registry=make_registry(),
        config=PathAssemblyConfig(enabled=True),
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        # 未传 envelope：草稿层关闭，provider 不被调用
        off = FixedDraftProvider('["intent_parse","domain_router"]')
        result_off = await assemble_plan(
            _request(("answer",), provider=off), audit_sink=lambda r: None
        )
        assert result_off.llm_attempts == 0
        assert off.calls == []
        # 传 envelope（llm_draft=True）：provider 被调用，草稿链进候选
        on = FixedDraftProvider(
            '["intent_parse","domain_router","web_search","answer_direct"]'
        )
        result_on = await assemble_plan(
            _request(("answer",), provider=on),
            envelope=AssemblyEnvelope(llm_draft=True, llm_retry_limit=1),
            audit_sink=lambda r: None,
        )
        assert result_on.llm_attempts == 1
        assert len(on.calls) == 1
    finally:
        set_default_assembly_runtime(previous)


async def test_runtime_assemble_plan_envelope_beam_and_draft():
    """PathAssemblyRuntime.assemble_plan 的 envelope 直通组装器（beam 宽度
    与草稿开关同达；仅反推解不出时开草稿 = 覆盖率断言）。"""
    from ink_engine.core.path_assembler import (
        AssemblyEnvelope,
        PathAssemblyRuntime,
    )

    provider = FixedDraftProvider(
        '["intent_parse","domain_router","web_search","answer_direct"]'
    )
    runtime = PathAssemblyRuntime(
        registry=make_registry(),
        config=PathAssemblyConfig(enabled=True),
        now=DUMMY_NOW,
    )
    result = await runtime.assemble_plan(
        _request(("answer",), provider=provider),
        envelope=AssemblyEnvelope(llm_draft=True, beam_width=2, max_path_length=6),
    )
    assert result.llm_attempts == 1
    assert len(provider.calls) == 1


# ── ENG9a-11：草稿层三重敞口（条数/长度上限 + 超时兜底 + 反馈消毒）──

def test_parse_draft_chain_imposes_limits():
    """草稿链条数/单条长度上限：超出 = 解析失败（模型输出失控不撑爆上下文）。"""
    from ink_engine.core.path_assembler import (
        MAX_DRAFT_ITEMS,
        MAX_ITEM_CHARS,
        parse_draft_chain,
    )

    assert parse_draft_chain(json.dumps(["a"] * (MAX_DRAFT_ITEMS + 1))) is None
    assert parse_draft_chain(json.dumps(["x" * (MAX_ITEM_CHARS + 1)])) is None
    assert parse_draft_chain(json.dumps(["a", "b"])) == ("a", "b")
    assert parse_draft_chain(json.dumps(["a" * MAX_ITEM_CHARS])) == ("a" * MAX_ITEM_CHARS,)


class _SlowDraftProvider:
    """慢速草稿源（验证草稿层超时兜底；不重试直接转算法兜底）。"""

    def __init__(self) -> None:
        self.calls = 0

    async def draft(self, context: Any) -> str:
        self.calls += 1
        await asyncio.sleep(5)
        return '["intent_parse"]'


async def test_draft_provider_timeout_falls_back_to_algorithm():
    """草稿源超时：wait_for 兜底 → 不重试直接算法层兜底（候选仍产出）。"""
    from ink_engine.core.path_assembler import AssemblyEnvelope

    provider = _SlowDraftProvider()
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=AssemblyEnvelope(llm_draft=True, draft_timeout=0.05, llm_retry_limit=2),
    )
    assert provider.calls == 1  # 超时即放弃，不重试
    assert result.llm_attempts == 1
    assert not result.is_empty  # 算法层兜底产出候选
    assert "草稿源调用异常" in (result.fallback_reason or "")


async def test_draft_feedback_only_codes_and_whitelisted_names():
    """重试反馈消毒：模型自造结点名原文不拼回提示词，只回结构化码 +
    白名单类型名（自反馈注入面关闭）。"""
    from ink_engine.core.path_assembler import AssemblyEnvelope

    provider = FixedDraftProvider(
        '["evil_node"]',
        '["intent_parse","domain_router","web_search","answer_direct"]',
    )
    result = await make_assembler().assemble(
        _request(("answer",), provider=provider),
        envelope=AssemblyEnvelope(llm_draft=True, llm_retry_limit=1),
    )
    assert result.llm_attempts == 2
    assert len(provider.calls) == 2
    feedback = provider.calls[1].feedback
    assert "evil_node" not in feedback
    assert "unknown_node" in feedback  # 结构化理由码


# ── ENG9a-6：canary 护栏（桩化 + 预算上限 + 超时）──────────────────

async def test_canary_active_context_flag():
    """canary 执行态标记：执行期间结点层可见（桩化判定），入口出口复位。"""
    from ink_engine.core.path_assembler import canary_active, canary_round

    seen: list[bool] = []

    async def node(ctx):
        seen.append(canary_active())
        return {}

    graph = Graph(name="canary-flag", entry="n")
    graph.add_node("n", node)
    graph.add_exit("n")
    assert canary_active() is False
    result = await canary_round(graph)
    assert result.ok is True
    assert seen == [True]
    assert canary_active() is False


async def test_canary_step_budget_caps_execution():
    """canary 预算护栏：候选链执行步数超上限即终止（预算维度掐断）。"""
    from ink_engine.core.path_assembler import canary_round

    graph = Graph(name="canary-long", entry="n0")
    for i in range(30):
        graph.add_node(f"n{i}", lambda ctx: {})
    for i in range(29):
        graph.add_edge(f"n{i}", f"n{i + 1}")
    graph.add_exit("n29")
    result = await canary_round(graph)
    assert result.ok is False
    assert result.reason == TerminateReason.BUDGET_EXCEEDED


async def test_canary_timeout_aborts():
    """canary 超时护栏：执行超上限即中断（wait_for 兜底）。"""
    from ink_engine.core.path_assembler import canary_round

    async def slow(ctx):
        await asyncio.sleep(5)
        return {}

    graph = Graph(name="canary-slow", entry="n")
    graph.add_node("n", slow)
    graph.add_exit("n")
    with pytest.raises(asyncio.TimeoutError):
        await canary_round(graph, canary_timeout=0.05)


async def test_runtime_canary_options_propagate_to_execution():
    """canary_options 注入经 PathAssemblyRuntime 到达执行（预算掐断 =
    canary 失败；缺省无掐断 = canary 通过）。"""
    from conftest import DemoBudgetPolicy

    from ink_engine.core.budget import BudgetManager
    from ink_engine.core.path_assembler import (
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )
    from ink_engine.core.run_result import RunOptions

    previous = get_default_assembly_runtime()
    capped = BudgetManager()
    capped.register(DemoBudgetPolicy(max_nodes=0))  # 首个节点边界即超限
    runtime = PathAssemblyRuntime(
        registry=make_registry(),
        config=PathAssemblyConfig(enabled=True),
        canary=True,
        canary_options=RunOptions(budget=capped),
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        result = await assemble_plan(_request(("answer",)), audit_sink=lambda r: None)
        assert not result.is_empty
        assert all(v.ok is False for v in result.canary)  # 预算掐断 → canary 失败
    finally:
        set_default_assembly_runtime(previous)


# ── ENG9a-7：缓存命中候选不重复 canary ────────────────────────────

def _counting_registry(counter: list[int]) -> NodeTypeRegistry:
    """计数结点注册表（结点执行一次计一次；canary 重复执行断言用）。"""
    registry = NodeTypeRegistry()

    async def node(ctx):
        counter.append(1)
        return {"goal": "ok"}

    registry.register(
        "cnt",
        lambda config: node,
        contract=_contract(outputs=("goal",)),
    )
    return registry


async def test_cache_hit_candidates_canary_verified_once():
    """命中候选 canary 只验证一次（全部 ok 直接复用 hit_verdicts）——
    验证成本不翻倍、首批结论进审计（ENG9a-7）。"""
    from ink_engine.core.fingerprint_cache import FingerprintCacheStore
    from ink_engine.core.path_assembler import (
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    counter: list[int] = []
    registry = _counting_registry(counter)
    store = FingerprintCacheStore(":memory:", now=DUMMY_NOW)
    graph = Graph(name="cnt", entry="cnt")
    graph.add_node_type(
        "cnt", "cnt", config={}, contract=registry.contract_for("cnt")
    )
    graph.add_exit("cnt")
    request = _request(("goal",))
    from ink_engine.core.fingerprint import request_fingerprint

    key = request_fingerprint(
        goal_fields=request.goal_fields(),
        entry_fields=request.entry_fields,
        domain=request.domain,
        max_safety_tier=request.max_safety_tier,
        model_id="",
    )
    await store.upsert(
        key,
        path=graph.to_dict(),
        evidence_snapshot=[],
        model_id="",
        gate_passed=True,
        path_fingerprint=graph.digest(),
        domain="code",
    )
    previous = get_default_assembly_runtime()
    runtime = PathAssemblyRuntime(
        registry=registry,
        config=PathAssemblyConfig(enabled=True),
        cache=store,
        cache_epsilon=0.0,
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        result = await assemble_plan(request, audit_sink=lambda r: None)
        assert result.stats["cache_hits"] == 1
        assert len(result.canary) == 1
        assert result.canary[0].ok is True
        assert len(counter) == 1  # 命中验证一次即复用（修复前为 2）
    finally:
        set_default_assembly_runtime(previous)
        await store.close()


# ── ENG9a-5：顶替判据两侧基线统一 ─────────────────────────────────

async def test_replace_baseline_uses_current_evidence():
    """顶替判据两侧同基线：缓存分用当前证据行重算——证据漂移后新链分
    高于旧链当前分即顶替（旧快照不再压制顶替，ENG9a-5）。"""
    from ink_engine.core.edge_evidence import EdgeEvidenceStore, EdgeKey
    from ink_engine.core.fingerprint_cache import (
        FingerprintCacheStore,
    )
    from ink_engine.core.path_assembler import (
        STATS_CACHE_REPLACEMENTS,
        PathAssembler,
    )

    # 小池：A 产 x；B/C 消费 x 产 goal
    small_pool = (
        ("A", (), ("x",)),
        ("B", ("x",), ("goal",)),
        ("C", ("x",), ("goal",)),
    )
    registry = make_registry(small_pool)
    evidence = EdgeEvidenceStore(":memory:")
    cache = FingerprintCacheStore(":memory:", now=DUMMY_NOW)
    assembler = PathAssembler(
        registry=registry,
        evidence_store=evidence,
        cache=cache,
        config=PathAssemblyConfig(enabled=True),
        cache_epsilon=0.0,
        now=DUMMY_NOW,
    )
    request = _request(("goal",))
    first = await assembler.assemble(request)
    assert first.candidates[0].chain == ("A", "B")  # 零证据字典序 B 先
    key = request_fingerprint(
        goal_fields=request.goal_fields(),
        entry_fields=request.entry_fields,
        domain=request.domain,
        max_safety_tier=request.max_safety_tier,
        model_id="",
    )
    b_edge = EdgeKey(src_type="A", dst_type="B", context_domain="code")
    c_edge = EdgeKey(src_type="A", dst_type="C", context_domain="code")
    # 旧条目快照：B 边 30 成功（转正档高分）
    for _ in range(30):
        await evidence.record_success(b_edge, now=DUMMY_NOW)
    await cache.upsert(
        key,
        path=first.candidates[0].graph.to_dict(),
        evidence_snapshot=[e.to_dict() for e in await evidence.list_edges("code")],
        model_id="",
        gate_passed=True,
        path_fingerprint=first.candidates[0].graph.digest(),
        domain="code",
    )
    # 证据漂移：B 边灌失败（当前分大跌），C 边灌中量成功（当前分反超 B
    # 但低于 B 的旧快照分——旧基线会压制顶替，同基线则成立）
    for _ in range(30):
        await evidence.record_failure(b_edge, now=DUMMY_NOW)
    for _ in range(25):
        await evidence.record_success(c_edge, now=DUMMY_NOW)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_REPLACEMENTS] == 1
    assert second.candidates[0].chain == ("A", "C")
    await evidence.close()
    await cache.close()


# ── ENG9a-8：stats 最后一跳（运行期统计累计）───────────────────────

async def test_runtime_stats_total_accumulates():
    """组装统计跨调用累计（assemble_stats op 的数据源）：命中/未命中/
    顶替计数经运行期累积可见，不随单次结果丢失。"""
    from ink_engine.core.edge_evidence import EdgeEvidenceStore
    from ink_engine.core.fingerprint_cache import FingerprintCacheStore
    from ink_engine.core.path_assembler import (
        PathAssemblyRuntime,
        assemble_plan,
        get_default_assembly_runtime,
        set_default_assembly_runtime,
    )

    registry = make_registry()
    evidence = EdgeEvidenceStore(":memory:")
    cache = FingerprintCacheStore(":memory:", now=DUMMY_NOW)
    previous = get_default_assembly_runtime()
    runtime = PathAssemblyRuntime(
        registry=registry,
        evidence_store=evidence,
        config=PathAssemblyConfig(enabled=True),
        cache=cache,
        cache_epsilon=0.0,
        now=DUMMY_NOW,
    )
    set_default_assembly_runtime(runtime)
    try:
        first = await assemble_plan(_request(("answer",)), audit_sink=lambda r: None)
        assert runtime.stats_total["cache_misses"] == 1
        assert runtime.stats_total["beam_extensions"] == first.stats["beam_extensions"]
        # 沉淀侧写入缓存（FingerprintSettleHook 同源形态）后再调：命中累计
        from ink_engine.core.fingerprint import request_fingerprint as _rf

        req = _request(("answer",))
        key = _rf(
            goal_fields=req.goal_fields(),
            entry_fields=req.entry_fields,
            domain=req.domain,
            max_safety_tier=req.max_safety_tier,
            model_id="",
        )
        graph = first.candidates[0].graph
        await cache.upsert(
            key,
            path=graph.to_dict(),
            evidence_snapshot=[],
            model_id="",
            gate_passed=True,
            path_fingerprint=graph.digest(),
            domain="code",
        )
        await assemble_plan(_request(("answer",)), audit_sink=lambda r: None)
        assert runtime.stats_total["cache_hits"] == 1
        assert runtime.stats_total["cache_misses"] == 1  # 命中不再累计 miss
        await assemble_plan(_request(("answer",)), audit_sink=lambda r: None)
        assert runtime.stats_total["cache_hits"] == 2
    finally:
        set_default_assembly_runtime(previous)
        await evidence.close()
        await cache.close()

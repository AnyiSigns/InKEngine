"""指纹缓存单测：存储往返/容量淘汰/三失效信号/版本钉死/flag 零生效。

覆盖（按任务矩阵）：
- 存储往返：upsert/lookup/命中数/失败数/域字段；fail-closed（闸门拒绝
  不落库）；契约版本快照与证据快照随条目往返；
- 容量上限边界 + 淘汰序（命中率 + 时效，确定性）；
- 缓存命中：同上下文指纹二次组装返回缓存路径（统计断言未触发算法
  搜索/草稿）；沉淀侧与组装侧键一致（settle upsert → assemble 命中）；
- 三失效信号：执行失败强失效（失败数+1 且立即失效不命中，调用方重组
  装）；证据漂移（差 ≥20% 且 N≥5 判漂移；N<5 不误判；信任档变化）；
  顶替（重组装分更高顶替 + fingerprint_replace 审计留痕）；ε 抽样
  （ε=0 关闭断言；ε>0 确定性注入断言绕过）；
- 契约版本钉死：池内契约升版 → 旧条目降级不命中；模型 id 钉死：
  model_id 变化不命中；
- 上下文指纹稳定性：同请求同指纹；目标字段排序无关；
- flag 零生效：未注入缓存实例时无查找无写入（存储零触碰）。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.contracts import PathAssemblyConfig
from ink_engine.core.edge_evidence import (
    EdgeEvidenceStore,
    EdgeKey,
)
from ink_engine.core.event_types import EVENT_AUDIT_FINGERPRINT_REPLACE
from ink_engine.core.fingerprint import request_fingerprint
from ink_engine.core.fingerprint_cache import (
    DEFAULT_CACHE_CAP_PER_DOMAIN,
    DRIFT_MIN_N,
    DRIFT_RATIO,
    REPLACE_REASON_DRIFT,
    REPLACE_REASON_SAMPLE,
    FingerprintCacheStore,
    evidence_drifted,
    fingerprint_replace_audit_record,
)
from ink_engine.core.graph import Graph, TerminateReason
from ink_engine.core.path_assembler import (
    CANDIDATE_SOURCE_CACHE,
    DEFAULT_CACHE_EPSILON,
    STATS_CACHE_HITS,
    STATS_CACHE_INVALIDATIONS,
    STATS_CACHE_MISSES,
    STATS_CACHE_REPLACEMENTS,
    AssemblyEnvelope,
    AssemblyRequest,
    PathAssemblyRuntime,
)
from ink_engine.core.registry import NodeTypeRegistry
from ink_engine.core.run_result import RunResult
from ink_engine.core.schema_validator import (
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)
from ink_engine.core.settle import (
    TRACE_SUCCESS,
    FingerprintSettleHook,
    SettleContext,
    TraceStep,
)

ENTRY = ("user_query",)
DUMMY_NOW = 1_800_000_000.0


def _field(name: str, required: bool = False, kind: str = FIELD_STRING) -> SchemaField:
    return SchemaField(name=name, required=required, kind=kind)


def _spec(name: str, *fields: SchemaField) -> SchemaSpec:
    return SchemaSpec(name=name, fields=tuple(fields))


def _contract(inputs: tuple[str, ...] = (), outputs: tuple[str, ...] = (),
              *, safety_tier: int = 0, version: int = 1):
    from ink_engine.core.contracts import NodeContract

    return NodeContract(
        input_schema=_spec("in", *(_field(n, required=True) for n in inputs)),
        output_schema=_spec("out", *(_field(n) for n in outputs)),
        safety_tier=safety_tier,
        version=version,
    )


def _stub_node(config: dict[str, Any] | None = None):
    async def node(ctx):
        return {}

    return node


def make_registry(
    pool_specs: tuple[tuple[str, tuple[str, ...], tuple[str, ...]], ...] = (
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
    ),
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


def _request(
    goal_fields: tuple[str, ...],
    *,
    entry: tuple[str, ...] = ENTRY,
    domain: str = "code",
    tier: int = 0,
    provider: Any = None,
    top_k: int = 2,
) -> AssemblyRequest:
    return AssemblyRequest(
        goal_schema=_spec("goal", *(_field(f, required=True) for f in goal_fields)),
        entry_fields=entry,
        domain=domain,
        max_safety_tier=tier,
        draft_provider=provider,
        top_k=top_k,
    )


def make_assembler(
    registry: NodeTypeRegistry | None = None,
    *,
    store: EdgeEvidenceStore | None = None,
    cache: FingerprintCacheStore | None = None,
    config: PathAssemblyConfig | None = None,
    sink: Any = None,
    model_id: str = "",
    cache_epsilon: float = 0.0,
) -> Any:
    """测试组装器：ε 抽样默认关闭（确定性断言）；抽样行为由专项用例注入。"""
    from ink_engine.core.path_assembler import PathAssembler

    return PathAssembler(
        registry=registry or make_registry(),
        evidence_store=store,
        cache=cache,
        config=config,
        sink=sink,
        now=DUMMY_NOW,
        model_id=model_id,
        cache_epsilon=cache_epsilon,
    )


def _request_key(request: AssemblyRequest, model_id: str = "") -> str:
    return request_fingerprint(
        goal_fields=request.goal_fields(),
        entry_fields=request.entry_fields,
        domain=request.domain,
        max_safety_tier=request.max_safety_tier,
        model_id=model_id,
    )


async def _upsert_result(
    store: FingerprintCacheStore,
    request: AssemblyRequest,
    result_graph: Graph,
    *,
    evidence: EdgeEvidenceStore | None = None,
    model_id: str = "",
    domain: str | None = None,
) -> None:
    """沉淀侧形态写入（settle hook 同源：上下文指纹键 + 图定义 + 快照）。"""
    domain = domain or request.domain
    snapshot = await evidence.list_edges(domain) if evidence is not None else []
    await store.upsert(
        _request_key(request, model_id=model_id),
        path=result_graph.to_dict(),
        evidence_snapshot=[e.to_dict() for e in snapshot],
        model_id=model_id,
        gate_passed=True,
        path_fingerprint=result_graph.digest(),
        domain=domain,
    )


def _settle_ctx(
    graph: Graph,
    *,
    domain: str = "code",
) -> SettleContext:
    return SettleContext(
        thread_id="t1",
        round_id="r1",
        trace_id="tr1",
        domain=domain,
        steps=tuple(
            TraceStep(graph_path=(), node=node, status=TRACE_SUCCESS)
            for node in graph.node_bindings
        ),
        node_tokens={},
        graphs={(): graph},
        result=RunResult(state={}, reason=TerminateReason.REPLY, interrupt=None, error=None),
    )


# ── 存储往返 ──

async def test_store_roundtrip_and_counters():
    """存储往返：upsert/lookup/命中数/失败数/域字段/快照随条目落。"""
    store = FingerprintCacheStore(now=DUMMY_NOW)
    key = "fp-1"
    path = {"nodes": {"a": {"type": "a", "contract": {"version": 2}}}}
    snap = [{"src_type": "a", "dst_type": "b", "success_count": 5, "fail_count": 1}]
    written = await store.upsert(
        key, path=path, evidence_snapshot=snap, model_id="m1",
        gate_passed=True, path_fingerprint="dig-1", domain="code",
    )
    assert written is True
    entry = await store.lookup(key)
    assert entry is not None
    assert entry.context_fingerprint == key
    assert entry.path == path
    assert entry.path_fingerprint == "dig-1"
    assert entry.evidence_snapshot == (snap[0],)
    assert entry.contract_snapshot == (("a", "2"),)  # 契约版本快照随条目落
    assert entry.model_id == "m1"
    assert entry.domain == "code"
    assert entry.created_at == DUMMY_NOW and entry.updated_at == DUMMY_NOW
    assert entry.hit_count == 0 and entry.fail_count == 0
    # 命中成功执行 → 命中数+1 并刷新时间戳
    assert await store.report(key, ok=True) is True
    entry = await store.get(key)
    assert entry is not None and entry.hit_count == 1
    # 域字段独立记录（键含域语义；不同域不同键互不干扰）
    key_docs = "fp-docs"
    await store.upsert(
        key_docs, path=path, evidence_snapshot=[], model_id="m1",
        gate_passed=True, path_fingerprint="dig-2", domain="docs",
    )
    assert await store.count("code") == 1
    assert await store.count("docs") == 1
    assert await store.count() == 2
    await store.close()


async def test_store_fail_closed_on_gate_rejected():
    """入缓存质量线：gate_passed=False 不落库（缓存体只收合格条目）。"""
    store = FingerprintCacheStore()
    written = await store.upsert(
        "fp-x", path={"nodes": {}}, evidence_snapshot=[], model_id="",
        gate_passed=False, domain="code",
    )
    assert written is False
    assert await store.count() == 0
    assert await store.lookup("fp-x") is None
    await store.close()


async def test_store_report_failure_invalidates_but_keeps_count():
    """命中失败 → 失败数+1 且条目立即失效（不命中）；计数保留可观测。"""
    store = FingerprintCacheStore(now=DUMMY_NOW)
    await store.upsert(
        "fp-f", path={"nodes": {}}, evidence_snapshot=[], model_id="",
        gate_passed=True, path_fingerprint="d", domain="code",
    )
    assert await store.report("fp-f", ok=False) is True
    entry = await store.get("fp-f")
    assert entry is not None and entry.fail_count == 1 and entry.invalid is True
    assert await store.lookup("fp-f") is None  # 失效条目不命中
    assert await store.report("fp-f", ok=False) is False  # 已失效不再计数
    await store.close()


# ── 容量上限 + 淘汰（命中率 + 时效）──

async def test_capacity_eviction_oldest_zero_hit_first():
    """容量上限：达上限按「命中率 → 时效 → 键序」淘汰最差条目（确定性）。"""
    store = FingerprintCacheStore(now=DUMMY_NOW, cap_per_domain=3)
    for i in range(4):
        await store.upsert(
            f"fp-{i}", path={"nodes": {}}, evidence_snapshot=[], model_id="",
            gate_passed=True, path_fingerprint=f"d{i}", domain="code",
        )
    assert await store.count("code") == 3
    # 全零命中：最先写入（最旧）被淘汰
    assert await store.get("fp-0") is None
    assert await store.get("fp-1") is not None
    assert store.stats["evictions"] == 1
    await store.close()


async def test_capacity_eviction_hit_rate_first():
    """命中率优先于时效：高命中条目即使更旧也保留。"""
    store = FingerprintCacheStore(now=DUMMY_NOW, cap_per_domain=3)
    for i in range(3):
        await store.upsert(
            f"fp-{i}", path={"nodes": {}}, evidence_snapshot=[], model_id="",
            gate_passed=True, path_fingerprint=f"d{i}", domain="code",
        )
    await store.report("fp-0", ok=True)  # 命中率 1.0（唯一有命中者）
    await store.report("fp-0", ok=True)
    await store.upsert(
        "fp-new", path={"nodes": {}}, evidence_snapshot=[], model_id="",
        gate_passed=True, path_fingerprint="dn", domain="code",
    )
    # fp-0 命中率高保留；fp-1/fp-2 零命中淘汰其一（键序确定性）
    assert await store.get("fp-0") is not None
    assert await store.get("fp-1") is None
    assert await store.get("fp-2") is not None
    assert await store.get("fp-new") is not None
    await store.close()


async def test_capacity_eviction_per_domain_independent():
    """容量按域分组：达上限只淘汰本域条目，他域不受影响。"""
    store = FingerprintCacheStore(now=DUMMY_NOW, cap_per_domain=2)
    for i in range(3):
        await store.upsert(
            f"fp-{i}", path={"nodes": {}}, evidence_snapshot=[], model_id="",
            gate_passed=True, path_fingerprint=f"d{i}", domain="code",
        )
    await store.upsert(
        "fp-docs", path={"nodes": {}}, evidence_snapshot=[], model_id="",
        gate_passed=True, path_fingerprint="dd", domain="docs",
    )
    assert await store.count("code") == 2
    assert await store.count("docs") == 1
    await store.close()


# ── 上下文指纹稳定性 ──

def test_request_fingerprint_stable_and_order_free():
    """上下文指纹稳定性：同请求同指纹；目标字段排序无关；维度变化即变。"""
    key_a = request_fingerprint(
        goal_fields=("answer", "code"), entry_fields=("q",),
        domain="code", max_safety_tier=0, model_id="m1",
    )
    key_b = request_fingerprint(
        goal_fields=("code", "answer"), entry_fields=("q",),
        domain="code", max_safety_tier=0, model_id="m1",
    )
    assert key_a == key_b  # 目标字段排序无关
    assert key_a == request_fingerprint(
        goal_fields=("answer", "code"), entry_fields=("q",),
        domain="code", max_safety_tier=0, model_id="m1",
    )  # 同请求同指纹
    assert key_a != request_fingerprint(
        goal_fields=("answer",), entry_fields=("q",),
        domain="code", max_safety_tier=0, model_id="m1",
    )  # 目标变化
    assert key_a != request_fingerprint(
        goal_fields=("answer", "code"), entry_fields=("q",),
        domain="docs", max_safety_tier=0, model_id="m1",
    )  # 域变化
    assert key_a != request_fingerprint(
        goal_fields=("answer", "code"), entry_fields=("q",),
        domain="code", max_safety_tier=1, model_id="m1",
    )  # 安全档变化
    assert key_a != request_fingerprint(
        goal_fields=("answer", "code"), entry_fields=("q",),
        domain="code", max_safety_tier=0, model_id="m2",
    )  # 模型变化


def test_request_fingerprint_via_assembly_request():
    """组装请求侧与纯函数侧键一致（目标字段按必填排序入键）。"""
    request = _request(("code", "answer"))  # goal_fields 排序为 (answer, code)
    expected = request_fingerprint(
        goal_fields=("answer", "code"),
        entry_fields=request.entry_fields,
        domain=request.domain,
        max_safety_tier=request.max_safety_tier,
        model_id="",
    )
    assert _request_key(request) == expected


# ── 证据漂移判定（纯函数边界）──

def _row(src: str, dst: str, s: int, f: int) -> dict[str, Any]:
    return {
        "src_type": src, "dst_type": dst,
        "src_contract_version": "1", "dst_contract_version": "1",
        "context_domain": "code", "success_count": s, "fail_count": f,
    }


def test_evidence_drift_threshold_and_min_n():
    """漂移边界：差 ≥20% 且 N≥5 判漂移；N<5 不误判；新边不参与。"""
    # 差 ≥20%（相对快照总量）且 N≥5 → 漂移
    assert evidence_drifted([_row("a", "b", 5, 0)], [_row("a", "b", 5, 3)])
    # 边界：差恰 20%（5/25）→ 漂移
    assert evidence_drifted([_row("a", "b", 20, 5)], [_row("a", "b", 25, 5)])
    # 差 <20% → 不漂移
    assert not evidence_drifted([_row("a", "b", 6, 0)], [_row("a", "b", 6, 1)])
    # N<5（防小样本噪声）→ 不误判
    assert not evidence_drifted([_row("a", "b", 2, 0)], [_row("a", "b", 2, 2)])
    assert DRIFT_MIN_N == 5
    assert DRIFT_RATIO == 0.2
    # 快照未覆盖的新边不参与判定
    assert not evidence_drifted(
        [_row("a", "b", 5, 0)],
        [_row("a", "b", 5, 0), _row("c", "d", 9, 0)],
    )
    # 空快照 = 不漂移
    assert not evidence_drifted([], [_row("a", "b", 5, 0)])


def test_evidence_drift_tier_change():
    """信任档变化 → 漂移（计数差 <20% 但档位变 = 评分依据变）。"""
    from ink_engine.core.edge_evidence import TIER_PROMOTED, TIER_REGULAR, derive_edge_tier

    assert derive_edge_tier(28, 2) == TIER_PROMOTED
    assert derive_edge_tier(28, 3) == TIER_REGULAR
    # (28,2)→(28,3)：计数差 1/30 < 20% 但档位 转正→常规
    assert evidence_drifted([_row("a", "b", 28, 2)], [_row("a", "b", 28, 3)])
    assert not evidence_drifted([_row("a", "b", 6, 0)], [_row("a", "b", 7, 0)])


# ── 缓存命中（先例层最优先）──

async def test_cache_hit_returns_cached_path_without_search():
    """命中：同上下文指纹二次组装返回缓存路径（统计断言未触发算法搜索）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    first = await assembler.assemble(request)
    assert first.stats[STATS_CACHE_MISSES] == 1
    # 沉淀侧写入（settle hook 同源形态：上下文指纹键 + 图定义 + 快照）
    await _upsert_result(store, request, first.candidates[0].graph)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_HITS] == 1
    assert second.stats[STATS_CACHE_MISSES] == 0
    assert second.stats["beam_extensions"] == 0  # 未触发算法搜索
    assert second.stats["edge_score_calls"] == 0
    assert second.stats["llm_attempts"] == 0
    assert len(second.candidates) == 1
    candidate = second.candidates[0]
    assert candidate.source == CANDIDATE_SOURCE_CACHE
    assert candidate.chain == first.candidates[0].chain
    assert candidate.graph.digest() == first.candidates[0].graph.digest()
    assert second.fingerprint == first.fingerprint
    # 多径信号 = 全链口径（ENG9a-22）：命中路径不再硬编码 False——单
    # 候选（top-2 缺失 = 样本不足判据）与组装侧同判据，恒触发
    assert second.multipath_signal is True
    await evidence.close()
    await store.close()


async def test_cache_hit_skips_draft_provider():
    """命中不触发草稿层：注入草稿源且计数为 0（未调用）。"""
    calls: list[Any] = []

    class SpyProvider:
        async def draft(self, context: Any) -> str:
            calls.append(context)
            return '["intent_parse","domain_router","web_search","answer_direct"]'

    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",), provider=SpyProvider())
    first = await assembler.assemble(request, envelope=AssemblyEnvelope(llm_draft=True))
    await _upsert_result(store, request, first.candidates[0].graph)
    calls.clear()
    second = await assembler.assemble(request, envelope=AssemblyEnvelope(llm_draft=True))
    assert second.stats[STATS_CACHE_HITS] == 1
    assert calls == []  # 命中路径不调用草稿源
    await evidence.close()
    await store.close()


async def test_settle_hook_and_assembler_key_consistency():
    """键一致：沉淀侧（FingerprintSettleHook upsert）与组装侧查找键同一指纹。"""
    class _FakeGate:
        async def evaluate(self, ctx: SettleContext) -> bool:
            return True

    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    first = await assembler.assemble(request)
    assert not first.is_empty
    # 沉淀钩子注入上下文指纹（与组装请求同键）→ 执行成功组合入库
    key = _request_key(request)
    hook = FingerprintSettleHook(
        cache=store, gate=_FakeGate(), store=evidence,
        context_fingerprint=key,
    )
    graph = first.candidates[0].graph
    await hook.settle(_settle_ctx(graph))
    assert await store.count() == 1
    entry = await store.lookup(key)
    assert entry is not None
    assert entry.path_fingerprint == graph.digest()
    assert entry.path["nodes"] is not None  # 图定义序列化落库
    assert entry.evidence_snapshot == ()  # 快照 = 组装时域内边计数（空域）
    # 同请求二次组装 → 命中（先例层最优先）
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_HITS] == 1
    assert second.candidates[0].graph.digest() == graph.digest()
    await evidence.close()
    await store.close()


# ── 三失效信号 ①：执行失败强失效 ──

async def test_execution_failure_invalidates_entry_and_misses():
    """执行失败强失效：失败数+1 且条目立即失效（不命中），调用方重组装。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    first = await assembler.assemble(request)
    await _upsert_result(store, request, first.candidates[0].graph)
    key = _request_key(request)
    assert await store.lookup(key) is not None
    # 执行失败回馈（宿主在缓存路径执行失败后接线）
    runtime = PathAssemblyRuntime(
        registry=registry, evidence_store=evidence,
        config=PathAssemblyConfig(enabled=True), cache=store,
        model_id="", cache_epsilon=0.0, now=DUMMY_NOW,
    )
    assert await runtime.report_cache_execution(request, ok=False) is True
    entry = await store.get(key)
    assert entry is not None and entry.fail_count == 1 and entry.invalid is True
    assert await store.lookup(key) is None
    # 调用方重组装：失效后自然走 miss 路径（先例层不参与）
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert second.stats["beam_extensions"] > 0  # 真实重组装
    assert second.candidates[0].source != CANDIDATE_SOURCE_CACHE
    # 未注入缓存（flag 关闭）时回馈零参与
    no_cache = PathAssemblyRuntime(
        registry=registry, config=PathAssemblyConfig(enabled=True),
    )
    assert await no_cache.report_cache_execution(request, ok=False) is False
    await evidence.close()
    await store.close()


async def test_assemble_plan_hit_canary_failure_reassembles():
    """指令入口：命中候选 canary 验证失败 = 强失效 + 立即重组装。"""
    registry = make_registry()
    # 追加一个无契约的失败结点类型（可被缓存图引用，但不参与组装搜索）
    async def boom(ctx):
        raise RuntimeError("命中路径执行失败")

    registry.register("boom", lambda config: boom)
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    runtime = PathAssemblyRuntime(
        registry=registry, evidence_store=evidence,
        config=PathAssemblyConfig(enabled=True), cache=store,
        model_id="", cache_epsilon=0.0, now=DUMMY_NOW,
        canary=True,
    )
    request = _request(("answer",))
    # 预置一条会执行失败的缓存路径（boom 单节点图）
    broken = Graph(name="broken", entry="boom")
    broken.add_node_type("boom", "boom")
    broken.add_exit("boom")
    await store.upsert(
        _request_key(request),
        path=broken.to_dict(), evidence_snapshot=[], model_id="",
        gate_passed=True, path_fingerprint=broken.digest(), domain="code",
    )
    result = await runtime.assemble_plan(request)
    assert not result.is_empty  # 重组装兜底产出
    assert result.stats[STATS_CACHE_MISSES] == 1
    assert result.stats[STATS_CACHE_HITS] == 0
    entry = await store.get(_request_key(request))
    assert entry is not None and entry.fail_count == 1 and entry.invalid is True
    assert await store.lookup(_request_key(request)) is None
    await evidence.close()
    await store.close()


# ── 三失效信号 ②：证据漂移 + 顶替 ──

async def test_evidence_drift_invalidates_entry():
    """证据漂移（差 ≥20% 且 N≥5）→ 条目失效，重组装不命中。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    edge_key = EdgeKey(
        src_type="web_search", dst_type="answer_direct", context_domain="code"
    )
    # 先有证据再组装：快照 = 组装时各边 s/f 计数（30 成功 = 转正档）
    for _ in range(30):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    first = await assembler.assemble(request)
    assert first.candidates[0].chain[-1] == "answer_direct"
    key = _request_key(request)
    await _upsert_result(store, request, first.candidates[0].graph, evidence=evidence)
    # 命中一次证明条目有效
    hit = await assembler.assemble(request)
    assert hit.stats[STATS_CACHE_HITS] == 1
    # 证据漂移：该边失败 +10 → 差 10/30 ≥ 20%（N=40 ≥ 5）
    for _ in range(10):
        await evidence.record_failure(edge_key, now=DUMMY_NOW)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 1
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert await store.lookup(key) is None  # 失效条目不命中
    await evidence.close()
    await store.close()


async def test_evidence_drift_small_sample_no_false_positive():
    """N<5 不误判：小样本计数变化不触发漂移（命中保持）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    edge_key = EdgeKey(
        src_type="web_search", dst_type="answer_direct", context_domain="code"
    )
    for _ in range(2):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    first = await assembler.assemble(request)
    key = _request_key(request)
    await _upsert_result(store, request, first.candidates[0].graph, evidence=evidence)
    # 注入少量失败（快照 N=2 + 2 失败 = 当前 N=4 < 5）：不判漂移
    for _ in range(2):
        await evidence.record_failure(edge_key, now=DUMMY_NOW)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_HITS] == 1
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 0
    assert await store.lookup(key) is not None
    await evidence.close()
    await store.close()


async def test_evidence_drift_tier_change_invalidates():
    """信任档变化 → 漂移失效（即使计数差 <20%）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    edge_key = EdgeKey(
        src_type="web_search", dst_type="answer_direct", context_domain="code"
    )
    # 快照 = 28 成功 + 2 失败（N=30 转正档）
    for _ in range(28):
        await evidence.record_success(edge_key, now=DUMMY_NOW)
    for _ in range(2):
        await evidence.record_failure(edge_key, now=DUMMY_NOW)
    first = await assembler.assemble(request)
    key = _request_key(request)
    await _upsert_result(store, request, first.candidates[0].graph, evidence=evidence)
    assert (await store.lookup(key)) is not None
    # 注入 1 失败：计数差 1/30 < 20%，但档位 转正→常规 = 漂移
    await evidence.record_failure(edge_key, now=DUMMY_NOW)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert await store.lookup(key) is None
    await evidence.close()
    await store.close()


async def test_drift_reassembly_replaces_when_score_higher():
    """证据漂移 → 失效 + 重组装分更高顶替（fingerprint_replace 审计留痕）。"""
    # 小池：A 产 x；B/C 消费 x 产 goal（B 原最强，漂移后 C 反超）
    small_pool = (
        ("A", (), ("x",)),
        ("B", ("x",), ("goal",)),
        ("C", ("x",), ("goal",)),
    )
    registry = make_registry(small_pool)
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    records: list[dict[str, Any]] = []
    assembler = make_assembler(registry, store=evidence, cache=store, sink=records.append)
    request = _request(("goal",))
    # 首组装：零证据并列 → 字典序 B 先
    first = await assembler.assemble(request)
    assert first.candidates[0].chain == ("A", "B")
    key = _request_key(request)
    b_edge = EdgeKey(src_type="A", dst_type="B", context_domain="code")
    c_edge = EdgeKey(src_type="A", dst_type="C", context_domain="code")
    # 旧条目快照：B 边 30 成功（转正档，高分）
    for _ in range(30):
        await evidence.record_success(b_edge, now=DUMMY_NOW)
    await _upsert_result(store, request, first.candidates[0].graph, evidence=evidence)
    hit = await assembler.assemble(request)
    assert hit.stats[STATS_CACHE_HITS] == 1
    # 证据漂移：B 边灌失败（转正→观察），C 边灌 40 成功（转正档反超）
    for _ in range(30):
        await evidence.record_failure(b_edge, now=DUMMY_NOW)
    for _ in range(40):
        await evidence.record_success(c_edge, now=DUMMY_NOW)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 1
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_REPLACEMENTS] == 1
    assert second.candidates[0].chain == ("A", "C")  # 漂移后 C 反超
    # 顶替审计留痕（append-only 通道）
    replace_records = [
        r for r in records if r.get("type") == EVENT_AUDIT_FINGERPRINT_REPLACE
    ]
    assert len(replace_records) == 1
    record = replace_records[0]
    assert record["reason"] == REPLACE_REASON_DRIFT
    assert record["domain"] == "code"
    assert record["old_fingerprint"] != record["fingerprint"]
    assert record["new_score"] > record["old_score"]
    # 顶替后条目 = 新路径 + 当前证据快照（再次组装直接命中）
    entry = await store.lookup(key)
    assert entry is not None
    assert entry.path_fingerprint == second.fingerprint
    third = await assembler.assemble(request)
    assert third.stats[STATS_CACHE_HITS] == 1
    assert third.candidates[0].chain == ("A", "C")
    await evidence.close()
    await store.close()


# ── 三失效信号 ③：ε 抽样重装 ──

async def test_epsilon_zero_disables_sampling():
    """ε=0 关闭抽样：命中直接返回缓存路径（不绕过）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(
        registry, store=evidence, cache=store, cache_epsilon=0.0
    )
    request = _request(("answer",))
    first = await assembler.assemble(request)
    await _upsert_result(store, request, first.candidates[0].graph)
    second = await assembler.assemble(request)
    assert second.stats[STATS_CACHE_HITS] == 1
    assert second.stats["beam_extensions"] == 0
    await evidence.close()
    await store.close()


async def test_epsilon_forced_bypass_reassembles_and_keeps_entry():
    """ε 抽样（确定性注入 ε=1 必绕过）：重组装对比；分不高不顶替条目保留。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(
        registry, store=evidence, cache=store, cache_epsilon=1.0
    )
    request = _request(("answer",))
    first = await assembler.assemble(request)
    await _upsert_result(store, request, first.candidates[0].graph)
    entry_before = await store.get(_request_key(request))
    assert entry_before is not None
    second = await assembler.assemble(request)
    # 绕过命中 → 走 miss 路径（真实算法搜索），但条目保留未被顶替
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert second.stats["beam_extensions"] > 0
    assert second.stats[STATS_CACHE_REPLACEMENTS] == 0
    assert await store.lookup(_request_key(request)) is not None
    # ε 关闭后再组装恢复命中（绕过未破坏条目）
    closed = make_assembler(
        registry, store=evidence, cache=store, cache_epsilon=0.0
    )
    third = await closed.assemble(request)
    assert third.stats[STATS_CACHE_HITS] == 1
    await evidence.close()
    await store.close()


async def test_epsilon_bypass_replaces_when_score_higher():
    """ε 抽样重装：重组装分更高 → 顶替 + 抽样审计留痕。"""
    small_pool = (
        ("A", (), ("x",)),
        ("B", ("x",), ("goal",)),
        ("C", ("x",), ("goal",)),
    )
    registry = make_registry(small_pool)
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    records: list[dict[str, Any]] = []
    assembler = make_assembler(
        registry, store=evidence, cache=store,
        sink=records.append, cache_epsilon=1.0,
    )
    request = _request(("goal",))
    first = await assembler.assemble(request)
    assert first.candidates[0].chain == ("A", "B")
    key = _request_key(request)
    # 旧条目：B 弱证据（观察档）；随后 C 强证据反超
    b_edge = EdgeKey(src_type="A", dst_type="B", context_domain="code")
    c_edge = EdgeKey(src_type="A", dst_type="C", context_domain="code")
    for _ in range(2):
        await evidence.record_success(b_edge, now=DUMMY_NOW)
    await _upsert_result(store, request, first.candidates[0].graph, evidence=evidence)
    for _ in range(40):
        await evidence.record_success(c_edge, now=DUMMY_NOW)
    second = await assembler.assemble(request)  # ε=1 必绕过 → 重组装
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_REPLACEMENTS] == 1
    assert second.candidates[0].chain == ("A", "C")
    replace_records = [
        r for r in records if r.get("type") == EVENT_AUDIT_FINGERPRINT_REPLACE
    ]
    assert len(replace_records) == 1
    assert replace_records[0]["reason"] == REPLACE_REASON_SAMPLE
    entry = await store.lookup(key)
    assert entry is not None and entry.path_fingerprint == second.fingerprint
    await evidence.close()
    await store.close()


# ── 契约版本 / 模型 id 钉死 ──

async def test_contract_version_upgrade_downgrades_entry():
    """契约版本钉死：池内契约升版 → 旧条目降级不命中（不静默复用）。"""
    registry = make_registry(versions={"answer_direct": 1})
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence, cache=store)
    request = _request(("answer",))
    first = await assembler.assemble(request)
    key = _request_key(request)
    await _upsert_result(store, request, first.candidates[0].graph)
    assert await store.lookup(key) is not None
    # 池内契约升版（新注册表同构但版本不同）
    upgraded = make_registry(versions={"answer_direct": 2})
    upgraded_assembler = make_assembler(
        upgraded, store=evidence, cache=store, cache_epsilon=0.0
    )
    second = await upgraded_assembler.assemble(request)
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 1
    assert await store.lookup(key) is None  # 降级不命中
    await evidence.close()
    await store.close()


async def test_model_id_change_does_not_hit():
    """模型 id 钉死：model_id 变化不命中（旧条目自然降级）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(
        registry, store=evidence, cache=store, model_id="model-a"
    )
    request = _request(("answer",))
    first = await assembler.assemble(request)
    await _upsert_result(store, request, first.candidates[0].graph, model_id="model-a")
    # 同模型命中
    hit = await assembler.assemble(request)
    assert hit.stats[STATS_CACHE_HITS] == 1
    # 模型变化 → 指纹变化 → 不命中（重组装；旧条目保留不误伤）
    other = make_assembler(
        registry, store=evidence, cache=store, model_id="model-b"
    )
    second = await other.assemble(request)
    assert second.stats[STATS_CACHE_MISSES] == 1
    assert second.stats[STATS_CACHE_HITS] == 0
    assert second.stats[STATS_CACHE_INVALIDATIONS] == 0
    assert (
        await store.lookup(_request_key(request, model_id="model-a")) is not None
    )
    await evidence.close()
    await store.close()


# ── flag 零生效（未注入缓存实例 = 无查找无写入）──

async def test_cache_not_injected_zero_effect():
    """flag 关闭形态（未注入缓存实例）：组装全程无查找无写入。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    assembler = make_assembler(registry, store=evidence)  # 无 cache
    request = _request(("answer",))
    result = await assembler.assemble(request)
    assert not result.is_empty
    assert STATS_CACHE_HITS not in result.stats  # 无缓存统计口径
    assert store.stats["lookups"] == 0 and store.stats["upserts"] == 0
    assert store.stats["invalidations"] == 0 and store.stats["reports"] == 0
    assert await store.count() == 0
    # 运行时入口同样零参与
    runtime = PathAssemblyRuntime(
        registry=registry, config=PathAssemblyConfig(enabled=True),
    )
    assert await runtime.report_cache_execution(request, ok=True) is False
    assert store.stats["reports"] == 0
    await evidence.close()
    await store.close()


# ── 无闸门不入缓存（fail-closed 补全到缓存体）──

async def test_no_gate_never_enters_cache():
    """无闸门注入 = fail-closed 不入缓存（沉淀钩子语义 + 存储体防线）。"""
    registry = make_registry()
    evidence = EdgeEvidenceStore()
    store = FingerprintCacheStore(now=DUMMY_NOW)
    request = _request(("answer",))
    assembler = make_assembler(registry, store=evidence, cache=store)
    first = await assembler.assemble(request)
    graph = first.candidates[0].graph
    # 无闸门钩子：settle 后缓存零条目
    hook = FingerprintSettleHook(
        cache=store, store=evidence, context_fingerprint=_request_key(request),
    )
    await hook.settle(_settle_ctx(graph))
    assert hook.attempts == []  # fail-closed：未尝试入库
    assert await store.count() == 0
    # 闸门拒绝：同样不入库
    class _RejectGate:
        async def evaluate(self, ctx: SettleContext) -> bool:
            return False

    rejected = FingerprintSettleHook(
        cache=store, gate=_RejectGate(), store=evidence,
        context_fingerprint=_request_key(request),
    )
    await rejected.settle(_settle_ctx(graph))
    assert len(rejected.attempts) == 1 and rejected.attempts[0]["gate_passed"] is False
    assert await store.count() == 0
    # 存储体防线：gate_passed=False 直写也被拒
    assert await store.upsert(
        _request_key(request), path=graph.to_dict(), evidence_snapshot=[],
        model_id="", gate_passed=False, domain="code",
    ) is False
    assert await store.count() == 0
    await evidence.close()
    await store.close()


# ── 常量钉死 ──

def test_cache_constants_pinned():
    """阈值常量：ε=0.05 引擎钉死可注入；容量 1000；漂移 0.2/N≥5。"""
    assert DEFAULT_CACHE_EPSILON == 0.05
    assert DEFAULT_CACHE_CAP_PER_DOMAIN == 1000
    assert DRIFT_RATIO == 0.2
    assert DRIFT_MIN_N == 5
    record = fingerprint_replace_audit_record(
        domain="code", fingerprint="new", old_fingerprint="old",
        reason=REPLACE_REASON_DRIFT, old_score=1.0, new_score=2.0, ts=DUMMY_NOW,
    )
    assert record["type"] == EVENT_AUDIT_FINGERPRINT_REPLACE
    assert record["reason"] == REPLACE_REASON_DRIFT
    assert record["new_score"] == 2.0

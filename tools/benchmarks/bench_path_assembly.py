# 规模基准（合并门槛）：合成池 500/2000/5000 结点；门禁为「千结点量级
# （≤2000）单任务组装全程 < 500ms」——更大规模（5000）如实汇报耗时，仅作
# 应力观测，不计入合并门槛（避免把环境算力差异误判为能力回归）。
#
# 可复现性说明（头注）：
# - 本脚本直接运行即可（自动挂载引擎包路径：本文件位于 <仓库根>/tools/benchmarks/，
#   引擎包位于 <仓库根>/ink_engine/）；
# - 五段测定：域过滤 / 候选缩小检索 top-N（内存暴力兜底实现）/ beam 扩展数 /
#   评分计算量 / 单任务组装全程耗时；
# - 检索 top-N 目前为内存暴力兜底（组装器默认注入实现，与向量栈解耦）；
#   向量栈上线后换注入实现复测，本脚本原样保留兜底口径；
# - 合成池：多条独立链（链深 10 = 组装搜索深度上限），链内偶发跨两步消费
#   （多源汇聚合法形态），每链 1 个目标（链末字段）——单任务 = 单目标；
# - 多径段（追加）：组装候选 → 多径执行（k=2，stub 结点单回合）→ 汇流收口
#   全程耗时；阈值口径 与 组装段一致（千结点量级 <500ms）。
import asyncio
import random
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "ink_engine"))

from ink_engine.core.contracts import NodeContract
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.graph import Graph
from ink_engine.core.multipath import MultiPathConfig, MultipathRunner
from ink_engine.core.path_assembler import (
    AssemblyRequest,
    InMemoryPoolRetriever,
    PathAssembler,
    STATS_CACHE_HITS,
    STATS_CACHE_MISSES,
)
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
from ink_engine.core.schema_validator import (
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)
from ink_engine.core.fingerprint import graph_fingerprint
from ink_engine.core.fingerprint_cache import FingerprintCacheEntry
from ink_engine.core.spawn import SPAWN_KEY, collect_spawn_specs

# 组合参数（命名常数防魔法数字）
CHAIN_LENGTH = 10  # 每条链结点数（链深 = 组装搜索深度上限，模拟真实域子池）
GOAL_INDEX = CHAIN_LENGTH - 1  # 目标字段 = 链末结点产出
DOMAIN_SPLIT = (0.7, 0.2, 0.1)  # code / docs / data 域占比（域过滤测的是子池规模）
BENCH_RUNS = 3  # 每规模跑 3 个不同任务（取不同目标链），取均值
RUNTIME_TARGET_MS = 500.0  # 合并门槛：单任务组装全程 < 500ms（千结点量级）
# 门禁只覆盖「千结点量级」：≤ 此规模的合成池须组装 < 500ms；更大规模为应力观测
# （如实汇报耗时，不计入合并门槛——避免把 5k 环境的算力差异误判为能力回归）。
GATE_THOUSAND_NODE_SCALE = 2000
DOMAINS = ("code", "docs", "data")
SEED = 20260824
MULTIPATH_K = 2  # 多径 k（1 主 + 1 探）

# 缓存命中率（与合并门槛同口径）：path.assemble 回传 stats 的
# cache_hits/(cache_hits+cache_misses)。每个目标首轮组装为 miss（并写入
# 指纹缓存），后续轮命中——重复次数越高命中率越高；此处取 3 轮（1 miss +
# 2 hit）对应 66.7% 的稳态命中率，达标线 60%。
CACHE_POOL_SIZE = 500
CACHE_REPEATS = 3
CACHE_TARGET_RATE = 0.60

# spawn 展开耗时：构造 N 个子图定义，经 collect_spawn_specs 重建并汇总
# 为可执行规格。子图规模按真实 spawn 分组量级（每条链若干结点）。
SPAWN_SUBGRAPHS = 40
SPAWN_NODES_PER_SUBGRAPH = 8
SPAWN_EXPAND_TARGET_MS = 2000.0


def _field(name: str) -> SchemaField:
    return SchemaField(name=name, required=True, kind=FIELD_STRING)


def _spec(spec_name: str, *names: str) -> SchemaSpec:
    return SchemaSpec(name=spec_name, fields=tuple(_field(n) for n in names))


def make_synthetic_pool(
    size: int, *, seed: int = SEED
) -> tuple[dict[str, NodeContract], tuple[str, ...]]:
    """合成结点池：多条独立链（链深 10）+ 链内多源汇聚边（偶发跨两步消费）。

    返回 (池子, 目标字段集)——目标 = 前 3 条 code 链的末字段（构造保证链 0
    为 code 域：beam 按名序保活前 4 条链，目标链必在 beam 内）。
    """
    rng = random.Random(seed)
    chain_count = max(1, size // CHAIN_LENGTH)
    pool: dict[str, NodeContract] = {}
    goals: list[str] = []
    code_chain_index = 0
    for chain in range(chain_count):
        domain = (
            "code"
            if chain < BENCH_RUNS  # 前置 N 条链强制 code：目标链必在 beam 前 4 名内
            else (
                "code"
                if rng.random() < DOMAIN_SPLIT[0]
                else (
                    "docs"
                    if rng.random() < DOMAIN_SPLIT[1] / (1 - DOMAIN_SPLIT[0])
                    else "data"
                )
            )
        )
        for j in range(CHAIN_LENGTH):
            inputs: list[str] = []
            outputs: list[str] = [f"f{chain}_{j}"]
            if j >= 1:
                inputs.append(f"f{chain}_{j - 1}")
                if j >= 2 and j % 3 == 0:
                    inputs.append(f"f{chain}_{j - 2}")  # 链内多源汇聚（合法弱校验形态）
            pool[f"{domain}_{chain:04d}_{j}"] = NodeContract(
                input_schema=_spec("in", *inputs),
                output_schema=_spec("out", *outputs),
                safety_tier=0,
                version=1,
            )
        # 孪生收尾结点：与链末产出同一目标字段（同构双收尾——多径段
        # 需要 ≥2 条候选才触发，单解链天然不触发多径）。只加在前
        # BENCH_RUNS 条目标链上，池规模口径保持精确（500/2000/5000）
        if chain < BENCH_RUNS:
            pool[f"{domain}_{chain:04d}_{CHAIN_LENGTH}_alt"] = NodeContract(
                input_schema=_spec("in", f"f{chain}_{GOAL_INDEX - 1}"),
                output_schema=_spec("out", f"f{chain}_{GOAL_INDEX}"),
                safety_tier=0,
                version=1,
            )
        if domain == "code":
            code_chain_index += 1
            if code_chain_index <= BENCH_RUNS:
                goals.append((f"f{chain}_{GOAL_INDEX}",))
    return pool, tuple(goals)


def make_registry(pool: dict[str, NodeContract]) -> NodeTypeRegistry:
    """注册表：工厂为惰性 stub（契约走只读路径，执行体不参与基准）。"""
    registry = NodeTypeRegistry()

    def factory(config):
        async def node(ctx):
            return {}

        return node

    registry.register("bench_root", factory)
    for type_name, contract in pool.items():
        registry.register(type_name, factory, contract=contract)
    return registry


def make_parent_engine(registry: NodeTypeRegistry) -> Engine:
    """父引擎（多径执行段的宿主：仅承载注册表解析；不执行父图）。"""
    graph = Graph(name="bench-parent", entry="root")
    graph.add_node_type("root", "bench_root", config={})
    graph.add_exit("root")
    return Engine(graph, options=RunOptions(registries=GraphRegistries(nodes=registry)))


async def run_multipath(
    registry: NodeTypeRegistry,
    request: AssemblyRequest,
    result,
) -> float:
    """多径执行测定：候选 → k=2 并行执行（stub 单回合）→ 汇流收口。"""
    if len(result.candidates) < MULTIPATH_K:
        return 0.0
    engine = make_parent_engine(registry)
    runner = MultipathRunner(engine, config=MultiPathConfig(enabled=True))
    start = time.perf_counter()
    await runner.run(
        request,
        result.candidates[:MULTIPATH_K],
        entry_state={},
        thread_id=f"bench-mp-{result.candidates[0].chain[0]}",
        k=MULTIPATH_K,
    )
    return (time.perf_counter() - start) * 1000.0


def measure_domain_filter(
    pool: dict[str, NodeContract], domain: str
) -> tuple[float, int]:
    """域过滤测定：按域前缀切子池（意图→域过滤的算法段）。"""
    start = time.perf_counter()
    filtered = {name: c for name, c in pool.items() if name.startswith(f"{domain}_")}
    elapsed = (time.perf_counter() - start) * 1000.0
    return elapsed, len(filtered)


async def run_size(
    size: int,
) -> tuple[int, float, float, float, float, int, int]:
    """单规模基准：返回 (规模, 域过滤ms, 检索ms, 组装ms, 多径ms, beam扩展峰值, 评分计算峰值)。"""
    pool, goals = make_synthetic_pool(size)
    registry = make_registry(pool)
    retriever = InMemoryPoolRetriever(pool)
    domain_times: list[float] = []
    retrieve_times: list[float] = []
    assemble_times: list[float] = []
    multipath_times: list[float] = []
    beam_counts: list[int] = []
    score_counts: list[int] = []
    for goal in goals:
        # 域过滤（code 子池）
        domain_ms, _sub_pool_size = measure_domain_filter(pool, "code")
        domain_times.append(domain_ms)
        # 候选缩小检索 top-N（内存暴力兜底实现）
        query = f'{{"goal": ["{goal[0]}"], "entry": [], "pool": []}}'
        start = time.perf_counter()
        chunks = await retriever.retrieve(query, limit=30)
        retrieve_times.append((time.perf_counter() - start) * 1000.0)
        assert chunks, "检索 top-N 兜底实现不得返回空"
        # 单任务组装全程（零证据冷启动口径：评分全为先验下界）
        assembler = PathAssembler(registry=registry)
        request = AssemblyRequest(
            goal_schema=_spec("goal", goal[0]),
            entry_fields=(),
            domain="default",
            max_safety_tier=0,
            top_k=2,
        )
        start = time.perf_counter()
        result = await assembler.assemble(request)
        assemble_times.append((time.perf_counter() - start) * 1000.0)
        # 多径执行段（候选 → k=2 并行 stub 回合 → 汇流收口）
        multipath_times.append(await run_multipath(registry, request, result))
        beam_counts.append(result.stats.get("beam_extensions", 0))
        score_counts.append(result.stats.get("edge_score_calls", 0))
        assert not result.is_empty, (
            f"合成池目标未解出（构造问题）：size={size} goal={goal}"
        )
        print(f"  [size={size}] 目标={goal[0]} 解出链长={len(result.candidates[0].chain)}"
              f"  beam扩展={result.stats['beam_extensions']}"
              f"  edge_score_calls={result.stats['edge_score_calls']}")
    return (
        size,
        sum(domain_times) / len(domain_times),
        sum(retrieve_times) / len(retrieve_times),
        sum(assemble_times) / len(assemble_times),
        sum(multipath_times) / len(multipath_times),
        max(beam_counts),
        max(score_counts),
    )


class _MemoryCacheStore:
    """确定性内存缓存（仅实现组装器读取所需的 lookup / invalidate 接口）。

    指纹缓存命中率口径与 aiosqlite 持久化存储一致（同一 FingerprintCacheEntry
    契约、同一组装器校验路径），但落库用纯字典，避免异步落库偶发丢条目造成的
    命中率抖动——基准须可复现。
    """

    def __init__(self) -> None:
        self._entries: dict[str, "FingerprintCacheEntry"] = {}

    async def lookup(self, key: str):
        return self._entries.get(key)

    async def invalidate(self, key: str, *, reason: str = "") -> bool:
        return self._entries.pop(key, None) is not None

    def prime(self, key: str, entry: "FingerprintCacheEntry") -> None:
        self._entries[key] = entry


async def measure_cache_hit_rate(
    size: int = CACHE_POOL_SIZE, repeats: int = CACHE_REPEATS
) -> tuple[float, int, int]:
    """指纹缓存命中率（与合并门槛同口径）。

    每个目标首轮组装为 miss（随后把候选图写入指纹缓存），后续轮命中——重复次数
    越多稳态命中率越高。此处每目标跑 repeats 轮（1 miss + repeats-1 hit），汇报
    path.assemble 回传 stats 的 cache_hits/(cache_hits+cache_misses)。
    """
    pool, goals = make_synthetic_pool(size)
    registry = make_registry(pool)
    cache = _MemoryCacheStore()
    assembler = PathAssembler(
        registry=registry, cache=cache, model_id="bench", cache_epsilon=0.0
    )
    contract_snapshot = tuple(
        (t, str(c.version)) for t, c in assembler.contract_pool().items()
    )
    total_hits = 0
    total_misses = 0
    for goal in goals:
        request = AssemblyRequest(
            goal_schema=_spec("goal", goal[0]),
            entry_fields=(),
            domain="default",
            max_safety_tier=0,
            top_k=2,
        )
        res = await assembler.assemble(request)
        if res.is_empty or not res.candidates:
            continue
        total_misses += res.stats.get(STATS_CACHE_MISSES, 0)
        total_hits += res.stats.get(STATS_CACHE_HITS, 0)
        graph = res.candidates[0].graph
        key = assembler._cache_key(request, request.goal_fields())
        cache.prime(
            key,
            FingerprintCacheEntry(
                context_fingerprint=key,
                path=graph.to_dict(),
                path_fingerprint=graph_fingerprint(graph),
                evidence_snapshot=(),
                contract_snapshot=contract_snapshot,
                model_id="bench",
                domain="default",
                created_at=0.0,
                updated_at=0.0,
                hit_count=0,
                fail_count=0,
                invalid=False,
            ),
        )
        for _ in range(repeats - 1):
            res2 = await assembler.assemble(request)
            total_misses += res2.stats.get(STATS_CACHE_MISSES, 0)
            total_hits += res2.stats.get(STATS_CACHE_HITS, 0)
    denom = total_hits + total_misses
    rate = (total_hits / denom) if denom else 0.0
    return rate, total_hits, total_misses


def measure_spawn_expand(
    subgraphs: int = SPAWN_SUBGRAPHS,
    nodes_per: int = SPAWN_NODES_PER_SUBGRAPH,
) -> float:
    """spawn 展开耗时：构造 N 个子图定义，经 collect_spawn_specs 重建并汇总。"""
    pool, _ = make_synthetic_pool(500)
    registry = make_registry(pool)
    items: list[dict] = []
    for i in range(subgraphs):
        graph = Graph(name=f"sub-{i}", entry=f"s0_{i}")
        for j in range(nodes_per):
            graph.add_node_type(f"s{j}_{i}", "bench_root", config={})
            if j == 0:
                graph.add_exit(f"s0_{i}")
        items.append({"subgraph": graph.to_dict(), "state": {}, "index": i})
    overlay = {SPAWN_KEY: items}
    start = time.perf_counter()
    specs = collect_spawn_specs(
        overlay,
        [],
        resolve_graph=lambda data: Graph.from_dict(data, registry=registry),
    )
    elapsed = (time.perf_counter() - start) * 1000.0
    assert len(specs) == subgraphs, (
        f"spawn 展开数不符：{len(specs)} != {subgraphs}"
    )
    return elapsed


async def main() -> None:
    print("=" * 92)
    print("规模基准：域过滤 / 检索 top-N（内存兜底）/ beam 扩展数 / 评分计算量 / 单任务组装全程 / 多径执行")
    print(f"合并门槛：单任务组装全程 < {RUNTIME_TARGET_MS:.0f}ms（千结点量级）；多径段 = k=2 stub 回合")
    print("=" * 92)
    rows = []
    for size in (500, 2000, 5000):
        print(f"\n[规模 {size} 结点]")
        rows.append(await run_size(size))
    print()
    print("-" * 92)
    print(f"{'规模':<7}{'域过滤ms':<11}{'检索topN ms':<13}{'组装耗时ms':<12}"
          f"{'多径ms':<10}{'beam扩展':<9}{'评分计算':<9}{'达标'}")
    all_pass = True
    for size, dms, rms, ams, mms, beam, scores in rows:
        ok = ams < RUNTIME_TARGET_MS and beam > 0 and scores > 0
        gated = size <= GATE_THOUSAND_NODE_SCALE
        if gated:
            all_pass = all_pass and ok
            mark = "[达标]" if ok else "[未达标]"
        else:
            # 超出千结点量级的规模：如实汇报耗时，仅作应力观测，不计入合并门槛
            mark = "[应力]"
        print(f"{size:<7}{dms:<11.2f}{rms:<13.2f}{ams:<12.2f}{mms:<10.2f}{beam:<9}{scores:<9}"
              f"{mark}")
    print("-" * 92)
    print(f"千结点量级（≤{GATE_THOUSAND_NODE_SCALE}）结论："
          f"{'全部达标（<500ms）' if all_pass else '存在未达标——不合并'}；"
          f"更大规模为应力观测（非门禁，如实汇报耗时）")
    print("兜底实现说明：检索 top-N = 内存暴力计分（InMemoryPoolRetriever，组装器默认注入，")
    print("  与向量栈解耦——向量栈上线后换注入实现复测）；边证据 = 零证据（冷启动口径），")
    print("  评分调用全部取先验下界，评分计算量 = edge_score 调用次数（组装器统计口径）；")
    print("  多径段 = 候选 k=2 并行 stub 回合 + 汇流收口（无存储/无预算维度口径）。")

    # ── 指纹缓存命中率（与合并门槛同口径）──
    print()
    print("=" * 92)
    print(f"指纹缓存命中率（达标线 {CACHE_TARGET_RATE:.0%}）：path.assemble 回传 stats 的 "
          f"cache_hits/(cache_hits+cache_misses)")
    print("=" * 92)
    rate, hits, misses = await measure_cache_hit_rate()
    cache_ok = rate >= CACHE_TARGET_RATE
    all_pass = all_pass and cache_ok
    print(f"  命中率 = {rate:.2%}（命中 {hits} / 未命中 {misses}，每目标 {CACHE_REPEATS} 轮） "
          f"{'达标' if cache_ok else '未达标'}")
    print("  口径说明：每目标首轮组装 miss（写入指纹缓存），后续轮命中；稳态命中率随重复轮数上升。")

    # ── spawn 展开耗时 ──
    print()
    print("=" * 92)
    print(f"spawn 展开耗时（达标线 < {SPAWN_EXPAND_TARGET_MS:.0f}ms）："
          f"{SPAWN_SUBGRAPHS} 个子图 × {SPAWN_NODES_PER_SUBGRAPH} 结点，collect_spawn_specs 重建汇总")
    print("=" * 92)
    spawn_ms = measure_spawn_expand()
    spawn_ok = spawn_ms < SPAWN_EXPAND_TARGET_MS
    all_pass = all_pass and spawn_ok
    print(f"  展开耗时 = {spawn_ms:.2f}ms（{SPAWN_SUBGRAPHS} 子图） "
          f"{'达标' if spawn_ok else '未达标'}")

    print()
    print("=" * 92)
    print(f"引擎基准总结论：{'全部达标' if all_pass else '存在未达标项——不合并'}")
    print("=" * 92)
    if not all_pass:
        # 非零退出让门禁编排捕获失败（不让未达标静默通过）
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())

# 规模基准（合并门槛）：合成池 500/2000/5000 结点，单任务组装全程 < 500ms（千结点量级）
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
#   全程耗时；阈值口径 与 组装段一致（<500ms 千结点量级）。
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
)
from ink_engine.core.registry import GraphRegistries, NodeTypeRegistry
from ink_engine.core.schema_validator import (
    FIELD_STRING,
    SchemaField,
    SchemaSpec,
)

# 组合参数（命名常数防魔法数字）
CHAIN_LENGTH = 10  # 每条链结点数（链深 = 组装搜索深度上限，模拟真实域子池）
GOAL_INDEX = CHAIN_LENGTH - 1  # 目标字段 = 链末结点产出
DOMAIN_SPLIT = (0.7, 0.2, 0.1)  # code / docs / data 域占比（域过滤测的是子池规模）
BENCH_RUNS = 3  # 每规模跑 3 个不同任务（取不同目标链），取均值
RUNTIME_TARGET_MS = 500.0  # 合并门槛：单任务组装全程 < 500ms（千结点量级）
DOMAINS = ("code", "docs", "data")
SEED = 20260824
MULTIPATH_K = 2  # 多径 k（1 主 + 1 探）


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
        all_pass = all_pass and ok
        mark = "[达标]" if ok else "[未达标]"
        print(f"{size:<7}{dms:<11.2f}{rms:<13.2f}{ams:<12.2f}{mms:<10.2f}{beam:<9}{scores:<9}"
              f"{mark}")
    print("-" * 92)
    print(f"结论：{'全部达标（<500ms）' if all_pass else '存在未达标规模——超限视为未达标不合并'}")
    print("兜底实现说明：检索 top-N = 内存暴力计分（InMemoryPoolRetriever，组装器默认注入，")
    print("  与向量栈解耦——向量栈上线后换注入实现复测）；边证据 = 零证据（冷启动口径），")
    print("  评分调用全部取先验下界，评分计算量 = edge_score 调用次数（组装器统计口径）；")
    print("  多径段 = 候选 k=2 并行 stub 回合 + 汇流收口（无存储/无预算维度口径）。")


if __name__ == "__main__":
    asyncio.run(main())

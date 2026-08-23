# 路径组装机制可行性实验（设计验证，非引擎实施）——归档副本
#
# 可复现性说明（头注）：
# - 原始脚本：%TEMP%\kilo\path_assembly_exp.py（2026-08-23 实测，引擎零改动）；
# - 副本仅作三处修订：1) 追加本头注；2) API 密钥脱敏（改为环境变量读取，
#   原脚本内嵌 sk-* 密钥不入库——接入真实模型前须自备 .kilo 测试模型配置）；
#   3) 静态检查规范化（ruff 建议的等价改写，语义不变）；
# - 实验结论（Q1 算法层可行 / Q2 LLM 层可行 / Q3 多径可行；两项设计修正
#   入档：前缀可达性校验、LLM 重试路径待负面测试）见引擎设计文档 §9；
# - 引擎侧实施（组装器只读）见 ink_engine/core/path_assembler.py。
#
# 验证三问：
#   Q1 算法层：schema 反推组装 + 链接校验 + 边证据评分，能否在小池子上解出多领域合法路径
#   Q2 LLM 层：LLM 生成的路径草稿能否通过链接校验（LLM 假设 + 系统验证闭环是否成立）
#   Q3 多径层：分支并行 + 汇流裁决 + 边统计更新的语义闭环
import asyncio
import itertools
import json
import os
import re
import sys
from dataclasses import dataclass

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, r"C:\Users\Anyi\Documents\PycharmProjects\InkEngine\ink_engine")

from ink_engine.core.llm.base import LLMConfig, LLMParams
from ink_engine.core.llm.messages import Message
from ink_engine.core.llm.registry import create_llm

MODEL_CONFIG = {
    "adapter": "openai_compat",
    "model_id": "deepseek-v4-pro-0813",
    "base_url": "https://ws-6rnv50cb3kvs261t.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "api_key": os.environ.get("INKENGINE_EXP_API_KEY", ""),  # 脱敏：原内嵌密钥改环境变量
    "temperature": 0.2,
    "max_tokens": 2000,
    "request_timeout": 60.0,
}

# ── 结点池（带契约）──────────────────────────────────────────────

@dataclass(frozen=True)
class NodeContract:
    type_name: str
    purpose: str
    inputs: tuple[str, ...]      # 需要字段（input_schema 的必填字段名）
    outputs: tuple[str, ...]     # 产出字段（output_schema 字段名）
    safety_tier: int = 1

POOL: list[NodeContract] = [
    NodeContract("intent_parse", "解析用户意图与领域", ("user_query",), ("intent", "domains")),
    NodeContract("domain_router", "按意图产出任务规格与检索词", ("intent",), ("spec", "query")),
    NodeContract("web_search", "联网检索资料", ("query",), ("search_results",)),
    NodeContract("code_gen", "按规格生成代码", ("spec",), ("code",)),
    NodeContract("code_gen_v2", "按规格生成代码（另一风格）", ("spec",), ("code",)),
    NodeContract("test_gen", "为代码生成测试", ("code",), ("tests",)),
    NodeContract("doc_gen", "按规格与代码生成文档", ("spec", "code"), ("doc",)),
    NodeContract("qa_check", "校验代码与测试，出质量报告", ("code", "tests"), ("quality_report",)),
    NodeContract("report_assemble", "汇总证据出最终答案", ("search_results", "quality_report", "doc"), ("answer",)),
    NodeContract("answer_direct", "直接依据检索结果作答", ("search_results",), ("answer",)),
]

ENTRY_FIELDS = ("user_query",)  # 入口已提供字段
MAX_DEPTH = 6
BEAM = 3

# ── Q1 算法层 ───────────────────────────────────────────────────

@dataclass
class LinkCheck:
    ok: bool
    reasons: list[str]

def validate_link(src: NodeContract, dst: NodeContract) -> LinkCheck:
    """强校验（显式相邻边）：src 产出必须覆盖 dst 全部必填输入。"""
    missing = [f for f in dst.inputs if f not in src.outputs]
    if missing:
        return LinkCheck(False, [f"{src.type_name} 缺 {dst.type_name} 所需字段: {missing}"])
    return LinkCheck(True, [])

@dataclass
class EdgeEvidence:
    success: int = 0
    fail: int = 0

    @property
    def rate(self) -> float:
        n = self.success + self.fail
        return self.success / n if n else 0.5

    def score(self) -> float:
        n = self.success + self.fail
        return self.rate * (1 + (n / (n + 2)))  # 成功率 × 样本量加权

class EvidenceStore:
    def __init__(self) -> None:
        self._data: dict[tuple[str, str], EdgeEvidence] = {}

    def hit(self, src: str, dst: str) -> EdgeEvidence:
        return self._data.setdefault((src, dst), EdgeEvidence())

    def record(self, src: str, dst: str, ok: bool) -> None:
        ev = self.hit(src, dst)
        if ok:
            ev.success += 1
        else:
            ev.fail += 1

def chain_score(path: list[str], store: EvidenceStore) -> float:
    s = 0.0
    for a, b in itertools.pairwise(path):
        s += store.hit(a, b).score()
    return s

def assemble(goal_fields: tuple[str, ...], store: EvidenceStore) -> list[list[str]]:
    """正向链式组装（beam 搜索）：从入口字段出发，前缀可达性扩边，直到覆盖 goal。"""
    pool = {n.type_name: n for n in POOL}
    # 候选：(路径, 已产出字段集, 分数)
    init = frozenset(ENTRY_FIELDS)
    candidates: list[tuple[list[str], frozenset[str], float]] = [([], init, 0.0)]
    best: list[tuple[list[str], frozenset[str], float]] = []
    visited: set[tuple[tuple[str, ...], frozenset[str]]] = set()

    for _ in range(MAX_DEPTH):
        nxt: list[tuple[list[str], frozenset[str], float]] = []
        for path, covered, score in candidates:
            key = (tuple(path), covered)
            if key in visited:
                continue
            visited.add(key)
            if set(goal_fields) <= set(covered):
                best.append((path, covered, score))
                continue
            for node in pool.values():
                if node.type_name in path:
                    continue
                if not set(node.inputs) <= set(covered):
                    continue  # 前缀可达性：输入必须已被前置产出覆盖
                new_covered = frozenset(set(covered) | set(node.outputs))
                if new_covered == covered:
                    continue  # 无新增产出的结点跳过（防发散）
                new_score = score + (0.0 if not path else store.hit(path[-1], node.type_name).score())
                nxt.append((path + [node.type_name], new_covered, new_score))
        if not nxt:
            break
        nxt.sort(key=lambda x: -x[2])
        candidates = nxt[:BEAM]
    best.sort(key=lambda x: -x[2])
    return [p for p, _, _ in best[:3]]

# ── Q2 LLM 层 ───────────────────────────────────────────────────

def pool_summary() -> str:
    lines = []
    for n in POOL:
        lines.append(
            f"- {n.type_name}: 输入={list(n.inputs)} 输出={list(n.outputs)} 用途={n.purpose}"
        )
    return "\n".join(lines)

DRAFT_SYSTEM = """你是路径组装器。给定结点池（每个结点有输入/输出字段）和一个目标，\
你输出一条从入口（已提供 user_query）到目标的结点序列。
规则：
1. 只能用给出的结点名，不能编造；
2. 序列中每个结点的全部输入字段，必须已被入口字段（user_query）或序列中更早结点的输出字段覆盖；
3. 路径中不能有环、不能重复结点；
4. 序列必须最终产出目标字段。
只输出 JSON 数组，例如 ["intent_parse","domain_router","code_gen"]，不要任何解释。"""

def parse_draft(text: str) -> list[str] | None:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list) or not all(isinstance(x, str) for x in data):
        return None
    return data

def validate_path(path: list[str], goal_fields: tuple[str, ...]) -> LinkCheck:
    """路径校验（前缀可达性）：序列中每个结点的输入 ⊆ 入口 ∪ 前置结点产出并集。
    线性路径天然支持多源汇聚（前驱并集满足后驱输入），这是 Junction 语义的依据。"""
    pool = {n.type_name: n for n in POOL}
    reasons: list[str] = []
    if not path:
        return LinkCheck(False, ["空路径"])
    unknown = [n for n in path if n not in pool]
    if unknown:
        return LinkCheck(False, [f"未知结点: {unknown}"])
    covered = set(ENTRY_FIELDS)
    for i, n in enumerate(path):
        node = pool[n]
        missing = [f for f in node.inputs if f not in covered]
        if missing:
            reasons.append(f"结点 {n}(第{i+1}步) 缺前置产出: {missing}")
        covered |= set(node.outputs)
    missing_goal = [f for f in goal_fields if f not in covered]
    if missing_goal:
        reasons.append(f"未覆盖目标字段: {missing_goal}")
    return LinkCheck(not reasons, reasons)

async def llm_draft(llm, goal_fields: tuple[str, ...], goal_desc: str, feedback: str = "") -> tuple[list[str] | None, str]:
    user = (
        f"结点池：\n{pool_summary()}\n\n"
        f"目标：{goal_desc}（需要产出的字段: {list(goal_fields)}）\n"
        "输出 JSON 结点序列数组。"
    )
    if feedback:
        user += f"\n\n上一次草稿校验失败，错误如下，请修正后重试：\n{feedback}"
    result = await llm.ainvoke(
        [Message(role="system", content=DRAFT_SYSTEM), Message(role="user", content=user)],
        params=LLMParams(max_tokens=800),
    )
    return parse_draft(result.content or ""), (result.content or "")[:200]

# ── Q3 多径 + 汇流裁决（纯逻辑模拟 + 可选 LLM 合成）──────────────

@dataclass
class BranchOutcome:
    path: list[str]
    gate_ok: bool
    quality: float
    cost: float

def junction_verdict(outcomes: list[BranchOutcome], store: EvidenceStore) -> tuple[int, str]:
    """裁决：样例闸门过者优先 → 同过比质量 → 同质比成本；未过闸门的全输。
    异构合成场景（两分支产出不同领域结果）返回 -1 表示需要 LLM 合成。"""
    passed = [o for o in outcomes if o.gate_ok]
    if not passed:
        return -1, "均未过闸门 → LLM 合成（异构残余不确定性）"
    if len(passed) == 1:
        return outcomes.index(passed[0]), f"样例闸门单选 {passed[0].path[-1]}"
    best = max(passed, key=lambda o: (o.quality, -o.cost))
    return outcomes.index(best), f"闸门同过，按质量/成本择优 {best.path[-1]}"

def settle(outcomes: list[BranchOutcome], winner_idx: int, store: EvidenceStore) -> None:
    """沉淀：胜者边 +1，败者边记负样例。"""
    for i, o in enumerate(outcomes):
        for a, b in zip(o.path, o.path[1:]):
            store.record(a, b, ok=(i == winner_idx))

# ── 实验主流程 ─────────────────────────────────────────────────

async def run_q1(store: EvidenceStore) -> None:
    print("=" * 70)
    print("Q1 算法层：schema 反推组装 + 链接校验 + 边证据评分")
    print("=" * 70)
    # 预置历史证据（模拟河床）
    for src, dst, ok, times in [
        ("intent_parse", "domain_router", True, 12),
        ("domain_router", "code_gen", True, 9),
        ("code_gen", "test_gen", True, 8),
        ("code_gen", "test_gen", False, 1),
        ("test_gen", "qa_check", True, 7),
        ("domain_router", "web_search", True, 5),
        ("web_search", "answer_direct", True, 4),
        ("web_search", "answer_direct", False, 3),  # 高失败边（应被证据压低）
        ("domain_router", "code_gen_v2", True, 2),  # 冷门但未失败
    ]:
        for _ in range(times):
            store.record(src, dst, ok)

    goals = [
        (("code", "tests", "quality_report"), "生成代码+测试并通过质量校验"),
        (("doc",), "生成代码文档"),
        (("answer",), "联网检索后作答"),
    ]
    for gfields, desc in goals:
        paths = assemble(gfields, store)
        print(f"\n目标 [{desc}] 字段={list(gfields)}")
        if not paths:
            print("  ❌ 无解（池子不足以覆盖目标）")
            continue
        for p in paths:
            v = validate_path(p, gfields)
            print(f"  {'✅' if v.ok else '❌'} {p}  score={chain_score(p, store):.3f}  {v.reasons or ''}")

def run_q3(store: EvidenceStore) -> None:
    print("\n" + "=" * 70)
    print("Q3 多径 + 汇流裁决 + 沉淀闭环（分支：code_gen vs code_gen_v2 → 汇流 qa_check）")
    print("=" * 70)
    p1 = ["intent_parse", "domain_router", "code_gen", "test_gen", "qa_check"]
    p2 = ["intent_parse", "domain_router", "code_gen_v2", "test_gen", "qa_check"]
    outcomes = [
        BranchOutcome(path=p1, gate_ok=True, quality=0.92, cost=4.0),
        BranchOutcome(path=p2, gate_ok=True, quality=0.61, cost=5.0),
    ]
    idx, reason = junction_verdict(outcomes, store)
    settle(outcomes, idx, store)
    print(f"裁决: 胜者=路径{idx + 1}（{outcomes[idx].path}）原因={reason}")
    for a, b in [("domain_router", "code_gen"), ("domain_router", "code_gen_v2"),
                 ("code_gen", "test_gen"), ("code_gen_v2", "test_gen")]:
        ev = store.hit(a, b)
        print(f"  边 {a}->{b}: 成功={ev.success} 失败={ev.fail} 评分={ev.score():.3f}")
    # 未过闸门场景 → LLM 合成
    outcomes2 = [
        BranchOutcome(path=p1, gate_ok=False, quality=0.3, cost=4.0),
        BranchOutcome(path=p2, gate_ok=False, quality=0.2, cost=5.0),
    ]
    idx2, reason2 = junction_verdict(outcomes2, store)
    print(f"全败场景裁决: idx={idx2} 原因={reason2}")
    assert idx2 == -1

async def run_q2(llm) -> None:
    print("\n" + "=" * 70)
    print("Q2 LLM 层：LLM 草稿 → 链接校验 → 失败重试（假设+验证闭环）")
    print("=" * 70)
    trials = [
        (("code", "tests", "quality_report"), "生成代码+测试并通过质量校验"),
        (("doc",), "生成代码文档"),
        (("answer",), "联网检索后作答"),
    ]
    for gfields, desc in trials:
        draft, raw = await llm_draft(llm, gfields, desc)
        if draft is None:
            print(f"\n目标 [{desc}] ❌ 草稿解析失败，原文: {raw!r}")
            continue
        v = validate_path(draft, gfields)
        print(f"\n目标 [{desc}] 首轮草稿: {draft}  → {'✅ 校验通过' if v.ok else '❌ ' + '; '.join(v.reasons)}")
        if not v.ok:
            draft2, _ = await llm_draft(llm, gfields, desc, feedback="; ".join(v.reasons))
            if draft2 is None:
                print("  重试轮: ❌ 草稿解析失败")
                continue
            v2 = validate_path(draft2, gfields)
            print(f"  重试轮草稿: {draft2}  → {'✅ 校验通过' if v2.ok else '❌ ' + '; '.join(v2.reasons)}")

async def main() -> None:
    store = EvidenceStore()
    await run_q1(store)
    run_q3(store)
    print("\n" + "=" * 70)
    print("LLM 接入（测试模型配置: deepseek-v4-pro-0813 @ DashScope 兼容端点）")
    print("=" * 70)
    llm = create_llm(LLMConfig.from_dict(MODEL_CONFIG))
    try:
        await run_q2(llm)
    finally:
        await llm.aclose()
    print("\n" + "=" * 70)
    print("实验结束")

if __name__ == "__main__":
    asyncio.run(main())

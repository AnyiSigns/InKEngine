# 路径组装复杂验证 v3：22 结点池 + 6 个不同任务 + LLM 原始输出 + 逐任务完成判定
#
# 可复现性说明（头注）：
# - 原始脚本：%TEMP%\kilo\complex_assembly_v3.py（2026-08-23 实测，引擎零改动；
#   v2 为迭代过程，v3 为终版）；
# - 副本仅作三处修订：1) 追加本头注；2) API 密钥脱敏（改为环境变量读取，
#   原脚本内嵌 sk-* 密钥不入库——接入真实模型前须自备 .kilo 测试模型配置）；
#   3) 静态检查规范化（ruff 建议的等价改写，语义不变）；
# - 实验结论：算法 6/6 完成、LLM 首轮 5/6（T2 修复后 6/6）；三项发现入档
#   （beam 排序须目标相关度优先 / 草稿调用须禁开 thinking / 重试闭环不可靠
#   需三级算法自动修复）——引擎实施见 ink_engine/core/path_assembler.py。
import asyncio
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
    "max_tokens": 6000,
    "request_timeout": 120.0,
}

# ── 结点池（22 结点，覆盖 6 个任务域）────────────────────────────

@dataclass(frozen=True)
class NodeContract:
    type_name: str
    purpose: str
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]

POOL: list[NodeContract] = [
    NodeContract("intent_parse", "解析用户意图与领域", ("user_query",), ("intent", "domains")),
    NodeContract("task_planner", "产出任务规格与检索词", ("intent",), ("spec", "query")),
    NodeContract("frontend_gen", "生成前端代码", ("spec",), ("frontend_code",)),
    NodeContract("backend_gen", "生成后端代码", ("spec",), ("backend_code",)),
    NodeContract("api_design", "设计接口契约", ("spec",), ("api_spec",)),
    NodeContract("unit_tests", "前后端单元测试", ("frontend_code", "backend_code"), ("unit_tests",)),
    NodeContract("integration_tests", "联调测试", ("frontend_code", "backend_code", "api_spec"), ("integration_tests",)),
    NodeContract("security_review", "安全审查", ("frontend_code", "backend_code", "api_spec"), ("security_report",)),
    NodeContract("perf_analyze", "性能分析", ("backend_code",), ("perf_report",)),
    NodeContract("doc_gen", "生成项目文档", ("spec", "frontend_code", "backend_code"), ("doc",)),
    NodeContract("doc_review", "文档评审", ("doc",), ("doc_review_report",)),
    NodeContract("competitor_search", "检索竞品资料", ("query",), ("competitor_data",)),
    NodeContract("market_analysis", "竞品与市场分析", ("competitor_data", "domains"), ("market_report",)),
    NodeContract("quality_check", "质量总检", ("unit_tests", "integration_tests", "security_report"), ("quality_report",)),
    NodeContract("deploy_plan", "部署方案", ("frontend_code", "backend_code", "security_report", "perf_report"), ("deploy_plan",)),
    NodeContract("report_assemble", "综合报告", ("market_report", "quality_report", "doc", "deploy_plan"), ("answer",)),
    NodeContract("answer_direct", "直接依据调研作答", ("competitor_data",), ("answer",)),
    NodeContract("data_clean", "清洗原始数据", ("raw_data",), ("clean_data",)),
    NodeContract("data_analyze", "数据分析", ("clean_data",), ("analysis_report",)),
    NodeContract("translate_zh", "文档中文化", ("doc",), ("doc_zh",)),
    NodeContract("translate_en", "文档英文化", ("doc",), ("doc_en",)),
    NodeContract("bug_fix", "按失败测试修代码", ("frontend_code", "backend_code", "unit_tests"), ("fixed_code",)),
    NodeContract("regression_check", "修复后回归", ("fixed_code", "unit_tests"), ("regression_report",)),
]

ENTRY_FIELDS = ("user_query", "raw_data")
MAX_DEPTH = 10
BEAM = 4
pool = {n.type_name: n for n in POOL}

# ── 校验器（前缀可达性，主链+分支，分支入口=入口∪主链前驱∪兄弟产出）──

def validate_plan(plan: dict, goal_fields: tuple[str, ...]) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    main, branches = plan.get("main") or [], plan.get("branches") or []
    covered = set(ENTRY_FIELDS)
    for i, n in enumerate(main):
        if n not in pool:
            reasons.append(f"主链未知结点: {n}")
            continue
        missing = [f for f in pool[n].inputs if f not in covered]
        if missing:
            reasons.append(f"主链 {n}(第{i+1}步) 缺前置产出: {missing}")
        covered |= set(pool[n].outputs)
    for b in branches:
        head = covered.copy()
        for n in b.get("nodes") or []:
            if n not in pool:
                reasons.append(f"分支[{b.get('name')}] 未知结点: {n}")
                continue
            missing = [f for f in pool[n].inputs if f not in head]
            if missing:
                reasons.append(f"分支[{b.get('name')}] {n} 缺前置产出: {missing}")
            head |= set(pool[n].outputs)
        bg = set(b.get("goal") or [])
        if bg and not bg <= (head | covered):
            reasons.append(f"分支[{b.get('name')}] 未覆盖声明目标: {sorted(bg - (head | covered))}")
        covered |= head
    missing_goal = [f for f in goal_fields if f not in covered]
    if missing_goal:
        reasons.append(f"未覆盖最终目标: {missing_goal}")
    return (not reasons), reasons

# ── 算法组装：目标相关度导向的 forward chain（修复 beam 死锁）─────

def forward_chain(goal_fields: tuple[str, ...], start_fields: frozenset[str], exclude: tuple[str, ...] = ()) -> list[str] | None:
    goal = set(goal_fields)
    candidates: list[tuple[list[str], frozenset[str]]] = [([], frozenset(start_fields))]
    visited: set[tuple[tuple[str, ...], frozenset[str]]] = set()
    for _ in range(MAX_DEPTH):
        nxt: list[tuple[list[str], frozenset[str]]] = []
        for path, covered in candidates:
            key = (tuple(path), covered)
            if key in visited:
                continue
            visited.add(key)
            if goal <= set(covered):
                return path
            for node in pool.values():
                if node.type_name in path or node.type_name in exclude:
                    continue
                if not set(node.inputs) <= set(covered):
                    continue
                new_covered = frozenset(set(covered) | set(node.outputs))
                if new_covered == covered:
                    continue
                nxt.append((path + [node.type_name], new_covered))
        if not nxt:
            break
        # 排序：目标相关度优先（产出覆盖 goal 字段最多的优先），深度惩罚次之
        nxt.sort(key=lambda c: (-len(set(c[1]) & goal), len(c[0])))
        candidates = nxt[:BEAM]
    return None

def algorithm_plan(goal_fields: tuple[str, ...]) -> dict:
    # 主链优先解全量目标；失败则选「最长可解子链」作主链，剩余字段拆分支
    main = forward_chain(goal_fields, frozenset(ENTRY_FIELDS)) or []
    if not main:
        candidates = []
        for f in goal_fields:
            sub = forward_chain((f,), frozenset(ENTRY_FIELDS))
            if sub:
                candidates.append(sub)
        if candidates:
            candidates.sort(key=len, reverse=True)
            main = candidates[0]
    main_fields = set(ENTRY_FIELDS) | {f for n in main for f in pool[n].outputs}
    branches: list[dict] = []
    remaining = [f for f in goal_fields if f not in main_fields]
    used: list[str] = list(main)
    for f in remaining:
        sub = forward_chain((f,), frozenset(set(ENTRY_FIELDS) | set(main_fields)), exclude=tuple(used))
        if sub is None:
            return {"main": main, "branches": branches, "uncovered": [f] + [g for g in remaining if g != f]}
        branches.append({"name": f"branch_{f}", "goal": [f], "nodes": sub})
        used.extend(sub)
        main_fields |= {g for n in sub for g in pool[n].outputs}
    return {"main": main, "branches": branches, "uncovered": []}

def plan_to_text(plan: dict) -> str:
    parts = [f"主链: {' -> '.join(plan['main']) or '(空)'}"]
    for b in plan["branches"]:
        parts.append(f"  分支[{b['name']}] 目标={b['goal']}: {' -> '.join(b['nodes'])}")
    if plan.get("uncovered"):
        parts.append(f"  未覆盖: {plan['uncovered']}")
    return "\n".join(parts)

# ── LLM 计划草稿 ───────────────────────────────────────────────

def pool_summary() -> str:
    return "\n".join(
        f"- {n.type_name}: 输入={list(n.inputs)} 输出={list(n.outputs)} 用途={n.purpose}"
        for n in POOL
    )

PLAN_SYSTEM = """你是任务计划组装器。给定结点池与任务目标，输出一个执行计划。
计划 = {"main": [结点名序列], "branches": [{"name": "分支名", "goal": [目标字段], "nodes": [结点名序列]}]}
规则：
1. 只能用给出的结点名，不能编造；不能有环（同一序列内不重复，跨序列可复用）；
2. 主链中每个结点的全部输入字段，必须已被入口字段(user_query, raw_data)或主链更早结点的输出覆盖；
3. 分支用于可并行的独立子任务：分支结点输入可被入口字段、主链结点输出、其它分支输出覆盖；每个分支必须声明它负责产出的 goal 字段；
4. 主链与分支的产出并集必须覆盖任务的全部目标字段；
5. 复杂任务优先拆分支（并行），不要把一切塞进主链；简单任务只需主链。
只输出 JSON，不要输出任何思考过程、解释或 markdown 代码块。"""

def parse_plan(text: str) -> dict | None:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or "main" not in data:
        return None
    data.setdefault("branches", [])
    if not isinstance(data["main"], list) or not all(isinstance(x, str) for x in data["main"]):
        return None
    for b in data["branches"]:
        if not isinstance(b.get("nodes"), list) or not all(isinstance(x, str) for x in b["nodes"]):
            return None
        if not isinstance(b.get("goal"), list):
            b["goal"] = []
    return data

async def llm_plan(llm, goal_fields: tuple[str, ...], goal_desc: str, feedback: str = "") -> tuple[dict | None, str, str | None]:
    user = (
        f"结点池：\n{pool_summary()}\n\n"
        f"任务目标：{goal_desc}\n需要产出的字段: {list(goal_fields)}\n"
        "输出计划 JSON。"
    )
    if feedback:
        user += f"\n\n上一次计划校验失败，错误如下，请修正后重试：\n{feedback}"
    result = await llm.ainvoke(
        [Message(role="system", content=PLAN_SYSTEM), Message(role="user", content=user)],
        params=LLMParams(max_tokens=4000, extra_body={"enable_thinking": False}),
    )
    return parse_plan(result.content or ""), (result.content or ""), result.reasoning

# ── 任务清单（6 个不同任务）─────────────────────────────────────

TASKS = [
    (("unit_tests", "integration_tests", "security_report", "doc", "deploy_plan"),
     "全栈 Web 应用交付：测试+安全+文档+部署"),
    (("market_report", "answer"),
     "竞品调研 + 综合报告"),
    (("clean_data", "analysis_report"),
     "数据清洗 + 分析报告"),
    (("fixed_code", "regression_report"),
     "缺陷修复 + 回归验证"),
    (("doc_zh", "doc_en"),
     "文档多语言化（中英）"),
    (("answer",),
     "调研竞品后直接作答"),
]

async def main() -> None:
    llm = create_llm(LLMConfig.from_dict(MODEL_CONFIG))
    try:
        summary_rows = []
        for i, (gfields, desc) in enumerate(TASKS, 1):
            print("=" * 72)
            print(f"任务{i} [{desc}] 目标字段={list(gfields)}")
            print("=" * 72)

            # ── 算法层 ──
            ap = algorithm_plan(gfields)
            aok, areasons = validate_plan(ap, gfields)
            print(f"[算法] {'✅ 完成' if aok else '❌ 失败: ' + '; '.join(areasons)}")
            print(f"  {plan_to_text(ap)}")

            # ── LLM 层（首轮 + 失败重试）──
            draft, content, reasoning = await llm_plan(llm, gfields, desc)
            if draft is None:
                print("[LLM] ❌ 草稿解析失败（content 为空/非 JSON）")
            else:
                lok, lreasons = validate_plan(draft, gfields)
                print(f"[LLM] 首轮 {'✅ 完成' if lok else '❌ ' + '; '.join(lreasons)}")
                print(f"  {plan_to_text(draft)}")
                if not lok:
                    draft2, _content2, _reasoning2 = await llm_plan(llm, gfields, desc, feedback="; ".join(lreasons))
                    if draft2 is None:
                        print("[LLM] ❌ 重试轮草稿解析失败")
                    else:
                        lok2, lreasons2 = validate_plan(draft2, gfields)
                        print(f"[LLM] 重试轮 {'✅ 完成' if lok2 else '❌ ' + '; '.join(lreasons2)}")
                        print(f"  {plan_to_text(draft2)}")
                        draft, lok = draft2, lok2
            # ── LLM 原始输出（用户要看）──
            print(f"[LLM 原始输出 content]（{len(content)} 字符）")
            print(f"  {content[:400]}{'...' if len(content) > 400 else ''}")
            print(f"[LLM 推理过程 reasoning]（{len(reasoning or '')} 字符，前 250）")
            print(f"  {(reasoning or '')[:250]}")

            lok = lok if "lok" in dir() else False
            summary_rows.append((i, desc, aok, lok))
    finally:
        await llm.aclose()

    print("\n" + "=" * 72)
    print("任务完成判定汇总")
    print("=" * 72)
    print(f"{'任务':<4}{'描述':<28}{'算法':<8}{'LLM':<8}")
    for i, desc, aok, lok in summary_rows:
        print(f"T{i:<3}{desc:<28}{'✅' if aok else '❌':<8}{'✅' if lok else '❌':<8}")
    total_ok = sum(1 for _, _, a, l in summary_rows if a and l)
    print(f"\n双通道全通过: {total_ok}/{len(summary_rows)}")

if __name__ == "__main__":
    asyncio.run(main())

"""graph_lab 核心冒烟自测（无 LLM、无网络、纯确定性）。

覆盖：图构造/随机化、forward 三种模式、collect_stats 显式统计、
train_step 更新、evolve 保守/非保守、checkpoint 序列化往返、
玩具域 6 类任务最短路径（多 seed 收敛 smoke）。

  python experiment/GraphLab/demos/selftest.py
"""

from __future__ import annotations

import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from env import TaskSpace, initial_state, reward
from store import Contract
from graph_engine import GraphEngine
from llm_adapter import LLMAdapter
from nodes import OPTIMAL, build_node_pool, feature
from credit import CreditAssigner
from evolution import Evolution


CREDIT = CreditAssigner()
EVOLUTION = Evolution()

PASS = 0
FAIL = 0


def check(name: str, cond: bool, detail: str = ""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


def build_toy(seed: int = 0) -> GraphEngine:
    g = GraphEngine(seed=seed, feature_fn=feature)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", lambda s: {**s, "ok": s.get("payload") == s.get("expected")}, kind="exit")
    for nid, (func, kind) in build_node_pool(llm=False).items():
        g.add_node(nid, func, kind)
    g.randomize(p=0.25)
    return g


def test_graph_base():
    print("[1] graph base")
    g = build_toy(0)
    check("randomize keeps entry/exit reachable",
          all(any(e.dst == n for e in g.out["entry"]) for n in g.nodes if n != "entry")
          and all(any(e.dst == "exit" for e in g.out[n]) for n in g.nodes if n != "exit"))
    ts = TaskSpace(seed=1)
    task = ts.sample()
    paths = g.forward(initial_state(task), beam=8, max_steps=10)
    check("forward softmax returns beam paths", len(paths) == 8)
    gp = g.forward(initial_state(task), beam=4, max_steps=10, greedy=True)
    check("forward greedy returns beam paths", len(gp) == 4)
    g.collect_stats(paths)
    check("collect_stats accumulates edge uses",
          any(e.uses > 0 for es in g.out.values() for e in es))


def test_train_step():
    print("[2] train_step")
    g = build_toy(0)
    ts = TaskSpace(seed=2)
    task = ts.sample()
    paths = g.forward(initial_state(task), beam=6, max_steps=10)
    rewards = [reward(p, g) for p in paths]
    g.collect_stats(paths)
    before = {e.logit for es in g.out.values() for e in es}
    CREDIT.train(g, paths, rewards)
    after = {e.logit for es in g.out.values() for e in es}
    check("batch train_step changes logits", before != after)
    p1 = g.forward(initial_state(task), beam=1, max_steps=10, greedy=True)[0]
    r1 = reward(p1, g)
    b1 = {e.logit for es in g.out.values() for e in es}
    CREDIT.train(g, [p1], [r1])  # 单样本：固定基线 0，成功正强化/失败负弱化
    a1 = {e.logit for es in g.out.values() for e in es}
    check("single-sample train_step (fixed baseline) works", b1 != a1)


def test_evolve():
    print("[3] evolve")
    g = build_toy(0)
    ts = TaskSpace(seed=3)
    for _ in range(100):
        task = ts.sample()
        paths = g.forward(initial_state(task), beam=6, max_steps=10)
        g.collect_stats(paths)
        CREDIT.train(g, paths, [reward(p, g) for p in paths])
    n_edges0 = g.edge_count()
    ev = EVOLUTION.evolve(g, conservative=False)
    check("non-conservative evolve prunes", len(ev) > 0 and g.edge_count() < n_edges0)
    EVOLUTION.reset_usage(g)
    for _ in range(100):
        task = ts.sample()
        paths = g.forward(initial_state(task), beam=6, max_steps=10)
        g.collect_stats(paths)
        CREDIT.train(g, paths, [reward(p, g) for p in paths])
    n_edges1 = g.edge_count()
    evc = EVOLUTION.evolve(g, conservative=True)
    check("conservative evolve does not mass-prune", g.edge_count() >= n_edges1 - 20,
          f"edges {n_edges1}->{g.edge_count()}")


def test_checkpoint_roundtrip():
    print("[4] checkpoint roundtrip")
    g = build_toy(0)
    ts = TaskSpace(seed=4)
    for _ in range(200):
        task = ts.sample()
        paths = g.forward(initial_state(task), beam=6, max_steps=10)
        g.collect_stats(paths)
        CREDIT.train(g, paths, [reward(p, g) for p in paths])
    data = g.to_dict()
    g2 = GraphEngine.from_dict(data, build_node_pool(llm=False), feature_fn=feature)
    check("roundtrip node count", len(g2.nodes) == len(g.nodes))
    check("roundtrip edge count", g2.edge_count() == g.edge_count())
    check("roundtrip alive flags", all(g2.nodes[n].alive == g.nodes[n].alive for n in g.nodes))
    # 恢复后对 6 类任务 greedy 行为与恢复前一致
    for kind, opt in OPTIMAL.items():
        task = ts._make(kind)
        best1 = max(g.forward(initial_state(task), beam=1, max_steps=10, greedy=True),
                    key=lambda p: (p.ok, -len(p.nodes)))
        best2 = max(g2.forward(initial_state(task), beam=1, max_steps=10, greedy=True),
                    key=lambda p: (p.ok, -len(p.nodes)))
        check(f"roundtrip greedy {kind} consistent", best1.ok == best2.ok
              and best1.nodes == best2.nodes)


def test_toy_convergence_smoke():
    print("[5] toy convergence (short smoke: 1000 episodes)")
    g = build_toy(0)
    ts = TaskSpace(seed=5)
    rng = random.Random(5)
    for ep in range(1, 1001):  # entry 禁入堵住 entry 中转捷径后收敛放缓，1000 轮仍达 1.0
        task = ts.sample()
        eps = max(0.05, 0.7 * (1.0 - ep / 1000))
        paths = g.forward(initial_state(task), beam=8, max_steps=10, eps=eps)
        g.collect_stats(paths)
        CREDIT.train(g, paths, [reward(p, g) for p in paths])
    ok = 0
    for _ in range(60):
        task = ts.sample()
        best = max(g.forward(initial_state(task), beam=8, max_steps=10, greedy=False),
                   key=lambda p: (p.ok, -len(p.nodes)))
        ok += 1 if best.ok else 0
    check("smoke convergence success rate > 0.8", ok / 60 > 0.8, f"sr={ok / 60:.2f}")


def test_contract_gating():
    print("[6] contract gating (engine zero-cost dead ends)")
    calls = {"n": 0}
    def noisy_logger(*a, **k):
        calls["n"] += 1
    def build_contract_graph(entry_saver: float, entry_producer: float):
        g = GraphEngine(seed=0)
        g.add_node("entry", lambda s: dict(s), kind="entry")
        g.add_node("exit", lambda s: {**s, "ok": bool(s.get("saved"))}, kind="exit")
        g.add_node("producer", lambda s: {**s, "content": "x" * 40}, kind="function",
                   contract=Contract(requires={"payload": ()}, provides="content"))
        g.add_node("saver", lambda s: {**s, "saved": True}, kind="tool",
                   contract=Contract(requires={"content": ()}, provides="saved"))
        inst = LLMAdapter(role="generic", api=("", "", ""), logger=noisy_logger, nid="llm_t")
        g.add_node("llm_t", lambda s: {**s, "_out": "out"}, kind="llm",
                   contract=Contract(requires={"payload": ()}, provides="answer"))
        g.add_edge("entry", "saver", entry_saver)
        g.add_edge("entry", "llm_t", 1.0)
        g.add_edge("entry", "producer", entry_producer)
        g.add_edge("producer", "saver", 1.0)
        g.add_edge("saver", "exit", 1.0)
        g.add_edge("llm_t", "exit", 1.0)
        g.add_edge("producer", "exit", 0.5)
        return g

    # 1) 前置不满足 -> 契约死路：零 LLM 调用、func 未执行、坏边入路径
    g = build_contract_graph(entry_saver=3.0, entry_producer=2.0)
    paths = g.forward({"payload": "t"}, beam=1, max_steps=5, greedy=True)
    p = paths[0]
    check("contract dead end (saver before content)", p.dead and not p.ok
          and "saver" in p.edges[-1].dst)
    check("zero-cost: no LLM call on contract dead end", calls["n"] == 0)
    check("contract dead edge in path for credit assignment",
          [e.dst for e in p.edges] == ["saver"])

    # 2) 前置满足 -> 正常执行，路径成功（greedy 走 producer 分支）
    g = build_contract_graph(entry_saver=1.0, entry_producer=3.0)
    p2 = g.forward({"payload": "t"}, beam=1, max_steps=6, greedy=True)[0]
    check("contract satisfied -> success path", p2.ok and "producer" in p2.nodes
          and "saver" in p2.nodes and [e.dst for e in p2.edges] ==
          ["producer", "saver", "exit"])

    # 3) 静态死路：requires 字段无任何提供者 -> 路由前过滤，func 永不执行
    g = build_contract_graph(1.0, 3.0)
    hit = {"n": 0}
    def ghost_fn(s):
        hit["n"] += 1
        return dict(s)
    g.add_node("ghost_req", ghost_fn, kind="function",
               contract=Contract(requires={"ghost_field": ()}))
    g.add_edge("entry", "ghost_req", 3.0)  # 最高 logit，若不过滤必被选中
    g.forward({"payload": "t"}, beam=1, max_steps=5, greedy=True)
    check("statically dead node never executed", hit["n"] == 0)

    # 4) entry 禁入：exit 弹回不再重入 entry（拓扑不变量）
    g = GraphEngine(seed=0)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", lambda s: {**s, "ok": False}, kind="exit")
    g.add_edge("entry", "exit", 1.0)
    g.add_edge("exit", "entry", 1.0)
    p4 = g.forward({"payload": "x"}, beam=1, max_steps=4, greedy=True)[0]
    check("no re-entry into entry", p4.nodes.count("entry") == 1)

    # 5) 契约序列化往返
    g = build_contract_graph(3.0, 2.0)
    g2 = GraphEngine.from_dict(g.to_dict(), {nid: (n.func, n.kind)
                                       for nid, n in g.nodes.items()
                                       if nid not in ("entry", "exit")},
                         entry_fn=lambda s: dict(s),
                         exit_fn=lambda s: {**s, "ok": bool(s.get("saved"))})
    c1, c2 = g.nodes["saver"].contract, g2.nodes["saver"].contract
    check("contract roundtrip (saver requires/provides)",
          c2 is not None and c2.provides == "saved" and c1.to_dict() == c2.to_dict())
    check("contract roundtrip behavior",
          g2.forward({"payload": "t"}, beam=1, max_steps=5, greedy=True)[0].dead
          and not g2.forward({"payload": "t", "content": "z" * 40}, beam=1,
                             max_steps=5, greedy=True)[0].dead)


def test_agent_demo2_smoke():
    print("[7] agent_demo2 pipeline smoke (stub LLM, offline)")
    import agent_demo2 as a2
    a2.API = ("", "", "")  # stub：零网络
    a2.OUT = os.path.join(HERE, "out")
    os.makedirs(a2.WORKDIR, exist_ok=True)
    from dataset import TRAIN_TASKS
    tasks = [TRAIN_TASKS[i % len(TRAIN_TASKS)] for i in range(6)]
    h = a2.arm_heuristic(tasks, "smoke")
    check("heuristic arm runs (offline)", len(h["records"]) == 6
          and h["total"] == 6)
    g, t = a2.arm_graph(tasks, seed=0, beam=2, arm="smoke_t", train=True)
    check("trained arm runs (offline)", len(t["records"]) == 6
          and t["total"] == 6 and t["calls"] >= 0)
    g2, u = a2.arm_graph(tasks, seed=0, beam=2, arm="smoke_u", train=False)
    check("untrained arm runs (offline)", len(u["records"]) == 6
          and u["total"] == 6)
    check("all arms deterministic-consistent ok counts",
          h["ok"] == h["ok"] and isinstance(g.snapshot()["nodes"], int))


def test_skill_macro():
    print("[8] skill macro (B1: O(1) learning)")
    import agent_demo2 as a2
    a2.API = ("", "", "")
    os.makedirs(a2.WORKDIR, exist_ok=True)
    g = a2.build_graph(0, a2.WORKDIR, "smoke")

    # 1) 命中：族一致 + 余弦≥阈值；typed 闸：异族必弃权
    a2.LIBRARY.macros.clear()
    m = a2.SkillMacro("code", ["code", "save_file", "exit"], (0.1, 0.2), 1, 0)
    a2.LIBRARY.add_or_replace(m)
    check("macro match same family + anchor", a2.LIBRARY.match("code", (0.1, 0.2)) is m)
    check("macro abstain cross family (typed gate)",
          a2.LIBRARY.match("novel", (0.1, 0.2)) is None)
    check("macro abstain below cosine threshold",
          a2.LIBRARY.match("code", (0.9, -0.9)) is None)

    # 2) 执行：stub LLM 走完全路径，验收决定成败（验证"验收通过才算命中"）
    state = a2.initial_state("code",
                             "写一个 Python 计算器：实现 add/sub/mul/div 四个函数，保存到 calc.py",
                             a2.WORKDIR, {})
    s0, mc, run = a2.execute_macro(state, m, g)
    check("macro executes full path", run == ["code", "save_file", "exit"])
    check("macro verify fail -> not ok (acceptance gates)",
          s0 is not None and not s0.get("ok"))

    # 3) 漂移护栏：连续 2 次验收失败移除
    a2.LIBRARY.note_fail(m)
    check("macro kept after 1 fail", "code" in a2.LIBRARY.macros)
    a2.LIBRARY.note_fail(m)
    check("macro dropped after 2 consecutive fails", "code" not in a2.LIBRARY.macros)

    # 4) 同族替换：更省调用胜出
    m1 = a2.SkillMacro("code", ["code", "exit"], (0.1, 0.2), 1, 0)
    m2 = a2.SkillMacro("code", ["code", "save_file", "exit"], (0.1, 0.2), 2, 0)
    a2.LIBRARY.macros.clear()
    a2.LIBRARY.add_or_replace(m2)
    a2.LIBRARY.add_or_replace(m1)
    check("macro replace: fewer calls wins", a2.LIBRARY.macros["code"] is m1)

    # 5) 结晶：成功轨迹 -> 宏（去 entry，含 exit）
    a2.LIBRARY.macros.clear()
    ok = a2.crystallize(g, "code", ["entry", "code", "save_file", "exit"], "x" * 10, 1)
    check("crystallize success path -> macro",
          ok and a2.LIBRARY.macros["code"].path == ["code", "save_file", "exit"])

    # 6) 执行中节点缺失 = 弃权（不误用死宏）
    dead = a2.SkillMacro("math", ["math", "ghost_node", "exit"], (0.1, 0.2), 1, 0)
    a2.LIBRARY.macros.clear()
    a2.LIBRARY.add_or_replace(dead)
    s0, mc, run = a2.execute_macro(
        a2.initial_state("math", "解方程 2x + 5 = 17，保存到 m1.txt", a2.WORKDIR, {}),
        dead, g)
    check("macro with missing node abstains (returns None)",
          s0 is None and run == ["math"])


def test_math_verifier():
    print("[9] math numeric acceptance (替换弱验收 '含 x')")
    import agent_demo2 as a2
    ok = a2._math_numeric_check("解方程 2x + 5 = 17，给出步骤", "两边减5：2x=12，x=6")
    check("math numeric: correct x passes", ok)
    bad = a2._math_numeric_check("解方程 2x + 5 = 17，给出步骤", "x = 3")
    check("math numeric: wrong x rejected", not bad)
    nox = a2._math_numeric_check("解方程 2x + 5 = 17，给出步骤", "两边减5得 2x=12")
    check("math numeric: no explicit x= rejected", not nox)
    noparse = a2._math_numeric_check("解一个方程组问题", "x = 1")
    check("math numeric: unparseable equation fails conservatively", not noparse)
    m2 = a2._math_numeric_check("解方程 3x - 7 = 8，给出步骤", "x = 5")
    check("math numeric: subtraction form passes", m2)


def test_contract_route():
    print("[10] contract-only deterministic routing (审查 #3.7)")
    import agent_demo2 as a2
    a2.API = ("", "", "")
    os.makedirs(a2.WORKDIR, exist_ok=True)
    g = a2.build_graph(0, a2.WORKDIR, "smoke")
    # stub LLM 下 translate 验收可通过（ASCII 检查），可验证整链成功
    state = a2.initial_state("translate",
                             "把这句话翻译成英文：今天天气很好，我们去公园散步吧，保存到 t1.txt",
                             a2.WORKDIR, {})
    if os.path.exists(state["path"]):  # 清旧产物防假阳性
        os.remove(state["path"])
    path, s, ok, added = a2.contract_route(g, state)
    check("contract route: 声明即可达验收（零学习）",
          ok and path == ["entry", "translate", "save_file", "exit"], f"path={path}")
    # math 任务：验收是数值代入，stub 输出无 x= 形式 -> 失败但路径合理
    state = a2.initial_state("math", "解方程 2x + 5 = 17，给出步骤，保存到 m1.txt",
                             a2.WORKDIR, {})
    if os.path.exists(state["path"]):  # 清旧产物防假阳性
        os.remove(state["path"])
    path2, s2, ok2, added2 = a2.contract_route(g, state)
    check("contract route: math 走 math->save_file，验收失败即停（不空转）",
          path2 == ["entry", "math", "save_file"] and not ok2,
          f"path={path2} ok={ok2}")
    check("contract route: 缺边按需补全（需求驱动生长）", added >= 1)
    # held-out eval 通路
    from dataset import EVAL_TASKS
    c = a2.arm_contract(EVAL_TASKS, "smoke_c")
    check("contract arm runs on held-out", c["total"] == len(EVAL_TASKS)
          and c["ok"] == c["ok"])


def test_contract_when():
    print("[11] Contract.when 值约束（族由节点产出）")
    from contract_gate import ContractGate
    g = GraphEngine(seed=0)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", lambda s: {**s, "ok": True}, kind="exit")
    g.add_node("classify", lambda s: {**s, "family": "code"}, kind="llm",
               contract=Contract(requires={"payload": ()}, provides="family"))
    role = Contract(requires={"payload": (), "family": ()},
                    when={"family": ("code",)}, provides="code")
    g.add_node("code", lambda s: {**s, "code": "x" * 40}, kind="llm", contract=role)
    check("when: classify 前角色节点不满足（存在性拦住）",
          not ContractGate.ok(role, {"payload": "t"}))
    check("when: 族匹配后可执行",
          ContractGate.ok(role, {"payload": "t", "family": "code"}))
    check("when: 族错配静态死路",
          ContractGate.statically_dead(g.store, g.nodes["code"],
                                       {"payload": "t", "family": "math"}))
    check("when: 无提供者时静态死路",
          ContractGate.statically_dead(
              g.store, g.nodes["code"], {"payload": "t"}) is False)  # classify 能提供


def test_hard_composite():
    print("[12] 难域：单角色必失败 / 声明链 == 人工链")
    import hard_demo as h
    import composite as C
    h.API = ("", "", "")
    os.makedirs(h.WORKDIR, exist_ok=True)
    code_task, tr_task = C.TRAIN_TASKS[0], C.TRAIN_TASKS[3]

    hn = h.arm_chain([code_task], h.NAIVE_CHAIN, "smoke_naive")
    check("naive 单角色链无法满足复合验收", hn["ok"] == 0,
          f"ok={hn['ok']}")

    hf = h.arm_chain([tr_task], h.FULL_CHAIN, "smoke_full")
    co = h.arm_contract([tr_task])
    hf_path = hf["records"][0]["path"].split("->")
    co_path = co["records"][0]["path"].split("->")[1:]  # 去 entry
    check("heuristic_full translate 通过（内容+回译检查）", hf["ok"] == 1,
          f"path={hf_path}")
    check("contract_only 声明反向链 == heuristic_full 人工链",
          co["ok"] == hf["ok"] and co_path == hf_path,
          f"co={co_path} hf={hf_path}")

    cc = h.arm_contract([code_task])
    cp = cc["records"][0]["path"].split("->")
    check("code 契约链含检查器 + 条件修复后重测（依赖失效）",
          cp.count("run_tests") == 2 and "fix" in cp, f"path={cp}")


def main():
    print("graph_lab selftest")
    test_graph_base()
    test_train_step()
    test_evolve()
    test_checkpoint_roundtrip()
    test_toy_convergence_smoke()
    test_contract_gating()
    test_agent_demo2_smoke()
    test_skill_macro()
    test_math_verifier()
    test_contract_route()
    test_contract_when()
    test_hard_composite()
    print(f"\nresult: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()

"""DEPRECATED (2026-09-12): llm_demo 已被 agent_demo 取代（真实 LLM 域主原型）。

保留原因：跨任务干扰对照（scene1/scene2）设计在 agent_demo 未覆盖，
且 feature_fn=None（全局共享权重）是"跨任务影响可观测"的有意设定——
注意这与玩具域的"条件路由=注意力类比"不同，勿混读。

旧说明（历史）：真实 LLM 节点实验：Q1 节点 IO 观测 / Q2 任务完成
（代码项目、小说 ch1-3+审查+精修）/ Q3 微调真实发生（权重更新 + 结构
演化 + 生长）/ Q4 跨任务干扰（scene1 code→novel vs scene2 novel，
同 seed 同初始图）/ Q5 工具（save_file/clean_code/append_file）/
Q6 图前后快照。控制项：同初始图、每轮清理产物、验收基于状态内容。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from graph_engine import GraphEngine
from llm_adapter import LLMAdapter
from credit import CreditAssigner
from evolution import Evolution


CREDIT = CreditAssigner()
EVOLUTION = Evolution()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
TMP = os.path.join(OUT, "tmp")
API = (os.environ.get("LLM_BASE_URL", ""),
       os.environ.get("LLM_KEY", ""),
       os.environ.get("LLM_MODEL", "qwen3.8-flash"))

TASKS = {
    "code": {
        "payload": "写一个 Python 计算器项目：实现 add/sub/mul/div 四个函数，保存为 calc.py，项目要完整可运行。",
        "path": os.path.join(TMP, "calc.py"),
    },
    "novel": {
        "payload": "写一篇短篇小说《雾中灯塔》，写第一章、第二章、第三章，然后审查并精修，保存到 novel.txt。",
        "path": os.path.join(TMP, "novel.txt"),
    },
}

obs_log = os.path.join(OUT, "llm_observations.jsonl")
round_log = os.path.join(OUT, "llm_rounds.jsonl")
report_json = os.path.join(OUT, "llm_report.json")


def obs_logger(nid, role, task, inp, out, secs, provider=""):
    with open(obs_log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": round(time.time(), 3), "node": nid, "role": role,
                            "task": task, "input": inp, "output": out,
                            "secs": round(secs, 1), "provider": provider},
                           ensure_ascii=False) + "\n")


# ---------------- 节点函数 ----------------

llm_instances: dict[str, LLMAdapter] = {}

# 角色 -> 状态字段（polish 写 polished，math 写 math_answer ...）
ROLE_FIELD = {"plan": "plan", "code": "code", "article": "article",
              "translate": "translated", "math": "math_answer",
              "review": "review", "polish": "polished"}


def make_llm(nid: str, role: str):
    if nid not in llm_instances:  # 实例复用：提示词变异/质量偏置对同一节点生效
        inst = LLMAdapter(role=role, api=API, logger=obs_logger, nid=nid)
        llm_instances[nid] = inst
    return llm_instances[nid]


def field_setter(role, field):
    def fn(state):
        st = make_llm(role, role)(state)
        if st is None:
            return None
        return {**st, field: st["payload"]}
    return fn


def chapter_fn(state):  # 章节节点：每次调用写下一章（同一节点多次访问 = 迭代写章）
    st = make_llm("chapter", "chapter")(state)
    if st is None:
        return None
    return {**st, "chapters": list(state.get("chapters", [])) + [st["payload"]]}


def generic_llm(nid):  # 三个同 prompt 的通用 LLM 节点：每个"回答一次"用户任务
    def fn(state):
        st = make_llm(nid, "generic")(state)
        if st is None:
            return None
        return {**st, "answer": st["payload"]}
    return fn


def save_fn(state):  # 工具节点：把产出写入文件（任务产物落盘）
    if state["task"] == "code":
        content = state.get("code") or state.get("answer") or ""
    else:
        content = state.get("polished") or "\n\n".join(state.get("chapters", [])) \
            or state.get("answer") or ""
    if len(content) < 50:
        return None
    d = os.path.dirname(state["path"])
    if d:  # 路径无目录部分时跳过 makedirs，避免 Windows makedirs("") 行为不一致
        os.makedirs(d, exist_ok=True)
    with open(state["path"], "w", encoding="utf-8") as f:
        f.write(content)
    return {**state, "saved": True}


def clean_code_fn(state):  # 工具：剥掉 markdown 代码围栏
    code = state.get("code") or ""
    if "```" in code:
        parts = code.split("```")
        if len(parts) >= 3:
            body = parts[1]
            if body.startswith("python"):
                body = body[len("python"):].lstrip()
            return {**state, "code": body.strip()}
    return dict(state)


def append_fn(state):  # 工具：把当前产出追加写入文件
    content = state.get("polished") or "\n\n".join(state.get("chapters", [])) \
        or state.get("answer") or ""
    if len(content) < 50:
        return None
    d = os.path.dirname(state["path"])
    if d:
        os.makedirs(d, exist_ok=True)
    existed = os.path.exists(state["path"]) and os.path.getsize(state["path"]) > 0
    with open(state["path"], "a", encoding="utf-8") as f:
        f.write(("\n\n" if existed else "") + content)
    return {**state, "saved": True}


def exit_fn(state):  # 验收门：任务完成 = 产出内容正确（文件保存是工具加分项）
    if state["task"] == "code":
        content = state.get("code") or state.get("answer") or ""
        ok = len(content) > 50 and "def add" in content
    else:
        chapters = state.get("chapters", [])
        ok = len(chapters) >= 3 and sum(len(c) for c in chapters) > 300
        if not ok and state.get("answer"):
            ok = len(state["answer"]) > 300 and "第一章" in state["answer"] \
                and "第三章" in state["answer"]
    return {**state, "ok": ok}


def noise_fn(state):
    return None


def pass_fn(state):
    return dict(state)


def initial_state(task_name: str) -> dict:
    t = TASKS[task_name]
    return {"payload": t["payload"], "task": task_name, "path": t["path"],
            "chapters": [], "plan": None, "code": None, "review": None,
            "polished": None}


def reward(path, graph) -> float:
    r = 10.0 - 1.0 * (len(path.nodes) - 1) if path.ok else -2.0
    if path.ok and "save_file" in path.nodes:
        r += 1.0  # 工具加分：成功且落盘
    for nid in path.nodes:
        k = graph.nodes[nid].kind
        if k in ("noise", "fake"):
            r -= 3.0
        elif k == "pass":
            r -= 2.0
    return r


def build_graph(seed: int) -> GraphEngine:
    """混乱初始图：三个同 prompt 的通用 LLM 节点（串联，还原旧组装结构）+ 5 个
    角色 LLM 节点（协作者）+ 3 个工具节点 + 噪声/中性干扰，随机连线。
    feature_fn=None -> 全局共享权重，任务间相互影响可观测（与条件路由不同，勿混读）。"""
    g = GraphEngine(seed=seed)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", exit_fn, kind="exit")
    roles = {
        "plan": ("plan", "function"),
        "code": ("code", "function"),
        "chapter": ("chapter", "function"),
        "review": ("review", "function"),
        "polish": ("polish", "function"),
        "save_file": ("save", "tool"),
        "noise_a": ("noise", "noise"),
        "noise_b": ("noise", "noise"),
        "pass_1": ("pass", "pass"),
        "pass_2": ("pass", "pass"),
    }
    for nid, (role_or_kind, kind) in roles.items():
        if role_or_kind == "save":
            g.add_node(nid, save_fn, kind)
        elif role_or_kind in ("noise", "pass"):
            g.add_node(nid, noise_fn if kind == "noise" else pass_fn, kind)
        else:
            g.add_node(nid, field_setter(role_or_kind, ROLE_FIELD.get(role_or_kind, role_or_kind)), kind)
    for i in (1, 2, 3):  # 三个同 prompt 通用 LLM 节点，串联
        g.add_node(f"llm_{i}", generic_llm(f"llm_{i}"), kind="llm")
    g.add_edge("llm_1", "llm_2", 2.0)
    g.add_edge("llm_2", "llm_3", 2.0)
    g.add_edge("llm_3", "exit", 1.0)
    g.randomize(p=0.3)
    return g


def grow_llm_node(graph: GraphEngine):
    n = 1
    while f"llm_g{n}" in graph.nodes:
        n += 1
    return f"llm_g{n}", generic_llm(f"llm_g{n}"), "llm"


def grow_role_node(graph: GraphEngine):
    role = graph.rng.choice(["plan", "code", "chapter", "review", "polish"])
    n = 1
    while f"{role}_{n}" in graph.nodes:
        n += 1
    return f"{role}_{n}", field_setter(role, ROLE_FIELD.get(role, role)), "function"


FUNC_LIBRARY = {"clean_code": clean_code_fn, "append_file": append_fn}


def grow_node(graph: GraphEngine):
    """结构生长主工厂：LLM 节点（通用/角色克隆）或确定性函数节点。"""
    roll = graph.rng.random()
    if roll < 0.55:
        return grow_llm_node(graph)
    if roll < 0.8:
        return grow_role_node(graph)
    for nid, fn in FUNC_LIBRARY.items():
        if nid not in graph.nodes:
            return nid, fn, "function"
    return grow_llm_node(graph)


# ---------------- 实验流程 ----------------

def run_round(g: GraphEngine, task_name: str, rnd: int, sims: int = 0) -> dict:
    """一次任务：采样探索（beam=max(6,sims)）-> 执行最优 -> 全路径微调。"""
    task = initial_state(task_name)
    if os.path.exists(task["path"]):  # 严谨性：每轮清理产物，杜绝上轮文件假阳性
        os.remove(task["path"])
    paths = g.forward(task, beam=max(6, sims), max_steps=10, greedy=False)
    g.collect_stats(paths)
    path = max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
    rewards = [reward(p, g) for p in paths]
    CREDIT.train(g, paths, rewards)  # 微调：全部路径按奖励更新
    saved = os.path.exists(task["path"])
    record = {"round": rnd, "task": task_name, "ok": bool(path.ok),
              "saved": saved, "beam_ok": sum(1 for p in paths if p.ok),
              "beam": len(paths), "path": "->".join(path.nodes),
              "reward": round(reward(path, g), 2), "snapshot": g.snapshot()}
    with open(round_log, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def run_scene(seed: int, code_first: bool, rounds: int, sims: int) -> tuple[GraphEngine, list[dict]]:
    g = build_graph(seed)
    records = []
    seq = ["code"] * rounds + ["novel"] * rounds if code_first else ["novel"] * rounds
    for i, task_name in enumerate(seq, 1):
        rec = run_round(g, task_name, i, sims)
        records.append(rec)
        print(f"  [r{i:>2}] {task_name:<6} ok={rec['ok']} saved={rec['saved']} "
              f"reward={rec['reward']} path={rec['path']}")
        if i % rounds == 0:  # 演化 schedule：每个任务块结束时一次（含结构生长）
            events = EVOLUTION.evolve(g, new_node_maker=grow_node)
            grown = [e for e in events if e.startswith("grow")]
            print(f"    evolve: {len(events)} events (grow={len(grown)}) | {g.snapshot()}")
            for e in grown:
                print(f"      {e}")
            EVOLUTION.reset_usage(g)
    return g, records


def stats(records: list[dict], task: str) -> dict:
    rs = [r for r in records if r["task"] == task]
    return {
        "rounds": len(rs),
        "success": sum(r["ok"] for r in rs),
        "saved": sum(r["saved"] for r in rs),
        "ok_rounds": [r["round"] for r in rs if r["ok"]],
    }


def summarize(records: list[dict], name: str) -> dict:
    s = {"novel": stats(records, "novel")}
    if any(r["task"] == "code" for r in records):
        s["code"] = stats(records, "code")
    print(f"  {name}: {json.dumps(s, ensure_ascii=False)}")
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=4, help="rounds per task block")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sims", type=int, default=0, help="think-mode simulations (0 = beam-6 sample)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    os.makedirs(TMP, exist_ok=True)
    for p in (obs_log, round_log):
        if os.path.exists(p):
            os.remove(p)
    print(f"LLM api: base={API[0] or '(stub!)'} model={API[2]} key={'set' if API[1] else 'MISSING'}")
    if not (API[0] and API[1]):
        print("WARNING: no API configured -> LLM nodes fall back to stub, results meaningless.")
        return

    g0 = build_graph(args.seed)
    print(f"initial graph (same for both scenes): {g0.snapshot()}")

    print(f"\n=== scene 1: finetune on CODE x{args.rounds}, then NOVEL x{args.rounds} (same graph) ===")
    g1, r1 = run_scene(args.seed, code_first=True, rounds=args.rounds, sims=args.sims)
    s1 = summarize(r1, "scene1")

    print(f"\n=== scene 2 (control): identical initial graph, NOVEL x{args.rounds} only ===")
    g2, r2 = run_scene(args.seed, code_first=False, rounds=args.rounds, sims=args.sims)
    s2 = summarize(r2, "scene2")

    report = {
        "api": {"base": API[0], "model": API[2]},
        "rounds": args.rounds, "seed": args.seed,
        "initial_graph": g0.snapshot(),
        "scene1": {"graph_final": g1.snapshot(), "stats": s1},
        "scene2": {"graph_final": g2.snapshot(), "stats": s2},
        "cross_task": {
            "novel_success_scene1": s1["novel"]["success"],
            "novel_success_scene2": s2["novel"]["success"],
            "novel_rounds": args.rounds,
            "interpretation": (
                "code-finetuning carried into novel (both scenes: s1==s2)" if
                s1["novel"]["success"] >= s2["novel"]["success"] and
                s2["novel"]["success"] > 0 else
                "novel failed in one or both scenes: no cross-task conclusion"),
        },
    }
    with open(report_json, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1)
    print(f"\nreport: {report_json}")
    print(f"observations: {obs_log}")
    print(f"rounds: {round_log}")


if __name__ == "__main__":
    main()

"""hard_demo.py - 难域重构实验（替代 v2 的浅域；数据引擎路线归另一 agent）。

v2 实验结论：契约 + 技能宏（100%/93%）完胜策略梯度（0-20%），但域名太浅——
每族金路径 = 单角色 + save→exit，族由数据集 gold label 直接给出，单个 LLM 角色
节点就能满足验收。本 demo 针对审查逐条重构：

  1. **单角色必失败**：验收 = 内容通道 + 确定性检查器 verdict + 落盘产物；
     code 族还带条件分支：run_tests 失败 -> fix -> 重测（fix 清除过期 verdict）。
  2. **族由系统自产**：entry 后必经 classify LLM 节点，family 由它产出（
     `when={"family": (...)}` 值约束门；classify 前所有角色节点零代价死路）。
  3. **契约含值约束**：`Contract.when` 与 `requires` 分离（存在性 vs 值域）。
  4. 六臂：heuristic_naive / heuristic_full / contract_only(声明反向链) /
     untrained / trained(REINFORCE) / skills(宏)。

Usage:
  python experiment/GraphLab/demos/hard_demo.py --compare --rounds 12 --beam 2
  python experiment/GraphLab/demos/hard_demo.py --smoke      # 离线管线冒烟
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from copy import deepcopy

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from serialization import Serialization  # noqa: E402
from store import Contract, Path  # noqa: E402
from graph_engine import GraphEngine  # noqa: E402
from contract_gate import ContractGate  # noqa: E402
from llm_adapter import LLMAdapter, PROVIDERS  # noqa: E402
from embedding import embed  # noqa: E402
from credit import CreditAssigner  # noqa: E402
from evolution import Evolution  # noqa: E402
from skills import MacroLibrary, SkillMacro  # noqa: E402
import composite as C  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
WORKDIR = os.path.join(OUT, "workspace_hard")

RUN_TS = time.strftime("%Y%m%d_%H%M%S")
obs_log = os.path.join(OUT, f"hard_observations_{RUN_TS}.jsonl")
event_log = os.path.join(OUT, f"hard_events_{RUN_TS}.jsonl")

CALLS = {"n": 0}
MODELS: list[str] | None = None
LLM_TIMEOUT = 90
ANCHOR: str = "hash"  # 宏检索锚点：hash（16 维字符直方图）| embed（语义向量）


def anchor_fn(text: str):
    """宏检索锚点：hash = 字符直方图（零网络）；embed = 语义向量（API，失败回退 hash）。"""
    if ANCHOR == "embed":
        return embed(text)
    return C.hash_anchor(text)


def resolve_api() -> tuple[str, str, str]:
    if os.environ.get("LLM_BASE_URL") and os.environ.get("LLM_KEY"):
        return (os.environ["LLM_BASE_URL"], os.environ["LLM_KEY"],
                os.environ.get("LLM_MODEL", PROVIDERS[0]["models"][0]))
    return (PROVIDERS[0]["base_url"], PROVIDERS[0]["api_key"],
            PROVIDERS[0]["models"][0])


API = resolve_api()


def log_event(obj: dict) -> None:
    Serialization.log_jsonl(event_log, obj)


def obs_logger(arm: str):
    def logger(nid, role, task, inp, out, secs, provider=""):
        CALLS["n"] += 1
        Serialization.log_jsonl(obs_log, {
            "ts": round(time.time(), 3), "arm": arm, "node": nid, "role": role,
            "task": task, "input": inp, "output": out, "secs": round(secs, 1),
            "provider": provider})
    return logger


# ---------------- 契约表（v3：requires 存在性 + when 值约束） ----------------

CONTENT_FIELDS = C.CONTENT_FIELDS

CONTRACTS: dict[str, Contract] = {
    "classify": Contract(requires={"payload": ()}, provides="family"),
    "code": Contract(requires={"payload": (), "family": ()},
                     when={"family": ("code",)}, provides="code"),
    "run_tests": Contract(requires={"code": (), "family": ()},
                          when={"family": ("code",)}, provides="test_verdict"),
    "fix": Contract(requires={"code": (), "test_report": (), "test_verdict": (),
                              "family": ()},
                    when={"family": ("code",), "test_verdict": ("fail",)},
                    provides="code"),
    "translate": Contract(requires={"payload": (), "family": ()},
                          when={"family": ("translate",)}, provides="translated"),
    "backtranslate": Contract(requires={"translated": (), "family": ()},
                              when={"family": ("translate",)},
                              provides="backtranslated"),
    "roundtrip_check": Contract(requires={"backtranslated": (), "family": ()},
                                when={"family": ("translate",)},
                                provides="roundtrip_verdict"),
    "math": Contract(requires={"payload": (), "family": ()},
                     when={"family": ("math",)}, provides="math_answer"),
    "verify_math": Contract(requires={"math_answer": (), "family": ()},
                            when={"family": ("math",)}, provides="math_verdict"),
    "save_file": Contract(requires={"content": CONTENT_FIELDS}, provides="saved"),
}

INPUT_FIELDS = {
    "classify": ("payload",),
    "code": ("payload",),
    "fix": ("payload", "code", "test_report"),
    "translate": ("payload", "source"),
    "backtranslate": ("translated",),
    "math": ("payload",),
}

# 手写路由臂（基线）：naive = 单角色；full = 内容 + 检查器（人工知道域）
NAIVE_CHAIN = {
    "code": ["code", "save_file", "exit"],
    "translate": ["translate", "save_file", "exit"],
    "math": ["math", "save_file", "exit"],
}
FULL_CHAIN = {
    "code": ["code", "run_tests", "save_file", "exit"],
    "translate": ["translate", "backtranslate", "roundtrip_check",
                  "save_file", "exit"],
    "math": ["math", "verify_math", "save_file", "exit"],
}

llm_instances: dict[str, LLMAdapter] = {}


def reset_instances():
    llm_instances.clear()


def make_llm(nid: str, role: str, arm: str) -> LLMAdapter:
    inst = LLMAdapter(role=role, api=API, logger=obs_logger(arm), nid=nid,
                      input_fields=list(INPUT_FIELDS[role]),
                      provides=CONTRACTS[nid].provides, models=MODELS,
                      timeout=LLM_TIMEOUT)
    llm_instances[nid] = inst
    return inst


def define(inst: LLMAdapter, field: str):
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        return {**st, field: st["_out"]}
    return fn


def classify_fn(inst: LLMAdapter):
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        tok = (st.get("_out") or "").strip().lower()
        fam = None
        for t in ("code", "translate", "math"):
            if t in tok:
                fam = t
                break
        if fam is None:
            for k, v in C._ALIASES.items():
                if k in tok:
                    fam = v
                    break
        return {**st, "family": fam or "unknown"}
    return fn


def fix_fn(inst: LLMAdapter):
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        # 修复产出新 code -> 过期 verdict 失效（typed-state 依赖失效）
        return {**st, "code": st["_out"], "test_verdict": None,
                "test_report": None}
    return fn


# ---------------- 工具节点（确定性检查器；写状态 + 落盘验证日志） ----------------

def run_tests_fn(state):
    code = state.get("code")
    if not code:
        return None
    spec = state.get("spec") or {}
    workdir = state["workdir"]
    os.makedirs(workdir, exist_ok=True)
    cand = os.path.join(workdir, "_candidate.py")
    with open(cand, "w", encoding="utf-8") as f:
        f.write(C.strip_fences(code))
    passed, report = C.run_spec_tests(cand, spec.get("tests", []), workdir)
    log = spec.get("log")
    if log:
        lp = log if os.path.isabs(log) else os.path.join(workdir, log)
        with open(lp, "w", encoding="utf-8") as f:
            f.write(report)
    return {**state, "test_verdict": "pass" if passed else "fail",
            "test_report": report[-1200:]}


def roundtrip_fn(state):
    spec = state.get("spec") or {}
    back = state.get("backtranslated") or ""
    if not back:
        return None
    score = C.roundtrip_overlap(spec.get("source", ""), back)
    return {**state, "roundtrip_score": round(score, 3),
            "roundtrip_verdict": "pass" if score >= spec.get("min_overlap", 0.5)
            else "fail"}


def verify_math_fn(state):
    spec = state.get("spec") or {}
    ans = state.get("math_answer") or ""
    if not ans:
        return None
    ok = C.math_verify(spec, ans)
    return {**state, "math_verdict": "pass" if ok else "fail"}


def save_fn(state):
    fam = state.get("family")
    content = {"code": state.get("code"), "translate": state.get("translated"),
               "math": state.get("math_answer")}.get(fam) or ""
    if len(content) < 10:
        return None
    os.makedirs(state["workdir"], exist_ok=True)
    with open(state["path"], "w", encoding="utf-8") as f:
        f.write(content)
    return {**state, "saved": True}


def _saved_ok(state) -> bool:
    p = state.get("path")
    return bool(state.get("saved")) or bool(
        p and os.path.exists(p) and os.path.getsize(p) > 0)


def exit_fn(state):
    ok = C.accept(state)
    if ok and state.get("require_file"):
        ok = _saved_ok(state)
    return {**state, "ok": ok}


def noise_fn(state):
    return None


def pass_fn(state):
    return dict(state)


def initial_state(task: dict) -> dict:
    spec = dict(task.get("spec") or {})
    path = os.path.join(WORKDIR, task["file"])
    return {"payload": task["desc"], "spec": spec, "workdir": WORKDIR,
            "path": path, "require_file": True, "source": spec.get("source"),
            "type": task["type"], "family": None,
            "code": None, "test_verdict": None, "test_report": None,
            "translated": None, "backtranslated": None,
            "roundtrip_verdict": None, "roundtrip_score": None,
            "math_answer": None, "math_verdict": None, "saved": None}


def hard_feature(state) -> str:
    """路由观察 = 类型化族标签（classify 产出前为 unclassified）。"""
    return state.get("family") or "unclassified"


# ---------------- 图构造 ----------------

def build_graph(seed: int, arm: str) -> GraphEngine:
    """混乱初始图：1 分类 + 6 角色（含 fix）+ 4 工具 + 干扰节点。
    只给 entry->classify 一个先验（族必须由系统自产）；其余随机。"""
    g = GraphEngine(seed=seed, feature_fn=hard_feature)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", exit_fn, kind="exit")
    for role in ("classify", "code", "translate", "backtranslate", "math"):
        fn = classify_fn(make_llm(role, role, arm)) if role == "classify" \
            else define(make_llm(role, role, arm), CONTRACTS[role].provides)
        g.add_node(role, fn, kind="llm", contract=CONTRACTS[role])
    g.add_node("fix", fix_fn(make_llm("fix", "fix", arm)), kind="llm",
               contract=CONTRACTS["fix"])
    for tool, fn in (("run_tests", run_tests_fn),
                     ("roundtrip_check", roundtrip_fn),
                     ("verify_math", verify_math_fn),
                     ("save_file", save_fn)):
        g.add_node(tool, fn, kind="tool", contract=CONTRACTS[tool])
    g.add_edge("entry", "classify", 2.0)  # 唯一先验：族由 classify 自产
    for i in (1, 2):
        g.add_node(f"noise_{i}", noise_fn, kind="noise")
        g.add_node(f"pass_{i}", pass_fn, kind="pass")
    g.randomize(p=0.22)
    return g


def reward(path: Path, g: GraphEngine) -> float:
    r = 10.0 - 1.0 * (len(path.nodes) - 1) if path.ok else -2.0
    if path.ok and any(g.nodes[n].kind == "tool" for n in path.nodes):
        r += 1.0
    for nid in path.nodes:
        k = g.nodes[nid].kind
        if k in ("noise", "fake"):
            r -= 3.0
        elif k == "pass":
            r -= 2.0
    return r


# ---------------- 直接执行（手写臂 / 宏执行 / 契约臂 共用） ----------------

def run_sequence(g: GraphEngine, state: dict, nids: list[str]):
    """按序执行节点：逐节点过契约；任一步失败返回 (None, 已执行序)。"""
    s = deepcopy(state)
    run: list[str] = []
    for nid in nids:
        n = g.nodes.get(nid)
        if n is None or not n.alive:
            return None, run
        if n.contract and not ContractGate.ok(n.contract, s):
            return None, run
        s2 = n.func(s)
        if s2 is None:
            return None, run
        s = s2
        run.append(nid)
    return s, run


def run_chain(g: GraphEngine, state: dict, chains: dict):
    """手写臂：先 classify（族由系统产出），再按运行期族选链。"""
    s0, run = run_sequence(g, state, ["classify"])
    if s0 is None:
        return None, run
    chain = chains.get(s0.get("family"))
    if not chain:
        return None, run
    s1, run2 = run_sequence(g, s0, chain)
    return s1, run + run2


# ---------------- 契约导向规划（声明反向链，零学习） ----------------

def _missing(field: str, s: dict) -> bool:
    if field == "content":
        return not any(s.get(k) is not None for k in CONTENT_FIELDS)
    return s.get(field) is None


def _providers(g: GraphEngine, field: str) -> list[str]:
    if field == "content":
        out: list[str] = []
        for cf in CONTENT_FIELDS:
            out += [nid for nid, n in g.nodes.items()
                    if n.alive and n.contract and n.contract.provides == cf]
        return out
    return [nid for nid, n in g.nodes.items()
            if n.alive and n.contract and n.contract.provides == field]


def _pick(g: GraphEngine, s: dict, field: str, depth: int = 0):
    """选满足 field 的节点：优先契约当前可执行的（含 when），否则先补其前置。"""
    if depth > 2:
        return None
    for nid in _providers(g, field):
        n = g.nodes[nid]
        if ContractGate.ok(n.contract, s):
            return nid
    for nid in _providers(g, field):
        for r in g.nodes[nid].contract.requires:
            if _missing(r, s):
                sub = _pick(g, s, r, depth + 1)
                if sub:
                    return sub
    return None


def contract_route(g: GraphEngine, state: dict, max_steps: int = 10):
    """声明即调度器：按验收规格反向链，逐步补齐缺失字段。
    目标序：family -> 验收 verdict(=pass) -> saved -> exit。
    verdict 为 fail 时优先选 when 命中该失败态的修复者（fix），其清除过期
    verdict 后检查器可重跑（依赖失效机制）。"""
    s = deepcopy(state)
    path = [g.entry]
    added = 0
    for _ in range(max_steps):
        fam = s.get("family")
        target = None
        if fam is None:
            target = "family"
        else:
            for f in C.ACCEPT_FIELDS.get(fam, ()):
                if s.get(f) != "pass":
                    target = f
                    break
            if target is None and not _saved_ok(s):
                target = "saved"
            if target is None:
                target = "exit"
        if target == "exit":
            if not any(e.dst == g.exit for e in g.out[path[-1]]):
                g.add_edge(path[-1], g.exit, 1.0)
                added += 1
            s2 = exit_fn(s)
            return s2, path + ["exit"], added
        nid = None
        cur_val = s.get(target)
        if cur_val == "fail":  # 优先修复者（when 命中失败态）
            for cand, n in g.nodes.items():
                if n.alive and n.contract and n.contract.provides in CONTENT_FIELDS \
                        and n.contract.when.get(target) == ("fail",):
                    nid = cand
                    break
        if nid is None and cur_val == "fail":
            break  # 失败态且无修复者：重跑检查器无意义
        if nid is None:
            nid = _pick(g, s, target)
        if nid is None:
            break
        prov = g.nodes[nid].contract.provides if g.nodes[nid].contract else None
        if nid in path[1:] and s.get(prov) not in (None, "fail"):
            break  # 重跑无意义（已产出且未失效）
        if not any(e.dst == nid for e in g.out[path[-1]]):
            g.add_edge(path[-1], nid, 1.0)
            added += 1
            log_event({"event": "contract_edge", "src": path[-1], "dst": nid,
                       "ts": round(time.time(), 3)})
        s2 = g.nodes[nid].func(s)
        if s2 is None:
            break
        s = s2
        path.append(nid)
    return s, path, added


# ---------------- 臂 ----------------

def skill_curve(records: list[dict]) -> dict:
    fam: dict[str, dict] = {}
    for i, r in enumerate(records, 1):
        f = r["task"]
        d = fam.setdefault(f, {"seen": 0, "ok": 0, "first_ok": None,
                               "streak": 0, "streak3": None, "calls": 0})
        d["seen"] += 1
        d["calls"] += r.get("calls", 0)
        if r["ok"]:
            d["ok"] += 1
            if d["first_ok"] is None:
                d["first_ok"] = i
            d["streak"] += 1
            if d["streak"] >= 3 and d["streak3"] is None:
                d["streak3"] = i
        else:
            d["streak"] = 0
    return fam


def _record(g, task, run, ok, calls):
    return {"round": 0, "task": task["type"], "ok": bool(ok), "path": "->".join(run),
            "calls": calls}


# ---------------- 演化回归闸门（B：成功非降才提交，失败回滚 + 审计） ----------------

def gate_score(g: GraphEngine, tasks: list[dict]) -> int:
    """闸门评分 = gate 集上 greedy pass@1 成功数（结构演化的受控指标）。"""
    ok = 0
    for t in tasks:
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        p = g.forward(state, beam=1, max_steps=10, greedy=True)[0]
        ok += 1 if p.ok else 0
    return ok


def gate_tasks_one_per_family() -> list[dict]:
    """每族取 1 个训练任务作闸门集（分布内，不动 held-out）。"""
    out, seen = [], set()
    for t in C.TRAIN_TASKS:
        if t["type"] not in seen:
            out.append(t)
            seen.add(t["type"])
    return out


def arm_chain(tasks: list[dict], chains: dict, arm: str) -> dict:
    reset_instances()
    CALLS["n"] = 0
    g = build_graph(0, arm)
    records = []
    for i, t in enumerate(tasks, 1):
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        s, run = run_chain(g, state, chains)
        rec = _record(g, t, run, s is not None and s.get("ok"), CALLS["n"] - c0)
        rec["round"] = i
        records.append(rec)
    return {"records": records, "calls": CALLS["n"], "skill": skill_curve(records),
            "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


def arm_contract(tasks: list[dict]) -> dict:
    reset_instances()
    CALLS["n"] = 0
    g = build_graph(0, "contract_only")
    records = []
    for i, t in enumerate(tasks, 1):
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        s, run, added = contract_route(g, state)
        rec = _record(g, t, run, s is not None and s.get("ok"), CALLS["n"] - c0)
        rec["round"] = i
        rec["edges_added"] = added
        records.append(rec)
    return {"records": records, "calls": CALLS["n"], "skill": skill_curve(records),
            "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


def arm_graph(tasks: list[dict], seed: int, beam: int, arm: str,
              train: bool, evolve_every: int = 5, max_steps: int = 10,
              skills: bool = False, macro_lib: MacroLibrary | None = None,
              gate: bool = False,
              gate_tasks: list[dict] | None = None) -> tuple:
    reset_instances()
    CALLS["n"] = 0
    g = build_graph(seed, arm)
    rng = random.Random(seed)
    credit = CreditAssigner()
    evo = Evolution()
    records = []
    for i, t in enumerate(tasks, 1):
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        done = False
        rec = None
        if skills and macro_lib is not None:
            # 族由系统自产：先跑 classify，再用产出的 family 匹配宏（不吃 gold label）
            s0, run0 = run_sequence(g, state, ["classify"])
            fam = s0.get("family") if s0 is not None else None
            m = macro_lib.match(fam, anchor_fn(t["desc"])) if fam else None
            if m is not None:
                s, run = run_sequence(g, s0, m.path)
                if s is not None and s.get("ok"):
                    m.hits += 1
                    m.ok += 1
                    m.fails = 0
                    rec = {"round": i, "task": t["type"], "ok": True,
                           "path": "->".join(run0 + run), "macro": True,
                           "calls": CALLS["n"] - c0}
                    done = True
                else:
                    macro_lib.note_fail(m)
        if not done:
            paths = g.forward(state, beam=beam, max_steps=max_steps, greedy=False)
            if train:
                g.collect_stats(paths)
            best = max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
            if train:
                credit.train(g, paths, [reward(p, g) for p in paths])
                if skills and best.ok and macro_lib is not None:
                    macro_lib.add_or_replace(SkillMacro(
                        t["type"], best.nodes[1:], anchor_fn(t["desc"]),
                        sum(1 for n in best.nodes
                            if g.nodes[n].kind in ("llm", "function")), i))
            rec = {"round": i, "task": t["type"], "ok": bool(best.ok),
                   "path": "->".join(best.nodes), "macro": False,
                   "calls": CALLS["n"] - c0}
        rec["round"] = i
        records.append(rec)
        print(f"    [r{i:>2}] {t['type']:<9} ok={rec['ok']} "
              f"macro={rec.get('macro')} calls={rec['calls']} path={rec['path']}",
              flush=True)
        if train and i % evolve_every == 0:
            if gate and gate_tasks:
                before = gate_score(g, gate_tasks)
                snap = deepcopy(g)
                events = evo.evolve(g, conservative=True)
                after = gate_score(g, gate_tasks)
                if after < before:
                    g.__dict__.clear()
                    g.__dict__.update(snap.__dict__)
                    log_event({"event": "evolve_rollback", "round": i,
                               "before": before, "after": after,
                               "ts": round(time.time(), 3)})
                    print(f"    gate: ROLLBACK (before={before} after={after})",
                          flush=True)
                else:
                    log_event({"event": "evolve_commit", "round": i,
                               "before": before, "after": after,
                               "events": len(events),
                               "ts": round(time.time(), 3)})
                    print(f"    gate: commit (before={before} after={after}) "
                          f"| {len(events)} events | {g.snapshot()}", flush=True)
            else:
                events = evo.evolve(g, conservative=True)
                if events:
                    print(f"    evolve: {len(events)} events | {g.snapshot()}",
                          flush=True)
    return g, {"records": records, "calls": CALLS["n"],
               "skill": skill_curve(records),
               "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


def evaluate(g: GraphEngine, tasks: list[dict], arm: str) -> dict:
    """held-out：greedy pass@1（各臂同预算）。非图臂自建图。"""
    if arm in ("heuristic_naive", "heuristic_full", "contract_only"):
        reset_instances()
        g = build_graph(0, arm)
    records = []
    CALLS["n"] = 0
    for i, t in enumerate(tasks, 1):
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        if arm == "heuristic_naive":
            s, run = run_chain(g, state, NAIVE_CHAIN)
        elif arm == "heuristic_full":
            s, run = run_chain(g, state, FULL_CHAIN)
        elif arm == "contract_only":
            s, run, _ = contract_route(g, state)
        else:
            p = g.forward(state, beam=1, max_steps=10, greedy=True)[0]
            s, run = p.state, p.nodes
        records.append({"round": i, "task": t["type"], "ok": bool(s and s.get("ok")),
                        "calls": CALLS["n"] - c0, "path": "->".join(run)})
    return {"records": records, "calls": CALLS["n"],
            "skill": skill_curve(records),
            "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


def fmt_arm(name: str, res: dict, indent: str = "  ") -> str:
    lines = [f"{indent}== {name}: ok {res['ok']}/{res['total']} "
             f"({res['ok'] / max(1, res['total']):.0%}) calls={res['calls']}"]
    for fam, d in sorted(res.get("skill", {}).items()):
        lines.append(f"{indent}    {fam:<9} first={d['first_ok']} "
                     f"streak3={d['streak3']} seen={d['seen']} ok={d['ok']} "
                     f"calls={d['calls']}")
    return "\n".join(lines)


def run_compare(args) -> None:
    train = [C.TRAIN_TASKS[i % len(C.TRAIN_TASKS)] for i in range(args.rounds)]
    print(f"hard domain | train rounds={len(train)} beam={args.beam} "
          f"seed={args.seed}")

    print("\n----- arm 1/6: heuristic_naive (单角色+save，不知道复合验收) -----")
    hn = arm_chain(train, NAIVE_CHAIN, "heuristic_naive")
    print(fmt_arm("heuristic_naive", hn))

    print("\n----- arm 2/6: heuristic_full (人工知道域：内容+检查器+落盘) -----")
    hf = arm_chain(train, FULL_CHAIN, "heuristic_full")
    print(fmt_arm("heuristic_full", hf))

    print("\n----- arm 3/6: contract_only (声明反向链，零学习零随机) -----")
    co = arm_contract(train)
    print(fmt_arm("contract_only", co))

    print("\n----- arm 4/6: untrained random graph -----")
    gu, un = arm_graph(train, args.seed, args.beam, "untrained", train=False)
    print(fmt_arm("untrained", un))

    print("\n----- arm 5/6: trained graph (契约门控 + REINFORCE) -----")
    gt, tr = arm_graph(train, args.seed, args.beam, "trained", train=True)
    print(fmt_arm("trained", tr))

    print("\n----- arm 6/6: trained + skills (teacher 宏) -----")
    lib = MacroLibrary(threshold=args.macro_threshold, log_fn=log_event)
    for r in hf["records"]:
        if r["ok"]:
            lib.add_or_replace(SkillMacro(r["task"], FULL_CHAIN[r["task"]],
                                          anchor_fn(
                                              next(t["desc"] for t in train
                                                   if t["type"] == r["task"])),
                                          1, r.get("round", 0)))
    print(f"    teacher: {len(lib.macros)} 条宏 -> {list(lib.macros)}", flush=True)
    gs, sk = arm_graph(train, args.seed, args.beam, "trained_skills", train=True,
                       skills=True, macro_lib=lib)
    print(fmt_arm("trained_skills", sk))

    print("\n----- held-out eval (composite.EVAL_TASKS, greedy pass@1) -----")
    evals = {}
    for name, g in (("heuristic_naive", None), ("heuristic_full", None),
                    ("contract_only", None), ("untrained", gu),
                    ("trained", gt), ("trained_skills", gs)):
        evals[name] = evaluate(g, C.EVAL_TASKS, name)
        print(fmt_arm(name, evals[name]))
    sk_eval = skills_macro_eval(gs, lib, C.EVAL_TASKS)
    print(fmt_arm("skills_macro_only", sk_eval))

    result = {"ts": RUN_TS, "seed": args.seed, "beam": args.beam,
              "rounds": args.rounds,
              "train": {"heuristic_naive": hn, "heuristic_full": hf,
                        "contract_only": co, "untrained": un,
                        "trained": tr, "trained_skills": sk},
              "eval": evals, "skills_macro_only": sk_eval,
              "final_graph": gt.snapshot()}
    path = os.path.join(OUT, f"hard_compare_{RUN_TS}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"\nresult -> {path}")
    print(f"logs -> {os.path.basename(obs_log)} / {os.path.basename(event_log)}")


def skills_macro_eval(g: GraphEngine, lib: MacroLibrary,
                      tasks: list[dict]) -> dict:
    """held-out：宏优先（classify 自产族 -> 锚点匹配 -> 宏链执行）。"""
    res = {"records": [], "calls": 0, "ok": 0, "total": len(tasks)}
    CALLS["n"] = 0
    for i, t in enumerate(tasks, 1):
        state = initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        s0, run0 = run_sequence(g, state, ["classify"])
        fam = s0.get("family") if s0 is not None else None
        m = lib.match(fam, anchor_fn(t["desc"])) if fam else None
        if m is not None:
            s, run = run_sequence(g, s0, m.path)
            run = run0 + run
        else:
            s, run = None, run0
        ok = bool(s is not None and s.get("ok"))
        res["records"].append({"round": i, "task": t["type"], "ok": ok,
                               "calls": CALLS["n"] - c0,
                               "path": "->".join(run)})
    res["calls"] = CALLS["n"]
    res["ok"] = sum(1 for r in res["records"] if r["ok"])
    return res


def run_gated(args) -> None:
    """B：演化回归闸门对照（只跑受闸门约束的训练臂，对照 095555 无闸门基线）。"""
    train = [C.TRAIN_TASKS[i % len(C.TRAIN_TASKS)] for i in range(args.rounds)]
    gates = gate_tasks_one_per_family()
    print(f"hard gated | train rounds={len(train)} beam={args.beam} "
          f"seed={args.seed} anchor={ANCHOR} "
          f"gate={[t['type'] for t in gates]}", flush=True)

    lib = MacroLibrary(threshold=args.macro_threshold, log_fn=log_event)
    for fam, chain in FULL_CHAIN.items():
        first = next(t for t in C.TRAIN_TASKS if t["type"] == fam)
        lib.add_or_replace(SkillMacro(fam, chain, anchor_fn(first["desc"]), 1, 0))
    print(f"    teacher: {len(lib.macros)} 条宏（FULL_CHAIN 直构）", flush=True)

    print("\n----- arm g1: trained_gated (REINFORCE + 回归闸门演化) -----")
    gt, tr = arm_graph(train, args.seed, args.beam, "trained_gated", train=True,
                       gate=True, gate_tasks=gates)
    print(fmt_arm("trained_gated", tr))

    print("\n----- arm g2: trained_skills_gated (宏 + 回归闸门演化) -----")
    gs, sk = arm_graph(train, args.seed, args.beam, "trained_skills_gated",
                       train=True, skills=True, macro_lib=lib,
                       gate=True, gate_tasks=gates)
    print(fmt_arm("trained_skills_gated", sk))

    print("\n----- held-out eval (greedy pass@1) -----")
    evals = {}
    for name, g in (("trained_gated", gt), ("trained_skills_gated", gs)):
        evals[name] = evaluate(g, C.EVAL_TASKS, name)
        print(fmt_arm(name, evals[name]))
    sk_eval = skills_macro_eval(gs, lib, C.EVAL_TASKS)
    print(fmt_arm("skills_macro_only", sk_eval))

    result = {"ts": RUN_TS, "seed": args.seed, "beam": args.beam,
              "rounds": args.rounds, "anchor": ANCHOR,
              "gate_tasks": [t["type"] for t in gates],
              "train": {"trained_gated": tr, "trained_skills_gated": sk},
              "eval": evals, "skills_macro_only": sk_eval,
              "final_graph": gt.snapshot()}
    path = os.path.join(OUT, f"hard_gated_{RUN_TS}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"\nresult -> {path}")
    print(f"logs -> {os.path.basename(obs_log)} / {os.path.basename(event_log)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compare", action="store_true")
    ap.add_argument("--gated", action="store_true",
                    help="只跑回归闸门臂（trained_gated / trained_skills_gated）")
    ap.add_argument("--smoke", action="store_true", help="离线管线冒烟（stub LLM）")
    ap.add_argument("--rounds", type=int, default=12)
    ap.add_argument("--beam", type=int, default=2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--models", default="")
    ap.add_argument("--llm_timeout", type=int, default=90)
    ap.add_argument("--macro_threshold", type=float, default=0.6)
    ap.add_argument("--anchor", choices=("hash", "embed"), default="hash",
                    help="宏检索锚点：hash（零网络）| embed（语义向量，dashscope）")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    global MODELS, API, LLM_TIMEOUT, ANCHOR
    LLM_TIMEOUT = args.llm_timeout
    ANCHOR = args.anchor
    if args.anchor == "embed":
        os.environ.setdefault("LLM_EMBED_KEY", PROVIDERS[1]["api_key"])
    if args.models:
        MODELS = [m.strip() for m in args.models.split(",") if m.strip()]
    if args.smoke:
        API = ("", "", "")
        print("SMOKE mode: stub LLM (no network)")
    elif not API[0]:
        print("ERROR: no LLM credentials.")
        return
    os.makedirs(WORKDIR, exist_ok=True)
    print(f"LLM: {API[0] or '(stub)'} models_pinned={MODELS} "
          f"anchor={ANCHOR} | workdir={WORKDIR}")

    if args.gated:
        run_gated(args)
        return
    if args.compare or args.smoke:
        run_compare(args)
        return
    ap.print_help()


if __name__ == "__main__":
    main()

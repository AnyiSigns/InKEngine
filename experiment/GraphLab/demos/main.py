"""Experiment entry: train a messy random graph into a reliable one.

  python experiment/GraphLab/demos/main.py [--episodes 3000] [--seed 0] [--llm]

Background:
  The old "assembly" graph ran, but it was just N LLM nodes chained in sequence -
  every query walked the same random route through LLM calls, so assembly felt
  equivalent to randomness. This experiment tests whether the randomness can be
  TRAINED AWAY: start from a fully randomized graph (noise/fake nodes, random
  edges), train routing weights with REINFORCE + replay + structure evolution,
  and check whether the graph converges to short deterministic correct paths.

Outputs:
  - out/curves.json           training curves (success rate / path len / entropy)
  - out/checkpoint_best.json  best-graph snapshot (checkpoint / rollback)
  - out/evolution_log.jsonl   structure evolution audit log
  - stdout                    messiness report, evolution events, skeleton report,
                              black-box IO demo
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import Counter

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from env import TaskSpace, initial_state, reward
from graph_engine import GraphEngine
from nodes import OPTIMAL, build_node_pool, feature
from credit import CreditAssigner
from evolution import Evolution


CREDIT = CreditAssigner()
EVOLUTION = Evolution()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")


def build_messy_graph(seed: int, llm: bool = False) -> GraphEngine:
    """Messy initial graph: useful ops + fake + noise + pass nodes, randomly wired."""
    g = GraphEngine(seed=seed, feature_fn=feature)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", lambda s: {**s, "ok": s.get("payload") == s.get("expected")}, kind="exit")
    for nid, (func, kind) in build_node_pool(llm).items():
        g.add_node(nid, func, kind)
    g.randomize(p=0.25)
    return g


def save_checkpoint(g: GraphEngine, meta: dict) -> None:
    """Persist best graph: weight snapshot (checkpoint). Structure changes go to
    evolution_log.jsonl (audit)."""
    with open(os.path.join(OUT, "checkpoint_best.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "graph": g.to_dict()}, f, ensure_ascii=False, indent=1)


def load_checkpoint(llm: bool = False) -> GraphEngine:
    """从 checkpoint_best.json 恢复图（resume / 回滚到历史最优）。llm=True 时按
    --llm 训练的图恢复（含 LLM 节点），否则 LLM 节点缺失会 KeyError。"""
    with open(os.path.join(OUT, "checkpoint_best.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    return GraphEngine.from_dict(data["graph"], build_node_pool(llm=llm), feature_fn=feature)


def evaluate(g: GraphEngine, ts: TaskSpace, n: int = 200, greedy: bool = True, beam: int = 6) -> dict:
    """Evaluate on n fresh tasks: success rate, avg path len, avg op count."""
    ok = 0
    lens: list[int] = []
    ops: list[int] = []
    for _ in range(n):
        task = ts.sample()
        paths = g.forward(initial_state(task), beam=beam, max_steps=10, greedy=greedy)
        best = max(paths, key=lambda p: (p.ok, -len(p.nodes)))
        if best.ok:
            ok += 1
            lens.append(len(best.nodes) - 2)
            ops.append(len([n for n in best.nodes if g.nodes[n].kind == "function"]))
    return {
        "success_rate": ok / n,
        "avg_path_len": round(sum(lens) / len(lens), 2) if lens else None,
        "avg_ops": round(sum(ops) / len(ops), 2) if ops else None,
    }


def learned_path(g: GraphEngine, task: dict) -> list[str]:
    """Greedy forward pass: what the trained graph actually does (white-box view)."""
    best = max(g.forward(initial_state(task), beam=1, max_steps=10, greedy=True),
               key=lambda p: (p.ok, -len(p.nodes)))
    return best.nodes


def report_final(g: GraphEngine, ts: TaskSpace) -> str:
    lines = []
    lines.append("=" * 66)
    lines.append("FINAL SKELETON: learned greedy path vs optimal path per task kind")
    lines.append("=" * 66)
    matched = 0
    for kind, opt in OPTIMAL.items():
        task = ts._make(kind)
        got = learned_path(g, task)
        same = got == opt
        matched += same
        lines.append(f"  {kind:<15} learned: {'->'.join(got):<36} optimal: {'->'.join(opt)}  "
                     f"{'[OK]' if same else '[X]'}")
    lines.append(f"  exact-optimal ratio: {matched}/{len(OPTIMAL)}")
    lines.append("")
    lines.append("node fates (alive / discarded):")
    for nid, n in sorted(g.nodes.items()):
        lines.append(f"  {nid:<12} {'alive' if n.alive else 'discarded'}  kind={n.kind}")
    return "\n".join(lines)


def black_box_demo(g: GraphEngine, ts: TaskSpace, n: int = 6) -> str:
    """User view: input -> output (black box), with internal route beside it (white box)."""
    lines = ["user-visible IO (black box)                     | internal route (white box)"]
    for _ in range(n):
        task = ts.sample()
        best = max(g.forward(initial_state(task), beam=8, max_steps=10, greedy=False),
                   key=lambda p: (p.ok, -len(p.nodes)))
        out = str(best.state.get("payload"))[:14] if best.ok else "FAIL"
        lines.append(f"  {str(task['payload'])[:18]:<20} -> {out:<14} | {'->'.join(best.nodes)}")
    return "\n".join(lines)


def skeleton(g: GraphEngine, ts: TaskSpace, n: int = 400) -> dict:
    """Stats of edges/nodes on successful paths of fresh tasks (the trained skeleton)."""
    edge_hits = Counter()
    node_hits = Counter()
    for _ in range(n):
        task = ts.sample()
        paths = g.forward(initial_state(task), beam=8, max_steps=10, greedy=False)
        for p in paths:
            if not p.ok:
                continue
            for e in p.edges:
                edge_hits[(e.src, e.dst)] += 1
            for nid in p.nodes:
                node_hits[nid] += 1
    return {
        "edges": [{"src": a, "dst": b, "hits": c} for (a, b), c in edge_hits.most_common(20)],
        "nodes": [{"id": nid, "hits": c} for nid, c in node_hits.most_common(20)],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--llm", action="store_true",
                    help="add LLM node (real API when LAB_LLM=1, otherwise deterministic stub)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    os.makedirs(OUT, exist_ok=True)
    ts = TaskSpace(seed=args.seed)
    g = build_messy_graph(args.seed, llm=args.llm)
    evo_log = os.path.join(OUT, "evolution_log.jsonl")

    print(f"initial messy graph: {g.snapshot()} "
          f"mean_out_degree={g.mean_out_degree():.2f} route_entropy={g.route_entropy():.3f}")
    base = evaluate(g, ts, greedy=True)
    print(f"before training (greedy): success_rate={base['success_rate']:.2f}")

    episodes = args.episodes
    eval_every, evolve_every = 100, 500
    rng = random.Random(args.seed)
    curve = []
    best_sr, best_ep = 0.0, 0
    for ep in range(1, episodes + 1):
        task = ts.sample()
        eps = max(0.05, 0.7 * (1.0 - ep / episodes))  # epsilon anneal: explore -> exploit
        paths = g.forward(initial_state(task), beam=12, max_steps=10, eps=eps)
        g.collect_stats(paths)
        rewards = [reward(p, g) for p in paths]
        CREDIT.train(g, paths, rewards)

        if ep % evolve_every == 0:
            events = EVOLUTION.evolve(g)
            print(f"[ep {ep}] evolve: {len(events)} events | {g.snapshot()}")
            for ev in events[:10]:
                print(f"    {ev}")
            with open(evo_log, "a", encoding="utf-8") as f:  # audit: every structural change
                for ev in events:
                    f.write(json.dumps({"episode": ep, "event": ev}) + "\n")
            EVOLUTION.reset_usage(g)

        if ep % eval_every == 0:
            gr = evaluate(g, ts, greedy=True)
            sr = evaluate(g, ts, greedy=False)
            if gr["success_rate"] > best_sr:  # checkpoint only when a new best appears
                best_sr = gr["success_rate"]
                best_ep = ep
                save_checkpoint(g, {"episode": ep, "greedy_sr": best_sr})
            curve.append({
                "episode": ep,
                "greedy_sr": gr["success_rate"],
                "sample_sr": sr["success_rate"],
                "avg_path_len": gr["avg_path_len"],
                "entropy": g.route_entropy(),
                "alive_nodes": sum(1 for n in g.nodes.values() if n.alive),
                "edges": g.edge_count(),
            })
            print(f"[ep {ep}] greedy_sr={gr['success_rate']:.2f} sample_sr={sr['success_rate']:.2f} "
                  f"path_len={gr['avg_path_len']} entropy={g.route_entropy():.3f}")

    with open(os.path.join(OUT, "curves.json"), "w", encoding="utf-8") as f:
        json.dump(curve, f, ensure_ascii=False, indent=1)
    sk = skeleton(g, ts)
    with open(os.path.join(OUT, "final.json"), "w", encoding="utf-8") as f:
        json.dump({"snapshot": g.snapshot(), "skeleton": sk, "optimals": OPTIMAL,
                   "curve": curve}, f, ensure_ascii=False, indent=1)

    print()
    print(report_final(g, ts))
    print()
    print(black_box_demo(g, ts))
    print()
    print(f"best checkpoint: episode={best_ep} greedy_sr={best_sr:.2f} "
          f"(stored at {os.path.join(OUT, 'checkpoint_best.json')})")
    print(f"evolution audit log: {evo_log} "
          f"({sum(1 for _ in open(evo_log, encoding='utf-8'))} events)")
    print(f"results written to {OUT}")


if __name__ == "__main__":
    main()

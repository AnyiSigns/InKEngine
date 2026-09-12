"""Quick check: can SEMANTIC routing (qwen embedding feature) learn the toy domain?

Fixed 6-task pool (one payload per kind) so the state set is finite and all
embeddings hit the cache. Trains two identical graphs for 200 episodes:
  - type graph: hand-written discrete feature (baseline, known to converge)
  - embed graph: 1024-dim qwen3.7-text-embedding-flash semantic feature
Answer it gives: is 1024-dim semantic observation enough for the router?

  $env:LLM_EMBED_KEY="sk-..."
  python experiment/GraphLab/demos/quick_embed.py
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

from embedding import embed_state
from env import TaskSpace, initial_state, reward
from graph_engine import GraphEngine
from nodes import OPTIMAL, build_node_pool, feature
from credit import CreditAssigner


CREDIT = CreditAssigner()

FIXED_TASKS = [
    {"kind": "add", "payload": (3, 5)},
    {"kind": "add_double", "payload": (4, 6)},
    {"kind": "double_direct", "payload": 9},
    {"kind": "upper", "payload": "abcde"},
    {"kind": "upper_reverse", "payload": "xyz"},
    {"kind": "concat", "payload": ("ab", "cd")},
]
for t in FIXED_TASKS:
    t["expected"] = TaskSpace._expected(t["kind"], t["payload"])


def build(seed: int, feature_fn) -> GraphEngine:
    g = GraphEngine(seed=seed, feature_fn=feature_fn)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", lambda s: {**s, "ok": s.get("payload") == s.get("expected")}, kind="exit")
    for nid, (func, kind) in build_node_pool(llm=False).items():
        g.add_node(nid, func, kind)
    g.randomize(p=0.25)
    return g


def train(g: GraphEngine, episodes: int, seed: int) -> float:
    rng = random.Random(seed)
    for ep in range(1, episodes + 1):
        task = dict(rng.choice(FIXED_TASKS))
        eps = max(0.05, 0.7 * (1.0 - ep / episodes))
        paths = g.forward(initial_state(task), beam=8, max_steps=10, eps=eps)
        g.collect_stats(paths)
        CREDIT.train(g, paths, [reward(p, g) for p in paths])
    ok = 0
    for task in FIXED_TASKS:
        best = max(g.forward(initial_state(task), beam=8, max_steps=10, greedy=False),
                   key=lambda p: (p.ok, -len(p.nodes)))
        ok += 1 if best.ok else 0
    return ok / len(FIXED_TASKS)


def main():
    episodes = int(os.environ.get("QUICK_EPISODES", "200"))
    g_type = build(0, feature)
    g_emb = build(0, embed_state)
    sr_type = train(g_type, episodes, 0)
    sr_emb = train(g_emb, episodes, 0)
    print(f"episodes={episodes} | type-feature sr={sr_type:.2f} | "
          f"embedding-feature sr={sr_emb:.2f}")
    print("conclusion:", "1024-dim semantic observation is sufficient" if
          sr_emb >= 0.8 else "semantic routing not converged yet")


if __name__ == "__main__":
    main()

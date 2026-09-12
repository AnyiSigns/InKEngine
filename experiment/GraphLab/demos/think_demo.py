"""Think-and-act demo: every task = one think (internal simulation) + one act
(finetune). Verifies that a graph can "think" before acting, and that every
completed task is a finetune step on the SAME persistent graph.

Analogy:
  - think   = LLM reasoning / test-time compute: N internal rollout simulations,
              pick the best path, then execute it (user sees input -> output)
  - finetune = online update after each task (REINFORCE + replay + contrastive),
              small-step, never rebuilding the graph
  - no-think = act greedily without internal simulation (plain greedy route)

The demo trains two identical messy graphs in parallel on the same task stream:
one with thinking, one without. User-visible success is measured in sliding
windows; policy quality is evaluated on fresh tasks every 100 tasks.

  python experiment/GraphLab/demos/think_demo.py [--tasks 1200] [--sims 48] [--seed 0]
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from env import TaskSpace, initial_state, reward
from main import OUT, build_messy_graph, evaluate
from credit import CreditAssigner



CREDIT = CreditAssigner()

def think(graph, task, sims: int, max_steps: int = 10):
    """Internal simulation: sample `sims` rollouts, return the best one to act on."""
    paths = graph.forward(initial_state(task), beam=sims, max_steps=max_steps, greedy=False)
    return max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))


def act(graph, task, greedy: bool):
    """Execute one path (greedy = no thinking; think mode uses the simulated best)."""
    if greedy:
        paths = graph.forward(initial_state(task), beam=1, max_steps=10, greedy=True)
        return max(paths, key=lambda p: (p.ok, -len(p.nodes)))
    return think(graph, task, sims=16)  # 非贪心 = 有限模拟后执行最优（不可为 0，beam>=1）


def run(tasks: int, sims: int, seed: int) -> dict:
    """FAIR comparison: both graphs do the SAME beam=sims rollouts every task.
    The only difference is WHICH path gets trained:
      - think: the BEST simulated path (by ok, then shortest, then logprob)
      - plain: a path drawn uniformly from the same rollouts (no selection bias)
    So the gap measures "selection for training" (thinking), not sample size.
    """
    g_plain = build_messy_graph(seed)
    g_think = build_messy_graph(seed)
    ts = TaskSpace(seed=seed)
    W = 100  # sliding window for user-visible success

    plain_win = []
    think_win = []
    curve = []
    rng = random.Random(seed)
    for ep in range(1, tasks + 1):
        task = ts.sample()
        # both graphs sample the SAME number of rollouts
        s1 = initial_state(task)
        paths_plain = g_plain.forward(s1, beam=sims, max_steps=10, greedy=False)
        paths_think = g_think.forward(initial_state(task), beam=sims, max_steps=10, greedy=False)
        g_plain.collect_stats(paths_plain)
        g_think.collect_stats(paths_think)
        # plain: uniform random pick (no selection); think: pick best
        p1 = rng.choice(paths_plain)
        p2 = max(paths_think, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
        plain_win.append(1 if p1.ok else 0)
        think_win.append(1 if p2.ok else 0)
        CREDIT.train(g_plain, [p1], [reward(p1, g_plain)])
        CREDIT.train(g_think, [p2], [reward(p2, g_think)])

        if ep % W == 0:
            ev_plain = evaluate(g_plain, ts, greedy=True)
            ev_think = evaluate(g_think, ts, greedy=True)
            curve.append({
                "task": ep,
                "plain_online": round(sum(plain_win[-W:]) / W, 3),
                "think_online": round(sum(think_win[-W:]) / W, 3),
                "plain_policy": ev_plain["success_rate"],
                "think_policy": ev_think["success_rate"],
            })
    return {"curve": curve, "sims": sims, "seed": seed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", type=int, default=1200)
    ap.add_argument("--sims", type=int, default=48)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    result = run(args.tasks, args.sims, args.seed)
    with open(os.path.join(OUT, "think_curve.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    print(f"think demo: tasks={args.tasks} sims={args.sims} seed={args.seed}")
    print(f"{'task':>6} {'plain_online':>13} {'think_online':>13} {'plain_policy':>13} {'think_policy':>13}")
    for row in result["curve"]:
        print(f"{row['task']:>6} {row['plain_online']:>13.2f} {row['think_online']:>13.2f} "
              f"{row['plain_policy']:>13.2f} {row['think_policy']:>13.2f}")
    last = result["curve"][-1]
    print(f"\nfinal: plain_policy={last['plain_policy']:.2f} think_policy={last['think_policy']:.2f}")
    print(f"stored at {os.path.join(OUT, 'think_curve.json')}")


if __name__ == "__main__":
    main()

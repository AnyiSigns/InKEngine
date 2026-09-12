"""执行层 GraphEngine：组合 GraphStore + Router + ContractGate + ExitGate。

forward/rollout = 原 graph_lab/graph.py Graph.forward 逐行搬入：beam 独立 rollout、
选边委托 Router、契约查闸委托 ContractGate、验收弹回判定委托 ExitGate。
rng 消耗顺序、浮点运算次序与原实现逐位一致；纯函数式（统计只在显式
collect_stats 落账）。
"""

from __future__ import annotations

import os
import sys
from copy import deepcopy

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()

from contract_gate import ContractGate  # noqa: E402
from exit_gate import ExitGate  # noqa: E402
from router import Router  # noqa: E402
from store import GraphStore  # noqa: E402


class GraphEngine:
    """Analogy to LLMs:
      - node = operator (functional transform), the "neuron"
      - edge weights = routing logits (global approx + per-input-feature conditional
        weights, the analogue of attention)
      - forward = one inference pass: state enters at entry node, transforms node by
        node; exit is an "acceptance gate" - if verification fails, the state is
        bounced back into the graph for more transforms (multi-layer iterative
        coordination) until expected is satisfied or steps run out
      - not differentiable; training signal comes from discrete credit assignment
        (see learning/credit.py)
    """

    def __init__(self, entry: str = "entry", exit: str = "exit", seed: int = 0,
                 feature_fn=None, store: GraphStore | None = None,
                 router: Router | None = None,
                 contract_gate: ContractGate | None = None,
                 exit_gate: ExitGate | None = None):
        """feature_fn: (state) -> str|None. When set, routing uses conditional weights."""
        self.store = store if store is not None else GraphStore(
            entry=entry, exit=exit, seed=seed)
        self.router = router if router is not None else Router()
        self.contract_gate = contract_gate if contract_gate is not None else ContractGate()
        self.exit_gate = exit_gate if exit_gate is not None else ExitGate()
        self.feature_fn = feature_fn

    # ---------------- store facade（构造/计数/度量委派给 topology） ----------------
    @property
    def nodes(self):
        return self.store.nodes

    @property
    def out(self):
        return self.store.out

    @property
    def entry(self):
        return self.store.entry

    @property
    def exit(self):
        return self.store.exit

    @property
    def rng(self):
        return self.store.rng

    def add_node(self, nid: str, func, kind: str = "function",
                 contract=None) -> None:
        self.store.add_node(nid, func, kind=kind, contract=contract)

    def add_edge(self, src: str, dst: str, logit: float = 0.0):
        return self.store.add_edge(src, dst, logit=logit)

    def randomize(self, p: float = 0.25, lo: float = -1.0, hi: float = 1.0) -> None:
        self.store.randomize(p=p, lo=lo, hi=hi)

    def collect_stats(self, paths: list) -> None:
        self.store.collect_stats(paths)

    def edge_count(self) -> int:
        return self.store.edge_count()

    def mean_out_degree(self) -> float:
        return self.store.mean_out_degree()

    def route_entropy(self) -> float:
        return self.router.route_entropy(self.store)

    def snapshot(self) -> dict:
        return {
            "nodes": len(self.store.nodes),
            "alive": sum(1 for n in self.store.nodes.values() if n.alive),
            "edges": self.edge_count(),
            "entropy": round(self.route_entropy(), 3),
        }

    def to_dict(self) -> dict:
        return self.store.to_dict()

    @classmethod
    def from_dict(cls, data: dict, pool: dict, feature_fn=None,
                  entry_fn=None, exit_fn=None) -> "GraphEngine":
        """Rebuild engine from snapshot. pool: {nid: (func, kind)} covering all nodes.

        entry_fn/exit_fn override the default built-ins (payload==expected check);
        pass the real acceptance semantics of the domain so a restored graph
        verifies exactly like the original (checkpoint semantic replay).
        """
        store = GraphStore.from_dict(data, pool, entry_fn=entry_fn, exit_fn=exit_fn)
        return cls(store=store, feature_fn=feature_fn)

    # ---------------- forward pass (conditional dynamic routing) ----------------
    def forward(self, state: dict, beam: int = 6, max_steps: int = 10,
                greedy: bool = False, eps: float = 0.0) -> list:
        """Beam independent rollouts from entry. PURE: no stats side effects.

        Edge selection:
          - greedy=True : argmax (deployment view)
          - eps>0       : epsilon-greedy, argmax with prob 1-eps, uniform with prob eps
          - default     : softmax sampling (exploration)
        exit is an acceptance gate: ok -> stop; not ok -> do NOT stop, route out of
        exit and keep transforming until expected is met or steps run out.
        state must contain "payload" and "expected".
        Usage statistics are collected separately via collect_stats(paths) so
        inference/evals never pollute training stats.
        """
        from store import Path  # noqa: PLC0415  (局部引用：Path 与 forward 返回类型同源)
        paths: list[Path] = []
        for _ in range(beam):
            s = deepcopy(state)
            nodes_seen = [self.store.entry]
            edges_seen: list = []
            feats_seen: list = []
            lp = 0.0
            cur = self.store.entry
            ok = False
            dead = False
            for _step in range(max_steps):
                outs = [e for e in self.store.out[cur] if self.store.nodes[e.dst].alive
                        and not self.contract_gate.statically_dead(
                            self.store, self.store.nodes[e.dst], s)
                        and not (e.dst == self.store.entry and cur != self.store.entry)]  # entry 禁入（拓扑不变量）
                if not outs:
                    dead = True
                    break
                feat = self.feature_fn(s) if self.feature_fn else None
                logits = self.router.logits(self.store.nodes, outs, feat)
                # 契约查闸在选边之后、执行之前：坏边先入路径（见下方 append），
                # 让负信号命中"路由选错了"的那条边。
                e, d_lp = self.router.choose(self.store.rng, outs, logits, greedy, eps)
                lp += d_lp
                # 坏边先入路径，让负信号命中"路由选错了"的那条边。
                edges_seen.append(e)
                feats_seen.append(feat)
                if self.store.nodes[e.dst].contract and \
                        not self.contract_gate.ok(self.store.nodes[e.dst].contract, s):
                    dead = True
                    break
                s = self.store.nodes[e.dst].func(s)
                if s is None:
                    dead = True
                    break
                nodes_seen.append(e.dst)
                if e.dst == self.store.exit:
                    if self.exit_gate.passed(s):
                        ok = True
                        break
                    # gate not passed: keep going from exit's own out-edges
                cur = e.dst
            paths.append(Path(nodes=nodes_seen, edges=edges_seen, feats=feats_seen,
                              logprob=lp, ok=ok, dead=dead, state=s))
        return paths

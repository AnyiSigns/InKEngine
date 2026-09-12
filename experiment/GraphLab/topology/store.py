"""拓扑层 GraphStore：节点 + 边 + 权重存储（logit/cond/proto/bias）、契约声明、
使用计数与 JSON 快照——纯数据结构，零策略。

自 graph_lab/graph.py 逐行拆出；edge-selection/forward 在 engine 层（GraphEngine），
路由策略在 policy 层（Router）。与原实现语义零差异。
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field


@dataclass
class Contract:
    """节点契约（typed-state 声明）：requires = 前置条件，provides = 唯一产物字段。

    requires: {字段: 可满足该字段的键集合 K}（存在性/析取，键 = state 键名）
      - K 为空元组 ()：要求该键存在于 state 且非 None（存在性）
      - K 非空：K 中任一键存在且非 None 即可（析取，如 save_file 接受任意内容字段）
      - 兼容旧语义：若 K 中键本身在 state 有值，则按值约束判定（旧 task 族用法）
    when: {字段: 值域 V}（值约束，字段 = state 键名）
      - 字段存在：值必须在 V 中（如 family="code" 才能用 code 节点）
      - 字段不存在：视为可满足（可由 provider 后续产出）；静态死路仅当
        **没有任何存活节点 provides 该字段**时判定
    provides: 该节点成功时写入的唯一 state 字段（验收通道据此收口——
               错误生产者无法喂饱验收，见 hard_demo.accept）

    引擎在调用节点函数前查契约：不满足 = 零代价死路（不执行函数、不调 LLM）。
    查闸逻辑在 policy/contract_gate.ContractGate（独立于路由）。
    """

    requires: dict[str, tuple[str, ...]] = field(default_factory=dict)
    when: dict[str, tuple[str, ...]] = field(default_factory=dict)
    provides: str | None = None

    def to_dict(self) -> dict | None:
        return {"requires": {k: list(v) for k, v in self.requires.items()},
                "when": {k: list(v) for k, v in self.when.items()},
                "provides": self.provides}

    @classmethod
    def from_dict(cls, d: dict) -> "Contract | None":
        if not d:
            return None
        return cls(requires={k: tuple(v) for k, v in d.get("requires", {}).items()},
                   when={k: tuple(v) for k, v in d.get("when", {}).items()},
                   provides=d.get("provides"))


@dataclass
class Node:
    id: str
    func: object  # (state: dict) -> dict | None; None = node refuses current state (dead end)
    kind: str = "function"  # entry | exit | function | llm | noise | fake | pass | tool
    alive: bool = True
    uses: int = 0
    success_uses: int = 0
    bias: float = 0.0  # extra routing preference (e.g. LLM quality signal), set by upper layers
    contract: Contract | None = None  # 引擎查闸的 typed-state 契约；None = 无契约（v1 行为）


@dataclass
class Edge:
    src: str
    dst: str
    logit: float = 0.0  # global weight (cross-feature approx, used by evolution pruning)
    cond: dict = field(default_factory=dict)  # conditional weight: feature -> logit (attention)
    proto: tuple = None  # semantic prototype vector for embedding routing (cosine)
    uses: int = 0
    success_uses: int = 0

    def __post_init__(self):
        if self.cond is None:
            self.cond = {}
        if self.proto is None:
            self.proto = ()


@dataclass
class Path:
    nodes: list[str]
    edges: list[Edge]
    feats: list  # input features per step (the observation of conditional routing)
    logprob: float
    ok: bool
    dead: bool  # True = dead end / step limit; False = reached exit gate (ok = passed)
    state: dict = None  # terminal state (for black-box output display)


class GraphStore:
    def __init__(self, entry: str = "entry", exit: str = "exit", seed: int = 0):
        self.nodes: dict[str, Node] = {}
        self.out: dict[str, list[Edge]] = {}
        self.entry = entry
        self.exit = exit
        self.rng = random.Random(seed)

    # ---------------- construction ----------------
    def add_node(self, nid: str, func, kind: str = "function",
                 contract: Contract | None = None) -> None:
        self.nodes[nid] = Node(id=nid, func=func, kind=kind, contract=contract)
        self.out.setdefault(nid, [])

    def add_edge(self, src: str, dst: str, logit: float = 0.0) -> Edge:
        e = Edge(src=src, dst=dst, logit=logit)
        self.out[src].append(e)
        return e

    def randomize(self, p: float = 0.25, lo: float = -1.0, hi: float = 1.0) -> None:
        """Messy init: random edges between any node pair with random logits.

        entry connects to all, all connect to exit, exit connects back to all
        (bounce-back path for the acceptance gate); everything else is random.
        The initial graph is dense, order-free, and contains noise/fake nodes:
        the "messy graph".
        """
        nids = list(self.nodes)
        for src in nids:
            for dst in nids:
                if src == dst:
                    continue
                if self.rng.random() < p:
                    self.add_edge(src, dst, self.rng.uniform(lo, hi))
        for dst in nids:
            if dst != self.entry and not any(e.dst == dst for e in self.out[self.entry]):
                self.add_edge(self.entry, dst, self.rng.uniform(lo, hi))
        for src in nids:
            if src != self.exit and not any(e.dst == self.exit for e in self.out[src]):
                self.add_edge(src, self.exit, self.rng.uniform(lo, hi))
        for dst in nids:
            if dst != self.exit and not any(e.dst == dst for e in self.out[self.exit]):
                self.add_edge(self.exit, dst, self.rng.uniform(lo, hi))

    # ---------------- usage counters ----------------
    def collect_stats(self, paths: list[Path]) -> None:
        """Accumulate usage/success stats from rollouts (training only, explicit)."""
        for p in paths:
            seen = set()
            for e in p.edges:
                e.uses += 1
                if p.ok and e.dst not in seen:
                    e.success_uses += 1
                if e.dst not in seen:
                    seen.add(e.dst)
            for nid in p.nodes:
                n = self.nodes[nid]
                n.uses += 1
                if p.ok and nid != self.exit:
                    n.success_uses += 1

    # ---------------- metrics ----------------
    def edge_count(self) -> int:
        return sum(len(v) for v in self.out.values())

    def mean_out_degree(self) -> float:
        alive = [n for n in self.nodes if self.nodes[n].alive]
        return sum(len(self.out[n]) for n in alive) / max(1, len(alive))

    # ---------------- persistence (checkpoint / audit) ----------------
    def to_dict(self) -> dict:
        """Serialize whole graph: node kinds + edge weights (global + conditional)."""
        return {
            "entry": self.entry,
            "exit": self.exit,
            "nodes": {nid: {"kind": n.kind, "alive": n.alive,
                            "contract": n.contract.to_dict() if n.contract else None}
                      for nid, n in self.nodes.items()},
            "edges": [
                {"src": e.src, "dst": e.dst, "logit": e.logit, "cond": dict(e.cond),
                 "proto": list(e.proto) if e.proto else []}
                for edges in self.out.values() for e in edges
            ],
        }

    @classmethod
    def from_dict(cls, data: dict, pool: dict, entry_fn=None,
                  exit_fn=None) -> "GraphStore":
        """Rebuild store from snapshot. pool: {nid: (func, kind)} covering all nodes.

        entry_fn/exit_fn override the default built-ins (payload==expected check);
        pass the real acceptance semantics of the domain so a restored store
        verifies exactly like the original (checkpoint semantic replay).
        """
        g = cls(entry=data["entry"], exit=data["exit"], seed=0)
        g.add_node(data["entry"], entry_fn or (lambda s: dict(s)), kind="entry")
        g.add_node(data["exit"],
                   exit_fn or (lambda s: {**s, "ok": s.get("payload") == s.get("expected")}),
                   kind="exit")
        for nid, meta in data["nodes"].items():
            if nid in (data["entry"], data["exit"]):
                continue
            func, kind = pool[nid]
            g.add_node(nid, func, kind)
            g.nodes[nid].alive = meta["alive"]
            g.nodes[nid].bias = meta.get("bias", 0.0)
            g.nodes[nid].contract = Contract.from_dict(meta.get("contract"))
        for e in data["edges"]:
            edge = g.add_edge(e["src"], e["dst"], e["logit"])
            edge.cond = dict(e.get("cond", {}))
            if e.get("proto"):
                edge.proto = tuple(e["proto"])
        return g

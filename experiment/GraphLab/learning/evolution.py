"""学习层 Evolution：结构演化（剪边 / 生长 / 变异）+ 演化窗口计数复位。

自 graph_lab/trainer.py 的 evolve / reset_usage 逐行搬入，语义零改动。
Goal: random initial routing (the "assembly = randomness" pain point) converges
into deterministic, reliable paths through training; structure is not fixed
(finetuning can add nodes, e.g. new LLM nodes) -- one training run trains ONE
persistent graph, never rebuilt (no "assembly").
"""

from __future__ import annotations


class Evolution:
    def evolve(self, graph, min_logit: float = -4.0, new_node_maker=None,
               grow_prob: float = 0.7, max_new: int = 2,
               conservative: bool = False) -> list[str]:
        """Structure evolution: prune redundant/harmful edges, discard dead nodes,
        randomly add new edges, and GROW new nodes (structural growth: the graph is
        not fixed -- finetuning can add nodes, e.g. new LLM nodes).
        new_node_maker(graph) -> (nid, func, kind). Returns event strings.

        conservative=True: only prune edges that were WALKED in the window and are
        strongly negative with zero success contribution -- production-safe when
        rounds are few (sparse window stats must not destroy unexplored edges).
        """
        events: list[str] = []

        # 1) prune edges: only edges that are BOTH never walked AND non-positive are
        #    pruned as redundant (protects unexplored positive-prior edges); edges
        #    walked but never successful with strongly negative weight are harmful.
        #    conservative=True: do not prune never-walked edges at all.
        for src in list(graph.out):
            for e in list(graph.out[src]):
                if not conservative and e.uses == 0 and e.logit < 0:
                    graph.out[src].remove(e)
                    events.append(f"prune redundant {e.src}->{e.dst}")
                elif e.uses > 0 and e.success_uses == 0 and e.logit < min_logit:
                    graph.out[src].remove(e)
                    events.append(f"prune harmful {e.src}->{e.dst}")

        # 2) discard nodes: interference kinds (noise/fake/pass) with zero success
        #    contribution in the window
        for nid, n in list(graph.nodes.items()):
            if n.alive and n.kind in ("noise", "fake", "pass") and n.success_uses == 0:
                n.alive = False
                graph.out[nid].clear()
                for src in list(graph.out):
                    graph.out[src] = [e for e in graph.out[src] if e.dst != nid]
                events.append(f"discard node {nid}({n.kind})")

        # 3) exploration: add new random edges between alive nodes
        alive = [nid for nid, n in graph.nodes.items() if n.alive and nid not in (graph.entry, graph.exit)]
        added = 0
        for _ in range(20):
            if added >= 5 or len(alive) < 2:
                break
            a, b = graph.rng.choice(alive), graph.rng.choice(alive)
            if a == b or any(e.dst == b for e in graph.out[a]):
                continue
            graph.add_edge(a, b, 0.0)
            added += 1
            events.append(f"new edge {a}->{b}")

        # 4) growth: create new nodes (structural growth, e.g. new LLM nodes)
        if new_node_maker:
            for _ in range(max_new):
                if len(alive) < 3 or graph.rng.random() >= grow_prob:
                    continue
                nid, func, kind = new_node_maker(graph)
                graph.add_node(nid, func, kind,
                               contract=getattr(func, "contract", None))
                alive.append(nid)
                for _ in range(2):  # 2 random in-edges + 2 random out-edges
                    src = graph.rng.choice(alive)
                    if src != nid and not any(e.dst == nid for e in graph.out[src]):
                        graph.add_edge(src, nid, 0.0)
                for _ in range(2):
                    dst = graph.rng.choice(alive)
                    if dst != nid and dst != graph.entry and not any(
                            e.dst == dst for e in graph.out[nid]):
                        graph.add_edge(nid, dst, 0.0)
                events.append(f"grow node {nid}({kind})")
        return events

    @staticmethod
    def reset_usage(graph):
        """演化窗口计数复位（原 trainer.reset_usage）。"""
        for n in graph.nodes.values():
            n.uses = n.success_uses = 0
        for edges in graph.out.values():
            for e in edges:
                e.uses = e.success_uses = 0

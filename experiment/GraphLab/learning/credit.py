"""学习层 CreditAssigner：REINFORCE（正负不对称）+ 同源边对比学习，回放可插拔。

自 graph_lab/trainer.train_step 逐行拆出：批次归一化与成功回放委托 ReplayBuffer，
本模块保留逐路径的强化 + 对比两段。更新次序与原实现逐位一致。

LLM analogy:
  - REINFORCE = non-differentiable counterpart of backprop: adjust "connection
    strengths" (edge logits) by reward
  - weight layering: e.cond[feat] conditional weights (attention, activated by
    input feature); e.logit global approximation (for evolution pruning)
  - success replay = direct reinforcement of successful paths (fixes sparse
    positive signal drowned by 5x more negative signals)
"""

from __future__ import annotations

from replay import ReplayBuffer, clamp  # noqa: F401  (clamp 供上层复用)

LR = 0.25          # edge logit learning rate
NEG_FACTOR = 0.25  # slow down negative signals (positive signals are sparse)
NEG_LR = 0.05      # contrastive learning coefficient for sibling out-edges


class CreditAssigner:
    def __init__(self, replay: ReplayBuffer | None = None):
        self.replay = replay if replay is not None else ReplayBuffer()

    @staticmethod
    def assign(graph, p, delta):
        """单条路径：REINFORCE + 同源出边对比。"""
        lr = LR if delta > 0 else LR * NEG_FACTOR
        for e, f in zip(p.edges, p.feats):
            if isinstance(f, str):  # 离散特征：按特征分裂的条件权重（语义 embedding 不写 cond）
                e.cond[f] = clamp(e.cond.get(f, e.logit) + lr * delta)
            e.logit = clamp(e.logit + lr * delta * 0.5)
        for e, f in zip(p.edges, p.feats):
            for e2 in graph.out[e.src]:
                if e2 is e:
                    continue
                if isinstance(f, str):
                    e2.cond[f] = clamp(e2.cond.get(f, e2.logit) - lr * delta * NEG_LR)
                e2.logit = clamp(e2.logit - lr * delta * NEG_LR * 0.5)

    def train(self, graph, paths, rewards) -> float:
        """One update: REINFORCE (asymmetric +/-) + contrastive learning + replay.

        Replay is scaled by normalized delta (delta / max_positive_delta of the batch):
        the SHORTEST successful paths get full replay, longer detours get proportionally
        less, so suboptimal attractors lose even if they are sampled more often.
        """
        baseline, deltas, max_delta = self.replay.batch_norm(rewards)
        for p, delta in zip(paths, deltas):
            if abs(delta) < 1e-9:
                continue
            self.assign(graph, p, delta)
            if p.ok and delta > 0:
                scale = delta / max_delta
                self.replay.reinforce(p, scale)
        return baseline

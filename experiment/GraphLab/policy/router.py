"""策略层 Router：边选择策略（原实现 = greedy / eps-greedy / softmax 采样；
MCTS/beam 搜索为扩展位，原代码没有即不发明）。

自 graph.py Graph.forward 的路由内联逻辑逐行拆出：logits 计算、选边、
softmax、余弦、路由熵。rng 消耗顺序与原实现逐位一致。
"""

from __future__ import annotations

import math

SEMANTIC_W = 2.0  # embedding 路由的余弦相似度权重（与 logit 相加）


class Router:
    def logits(self, nodes: dict, outs: list, feat) -> list[float]:
        """出边打分：语义 embedding 走原型向量余弦，离散特征走条件权重。"""
        if feat is not None and isinstance(feat, tuple) and feat and \
                isinstance(feat[0], float):
            # 语义路由：边原型向量 + 余弦相似度（观察是连续 embedding）
            return [e.logit + nodes[e.dst].bias
                    + SEMANTIC_W * self.cosine(feat, e.proto)
                    for e in outs]
        # 离散特征路由：按特征分裂的条件权重
        return [e.logit + nodes[e.dst].bias if not feat
                else e.cond.get(feat, e.logit) + nodes[e.dst].bias
                for e in outs]

    def choose(self, rng, outs: list, logits: list[float],
               greedy: bool, eps: float):
        """在候选出边中选一条，返回 (edge, logprob 增量)。

        - greedy=True : argmax (deployment view)
        - eps>0       : epsilon-greedy, argmax with prob 1-eps, uniform with prob eps
        - default     : softmax sampling (exploration)
        """
        if greedy or (eps > 0.0 and rng.random() >= eps):
            return max(zip(outs, logits), key=lambda t: t[1])[0], 0.0
        elif eps > 0.0:
            return rng.choice(outs), 0.0
        probs = self._softmax(logits)
        idx = rng.choices(range(len(outs)), weights=probs)[0]
        return outs[idx], math.log(probs[idx])

    @staticmethod
    def _softmax(x: list[float]) -> list[float]:
        m = max(x)
        ex = [math.exp(v - m) for v in x]
        s = sum(ex)
        return [v / s for v in ex]

    @staticmethod
    def cosine(a: tuple, b: tuple) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        na = sum(x * x for x in a) ** 0.5
        nb = sum(x * x for x in b) ** 0.5
        if na == 0 or nb == 0:
            return 0.0
        return dot / (na * nb)

    @staticmethod
    def route_entropy(store) -> float:
        """Mean softmax entropy over out-edge logits -- routing uncertainty."""
        total, cnt = 0.0, 0
        for nid, edges in store.out.items():
            if not edges or nid == store.exit:
                continue
            ps = Router._softmax([e.logit for e in edges])
            total -= sum(p * math.log(p) for p in ps)
            cnt += 1
        return total / max(1, cnt)

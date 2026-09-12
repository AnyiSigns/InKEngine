"""学习层 ReplayBuffer：批次归一化 + 成功路径回放（pluggable）+ clamp。

自 graph_lab/trainer.py 逐行搬入（train_step 的 batch 归一化前段与回放段）；
更新次序与 trainer.train_step 完全一致。
"""

from __future__ import annotations

REPLAY_LR = 0.9    # success path replay strength
PROTO_LR = 0.05     # 语义路由：边原型向量朝成功路径状态的移动系数


def clamp(x: float, lo: float = -8.0, hi: float = 8.0) -> float:
    return max(lo, min(hi, x))


def _move_proto(proto: tuple, emb: tuple, lr: float) -> tuple:
    """proto <- proto + lr*emb（归一化到单位向量）。proto 为空时初始化为 emb。"""
    if not emb:
        return proto
    if not proto or len(proto) != len(emb):
        return emb
    moved = tuple(p + lr * x for p, x in zip(proto, emb))
    n = sum(x * x for x in moved) ** 0.5
    if n == 0:
        return proto
    return tuple(x / n for x in moved)


class ReplayBuffer:
    @staticmethod
    def batch_norm(rewards):
        """批次基线与归一化尺度（train_step 开头 4 行）。"""
        baseline = 0.0 if len(rewards) == 1 else sum(rewards) / len(rewards)
        deltas = [r - baseline for r in rewards]
        pos = [d for d in deltas if d > 0]
        max_delta = max(pos) if pos else 1.0
        return baseline, deltas, max_delta

    @staticmethod
    def reinforce(p, scale):
        """成功路径直接回放（按批次归一化 delta 缩放，最短路径拿满）。"""
        for e, f in zip(p.edges, p.feats):
            if f is not None:
                e.cond[f] = clamp(e.cond.get(f, e.logit) + REPLAY_LR * scale)
            e.logit = clamp(e.logit + REPLAY_LR * scale * 0.5)
            if isinstance(f, tuple) and f:  # 语义特征：原型向量朝成功状态移动
                e.proto = _move_proto(e.proto, f, PROTO_LR * scale)

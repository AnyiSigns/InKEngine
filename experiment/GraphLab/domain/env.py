"""任务空间与奖励：6 类任务，自动判定成败。"""

from __future__ import annotations

import random

from nodes import OPTIMAL


class TaskSpace:
    def __init__(self, seed: int = 0):
        self.rng = random.Random(seed)
        self.kinds = list(OPTIMAL)

    def sample(self) -> dict:
        kind = self.rng.choice(self.kinds)
        return self._make(kind)

    def _make(self, kind: str) -> dict:
        if kind in ("add", "add_double"):
            payload = (self.rng.randint(1, 99), self.rng.randint(1, 99))
        elif kind == "double_direct":
            payload = self.rng.randint(1, 99)
        elif kind in ("upper", "upper_reverse"):
            payload = "".join(self.rng.choice("abcdefgh") for _ in range(self.rng.randint(3, 8)))
        else:  # concat
            payload = (
                "".join(self.rng.choice("xyz") for _ in range(self.rng.randint(2, 4))),
                "".join(self.rng.choice("xyz") for _ in range(self.rng.randint(2, 4))),
            )
        return {"kind": kind, "payload": payload, "expected": self._expected(kind, payload)}

    @staticmethod
    def _expected(kind: str, payload) -> object:
        if kind == "add":
            return payload[0] + payload[1]
        if kind == "add_double":
            return (payload[0] + payload[1]) * 2
        if kind == "double_direct":
            return payload * 2
        if kind == "upper":
            return payload.upper()
        if kind == "upper_reverse":
            return payload.upper()[::-1]
        return payload[0] + payload[1]

    @staticmethod
    def opt_len(kind: str) -> int:
        return len(OPTIMAL[kind]) - 2  # 不算 entry/exit 的算子数


def initial_state(task: dict) -> dict:
    return {"payload": task["payload"], "expected": task["expected"]}


def reward(path, graph) -> float:
    """路径奖励：成功 +10 - 每步 1.0；死路/失败 -2；噪声/伪装 -3；中性 -2。"""
    r = 10.0 - 1.0 * (len(path.nodes) - 1) if path.ok else -2.0
    for nid in path.nodes:
        kind = graph.nodes[nid].kind
        if kind in ("noise", "fake"):
            r -= 3.0
        elif kind == "pass":
            r -= 2.0
    return r

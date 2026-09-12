"""学习层 SkillLibrary：情景式技能宏（一次验证成功轨迹 -> 带 typed 锚点的 recipe）。

从 agent_demo2 的 B1 实现泛化拆出（agent_demo2 保留自有副本，行为不变）：
  命中 = 族一致（typed 硬闸）且锚点余弦 >= 阈值（检索护栏，相似≠可用）
  命中后 top-1 执行路径；验收不过 = 弃权回退探索
  连续 2 次验收失败 = 技能腐烂 -> 移除（漂移护栏）
  同族保留调用数更少的一条（更省即更优）
"""

from __future__ import annotations

import time


def cosine(a: tuple, b: tuple) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class SkillMacro:
    def __init__(self, family: str, path: list[str], anchor: tuple,
                 calls: int, round_: int):
        self.family = family
        self.path = list(path)
        self.anchor = anchor
        self.calls = calls
        self.round = round_
        self.hits = 0
        self.ok = 0
        self.fails = 0  # 连续验收失败（漂移信号）

    def to_dict(self) -> dict:
        return {"family": self.family, "path": self.path, "calls": self.calls,
                "round": self.round, "hits": self.hits, "ok": self.ok,
                "anchor": list(self.anchor) if self.anchor else []}


class MacroLibrary:
    def __init__(self, threshold: float = 0.6, log_fn=None):
        self.macros: dict[str, SkillMacro] = {}
        self.threshold = threshold
        self.log_fn = log_fn

    def match(self, family: str, anchor: tuple) -> SkillMacro | None:
        m = self.macros.get(family)
        if m is None:
            return None
        if cosine(anchor, m.anchor) >= self.threshold:
            return m
        return None  # 检索相似度不足：弃权（宁可探索，不盲目复用）

    def add_or_replace(self, macro: SkillMacro) -> bool:
        cur = self.macros.get(macro.family)
        if cur is None or macro.calls < cur.calls:
            self.macros[macro.family] = macro
            return True
        return False

    def note_fail(self, macro: SkillMacro) -> None:
        macro.fails += 1
        if macro.fails >= 2:
            self.macros.pop(macro.family, None)
            if self.log_fn:
                self.log_fn({"event": "skill_drop", "family": macro.family,
                             "fails": macro.fails, "ts": round(time.time(), 3)})

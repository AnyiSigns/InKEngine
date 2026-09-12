"""策略层 ExitGate：验收弹回逻辑。

exit 是验收门：通过 = 终止；不通过 = 不终止，继续沿 exit 出边弹回图内变换
（原 graph.py forward 中的内联判定，逐行搬入）。验收函数本身属于节点的
exit 实现（func 写 state["ok"]），本模块只做「是否通过」的判定。
"""

from __future__ import annotations


class ExitGate:
    @staticmethod
    def passed(state: dict) -> bool:
        return bool(state.get("ok"))

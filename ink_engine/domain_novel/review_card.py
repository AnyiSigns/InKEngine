"""兼容别名——四类审批卡模型已归入共享组件包。

新代码请直接使用 ``ink_engine.components.review_card``；
本模块仅保证既有 ``ink_engine.domain_novel.review_card`` 路径继续可用。
"""

from ink_engine.components import review_card as _review_card
from ink_engine.components.review_card import *  # noqa: F403

__all__ = _review_card.__all__

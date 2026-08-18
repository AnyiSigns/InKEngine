"""InkEngine 叙事领域包旧路径（兼容别名层）。

引擎包归属已重划：通用原语归 ``ink_engine.components``（共享组件包），
叙事语义归 ``ink_engine.novel_harness``（叙事领域包）。本包及其子模块
保留为兼容别名（re-export），保证既有 ``ink_engine.domain_novel.*``
import 路径继续可用；新代码请使用新路径。
"""

from ink_engine import novel_harness
from ink_engine.components import review_card
from ink_engine.components.review_card import *  # noqa: F403
from ink_engine.novel_harness import *  # noqa: F403

__all__ = list(dict.fromkeys([*review_card.__all__, *novel_harness.__all__]))

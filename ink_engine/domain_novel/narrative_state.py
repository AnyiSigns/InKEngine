"""兼容别名——叙事状态定义已归入叙事领域包。

新代码请直接使用 ``ink_engine.novel_harness.narrative_state``；
本模块仅保证既有 ``ink_engine.domain_novel.narrative_state`` 路径继续可用。
"""

from ink_engine.novel_harness import narrative_state as _narrative_state
from ink_engine.novel_harness.narrative_state import *  # noqa: F403

__all__ = _narrative_state.__all__

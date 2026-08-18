"""兼容别名——世界状态层已归入叙事领域包。

新代码请直接使用 ``ink_engine.novel_harness.world_state``；
本模块仅保证既有 ``ink_engine.domain_novel.world_state`` 路径继续可用。
"""

from ink_engine.novel_harness import world_state as _world_state
from ink_engine.novel_harness.world_state import *  # noqa: F403

__all__ = _world_state.__all__

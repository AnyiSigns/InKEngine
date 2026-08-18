"""兼容别名——叙事评审-收敛已归入叙事领域包。

新代码请直接使用 ``ink_engine.novel_harness.review``；
本模块仅保证既有 ``ink_engine.domain_novel.review`` 路径继续可用。
"""

from ink_engine.novel_harness import review as _review
from ink_engine.novel_harness.review import *  # noqa: F403

__all__ = _review.__all__

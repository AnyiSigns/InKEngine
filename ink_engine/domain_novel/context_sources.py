"""兼容别名——上下文源构建器已归入叙事领域包。

新代码请直接使用 ``ink_engine.novel_harness.context_sources``；
本模块仅保证既有 ``ink_engine.domain_novel.context_sources`` 路径继续可用。
"""

from ink_engine.novel_harness import context_sources as _context_sources
from ink_engine.novel_harness.context_sources import *  # noqa: F403

__all__ = _context_sources.__all__

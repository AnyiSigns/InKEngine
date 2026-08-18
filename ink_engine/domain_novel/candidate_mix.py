"""兼容别名——候选段落级混合已归入叙事领域包。

新代码请直接使用 ``ink_engine.novel_harness.candidate_mix``；
本模块仅保证既有 ``ink_engine.domain_novel.candidate_mix`` 路径继续可用。
"""

from ink_engine.novel_harness import candidate_mix as _candidate_mix
from ink_engine.novel_harness.candidate_mix import *  # noqa: F403

__all__ = _candidate_mix.__all__

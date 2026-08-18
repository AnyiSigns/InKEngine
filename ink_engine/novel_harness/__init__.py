"""InkEngine 叙事领域包（novel harness，engine-novel-harness）。

随引擎发布的叙事领域 harness：叙事状态机语义 / 世界状态层 /
候选段落级混合 / 叙事评审-收敛 / 域侧上下文源构建器，以及小说
场景的窗口/记忆/审批策略与沙箱配置。TextForge/lite 等宿主作为本包
消费方，读取 core API 与共享组件（``ink_engine.components``）组装
自身流程，不复写机制。

分层约定：

- ``core``：纯机制（唯一 seam——API 即协议）；
- ``components``：共享组件包（通用原语，本包直接复用）；
- ``novel_harness``：叙事语义（本包）——绑定小说语义的部分，
  仅消费 core/components，反向无依赖。

世界状态层的通用机制（状态机原语/补丁链分支）在 core，本包只承载
书级语义（角色状态机/知识矩阵/因果链/伏笔矩阵）。
"""

from . import candidate_mix, context_sources, narrative_state, review, world_state
from .candidate_mix import *  # noqa: F403
from .context_sources import *  # noqa: F403
from .narrative_state import *  # noqa: F403
from .review import *  # noqa: F403
from .world_state import *  # noqa: F403

__all__ = list(
    dict.fromkeys(
        [
            *candidate_mix.__all__,
            *context_sources.__all__,
            *narrative_state.__all__,
            *review.__all__,
            *world_state.__all__,
        ]
    )
)

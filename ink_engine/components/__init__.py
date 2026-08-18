"""InkEngine 共享组件包（harness 组件库，engine-components）。

core 之上的通用原语集合——回合步骤 / 审批卡 / 域窗口 /
评审收敛，按「harness 组件」形态交付：现成零件、可组合可替换，
各领域 harness 直接复用、禁止重写。本包可选引入（非强制协议），
只依赖 core，不依赖任何领域语义。

分层约定：

- ``core``：纯机制（图执行/checkpoint/事件流/interrupt/存储/补丁链/
  沙箱与审批原语——唯一 seam，API 即协议）；
- ``components``：共享组件（本包）——跨域共用的通用原语；
- ``novel_harness``：叙事领域包（随引擎发布的参考 harness，
  消费本包与 core）。
"""

from . import domain_window, review, review_card, round_steps
from .domain_window import *  # noqa: F403
from .review import *  # noqa: F403
from .review_card import *  # noqa: F403
from .round_steps import *  # noqa: F403

__all__ = list(
    dict.fromkeys(
        [
            *domain_window.__all__,
            *review.__all__,
            *review_card.__all__,
            *round_steps.__all__,
        ]
    )
)

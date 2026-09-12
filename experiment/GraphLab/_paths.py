"""GraphLab 层级路径注册（暂不做正式包：各层目录注入 sys.path，裸模块名 import）。

入口：`import _paths` 后执行 `_paths.setup()`。
"""

from __future__ import annotations

import os
import sys

GRAPHLAB = os.path.dirname(os.path.abspath(__file__))
LAYERS = ("topology", "policy", "engine", "learning", "adapters", "domain")


def setup() -> None:
    for name in LAYERS:
        p = os.path.join(GRAPHLAB, name)
        if p not in sys.path:
            sys.path.insert(0, p)

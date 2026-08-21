"""种子机制转发（通用种子 + boot 自举种子统一入口）。

种子分层（机制在 :mod:`ink_engine.core.seeds`，语义中立）：
- **通用种子**（引擎内置，恒注基线）：默认模板 + 默认权重，最小可用空壳；
- **boot 种子**（引擎随带引导数据）：系统提示词/界面基线/事件类型/
  自举 harness——装配配方按名直注（``AssemblyRecipe.seeds``）。

领域深度归宿主产品层：宿主自写领域知识，直接以知识条目注入
（``seed_knowledge_set``）或经装配配方直注；本包不持有领域内容。
"""
from __future__ import annotations

from ink_engine.core.seeds import (
    GENERAL_TEMPLATE_SEED_ID,
    GENERAL_WEIGHTS_SEED_ID,
    SeedProvider,
    build_general_seed_entries,
    seed_general,
)

__all__ = [
    "GENERAL_TEMPLATE_SEED_ID",
    "GENERAL_WEIGHTS_SEED_ID",
    "SeedProvider",
    "build_general_seed_entries",
    "seed_general",
]

"""种子仓库（领域种子发布物统一入口：「领域种子注入用户集」语义）。

种子分层与注册契约（机制）在 :mod:`ink_engine.core.seeds`（机制层语义
中立，含通用种子）；本包承载随引擎发布的**领域种子**——novel 为第一个
领域种子（``seeds/novel/``），未来 ``seeds/code/`` 等领域种子平行扩展。

使用形态（插拔 U 盘）：领域种子包导入即自注册——装配领域能力 =
``import ink_engine.seeds.<domain>``，随后 ``seed_user_set(ks,
domain=...)`` 按名注入；未导入 = 该领域种子不可用（注册表按名解析时
显式拒绝，不静默建空集）。

本包只做机制转发与目录约定，不持有领域内容。
"""
from __future__ import annotations

from ink_engine.core.seeds import (
    GENERAL_TEMPLATE_SEED_ID,
    GENERAL_WEIGHTS_SEED_ID,
    SeedProvider,
    build_domain_seed_entries,
    build_general_seed_entries,
    register_seed_provider,
    seed_domain,
    seed_domains,
    seed_general,
    seed_user_set,
)

__all__ = [
    "GENERAL_TEMPLATE_SEED_ID",
    "GENERAL_WEIGHTS_SEED_ID",
    "SeedProvider",
    "build_domain_seed_entries",
    "build_general_seed_entries",
    "register_seed_provider",
    "seed_domain",
    "seed_domains",
    "seed_general",
    "seed_user_set",
]

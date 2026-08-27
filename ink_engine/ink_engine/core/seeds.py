"""内置种子知识集封装（通用种子：用户集初始化注入的机制基线）。

通用种子 = 引擎内置的最小可用基线：「能跑、能学、能存的空壳」——
默认编排模板（工作流数据形态）+ 默认权重/阈值（调参基线），**不含
任何领域成品**；每个用户集初始化时注入（幂等，不覆盖使用中演化）。

领域深度归宿主产品层：宿主自写领域规则/样例/谓词，直接以知识条目
形态注入（``seed_knowledge_set``）或经装配配方（``AssemblyRecipe.seeds``
按 ``(name, provider)`` 直注）；机制层不持有任何领域内容（架构门禁：
机制层语义中立）。领域校验语义与验证基线（样例库）由产品成对维护——
fixture 全绿是新规则落库的非谈判项。

种子条目 id 稳定（固定前缀 + 规则 id）：重复初始化经
:func:`~ink_engine.core.knowledge_set.seed_knowledge_set` 幂等跳过，
「种子只读基线 + 演化补丁链」的分层语义不因重复注入被破坏。
"""
from __future__ import annotations

from collections.abc import Callable

from .knowledge_set import (
    KIND_TEMPLATE,
    KIND_WEIGHT,
    SOURCE_MODEL,
    KnowledgeEntry,
    KnowledgeSet,
    seed_knowledge_set,
)
from .source_grading import _SOURCE_CREDIBILITY, SOURCE_USER

# 通用种子条目 id（稳定键：幂等注入与版本回退的锚点）
GENERAL_TEMPLATE_SEED_ID = "seed.general.template.default"
GENERAL_WEIGHTS_SEED_ID = "seed.general.weights.default"

# 种子条目可信度（ENG3-15 机制化说明）：引擎随带的种子 = 经过验证的
# 发布物——取值 = 统一来源分级表（source_grading）中最高档（用户确认
# 级 0.9），高于普通对话（0.6）/模型（0.7）来源：种子经出厂验证管线
# 发布，等同用户确认的信任档；分级基准变化时本常量随表联动（不再
# 独立硬编码）
SEED_CREDIBILITY: float = _SOURCE_CREDIBILITY[SOURCE_USER]

# 种子条目工厂签名（装配配方 seeds 直注用）
SeedProvider = Callable[[], list[KnowledgeEntry]]


def build_general_seed_entries() -> list[KnowledgeEntry]:
    """通用种子条目（最小可用空壳：默认编排模板 + 默认权重/阈值）。

    通用种子不含任何领域成品——「能跑、能学、能存」的基线：
    - 模板条目：默认编排模板（工作流数据形态，节点名由使用方按图适配）；
    - 权重条目：评审/校验的默认权重与阈值（调参基线，参数快照的
      初始形态）。
    """
    return [
        KnowledgeEntry(
            id=GENERAL_TEMPLATE_SEED_ID,
            level="work",
            kind=KIND_TEMPLATE,
            data={
                "template": {
                    "name": "default",
                    "description": "默认编排模板（空壳：入站 → 执行 → 收口）",
                    "plan": {"steps": [{"nodes": ["start"]}]},
                }
            },
            source=SOURCE_MODEL,
            credibility=SEED_CREDIBILITY,
            title="默认编排模板",
            tags=("template", "default"),
        ),
        KnowledgeEntry(
            id=GENERAL_WEIGHTS_SEED_ID,
            level="work",
            kind=KIND_WEIGHT,
            data={
                "divergence_width": 3,
                "retry_budget": 1,
                "web_verify_threshold": 0.5,
                "weights": {"quality": 0.5, "consistency": 0.5},
                "thresholds": {"pass": 0.6},
            },
            source=SOURCE_MODEL,
            credibility=SEED_CREDIBILITY,
            title="默认权重与阈值",
            tags=("weights", "thresholds", "tuning"),
        ),
    ]


def seed_general(knowledge_set: KnowledgeSet) -> int:
    """通用种子注入（每个用户集初始化时调用；幂等，不覆盖演化）。"""
    return seed_knowledge_set(knowledge_set, build_general_seed_entries())


__all__ = [
    "GENERAL_TEMPLATE_SEED_ID",
    "GENERAL_WEIGHTS_SEED_ID",
    "SEED_CREDIBILITY",
    "SeedProvider",
    "build_general_seed_entries",
    "seed_general",
]

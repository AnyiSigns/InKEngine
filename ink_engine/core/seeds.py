"""内置种子知识集封装（通用种子 + 领域种子注册机制：用户集初始化注入）。

种子分层（计划 M6 种子知识集小节）：
- **通用种子**（引擎内置，最小可用）：「能跑、能学、能存的空壳」——
  默认编排模板（工作流数据形态）+ 默认权重/阈值（调参基线），**不含
  任何领域成品**；每个用户集初始化时注入（幂等，不覆盖使用中演化）；
- **领域种子**（引擎随带，按需注入）：领域种子以**注册机制**插拔——
  引擎只定义注册契约（领域名 → 种子条目工厂），领域包自注册（如
  novel 领域种子随其领域包发布并登记），``seed_user_set`` 按名解析。
  机制层不持有任何领域内容（架构门禁：机制层语义中立）。

配套发布物（领域种子的接线件，随领域包一起随带）：领域规则集依赖的
谓词注册表与样例库由领域包自行发布——fixture 全绿是新规则落库的非
谈判项，领域谓词不注册 = 规则无法执行。

种子条目 id 稳定（固定前缀 + 规则 id）：重复初始化经
:func:`~ink_engine.core.knowledge_set.seed_knowledge_set` 幂等跳过，
「种子只读基线 + 演化补丁链」的分层语义不因重复注入被破坏。
"""
from __future__ import annotations

from collections.abc import Callable

from .exceptions import GraphDefinitionError
from .knowledge_set import (
    KIND_TEMPLATE,
    KIND_WEIGHT,
    SOURCE_MODEL,
    KnowledgeEntry,
    KnowledgeSet,
    seed_knowledge_set,
)

# 通用种子条目 id（稳定键：幂等注入与版本回退的锚点）
GENERAL_TEMPLATE_SEED_ID = "seed.general.template.default"
GENERAL_WEIGHTS_SEED_ID = "seed.general.weights.default"

# 引擎随带的种子 = 经过验证的发布物（可信度高于普通对话/模型来源）
_SEED_CREDIBILITY = 0.9

# 领域种子工厂签名：领域种子条目清单（注册契约，领域包自实现）
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
                    "description": "默认编排模板（空壳：任务 → 执行 → 收敛）",
                    "plan": {"steps": [{"nodes": ["start"]}]},
                }
            },
            source=SOURCE_MODEL,
            credibility=_SEED_CREDIBILITY,
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
            credibility=_SEED_CREDIBILITY,
            title="默认权重与阈值",
            tags=("weights", "thresholds", "tuning"),
        ),
    ]


def seed_general(knowledge_set: KnowledgeSet) -> int:
    """通用种子注入（每个用户集初始化时调用；幂等，不覆盖演化）。"""
    return seed_knowledge_set(knowledge_set, build_general_seed_entries())


# ── 领域种子注册机制（插拔 U 盘：领域包自注册，机制层零领域内容）──

_SEED_PROVIDERS: dict[str, SeedProvider] = {}


def register_seed_provider(domain: str, provider: SeedProvider) -> None:
    """登记领域种子工厂（领域包导入时自注册；重复登记显式拒绝）。

    注册契约：领域名 → 种子条目工厂。引擎发布物（novel 领域种子）经
    此入口自注册——``seed_user_set(domain=...)`` 按名解析，未注册的
    领域名在注入时显式拒绝（不静默建空集）。
    """
    if not domain or not isinstance(domain, str):
        raise GraphDefinitionError("领域种子名须为非空字符串")
    if domain in _SEED_PROVIDERS:
        raise GraphDefinitionError(f"领域种子重复注册: {domain}")
    _SEED_PROVIDERS[domain] = provider


def seed_domains() -> tuple[str, ...]:
    """已注册的领域种子名（按注册序稳定）。"""
    return tuple(_SEED_PROVIDERS)


def build_domain_seed_entries(domain: str) -> list[KnowledgeEntry]:
    """按领域名取种子条目（未注册 = 显式拒绝，防拼写错误静默建空集）。"""
    provider = _SEED_PROVIDERS.get(domain)
    if provider is None:
        raise GraphDefinitionError(
            f"未知领域种子: {domain!r}（已注册: {seed_domains()}）"
        )
    return provider()


def seed_domain(knowledge_set: KnowledgeSet, domain: str) -> int:
    """按领域名注入领域种子（未注册领域名显式拒绝；幂等）。"""
    return seed_knowledge_set(knowledge_set, build_domain_seed_entries(domain))


def seed_user_set(knowledge_set: KnowledgeSet, *, domain: str | None = None) -> int:
    """用户集初始化注入（通用种子恒注入 + 领域种子按需注入）。

    Args:
        knowledge_set: 目标用户集。
        domain: 领域种子名（经注册机制解析；None = 只注通用种子）。

    Returns:
        本次实际注入条数（幂等：已存在的种子条目跳过不计）。
    """
    injected = seed_general(knowledge_set)
    if domain is not None:
        injected += seed_domain(knowledge_set, domain)
    return injected


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

"""novel 领域种子（随引擎发布的数据资产：规则集/样例库/schema 基座/模板）。

领域种子 = 引擎随带的领域发布物，按需注入用户集（如 TextForge 用户），
目录形态 = 纯数据包 + 执行语义随带件：
- **规则条目**（:mod:`.ruleset`）：领域写时校验规则集（10 条声明式规则）
  逐条封装为 kind=rule 的知识条目（data.rule 与规则 DSL 声明同构，
  可加载执行）——「核不用写」的示范：领域校验语义 = 规则数据，机制 =
  注册谓词 + 规则引擎；本种子也是「如何声明领域知识」的参考实现；
- **样例库**（:func:`novel_seed_fixtures`）：14 个回归用例——样例全绿
  是新规则落库的非谈判项（L2 效果评估的基线）；
- **schema 基座**（:mod:`.schema_base`）：领域数据模型的字段口径声明
  （知识条目 + 世界观视图），L1 准入与视图校验的口径依据；
- **默认编排模板**（:mod:`.template`）：领域默认工作流的图定义数据
  （宿主按图适配节点类型后编译为可执行图）；
- **出厂自检**（:func:`check_novel_seed_integrity`）：断言规则条目
  可加载 + 样例全绿（发布物回归防线，种子数据改动不破坏契约）。

注册形态（插拔 U 盘）：模块导入即经
:func:`~ink_engine.core.seeds.register_seed_provider` 自注册——宿主
装配领域能力时 import 本模块，``seed_user_set(domain="novel")`` 即可
按名注入；未导入 = 该领域种子不可用（机制层零领域内容）。
"""
from __future__ import annotations

from ink_engine.core.knowledge_set import (
    KIND_RULE,
    SOURCE_MODEL,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.rules import (
    FixtureSet,
    RuleEngine,
    RuleSet,
    RuleTypeRegistry,
    assert_fixtures_pass,
)
from ink_engine.core.schema_validator import SchemaSpec
from ink_engine.core.seeds import register_seed_provider

# novel 领域种子条目 id 前缀（+ 规则 id，如 seed.novel.causal.link_exists.cause）
NOVEL_SEED_PREFIX = "seed.novel"

# 领域种子 = 经过验证的发布物（可信度高于普通对话/模型来源）
_SEED_CREDIBILITY = 0.9


def build_novel_seed_entries() -> list[KnowledgeEntry]:
    """novel 领域种子条目（领域写时校验规则集的封装形态）。

    规则集 10 条声明式规则逐条封装为 kind=rule 的规则条目（data.rule
    与规则 DSL 声明同构，可经 :class:`~ink_engine.core.rules.RuleSet.parse`
    加载执行）——「核不用写」的示范：领域校验语义 = 规则数据，机制 =
    注册谓词 + 规则引擎。

    规则条目引用的领域谓词经 :func:`novel_seed_registry` 注册后才可
    执行（宿主装配时随种子一并接线）。
    """
    from ink_engine.seeds.novel.ruleset import build_world_state_rule_set

    rule_set = build_world_state_rule_set()
    entries: list[KnowledgeEntry] = []
    for rule in rule_set.rules:
        entries.append(
            KnowledgeEntry(
                id=f"{NOVEL_SEED_PREFIX}.{rule.id}",
                level="work",
                kind=KIND_RULE,
                data={"rule": rule.to_dict()},
                source=SOURCE_MODEL,
                credibility=_SEED_CREDIBILITY,
                title=rule.description or rule.id,
                tags=("novel", "world_state", rule.kind),
            )
        )
    return entries


def novel_seed_registry() -> RuleTypeRegistry:
    """novel 领域种子配套：领域谓词注册表（规则执行的前置接线件）。

    与种子条目一起随带发布——领域谓词不注册 = 种子规则无法执行
    （RuleSet.parse 在建期即拒绝未知谓词，不延后到执行期静默跳过）。
    """
    from ink_engine.seeds.novel.ruleset import build_world_state_registry

    return build_world_state_registry()


def novel_seed_fixtures() -> FixtureSet:
    """novel 领域种子配套：样例库（L2 效果评估/新规则落库的非谈判项）。

    样例库与种子规则集同源发布：每条新规则必须先让本样例全绿才允许
    落库（防退化底线，验收语义 = 领域迁移产物规则集 fixture 全绿）。
    """
    from ink_engine.seeds.novel.ruleset import build_world_state_fixtures

    return build_world_state_fixtures()


def novel_schema_base() -> SchemaSpec:
    """novel 领域种子配套：schema 基座（领域数据模型的字段口径声明）。"""
    from ink_engine.seeds.novel.schema_base import build_novel_schema_base

    return build_novel_schema_base()


def novel_default_template() -> dict:
    """novel 领域种子配套：默认编排模板（图定义数据，宿主按图适配）。"""
    from ink_engine.seeds.novel.template import build_novel_default_template

    return build_novel_default_template()


def check_novel_seed_integrity() -> tuple[int, int]:
    """种子完整性自检：规则条目可加载 + 样例全绿（发布物出厂检查）。

    Returns:
        (规则条目数, 样例用例数)；任一环节失败抛
        :class:`~ink_engine.core.exceptions.FixtureGateError`——种子是
        引擎发布物，出厂即应全绿（回归防线：种子数据改动不破坏契约）。
    """
    entries = build_novel_seed_entries()
    registry = novel_seed_registry()
    rule_set = RuleSet(
        name="seed-novel-integrity",
        rules=tuple(
            RuleSet.parse(
                {"name": f"seed-{e.id}", "rules": [e.data["rule"]]},
                registry=registry,
            ).rules[0]
            for e in entries
        ),
    )
    fixtures = novel_seed_fixtures()
    assert_fixtures_pass(rule_set, fixtures, engine=RuleEngine(registry))
    return len(entries), len(fixtures.cases)


def seed_novel(knowledge_set: KnowledgeSet) -> int:
    """novel 领域种子注入（按需：小说场景用户集初始化时调用；幂等）。"""
    from ink_engine.core.seeds import seed_domain

    return seed_domain(knowledge_set, "novel")


# 模块导入即自注册（插拔形态：装配领域能力 = import 本模块即可注入）
register_seed_provider("novel", build_novel_seed_entries)


__all__ = [
    "NOVEL_SEED_PREFIX",
    "build_novel_seed_entries",
    "check_novel_seed_integrity",
    "novel_default_template",
    "novel_schema_base",
    "novel_seed_fixtures",
    "novel_seed_registry",
    "seed_novel",
]

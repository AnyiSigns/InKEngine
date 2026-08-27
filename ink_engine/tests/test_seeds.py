"""内置种子知识集封装单测：通用种子/注入幂等/序列化契约。

语义检查点：
- 通用种子 = 最小可用空壳（默认编排模板 + 默认权重阈值），不含领域成品；
- 注入幂等（重复初始化不覆盖使用中演化——种子只读基线语义）；
- 领域深度归宿主产品层：宿主自写领域知识直接注入（seed_knowledge_set），
  机制层不持有领域注册表。
"""
from __future__ import annotations

from ink_engine.core.knowledge_set import (
    KIND_TEMPLATE,
    KIND_WEIGHT,
    KnowledgeSet,
)
from ink_engine.seeds import (
    GENERAL_TEMPLATE_SEED_ID,
    GENERAL_WEIGHTS_SEED_ID,
    build_general_seed_entries,
    seed_general,
)


def test_general_seed_is_minimal_shell():
    """通用种子 = 最小可用空壳：模板 + 权重阈值，不含领域成品。"""
    entries = build_general_seed_entries()
    by_id = {e.id: e for e in entries}
    assert set(by_id) == {GENERAL_TEMPLATE_SEED_ID, GENERAL_WEIGHTS_SEED_ID}
    assert by_id[GENERAL_TEMPLATE_SEED_ID].kind == KIND_TEMPLATE
    assert by_id[GENERAL_TEMPLATE_SEED_ID].data["template"]["plan"]["steps"]
    assert by_id[GENERAL_WEIGHTS_SEED_ID].kind == KIND_WEIGHT
    assert by_id[GENERAL_WEIGHTS_SEED_ID].data["weights"]
    assert by_id[GENERAL_WEIGHTS_SEED_ID].data["thresholds"]
    assert all(e.id.startswith("seed.general.") for e in entries)


def test_seed_general_injects_and_idempotent():
    """通用种子注入幂等（种子只读基线：重复初始化不覆盖演化）。"""
    ks = KnowledgeSet("u1")
    assert seed_general(ks) == 2
    # 使用中演化种子条目（模拟用户打磨模板）
    ks.update(GENERAL_TEMPLATE_SEED_ID, data={"template": {"name": "打磨后"}})
    assert seed_general(ks) == 0  # 幂等：已存在跳过
    assert ks.get(GENERAL_TEMPLATE_SEED_ID).data["template"]["name"] == "打磨后"


def test_general_seed_serialization_roundtrip():
    """通用种子条目可序列化（补丁链落库/导出的数据契约）。"""
    for entry in build_general_seed_entries():
        rebuilt = type(entry).from_dict(entry.to_dict())
        assert rebuilt == entry


def test_seed_credibility_derived_from_grading_table():
    """ENG3-15 回归：种子可信度 = 统一来源分级表最高档（用户确认级 0.9）。"""
    from ink_engine.core.seeds import SEED_CREDIBILITY, build_general_seed_entries

    assert SEED_CREDIBILITY == 0.9
    assert all(e.credibility == SEED_CREDIBILITY for e in build_general_seed_entries())

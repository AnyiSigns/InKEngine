"""感知结点 + 双通道交叉验证 + 截图外发分级单测。

覆盖：
- 感知结点注册 + 可组装（登记进结点类型注册表，进入组装器结点池，
  factory 产出结构化描述）；
- 视觉任务成败由执行器经通用 ``EdgeEvidenceStore`` 边证据机制统一留痕
  （无专用函数——通用机制覆盖）；
- 双通道交叉验证（一致直进 / 不一致触发复核信号 + 降级决策）；
- 截图外发分级（本地多模态直喂、云端默认禁外发、授权放开）。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.contracts import PathAssemblyConfig
from ink_engine.core.path_assembler import PathAssembler
from ink_engine.core.perception import (
    EXPORT_ALLOW,
    EXPORT_DENY,
    MODEL_CLOUD,
    MODEL_LOCAL,
    VALIDATE_PROCEED,
    VALIDATE_REVIEW,
    VISION_PERCEIVE_TYPE,
    CrossValidationResult,
    VisionExportDecision,
    classify_vision_export,
    cross_validate_channels,
    register_perception_nodes,
)
from ink_engine.core.registry import NodeTypeRegistry

# ── 感知结点注册 + 可组装 ──

def test_perception_node_registered_with_contract():
    registry = NodeTypeRegistry()
    register_perception_nodes(registry)
    assert registry.has(VISION_PERCEIVE_TYPE)
    contract = registry.contract_for(VISION_PERCEIVE_TYPE)
    assert contract is not None
    assert contract.safety_tier == 1
    # 输入 = 截图引用、输出 = 结构化描述
    assert {f.name for f in contract.input_schema.fields} == {"image_url", "image_path"}
    assert "description" in {f.name for f in contract.output_schema.fields}


def test_perception_node_in_assembler_pool():
    """登记后进入组装器结点池（可被组装进路径）。"""
    registry = NodeTypeRegistry()
    register_perception_nodes(registry)
    assembler = PathAssembler(registry=registry, config=PathAssemblyConfig(enabled=True))
    assert VISION_PERCEIVE_TYPE in assembler.contract_pool()


async def test_perception_node_factory_produces_description():
    """factory 产出可执行结点，输入截图引用 → 输出结构化描述。"""

    class Ctx:
        state = {"image_url": "file:///tmp/shot.png"}

    registry = NodeTypeRegistry()
    register_perception_nodes(registry)
    node_fn = registry.create(VISION_PERCEIVE_TYPE, {})
    out = await node_fn(Ctx())
    assert isinstance(out, dict)
    assert out["description"]
    assert "elements" in out
    assert out["confidence"] > 0.0


# ── 双通道交叉验证 ──

def _chan(elements: str) -> dict[str, Any]:
    return {"elements": elements, "description": "x"}


def test_cross_validate_consistent_proceeds():
    result = cross_validate_channels(
        _chan("window,button,text"), _chan("window,button,text")
    )
    assert isinstance(result, CrossValidationResult)
    assert result.consistent is True
    assert result.review_signal is False
    assert result.decision == VALIDATE_PROCEED


def test_cross_validate_inconsistent_triggers_review():
    result = cross_validate_channels(
        _chan("window,button,text"), _chan("window,link,image")
    )
    assert result.consistent is False
    assert result.review_signal is True
    assert result.decision == VALIDATE_REVIEW


def test_cross_validate_single_channel_missing_triggers_review():
    result = cross_validate_channels(_chan("window,button"), _chan(""))
    assert result.consistent is False
    assert result.review_signal is True
    assert result.decision == VALIDATE_REVIEW


# ── 截图外发分级 ──

def test_classify_export_local_always_allowed():
    decision = classify_vision_export(MODEL_LOCAL, authorized=False)
    assert isinstance(decision, VisionExportDecision)
    assert decision.decision == EXPORT_ALLOW


def test_classify_export_cloud_default_denied():
    """云端模型默认禁止截图外发（fail-closed 默认禁外发）。"""
    decision = classify_vision_export(MODEL_CLOUD, authorized=False)
    assert decision.decision == EXPORT_DENY


def test_classify_export_cloud_allowed_when_authorized():
    decision = classify_vision_export(MODEL_CLOUD, authorized=True)
    assert decision.decision == EXPORT_ALLOW


def test_classify_export_unknown_kind_denied():
    decision = classify_vision_export("edge", authorized=True)
    assert decision.decision == EXPORT_DENY

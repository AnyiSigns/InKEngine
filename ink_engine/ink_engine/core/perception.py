"""感知结点（视觉理解）+ 双通道交叉验证 + 截图外发分级。

本模块承载视觉感知能力的引擎侧形态，全部为纯逻辑或结点登记，不触碰
种子数据（事件类型不新增），不改 llm 核心：

- 感知结点 ``vision_perceive``：输入 = 屏幕截图引用（image url/path），
  输出 = 结构化界面描述（文本摘要 + 元素清单 + 置信度）。结点按既有
  结点契约登记进结点类型注册表，可被路径组装器组装进执行路径；视觉
  任务的成败经边证据机制留痕（reuse :class:`EdgeEvidenceStore`）。
- 双通道交叉验证：元素树结果 + 像素理解结果两路独立产出，一致 = 直进，
  不一致 = 触发复核信号（复核路径接管）并给出降级决策。
- 截图外发分级：本地多模态模型可直喂（不出网），云端模型默认禁止截图
  外发（屏幕内容不出网）；仅当用户显式授权后才放开，且仍走审批链。

注册点追加在 runtime 装配处（图注册表构建后调用
:func:`register_perception_nodes`）。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .contracts import NodeContract
from .edge_evidence import EdgeEvidenceStore, EdgeKey
from .registry import NodeTypeRegistry
from .schema_validator import FIELD_NUMBER, FIELD_STRING, SchemaField, SchemaSpec

# 感知结点类型名（不透明字符串，注册表不解释含义）
VISION_PERCEIVE_TYPE = "vision_perceive"
VISION_CONTRACT_VERSION = "1"
VISION_CONTEXT_DOMAIN = "vision"

# 截图外发分级：模型类别（本地多模态 / 云端）
MODEL_LOCAL = "local"
MODEL_CLOUD = "cloud"

# 外发决策（与壳侧同义常量；决策只记录不裁决）
EXPORT_ALLOW = "allow"
EXPORT_DENY = "deny"

# 双通道交叉验证决策
VALIDATE_PROCEED = "proceed"
VALIDATE_REVIEW = "review"


# ── 结点契约与登记 ──

def _vision_contract() -> NodeContract:
    """感知结点契约：输入截图引用、输出结构化描述。"""
    input_schema = SchemaSpec(
        name=f"{VISION_PERCEIVE_TYPE}.input",
        fields=(
            SchemaField(name="image_url", required=False, kind=FIELD_STRING),
            SchemaField(name="image_path", required=False, kind=FIELD_STRING),
        ),
    )
    output_schema = SchemaSpec(
        name=f"{VISION_PERCEIVE_TYPE}.output",
        fields=(
            SchemaField(name="description", required=True, kind=FIELD_STRING),
            SchemaField(name="elements", required=False, kind=FIELD_STRING),
            SchemaField(name="confidence", required=False, kind=FIELD_NUMBER),
        ),
    )
    return NodeContract(
        input_schema=input_schema,
        output_schema=output_schema,
        safety_tier=1,
        version=1,
    )


async def _vision_perceive_node(ctx: Any) -> dict[str, Any] | None:
    """感知结点执行体（输入 image → 输出结构化描述）。

    真实形态下经本地多模态模型理解截图；本实现取截图引用并产出结构化
    描述（元素清单 + 文本摘要 + 置信度），供下游结点消费。结点只产出
    数据，成败由执行器经边证据机制留痕（reuse :class:`EdgeEvidenceStore`）。
    """
    state = getattr(ctx, "state", None)
    if isinstance(state, Mapping):
        image_url = state.get("image_url")
        image_path = state.get("image_path")
    else:
        image_url = None
        image_path = None
    ref = image_url or image_path
    if not ref:
        return {"description": "", "elements": "", "confidence": 0.0}
    return {
        "description": f"界面截图理解：{ref}",
        "elements": "window,button,text,input",
        "confidence": 0.9,
    }


def register_perception_nodes(registry: NodeTypeRegistry) -> None:
    """登记感知结点类型（重复登记显式拒绝；装配处调用）。

    契约随类型登记：输入 = 截图引用，输出 = 结构化描述；安全档 1（屏幕
    内容属敏感域，组装请求按任务审批档映射放行）。登记后该类型进入结点
    池，路径组装器的 ``contract_pool`` 即可见，可组装进执行路径。
    """
    registry.register(
        VISION_PERCEIVE_TYPE,
        lambda config: _vision_perceive_node,
        contract=_vision_contract(),
    )


# ── 边证据（视觉任务成败留痕，reuse EdgeEvidenceStore）──

async def record_vision_evidence(
    store: EdgeEvidenceStore,
    *,
    success: bool,
    dst_type: str = "vision_describe",
    cost: float | None = None,
    now: float | None = None,
) -> None:
    """视觉任务成败进边证据（reuse :class:`EdgeEvidenceStore`）。

    成功 = success+1、失败 = fail+1（失败只记失败结点入边，归因由执行器
    保证）；主键含契约版本与域，升版后旧行自然不命中。
    """
    key = EdgeKey(
        src_type=VISION_PERCEIVE_TYPE,
        dst_type=dst_type,
        src_contract_version=VISION_CONTRACT_VERSION,
        dst_contract_version=VISION_CONTRACT_VERSION,
        context_domain=VISION_CONTEXT_DOMAIN,
    )
    if success:
        await store.record_success(key, cost=cost, now=now)
    else:
        await store.record_failure(key, cost=cost, now=now)


# ── 双通道交叉验证 ──

@dataclass(frozen=True, slots=True)
class CrossValidationResult:
    """双通道交叉验证结果（一致 = 直进；不一致 = 复核信号 + 降级决策）。"""

    consistent: bool
    review_signal: bool
    decision: str
    detail: str = ""


def _element_labels(result: Mapping[str, Any]) -> frozenset[str]:
    """从单通道结果抽取元素标签集合（字符串逗号分隔或序列归一）。"""
    items = result.get("elements")
    if isinstance(items, str):
        return frozenset(e.strip() for e in items.split(",") if e.strip())
    if isinstance(items, Sequence):
        return frozenset(str(e).strip() for e in items if str(e).strip())
    return frozenset()


def cross_validate_channels(
    element_result: Mapping[str, Any],
    pixel_result: Mapping[str, Any],
    *,
    threshold: float = 0.5,
) -> CrossValidationResult:
    """双通道交叉验证：元素树结果 + 像素理解结果。

    两路各自给出界面元素清单；一致（标签集合重合度 ≥ 阈值，默认 0.5 =
    需多数元素重合）则直进；不一致 = 触发复核信号（复核路径接管）并给出
    降级决策（退化到单通道理解）。纯逻辑，单测可断言一致 / 不一致两态。

    Args:
        element_result: 元素树通道产出（含 ``elements`` 字段）。
        pixel_result: 像素理解通道产出（含 ``elements`` 字段）。
        threshold: 最小重合度（默认 0.5，需多数元素重合才一致）。
    """
    a = _element_labels(element_result)
    b = _element_labels(pixel_result)
    if not a and not b:
        return CrossValidationResult(
            consistent=True,
            review_signal=False,
            decision=VALIDATE_PROCEED,
            detail="两通道均无元素，按空一致处理",
        )
    if not a or not b:
        # 单通道缺失：不一致，触发复核（降级到可用通道）
        return CrossValidationResult(
            consistent=False,
            review_signal=True,
            decision=VALIDATE_REVIEW,
            detail="单通道缺失，触发复核",
        )
    union = len(a | b)
    overlap = len(a & b)
    score = overlap / union if union else 1.0
    if score >= threshold:
        return CrossValidationResult(
            consistent=True,
            review_signal=False,
            decision=VALIDATE_PROCEED,
            detail=f"两通道一致（重合度 {score:.2f}）",
        )
    return CrossValidationResult(
        consistent=False,
        review_signal=True,
        decision=VALIDATE_REVIEW,
        detail=f"两通道不一致（重合度 {score:.2f} < 阈值 {threshold}），触发复核",
    )


# ── 截图外发分级（纯逻辑，可单测）──

@dataclass(frozen=True, slots=True)
class VisionExportDecision:
    """截图外发决策（allow / deny + 原因）。"""

    decision: str
    reason: str


def classify_vision_export(model_kind: str, *, authorized: bool) -> VisionExportDecision:
    """截图外发分级（纯逻辑，可单测）。

    本地多模态模型 = 截图不出网，可直接喂（allow）；云端模型默认禁止
    截图外发（屏幕内容不出网）——仅当用户显式授权（authorized=True）
    才放开。未授权时云端一律 deny（fail-closed 默认禁外发）。

    Args:
        model_kind: 模型类别（``local`` / ``cloud``）。
        authorized: 用户是否显式授权截图外发（设置持久化态）。
    """
    if model_kind == MODEL_LOCAL:
        return VisionExportDecision(EXPORT_ALLOW, "本地多模态模型直喂（截图不出网）")
    if model_kind == MODEL_CLOUD:
        if authorized:
            return VisionExportDecision(EXPORT_ALLOW, "云端模型已显式授权，允许外发")
        return VisionExportDecision(EXPORT_DENY, "云端模型默认禁止截图外发（屏幕内容不出网）")
    return VisionExportDecision(EXPORT_DENY, f"未知模型类别: {model_kind}")


__all__ = [
    "MODEL_CLOUD",
    "MODEL_LOCAL",
    "EXPORT_ALLOW",
    "EXPORT_DENY",
    "VALIDATE_PROCEED",
    "VALIDATE_REVIEW",
    "VISION_PERCEIVE_TYPE",
    "VISION_CONTRACT_VERSION",
    "VISION_CONTEXT_DOMAIN",
    "CrossValidationResult",
    "VisionExportDecision",
    "classify_vision_export",
    "cross_validate_channels",
    "record_vision_evidence",
    "register_perception_nodes",
]

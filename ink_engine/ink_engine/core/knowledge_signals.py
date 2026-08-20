"""信号感知与蒸馏（轨迹 → 结构化知识的入口：五类信号分类路由 + 结构化压缩）。

信号感知（借鉴他山信号体系）：任务执行轨迹中分类感知五类信号——
踩坑（预期外失败）/ 用户修正（卡回路 accept/edit 反例）/ 洞见（成功
路径中的可复用经验）/ 流程缺口（缺某类能力 → 新建候选）/ 重复根因
（同一问题 ≥3 次 → 人工确认后升级修规范）。触发条件：任务复杂度或
用户干预超过阈值（华为云任务反思语义），蒸馏按需触发非每回合。

蒸馏（华为云任务反思）：把轨迹压缩为结构化知识——丢弃试错分支，仅
保留成功步骤/分支判断/异常修复；对已有知识的修正走**精准补丁**
（replace 语义，只改对应段落，不重写整条知识）。

来源留痕 + 可信度分级贯穿全链：信号携带来源（web/dialog/model/user），
蒸馏产物继承来源——防 web 注入污染知识集（L1 安全扫描见闸门模块）。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, ClassVar, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError
from .knowledge_set import KnowledgeEntry
from .tiers import build_tier_chain

# 五类信号（分类路由的枚举化标签，防魔法字符串）
SIGNAL_PITFALL = "pitfall"  # 踩坑：预期外失败（错误轨迹的可复用教训）
SIGNAL_USER_CORRECTION = "user_correction"  # 用户修正：卡回路 accept/edit 反例
SIGNAL_INSIGHT = "insight"  # 洞见：成功路径中的可复用经验
SIGNAL_GAP = "gap"  # 流程缺口：缺某类能力 → 新建候选
SIGNAL_REPEATED_ROOT_CAUSE = "repeated_root_cause"  # 重复根因：同一问题 ≥3 次

# 来源分级（web < dialog < model < user；可信度判定的基准标签）
SOURCE_WEB = "web"
SOURCE_DIALOG = "dialog"
SOURCE_MODEL = "model"
SOURCE_USER = "user"

# 重复根因升级阈值（同一问题出现次数 ≥ 该值 → 转人工确认）
REPEAT_THRESHOLD = 3

# 蒸馏触发阈值（任务复杂度/用户干预超阈值才按需蒸馏——非每回合）
DEFAULT_COMPLEXITY_THRESHOLD = 5
DEFAULT_INTERVENTION_THRESHOLD = 1

# 蒸馏建链挡位（router 挡位；router_config 缺失回落 main_config——与
# 挡位机制其余消费方同语义，见 tiers.resolve_tier_config）
DEFAULT_DISTILL_TIER = "router"

# 蒸馏产物的来源归属（无信号可推导时回落模型来源）
_FALLBACK_SOURCE = SOURCE_MODEL


@dataclass(frozen=True, slots=True)
class ExecutionSignal:
    """一条执行信号（分类路由的产物：轨迹中的一次可学习事件）。

    Attributes:
        kind: 信号类别（pitfall/user_correction/insight/gap/repeated_root_cause）。
        message: 信号内容（轨迹摘要，蒸馏的输入素材）。
        source: 来源（web/dialog/model/user——可信度分级与防注入审计）。
        context: 关联上下文（任务描述/节点/工具名等，蒸馏时透传）。
        count: 同因出现次数（重复根因判定依据；初次为 1）。
        timestamp: 信号时间戳（epoch 秒）。
    """

    kind: str
    message: str
    source: str = SOURCE_MODEL
    context: dict[str, Any] = field(default_factory=dict)
    count: int = 1
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "kind": self.kind,
            "message": self.message,
            "source": self.source,
        }
        if self.context:
            data["context"] = self.context
        if self.count > 1:
            data["count"] = self.count
        data["timestamp"] = self.timestamp
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ExecutionSignal:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"信号声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        kind = data.get("kind")
        message = data.get("message")
        if kind not in _SIGNAL_KINDS:
            raise GraphDefinitionError(f"未知信号类别: {kind!r}（仅 {_SIGNAL_KINDS}）")
        if not isinstance(message, str) or not message:
            raise GraphDefinitionError("信号缺 message（字符串）")
        source = data.get("source", SOURCE_MODEL)
        if source not in _SOURCES:
            raise GraphDefinitionError(f"未知信号来源: {source!r}（仅 {_SOURCES}）")
        context = data.get("context")
        if context is not None and not isinstance(context, dict):
            raise GraphDefinitionError("信号 context 须为 dict")
        return cls(
            kind=kind,
            message=message,
            source=source,
            context=dict(context or {}),
            count=int(data.get("count", 1)),
            timestamp=float(data.get("timestamp", time.time())),
        )


_SIGNAL_KINDS = (
    SIGNAL_PITFALL,
    SIGNAL_USER_CORRECTION,
    SIGNAL_INSIGHT,
    SIGNAL_GAP,
    SIGNAL_REPEATED_ROOT_CAUSE,
)
_SOURCES = (SOURCE_WEB, SOURCE_DIALOG, SOURCE_MODEL, SOURCE_USER)


class SignalClassifier:
    """信号分类器：原始轨迹事件 → 五类信号（确定性规则分类路由）。

    分类语义（可扩展的确定性基线；语义分类为可选扩展）：
    - 节点异常/工具失败/校验拒绝 → pitfall（踩坑）；
    - 用户修正（accept/edit/reject 反例）→ user_correction；
    - 成功路径的可复用结论（评审通过/用户确认）→ insight；
    - 缺能力提示（能力不存在/工具缺失/规则未覆盖）→ gap；
    - 同因重复（按 context 中的根因键聚合 ≥ REPEAT_THRESHOLD）→
      repeated_root_cause（升级信号，供人工确认后修规范）。
    """

    def __init__(self, repeat_threshold: int = REPEAT_THRESHOLD) -> None:
        self.repeat_threshold = repeat_threshold
        # 根因聚合表（root_cause_key → 计数）：同回合内同因事件聚合
        self._root_causes: dict[str, int] = {}

    def classify(self, event: dict[str, Any]) -> ExecutionSignal | None:
        """分类单条轨迹事件（非信号形态返回 None——轨迹噪音不沉淀）。

        Args:
            event: 轨迹事件（type/message/source/context 字段；形态与
                执行器事件/宿主回合记录对齐，字段缺失走默认）。

        Returns:
            分类出的信号（None = 无需沉淀的噪音事件）。
        """
        etype = event.get("type") or ""
        message = event.get("message") or event.get("payload", {}).get("message") or ""
        source = event.get("source") or SOURCE_MODEL
        context = dict(event.get("context") or event.get("payload") or {})
        if etype in ("error", "node_error", "tool_error", "validation_error"):
            return ExecutionSignal(
                kind=SIGNAL_PITFALL,
                message=str(message) or f"执行异常: {etype}",
                source=source,
                context=context,
            )
        if etype in ("accept", "edit", "reject", "user_correction"):
            return ExecutionSignal(
                kind=SIGNAL_USER_CORRECTION,
                message=str(message) or f"用户修正: {etype}",
                source=SOURCE_USER,
                context=context,
            )
        if etype in ("insight", "review_pass", "user_confirm"):
            return ExecutionSignal(
                kind=SIGNAL_INSIGHT,
                message=str(message) or f"可复用经验: {etype}",
                source=source,
                context=context,
            )
        if etype in ("gap", "missing_capability", "no_rule"):
            return ExecutionSignal(
                kind=SIGNAL_GAP,
                message=str(message) or "能力缺失（新建候选）",
                source=source,
                context=context,
            )
        # 非信号形态：不沉淀（轨迹噪音过滤）
        return None

    def aggregate(self, signals: list[ExecutionSignal]) -> list[ExecutionSignal]:
        """同因聚合：重复根因升级（同一 root key ≥ 阈值 → 升级信号）。

        root key = (kind, message 规范化)；重复根因不直接产出知识——
        升级为人工确认候选（repeated_root_cause），由使用方转人工。
        """
        counts: dict[tuple[str, str], int] = {}
        for signal in signals:
            key = (signal.kind, signal.message.strip().lower())
            counts[key] = counts.get(key, 0) + 1
        upgraded: list[ExecutionSignal] = []
        for signal in signals:
            key = (signal.kind, signal.message.strip().lower())
            count = counts[key]
            if count >= self.repeat_threshold:
                upgraded.append(
                    ExecutionSignal(
                        kind=SIGNAL_REPEATED_ROOT_CAUSE,
                        message=signal.message,
                        source=signal.source,
                        context={**signal.context, "repeat_count": count},
                        count=count,
                    )
                )
            else:
                upgraded.append(signal)
        return upgraded


@runtime_checkable
class Distiller(Protocol):
    """蒸馏器协议：信号序列 → 结构化知识条目数据（丢弃试错分支）。

    引擎规定「输入信号、输出知识数据」的契约；具体压缩策略（保留成功
    步骤/分支判断/异常修复，丢弃试错分支）由实现方决定——确定性基线
    实现见 :class:`DeterministicDistiller`，LLM 蒸馏为可选扩展。
    """

    def distill(self, signals: list[ExecutionSignal]) -> dict[str, Any] | None: ...


@dataclass(frozen=True, slots=True)
class DistillOutcome:
    """一次蒸馏的产物（知识数据 + 来源/标签/说明，供闸门与沉淀）。"""

    data: dict[str, Any]
    source: str
    tags: tuple[str, ...] = ()
    title: str = ""
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "data": self.data,
            "source": self.source,
        }
        if self.tags:
            data["tags"] = list(self.tags)
        if self.title:
            data["title"] = self.title
        if self.note:
            data["note"] = self.note
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DistillOutcome:
        if not isinstance(data, dict) or not isinstance(data.get("data"), dict):
            raise GraphDefinitionError(
                f"蒸馏产物声明非法: 期望 {{data: dict, ...}}，收到 {type(data).__name__}"
            )
        tags = data.get("tags") or ()
        return cls(
            data=data["data"],
            source=data.get("source", SOURCE_MODEL),
            tags=tuple(tags),
            title=data.get("title", ""),
            note=data.get("note", ""),
        )


class DeterministicDistiller:
    """确定性蒸馏基线：信号 → 结构化知识（零 LLM 调用，可测试可断言）。

    压缩语义：
    - 只保留「成功路径结论」（insight 的成功经验 + user_correction 的
      修正反例——反例是「别这么做」的规则素材）；踩坑信号作为失败原因
      汇总进 note（教训来源），不直接成为知识内容（试错分支丢弃）；
    - 输出 data = {"rule": {message, context}}（规则条目的声明形态，
      与规则 DSL 的 Rule 声明兼容——kind=rule 条目直接可执行）；
    - 来源取信号中最可信者（user > model > dialog > web 的确定性基准）。

    蒸馏触发条件（按需非每回合）由使用方判定（复杂度/干预阈值），本
    实现只负责「触发后的压缩」。
    """

    # 来源可信度基准（数值仅供排序，不产出可信度字段）
    _SOURCE_RANK: ClassVar[dict[str, int]] = {
        SOURCE_USER: 4, SOURCE_MODEL: 3, SOURCE_DIALOG: 2, SOURCE_WEB: 1
    }

    def __init__(
        self,
        *,
        complexity_threshold: int = DEFAULT_COMPLEXITY_THRESHOLD,
        intervention_threshold: int = DEFAULT_INTERVENTION_THRESHOLD,
    ) -> None:
        self.complexity_threshold = complexity_threshold
        self.intervention_threshold = intervention_threshold

    def should_distill(
        self, *, complexity: int = 0, interventions: int = 0
    ) -> bool:
        """按需触发判定（华为云任务反思语义：复杂度或干预超过阈值才蒸馏）。

        双阈值保守：两项都低 = 普通回合，不蒸馏（防「蒸馏垃圾进垃圾出」）。
        """
        return (
            complexity >= self.complexity_threshold
            or interventions >= self.intervention_threshold
        )

    def distill(self, signals: list[ExecutionSignal]) -> dict[str, Any] | None:
        """信号 → 知识数据（无可沉淀信号返回 None）。

        Returns:
            知识条目 data（{"rule": {"message", "context"}} 声明形态），
            或 None（全部为噪音/无成功路径结论——不产出空知识）。
        """
        usable = [
            s
            for s in signals
            if s.kind in (SIGNAL_INSIGHT, SIGNAL_USER_CORRECTION)
        ]
        if not usable:
            return None
        # 修正反例优先（用户反例 = 最可靠规则素材），洞见次之
        primary = next(
            (s for s in usable if s.kind == SIGNAL_USER_CORRECTION), usable[0]
        )
        pitfalls = [s for s in signals if s.kind == SIGNAL_PITFALL]
        note = (
            "; ".join(p.message for p in pitfalls[:3]) if pitfalls else ""
        )
        return {
            "rule": {
                "message": primary.message,
                "context": dict(primary.context),
                "note": note,
            }
        }


@dataclass(frozen=True, slots=True)
class DistillConfig:
    """蒸馏配置（引擎配置开关 + 建链挡位）。

    Attributes:
        enabled: distill_enabled 引擎配置开关（False = 关闭蒸馏——
            should_distill 恒 False、distill 恒 None，一键回到「无蒸馏」）。
        tier: 蒸馏建链挡位（默认 router 挡位；该挡位配置缺失回落
            main_config——挡位机制统一语义）。
    """

    enabled: bool = True
    tier: str = DEFAULT_DISTILL_TIER

    def to_dict(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "tier": self.tier}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DistillConfig:
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"蒸馏配置声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        return cls(
            enabled=bool(data.get("enabled", True)),
            tier=data.get("tier") or DEFAULT_DISTILL_TIER,
        )


def resolve_distill_chain(
    model_config: dict[str, Any] | None,
    tier: str | None = None,
    *,
    create: Any = None,
    retry: Any = None,
):
    """按挡位构建蒸馏模型链（router 建链，配置缺失回落 main_config）。

    复用四挡位机制（router 建链语义）：蒸馏走 router 挡位的轻量模型
    （省成本），该挡位未配置时经
    :func:`~ink_engine.core.tiers.resolve_tier_config` 回落主挡位——
    与引擎其余挡位消费方同一条回落路径，无独立配置形态。

    Args:
        model_config: 用户模型配置字典（可含 router_config/main_config）。
        tier: 建链挡位（默认 router）。
        create/retry: 适配器工厂与重试策略注入（透传挡位建链）。

    Returns:
        ``ModelChain`` 实例；主/router 挡位均无配置时返回 None（由
        :class:`TieredDistiller` 回落确定性蒸馏基线，不静默降级到错误）。
    """
    return build_tier_chain(
        model_config, tier or DEFAULT_DISTILL_TIER, create=create, retry=retry
    )


class TieredDistiller:
    """挡位蒸馏器：distill_enabled 开关 + router 挡位建链 + 确定性回落。

    组装语义（计划「复用四挡位（router 建链，router_config 缺失回落
    main_config，distill_enabled 为引擎配置开关）」落地）：
    - 开关关闭（enabled=False）→ 蒸馏整体停用（触发判定恒 False、
      蒸馏恒无产物）——一键回退「无蒸馏」基线；
    - 开关开启且有模型链（router 挡位建成）→ 可走 LLM 蒸馏（异步入口
      ``distill_async``，LLM 调用回调由实现方注入）；链缺失（挡位未
      配置）→ 回落确定性蒸馏基线（零 LLM 调用，可测试可断言）；
    - 触发阈值（复杂度/干预双阈值）委托确定性基线，防「蒸馏垃圾进
      垃圾出」的保守语义不被开关/链配置削弱。
    """

    def __init__(
        self,
        config: DistillConfig | None = None,
        chain: Any = None,
        deterministic: Distiller | None = None,
        *,
        complexity_threshold: int = DEFAULT_COMPLEXITY_THRESHOLD,
        intervention_threshold: int = DEFAULT_INTERVENTION_THRESHOLD,
    ) -> None:
        self.config = config or DistillConfig()
        self.chain = chain
        self.deterministic = deterministic or DeterministicDistiller(
            complexity_threshold=complexity_threshold,
            intervention_threshold=intervention_threshold,
        )

    def should_distill(self, *, complexity: int = 0, interventions: int = 0) -> bool:
        """按需触发判定：开关关闭恒 False；开启后走双阈值保守语义。"""
        if not self.config.enabled:
            return False
        return self.deterministic.should_distill(
            complexity=complexity, interventions=interventions
        )

    def distill(self, signals: list[ExecutionSignal]) -> dict[str, Any] | None:
        """同步蒸馏入口（确定性基线路径；模型链路径走异步入口）。

        开关关闭恒 None；同步路径恒走确定性蒸馏（零 LLM 调用、可测试
        可断言）——配置了模型链的蒸馏经 :meth:`distill_async` 走 LLM
        回调，二者互不混叠。
        """
        if not self.config.enabled:
            return None
        return self.deterministic.distill(signals)

    async def distill_async(
        self,
        signals: list[ExecutionSignal],
        *,
        llm_distill: Any = None,
    ) -> dict[str, Any] | None:
        """异步蒸馏入口：链可用时经 LLM 回调蒸馏，失败/缺失回落确定性。

        Args:
            signals: 待蒸馏的信号序列。
            llm_distill: LLM 蒸馏回调（签名
                ``(chain, signals) -> dict | None``；None = 不调用 LLM）。
                回调返回 None/抛异常 = 本次不产 LLM 产物，回落确定性
                蒸馏（fail-open——蒸馏是增强能力，不阻断知识沉淀）。
        """
        if not self.config.enabled:
            return None
        if self.chain is not None and llm_distill is not None:
            try:
                data = await llm_distill(self.chain, signals)
                if isinstance(data, dict):
                    return data
            except Exception:
                pass  # fail-open：LLM 蒸馏失败回落确定性基线
        return self.deterministic.distill(signals)


@dataclass(frozen=True, slots=True)
class ReuseDecision:
    """「复用优先于生成」的组合判定结果（检索命中或蒸馏产物，二选一）。"""

    reused: tuple[KnowledgeEntry, ...] = ()
    distilled: DistillOutcome | None = None
    note: str = ""

    @property
    def reused_first(self) -> bool:
        """组合断言：检索命中优先于重新蒸馏（命中时无蒸馏产物）。"""
        return bool(self.reused) and self.distilled is None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {"note": self.note}
        if self.reused:
            data["reused"] = [e.id for e in self.reused]
        if self.distilled is not None:
            data["distilled"] = self.distilled.to_dict()
        return data


def reuse_or_distill(
    knowledge_set: Any,
    query: str,
    signals: list[ExecutionSignal],
    distiller: Distiller,
    *,
    level: str | None = None,
    kind: str | None = None,
    limit: int = 5,
    title: str = "",
    tags: tuple[str, ...] = (),
) -> ReuseDecision:
    """复用优先于生成：相似任务先检索已有条目，命中即跳过重新蒸馏。

    AgentFactory 教训的组合入口：先 ``knowledge_set.search``（复用检索），
    命中 = 直接用既有知识（降蒸馏成本、防知识膨胀），蒸馏器**不被调用**；
    未命中才走蒸馏（按需触发后）。未命中且蒸馏无产物 = 两路皆空，note
    说明（本次不沉淀，轨迹噪音不产出空知识）。

    Args:
        knowledge_set: 用户知识集（:class:`KnowledgeSet`，search 协议）。
        query: 任务描述（检索关键词来源）。
        signals: 蒸馏输入信号（未命中复用时的素材）。
        distiller: 蒸馏器（命中复用时不调用——组合断言）。
        level/kind/limit: 检索过滤与上限（透传 search）。
        title/tags: 蒸馏产物的标题/标签（默认取查询词，保证可再检索）。

    Returns:
        :class:`ReuseDecision`：reused = 检索命中条目（蒸馏跳过）；
        distilled = 蒸馏产物（未命中时）；两者皆空 = 无可沉淀。
    """
    hits = knowledge_set.search(query, level=level, kind=kind, limit=limit)
    if hits:
        return ReuseDecision(
            reused=tuple(hits),
            note=f"复用检索命中 {len(hits)} 条，跳过重新蒸馏（防知识膨胀）",
        )
    data = distiller.distill(signals)
    if data is None:
        return ReuseDecision(note="未命中复用且蒸馏无产物（本次不沉淀）")
    source = next(
        (s.source for s in signals if s.kind == SIGNAL_USER_CORRECTION),
        signals[0].source if signals else _FALLBACK_SOURCE,
    )
    return ReuseDecision(
        distilled=DistillOutcome(
            data=data,
            source=source,
            title=title or query,
            tags=tags or (query,),
            note="未命中复用，蒸馏产出新知识",
        ),
        note="未命中复用，蒸馏产出新知识",
    )


def build_precise_patch(
    existing_data: dict[str, Any], path: tuple[str | int, ...], value: Any
) -> dict[str, Any]:
    """精准补丁构造（修正已有知识：只改对应段落，不重写整条）。

    语义与补丁链 replace 对齐：path 指向知识 data 内的具体字段，替换
    仅落在该字段——旧值仍在链历史中可回退；不整条重写（防蒸馏覆盖
    知识集中其它已验证内容）。

    Returns:
        {"path": [seg, ...], "value": v} 形态的补丁声明（调用方落链）。
    """
    if not path:
        raise GraphDefinitionError("精准补丁路径不能为空")
    return {"path": list(path), "value": value}


__all__ = [
    "DEFAULT_COMPLEXITY_THRESHOLD",
    "DEFAULT_DISTILL_TIER",
    "DEFAULT_INTERVENTION_THRESHOLD",
    "REPEAT_THRESHOLD",
    "SIGNAL_GAP",
    "SIGNAL_INSIGHT",
    "SIGNAL_PITFALL",
    "SIGNAL_REPEATED_ROOT_CAUSE",
    "SIGNAL_USER_CORRECTION",
    "DeterministicDistiller",
    "DistillConfig",
    "DistillOutcome",
    "Distiller",
    "ExecutionSignal",
    "ReuseDecision",
    "SignalClassifier",
    "TieredDistiller",
    "build_precise_patch",
    "resolve_distill_chain",
    "reuse_or_distill",
]

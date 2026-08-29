"""孵化域：轨迹信号 → 蒸馏 → 三层闸门 → 落库 → 自指挂载的闭环入口。

**职责边界（孵化已下沉引擎）**：孵化闭环（信号感知/蒸馏触发/复用优先/
三层闸门/沉淀）由引擎侧 :class:`~ink_engine.core.growth.GrowthPipeline`
自承载（出厂默认开、宿主零介入）——本域的孵化面方法（classify/
should_distill/distill/verify_gate/sediment/distill_llm/promote/export/
review_and_converge）**无生产调用点**，标记废弃仅保留测试引用，宿主
不得再新增调用。本域当前唯一生产职责 = **演化面**：
- ``evolution_candidates``/``evolve``/``record_usage``：失败驱动反思式
  变异 + 三层闸门防退化（`knowledge.evolve` 桥 op 的低频批次触发点）；
- ``propose_knowledge_patch``：变异体以 KNOWLEDGE 补丁形态进入集补丁链
  （审批分级 → 审计 → 可回退）——知识既是数据也是演化对象。

数据驱动（PLAN 公理「知识是数据」）：蒸馏阈值/开关来自 signals.json、
样例库与交叉验证锚点来自 samples.json、收敛与评审阈值来自 review.json
——域内零硬编码产品语义。
"""
from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ink_engine.core.evolution import (
    EvolutionFactory,
    EvolutionOutcome,
    entry_metrics,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.knowledge_gate import (
    GateL2FixtureExecutor,
    KnowledgeGate,
    scan_text_injection,
)
from ink_engine.core.knowledge_set import (
    KIND_INSIGHT,
    KnowledgeEntry,
)
from ink_engine.core.knowledge_signals import (
    DEFAULT_COMPLEXITY_THRESHOLD,
    DEFAULT_DISTILL_TIER,
    DEFAULT_INTERVENTION_THRESHOLD,
    REPEAT_THRESHOLD,
    DistillConfig,
    DistillOutcome,
    ExecutionSignal,
    SignalClassifier,
    TieredDistiller,
    resolve_distill_chain,
    reuse_or_distill,
)
from ink_engine.core.rules import FixtureCase, FixtureSet
from ink_engine.core.schema_validator import SchemaSpec
from ink_engine.core.self_proposal import PatchKind, SelfProposal

# 知识条目 L1 形式校验 schema（与引擎 KnowledgeEntry 契约字段同源；
# data 内部形态由域内样例/谓词绑定约束，L2 样例全绿兜底）
_ENTRY_SCHEMA_FIELDS: tuple[dict[str, Any], ...] = (
    {"name": "id", "required": True, "kind": "string"},
    {
        "name": "level",
        "required": True,
        "kind": "string",
        "enum": ["work", "project", "user"],
    },
    {"name": "kind", "required": True, "kind": "string"},
    {"name": "source", "required": False, "kind": "string"},
    {"name": "title", "required": False, "kind": "string"},
)

# 评审阈值来源（review.json pass_threshold 的孵化侧引用点：评审收敛
# 与孵化闸门共用同一通过语义，防两套阈值漂移）
REVIEW_PASS_THRESHOLD_KEY = "pass_threshold"

# 废弃标记（孵化已下沉引擎 GrowthPipeline）：孵化面方法仅保留测试
# 引用，宿主不得再新增调用。装饰器在方法级 docstring 前追加统一
# 说明，防止漂移。
_DEPRECATED_INCUBATION = "【已废弃 · 孵化下沉引擎】"


def _deprecated(message: str) -> str:
    return f"{_DEPRECATED_INCUBATION} {message}（生产调用点已移除）"


def build_entry_schema() -> SchemaSpec:
    """知识条目 L1 形式校验 schema（构造即校验，字段声明可审计）。"""
    return SchemaSpec.from_dict(
        {"name": "knowledge_entry", "fields": list(_ENTRY_SCHEMA_FIELDS)}
    )


def _string_values_of(data: Any, *, depth: int = 0) -> list[str]:
    """递归提取条目数据中的字符串值（注入复扫的文本面，与引擎闸门同口径）。"""
    if depth > 8:
        return []
    if isinstance(data, str):
        return [data]
    if isinstance(data, dict):
        out: list[str] = []
        for value in data.values():
            out.extend(_string_values_of(value, depth=depth + 1))
        return out
    if isinstance(data, (list, tuple)):
        out: list[str] = []
        for item in data:
            out.extend(_string_values_of(item, depth=depth + 1))
        return out
    return []


def _string_keys_of(data: Any, *, depth: int = 0) -> list[str]:
    """递归提取条目数据中的字符串键名（注入复扫的键位面）。"""
    if depth > 8:
        return []
    if isinstance(data, dict):
        out: list[str] = []
        for key, value in data.items():
            if isinstance(key, str):
                out.append(key)
            out.extend(_string_keys_of(value, depth=depth + 1))
        return out
    if isinstance(data, (list, tuple)):
        out: list[str] = []
        for item in data:
            out.extend(_string_keys_of(item, depth=depth + 1))
        return out
    return []


def fixture_set_from_samples(samples_data: dict[str, Any]) -> FixtureSet:
    """samples.json → L2 样例库（用例字段与 FixtureCase 契约对齐）。"""
    return FixtureSet(
        name=str(samples_data.get("name") or "inkling.samples"),
        cases=tuple(
            FixtureCase(
                id=str(case["id"]),
                data=dict(case.get("data") or {}),
                context=dict(case.get("context") or {}),
                expected_pass=bool(case.get("expected_pass", True)),
                description=str(case.get("description") or ""),
            )
            for case in samples_data.get("cases") or ()
        ),
    )


class IncubationDomain:
    """孵化域（宿主装配：signals/samples/review 数据 + 运行时注入）。

    生产职责 = **演化面**（`knowledge.evolve` 桥 op 消费）：
    ``evolution_candidates`` → ``evolve``（失败驱动变异 + 三层闸门防退化）
    → ``propose_knowledge_patch``（KNOWLEDGE 补丁落集补丁链）+
    ``record_usage``（调用留痕 = 变异输入）。孵化面（信号/蒸馏/闸门/
    沉淀）已下沉引擎 :class:`~ink_engine.core.growth.GrowthPipeline`，
    本类孵化面方法标记废弃（无生产调用点，仅测试引用）。

    Attributes:
        samples: 完整样例库（samples.json 数据形态，**含负面用例**——
            verify_gate/sediment 喂 L2 的完整 fixtures，负面/对抗用例
            不剥离）。
        gate_fixtures: 内置谓词域的正面样例基线（expected_pass=True
            全量——领域谓词绑定执行件侧（has_fields/max_length/
            min_value/...），Python 侧内置闸门按内置谓词域评估候选，
            新规则不得违反既有领域形态约定）。负面用例由领域谓词覆盖：
            exec 绑定测试（rules.json × 完整 samples 全绿非谈判项）与
            Rust 域孵化同源承载，负面用例显式记录在
            ``negative_fixtures``（数据级绑定由校验脚本与 exec 绑定
            测试承接，不静默丢弃）。
        negative_fixtures: 负面/对抗用例显式记录（expected_pass=False
            全量；由领域谓词覆盖的执行侧绑定测试承接评估，Python 侧
            闸门按内置谓词域评估时以 gate_fixtures 为基线）。
        gate: 三层闸门实例（L1/L2/L3 组合入口）。
        schema: 知识条目 L1 形式校验声明。
    """

    def __init__(
        self,
        runtime: Any,
        *,
        signals_data: dict[str, Any],
        samples_data: dict[str, Any],
        review_data: dict[str, Any],
        on_llm_call: Callable[[str], None] | None = None,
        model_config: dict[str, Any] | None = None,
        distill_tier: str | None = None,
    ) -> None:
        self._runtime = runtime
        self.review_data = review_data
        # 挡位调用统计钩子（回合级观测：llm_calls_by_tier；None = 无挂接）
        self._on_llm_call = on_llm_call
        self.samples = fixture_set_from_samples(samples_data)
        self.gate_fixtures = FixtureSet(
            name=f"{self.samples.name}.positive",
            cases=tuple(case for case in self.samples.cases if case.expected_pass),
        )
        self.negative_fixtures = FixtureSet(
            name=f"{self.samples.name}.negative",
            cases=tuple(case for case in self.samples.cases if not case.expected_pass),
        )
        distill = signals_data.get("distill") or {}
        # 蒸馏模型链（ENG12 接线3：resolve_distill_chain 真正派上用场）
        # — 当宿主注入 model_config 时按挡位建链注入 TieredDistiller，
        # 蒸馏走 LLM 路径（distill_async 入口可用）；未注入时链为 None，
        # 回落确定性蒸馏基线（防 model_config 缺配置时阻塞孵化）。
        tier = distill_tier or distill.get("tier") or DEFAULT_DISTILL_TIER
        chain = (
            resolve_distill_chain(model_config, tier) if model_config else None
        )
        self.distiller = TieredDistiller(
            config=DistillConfig.from_dict(distill),
            chain=chain,
            complexity_threshold=int(
                distill.get("complexity_threshold", DEFAULT_COMPLEXITY_THRESHOLD)
            ),
            intervention_threshold=int(
                distill.get("intervention_threshold", DEFAULT_INTERVENTION_THRESHOLD)
            ),
        )
        self.classifier = SignalClassifier(
            repeat_threshold=int(distill.get("repeat_threshold", REPEAT_THRESHOLD))
        )
        self.schema = build_entry_schema()
        self.gate = KnowledgeGate(l2_executor=GateL2FixtureExecutor())
        # 进化工厂（失败驱动反思式变异 + 三层闸门防退化；变异策略
        # 缺省确定性基线，LLM 反思变异为宿主注入扩展点）
        self.evolution = EvolutionFactory(gate=self.gate)

    # ── 信号感知 ──

    def classify(self, events: list[dict[str, Any]]) -> list[ExecutionSignal]:
        """【已废弃 · 孵化下沉引擎】轨迹事件 → 信号（孵化面无生产调用点）。

        孵化信号分类已由引擎 :class:`~ink_engine.core.growth.GrowthPipeline`
        自承载（回合事件流旁路监听 + 同因聚合）；本方法仅保留测试引用。
        """
        signals = [
            signal
            for event in events
            if (signal := self.classifier.classify(event)) is not None
        ]
        return self.classifier.aggregate(signals)

    def should_distill(
        self, *, complexity: int = 0, interventions: int = 0
    ) -> bool:
        """【已废弃 · 孵化下沉引擎】按需触发判定（双阈值保守）。

        蒸馏触发已由引擎 GrowthPipeline 回合收尾承载（复杂度/干预
        双阈值）；本方法仅保留测试引用。
        """
        return self.distiller.should_distill(
            complexity=complexity, interventions=interventions
        )

    def distill(
        self,
        signals: list[ExecutionSignal],
        query: str,
        *,
        level: str | None = None,
        kind: str | None = None,
    ) -> Any:
        """【已废弃 · 孵化下沉引擎】复用优先于生成（防知识膨胀）。

        蒸馏链路已由引擎 GrowthPipeline 承载（信号 → 按需蒸馏 → 三层
        闸门 → 知识集落位）；本方法仅保留测试引用。
        """
        return reuse_or_distill(
            self._runtime.knowledge_set,
            query,
            signals,
            self.distiller,
            level=level,
            kind=kind,
        )

    # ── 闸门与落库 ──

    async def verify_gate(
        self,
        entry: KnowledgeEntry,
        *,
        old_metrics: dict[str, float] | None = None,
        new_metrics: dict[str, float] | None = None,
    ) -> tuple[Any, Any, Any]:
        """【已废弃 · 孵化下沉引擎】三层闸门组合评估（L1/L2/L3）。

        闸门评估已由引擎 GrowthPipeline 落位边界承载；本方法仅保留
        测试引用（samples 完整含负面用例的语义契约）。

        L2 喂完整样例库（:attr:`samples`，负面/对抗用例不剥离）——内置
        谓词域按候选评估：规则类候选须让完整样例全绿（含负面），insight
        教训按闸门语义跳过规则执行（L1 注入扫描与形式校验已覆盖）；负面
        用例的领域谓词覆盖（has_fields/max_length/min_value/...）由
        exec 绑定测试与 Rust 域孵化同源承载（:attr:`negative_fixtures`
        显式记录，不静默丢弃）。
        """
        l1, l2, l3 = await self.gate.check(
            entry,
            schema=self.schema,
            fixtures=self.samples,
            old_metrics=old_metrics,
            new_metrics=new_metrics,
        )
        return l1, l2, l3

    async def sediment(self, entry: KnowledgeEntry) -> KnowledgeEntry:
        """【已废弃 · 孵化下沉引擎】带闸门落库（fail-closed）。

        落位已由引擎 GrowthPipeline 承载（三层闸门通过即知识集条目
        补丁链落位）；本方法仅保留测试引用。
        """
        await self._runtime.knowledge_set.verify_through_gate(
            entry,
            gate=self.gate,
            schema=self.schema,
            fixtures=self.samples,
        )
        return self._runtime.knowledge_set.add(entry)

    # ── 分层晋升 ──

    def _rescan_injection(
        self, entry: KnowledgeEntry, *, rationale: str | None = None
    ) -> list[str]:
        """晋升前注入复扫（蒸馏后候选晋升前按全字符串字段再扫一遍）。

        扫描面 = id/source/title/tags + data 递归字符串值与键名 + 提案
        rationale（rationale 同面）——蒸馏/归一/拼接可能在 L1 之后引入注入
        措辞，落库/落链前 fail-closed 复扫兜底（与 Rust 侧
        incubation.rs propose_knowledge_patch 复扫同口径）。命中清单
        （空 = 干净）。
        """
        texts = [entry.id, entry.source, entry.title, *entry.tags]
        texts.extend(_string_values_of(entry.data))
        texts.extend(_string_keys_of(entry.data))
        if rationale:
            texts.append(rationale)
        hits: list[str] = []
        for text in texts:
            if text:
                hits.extend(scan_text_injection(text))
        return list(dict.fromkeys(hits))

    def promote(
        self, entry_id: str, *, to_level: str | None = None
    ) -> KnowledgeEntry:
        """【已废弃 · 孵化下沉引擎】晋升：条目层级迁移（work → project → user）。

        晋升已由引擎 KnowledgeSet.promote 承载（桥 op knowledge.promote
        直连）；本方法仅保留测试引用。

        晋升前注入复扫——蒸馏后候选可能在归一/拼接时引入注入措辞，
        迁移前按全字符串字段再扫一遍（fail-closed，命中即拒）。
        """
        entry = self._runtime.knowledge_set.get(entry_id)
        if entry is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        hits = self._rescan_injection(entry)
        if hits:
            raise GraphDefinitionError(
                f"知识晋升前注入复扫未通过（指令注入命中: {'；'.join(hits)}）"
            )
        return self._runtime.knowledge_set.promote(entry_id, to_level=to_level)

    # ── 可移植（导出/导入）──

    def export(self) -> dict[str, Any]:
        """【已废弃 · 孵化下沉引擎】知识集导出（桥 op knowledge.export 直连）。

        导出已由桥 op 直连引擎 KnowledgeSet.export；本方法仅保留测试引用。
        """
        return self._runtime.knowledge_set.export()

    def export_entry_summary(self, entry_id: str) -> dict[str, Any]:
        """【已废弃 · 孵化下沉引擎】单条目导出摘要（仅保留测试引用）。"""
        entry = self._runtime.knowledge_set.get(entry_id)
        if entry is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        return entry.to_dict()

    # ── 评审-收敛（引擎 core.review 机制：review.json 数据驱动）──

    async def review_and_converge(
        self,
        llm: Any,
        candidates: list[str],
        *,
        context: dict[str, Any] | None = None,
    ) -> Any:
        """【已废弃 · 孵化下沉引擎】评审-收敛循环（仅保留测试引用）。

        评审收敛由引擎 core.review 机制承载（review.json 数据驱动）；
        本方法无生产调用点。

        review.json（pass_threshold/max_rounds/beam_width/neutral_score/
        dimensions）数据驱动；LLM 缺省/评审失败 = fail-open 中性分
        （评审是 best-effort 增强，不阻断主流程）。治理类调用归因
        audit 挡（W8.3：review_pipeline+knowledge_domain main→audit；
        缺省回落 main 链，fail-open 中性分保留）。
        """
        from .review_pipeline import converge_candidates

        return await converge_candidates(
            llm,
            self.review_data,
            candidates,
            dimensions=list(self.review_data.get("dimensions") or []),
            context=context,
            tier="audit",
            on_llm_call=self._on_llm_call,
        )

    async def distill_llm(
        self,
        signals: list[ExecutionSignal],
        *,
        llm_distill: Any = None,
    ) -> dict[str, Any] | None:
        """【已废弃 · 孵化下沉引擎】LLM 蒸馏入口（仅保留测试引用）。

        蒸馏已由引擎 GrowthPipeline 承载（TieredDistiller 双阈值按需
        蒸馏）；本方法无生产调用点。

        领域蒸馏 prompt 由宿主经 ``llm_distill``（签名
        ``(chain, signals) -> dict | None``）注入；chain = host
        挡位链的 router 挡（缺失回落 main；全缺 = 确定性蒸馏基线）。
        """
        if self.distiller.chain is None:
            return await self.distiller.distill(signals)
        if self._on_llm_call is not None:
            self._on_llm_call("router")
        return await self.distiller.distill_async(signals, llm_distill=llm_distill)

    # ── 自指挂载（知识补丁走集补丁链：审批 → 审计 → 可回退）──

    async def propose_knowledge_patch(
        self,
        ctx: Any,
        entry: KnowledgeEntry,
        rationale: str,
        *,
        round_id: str | None = None,
    ) -> Any:
        """知识条目 → KNOWLEDGE 补丁提案（集补丁链自指挂载形态）。

        落链前注入复扫（entry 全字符串字段 + rationale 同面，与
        Rust 侧 incubation.rs 复扫同口径；命中 = fail-closed，不触碰
        引擎通道）。
        """
        hits = self._rescan_injection(entry, rationale=rationale)
        if hits:
            raise GraphDefinitionError(
                f"知识补丁晋升前复扫未通过（指令注入命中: {'；'.join(hits)}）"
            )
        base_version = await self._runtime.self_pipeline.chain.current_version()
        proposal = SelfProposal(
            kind=PatchKind.KNOWLEDGE,
            payload={"entry": entry.to_dict()},
            base_version=base_version,
            rationale=rationale,
        )
        return await self._runtime.self_pipeline.apply(
            ctx, proposal, round_id=round_id
        )

    # ── 进化工厂（失败驱动反思式变异 + 三层闸门防退化）──

    def record_usage(
        self, entry_id: str, *, failed: bool = False, log: str = ""
    ) -> None:
        """知识调用留痕（usage_count/fail_count + 失败日志）。

        失败日志 = 反思式变异的输入（进化工厂按近期失败定向修订）；
        知识利用点（复用命中/失败）由宿主调用。
        """
        self._runtime.knowledge_set.record_usage(entry_id, failed=failed, log=log)

    def evolution_candidates(self) -> list:
        """进化候选：失败率优先入队（次之长期未调用，稳定者不入队）。

        失败日志取条目自身留痕（record_usage 的反思式变异输入汇集）。
        """
        entries = self._runtime.knowledge_set.entries()
        return EvolutionFactory.rank(
            EvolutionFactory.collect_candidates(
                entries,
                failure_logs={e.id: e.failure_logs for e in entries if e.failure_logs},
            )
        )

    async def evolve(
        self,
        ctx: Any,
        *,
        limit: int = 1,
        round_id: str | None = None,
    ) -> list[EvolutionOutcome]:
        """进化批次：候选按优先级逐条变异 → 三层闸门（防退化）→ 落补丁链。

        变异体落库 = KNOWLEDGE 补丁（审批分级 → 审计 → 可回退，链为
        权威）；变异策略缺省确定性基线（零 LLM 可断言），LLM 反思变异
        经 ``self.evolution`` 的 mutation 注入（宿主扩展点）。L3 防退化
        （ENG1-1）：old_metrics 按母体条目调用留痕构造（
        :func:`entry_metrics`）传入——变异体不差于母体才过 L3，不再
        退化为「L1+L2 通过即替换」。
        """
        outcomes: list[EvolutionOutcome] = []
        for candidate in self.evolution_candidates()[:limit]:
            outcome = await self.evolution.evolve(
                candidate,
                schema=self.schema,
                fixtures=self.samples,
                old_metrics=entry_metrics(candidate.entry),
            )
            for variant in outcome.variants:
                await self.propose_knowledge_patch(
                    ctx,
                    variant,
                    rationale=f"进化变异：基于 {candidate.entry.id}"
                    f"（失败率 {candidate.failure_rate:.2f}）",
                    round_id=round_id,
                )
            outcomes.append(outcome)
        return outcomes


def entry_from_distill(outcome: DistillOutcome, entry_id: str) -> KnowledgeEntry:
    """蒸馏产物 → 知识条目（insight 教训形态；来源/标签/标题继承）。"""
    data = dict(outcome.data)
    return KnowledgeEntry(
        id=entry_id,
        level="work",
        kind=str(data.get("kind") or KIND_INSIGHT),
        data=data,
        source=outcome.source,
        title=outcome.title or "孵化沉淀",
        tags=tuple(outcome.tags),
        credibility=0.7,
    )


__all__ = [
    "REVIEW_PASS_THRESHOLD_KEY",
    "IncubationDomain",
    "build_entry_schema",
    "entry_from_distill",
    "fixture_set_from_samples",
]

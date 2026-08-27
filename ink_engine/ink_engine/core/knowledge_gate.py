"""知识验证闸门三层（L1 准入 → L2 效果评估 → L3 目标筛选）——质量底线。

华为云评估管道形态的引擎实现：
- **L1 准入**：schema 校验（形式合法）+ 安全扫描（不越权/危险操作 +
  指令注入检测）+ 最小功能测试（简化用例可加载执行）——形式与安全
  关，最廉价最先过；
- **L2 效果评估**：完整 fixtures（知识创建时自动合成的正常/边缘/对抗
  用例 + 历史执行日志采样的高价值回归用例）全绿；记录准确率/延迟/
  token 消耗/安全合规评分——**样例测试为非谈判项**（fixture 全绿才
  可进入 L3）；
- **L3 目标筛选**：新知识不差于旧版且至少一维严格优于才保留；多样性
  保留（多维显著优势的变体并存，为下轮进化提供样本）；用户可配置人工
  审核（默认弹卡，可关）作为 L3 之上的可选人工层。

指令注入检测（web 蒸馏引入 prompt injection 的防线）：规则文本是声明
数据，L1 安全扫描须能区分「内容」与「指令」——检出「忽略上文/你是
助手/输出格式覆盖」等指令型措辞即拒绝（恶意网页内容学进规则集会让
规则本身成为注入载体）。
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

from .exceptions import FixtureGateError, GraphDefinitionError
from .knowledge_set import KIND_INSIGHT, KnowledgeEntry
from .rules import (
    FixtureResult,
    FixtureSet,
    RuleEngine,
    RuleSet,
    RuleTypeRegistry,
    assert_fixtures_pass,
)
from .schema_validator import SchemaSpec, SchemaValidator

# L2 耗时 → L3 latency 维度的归一化基准（10000ms = 满分基线，超出
# 线性衰减到 0；ENG1-4 建议项落地：硬编码魔法数字提为常量）
LATENCY_NORM_MS = 10000.0

# L1 安全扫描：指令注入检测的命中模式（声明数据中的「指令型」措辞）。
# 规则文本是知识不是指令：检出即拒绝——防 web 注入规则成为注入载体。
# 中英文指令句式均收录（web 蒸馏是注入主要入口，英文形态不可漏）；
# 匹配前做归一化（全角转半角、去空白、小写），空格/全角混淆变体
# 同样可命中。
_INJECTION_PATTERNS = (
    # 中文指令型措辞
    "忽略上文",
    "忽略之前",
    "忽略上面的所有指令",
    "无视之前",
    "忘记所有",
    "你是助手",
    "你现在是",
    "重新定义你",
    "覆盖你的",
    "系统指令",
    "输出格式覆盖",
    "不要遵守",
    "绕过",
    # 英文指令型措辞（web 来源注入的主要形态）
    "ignore all previous instructions",
    "ignore previous instructions",
    "ignore above",
    "disregard",
    "forget all previous",
    "you are now",
    "from now on",
    "system prompt",
    "system instruction",
    "override your",
    "jailbreak",
    "do not follow",
    "new instructions",
    "print your",
    "reveal your",
)


def _normalize_injection_text(text: str) -> str:
    """注入检测归一化：全角转半角 + 去空白 + 小写（防混淆变体绕过）。"""
    chars: list[str] = []
    for ch in text.lower():
        code = ord(ch)
        if code == 0x3000:
            ch = " "
        elif 0xFF01 <= code <= 0xFF5E:
            ch = chr(code - 0xFEE0)
        if not ch.isspace():
            chars.append(ch)
    return "".join(chars)


# 熵启发（ENG1-21）：静态关键词对 base64/编码形态覆盖有限——归一化
# 文本中大小写/数字三类字符集混合 + 符号占比合理 = 疑似编码混淆块，
# 作为关键词之外的补充判据（保守阈值见 _obfuscation_entropy_hits）。


def _obfuscation_entropy_hits(text: str) -> tuple[str, ...]:
    """混淆熵启发信号：疑似 base64/编码混淆块的指纹（ENG1-21）。

    静态关键词对 base64/编码形态覆盖有限，熵启发作为补充判据。判据
    保守设计（压低自然文本/路径误伤）：
    - 归一化文本长度 ≥ 24（编码块最小有意义长度；短路径/短语不触发）；
    - **原文**同时含大写/小写字母与数字（大小写是编码形态指纹，归一化
      会小写化抹掉该信号——必须在原文上判定；自然语言连续片段很少
      三类字符集齐备）；
    - 符号占比 ≤ 0.5（纯符号噪声不判；base64 自带 ``+`` ``/`` 与
      ``=`` 填充，占比天然低于自然符号堆）。
    该信号只做「疑似」标记，随命中清单返回（调用方按 L1 拒绝语义
    处理，与关键词命中同权）。
    """
    normalized = _normalize_injection_text(text)
    if len(normalized) < 24:
        return ()
    # 大小写类判定用原文（归一化小写化会抹掉编码形态的大小写信号）
    has_upper = any(ch.isupper() for ch in text)
    has_lower = any(ch.islower() for ch in text)
    has_digit = any(ch.isdigit() for ch in text)
    if not (has_upper and has_lower and has_digit):
        return ()
    symbol_ratio = 1.0 - sum(
        1 for ch in normalized if ch.isalnum()
    ) / len(normalized)
    if symbol_ratio > 0.5:
        return ()
    return ("疑似编码混淆（base64 形态指纹：大小写数字混合）",)


def scan_text_injection(
    text: str, *, patterns: tuple[str, ...] = _INJECTION_PATTERNS
) -> tuple[str, ...]:
    """指令注入检测（纯文本形态，公开入口）。

    供检索结果/外部内容等不可信文本进入上下文前扫描（web 检索注入
    防线）；命中清单（空 = 干净）。归一化与命中语义与知识条目扫描
    同源——全角/空格混淆变体与英文句式同样可命中；熵启发（ENG1-21）
    作为关键词之外的补充信号（疑似编码混淆也入清单）。命中即拒：检出
    指令型措辞的文本不得进入模型上下文。
    """
    normalized = _normalize_injection_text(text)
    if not normalized:
        return ()
    hits: list[str] = []
    for pattern in patterns:
        if _normalize_injection_text(pattern) in normalized:
            hits.append(pattern)
    hits.extend(_obfuscation_entropy_hits(text))
    return tuple(dict.fromkeys(hits))


def _string_values(data: Any, *, depth: int = 0) -> list[str]:
    """递归提取条目数据中的字符串值（注入检测的文本面）。"""
    if depth > 8:
        return []
    if isinstance(data, str):
        return [data]
    if isinstance(data, dict):
        out: list[str] = []
        for value in data.values():
            out.extend(_string_values(value, depth=depth + 1))
        return out
    if isinstance(data, (list, tuple)):
        out = []
        for item in data:
            out.extend(_string_values(item, depth=depth + 1))
        return out
    return []


def _string_keys(data: Any, *, depth: int = 0) -> list[str]:
    """递归提取条目数据中的字符串键名（指令注入的键位面）。

    键名也能携带指令措辞（如把整句注入句式作为字段名）——与值同等
    扫描；常规结构键以下划线/点号分隔，与指令句式（含空格的完整措辞）
    天然不冲突，误伤面可忽略。
    """
    if depth > 8:
        return []
    if isinstance(data, dict):
        out: list[str] = []
        for key, value in data.items():
            if isinstance(key, str):
                out.append(key)
            out.extend(_string_keys(value, depth=depth + 1))
        return out
    if isinstance(data, (list, tuple)):
        out = []
        for item in data:
            out.extend(_string_keys(item, depth=depth + 1))
        return out
    return []


@dataclass(frozen=True, slots=True)
class GateL1Result:
    """L1 准入结果（形式合法 + 安全扫描 + 最小功能）。"""

    passed: bool
    errors: tuple[str, ...] = ()
    injection_hits: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "errors": list(self.errors),
            "injection_hits": list(self.injection_hits),
        }


@dataclass(frozen=True, slots=True)
class GateL2Result:
    """L2 效果评估结果（完整 fixtures + 回归，含指标留痕）。"""

    passed: bool
    fixture_results: tuple[FixtureResult, ...] = ()
    accuracy: float = 0.0  # 样例通过率（0-1）
    latency_ms: float = 0.0  # 样例评估总耗时（毫秒，指标留痕）
    token_cost: int = 0  # token 消耗（机制件统计口径；LLM 判定时由实现方填报）
    safety_score: float = 1.0  # 安全合规评分（0-1；L1 通过 = 满分基线）
    regression_samples: int = 0  # 历史回归用例数（采样补充的样本量）
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "accuracy": self.accuracy,
            "latency_ms": self.latency_ms,
            "token_cost": self.token_cost,
            "safety_score": self.safety_score,
            "regression_samples": self.regression_samples,
            "note": self.note,
            "fixtures": [
                {
                    "case_id": r.case_id,
                    "passed": r.passed,
                    "reason": r.reason,
                }
                for r in self.fixture_results
            ],
        }


@dataclass(frozen=True, slots=True)
class GateL3Result:
    """L3 目标筛选结果（不差于旧版 + 至少一维严格优于 / 多样性保留）。"""

    passed: bool
    reason: str = ""
    dimension_improvements: tuple[str, ...] = ()  # 严格优于的维度
    diversity_kept: bool = False  # 多样性保留（变体并存，供下轮进化）

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "reason": self.reason,
            "dimension_improvements": list(self.dimension_improvements),
            "diversity_kept": self.diversity_kept,
        }


@runtime_checkable
class KnowledgeExecutor(Protocol):
    """L2 效果评估的执行器协议（引擎规定契约，执行体由使用方注入）。

    实现方负责「把知识作为规则加载并评估样例」的领域语义（如规则引擎
    加载规则集跑 fixture），引擎只规定输入输出形态与失败兜底。

    context_rules：上下文规则集声明（旧集 + 候选合并评估的基底；
    None = 仅按候选自身评估）——样例面向整套规则集设计时，单条候选
    无法单独全绿，合并后按整套语义评估。
    """

    async def run(
        self,
        entry: KnowledgeEntry,
        fixtures: FixtureSet,
        *,
        context_rules: dict[str, Any] | None = None,
    ) -> GateL2Result: ...


class GateL2FixtureExecutor:
    """L2 默认执行器：规则条目经规则引擎跑完整 fixtures（确定性基线）。

    对 kind=rule 条目（data 为 Rule 声明形态）：组装 RuleSet → 样例库
    全量评估——样例测试为非谈判项（fixture 全绿才可进入 L3），失败
    明细随结果留痕；非规则条目（模板/权重/工具规则）无法按规则引擎
    评估 = 显式拒绝（由使用方注入领域执行器，不静默放行）。

    kind=insight（教训）条目例外：教训 = 经验文本，无谓词实现（执行件
    不进知识集），不存在「规则效果」可测——L2 跳过规则执行（L1 注入
    扫描 + 形式校验已覆盖其安全与结构），显式放行并在 note 留痕。

    context_rules 提供时按「旧规则集 + 候选规则」合并评估：样例面向
    整套规则集语义设计（如领域种子样例库），单条新规则无法独立全绿，
    合并后旧集与候选按同一套语义共同判定。
    """

    def __init__(self, registry: RuleTypeRegistry | None = None) -> None:
        self._schema_validator = SchemaValidator()
        self._registry = registry

    async def run(
        self,
        entry: KnowledgeEntry,
        fixtures: FixtureSet,
        *,
        context_rules: dict[str, Any] | None = None,
    ) -> GateL2Result:
        if entry.kind == KIND_INSIGHT:
            return GateL2Result(
                passed=True,
                note="insight 教训条目（无执行语义，L2 跳过规则执行；"
                "L1 注入扫描与形式校验已覆盖）",
            )
        if entry.kind != "rule":
            return GateL2Result(
                passed=False,
                note=f"非规则条目（kind={entry.kind}）需注入领域执行器",
            )
        raw_rule = entry.data.get("rule")
        if not isinstance(raw_rule, dict):
            return GateL2Result(passed=False, note="规则条目缺 data.rule 声明")
        try:
            if context_rules is not None:
                merged = dict(context_rules)
                rules = list(merged.get("rules") or [])
                rules.append(raw_rule)
                merged["rules"] = rules
                rule_set = RuleSet.parse(merged, registry=self._registry)
            else:
                rule_set = RuleSet.parse(
                    {"name": f"entry-{entry.id}", "rules": [raw_rule]},
                    registry=self._registry,
                )
        except GraphDefinitionError as exc:
            return GateL2Result(passed=False, note=f"规则声明非法: {exc}")
        start = time.monotonic()
        try:
            assert_fixtures_pass(rule_set, fixtures, engine=RuleEngine(self._registry))
        except (FixtureGateError, GraphDefinitionError) as exc:
            return GateL2Result(
                passed=False,
                accuracy=0.0,
                latency_ms=(time.monotonic() - start) * 1000,
                note=str(exc),
            )
        return GateL2Result(
            passed=True,
            accuracy=1.0,
            latency_ms=(time.monotonic() - start) * 1000,
            regression_samples=len(fixtures.cases),
        )


@runtime_checkable
class HumanReviewer(Protocol):
    """L3 之上可选人工审核层的审核者协议（引擎规定契约，实现由宿主注入）。

    语义：新知识过了 L1/L2/L3 后，是否还需人工确认——返回 True = 人工
    通过；False = 拒绝落库。默认实现见 :class:`ReviewCardPolicy`（默认
    弹卡，可关）；宿主接入审核卡 UI 时按自身产品形态实现本协议。
    """

    async def review(self, entry: KnowledgeEntry, l3: GateL3Result) -> bool: ...


class ReviewCardPolicy:
    """默认人工审核策略：默认弹卡（需人工确认才放行），可关。

    ``enabled=True``（默认）：审核卡弹出语义——引擎不代用户批准，任何
    知识落库前须经人工确认（review 返回 False 直到宿主确认放行）；
    ``enabled=False`` = 关闭人工层，知识自动落库（与未配置审核者等价）。

    宿主接入真实审核卡 UI 时实现 :class:`HumanReviewer` 协议替换本默认
    策略——本类只表达「默认弹卡、可关」的机制语义。
    """

    def __init__(self, *, enabled: bool = True) -> None:
        self.enabled = enabled

    async def review(self, entry: KnowledgeEntry, l3: GateL3Result) -> bool:
        # 弹卡语义：需要人工确认——未确认前不放行（确定性基线，宿主
        # UI 审核流接管后返回真实裁决）；enabled=False = 关闭人工层
        return not self.enabled


def _default_l3_metrics(
    entry: KnowledgeEntry, l2: GateL2Result
) -> dict[str, float]:
    """L3 缺省维度指标派生（未注入 new_metrics 时的兜底口径）。

    - 规则类条目：accuracy = L2 样例通过率（效果的真实度量）；
    - insight 教训条目：无规则执行语义（L2 跳过执行，accuracy 恒 0.0
      是「未测量」而非「劣」）——缺省派生不含 accuracy，避免与母体
      派生指标（调用留痕成功率）比较时产生虚假的「劣于旧版」误判，
      只留 latency/safety 中性维度（与旧版可比且不产生虚假优劣）；
    - latency = 1 - min(latency_ms / LATENCY_NORM_MS, 1)（耗时归一化）；
    - safety = L2 安全合规评分（L1 通过 = 满分基线）。
    """
    latency = 1.0 - min(l2.latency_ms / LATENCY_NORM_MS, 1.0)
    metrics: dict[str, float] = {"latency": latency, "safety": l2.safety_score}
    if entry.kind != KIND_INSIGHT:
        metrics["accuracy"] = l2.accuracy
    return metrics


class KnowledgeGate:
    """知识验证闸门（三层组合入口：L1 → L2 → L3 顺序执行）。

    Attributes:
        schema_validator: schema 校验执行体（L1 形式合法关）。
        l2_executor: L2 效果评估执行器（None = 默认规则引擎执行器）。
        injection_patterns: 指令注入检测模式（可覆盖，默认内置基线）。
        registry: 谓词注册表（L1 简化用例执行与默认 L2 执行器共用；
            None = 仅内置通用谓词）。
        human_reviewer: L3 之上的可选人工审核层（None = 不启用）。
        human_review_enabled: 人工审核开关（默认弹卡；False = 关闭）。
    """

    def __init__(
        self,
        *,
        schema_validator: SchemaValidator | None = None,
        l2_executor: KnowledgeExecutor | None = None,
        injection_patterns: tuple[str, ...] = _INJECTION_PATTERNS,
        registry: RuleTypeRegistry | None = None,
        human_reviewer: HumanReviewer | None = None,
        human_review_enabled: bool = True,
    ) -> None:
        self.schema_validator = schema_validator or SchemaValidator()
        self.registry = registry
        self.l2_executor = l2_executor or GateL2FixtureExecutor(registry=registry)
        self.injection_patterns = injection_patterns
        self.human_reviewer = human_reviewer
        self.human_review_enabled = human_review_enabled

    # ── L1 准入：schema 校验 + 安全扫描（指令注入）+ 最小功能 ──

    def check_l1(
        self,
        schema: SchemaSpec,
        entry: KnowledgeEntry,
        *,
        security_scan: dict[str, Any] | None = None,
        minimal_fixtures: FixtureSet | None = None,
    ) -> GateL1Result:
        """L1 准入：形式合法 + 安全扫描 + 最小功能测试。

        Args:
            schema: 知识条目的 schema 声明（字段口径校验）。
            entry: 待准入知识条目。
            security_scan: 使用方安全扫描附加检查（返回 False 键 = 拒绝
                原因；None = 跳过附加检查——指令注入检测恒执行）。
            minimal_fixtures: 最小功能测试的简化用例（可加载执行的
                轻量样例；None = 只做「可加载」关——规则条目须能被
                规则集解析器加载，非规则条目跳过最小功能关）。

        Returns:
            GateL1Result：passed = 三层子关全过；errors 含全部失败原因。
        """
        errors: list[str] = []
        schema_errors = self.schema_validator.validate(schema, entry.to_dict())
        errors.extend(schema_errors)
        injection_hits = self._scan_injection(entry)
        errors.extend(f"指令注入检测命中: {hit}" for hit in injection_hits)
        if security_scan:
            for key, ok in security_scan.items():
                if ok is False:
                    errors.append(f"安全扫描未通过: {key}")
        errors.extend(self._minimal_functional_test(entry, minimal_fixtures))
        if errors:
            return GateL1Result(
                passed=False, errors=tuple(errors), injection_hits=injection_hits
            )
        return GateL1Result(passed=True)

    def _minimal_functional_test(
        self, entry: KnowledgeEntry, minimal_fixtures: FixtureSet | None
    ) -> list[str]:
        """最小功能测试执行：简化用例可加载执行（L1 的第三子关）。

        语义（计划 L1「最小功能测试（简化用例可加载执行）」落地）：
        - 规则条目恒做「可加载」关——data.rule 必须能被规则集解析器
          加载（无法加载 = 声明层面不可执行，形式合法但功能不可用）；
        - 提供简化用例（minimal_fixtures）时进一步执行：轻量样例全绿
          才算通过（完整样例在 L2，L1 只做最廉价的执行冒烟）；
        - 非规则条目无规则引擎执行语义：不提供简化用例时跳过本关
          （执行语义由领域执行器承接），提供时显式拒绝（fail-closed，
          不静默放行未定义语义的简化用例）。
        """
        if entry.kind != "rule":
            if minimal_fixtures is not None:
                return [
                    "最小功能测试: 非规则条目无法执行简化用例"
                    "（需注入领域执行器）"
                ]
            return []
        raw_rule = entry.data.get("rule")
        if not isinstance(raw_rule, dict):
            return ["最小功能测试: 规则条目缺 data.rule 声明（无法加载）"]
        try:
            rule_set = RuleSet.parse(
                {"name": f"entry-{entry.id}", "rules": [raw_rule]},
                registry=self.registry,
            )
        except GraphDefinitionError as exc:
            return [f"最小功能测试: 规则声明无法加载: {exc}"]
        if minimal_fixtures is None:
            return []
        try:
            assert_fixtures_pass(
                rule_set, minimal_fixtures, engine=RuleEngine(self.registry)
            )
        except FixtureGateError as exc:
            return [f"最小功能测试: 简化用例未全绿: {exc}"]
        return []

    def _scan_injection(self, entry: KnowledgeEntry) -> tuple[str, ...]:
        """指令注入检测：知识可读文本中的指令型措辞命中清单。

        扫描面 = 标题/标签 + 条目数据内的字符串值与键名（键位注入与
        值位注入同属注入载体；常规结构键以分隔符拼合，与含空格的指令
        句式不冲突）；匹配前归一化（全角转半角、去空白、小写）——
        空格/全角混淆变体与英文句式同样可命中；熵启发（ENG1-21）补充
        编码混淆信号。检出指令型措辞即拒绝该知识落库。
        """
        texts = [entry.title, *entry.tags]
        texts.extend(_string_values(entry.data))
        texts.extend(_string_keys(entry.data))
        joined = " ".join(texts)
        normalized = _normalize_injection_text(joined)
        hits: list[str] = []
        for pattern in self.injection_patterns:
            if _normalize_injection_text(pattern) in normalized:
                hits.append(pattern)
        hits.extend(_obfuscation_entropy_hits(joined))
        return tuple(dict.fromkeys(hits))

    # ── L2 效果评估：完整 fixtures（非谈判项）──

    async def check_l2(
        self,
        entry: KnowledgeEntry,
        fixtures: FixtureSet,
        *,
        regression: FixtureSet | None = None,
        context_rules: dict[str, Any] | None = None,
    ) -> GateL2Result:
        """L2 效果评估：完整 fixtures + 历史回归用例，fixture 全绿才通过。

        Args:
            entry: 待评估知识条目。
            fixtures: 完整样例库（正常/边缘/对抗用例，合成或采集）。
            regression: 历史回归用例（追加进评估；None = 不追加）。
            context_rules: 上下文规则集声明（旧集 + 候选合并评估；None =
                仅按候选自身评估——样例面向整套规则集设计时传旧集合并）。

        Returns:
            GateL2Result：passed = 样例全绿；指标（准确率/耗时/token/
            安全评分）随结果留痕。
        """
        combined = fixtures
        if regression and regression.cases:
            combined = FixtureSet(
                name=f"{fixtures.name}+regression",
                cases=fixtures.cases + regression.cases,
            )
        result = await self.l2_executor.run(
            entry, combined, context_rules=context_rules
        )
        if result.passed and regression:
            result = GateL2Result(
                passed=True,
                fixture_results=result.fixture_results,
                accuracy=result.accuracy,
                latency_ms=result.latency_ms,
                token_cost=result.token_cost,
                safety_score=result.safety_score,
                regression_samples=len(regression.cases),
                note=result.note,
            )
        return result

    # ── L3 目标筛选：不差于旧版 + 至少一维严格优于 / 多样性保留 ──

    def check_l3(
        self,
        new_metrics: dict[str, float],
        old_metrics: dict[str, float] | None,
        *,
        diversity: bool = True,
    ) -> GateL3Result:
        """L3 目标筛选：新知识不差于旧版且至少一维严格优于才保留。

        Args:
            new_metrics: 新知识维度指标（accuracy/latency/token/safety…）。
            old_metrics: 旧版同维度指标（None = 无旧版，首版直接通过）。
            diversity: 多样性保留开关（多维显著优势的变体并存，为下轮
                进化提供样本；True = 严格优于也可保留，不要求全面占优）。

        Returns:
            GateL3Result：passed = 通过；reason 说明判定依据。
        """
        if old_metrics is None or not old_metrics:
            return GateL3Result(
                passed=True,
                reason="无旧版可比（首版/空旧版直接保留）",
            )
        common = set(new_metrics) & set(old_metrics)
        if not common:
            raise GraphDefinitionError(
                "新旧版本无共同维度可比（口径漂移会让目标筛选失真）"
            )
        worsened = [
            dim
            for dim in common
            if new_metrics[dim] < old_metrics[dim] - 1e-9
        ]
        if worsened:
            return GateL3Result(
                passed=False,
                reason=f"劣于旧版: {worsened}（不差于旧版是保留前提）",
            )
        improved = [
            dim
            for dim in common
            if new_metrics[dim] > old_metrics[dim] + 1e-9
        ]
        if improved:
            return GateL3Result(
                passed=True,
                reason=f"至少一维严格优于: {improved}",
                dimension_improvements=tuple(improved),
                diversity_kept=diversity,
            )
        # 无劣化也无严格优于：等价版本不重复保留（防知识膨胀）——除非
        # 多样性保留显式开启（变体并存为进化提供样本）
        if diversity:
            return GateL3Result(
                passed=True,
                reason="等价版本按多样性保留（变体并存，供下轮进化）",
                diversity_kept=True,
            )
        return GateL3Result(
            passed=False,
            reason="与旧版等价且多样性保留关闭（无新增价值不落库）",
        )

    # ── 组合入口：L1 → L2 → L3 顺序执行（短路：前关不过不后走）──

    async def check(
        self,
        entry: KnowledgeEntry,
        *,
        schema: SchemaSpec,
        fixtures: FixtureSet,
        old_metrics: dict[str, float] | None = None,
        new_metrics: dict[str, float] | None = None,
        regression: FixtureSet | None = None,
        context_rules: dict[str, Any] | None = None,
        security_scan: dict[str, Any] | None = None,
        minimal_fixtures: FixtureSet | None = None,
        diversity: bool = True,
    ) -> tuple[GateL1Result, GateL2Result, GateL3Result]:
        """三层闸门组合入口（华为云评估管道语义：逐层收口）。

        L3 之上的可选人工审核层：通过三层后若配置了人工审核者且开关
        开启（默认弹卡），须人工确认才放行——拒绝则 L3 结果为未通过。

        context_rules：L2 合并评估的上下文规则集（旧集 + 候选；样例
        面向整套规则集设计时传入，None = 仅按候选自身评估）。

        Returns:
            (l1, l2, l3)：三层结果；l1 不过时 l2/l3 为未执行占位
            （passed=False，note 说明短路原因）。
        """
        l1 = self.check_l1(
            schema, entry, security_scan=security_scan, minimal_fixtures=minimal_fixtures
        )
        if not l1.passed:
            return l1, GateL2Result(passed=False, note="L1 未通过（短路）"), GateL3Result(
                passed=False, reason="L1 未通过（短路）"
            )
        l2 = await self.check_l2(
            entry, fixtures, regression=regression, context_rules=context_rules
        )
        if not l2.passed:
            return l1, l2, GateL3Result(
                passed=False, reason="L2 样例测试未全绿（非谈判项）"
            )
        metrics = new_metrics or _default_l3_metrics(entry, l2)
        l3 = self.check_l3(metrics, old_metrics, diversity=diversity)
        if l3.passed and self.human_reviewer is not None and self.human_review_enabled:
            approved = await self.human_reviewer.review(entry, l3)
            if not approved:
                l3 = GateL3Result(
                    passed=False,
                    reason="人工审核未通过（L3 之上可选人工层，默认弹卡可关）",
                )
        return l1, l2, l3


__all__ = [
    "GateL1Result",
    "GateL2FixtureExecutor",
    "GateL2Result",
    "GateL3Result",
    "HumanReviewer",
    "KnowledgeExecutor",
    "KnowledgeGate",
    "ReviewCardPolicy",
    "scan_text_injection",
]

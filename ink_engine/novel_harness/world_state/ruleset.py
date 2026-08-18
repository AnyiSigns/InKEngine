"""世界状态写时校验的声明式规则集（核声明式化：校验语义 = 规则数据）。

世界状态写时校验（因果链/伏笔链/信息差/指纹禁忌）以**规则集数据**
（谓词名 + 参数）承载，执行语义由注册谓词承接——「核不用写」：
规则 = 数据（可版本化/回退/导出导入），机制 = 注册谓词 + 引擎。
校验入口为 :func:`check_world_state_rules`（确定性规则 + 可选 LLM
钩子的混合判定，fail-open）。

数据契约：规则集与样例库均为 JSON 兼容数据（随补丁链版本化/导出导入）；
评估输入 = 校验入口构造的**视图**（:func:`_build_view`），规则按视图
字段取值，运行时参数（输入文本/目标角色/事实清单）随视图携带——规则集
保持静态，参数走数据。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.rules import (
    FixtureCase,
    FixtureSet,
    Rule,
    RuleCheckResult,
    RuleEngine,
    RuleSet,
    RuleTypeRegistry,
)
from ink_engine.novel_harness.narrative_state import (
    NARRATIVE_STATUSES,
    STATUS_RESOLVED,
)

from .issues import (
    ISSUE_CAUSAL,
    ISSUE_FINGERPRINT,
    ISSUE_FORESHADOWING,
    ISSUE_KNOWLEDGE_GAP,
    SEVERITY_ERROR,
    SEVERITY_WARNING,
)
from .models import WorldState, _key

# 规则集/样例库名称（知识集内引用的稳定键）
WORLD_STATE_RULE_SET = "novel.world_state"
WORLD_STATE_FIXTURES = "novel.world_state.fixtures"

# 视图字段（校验入口与谓词共用的数据契约键）
_VIEW_WORLD = "world"
_VIEW_TEXT = "text"
_VIEW_CHARACTER_ID = "character_id"
_VIEW_FACT_IDS = "fact_ids"
_VIEW_AT_CHAPTER = "at_chapter"
_VIEW_CHARACTER_NAME = "character_name"
_VIEW_FINGERPRINT = "fingerprint"


# -- 领域谓词（注册进 RuleTypeRegistry，与内置通用谓词并存） --------------------


def _world_from_view(context: dict[str, Any] | None) -> dict[str, Any]:
    """评估上下文中取世界状态视图（root = 评估数据对象，由引擎注入）。"""
    root = (context or {}).get("root")
    if isinstance(root, dict):
        world = root.get(_VIEW_WORLD)
        if isinstance(world, dict):
            return world
    return {}


def _pred_causal_event_exists(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """causal_event_exists：因果边两端事件必须存在（悬空边 = 跨章追踪断链）。

    config: {event_id_path}——从每条因果边条目取值事件 id，按世界状态
    事件表核对存在性；缺失 = 违规。
    """
    if not isinstance(target, list):
        return []
    world = _world_from_view(context)
    events = world.get("events") or {}
    path = config.get("event_id_path")
    issues: list[dict[str, Any]] = []
    for link in target:
        event_id = str(link.get(path) or "") if isinstance(link, dict) else ""
        # 空/缺失事件 id 与不存在事件同判（对空 id 同样返回 None = 悬空引用）
        if event_id not in events:
            issues.append(
                {
                    "message": f"因果边引用了不存在的事件: {event_id}",
                    "entity_id": event_id,
                }
            )
    return issues


def _pred_causal_event_order(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """causal_event_order：后果不得早于原因（逻辑倒置检测）。

    因果边 cause → effect：effect 所在章节不得早于 cause 所在章节；
    任一端事件缺失或章节未落 = 该边不参与判定（与既有校验语义一致）。
    """
    if not isinstance(target, list):
        return []
    world = _world_from_view(context)
    events = world.get("events") or {}
    issues: list[dict[str, Any]] = []
    for link in target:
        if not isinstance(link, dict):
            continue
        cause = events.get(str(link.get("cause_event_id") or ""))
        effect = events.get(str(link.get("effect_event_id") or ""))
        if not isinstance(cause, dict) or not isinstance(effect, dict):
            continue
        cause_chapter = cause.get("chapter_id")
        effect_chapter = effect.get("chapter_id")
        if (
            cause_chapter is not None
            and effect_chapter is not None
            and effect_chapter < cause_chapter
        ):
            issues.append(
                {
                    "message": (
                        f"后果早于原因：事件 {cause.get('event_id')}"
                        f"（第 {cause_chapter} 章）的后果不可能在第"
                        f" {effect_chapter} 章体现"
                    ),
                    "entity_id": str(effect.get("event_id") or ""),
                }
            )
    return issues


def _resolved_value(config: dict[str, Any]) -> str:
    """回收态取值（规则声明可覆盖，缺省 = 叙事终态 resolved 单源常量）。"""
    return str(config.get("status_value", STATUS_RESOLVED))


def _pred_resolved_requires_planted(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """resolved_requires_planted：已回收必须已埋设，且回收不早于埋设。

    伏笔链合法性：未埋设即回收 / 回收章早于埋设章均违规。
    """
    if not isinstance(target, dict):
        return []
    status_path = config.get("status_path", "status")
    planted_path = config.get("planted_path", "planted_at_chapter")
    resolved_path = config.get("resolved_path", "resolved_at_chapter")
    resolved = _resolved_value(config)
    issues: list[dict[str, Any]] = []
    for node in target.values():
        if not isinstance(node, dict):
            continue
        if node.get(status_path) != resolved:
            continue
        key = str(node.get("foreshadowing_id") or "")
        planted = node.get(planted_path)
        resolved_at = node.get(resolved_path)
        if planted is None:
            issues.append(
                {
                    "message": f"伏笔[{key}] 已回收但无埋设记录（未埋设即回收）",
                    "entity_id": key,
                }
            )
        elif resolved_at is not None and resolved_at < planted:
            issues.append(
                {
                    "message": (
                        f"伏笔[{key}] 回收章（第 {resolved_at} 章）"
                        f"早于埋设章（第 {planted} 章）"
                    ),
                    "entity_id": key,
                }
            )
    return issues


def _pred_reference_exists(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """reference_exists：伏笔互引必须存在（悬空引用 = 回收链断链）。"""
    if not isinstance(target, dict):
        return []
    world = _world_from_view(context)
    foreshadowings = world.get("foreshadowings") or {}
    status_path = config.get("status_path", "status")
    refs_path = config.get("references_path", "references")
    issues: list[dict[str, Any]] = []
    for node in target.values():
        if not isinstance(node, dict):
            continue
        # 非法状态节点的互引不在此检查（状态问题由 status_valid 规则承接，
        # 非法状态 continue，不继续检查引用——避免同节点叠加误报）
        if node.get(status_path) not in NARRATIVE_STATUSES:
            continue
        key = str(node.get("foreshadowing_id") or "")
        for ref in node.get(refs_path) or ():
            if str(ref) not in foreshadowings:
                issues.append(
                    {
                        "message": f"伏笔[{key}] 互引了不存在的伏笔[{ref}]",
                        "entity_id": str(ref),
                    }
                )
    return issues


def _pred_reference_planted_before_resolve(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """reference_planted_before_resolve：回收前依赖的伏笔必须已埋设。

    先回收 B 再埋 A 检测：本伏笔已回收时，其每个互引伏笔须已埋设且
    埋设章不晚于本伏笔回收章。
    """
    if not isinstance(target, dict):
        return []
    world = _world_from_view(context)
    foreshadowings = world.get("foreshadowings") or {}
    status_path = config.get("status_path", "status")
    refs_path = config.get("references_path", "references")
    planted_path = config.get("planted_path", "planted_at_chapter")
    resolved_path = config.get("resolved_path", "resolved_at_chapter")
    resolved = _resolved_value(config)
    issues: list[dict[str, Any]] = []
    for node in target.values():
        if not isinstance(node, dict):
            continue
        if node.get(status_path) != resolved:
            continue
        key = str(node.get("foreshadowing_id") or "")
        resolved_at = node.get(resolved_path)
        # 回收章未落（resolved_at 缺失）的节点不检查依赖埋设——引用链
        # 检查的前提是回收章已知（无回收章 = 无「回收前」基准）
        if resolved_at is None:
            continue
        for ref in node.get(refs_path) or ():
            ref_node = foreshadowings.get(str(ref))
            if not isinstance(ref_node, dict):
                continue  # 悬空引用由 reference_exists 规则承接
            ref_planted = ref_node.get(planted_path)
            if ref_planted is None:
                issues.append(
                    {
                        "message": f"伏笔[{key}] 已回收，但依赖的伏笔[{ref}] 尚未埋设",
                        "entity_id": str(ref),
                    }
                )
            elif ref_planted > resolved_at:
                issues.append(
                    {
                        "message": (
                            f"伏笔[{key}] 回收前依赖的伏笔[{ref}] 才在"
                            f"第 {ref_planted} 章埋设（先回收 B 再埋 A）"
                        ),
                        "entity_id": str(ref),
                    }
                )
    return issues


def _pred_knowledge_gap(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """knowledge_gap：角色此刻是否不该知道这些事实（防上帝视角泄漏）。

    参数随视图携带（character_id/fact_ids/at_chapter），规则集保持静态；
    无目标角色或事实清单 = 无检查项（与既往校验语义一致）。
    """
    if not isinstance(target, dict):
        return []
    root = (context or {}).get("root")
    character_id = (root or {}).get(_VIEW_CHARACTER_ID) if isinstance(root, dict) else None
    fact_ids = (root or {}).get(_VIEW_FACT_IDS) if isinstance(root, dict) else ()
    at_chapter = (root or {}).get(_VIEW_AT_CHAPTER) if isinstance(root, dict) else None
    if not character_id or not fact_ids:
        return []
    knowledge = target.get("knowledge") or {}
    entries = knowledge.get(str(character_id)) or []
    issues: list[dict[str, Any]] = []
    for fact_id in fact_ids:
        known = any(
            isinstance(entry, dict)
            and entry.get("fact_id") == str(fact_id)
            and (at_chapter is None or (entry.get("known_at_chapter") or 0) <= at_chapter)
            for entry in entries
        )
        if not known:
            when = f"第 {at_chapter} 章" if at_chapter is not None else "当前"
            issues.append(
                {
                    "message": (
                        f"角色[{character_id}] 在{when}尚不知晓"
                        f"「{fact_id}」，正文提前泄漏"
                    ),
                    "entity_id": str(character_id),
                }
            )
    return issues


def _pred_taboo_free(
    target: Any, config: dict[str, Any], context: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """taboo_free：正文不得命中角色行为档案禁忌词（确定性命中检测）。

    语义偏离的深度判定由 LLM 钩子承接（fail-open）；
    本谓词只做确定性禁忌词命中。无正文/无禁忌清单 = 无检查项。
    """
    if not isinstance(target, dict):
        return []
    taboos = target.get("taboos") or ()
    root = (context or {}).get("root")
    if not isinstance(root, dict):
        return []
    text = root.get(_VIEW_TEXT) or ""
    if not text:
        return []
    name = root.get(_VIEW_CHARACTER_NAME) or ""
    label = f"角色「{name}」" if name else "该角色"
    issues: list[dict[str, Any]] = []
    for taboo in taboos:
        if taboo and taboo in text:
            issues.append(
                {
                    "message": f"{label}正文出现禁忌表述「{taboo}」（言行偏离行为档案）",
                    "severity": SEVERITY_WARNING,
                }
            )
    return issues


def register_world_state_predicates(registry: RuleTypeRegistry) -> None:
    """登记世界状态领域谓词（供规则集解析执行；重复登记显式拒绝）。"""
    registry.register("causal_event_exists", _pred_causal_event_exists)
    registry.register("causal_event_order", _pred_causal_event_order)
    registry.register("resolved_requires_planted", _pred_resolved_requires_planted)
    registry.register("reference_exists", _pred_reference_exists)
    registry.register(
        "reference_planted_before_resolve", _pred_reference_planted_before_resolve
    )
    registry.register("knowledge_gap", _pred_knowledge_gap)
    registry.register("taboo_free", _pred_taboo_free)


def build_world_state_registry() -> RuleTypeRegistry:
    """领域谓词注册表（内置通用谓词 + 世界状态谓词，一次装配）。"""
    registry = RuleTypeRegistry()
    register_world_state_predicates(registry)
    return registry


# -- 声明式规则集 -------------------------------------------------------------


def build_world_state_rule_set() -> RuleSet:
    """世界状态写时校验规则集（校验语义的声明式形态）。

    规则全部为纯数据：谓词名 + 参数 + 违规元数据；执行语义由
    内置/领域谓词承接，规则生成方只产出声明（LLM 生成安全可控）。
    """
    return RuleSet(
        name=WORLD_STATE_RULE_SET,
        description=(
            "小说世界状态写时校验（信息差/因果链/伏笔回收链/指纹禁忌）"
            "——声明式规则集形态"
        ),
        rules=(
            # 因果链：悬空引用（两端事件都必须存在）+ 后果早于原因 + 重复登记
            Rule(
                id="causal.link_exists.cause",
                predicate="causal_event_exists",
                config={"event_id_path": "cause_event_id"},
                target_path="world.causal_links",
                severity=SEVERITY_ERROR,
                kind=ISSUE_CAUSAL,
                entity_type="event",
                description="因果边 cause 事件必须存在（悬空边 = 跨章追踪断链）",
            ),
            Rule(
                id="causal.link_exists.effect",
                predicate="causal_event_exists",
                config={"event_id_path": "effect_event_id"},
                target_path="world.causal_links",
                severity=SEVERITY_ERROR,
                kind=ISSUE_CAUSAL,
                entity_type="event",
                description="因果边 effect 事件必须存在（悬空边 = 跨章追踪断链）",
            ),
            Rule(
                id="causal.effect_not_before_cause",
                predicate="causal_event_order",
                config={},
                target_path="world.causal_links",
                severity=SEVERITY_ERROR,
                kind=ISSUE_CAUSAL,
                entity_type="event",
                description="后果不得早于原因（逻辑倒置检测）",
            ),
            Rule(
                id="causal.duplicate_pair",
                predicate="unique_pairs",
                config={
                    "keys": ["cause_event_id", "effect_event_id"],
                    "message": "因果边重复登记",
                },
                target_path="world.causal_links",
                severity=SEVERITY_WARNING,
                kind=ISSUE_CAUSAL,
                entity_type="event",
                description="同一对因果边不得重复登记",
            ),
            # 伏笔回收链：状态合法性 + 未埋设即回收 + 回收不早于埋设 +
            # 互引存在性 + 先回收 B 再埋 A
            Rule(
                id="foreshadowing.status_valid",
                predicate="in_enum",
                config={"path": "status", "values": list(NARRATIVE_STATUSES)},
                target_path="world.foreshadowings",
                iterate_items=True,
                severity=SEVERITY_ERROR,
                kind=ISSUE_FORESHADOWING,
                entity_type="foreshadowing",
                description="伏笔状态必须是叙事状态机合法枚举（非法枚举 = 数据污染）",
            ),
            Rule(
                id="foreshadowing.resolved_requires_planted",
                predicate="resolved_requires_planted",
                config={},
                target_path="world.foreshadowings",
                severity=SEVERITY_ERROR,
                kind=ISSUE_FORESHADOWING,
                entity_type="foreshadowing",
                description="已回收必须已埋设，且回收章不早于埋设章",
            ),
            Rule(
                id="foreshadowing.reference_exists",
                predicate="reference_exists",
                config={},
                target_path="world.foreshadowings",
                severity=SEVERITY_ERROR,
                kind=ISSUE_FORESHADOWING,
                entity_type="foreshadowing",
                description="伏笔互引必须存在（悬空引用 = 回收链断链）",
            ),
            Rule(
                id="foreshadowing.reference_planted_before_resolve",
                predicate="reference_planted_before_resolve",
                config={},
                target_path="world.foreshadowings",
                severity=SEVERITY_ERROR,
                kind=ISSUE_FORESHADOWING,
                entity_type="foreshadowing",
                description="回收前依赖的伏笔必须已埋设且不晚于回收章（先回收 B 再埋 A）",
            ),
            # 信息差：角色此刻尚不知晓的事实被正文显露出
            Rule(
                id="knowledge.gap",
                predicate="knowledge_gap",
                config={},
                target_path="world",
                severity=SEVERITY_ERROR,
                kind=ISSUE_KNOWLEDGE_GAP,
                entity_type="character",
                description="角色在此时点不得显露出尚不知晓的事实（防上帝视角泄漏）",
            ),
            # 指纹禁忌：正文命中行为档案禁忌词（确定性检测；语义偏离走 LLM 钩子）
            Rule(
                id="fingerprint.taboo_free",
                predicate="taboo_free",
                config={},
                target_path="fingerprint",
                severity=SEVERITY_WARNING,
                kind=ISSUE_FINGERPRINT,
                entity_type="character",
                description="正文不得出现角色行为档案禁忌表述",
            ),
        ),
    )


# -- 校验入口（视图构造 + 规则评估） -------------------------------------------


def _build_view(
    world: WorldState,
    *,
    text: str = "",
    character_id: str | int | None = None,
    fact_ids: list[str] | None = None,
    at_chapter: int | None = None,
) -> dict[str, Any]:
    """构造规则评估视图（JSON 兼容：世界状态序列化 + 运行时参数）。

    规则集保持静态，调用时参数（正文/目标角色/事实清单）随视图携带；
    视图字段名 = 规则 target_path/谓词取值的契约（_VIEW_* 常量）。
    """
    view: dict[str, Any] = {
        _VIEW_WORLD: world.to_dict(),
        _VIEW_TEXT: text,
        _VIEW_CHARACTER_ID: str(_key(character_id)) if character_id is not None else None,
        _VIEW_FACT_IDS: [str(fact) for fact in (fact_ids or [])],
        _VIEW_AT_CHAPTER: at_chapter,
        _VIEW_CHARACTER_NAME: "",
        _VIEW_FINGERPRINT: None,
    }
    if character_id is not None:
        character = world.get_character(character_id)
        if character is not None:
            view[_VIEW_CHARACTER_NAME] = character.name
            if character.fingerprint is not None:
                view[_VIEW_FINGERPRINT] = {
                    "personality": dict(character.fingerprint.personality),
                    "catchphrases": list(character.fingerprint.catchphrases),
                    "taboos": list(character.fingerprint.taboos),
                }
    return view


async def check_world_state_rules(
    world: WorldState,
    *,
    text: str = "",
    character_id: str | int | None = None,
    fact_ids: list[str] | None = None,
    at_chapter: int | None = None,
    rule_set: RuleSet | None = None,
    registry: RuleTypeRegistry | None = None,
    llm_hook: Any = None,
) -> RuleCheckResult:
    """声明式规则集的写时校验（世界状态校验的唯一入口）。

    异步、可注入 LLM 钩子、fail-open：规则引擎跑声明式规则，钩子承接
    规则覆盖不到的深度启发式；任一环节异常跳过不阻断。

    Args:
        world: 世界状态图。
        text: 待检正文（指纹禁忌输入）。
        character_id: 信息差/指纹校验的目标角色。
        fact_ids: 正文让角色显露出知情的事实清单（信息差输入）。
        at_chapter: 当前章节（信息差时间基准）。
        rule_set: 规则集（缺省 = 内置世界状态规则集）。
        registry: 谓词注册表（缺省 = 内置通用 + 世界状态谓词）。
        llm_hook: 深度启发式 LLM 钩子（可选；异常 fail-open 跳过）。

    Returns:
        :class:`RuleCheckResult`：违规 + 跳过留痕（kind/severity 与
        领域问题模型词汇对齐，可直接消费）。
    """
    from ink_engine.core.rules import ConstraintChecker

    engine = RuleEngine(registry or build_world_state_registry())
    checker = ConstraintChecker(engine=engine, llm_hook=llm_hook)
    view = _build_view(
        world,
        text=text,
        character_id=character_id,
        fact_ids=fact_ids,
        at_chapter=at_chapter,
    )
    return await checker.check(rule_set or build_world_state_rule_set(), view)


# -- 样例库（parity 场景：新规则必须先让 fixture 全绿才允许落库） ----------------


def _char(**kw: Any) -> dict[str, Any]:
    """样例角色视图（与 WorldState.to_dict 的 characters 条目同构）。"""
    base = {
        "character_id": "c1",
        "name": "林晚",
        "location": "藏剑阁",
        "health": "完好",
        "goals": [],
        "relationships": {},
        "fingerprint": None,
        "updated_at_chapter": 0,
    }
    base.update(kw)
    return base


def _fixture_world(
    *,
    characters: dict[str, dict[str, Any]] | None = None,
    knowledge: dict[str, list[dict[str, Any]]] | None = None,
    events: dict[str, dict[str, Any]] | None = None,
    causal_links: list[dict[str, Any]] | None = None,
    foreshadowings: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """构造 JSON 兼容的世界状态样例（直接声明数据，含脏数据形态）。"""
    return {
        "characters": characters or {},
        "knowledge": knowledge or {},
        "events": events or {},
        "causal_links": causal_links or [],
        "foreshadowings": foreshadowings or {},
        "changes": [],
    }


def _view_for(
    world: dict[str, Any],
    *,
    text: str = "",
    character_id: str | None = None,
    fact_ids: list[str] | None = None,
    at_chapter: int | None = None,
    fingerprint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """样例评估视图（与 :func:`_build_view` 同构，输入为 JSON 数据）。

    指纹视图默认取自世界角色声明（与 :func:`_build_view` 同口径），
    ``fingerprint`` 参数仅在需要覆盖时显式传入——样例数据只声明一份，
    防两份拷贝静默漂移。
    """
    character = world.get("characters", {}).get(character_id or "")
    view: dict[str, Any] = {
        _VIEW_WORLD: world,
        _VIEW_TEXT: text,
        _VIEW_CHARACTER_ID: character_id,
        _VIEW_FACT_IDS: fact_ids or [],
        _VIEW_AT_CHAPTER: at_chapter,
        _VIEW_CHARACTER_NAME: character.get("name") or "" if character else "",
        _VIEW_FINGERPRINT: (
            fingerprint
            if fingerprint is not None
            else (character.get("fingerprint") if character else None)
        ),
    }
    return view


def build_world_state_fixtures() -> FixtureSet:
    """世界状态规则集样例库（写时校验场景的回归基线）。

    场景覆盖：信息差泄漏 / 因果悬空 / 后果早于原因 / 重复登记 / 伏笔
    未埋设即回收 / 回收早于埋设 / 互引未埋设 / 互引悬空 / 非法状态 /
    指纹禁忌命中 / 全绿组合——每一条新规则必须先让本样例全绿才允许落库。
    """
    knowledge_gap_world = _fixture_world(
        characters={"c1": _char()},
        knowledge={"c1": [{"character_id": "c1", "fact_id": "f1", "known_at_chapter": 3}]},
    )
    dangling_world = _fixture_world(
        events={"e1": {"event_id": "e1", "chapter_id": 3, "summary": ""}},
        causal_links=[{"cause_event_id": "e1", "effect_event_id": "ghost", "note": ""}],
    )
    reverse_world = _fixture_world(
        events={
            "e1": {"event_id": "e1", "chapter_id": 3, "summary": ""},
            "e2": {"event_id": "e2", "chapter_id": 23, "summary": ""},
        },
        causal_links=[{"cause_event_id": "e2", "effect_event_id": "e1", "note": ""}],
    )
    duplicate_world = _fixture_world(
        events={
            "e1": {"event_id": "e1", "chapter_id": 3, "summary": ""},
            "e2": {"event_id": "e2", "chapter_id": 23, "summary": ""},
        },
        causal_links=[
            {"cause_event_id": "e1", "effect_event_id": "e2", "note": ""},
            {"cause_event_id": "e1", "effect_event_id": "e2", "note": ""},
        ],
    )
    clean_causal_world = _fixture_world(
        events={
            "e1": {"event_id": "e1", "chapter_id": 3, "summary": ""},
            "e2": {"event_id": "e2", "chapter_id": 23, "summary": ""},
        },
        causal_links=[{"cause_event_id": "e1", "effect_event_id": "e2", "note": ""}],
    )
    unplanted_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "resolved",
                "planted_at_chapter": None,
                "resolved_at_chapter": 10,
                "references": [],
            }
        }
    )
    reverse_plant_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "resolved",
                "planted_at_chapter": 5,
                "resolved_at_chapter": 3,
                "references": [],
            }
        }
    )
    ref_unplanted_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "resolved",
                "planted_at_chapter": 2,
                "resolved_at_chapter": 8,
                "references": ["b"],
            },
            "b": {
                "foreshadowing_id": "b",
                "status": "set",
                "planted_at_chapter": None,
                "resolved_at_chapter": None,
                "references": [],
            },
        }
    )
    ref_missing_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "set",
                "planted_at_chapter": 2,
                "resolved_at_chapter": None,
                "references": ["ghost"],
            }
        }
    )
    bad_status_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "bogus",
                "planted_at_chapter": None,
                "resolved_at_chapter": None,
                "references": [],
            }
        }
    )
    clean_chain_world = _fixture_world(
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "resolved",
                "planted_at_chapter": 2,
                "resolved_at_chapter": 8,
                "references": ["b"],
            },
            "b": {
                "foreshadowing_id": "b",
                "status": "set",
                "planted_at_chapter": 1,
                "resolved_at_chapter": None,
                "references": [],
            },
        }
    )
    taboo_world = _fixture_world(
        characters={
            "c1": _char(
                fingerprint={"personality": {}, "catchphrases": [], "taboos": ["不可饶恕"]}
            )
        }
    )
    clean_full_world = _fixture_world(
        characters={
            "c1": _char(
                fingerprint={"personality": {}, "catchphrases": [], "taboos": []}
            )
        },
        knowledge={
            "c1": [{"character_id": "c1", "fact_id": "f1", "known_at_chapter": 3}]
        },
        events={
            "e1": {"event_id": "e1", "chapter_id": 3, "summary": ""},
            "e2": {"event_id": "e2", "chapter_id": 23, "summary": ""},
        },
        causal_links=[{"cause_event_id": "e1", "effect_event_id": "e2", "note": ""}],
        foreshadowings={
            "a": {
                "foreshadowing_id": "a",
                "status": "resolved",
                "planted_at_chapter": 2,
                "resolved_at_chapter": 8,
                "references": ["b"],
            },
            "b": {
                "foreshadowing_id": "b",
                "status": "set",
                "planted_at_chapter": 1,
                "resolved_at_chapter": None,
                "references": [],
            },
        },
    )
    composed_leaks_world = _fixture_world(
        characters={
            "c1": _char(
                fingerprint={"personality": {}, "catchphrases": [], "taboos": ["不可饶恕"]}
            )
        },
        knowledge={
            "c1": [{"character_id": "c1", "fact_id": "f1", "known_at_chapter": 3}]
        },
        events={
            "e1": {"event_id": "e1", "chapter_id": 3, "summary": ""},
            "e2": {"event_id": "e2", "chapter_id": 23, "summary": ""},
        },
        causal_links=[{"cause_event_id": "e2", "effect_event_id": "e1", "note": ""}],
    )

    return FixtureSet(
        name=WORLD_STATE_FIXTURES,
        cases=(
            FixtureCase(
                id="knowledge_gap_leak",
                data=_view_for(
                    knowledge_gap_world,
                    character_id="c1",
                    fact_ids=["f1", "f_secret"],
                    at_chapter=5,
                ),
                expected_pass=False,
                expected_kinds=(ISSUE_KNOWLEDGE_GAP,),
                description="角色已知 f1 但泄漏 f_secret（信息差硬冲突）",
            ),
            FixtureCase(
                id="causal_dangling_cause",
                data=_view_for(dangling_world),
                expected_pass=False,
                expected_kinds=(ISSUE_CAUSAL,),
                description="因果边引用不存在的事件（悬空边）",
            ),
            FixtureCase(
                id="causal_effect_before_cause",
                data=_view_for(reverse_world),
                expected_pass=False,
                expected_kinds=(ISSUE_CAUSAL,),
                description="后果早于原因（第 3 章事件被第 23 章事件引发）",
            ),
            FixtureCase(
                id="causal_duplicate_pair",
                data=_view_for(duplicate_world),
                expected_pass=False,
                expected_kinds=(ISSUE_CAUSAL,),
                description="同一对因果边重复登记",
            ),
            FixtureCase(
                id="causal_clean",
                data=_view_for(clean_causal_world),
                expected_pass=True,
                description="合法因果链零违规",
            ),
            FixtureCase(
                id="foreshadowing_resolved_without_planted",
                data=_view_for(unplanted_world),
                expected_pass=False,
                expected_kinds=(ISSUE_FORESHADOWING,),
                description="已回收但无埋设记录（未埋设即回收）",
            ),
            FixtureCase(
                id="foreshadowing_resolve_before_planted",
                data=_view_for(reverse_plant_world),
                expected_pass=False,
                expected_kinds=(ISSUE_FORESHADOWING,),
                description="回收章早于埋设章",
            ),
            FixtureCase(
                id="foreshadowing_reference_unplanted",
                data=_view_for(ref_unplanted_world),
                expected_pass=False,
                expected_kinds=(ISSUE_FORESHADOWING,),
                description="已回收但依赖的伏笔尚未埋设",
            ),
            FixtureCase(
                id="foreshadowing_reference_missing",
                data=_view_for(ref_missing_world),
                expected_pass=False,
                expected_kinds=(ISSUE_FORESHADOWING,),
                description="伏笔互引了不存在的伏笔",
            ),
            FixtureCase(
                id="foreshadowing_invalid_status",
                data=_view_for(bad_status_world),
                expected_pass=False,
                expected_kinds=(ISSUE_FORESHADOWING,),
                description="伏笔状态不是合法叙事状态",
            ),
            FixtureCase(
                id="foreshadowing_clean_chain",
                data=_view_for(clean_chain_world),
                expected_pass=True,
                description="合法伏笔回收链零违规",
            ),
            FixtureCase(
                id="fingerprint_taboo_hit",
                data=_view_for(
                    taboo_world,
                    text="他说出「不可饶恕」四个字",
                    character_id="c1",
                ),
                expected_pass=False,
                expected_kinds=(ISSUE_FINGERPRINT,),
                description="正文命中行为档案禁忌词",
            ),
            FixtureCase(
                id="clean_composed",
                data=_view_for(
                    clean_full_world,
                    text="正文无误",
                    character_id="c1",
                    fact_ids=["f1"],
                    at_chapter=5,
                ),
                expected_pass=True,
                description="因果链+伏笔链+信息差+指纹全部适用的全绿组合",
            ),
            FixtureCase(
                id="composed_leaks",
                data=_view_for(
                    composed_leaks_world,
                    text="他说出「不可饶恕」",
                    character_id="c1",
                    fact_ids=["f_secret"],
                    at_chapter=5,
                ),
                expected_pass=False,
                expected_kinds=(
                    ISSUE_KNOWLEDGE_GAP,
                    ISSUE_CAUSAL,
                    ISSUE_FINGERPRINT,
                ),
                description="组合泄漏：信息差 + 因果倒置 + 指纹禁忌同现",
            ),
        ),
    )


__all__ = [
    "WORLD_STATE_FIXTURES",
    "WORLD_STATE_RULE_SET",
    "build_world_state_fixtures",
    "build_world_state_registry",
    "build_world_state_rule_set",
    "check_world_state_rules",
    "register_world_state_predicates",
]

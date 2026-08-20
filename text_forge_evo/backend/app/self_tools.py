"""自指元工具：提案/应用/回退/领域生成（观察之后的演化通道）。

观察工具让 AI 看清自己；这套工具让 AI 合法地修改产品形态——
提案（propose_patch）校验形态与基准版本但不落链；应用（apply_patch）
走完整管线（校验 → 审批分级 → 补丁链落库 → 活跃态生效），L1/L2
挂卡等待用户决议；回退（revert_patch）仅允许链尾补丁，同样须审批；
领域生成（propose_domain_manifest）从高层描述产出新领域清单并提案。
全部输出为 JSON 文本（工具流水线结果契约），供 AI 回合内决策。

权限形态：``self:propose:*``（提案/领域生成）/ ``self:apply:*``（应用
与回退）——自定义权限域，经 PermissionGate fail-closed 判定；审批分级
在应用管线内完成（approve_before_execute），工具流水线不做二次挂卡。
"""
from __future__ import annotations

import json
from typing import Any

from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.harness import build_minimal_harness
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.self_application import SelfApplicationPipeline
from ink_engine.core.self_proposal import PatchKind, SelfProposal
from ink_engine.core.tool_pipeline import ToolPipeline

# 权限声明（自定义域：self:propose / self:apply）
PERMISSION_PROPOSE = "self:propose:*"
PERMISSION_APPLY = "self:apply:*"

# 判定动作（与权限声明的 action 配对）
_OPERATION_PROPOSE = "propose"
_OPERATION_APPLY = "apply"
_OPERATION_REVERT = "revert"

# 结果文本截断上限（与引擎工具流水线默认一致）
_MAX_RESULT_CHARS = 100_000


def self_tool_specs() -> list[ToolSpec]:
    """自指元工具的工具描述清单（注册进引擎工具表走标准流水线）。"""
    return [
        ToolSpec(
            name="propose_patch",
            description="提出产品演化补丁（只校验不落链）：按类型校验 payload 形态与"
            "基准版本，返回校验结果与当前集版本——合法提案的下一步是 apply_patch",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [k.value for k in PatchKind],
                        "description": "补丁类型（ui/theme/tool/rule/knowledge/"
                        "harness/event_type/environment/artifact）",
                    },
                    "payload": {
                        "type": "object",
                        "description": "补丁内容（按类型校验：界面描述/工具定义/"
                        "规则声明/知识条目/harness 定义/事件类型/环境声明/产物声明）",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "提案理由（审批卡展示与审计留痕）",
                    },
                },
                "required": ["kind", "payload"],
            },
            permissions=(PERMISSION_PROPOSE,),
        ),
        ToolSpec(
            name="apply_patch",
            description="应用演化补丁：校验 → 审批分级（L0 直过/L1 弹卡/L2 沙箱验证"
            "+人工）→ 补丁链落库 → 活跃态生效；审批卡等待用户决议时回合挂起",
            parameters={
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": [k.value for k in PatchKind],
                        "description": "补丁类型（与 propose_patch 同口径）",
                    },
                    "payload": {
                        "type": "object",
                        "description": "补丁内容（与 propose_patch 同口径）",
                    },
                    "base_version": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "提案时的集版本（缺省 = 当前版本；"
                        "基准不匹配 = 并发冲突，拒绝并要求重提）",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "提案理由（审批卡展示与审计留痕）",
                    },
                },
                "required": ["kind", "payload"],
            },
            permissions=(PERMISSION_APPLY,),
        ),
        ToolSpec(
            name="revert_patch",
            description="回退已应用补丁（仅链尾，须审批）：回退后集状态回到目标版本，"
            "审计保留完整历史（append-only）",
            parameters={
                "type": "object",
                "properties": {
                    "patch_id": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "要回退的补丁版本号（须为当前链尾）",
                    },
                    "reason": {
                        "type": "string",
                        "description": "回退原因（审计留痕）",
                    },
                },
                "required": ["patch_id"],
            },
            permissions=(PERMISSION_APPLY,),
        ),
        ToolSpec(
            name="propose_domain_manifest",
            description="领域生成器：根据自然语言领域需求生成最小可用领域清单"
                "（harness 定义）并提案——输入领域名/描述/关键词（可选工具与图），"
                "校验后产出 harness 补丁；经审批落地后该领域即出现在能力清单，"
                "可被路由激活（长出新领域 = 真实产品演化）",
            parameters={
                "type": "object",
                "properties": {
                    "domain_name": {
                        "type": "string",
                        "description": "领域名（harness 名，全局唯一，如 novel/code）",
                    },
                    "description": {
                        "type": "string",
                        "description": "领域能力描述（能力路由/用户可见说明）",
                    },
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "能力关键词（路由匹配依据，如 写作/推演/润色）",
                    },
                    "tools": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "可选声明式工具定义清单（扩展领域能力）",
                    },
                    "graph": {
                        "type": "object",
                        "description": "可选图定义数据（领域工作流；省略 = 纯能力标记）",
                    },
                    "rationale": {
                        "type": "string",
                        "description": "提案理由（审批卡展示与审计留痕）",
                    },
                },
                "required": ["domain_name", "description", "keywords"],
            },
            permissions=(PERMISSION_PROPOSE,),
        ),
    ]


def operation_of(spec: ToolSpec) -> tuple[str, str]:
    """操作提取：按工具名定动作（propose/apply × patch 目标）。

    同时供自指流水线与宿主统一流水线接线使用（单一判定来源，
    两条管线分类一致，避免新工具只在一侧登记造成的权限误判）。
    """
    if spec.name in ("propose_patch", "propose_domain_manifest"):
        return (_OPERATION_PROPOSE, "patch")
    if spec.name in ("apply_patch", "revert_patch"):
        return (_OPERATION_APPLY, "patch")
    return (_OPERATION_PROPOSE, "patch")


def make_self_executor(
    pipeline: SelfApplicationPipeline, app_getter: Any
) -> Any:
    """自指工具执行器（统一流水线分发用；ctx/spec/args/approval → 文本）。"""

    async def executor(ctx: Any, spec: ToolSpec, args: dict, approval: Any) -> str:
        app = app_getter()
        if spec.name == "propose_patch":
            return await _propose(ctx, app, args)
        if spec.name == "propose_domain_manifest":
            return await _propose_domain(ctx, app, args)
        if spec.name == "apply_patch":
            return await _apply(ctx, app, args)
        if spec.name == "revert_patch":
            return await _revert(ctx, app, args)
        raise GraphDefinitionError(f"未知自指工具: {spec.name}")

    return executor


def build_self_pipeline(
    pipeline: SelfApplicationPipeline,
    app_getter: Any,
    *,
    gate: PermissionGate | None = None,
) -> ToolPipeline:
    """装配自指元工具流水线（权限门禁 fail-closed + 执行器分发）。

    gate 缺省为 fail-closed 的 PermissionGate——工具声明了
    ``self:propose:*`` / ``self:apply:*`` 权限即可直过；未声明/未命中
    权限的工具调用被拒绝并留痕。审批分级在应用管线内完成，工具
    流水线不做二次挂卡。
    """
    return ToolPipeline(
        gate=gate or PermissionGate(),
        extractor=operation_of,
        executor=make_self_executor(pipeline, app_getter),
        max_result_chars=_MAX_RESULT_CHARS,
    )


async def _propose(ctx: Any, app: Any, args: dict) -> str:
    """提案校验：形态非法/未知类型显式报错，合法返回集版本供应用用。"""
    try:
        proposal = _build_proposal(ctx, args, base_version_hint=None)
    except GraphDefinitionError as exc:
        return _json({"ok": False, "violations": [str(exc)]})
    violations = app.self_pipeline.validator.validate(proposal)
    if violations:
        return _json({"ok": False, "violations": violations})
    return _json(
        {
            "ok": True,
            "kind": proposal.kind.value,
            "violations": [],
            "current_version": await app.self_pipeline.chain.current_version(),
            "hint": "调用 apply_patch 应用本提案（base_version = 上述 current_version）",
        }
    )


async def _propose_domain(ctx: Any, app: Any, args: dict) -> str:
    """领域生成器提案：从高层输入产出最小 harness 定义并校验提案。

    仅做「生成 + 校验 + 提案」，不落链（落链走 apply_patch）；回显生成的
    harness 定义，便于调用方（AI/apply_patch）复用——开局第一回合即可
    据此长出领域清单。所有非法输入都产出自描述违规清单（结构化拒绝），
    不在执行期以裸异常击穿。
    """
    violations: list[str] = []
    name = args.get("domain_name")
    if not isinstance(name, str) or not name.strip():
        violations.append("domain_name 须为非空字符串")
    description = args.get("description") or ""
    if not isinstance(description, str):
        violations.append("description 须为字符串")
    keywords = args.get("keywords")
    if (
        not isinstance(keywords, (list, tuple))
        or not keywords
        or not all(isinstance(k, str) and k.strip() for k in keywords)
    ):
        violations.append("keywords 须为非空字符串清单")
    tools = args.get("tools") or []
    if not isinstance(tools, (list, tuple)):
        violations.append("tools 须为声明式工具定义清单（数组）")
    graph = args.get("graph")
    if graph is not None and not isinstance(graph, dict):
        violations.append("graph 须为图定义 dict")
    if violations:
        return _json({"ok": False, "violations": violations})

    # 全局唯一承诺：与既有 harness 重名即拒绝（既有领域的修改走
    # propose_patch 的 harness 通道，生成器不承担改名覆盖职责）
    if app.harness_registry.get(name) is not None:
        return _json(
            {
                "ok": False,
                "violations": [
                    f"领域名已存在（harness 名全局唯一）: {name}；"
                    "修改既有领域请用 propose_patch（kind=harness）"
                ],
            }
        )
    # 工具清单逐项做声明式定义形态预校验：非法项转化为结构化违规，
    # 生成器的产出保证可被 apply_patch 直接复用
    for tool in tools:
        try:
            DeclarativeToolSpec.from_dict(tool)
        except Exception as exc:
            return _json({"ok": False, "violations": [f"工具定义非法: {exc}"]})
    try:
        definition = build_minimal_harness(
            name=name,
            description=description,
            keywords=tuple(keywords),
            tools=tuple(tools),
            graph=graph,
        )
    except GraphDefinitionError as exc:
        return _json({"ok": False, "violations": [str(exc)]})
    proposal = SelfProposal(
        kind=PatchKind.HARNESS,
        payload={"definition": definition.to_dict()},
        base_version=1,
        rationale=str(args.get("rationale") or ""),
        meta={"round_id": getattr(ctx, "round_id", None), "generator": "domain_manifest"},
    )
    violations = app.self_pipeline.validator.validate(proposal)
    if violations:
        return _json({"ok": False, "violations": violations})
    return _json(
        {
            "ok": True,
            "kind": proposal.kind.value,
            "violations": [],
            "current_version": await app.self_pipeline.chain.current_version(),
            "definition": definition.to_dict(),
            "hint": "调用 apply_patch（kind=harness, payload.definition=上述 definition）"
            "应用本提案（base_version = 上述 current_version）",
        }
    )


async def _apply(ctx: Any, app: Any, args: dict) -> str:
    """应用提案：完整管线（校验 → 审批分级 → 落链 → 活跃态生效）。"""
    try:
        proposal = _build_proposal(ctx, args, base_version_hint=args.get("base_version"))
    except GraphDefinitionError as exc:
        return _json({"ok": False, "status": "invalid", "reason": str(exc)})
    outcome = await app.self_pipeline.apply(ctx, proposal)
    return _json(
        {
            "ok": outcome.applied,
            "status": outcome.status,
            "decision": outcome.decision,
            "patch_id": outcome.patch_id,
            "reason": outcome.reason,
        }
    )


async def _revert(ctx: Any, app: Any, args: dict) -> str:
    """回退链尾补丁（审批确认后落地，审计保留历史）。"""
    try:
        patch_id = int(args["patch_id"])
    except (KeyError, TypeError, ValueError):
        return _json({"ok": False, "status": "invalid", "reason": "patch_id 须为整数"})
    try:
        outcome = await app.self_pipeline.revert(
            ctx, patch_id, reason=str(args.get("reason") or "")
        )
    except GraphDefinitionError as exc:
        return _json({"ok": False, "status": "rejected", "reason": str(exc)})
    return _json(
        {
            "ok": outcome.status == "reverted",
            "status": outcome.status,
            "decision": outcome.decision,
            "patch_id": patch_id,
            "reason": outcome.reason,
        }
    )


def _build_proposal(ctx: Any, args: dict, *, base_version_hint: Any) -> SelfProposal:
    """从工具入参构造提案（类型/形态非法显式报错）。"""
    raw_kind = args.get("kind")
    try:
        kind = PatchKind(raw_kind)
    except ValueError as exc:
        raise GraphDefinitionError(
            f"补丁类型非法: {raw_kind!r}（仅 {[k.value for k in PatchKind]}）"
        ) from exc
    payload = args.get("payload")
    if not isinstance(payload, dict):
        raise GraphDefinitionError("payload 须为对象（dict）")
    if base_version_hint is None:
        base_version = 1  # propose 侧不校验基准（仅形态校验）
    else:
        try:
            base_version = int(base_version_hint)
        except (TypeError, ValueError) as exc:
            raise GraphDefinitionError("base_version 须为整数") from exc
    return SelfProposal(
        kind=kind,
        payload=payload,
        base_version=base_version,
        rationale=str(args.get("rationale") or ""),
        meta={"round_id": getattr(ctx, "round_id", None)},
    )


def _json(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False)


__all__ = [
    "PERMISSION_APPLY",
    "PERMISSION_PROPOSE",
    "build_self_pipeline",
    "make_self_executor",
    "operation_of",
    "self_tool_specs",
]

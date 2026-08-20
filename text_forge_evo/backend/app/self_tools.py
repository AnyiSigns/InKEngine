"""宿主自指元工具扩展：种子沉淀（harvest_seed）与合并后的清单/执行器。

4 个契约工具（propose_patch/apply_patch/revert_patch/propose_domain_manifest）
已下沉内核 ``ink_engine.core.self_tools``（引擎能力，随机制层走补丁链
演化、不随宿主壳漂移）；本模块只保留宿主扩展 harvest_seed——不在
BOOT_METATOOLS 契约内、依赖宿主 seed_store 种子仓库（质量/通用性/
去隐私 vetting + 原子落盘），经内核执行器组合接入：契约工具走内核
行为，harvest_seed 走宿主沉淀逻辑。

上下文适配：内核执行器按 :class:`SelfToolContext` 取用（装配产物 +
收敛钩子）；宿主测试沿用 app 形态 getter（ForgeApp 为装配产物视图，
字段与上下文同源）——执行器统一归一为上下文后分发。
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from ink_engine.core.approval import (
    DECISION_ACCEPT,
    DECISION_AUTO,
    DefaultInterruptPolicy,
    approve_before_execute,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS
from ink_engine.core.self_tools import (
    PERMISSION_APPLY,
    PERMISSION_PROPOSE,
    SelfToolContext,
)
from ink_engine.core.self_tools import make_self_executor as core_make_self_executor
from ink_engine.core.self_tools import operation_of as core_operation_of
from ink_engine.core.self_tools import self_tool_specs as core_self_tool_specs
from ink_engine.core.tool_pipeline import ToolPipeline

from .seed_store import harvest_package, save_seed_package

# 结果文本截断上限（与引擎工具流水线默认一致）
_MAX_RESULT_CHARS = 100_000

# 宿主扩展工具名（契约清单之外的产品能力：种子沉淀）
_HARVEST_SEED_NAME = "harvest_seed"


def self_tool_specs() -> list[ToolSpec]:
    """自指元工具清单 = 内核 4 契约工具 + 宿主 harvest_seed 扩展。"""
    specs = core_self_tool_specs()
    specs.append(
        ToolSpec(
            name=_HARVEST_SEED_NAME,
            description="种子沉淀：把集内成熟领域形态（harness+领域知识）经校验"
            "（质量/通用性/去隐私）导出为共享种子包，写入本地种子仓库"
            "（~/.textforge/seeds/）——审批确认后落盘，供其它集/新机器开局"
            "注入即得（活的变死：沉淀为可复用基线）",
            parameters={
                "type": "object",
                "properties": {
                    "domain_name": {
                        "type": "string",
                        "description": "要沉淀的领域名（须已注册 harness）",
                    },
                    "note": {
                        "type": "string",
                        "description": "沉淀说明（用途/版本语义，入包留痕）",
                    },
                },
                "required": ["domain_name"],
            },
            permissions=(PERMISSION_APPLY,),
        )
    )
    return specs


def operation_of(spec: ToolSpec) -> tuple[str, str]:
    """操作提取（单一判定来源）：契约工具走内核判定，宿主扩展走宿主判定。"""
    if spec.name == _HARVEST_SEED_NAME:
        return ("apply", "patch")
    return core_operation_of(spec)


def make_self_executor(
    pipeline: Any, context_getter: Any
) -> Any:
    """宿主自指执行器（统一流水线分发用；ctx/spec/args/approval → 文本）。

    契约工具（4 个）经内核执行器执行；harvest_seed 走宿主沉淀逻辑；
    未知名显式拒绝。context_getter 返回 :class:`SelfToolContext` 或
    app 形态装配产物（字段与上下文同源，统一归一为上下文）。
    """
    core_executor = core_make_self_executor(
        pipeline, lambda: _as_context(context_getter())
    )

    async def executor(ctx: Any, spec: ToolSpec, args: dict, approval: Any) -> str:
        if spec.name == _HARVEST_SEED_NAME:
            return await _harvest_seed(ctx, _as_context(context_getter()), args)
        return await core_executor(ctx, spec, args, approval)

    return executor


def build_self_pipeline(
    pipeline: Any,
    context_getter: Any,
    *,
    gate: PermissionGate | None = None,
) -> ToolPipeline:
    """装配宿主自指元工具流水线（权限门禁 fail-closed + 执行器分发）。

    审批分级在应用管线内完成，工具流水线不做二次挂卡；门禁缺省
    fail-closed——工具声明了 ``self:propose:*`` / ``self:apply:*``
    权限即可直过，未声明/未命中权限的工具调用被拒绝并留痕。
    """
    return ToolPipeline(
        gate=gate or PermissionGate(),
        # 流水线按 extractor(spec, args) 双参调用；自指判定只取工具名
        extractor=lambda spec, _args: operation_of(spec),
        executor=make_self_executor(pipeline, context_getter),
        max_result_chars=_MAX_RESULT_CHARS,
    )


def _as_context(value: Any) -> SelfToolContext:
    """上下文归一：SelfToolContext 直通；app 形态装配产物包装为上下文。"""
    if isinstance(value, SelfToolContext):
        return value
    return SelfToolContext(
        self_pipeline=value.self_pipeline,
        harness_registry=getattr(value, "harness_registry", None),
        knowledge_set=getattr(value, "knowledge_set", None),
        convergence=getattr(value, "convergence", None),
        interrupt_policy=getattr(value, "interrupt_policy", None),
    )


async def _harvest_seed(ctx: Any, context: SelfToolContext, args: dict) -> str:
    """种子沉淀：组装种子包（校验）→ 审批挂卡 → 落盘种子仓库。

    沉淀是形态外流（导出到集外种子仓库），与集内演化同走审批闸门
    （全挂起策略 + 超时兜底，不直过）；vetting 未通过 = 结构化拒绝
    不落盘（隐私 fail-closed）。审批拒绝 = 只留痕（审计在集外无载体，
    沉淀动作本身是用户确认过的，拒绝即不产出）。
    """
    name = args.get("domain_name")
    if not isinstance(name, str) or not name.strip():
        return _json({"ok": False, "violations": ["domain_name 须为非空字符串"]})
    # 种子仓库取用装配产物的注册表与知识集（harvest_package 的取用面）
    app_view = SimpleNamespace(
        harness_registry=context.harness_registry,
        knowledge_set=context.knowledge_set,
    )
    try:
        package = harvest_package(app_view, name, note=str(args.get("note") or ""))
    except GraphDefinitionError as exc:
        return _json({"ok": False, "violations": [str(exc)]})
    approval = await approve_before_execute(
        ctx,
        f"harvest:{name}",
        {
            "tool": _HARVEST_SEED_NAME,
            "domain": name,
            "summary": f"沉淀领域种子 {name}",
            "note": args.get("note") or "",
        },
        payload={
            "review_type": "gate",
            "node_id": _HARVEST_SEED_NAME,
            "node_label": f"沉淀种子 {name}",
            "output_preview": (
                f"导出 {name} 领域形态为共享种子包（"
                f"{len(package['knowledge'])} 条领域知识）"
            ),
            "vetting": package["vetting"],
        },
        # 宿主级审批策略经上下文注入（Runtime 装配时取 Host 五件套）；
        # 直接执行器形态（测试/独立接线）回落自带默认策略
        policy=context.interrupt_policy
        or DefaultInterruptPolicy(timeout=APPROVAL_TIMEOUT_SECONDS),
    )
    if approval.decision not in (DECISION_ACCEPT, DECISION_AUTO):
        return _json(
            {
                "ok": False,
                "status": approval.decision,
                "reason": approval.reason or "种子沉淀未获批准",
            }
        )
    path = await save_seed_package(package)
    return _json(
        {
            "ok": True,
            "seed": name,
            "path": str(path),
            "knowledge_count": len(package["knowledge"]),
            "vetting": package["vetting"],
        }
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

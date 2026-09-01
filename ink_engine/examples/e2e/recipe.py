"""装配配方：参考宿主「怎么装配引擎 = 数据」。

复用 seeds/boot 自举数据（系统提示/事件类型/自举 harness/界面基线），
分级审批（theme/ui 直过、tool 弹卡），自指工具三路接线，声明式工具
活跃态应用目标（TOOL 补丁落链 → 注册进统一工具表）——参考宿主与产品
宿主唯一的差别是配方数据，机制层零差异。
"""
from __future__ import annotations

from typing import Any

from ink_engine.core.declarative_tools import DeclarativeToolSpec
from ink_engine.core.graph import Graph
from ink_engine.core.runtime import (
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    ToolWiring,
)
from ink_engine.core.self_application import ApplyTarget, ApprovalLevel
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs
from ink_engine.seeds.boot import (
    BOOT_EVENT_TYPES,
    BOOT_SYSTEM_PROMPT,
    BOOT_UI_SPEC,
    boot_harness_definition,
    build_boot_seed_entries,
)

from .graph import build_agent_graph


class _ToolApplyTarget(ApplyTarget):
    """TOOL 补丁落链后的活跃态生效：注册进声明式注册表 + 统一工具表。"""

    name = "e2e.tool"

    def __init__(self, runtime: Runtime) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict[str, Any], patch_id: int) -> None:
        spec = DeclarativeToolSpec.from_dict(payload)
        self._runtime.harness_registry.declarative.register_definition(spec)
        self._runtime.tool_registry[spec.name] = spec.to_spec()
        # 工具索引增量刷新：新注册工具对 search_tools/request_tool 立即可见
        self._runtime.refresh_tool_index()


def build_reference_recipe(*, set_id: str = "e2e") -> AssemblyRecipe:
    """参考宿主装配配方。"""

    def graph_recipe(ctx: GraphRecipeContext) -> Graph:
        return build_agent_graph(
            ctx.llm,
            tool_specs=ctx.tool_specs,
            pipeline=ctx.tool_pipeline,
            system_prompt=BOOT_SYSTEM_PROMPT,
            name="e2e_agent_loop",
        )

    return AssemblyRecipe(
        set_id=set_id,
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[boot_harness_definition()],
        event_type_specs=list(BOOT_EVENT_TYPES),
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=("column", "message_list", "agent_input"),
        ui_allowed_theme_tokens=("bg", "fg", "accent"),
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.UI: ApprovalLevel.L0,
            PatchKind.TOOL: ApprovalLevel.L1,
        },
        apply_targets={PatchKind.TOOL: lambda runtime: _ToolApplyTarget(runtime)},
        graph_recipe=graph_recipe,
    )


__all__ = [
    "build_reference_recipe",
]

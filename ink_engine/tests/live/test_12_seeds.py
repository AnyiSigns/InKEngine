"""族 12：种子知识集（test_12_seeds.py）｜core/seeds 通用种子 +
seeds/boot 自举引导数据。

- 通用种子注入幂等（重复初始化不覆盖使用中演化；种子只读基线语义）
- boot 知识条目（BOOT_SYSTEM_PROMPT 等）注入装配
- boot harness 编译 / 事件类型登记 / 界面基线装配

`real` 标记 = 真实 LLM 调用（族门禁②：boot 知识条目注入装配 → 真实
LLM 回合接收含 boot 知识的上下文 → 回复非空，LLM 调用 1 次）；其余为
确定性机制用例（零费用）。
"""
from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Any

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.approval import DefaultInterruptPolicy  # noqa: E402
from ink_engine.core.event_types import EventTypeSpec  # noqa: E402
from ink_engine.core.graph import Graph, TerminateReason  # noqa: E402
from ink_engine.core.harness import HarnessDefinition  # noqa: E402
from ink_engine.core.knowledge_set import KnowledgeSet, seed_knowledge_set  # noqa: E402
from ink_engine.core.llm import AsyncLLM  # noqa: E402
from ink_engine.core.llm.messages import user  # noqa: E402
from ink_engine.core.runtime import (  # noqa: E402
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    RuntimeState,
    ToolWiring,
)
from ink_engine.core.seeds import (  # noqa: E402
    GENERAL_TEMPLATE_SEED_ID,
    GENERAL_WEIGHTS_SEED_ID,
    build_general_seed_entries,
    seed_general,
)
from ink_engine.core.self_application import ApprovalLevel  # noqa: E402
from ink_engine.core.self_proposal import PatchKind  # noqa: E402
from ink_engine.core.self_tools import (  # noqa: E402
    make_self_executor,
    operation_of,
    self_tool_specs,
)
from ink_engine.core.storage import create_storage  # noqa: E402
from ink_engine.seeds.boot import (  # noqa: E402
    BOOT_SYSTEM_PROMPT,
    BOOT_UI_SPEC,
    build_boot_seed_entries,
)


class FakeTransport:
    """Host 传输工厂产物（事件收集；EngineTransport 协议）。"""

    def __init__(self) -> None:
        self.events: list = []

    async def send(self, event: Any) -> None:
        self.events.append(event)


@dataclass
class FakeHost:
    """Host 五件套 mock（调用留痕；可注入真实模型）。"""

    calls: list[str] = field(default_factory=list)
    llm: AsyncLLM | None = None
    policy: Any = field(default_factory=DefaultInterruptPolicy)

    async def create_storage(self) -> Any:
        self.calls.append("create_storage")
        return create_storage("memory://")

    async def resolve_llm(self) -> AsyncLLM | None:
        self.calls.append("resolve_llm")
        return self.llm

    def interrupt_policy(self) -> Any:
        self.calls.append("interrupt_policy")
        return self.policy

    def build_transport(self) -> Any:
        self.calls.append("build_transport")
        return FakeTransport()

    async def close(self) -> None:
        self.calls.append("host_close")


def _echo_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    g = Graph(name="echo", entry="agent")
    g.add_node("agent", lambda c: {"reply": "ok"})
    g.add_exit("agent")
    return g


def _minimal_recipe(**overrides) -> AssemblyRecipe:
    base = AssemblyRecipe(
        set_id="default",
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[
            HarnessDefinition(name="forge", description="自举领域", keywords=("自举",))
        ],
        event_type_specs=[EventTypeSpec(name="reply_token", renderer="StreamingRow")],
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=("column", "message_list", "agent_input"),
        ui_allowed_theme_tokens=("bg", "fg", "accent"),
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={PatchKind.THEME: ApprovalLevel.L0},
        graph_recipe=_echo_graph_recipe,
    )
    return dataclasses.replace(base, **overrides)


# ----------------------------------------------------------------------
# 通用种子注入幂等
# ----------------------------------------------------------------------

def test_general_seed_minimal_shell():
    """通用种子 = 最小可用空壳：模板 + 权重阈值，不含领域成品。"""
    entries = build_general_seed_entries()
    by_id = {e.id: e for e in entries}
    assert set(by_id) == {GENERAL_TEMPLATE_SEED_ID, GENERAL_WEIGHTS_SEED_ID}
    assert by_id[GENERAL_TEMPLATE_SEED_ID].data["template"]["plan"]["steps"]


def test_general_seed_injection_idempotent():
    """通用种子注入幂等（种子只读基线：重复初始化不覆盖演化）。"""
    ks = KnowledgeSet("u1")
    assert seed_general(ks) == 2
    ks.update(GENERAL_TEMPLATE_SEED_ID, data={"template": {"name": "打磨后"}})
    assert seed_general(ks) == 0
    assert ks.get(GENERAL_TEMPLATE_SEED_ID).data["template"]["name"] == "打磨后"


# ----------------------------------------------------------------------
# boot 知识条目注入
# ----------------------------------------------------------------------

def test_boot_seed_entries_injected():
    """boot 提示词知识条目结构合法并幂等注入知识集。"""
    ks = KnowledgeSet("u1")
    entries = build_boot_seed_entries()
    assert seed_knowledge_set(ks, entries) == 1
    assert all(entry.id and entry.data.get("prompt") for entry in entries)
    prompt_entry = ks.get("seed.boot.system_prompt")
    assert prompt_entry is not None
    assert prompt_entry.data.get("prompt") == BOOT_SYSTEM_PROMPT
    assert "boot" in prompt_entry.tags
    # 幂等：重复注入跳过已存在条目
    assert seed_knowledge_set(ks, entries) == 0


# ----------------------------------------------------------------------
# boot 装配：知识条目 / harness / 事件类型 / 界面基线
# ----------------------------------------------------------------------

async def test_boot_assembly_seed_knowledge():
    """boot 装配：知识条目（含 boot 系统提示词）注入知识集。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    assert runtime.knowledge_set.get("seed.boot.system_prompt") is not None
    assert (
        runtime.knowledge_set.get("seed.boot.system_prompt").data["prompt"]
        == BOOT_SYSTEM_PROMPT
    )


async def test_boot_assembly_harness_compiled():
    """boot 装配：自举 harness 注册 + 落库（编译形态可重建）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    assert "forge" in runtime.harness_registry.names()
    saved = await runtime.harness_repository.get("forge")
    assert saved is not None and saved.name == "forge"
    # 自举 harness 仅定义元数据（无图）；注册表路由名可见
    assert set(runtime.harness_registry.names()) == {"forge"}


async def test_boot_assembly_event_types_registered():
    """boot 装配：事件类型登记（基线 reply_token 恒在）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    names = runtime.event_type_registry.names()
    assert {"reply_token"} <= set(names)
    spec = runtime.event_type_registry.get("reply_token")
    assert spec is not None and spec.renderer == "StreamingRow"


async def test_boot_assembly_ui_baseline():
    """boot 装配：界面基线经白名单校验后装配（未定形回落前即存在）。"""
    runtime = await Runtime().boot(FakeHost(), _minimal_recipe())
    snapshot = runtime.introspection_service.snapshot_ui()
    assert snapshot["ui_spec"] is not None
    assert snapshot["ui_spec"]["root"]["kind"] == "container"


# ----------------------------------------------------------------------
# 真实 LLM 回合接收 boot 知识上下文（族门禁②）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_llm_round_with_boot_knowledge(live_llm):
    """boot 知识条目注入装配 → 真实 LLM 回合接收含 boot 知识上下文
    → 回复非空（LLM 调用 1 次，行为契约断言）。"""
    host = FakeHost(llm=live_llm)
    runtime = Runtime()

    def graph_recipe(ctx: GraphRecipeContext) -> Graph:
        llm = ctx.llm

        async def agent(c):
            entry = runtime.knowledge_set.get("seed.boot.system_prompt")
            assert entry is not None, "boot 知识未注入"
            prompt = entry.data["prompt"] + "\n\n用户：用一句话介绍你是谁。"
            result = await llm.ainvoke([user(prompt)])
            return {"reply": result.content}

        g = Graph(name="boot_real", entry="agent")
        g.add_node("agent", agent)
        g.add_exit("agent")
        return g

    recipe = _minimal_recipe(graph_recipe=graph_recipe)
    await runtime.boot(host, recipe)
    # boot 知识条目已注入装配
    assert runtime.knowledge_set.get("seed.boot.system_prompt") is not None
    result = await runtime.engine.ainvoke(
        {}, thread_id="t-boot", round_id="r-boot"
    )
    assert result.reason == TerminateReason.REPLY
    assert result.state["reply"].strip(), "真实 LLM 回复为空"
    await runtime.stop()
    assert runtime.state is RuntimeState.STOPPED

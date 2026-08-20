"""boot 种子单测：种子注册 / 提示词条目 / 元工具契约 / 界面与事件与自举 harness。

覆盖：boot 领域种子按名注册可注入；系统提示词知识条目结构合法；
BOOT_METATOOLS 契约基线包含 engine-resident 的 introspection 元工具
（换壳不失明：机制层新增观察工具须同步进清单，单测强制）；初始界面
描述 / 事件类型 / 自举 harness 定义形态正确。
"""
from __future__ import annotations

from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.introspection import introspection_tool_specs
from ink_engine.core.seeds import seed_domains
from ink_engine.seeds.boot import (
    BOOT_EVENT_TYPES,
    BOOT_METATOOLS,
    BOOT_SYSTEM_PROMPT,
    BOOT_UI_SPEC,
    boot_harness_definition,
    build_boot_seed_entries,
)


def test_boot_seed_provider_registered():
    """boot 领域种子按名注册（import 即自注册，seed_domains 可见）。"""
    assert "boot" in seed_domains()


def test_boot_seed_entries_valid():
    """系统提示词知识条目结构合法（id/来源/数据形态）。"""
    entries = build_boot_seed_entries()
    assert entries
    assert all(entry.id and entry.data.get("prompt") for entry in entries)
    prompt_entry = next(
        entry for entry in entries if entry.id == "seed.boot.system_prompt"
    )
    assert prompt_entry.data.get("prompt") == BOOT_SYSTEM_PROMPT
    assert isinstance(prompt_entry.tags, tuple) and "boot" in prompt_entry.tags


def test_boot_metatools_covers_introspection():
    """契约基线包含全部 engine-resident 观察元工具（换壳不失明）。"""
    introspection_names = {spec.name for spec in introspection_tool_specs()}
    assert introspection_names.issubset(set(BOOT_METATOOLS))
    # 演化三工具为 self_application 机制层能力，亦在基线内
    for name in ("propose_patch", "apply_patch", "revert_patch"):
        assert name in BOOT_METATOOLS


def test_boot_metatools_covers_self_tool_contract():
    """契约自指工具 ⊆ 元工具清单且 engine-resident（随机制层演化不漂移）。

    内核 core/self_tools.py 的 4 个契约工具（propose_patch/apply_patch/
    revert_patch/propose_domain_manifest）是引擎能力——契约清单与 boot
    基线双向闭合：机制层新增演化工具须同步进清单，换壳宿主才不失明。
    """
    from ink_engine.core.self_tools import SELF_TOOL_CONTRACT

    assert set(SELF_TOOL_CONTRACT).issubset(set(BOOT_METATOOLS))
    assert "propose_domain_manifest" in BOOT_METATOOLS


def test_boot_ui_spec_shape():
    """初始界面描述为对话面板布局树（含绑定通道）。"""
    assert isinstance(BOOT_UI_SPEC, dict)
    root = BOOT_UI_SPEC["root"]
    assert root["kind"] == "container"
    types = {child.get("type") for child in root["children"]}
    assert "message_list" in types and "agent_input" in types


def test_boot_event_types_complete():
    """boot 内置事件类型登记齐全（建卡型事件 → 前端渲染组件）。

    以成员集合断言而非固定数量：基线扩展（新增事件类型）不应
    破坏既有契约的兑现（reply_token/review_card/error 恒在）。
    """
    names = {spec.name for spec in BOOT_EVENT_TYPES}
    assert {"reply_token", "review_card", "error"} <= names
    by_name = {spec.name: spec for spec in BOOT_EVENT_TYPES}
    assert by_name["reply_token"].renderer == "StreamingRow"
    assert by_name["review_card"].renderer == "ReviewCard"
    assert by_name["error"].renderer == "ErrorRow"


def test_boot_harness_definition():
    """自举 harness 定义为 forge 自举领域（观寀/演化元能力集）。"""
    definition = boot_harness_definition()
    assert isinstance(definition, HarnessDefinition)
    assert definition.name == "forge"
    assert "自举" in definition.keywords

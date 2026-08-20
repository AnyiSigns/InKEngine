"""种子沉淀池单测：成熟形态 → vetting → 审批 → 导出种子包。

覆盖：
- 集内既有 harness（forge 自举领域）可沉淀为种子包（质量校验通过）；
- 去隐私 fail-closed：含疑似密钥键的知识条目拒绝沉淀；
- 落盘 → 清单 → 回读闭环（原子写/损坏跳过）；
- harvest_seed 元工具：审批 accept 落盘 / 审批拒绝不落盘。
"""
from __future__ import annotations

import json

import pytest
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.harness import build_minimal_harness
from ink_engine.core.knowledge_set import KIND_RULE, KnowledgeEntry

from app import boot
from app.seed_store import (
    harvest_package,
    is_safe_seed_name,
    list_seeds,
    read_seed,
    save_seed_package,
)
from app.self_tools import make_self_executor, self_tool_specs


class AcceptCtx:
    """审批注入接受的假上下文（harvest 挂卡 → accept 决议）。"""

    round_id = "r-harvest"

    async def interrupt(self, key, card):
        return {"decision": "accept"}

    async def get_interrupt_payload(self, key):
        return None


class RejectCtx:
    """审批注入拒绝的假上下文（harvest 挂卡 → reject 决议）。"""

    round_id = "r-harvest-reject"

    async def interrupt(self, key, card):
        return {"decision": "reject"}

    async def get_interrupt_payload(self, key):
        return None


async def _add_rule(app, entry_id: str, *, title: str, tags=(), data=None) -> None:
    """注入一条演化产物知识条目（演化形态：非 seed. 前缀）。"""
    app.knowledge_set.add(
        KnowledgeEntry(
            id=entry_id,
            level="work",
            kind=KIND_RULE,
            data=data or {"rule": {"message": "领域经验规则", "context": {}}},
            source="user",
            credibility=0.9,
            title=title,
            tags=tags,
        )
    )
    with app.storage.allow_mechanism():
        await app.knowledge_set.save()


async def test_harvest_package_roundtrip() -> None:
    app = await boot.init_app()
    # 集内已有自举领域（forge harness），先注入一条领域经验再沉淀
    await _add_rule(app, "forge.demo", title="forge 经验规则", tags=("forge",))

    package = harvest_package(app, "forge", note="自举形态沉淀")
    assert package["format"] == "forge.seed.v1"
    assert package["name"] == "forge"
    assert package["vetting"]["violations"] == []
    assert any(entry["id"] == "forge.demo" for entry in package["knowledge"])

    # 落盘 → 清单可见 → 回读内容一致（原子写闭环）
    path = await save_seed_package(package)
    assert path.is_file()
    seeds = list_seeds()
    assert any(seed["name"] == "forge" for seed in seeds)
    loaded = read_seed("forge")
    assert loaded is not None
    assert loaded["harness"] == package["harness"]
    assert loaded["knowledge"] == package["knowledge"]


async def test_harvest_rejects_secret_fields() -> None:
    # 去隐私 fail-closed：条目含疑似密钥 JSON 键 → 沉淀被拒
    app = await boot.init_app()
    await _add_rule(
        app,
        "forge.demo",
        title="forge 经验规则",
        tags=("forge",),
        data={"rule": {"message": "演示规则", "context": {"api_key": "sk-123"}}},
    )
    with pytest.raises(GraphDefinitionError, match="疑似密钥"):
        harvest_package(app, "forge")


async def test_harvest_rejects_unknown_domain() -> None:
    # 未注册 harness 的领域不可沉淀（形态不存在，无物可上贡）
    app = await boot.init_app()
    with pytest.raises(GraphDefinitionError, match="领域不存在"):
        harvest_package(app, "ghost_domain")


async def test_harvest_rejects_unsafe_domain_name() -> None:
    # 落盘路径穿越防线：恶意 harness 名（路径穿越段）在 vetting 即拒绝
    app = await boot.init_app()
    app.harness_registry.register(
        build_minimal_harness(name="../evil", description="恶意领域", keywords=("evil",))
    )
    with pytest.raises(GraphDefinitionError, match="种子名非法"):
        harvest_package(app, "../evil")
    # 名称判定单测（读取侧与落盘侧共用同一防线）
    assert is_safe_seed_name("novel") is True
    assert is_safe_seed_name("../evil") is False
    assert is_safe_seed_name("a/b") is False
    assert is_safe_seed_name("a\\b") is False
    assert is_safe_seed_name("C:evil") is False
    assert is_safe_seed_name("") is False


async def test_harvest_rejects_secret_values() -> None:
    # 值形态密钥：凭据 token 形状（sk-...）同样 fail-closed（键与值双防线）
    app = await boot.init_app()
    await _add_rule(
        app,
        "forge.demo",
        title="forge 经验规则",
        tags=("forge",),
        data={"rule": {"message": "配置规则", "context": {"config": "db token=sk-abc123DEF456ghi789"}}},
    )
    with pytest.raises(GraphDefinitionError, match="疑似密钥"):
        harvest_package(app, "forge")


async def test_harvest_seed_tool_accept_writes_package() -> None:
    # 元工具全链：vetting → 审批挂卡 → accept → 落盘种子仓库
    app = await boot.init_app()
    executor = make_self_executor(app.self_pipeline, lambda: app)
    spec = next(s for s in self_tool_specs() if s.name == "harvest_seed")
    out = json.loads(
        await executor(
            AcceptCtx(), spec, {"domain_name": "forge", "note": "沉淀自举形态"}, None
        )
    )
    assert out["ok"] is True
    assert out["seed"] == "forge"
    assert read_seed("forge") is not None
    seeds = list_seeds()
    assert any(seed["name"] == "forge" and seed["note"] == "沉淀自举形态" for seed in seeds)


async def test_harvest_seed_tool_reject_skips_write() -> None:
    # 审批拒绝 → 不落盘（形态外流须人类确认）
    app = await boot.init_app()
    executor = make_self_executor(app.self_pipeline, lambda: app)
    spec = next(s for s in self_tool_specs() if s.name == "harvest_seed")
    out = json.loads(
        await executor(RejectCtx(), spec, {"domain_name": "forge"}, None)
    )
    assert out["ok"] is False
    assert out["status"] == "reject"
    assert read_seed("forge") is None


async def test_save_seed_package_rejects_unsafe_name() -> None:
    # 落盘侧独立防线：绕过 vetting 直接调用 save 也被拒（纵深防御）
    with pytest.raises(GraphDefinitionError, match="拒绝落盘"):
        await save_seed_package({"name": "../../escape", "description": "x"})

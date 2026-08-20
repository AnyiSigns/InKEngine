"""开局装配单测：11 步装配产物完整性 + 内省工具可用性。"""

from __future__ import annotations

import json

import pytest
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.introspection import introspection_tool_specs

from app import boot
from app.self_tools import self_tool_specs


async def test_init_app_assembles_all_steps() -> None:
    app = await boot.init_app()
    # ① 存储已接线（SQLite 集目录）
    assert app.storage is not None
    # ② 图注册表
    assert app.graph_registries is not None
    # ③ 通用种子已注入（知识集非空）
    assert len(app.knowledge_set.entries()) > 0
    # ④ forge 领域已注册 + 落库
    assert "forge" in app.harness_registry.names()
    saved = await app.harness_repository.get("forge")
    assert saved is not None and saved.name == "forge"
    # ⑥ 内省工具装配完成
    assert [s.name for s in app.introspection_specs] == [
        "inspect_graph",
        "inspect_rules",
        "inspect_knowledge",
        "inspect_ui",
        "inspect_tools",
    ]
    # ⑧ 未配置模型 → LLM 解析为 None（前端引导）
    assert await app.resolve_llm() is None
    # ⑩ Engine 实例已装配（图可观察）
    assert app.engine is not None


async def test_init_app_idempotent() -> None:
    first = await boot.init_app()
    second = await boot.init_app()
    assert first is second


async def test_introspection_pipeline_works_after_assembly() -> None:
    app = await boot.init_app()
    spec = introspection_tool_specs()[4]  # inspect_tools
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    data = json.loads(result.output)
    # 工具表 = 内省元工具 + 自指演化元工具（数量随元工具清单变化）
    assert data["count"] == len(introspection_tool_specs()) + len(self_tool_specs())
    assert data["harnesses"] == ["forge"]


async def test_self_pipeline_assembled() -> None:
    # 应用管线装配：集版本从 1 起步，审计留痕可用，旁路写防护生效
    app = await boot.init_app()
    assert await app.self_pipeline.chain.current_version() == 1
    assert await app.self_pipeline.audit_log() == []
    with pytest.raises(GraphDefinitionError, match="旁路写拦截"):
        await app.storage.put_record("ui", "boot.panel", {"spec": {}})


async def test_boot_metatools_contract_bidirectional() -> None:
    """boot 元工具契约双向闭合：清单所列 = 装配实际登记（无换壳失明）。

    引擎侧单测保证 introspection ⊆ 清单；此处反向收紧——清单中的每个
    工具都必须真实落地在「内省 + 自指」装配表中，泄漏（清单虚标）即
    契约违反。
    """
    from ink_engine.seeds.boot import BOOT_METATOOLS

    app = await boot.init_app()
    assembled = {spec.name for spec in [*app.introspection_specs, *app.self_specs]}
    missing = set(BOOT_METATOOLS) - assembled
    assert not missing, f"BOOT_METATOOLS 虚标（未真实装配）: {missing}"


async def test_vetting_assembled() -> None:
    # vetting 闸门装配：L2 沙箱验证钩子已挂（构建产物引用的部署前
    # 静态门禁），L2 类型不被静默降级
    from ink_engine.core.self_application import ApprovalLevel
    from ink_engine.core.self_proposal import PatchKind

    app = await boot.init_app()
    assert app.self_pipeline._l2_vetting is not None
    assert app.self_pipeline._levels[PatchKind.ARTIFACT] is ApprovalLevel.L2


async def test_artifact_vetting_rejects_path_traversal() -> None:
    """L2 产物校验：越界文件名（穿越段/绝对路径）显式违规，不读取集外文件。

    哈希声明的文件名由 AI 提案携带——段级安全判定拒绝路径分隔/穿越段/
    绝对路径形态（fail-closed），合法文件名照常读取比对。
    """
    from ink_engine.core.self_proposal import PatchKind, SelfProposal

    from app import config
    from app.forge_recipe import _build_artifact_vetting

    vet = _build_artifact_vetting()
    artifacts_dir = config.SET_DIR / "artifacts"
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    # 越界形态：穿越段 / 反斜杠路径 / 盘符绝对路径 → 文件名非法（不触碰文件）
    malicious = SelfProposal(
        kind=PatchKind.ARTIFACT,
        payload={
            "hashes": {
                "../../outside.txt": "0" * 64,
                "sub\\win.ini": "0" * 64,
                "C:/Windows/win.ini": "0" * 64,
            }
        },
        base_version=1,
        rationale="",
        meta={},
    )
    violations = vet(malicious)
    assert all("文件名非法" in v for v in violations)
    assert len(violations) == 3
    # 合法形态：artifacts 目录内真实文件被读取并比对（内容不符 = 哈希不一致）
    (artifacts_dir / "build.zip").write_bytes(b"payload")
    legitimate = SelfProposal(
        kind=PatchKind.ARTIFACT,
        payload={"hashes": {"build.zip": "0" * 64}},
        base_version=1,
        rationale="",
        meta={},
    )
    violations = vet(legitimate)
    assert any("哈希不一致" in v for v in violations)


async def test_retrieval_source_assembled() -> None:
    # 检索原语装配：知识集检索源已注册（调配器 evidence 汇入的数据源）
    app = await boot.init_app()
    assert "knowledge" in app.retriever_registry.names()
    chunks = await app.retriever_registry.retrieve("写作", limit=5)
    assert isinstance(chunks, list)


async def test_inspect_graph_sees_round_graph() -> None:
    app = await boot.init_app()
    spec = introspection_tool_specs()[0]  # inspect_graph
    result = await app.introspection_pipeline.execute(None, spec, {})
    assert result.ok is True
    data = json.loads(result.output)
    assert data["graph"]["name"] == "forge_round"
    assert data["graph"]["entry"] == "agent"

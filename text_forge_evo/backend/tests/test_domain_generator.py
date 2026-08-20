"""领域生成器单测：propose_domain_manifest 产出 harness 定义并经
审批落库，开局第一回合即可长出新领域清单。

覆盖：领域生成器提案返回合法 harness 定义；该定义经 apply_patch
（L1 挂卡 → 回注 accept）落链后，领域即注册进 harness 注册表并
持久化进 harness 仓库（真实产品演化：集内长出新能力包）；经宿主
统一工具流水线执行（权限分类的回归防线）；非法输入的整组拒绝路径。
"""
from __future__ import annotations

import json

from ink_engine.core.events import CollectorTransport
from ink_engine.core.executor import Engine, RunOptions
from ink_engine.core.knowledge_set import KIND_RULE, KnowledgeEntry
from ink_engine.core.llm import LLMChunk
from ink_engine.core.llm.messages import ToolCallDelta

from app import boot
from app.round import build_forge_graph
from app.self_tools import make_self_executor, self_tool_specs


class PatchLLM:
    """回合测试用假模型：按给定 chunks 序列逐轮产出（末轮纯正文）。"""

    def __init__(self, chunks, *, reply="已落地领域。") -> None:
        self._turns = [chunks, [LLMChunk(token=reply)]]
        self._index = 0

    async def astream(self, messages, *, tools=None, params=None):
        chunks = self._turns[min(self._index, len(self._turns) - 1)]
        self._index += 1
        for chunk in chunks:
            yield chunk

    async def aclose(self) -> None:
        return None


def _engine(app, llm):
    graph = build_forge_graph(
        llm,
        app.tool_pipeline,
        [
            *app.introspection_specs,
            *app.self_specs,
            *app.tool_registry.values(),
        ],
        storage=app.storage,
    )
    return Engine(
        graph,
        options=RunOptions(
            storage=app.storage,
            registries=app.graph_registries,
            transports=[],
            system_events=app.event_type_registry.system_events(),
        ),
    )


async def test_domain_generator_grows_new_harness() -> None:
    # ① 领域生成器提案：高层输入 → 最小 harness 定义（校验通过）
    app = await boot.init_app()
    executor = make_self_executor(app.self_pipeline, lambda: app)
    ctx = type("Ctx", (), {"round_id": "r-dom-gen"})()
    gen_spec = next(
        s for s in self_tool_specs() if s.name == "propose_domain_manifest"
    )
    gen = json.loads(
        await executor(
            ctx,
            gen_spec,
            {
                "domain_name": "novel",
                "description": "小说写作领域",
                "keywords": ["写作", "小说"],
            },
            None,
        )
    )
    assert gen["ok"] is True
    assert gen["kind"] == "harness"
    definition = gen["definition"]
    assert definition["name"] == "novel"
    assert definition["keywords"] == ["写作", "小说"]

    # ② 应用该定义（L1 挂卡 → 回注 accept → 落库生效）
    apply_args = json.dumps(
        {
            "kind": "harness",
            "payload": {"definition": definition},
            "base_version": gen["current_version"],
            "rationale": "落地小说领域",
        }
    )
    chunks = [
        LLMChunk(
            tool_calls_delta=[
                ToolCallDelta(
                    index=0,
                    id="call_h",
                    name="apply_patch",
                    arguments_delta=apply_args,
                )
            ]
        )
    ]
    engine = _engine(app, PatchLLM(chunks))
    transport = CollectorTransport()
    await engine.ainvoke(
        {"input": "建个小说领域", "thread_id": "t-dom"},
        thread_id="t-dom",
        round_id="r-dom",
        transports=[transport],
    )
    # 回合挂起（L1 弹卡）
    interrupt = await engine.get_latest_interrupt("t-dom")
    assert interrupt is not None
    # 决议注入：accept 重入
    latest = await app.storage.get_latest_checkpoint("t-dom")
    transport2 = CollectorTransport()
    await engine.ainvoke(
        {},
        thread_id="t-dom",
        round_id="r-dom-resume",
        resume_from=latest.checkpoint_id,
        inject={interrupt.key: {"decision": "accept"}},
        transports=[transport2],
    )
    # 领域已注册并持久化（长出新领域清单）
    assert app.harness_registry.get("novel") is not None
    saved = await app.harness_repository.get("novel")
    assert saved is not None and saved.name == "novel"


async def test_domain_generator_via_unified_pipeline() -> None:
    """领域生成器经宿主统一工具流水线执行（权限提取分类的回归防线）。

    直接执行器调用绕过了 boot 的 unified_extractor——此处走
    app.tool_pipeline 全链（提取器 → 权限门禁 → 执行器），propose
    被误判为 apply 之类的分类回归会以「执行被拒」显式暴露。
    """
    app = await boot.init_app()
    spec = next(
        s for s in self_tool_specs() if s.name == "propose_domain_manifest"
    )
    result = await app.tool_pipeline.execute(
        None,
        spec,
        {
            "domain_name": "code",
            "description": "代码领域",
            "keywords": ["代码", "重构"],
        },
    )
    assert result.ok is True
    data = json.loads(result.output)
    assert data["ok"] is True
    assert data["kind"] == "harness"
    assert data["definition"]["name"] == "code"


async def test_domain_generator_rejects_invalid_inputs() -> None:
    """非法输入的整组拒绝路径：均返回结构化违规清单（ok=False）。"""
    app = await boot.init_app()
    executor = make_self_executor(app.self_pipeline, lambda: app)
    ctx = type("Ctx", (), {"round_id": "r-err"})()
    gen_spec = next(
        s for s in self_tool_specs() if s.name == "propose_domain_manifest"
    )

    async def propose(params: dict) -> dict:
        return json.loads(await executor(ctx, gen_spec, params, None))

    async def assert_violations(params: dict, keyword: str) -> None:
        out = await propose(params)
        assert out["ok"] is False
        assert any(keyword in item for item in out["violations"])

    def base() -> dict:
        return {"domain_name": "x", "description": "d", "keywords": ["关键词"]}

    # 空关键词（无法路由的领域能力标记）
    await assert_violations({**base(), "keywords": []}, "keywords")
    # 关键词含非字符串
    await assert_violations({**base(), "keywords": ["好", 1]}, "keywords")
    # tools 非清单形态
    await assert_violations({**base(), "tools": {"不是": "清单"}}, "tools")
    # 工具定义形态非法（缺必要字段）
    await assert_violations({**base(), "tools": [{"残缺": True}]}, "工具定义非法")
    # 重名领域（全局唯一承诺；forge 为自举领域不可覆盖）
    await assert_violations(
        {"domain_name": "forge", "description": "d", "keywords": ["x"]},
        "领域名已存在",
    )
    # graph 非 dict 形态
    await assert_violations({**base(), "graph": ["nodes"]}, "graph")
    # description 非字符串
    await assert_violations(
        {**base(), "description": {"嵌套": True}}, "description"
    )
    # 空白领域名
    await assert_violations(
        {"domain_name": "   ", "description": "d", "keywords": ["x"]},
        "domain_name",
    )


async def test_domain_generator_surfaces_incubated_knowledge() -> None:
    """领域生成器把孵化沉淀的相关经验显式交给调用方（复用优先）。

    集内先有领域相关沉淀（孵化产物/演化知识），生成器检索后随提案
    返回 related_knowledge——高质量版领域清单 = 参考既有经验生成，
    而非凭空发明（E 期孵化反馈的载体）。
    """
    app = await boot.init_app()
    app.knowledge_set.add(
        KnowledgeEntry(
            id="incubate.demo",
            level="work",
            kind=KIND_RULE,
            data={"rule": {"message": "小说写作领域经验：先定世界观再动笔", "context": {}}},
            source="user",
            credibility=0.9,
            title="小说写作经验",
            tags=("小说写作", "novel"),
        )
    )
    with app.storage.allow_mechanism():
        await app.knowledge_set.save()
    executor = make_self_executor(app.self_pipeline, lambda: app)
    ctx = type("Ctx", (), {"round_id": "r-rel"})()
    gen_spec = next(
        s for s in self_tool_specs() if s.name == "propose_domain_manifest"
    )
    out = json.loads(
        await executor(
            ctx,
            gen_spec,
            {
                "domain_name": "novel_writer",
                "description": "小说写作",
                "keywords": ["小说写作", "novel"],
            },
            None,
        )
    )
    assert out["ok"] is True
    related = out["related_knowledge"]
    assert any(item["id"] == "incubate.demo" for item in related)
    assert "复用优先" in out["hint"]

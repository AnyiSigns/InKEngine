"""Forge 装配配方：装配决策全部数据化（图配方/种子/harness/事件/界面/
工具三路/vetting/检索源/apply 目标/分级表/收敛钩子）。

装配动作已下沉内核 Runtime（core/runtime.py）——本模块只声明「怎么
装配 Forge」的数据（AssemblyRecipe），连同宿主差异接线（图配方、apply
目标、检索源、收敛钩子）。ForgeApp 变薄壳后，本模块是宿主侧唯一的
装配知识来源。
"""
from __future__ import annotations

import hashlib
import logging
import re
from collections.abc import Callable
from typing import Any

from ink_engine.core.graph import Graph
from ink_engine.core.retrieval import SOURCE_MODEL, RetrievedChunk
from ink_engine.core.runtime import (
    AssemblyRecipe,
    GraphRecipeContext,
    ToolWiring,
)
from ink_engine.core.self_application import DEFAULT_APPROVAL_LEVELS
from ink_engine.core.self_proposal import PatchKind
from ink_engine.seeds.boot import (
    BOOT_EVENT_TYPES,
    BOOT_UI_SPEC,
    boot_harness_definition,
    build_boot_seed_entries,
)

from . import config
from .round import build_forge_graph
from .self_tools import make_self_executor, operation_of, self_tool_specs

logger = logging.getLogger(__name__)

FORGE_SET_USER = "default"

# 界面组件白名单（界面描述只能引用已注册组件，JSON 不能执行任意代码）
ALLOWED_UI_COMPONENTS: tuple[str, ...] = (
    "column",
    "message_list",
    "agent_input",
    "files_panel",
)
# 主题 token 白名单（布局只能使用已声明的主题键）
ALLOWED_THEME_TOKENS: tuple[str, ...] = ("bg", "fg", "accent")


class KnowledgeRetriever:
    """知识集检索源（Retriever 实现）：检索集内知识条目作证据汇入。

    检索执行体 = 知识集的关键词基线（复用优先于生成：相似任务先检索
    已有条目）；检索结果带可信度分级（集内知识条目 = 模型级沉淀，
    非外部 web 来源），经注册表合并排序后作调配器 evidence 源注入。
    """

    name = "knowledge"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]:
        hits = self._runtime.knowledge_set.search(query, limit=limit)
        return [
            RetrievedChunk(
                source=self.name,
                doc_id=entry.id,
                text=f"{entry.title}：{entry.data}",
                relevance=min(1.0, entry.credibility),
                level=SOURCE_MODEL,
                meta={"kind": entry.kind, "source": entry.source},
            )
            for entry in hits
        ]


def _build_static_hooks() -> list:
    """默认静态审查钩子：代码形态审查（零外部依赖）。

    审查面 = AI 生成代码的形态合法性：Python 语法可解析（ast 编译）、
    文件真实存在。eslint/tsc/ruff 等重型审查由宿主按环境注入
    （ToolVetting 接受任意钩子清单），缺省不阻塞装配。
    """
    import ast
    from pathlib import Path

    def python_syntax(paths):
        violations: list[str] = []
        for path in paths:
            if not str(path).endswith(".py"):
                continue
            try:
                ast.parse(Path(path).read_text(encoding="utf-8"))
            except (SyntaxError, OSError) as exc:
                violations.append(f"Python 语法审查未通过: {path}: {exc}")
        return violations

    return [python_syntax]


def _is_safe_artifact_name(name: Any) -> bool:
    """产物文件名安全判定（目录段安全）：非空字符串且不含路径分隔/穿越段。

    哈希声明的文件名由 AI 提案携带——读取前先做段级约束（拒绝
    ``/`` ``\\`` ``..`` 与绝对路径形态），防止越界读取集目录之外的文件。
    """
    if not isinstance(name, str) or not name.strip():
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return not (re.match(r"^[A-Za-z]:", name) or name.startswith("/"))


def _build_artifact_vetting() -> Callable[[Any], list[str]]:
    """L2 沙箱验证钩子：构建产物引用的部署前静态门禁。

    验证面（fail-closed）：产物哈希声明的每个文件须真实存在于集
    数据目录的 artifacts 子目录且内容哈希一致（防篡改静默切换）；
    任一文件缺失/哈希不符 = 违规（不弹卡、不落链）。文件名先经
    段级安全判定 + 解析后包含断言双重约束（防路径穿越/符号链接
    边界绕过读取集外文件）。
    """

    def vet(proposal) -> list[str]:
        if proposal.kind is not PatchKind.ARTIFACT:
            return []
        payload = proposal.payload
        hashes = payload.get("hashes") or {}
        artifacts_dir = config.SET_DIR / "artifacts"
        if not artifacts_dir.is_dir():
            return ["构建产物目录不存在，无可部署产物"]
        resolved_root = artifacts_dir.resolve()
        violations: list[str] = []
        for name, digest in hashes.items():
            if not _is_safe_artifact_name(name):
                violations.append(
                    f"产物文件名非法: {name!r}（拒绝路径分隔/穿越段/绝对路径）"
                )
                continue
            source = artifacts_dir / name
            # 解析后双重约束：目标文件必须仍在 artifacts 目录内
            # （防符号链接/边界绕过），越界即违规不读取
            if not str(source.resolve()).startswith(str(resolved_root)):
                violations.append(f"产物文件越界: {name!r}")
                continue
            if not source.is_file():
                violations.append(f"产物文件缺失: {name}")
                continue
            actual = hashlib.sha256(source.read_bytes()).hexdigest()
            if actual != digest:
                violations.append(f"产物哈希不一致: {name}")
        return violations

    return vet


def _forge_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    """Forge 回合图配方：图级 LLM 工具循环（agent → exec_tool ⇄ agent）。"""
    return build_forge_graph(
        ctx.llm,
        ctx.tool_pipeline,
        ctx.tool_specs,
        storage=ctx.storage,
    )


async def _on_reverted_trigger(patch_id: int, reason: str) -> None:
    """回退后的孵化触发（回退 = 修正信号源：立即消费一次）。

    回退回调由应用管线调用（链已回退、审计已留痕）；孵化循环自身
    幂等（游标增量），失败只留痕不击穿回退流程。装配产物经延迟导入
    取用（装配期 boot 尚未完成，运行期才取单例）。
    """
    from . import boot

    app = boot._app
    if app is None or app.incubator is None:
        return
    try:
        await app.incubator.run_cycle()
    except Exception as exc:
        logger.warning("回退后孵化循环失败（忽略）: %s", exc)


def _convergence_provider() -> Any:
    """演化收敛管制钩子提供者（装配期尚无可取，运行期取装配产物）。"""
    from . import boot

    app = boot._app
    return app.convergence if app is not None else None


class _UITarget:
    """界面/主题补丁的活跃态目标：更新渲染器数据源 + 落库冗余视图。

    界面描述的权威记录 = 集补丁链（重启从链组装恢复）；此处只更新
    内存活跃态（渲染器消费）并写 ui 集合作审计视图（经旁路写防护
    的机制豁免——目标代码是应用管线的延伸）。
    """

    name = "ui"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        spec = payload.get("spec")
        if isinstance(spec, dict):
            self._runtime.introspection_service._sources.ui_spec = spec
            with self._runtime.storage.allow_mechanism("ui"):
                await self._runtime.storage.put_record(
                    "ui", spec.get("name") or "boot.panel", {"spec": spec, "patch_id": patch_id}
                )


class _ThemeTarget:
    """主题补丁的活跃态目标：主题 token 覆盖渲染器数据源。"""

    name = "theme"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        tokens = payload.get("tokens")
        if not isinstance(tokens, dict):
            return
        current = self._runtime.introspection_service._sources.ui_spec
        if not isinstance(current, dict):
            return
        updated = dict(current)
        updated["theme"] = {**dict(current.get("theme") or {}), **tokens}
        self._runtime.introspection_service._sources.ui_spec = updated


class _ToolTarget:
    """工具补丁的活跃态目标：登记声明式定义 + 注册进宿主动态工具表。

    执行体注册由宿主后续接入（未注册执行体的调用在分发处显式拒绝，
    fail-closed）；注册后 inspect_tools 立即可见、可被后续回合调用。
    """

    name = "tool"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec

        declarative = DeclarativeToolSpec.from_dict(payload)
        self._runtime.harness_registry.declarative.register_definition(declarative)
        self._runtime.tool_registry[declarative.name] = declarative.to_spec()
        self._runtime.introspection_service._sources.tools = self._runtime.collect_specs()
        with self._runtime.storage.allow_mechanism("tool_defs"):
            await self._runtime.storage.put_record(
                "tool_defs", declarative.name, declarative.to_dict()
            )


class _EventTypeTarget:
    """事件类型补丁的活跃态目标：注册进事件类型注册表并落库。

    重复注册（AI 改类型）保守跳过——类型变更走「先废弃再注册」或
    补丁链版本化，不静默覆盖既有类型。
    """

    name = "event_type"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.event_types import EventTypeSpec

        spec = EventTypeSpec.from_dict(payload)
        registry = self._runtime.event_type_registry
        if spec.name in registry.names():
            logger.info("事件类型已存在，跳过注册（类型变更走版本化）: %s", spec.name)
            return
        registry.register(spec)
        with self._runtime.storage.allow_mechanism("event_types"):
            await registry.save()


class _KnowledgeTarget:
    """知识补丁的活跃态目标：条目写入知识集（补丁链通道）并落库。

    知识集的权威记录 = 集补丁链（knowledge 段）；此处同步内存链
    （重启从链组装恢复），落库经旁路写防护的显式豁免——目标代码
    是应用管线的延伸。
    """

    name = "knowledge"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.knowledge_set import KnowledgeEntry

        raw = payload.get("entry")
        if not isinstance(raw, dict):
            return
        entry = KnowledgeEntry.from_dict(raw)
        ks = self._runtime.knowledge_set
        if ks.get(entry.id) is None:
            ks.add(entry)
        else:
            changes = {
                key: value
                for key, value in entry.to_dict().items()
                if key not in ("id", "created_at")
            }
            ks.update(entry.id, **changes)
        with self._runtime.storage.allow_mechanism():
            await ks.save()


class _HarnessTarget:
    """harness 补丁的活跃态目标：注册进 harness 注册表 + 仓库落库。"""

    name = "harness"

    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def apply(self, payload: dict, patch_id: int) -> None:
        from ink_engine.core.harness import HarnessDefinition

        definition = payload.get("definition")
        if not isinstance(definition, dict):
            return
        parsed = HarnessDefinition.from_dict(definition)
        self._runtime.harness_registry.register(parsed)
        # 目标代码是应用管线的延伸：仓库落库经旁路写防护的显式豁免
        with self._runtime.storage.allow_mechanism("harness"):
            await self._runtime.harness_repository.save(
                parsed, note=f"补丁 #{patch_id}"
            )


def build_forge_recipe() -> AssemblyRecipe:
    """Forge 装配配方（数据形态：怎么装配引擎 = 数据，可校验可替换）。"""
    return AssemblyRecipe(
        set_id=FORGE_SET_USER,
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[boot_harness_definition()],
        event_type_specs=list(BOOT_EVENT_TYPES),
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=ALLOWED_UI_COMPONENTS,
        ui_allowed_theme_tokens=ALLOWED_THEME_TOKENS,
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        vetting_static_hooks=_build_static_hooks(),
        vetting_l2_hook=_build_artifact_vetting(),
        approval_levels=dict(DEFAULT_APPROVAL_LEVELS),
        retrieval_sources=[lambda runtime: KnowledgeRetriever(runtime)],
        apply_targets={
            PatchKind.UI: _UITarget,
            PatchKind.THEME: _ThemeTarget,
            PatchKind.TOOL: _ToolTarget,
            PatchKind.EVENT_TYPE: _EventTypeTarget,
            PatchKind.HARNESS: _HarnessTarget,
            PatchKind.KNOWLEDGE: _KnowledgeTarget,
        },
        graph_recipe=_forge_graph_recipe,
        on_reverted=_on_reverted_trigger,
        convergence_provider=_convergence_provider,
    )

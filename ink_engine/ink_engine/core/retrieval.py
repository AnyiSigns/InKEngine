"""检索原语：Retriever 接口 + 注册表（多检索源统一汇入）。

引擎此前无任何检索原语（仅 knowledge_set.search 关键词子串基线，
且后端 RAG 完全旁路引擎）——本模块补位：检索源（FTS/向量/MCP 等）
统一经 Retriever 接口接入，结果作调配器源注入（relevance 排序 +
可信度分级标记），经知识闸门防线防注入（web < dialog < model <
user 的来源分级在 chunk 上透传，注入侧按级过滤；指令注入扫描
对检索文本强制执行——检出即剔除，检索结果不可信）。

机制边界：本模块是「接口 + 注册表 + 合并排序 + 注入防线」，检索
执行体由宿主/领域层注册（文档库/FTS 索引/向量库 = 领域层，不落
引擎）。未知检索源/空结果 = 空清单（检索是增强，不阻断回合）。
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError
from .knowledge_gate import scan_text_injection
from .knowledge_set import KnowledgeSet
from .source_grading import (  # 来源分级单源（ENG3-4：与知识集共享，不再各自定义）
    _SOURCE_CREDIBILITY,
    SOURCE_DIALOG,
    SOURCE_MODEL,
    SOURCE_ORDER,
    SOURCE_USER,
    SOURCE_WEB,
    grade_level_for_credibility,
)

# 来源分级次序（SOURCE_ORDER 的查表形态；单源派生的分级权重，与
# 知识集/记忆同口径——ENG3-4/ENG3-19）
_LEVEL_RANK: dict[str, int] = {name: index for index, name in enumerate(SOURCE_ORDER)}

# 注册表默认配额（防检索源无限膨胀；宿主可参数化）
DEFAULT_MAX_RETRIEVERS = 32

# 单次检索默认条数与合并上限（钳制注入上下文体积）
DEFAULT_LIMIT = 8
MAX_LIMIT = 50


@dataclass(frozen=True, slots=True)
class RetrievedChunk:
    """一条检索结果（注入侧消费的统一形态）。

    Attributes:
        source: 检索源名（注册表内的源标识，如 fts/vector/mcp_search）。
        doc_id: 文档/条目 id（源内唯一）。
        text: 检索文本（注入上下文的主体）。
        relevance: 相关度（0-1；合并排序主键）。
        level: 来源可信度分级（web/dialog/model/user——注入防线的
            分级依据）。
        meta: 扩展元数据（命中位置/时间等，宿主语义）。
    """

    source: str
    doc_id: str
    text: str
    relevance: float = 0.0
    level: str = SOURCE_WEB
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "doc_id": self.doc_id,
            "text": self.text,
            "relevance": self.relevance,
            "level": self.level,
            "meta": dict(self.meta),
        }


@runtime_checkable
class Retriever(Protocol):
    """检索源接口（插拔 U 盘：新增检索源 = 注册实现，引擎零改动）。

    实现要求：name 唯一；retrieve 返回相关度降序清单（引擎不代
    排序——源内排序更接近语义实现）；失败应抛异常由注册表兜底
    （检索失败不击穿回合）。
    """

    name: str

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]: ...


class RetrieverRegistry:
    """检索源注册表（多源统一汇入：合并排序 + 分级标记 + 限流截断）。

    语义：
    - 同名注册覆盖（配置驱动）；配额超限显式拒绝；
    - retrieve = 各源并行取回 → 按 (relevance 降序, 分级权重降序)
      稳定合并 → limit 截断（钳制注入上下文体积）；
    - 单源失败静默跳过（检索是增强不是收紧），空结果 = 空清单。
    """

    def __init__(self, *, max_retrievers: int = DEFAULT_MAX_RETRIEVERS) -> None:
        self._retrievers: dict[str, Retriever] = {}
        self._max_retrievers = max_retrievers

    def register(self, retriever: Retriever) -> None:
        if len(self._retrievers) >= self._max_retrievers and retriever.name not in self._retrievers:
            raise GraphDefinitionError(
                f"检索源数量已达配额上限（{self._max_retrievers}）"
            )
        self._retrievers[retriever.name] = retriever

    def get(self, name: str) -> Retriever | None:
        return self._retrievers.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(self._retrievers)

    async def retrieve(
        self,
        query: str,
        *,
        limit: int = DEFAULT_LIMIT,
        levels: tuple[str, ...] | None = None,
    ) -> list[RetrievedChunk]:
        """多源合并检索：按相关度/分级合并排序 + 限流截断。

        Args:
            query: 检索查询。
            limit: 返回条数上限（钳制 [1, MAX_LIMIT]）。
            levels: 允许的可信度分级（None = 全部分级放行；注入防线
                可只放行 model/user 级来源，拦截 web/dialog 检索注入）。

        每源配额语义（ENG3-10）：``limit`` 是**每源取回上限**——各源
        均以该上限并行取回（``retriever.retrieve(query, limit=capped)``），
        合并后仍以同一上限全局截断。即单源配额 = 全局上限（不是
        limit/源数）：多源场景下低相关源不会因高相关源占满全局配额
        而整体挤出，但全局截断仍保证注入体积有界（每源取回可能
        多余实际消费，由全局截断兜底）。
        """
        capped = max(1, min(int(limit or 1), MAX_LIMIT))
        merged: list[RetrievedChunk] = []
        for retriever in self._retrievers.values():
            try:
                chunks = await retriever.retrieve(query, limit=capped)
            except Exception:
                continue  # 单源失败静默跳过（检索是增强不是收紧）
            for chunk in chunks:
                if levels is not None and chunk.level not in levels:
                    continue
                # 注入防线：检索文本检出指令型措辞 = 剔除（检索结果
                # 不可信——web/外部来源可能携带恶意指令，命中不入上下文）
                if scan_text_injection(chunk.text):
                    continue
                merged.append(chunk)
        merged.sort(
            key=lambda chunk: (
                chunk.relevance,
                _LEVEL_RANK.get(chunk.level, -1),
            ),
            reverse=True,
        )
        return merged[:capped]


class KnowledgeSetRetriever:
    """知识集 → 检索源适配（KnowledgeSet 注册为 Retriever；知识注入接线）。

    决策 E-P6「Retriever 注册路线」落点：KnowledgeSet 以本适配器形态
    注册进 :class:`RetrieverRegistry`，知识内容与文档库/向量库等检索源
    统一汇入（合并排序 + 注入防线同管）。检索执行体 = knowledge_set
    的关键词基线（无语义检索时确定性可断言；语义检索为可选扩展，宿主
    可自行注册更强检索源）。

    可信度分级透传（weight=credibility 注入面）：条目 credibility 按
    ``knowledge_set._SOURCE_CREDIBILITY`` 分级档映射为 chunk.level（与
    来源分级同口径：web < dialog < model < user），meta 携带原始
    credibility——注入侧据此设 ContextSource.weight（不再恒 1.0 / 仅
    二元过滤），分级预算分配真正生效。

    Args:
        knowledge_set: 知识集实例或延迟提供者（``Callable[[], KnowledgeSet]``
            ——运行时链恢复会替换知识集实例，提供者取用最新实例）。
        name: 检索源名（注册表内唯一标识，知识源固定名）。
    """

    def __init__(
        self,
        knowledge_set: KnowledgeSet | Callable[[], KnowledgeSet],
        *,
        name: str = "knowledge",
    ) -> None:
        self._set_provider: Callable[[], KnowledgeSet] = (
            knowledge_set if callable(knowledge_set) else (lambda: knowledge_set)
        )
        self.name = name

    @property
    def knowledge_set(self) -> KnowledgeSet:
        """当前知识集实例（延迟取用：运行时会合替换后仍读到最新）。"""
        return self._set_provider()

    async def retrieve(
        self, query: str, *, limit: int
    ) -> list[RetrievedChunk]:
        """知识条目检索：关键词基线命中 → 可信度分级透传的 chunk 清单。"""
        capped = max(1, min(int(limit or 1), MAX_LIMIT))
        hits = self.knowledge_set.search(query, limit=capped)
        chunks: list[RetrievedChunk] = []
        for entry in hits:
            chunks.append(
                RetrievedChunk(
                    source=self.name,
                    doc_id=entry.id,
                    text=entry.render_content(),
                    relevance=entry.credibility,
                    level=grade_level_for_credibility(entry.credibility),
                    meta={
                        "entry_id": entry.id,
                        "credibility": entry.credibility,
                        "kind": entry.kind,
                        "level": entry.level,
                    },
                )
            )
        return chunks


__all__ = [
    "DEFAULT_LIMIT",
    "DEFAULT_MAX_RETRIEVERS",
    "MAX_LIMIT",
    "SOURCE_DIALOG",
    "SOURCE_MODEL",
    "SOURCE_USER",
    "SOURCE_WEB",
    "KnowledgeSetRetriever",
    "RetrievedChunk",
    "Retriever",
    "RetrieverRegistry",
]

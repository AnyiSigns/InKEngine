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

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .exceptions import GraphDefinitionError
from .knowledge_gate import scan_text_injection

# 检索源可信度分级（与知识闸门对齐：web < dialog < model < user）
SOURCE_WEB = "web"
SOURCE_DIALOG = "dialog"
SOURCE_MODEL = "model"
SOURCE_USER = "user"

# 来源分级权重（合并排序时同 relevance 的分级次序依据）
_LEVEL_ORDER: dict[str, int] = {
    SOURCE_WEB: 0,
    SOURCE_DIALOG: 1,
    SOURCE_MODEL: 2,
    SOURCE_USER: 3,
}

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
                _LEVEL_ORDER.get(chunk.level, -1),
            ),
            reverse=True,
        )
        return merged[:capped]


__all__ = [
    "DEFAULT_LIMIT",
    "DEFAULT_MAX_RETRIEVERS",
    "MAX_LIMIT",
    "SOURCE_DIALOG",
    "SOURCE_MODEL",
    "SOURCE_USER",
    "SOURCE_WEB",
    "RetrievedChunk",
    "Retriever",
    "RetrieverRegistry",
]

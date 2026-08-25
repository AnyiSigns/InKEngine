"""调配域装配：五源输入装配源提供者 + 记忆/检索接线（设计文档第六节模块 M3）。

引擎机制（core.assembly.InputAssembler）按 AssemblyConfig 五源预算
（context/knowledge/tool/memory/evidence）对 ContextSource 分池裁剪；
本模块负责「源从哪来」——宿主侧装配：
- 记忆源：MemoryStore（storage 后端承载）+ PriorityRecallPolicy 召回
  + memory.json 失效窗口（未过期才可被召回）；
- 检索源：RetrieverRegistry 注入（配方 retrieval_sources 工厂产出），
  可选挂 embedding 向量化（缺省 None = 纯关键词基线，不降级语义）；
- 上下文融合钩子：ContextMixer + 融合失败自动回退确定性装配
  （fail-open：融合是增强，不阻断回合）；
- 域窗口投影/归档摘要：build_domain_window + archive_digest（按域
  切分共享消息流，归档摘要入记忆源）。
"""
from __future__ import annotations

import inspect
import json
from typing import Any

from ink_engine.core.assembly import (
    SOURCE_CONTEXT,
    SOURCE_EVIDENCE,
    SOURCE_KNOWLEDGE,
    SOURCE_MEMORY,
    SOURCE_TOOL,
)
from ink_engine.core.context import ContextSource
from ink_engine.core.knowledge_set import KnowledgeEntry
from ink_engine.core.memory import (
    MemoryEntry,
    MemoryQuery,
    MemoryStore,
    PriorityRecallPolicy,
)
from ink_engine.core.retrieval import (
    SOURCE_MODEL,
    RetrievedChunk,
    RetrieverRegistry,
)
from ink_engine.core.storage import Storage

# ── 记忆源装配 ──


def build_memory_store(storage: Storage, *, collection: str = "memory") -> MemoryStore:
    """记忆存储（storage 后端承载，collection 与 memory.json store.collection 对齐）。"""
    from ink_engine.core.memory import StorageBackedMemoryStore

    return StorageBackedMemoryStore(storage, collection=collection)


def memory_expiry_window(memory_data: dict[str, Any]) -> float | None:
    """memory.json 失效窗口（默认 90 天；None = 不过期）。"""
    days = float((memory_data.get("expiry") or {}).get("default_window_days", 90))
    return days * 24 * 3600 if days > 0 else None


async def recall_memory(
    store: MemoryStore,
    *,
    query: str | None = None,
    namespace: str | None = None,
    limit: int = 8,
) -> list[MemoryEntry]:
    """记忆召回：过期过滤（PriorityRecallPolicy 语义）+ 优先级排序截断。"""
    entries = await store.query(
        MemoryQuery(namespace=namespace or "user:default", limit=None)
    )
    return PriorityRecallPolicy().recall(entries, limit=limit)


# ── 检索源装配 ──


class KnowledgeSetRetriever:
    """知识集检索源：确定性关键词匹配（知识条目按可信度排序截断）。

    检索源工厂经配方 retrieval_sources 注入 RetrieverRegistry；召回
    结果按模型级可信度（SOURCE_MODEL）分级——注册表合并时按
    (relevance, 来源分级) 排序，注入文本在注册表边界被剔除
    （core.retrieval 的注入防线）。
    """

    name = "knowledge_set"

    def __init__(self, knowledge_set: Any, *, limit: int = 8) -> None:
        self._knowledge_set = knowledge_set
        self._limit = max(limit, 1)

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]:
        entries = self._knowledge_set.search(query, limit=self._limit)
        chunks = [
            RetrievedChunk(
                source=self.name,
                doc_id=entry.id,
                text=_render_entry(entry),
                relevance=entry.credibility,
                level=SOURCE_MODEL,
                meta={"kind": entry.kind, "level": entry.level},
            )
            for entry in entries
        ]
        return chunks[:limit]


class EmbeddingRetriever:
    """可选 [llm] 向量化检索源：embedder 缺省 None = 纯关键词基线。

    挂载 embedding 后，命中条目按向量相似度排序（relevance 由
    embedder 提供）；未挂载时语义层不降级——relevance 中性，
    排序交给知识集可信度（与 KnowledgeSetRetriever 同语义）。

    embedder.score 支持同步或协程（引擎 AsyncEmbedder 经
    :class:`EngineEmbedderBridge` 挂载时 score 为协程——awaitable
    统一净化）。
    """

    name = "embedding"

    def __init__(
        self,
        knowledge_set: Any,
        *,
        embedder: Any = None,
        limit: int = 8,
    ) -> None:
        self._knowledge_set = knowledge_set
        self._embedder = embedder
        self._limit = max(limit, 1)

    async def _score(self, query: str, entry: Any) -> float:
        score = self._embedder.score(query, entry)
        if inspect.isawaitable(score):
            score = await score
        return float(score)

    async def retrieve(self, query: str, *, limit: int) -> list[RetrievedChunk]:
        entries = self._knowledge_set.search(query, limit=self._limit)
        if self._embedder is None:
            chunks = [
                RetrievedChunk(
                    source=self.name,
                    doc_id=entry.id,
                    text=_render_entry(entry),
                    relevance=entry.credibility,
                    level=SOURCE_MODEL,
                    meta={"kind": entry.kind},
                )
                for entry in entries
            ]
        else:
            chunks = [
                RetrievedChunk(
                    source=self.name,
                    doc_id=entry.id,
                    text=_render_entry(entry),
                    relevance=min(await self._score(query, entry), 1.0),
                    level=SOURCE_MODEL,
                    meta={"kind": entry.kind, "semantic": True},
                )
                for entry in entries
            ]
        return chunks[:limit]


class EngineEmbedderBridge:
    """引擎 AsyncEmbedder → 种子检索源 score 接口桥（向量预编码 + cosine）。

    引擎 embedding 适配器（core.llm.embeddings：OpenAI 兼容 /embeddings，
    create_embedder 配置驱动）是异步向量接口；种子 EmbeddingRetriever 的
    score 需与查询语义共空间。本桥做：查询/条目向量预编码缓存（同轮多
    query 免重编）+ cosine 相似度（0-1 归一）；嵌入失败 = fail-open 返回
    0.0（该条目不因语义分排前——纯关键词基线兜底，不击穿检索）。
    """

    def __init__(self, embedder: Any, *, cache_limit: int = 512) -> None:
        self._embedder = embedder
        self._cache_limit = max(cache_limit, 1)
        self._doc_cache: dict[str, list[float]] = {}
        self._query_cache: dict[str, list[float]] = {}

    async def score(self, query: str, entry: Any) -> float:
        try:
            qvec = self._query_cache.get(query)
            if qvec is None:
                qvec = await self._embedder.aembed_query(query)
                if len(self._query_cache) >= self._cache_limit:
                    self._query_cache.clear()
                self._query_cache[query] = qvec
            doc_id = str(getattr(entry, "id", ""))
            evec = self._doc_cache.get(doc_id)
            if evec is None:
                text = _render_entry(entry)
                docs = await self._embedder.aembed_documents([text])
                if not docs:
                    return 0.0
                evec = docs[0]
                if len(self._doc_cache) >= self._cache_limit:
                    self._doc_cache.clear()
                self._doc_cache[doc_id] = evec
            return _cosine(qvec, evec)
        except Exception:
            return 0.0


def _cosine(a: list[float], b: list[float]) -> float:
    """cosine 相似度（0-1：同向 1 / 正交 0 / 反向 0；零向量回 0.0）。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = (sum(x * x for x in a)) ** 0.5
    nb = (sum(y * y for y in b)) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return max(0.0, min(dot / (na * nb), 1.0))


def _render_entry(entry: KnowledgeEntry) -> str:
    """知识条目渲染（标题 + 声明数据摘要，上下文体积有界）。"""
    body = json.dumps(entry.data, ensure_ascii=False)
    return f"{entry.title or entry.id}：{body[:500]}"


# ── 五源输入装配源提供者 ──


# 工具源预取上限（体积护栏：工具描述进装配文本的上界；预算级裁剪由
# InputAssembler 按 tool_ratio 池执行——预取只防大对象循环，动态纳入
# 的新工具不被硬上限截断出预算刷新之外）。
# 取值基准：出厂工具集 = 种子 25（含文件检索 grep/glob 与网络检索
# web_search）+ 引擎驻留观察 5 + 自指 4 ≈ 34，叠加挂载工具的纳入
# 余量——上限须大于「基线 + 首批动态挂载」之和，否则新挂载工具
# 在预取处被截断、下一回合预算刷不出（回归：出厂 22 → 25 时 32
# 上限溢出，动态组装用例失败）。
_MAX_TOOL_SOURCES = 48


def build_five_source_provider(
    *,
    memory_store: MemoryStore | None = None,
    retriever_registry: RetrieverRegistry | None = None,
    knowledge_set: Any = None,
    tool_specs: list[Any] | None = None,
    tool_specs_provider: Any = None,
    memory_namespace: str = "user:default",
    memory_limit: int = 8,
    evidence_limit: int = 8,
) -> Any:
    """五源输入装配源提供者（RunOptions.assembly_sources 注入形态）。

    每个源都是 ContextSource（type ∈ 五源分类），InputAssembler 按
    预算分池裁剪；提供者自身不裁剪——裁剪是引擎机制，宿主只供源。
    单源故障不阻断回合：记忆/检索/知识任一步失败，只缺该源
    （装配是增强，增强失败不能击穿执行）。

    工具源实时刷新（调配器动态组装）：传 ``tool_specs_provider``
    （如 ``runtime.collect_specs`` 的封装）时每次装配现取工具表——
    新挂载工具在下一回合自动纳入工具源预算；传 ``tool_specs`` 静态
    清单为兼容形态（缺省 None = 无工具源）。
    """

    def _specs_now() -> list[Any]:
        if tool_specs_provider is not None:
            return list(tool_specs_provider())
        return list(tool_specs or ())

    async def provide(ctx: Any) -> list[ContextSource]:
        query = str(ctx.state.get("input") or "").strip()
        sources: list[ContextSource] = []
        if query:
            sources.append(
                ContextSource(
                    type=SOURCE_CONTEXT,
                    content=query,
                    title="回合输入",
                    weight=1.0,
                    relevance=1.0,
                    priority=10,
                    meta={"source": "input"},
                )
            )
        if knowledge_set is not None and query:
            for entry in knowledge_set.search(query, limit=memory_limit):
                sources.append(
                    ContextSource(
                        type=SOURCE_KNOWLEDGE,
                        content=_render_entry(entry)[:800],
                        title=entry.title or entry.id,
                        weight=entry.credibility,
                        relevance=entry.credibility,
                        priority=entry.usage_count,
                        meta={"entry_id": entry.id, "kind": entry.kind},
                    )
                )
        specs = _specs_now()
        if specs:
            for spec in specs[:_MAX_TOOL_SOURCES]:
                sources.append(
                    ContextSource(
                        type=SOURCE_TOOL,
                        content=f"{spec.name}：{spec.description}",
                        title=f"工具：{spec.name}",
                        weight=0.8,
                        relevance=0.6,
                        priority=3,
                        meta={"tool": spec.name},
                    )
                )
        if memory_store is not None:
            try:
                recalled = await recall_memory(
                    memory_store, query=query, namespace=memory_namespace,
                    limit=memory_limit,
                )
                for entry in recalled:
                    sources.append(
                        ContextSource(
                            type=SOURCE_MEMORY,
                            content=entry.content[:800],
                            title=entry.title or entry.id,
                            weight=entry.weight,
                            relevance=min(entry.priority / 10, 1.0),
                            priority=entry.priority,
                            meta={"kind": entry.kind, "entry_id": entry.id},
                        )
                    )
            except Exception:
                pass
        if retriever_registry is not None and query:
            try:
                chunks = await retriever_registry.retrieve(
                    query, limit=evidence_limit, levels=(SOURCE_MODEL,)
                )
                for chunk in chunks:
                    sources.append(
                        ContextSource(
                            type=SOURCE_EVIDENCE,
                            content=chunk.text[:800],
                            title=f"检索：{chunk.source}/{chunk.doc_id}",
                            relevance=chunk.relevance,
                            priority=5,
                            meta={
                                "source": chunk.source,
                                "doc_id": chunk.doc_id,
                            },
                        )
                    )
            except Exception:
                pass
        return sources

    return provide


# ── 域窗口投影 / 归档摘要 ──


def project_domain_window(
    messages: list[Any],
    group: str,
    *,
    group_of: Any,
    max_tool_rounds: int = 8,
) -> list[Any]:
    """域窗口投影（core.context.build_domain_window 封装：按域切分消息流）。"""
    from ink_engine.core.context import build_domain_window

    return build_domain_window(
        messages, group, group_of=group_of, max_tool_rounds=max_tool_rounds
    )


def archive_digest(window: list[Any], *, max_chars: int = 800) -> str:
    """归档摘要（core.context.archive_digest 封装：确定性摘要入记忆源）。"""
    from ink_engine.core.context import archive_digest

    return archive_digest(window, max_chars=max_chars)


__all__ = [
    "EmbeddingRetriever",
    "KnowledgeSetRetriever",
    "archive_digest",
    "build_five_source_provider",
    "build_memory_store",
    "memory_expiry_window",
    "project_domain_window",
    "recall_memory",
]

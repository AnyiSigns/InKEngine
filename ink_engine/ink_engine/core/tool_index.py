"""工具向量索引（search_tools 的后端检索引擎）。

检索层落引擎侧（Python）：search_tools 是引擎自指工具、工具注册表在引擎，
检索发生在引擎 = 索引也在引擎，保持架构一致（shell 侧 embedder.rs 是嵌入
计算的 Rust 实现，经桥层供引擎调用；本模块只消费引擎侧 AsyncEmbedder 抽象，
不直接依赖 Rust 层）。

索引契约：
- 构建：48 工具 name+description → 向量，命名空间 ``tools``，一次构建。
- 增量刷新：工具增改 / MCP 挂载 hook 触发 ``refresh``，只重新嵌入变更条目
  （不重建全量）。
- 降级：嵌入层不可用（无配置 / 模型缺失 / 推理失败）= 关键词基线
  （子串 + 分词匹配），永不明返回空。
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .llm.tools import ToolSpec
from .logging import get_logger

logger = get_logger(__name__)

# 检索结果上限（search_tools 返回 ≤8 条）
MAX_RESULTS = 8

# 嵌入文本中 name 的权重倍数（name 更关键，重复多次提升匹配精度）
_NAME_REPEAT = 3


@dataclass
class ToolIndexEntry:
    """索引条目（工具 + 嵌入向量 + 检索元数据）。"""
    spec: ToolSpec
    vector: list[float] | None = None
    endpoint: str = "declarative"
    tier: str = "review"


@dataclass
class SearchResult:
    """单条检索结果（search_tools 返回的列表项）。"""
    name: str
    description: str
    parameters_summary: str
    tier: str
    endpoint: str
    score: float = 0.0


def _embed_texts(embedder, texts: list[str]) -> list[list[float]] | None:
    """批量嵌入；失败返回 None（调用方降级关键词基线）。"""
    if embedder is None:
        return None
    try:
        import asyncio

        if asyncio.iscoroutinefunction(embedder.aembed_documents):
            return _run_async_blocking(embedder.aembed_documents(texts))
        return embedder.aembed_documents(texts)
    except Exception as exc:
        logger.warning("工具嵌入失败，降级关键词基线: %s", exc)
        return None


def _run_async_blocking(coro) -> Any:
    """同步上下文运行协程（兼容既有事件循环：不在当前线程新建嵌套循环）。

    ``asyncio.new_event_loop().run_until_complete`` 在已有 running loop 的
    线程内会抛 RuntimeError（嵌套循环）。这里把协程交给专用线程的独立
    事件循环执行——调用线程既有的 loop 不受影响，线程循环关闭即释放。
    """
    import asyncio
    import threading

    result: dict[str, Any] = {}

    def _runner() -> None:
        loop = asyncio.new_event_loop()
        try:
            result["value"] = loop.run_until_complete(coro)
        except BaseException as exc:
            result["error"] = exc
        finally:
            loop.close()

    try:
        asyncio.get_running_loop()
        thread = threading.Thread(target=_runner, daemon=True)
        thread.start()
        thread.join()
    except RuntimeError:
        # 当前线程无 running loop：直接新建循环执行（单线程主路径）
        loop = asyncio.new_event_loop()
        try:
            result["value"] = loop.run_until_complete(coro)
        except BaseException as exc:
            result["error"] = exc
        finally:
            loop.close()
    if "error" in result:
        raise result["error"]
    return result.get("value")


def _cosine(a: list[float], b: list[float]) -> float:
    """余弦相似度（单位向量时等价于点积）。"""
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b, strict=False):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def _tokenize(text: str) -> set[str]:
    """简易分词：小写 + 非字母数字切分 + 连续中文字符逐字。"""
    lowered = text.lower()
    tokens: set[str] = set()
    for word in re.findall(r"[a-z0-9]+", lowered):
        tokens.add(word)
    for ch in lowered:
        if "一" <= ch <= "鿿":
            tokens.add(ch)
    return tokens


def _keyword_score(query_tokens: set[str], text: str) -> float:
    """关键词基线打分：query token 在文本中的命中密度。"""
    if not query_tokens:
        return 0.0
    text_tokens = _tokenize(text)
    if not text_tokens:
        return 0.0
    hits = sum(1 for t in query_tokens if t in text_tokens)
    return hits / len(query_tokens)


def _parameters_summary(parameters: dict | None) -> str:
    """参数 schema 的一句话摘要（只取必填属性名）。"""
    if not isinstance(parameters, dict):
        return "无参数"
    properties = parameters.get("properties")
    if not isinstance(properties, dict) or not properties:
        return "无参数"
    required = parameters.get("required") or []
    if required:
        return "必填: " + "/".join(str(k) for k in required)
    return "可选: " + "/".join(str(k) for k in list(properties.keys())[:4])


@dataclass
class ToolVectorIndex:
    """工具向量索引（构建一次、增量刷新、失败降级关键词基线）。

    Args:
        embedder: 引擎侧 AsyncEmbedder 实例（None = 纯关键词基线）。
        namespace: 命名空间（默认 ``tools``，隔离不同检索域）。
    """
    embedder: object | None = None
    namespace: str = "tools"
    _entries: dict[str, ToolIndexEntry] = field(default_factory=dict)
    _vectors_built: bool = False

    def _embed_text(self, spec: ToolSpec) -> str:
        """构造嵌入文本（name 加权 + description）。"""
        name_part = " ".join([spec.name] * _NAME_REPEAT)
        desc = spec.description or ""
        return f"{name_part} {desc}".strip()

    def build(self, specs: Iterable[ToolSpec], endpoints: dict[str, str] | None = None) -> None:
        """全量构建索引（首次或强制重建）。"""
        endpoints = endpoints or {}
        items = list(specs)
        texts = [self._embed_text(s) for s in items]
        vectors = _embed_texts(self.embedder, texts) if items else []
        if vectors is None:
            vectors = [None] * len(items)
        self._entries = {}
        for spec, vector in zip(items, vectors, strict=False):
            self._entries[spec.name] = ToolIndexEntry(
                spec=spec,
                vector=vector if vector else None,
                endpoint=endpoints.get(spec.name, "declarative"),
                tier=_tier_of(spec),
            )
        # 嵌入失败时 vector 全 None → 关键词基线
        self._vectors_built = any(e.vector is not None for e in self._entries.values())
        if not self._vectors_built:
            logger.info("工具向量索引：嵌入不可用，启用关键词基线（%d 工具）", len(self._entries))

    def refresh(self, specs: Iterable[ToolSpec], endpoints: dict[str, str] | None = None) -> None:
        """增量刷新：只重新嵌入新增/变更的条目。

        只收集需要重嵌的条目（新增 / 描述为空且无向量 / 端点或权限档
        变更），不重建全量；spec 与 name 成对收集，避免 zip 错位。
        """
        endpoints = endpoints or {}
        texts: list[str] = []
        targets: list[tuple[str, ToolSpec]] = []
        for spec in specs:
            entry = self._entries.get(spec.name)
            if (
                entry is not None
                and entry.vector is not None
                and spec.description
                and entry.endpoint == endpoints.get(spec.name, "declarative")
                and entry.tier == _tier_of(spec)
            ):
                # 已嵌入且内容/端点/档位未变：仅同步 spec 元数据（描述
                # 更新走重嵌路径，不在此静默跳过）
                self._entries[spec.name] = ToolIndexEntry(
                    spec=spec,
                    vector=entry.vector,
                    endpoint=entry.endpoint,
                    tier=entry.tier,
                )
                continue
            texts.append(self._embed_text(spec))
            targets.append((spec.name, spec))
        if not targets:
            return
        vectors = _embed_texts(self.embedder, texts) if texts else []
        if vectors is None:
            vectors = [None] * len(targets)
        for (name, spec), vector in zip(targets, vectors, strict=False):
            self._entries[name] = ToolIndexEntry(
                spec=spec,
                vector=vector if vector else None,
                endpoint=endpoints.get(name, "declarative"),
                tier=_tier_of(spec),
            )
        self._vectors_built = any(e.vector is not None for e in self._entries.values())

    def search(self, query: str, limit: int = MAX_RESULTS) -> list[SearchResult]:
        """检索：向量相似度优先，不可用时降级关键词基线。"""
        if not query or not self._entries:
            return []
        query = query.strip()
        if not query:
            return []
        if self._vectors_built and self.embedder is not None:
            return self._vector_search(query, limit)
        return self._keyword_search(query, limit)

    def _vector_search(self, query: str, limit: int) -> list[SearchResult]:
        """向量检索（query 嵌入 + 余弦相似度排序）。"""
        query_vector = None
        try:
            import asyncio

            if asyncio.iscoroutinefunction(self.embedder.aembed_query):
                query_vector = _run_async_blocking(self.embedder.aembed_query(query))
            else:
                query_vector = self.embedder.aembed_query(query)
        except Exception as exc:
            logger.warning("query 嵌入失败，降级关键词: %s", exc)
        if not query_vector:
            return self._keyword_search(query, limit)
        scored: list[tuple[float, ToolIndexEntry]] = []
        for entry in self._entries.values():
            if entry.vector is None:
                continue
            score = _cosine(query_vector, entry.vector)
            scored.append((score, entry))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [_to_result(entry, score) for score, entry in scored[:limit] if score > 0]

    def _keyword_search(self, query: str, limit: int) -> list[SearchResult]:
        """关键词基线检索（子串 + 分词匹配）。"""
        query_tokens = _tokenize(query)
        query_lower = query.lower()
        scored: list[tuple[float, ToolIndexEntry]] = []
        for entry in self._entries.values():
            text = self._embed_text(entry.spec)
            # 子串匹配加分
            substring_bonus = 0.5 if query_lower in text.lower() else 0.0
            token_score = _keyword_score(query_tokens, text)
            score = substring_bonus + token_score
            if score > 0:
                scored.append((score, entry))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [_to_result(entry, score) for score, entry in scored[:limit]]

    def has(self, name: str) -> bool:
        """索引是否含某工具名。"""
        return name in self._entries

    def spec(self, name: str) -> ToolSpec | None:
        """按名取工具描述（供 request_tool 注入用）。"""
        entry = self._entries.get(name)
        return entry.spec if entry else None

    def all_specs(self) -> list[ToolSpec]:
        """全部工具描述（供 merged_specs 全量清单）。"""
        return [e.spec for e in self._entries.values()]

    def uses_vectors(self) -> bool:
        """是否使用向量检索（False = 关键词基线降级）。"""
        return self._vectors_built

    def __len__(self) -> int:
        return len(self._entries)


def _tier_of(spec: ToolSpec) -> str:
    """权限档判定：introspection/self 直过；声明式默认 review。"""
    if spec.name.startswith("inspect_"):
        return "allow"
    if spec.name in _SELF_TOOL_NAMES:
        return "allow"
    return "review"


_SELF_TOOL_NAMES = frozenset({
    "propose_patch", "apply_patch", "revert_patch", "propose_domain_manifest",
    "search_tools", "request_tool",
})


def _to_result(entry: ToolIndexEntry, score: float) -> SearchResult:
    return SearchResult(
        name=entry.spec.name,
        description=entry.spec.description or "",
        parameters_summary=_parameters_summary(entry.spec.parameters),
        tier=entry.tier,
        endpoint=entry.endpoint,
        score=score,
    )


def build_default_embedder() -> object | None:
    """尝试构建默认 embedder（env 配置驱动）；失败返回 None。"""
    import os

    base_url = os.environ.get("INK_EMBEDDING_BASE_URL")
    model_id = os.environ.get("INK_EMBEDDING_MODEL")
    if not (base_url and model_id):
        return None
    try:
        from .llm.embeddings import create_embedder

        return create_embedder({
            "adapter": os.environ.get("INK_EMBEDDING_ADAPTER", "openai_compatible"),
            "model_id": model_id,
            "base_url": base_url,
            "api_key": os.environ.get("INK_EMBEDDING_API_KEY"),
        })
    except Exception as exc:
        logger.warning("默认 embedder 构建失败，降级关键词基线: %s", exc)
        return None


__all__ = [
    "SearchResult",
    "ToolIndexEntry",
    "ToolVectorIndex",
    "build_default_embedder",
]

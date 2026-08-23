"""路径指纹（组装结果的身份指纹；算法归引擎，使用方仅阈值覆盖权）。

指纹算法 = 复用图定义规范摘要（``Graph.digest``：sha256 规范摘要，
拓扑 + 节点/条件引用 + 子图 + schema 参与）。上下文指纹 = 图摘要 +
上下文/模型维度（供结果缓存按上下文命中）；使用方只留「相似度阈值」
覆盖权，算法本身引擎钉死。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

from .graph import Graph


def graph_fingerprint(graph: Graph) -> str:
    """路径指纹：图定义规范摘要（复用 Graph.digest，算法归引擎）。"""
    return graph.digest()


def context_fingerprint(
    graph: Graph,
    *,
    context: dict[str, Any] | None = None,
    model_id: str | None = None,
) -> str:
    """上下文指纹：图摘要 + 任务上下文 + 模型标识（缓存命中键形态）。

    模型/上下文漂移 = 指纹变化，旧条目自然不命中（与契约版本入键
    同语义：钉版本防静默复用漂移结果）。
    """
    payload = {
        "graph": graph.digest(),
        "context": context or {},
        "model_id": model_id or "",
    }
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


__all__ = ["context_fingerprint", "graph_fingerprint"]

"""Semantic embedding features: routing observes CONTENT, not hand-written types.

Answers the toy-domain critique "feature() is hand-written": with this feature
source, the router distinguishes add vs mul (same input shape, different
semantics) because the observation is a 1024-dim semantic vector.

Implementation:
  - real embedding: dashscope compatible-mode /embeddings,
    model qwen3.7-text-embedding-flash (1024 dim), cached per text
  - fallback: deterministic character-histogram pseudo-vector (16 dim) so the
    pipeline still runs offline / when the embedding API is down
  - the returned vector feeds graph routing via edge prototype vectors:
    logits += SEMANTIC_W * cosine(state_emb, edge.proto); prototypes are
    trained toward successful-path states (see learning/replay.py)

Usage: from embedding import embed; g = GraphEngine(feature_fn=embed)
Env: LLM_EMBED_KEY (dashscope key), optional LLM_EMBED_MODEL / LLM_EMBED_URL
"""

from __future__ import annotations

import functools
import json
import os
import urllib.request

EMBED_URL = os.environ.get(
    "LLM_EMBED_URL",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings")
EMBED_MODEL = os.environ.get("LLM_EMBED_MODEL", "qwen3.7-text-embedding-flash")
EMBED_KEY = os.environ.get("LLM_EMBED_KEY", "")

_DIM = 1024


def _hash_fallback(text: str) -> tuple[float, ...]:
    """Deterministic 16-dim character histogram (offline fallback)."""
    v = [0.0] * 16
    for ch in text:
        v[ord(ch) % 16] += 1.0
    n = sum(v) or 1.0
    return tuple(x / n for x in v)


@functools.lru_cache(maxsize=1024)
def embed(text: str) -> tuple[float, ...]:
    """Semantic embedding of a state payload, cached. Returns tuple[float,...].
    Key read at call time so callers may set LLM_EMBED_KEY after import."""
    key = os.environ.get("LLM_EMBED_KEY", "")
    if not key:
        return _hash_fallback(text)
    try:
        req = urllib.request.Request(
            EMBED_URL,
            data=json.dumps({"model": EMBED_MODEL, "input": text}).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"},
            method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        vec = data["data"][0]["embedding"]
        if isinstance(vec, list) and vec and isinstance(vec[0], (int, float)):
            return tuple(float(x) for x in vec)
        return _hash_fallback(text)
    except Exception:
        return _hash_fallback(text)


def embed_state(state: dict) -> tuple[float, ...]:
    """Feature function signature for Graph(feature_fn=...): state -> vector."""
    payload = state.get("payload")
    if isinstance(payload, (tuple, list)):
        text = " ".join(str(x) for x in payload)
    else:
        text = str(payload)
    return embed(text)

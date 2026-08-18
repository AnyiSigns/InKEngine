"""OpenAI 兼容 embedding 适配器单测（httpx.MockTransport 本地模拟，零真实网络）。

覆盖：单条 / 批量编码、向量解析、错误分类、缺字段配置、注册表选择。
"""
from __future__ import annotations

import json

import httpx
import pytest

from ink_engine.core.llm import (
    AsyncEmbedder,
    EmbeddingConfig,
    OpenAICompatibleEmbedder,
    create_embedder,
    embedder_names,
)
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMConfigError,
    LLMError,
)


def make_embedder(handler, **config_kw) -> tuple[OpenAICompatibleEmbedder, dict]:
    """构造注入 MockTransport 的 embedding 适配器；seen 记录请求与调用次数。"""
    seen = {"request": None, "calls": 0}

    def wrapper(request: httpx.Request) -> httpx.Response:
        seen["calls"] += 1
        seen["request"] = request
        return handler(request)

    transport = httpx.MockTransport(wrapper)
    base_config = {
        "adapter": "openai_compat",
        "model_id": "text-embedding-3-small",
        "base_url": "https://example.com/v1/",
        "api_key": "sk-test",
    }
    base_config.update(config_kw)
    config = EmbeddingConfig(**base_config)
    return OpenAICompatibleEmbedder(config, transport=transport), seen


async def test_query_returns_vector():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "text-embedding-3-small"
        assert body["input"] == "你好世界"
        return httpx.Response(
            200,
            json={"data": [{"object": "embedding", "index": 0, "embedding": [0.1, 0.2, 0.3]}]},
        )

    embedder, seen = make_embedder(handler)
    vector = await embedder.aembed_query("你好世界")
    assert vector == [0.1, 0.2, 0.3]
    assert seen["calls"] == 1


async def test_documents_preserve_order():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["input"] == ["a", "b", "c"]
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 2, "embedding": [0.3, 0.3]},
                    {"index": 0, "embedding": [0.1, 0.1]},
                    {"index": 1, "embedding": [0.2, 0.2]},
                ]
            },
        )

    embedder, _ = make_embedder(handler)
    vectors = await embedder.aembed_documents(["a", "b", "c"])
    assert vectors == [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]]


async def test_auth_error_classified():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": {"message": "invalid api key", "code": "auth_error"}},
        )

    embedder, _ = make_embedder(handler)
    with pytest.raises(LLMAuthError):
        await embedder.aembed_query("x")


async def test_bad_request_error_classified():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad input", "code": "invalid_request"}})

    embedder, _ = make_embedder(handler)
    with pytest.raises(LLMBadRequestError):
        await embedder.aembed_query("x")


async def test_missing_data_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"object": "list", "data": []})

    embedder, _ = make_embedder(handler)
    with pytest.raises(LLMError):
        await embedder.aembed_query("x")


async def test_extra_fields_forwarded():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body.get("dimensions") == 128
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.0]}]})

    cfg = EmbeddingConfig(
        adapter="openai_compat",
        model_id="m",
        base_url="https://example.com/v1/",
        extra={"dimensions": 128},
    )
    embedder = create_embedder(cfg)
    embedder._transport = httpx.MockTransport(handler)
    await embedder.aembed_query("x")


def test_config_requires_fields():
    with pytest.raises(LLMConfigError):
        EmbeddingConfig.from_dict({"adapter": "openai_compat", "model_id": "m"})


def test_registry_lists_openai_compat_aliases():
    names = embedder_names()
    for alias in ("openai", "deepseek", "dashscope", "ollama", "zhipu", "moonshot"):
        assert alias in names


def test_create_embedder_selects_adapter():
    embedder = create_embedder(
        {"adapter": "openai", "model_id": "m", "base_url": "https://api.openai.com/v1"}
    )
    assert isinstance(embedder, AsyncEmbedder)
    assert isinstance(embedder, OpenAICompatibleEmbedder)

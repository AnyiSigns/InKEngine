"""模型三挡配置 API 测试：读写往返 / key 剥离落库 / 连通性测试。"""

from __future__ import annotations

from ink_engine.core.llm import AsyncLLM, LLMConfig, LLMResult

from app import boot
from app import secrets as secrets_store


async def test_models_roundtrip_strips_api_key(client) -> None:
    resp = client.put(
        "/api/settings/models",
        json={
            "models": {
                "main": {
                    "adapter": "openai_compat",
                    "base_url": "https://api.example.com/v1",
                    "model_id": "test-model",
                    "api_key": "sk-secret-123",
                    "temperature": 0.7,
                    "max_tokens": None,
                    "request_timeout": 120,
                },
                "router": None,
                "audit": None,
            }
        },
    )
    assert resp.status_code == 200
    data = resp.json()["models"]
    assert data["main"]["api_key"] == "sk-secret-123"

    # key 不落引擎存储 records（读回置空），独立存 secrets.db
    storage = boot.get_app().storage
    record = await storage.get_record("settings", "models")
    assert record["main"]["api_key"] == ""
    assert await secrets_store.get_api_key("main") == "sk-secret-123"

    # 配置完整时 LLM 可解析（配置与 key 合并路径）
    llm = await boot.get_app().resolve_llm()
    assert llm is not None
    assert llm.config.model_id == "test-model"
    assert llm.config.api_key == "sk-secret-123"


async def test_models_invalid_tier_rejected(client) -> None:
    resp = client.put(
        "/api/settings/models",
        json={"models": {"bogus": None}},
    )
    assert resp.status_code == 400


async def test_models_test_endpoint_without_config(client) -> None:
    resp = client.post("/api/settings/models/test", json={"tier": "main"})
    assert resp.status_code == 400


async def test_models_test_endpoint_success(client, monkeypatch) -> None:
    client.put(
        "/api/settings/models",
        json={
            "models": {
                "main": {
                    "adapter": "openai_compat",
                    "base_url": "https://api.example.com/v1",
                    "model_id": "test-model",
                    "api_key": "",
                    "temperature": 0.7,
                    "max_tokens": None,
                    "request_timeout": 120,
                },
                "router": None,
                "audit": None,
            }
        },
    )
    from ink_engine.core.llm import registry as llm_registry

    class FakeLLM(AsyncLLM):
        def __init__(self, config: LLMConfig) -> None:
            super().__init__(config)

        async def ainvoke(self, messages, *, tools=None, params=None):
            return LLMResult(content="OK", finish_reason="stop")

        async def astream(self, messages, *, tools=None, params=None):
            if False:
                yield  # pragma: no cover

        async def aclose(self) -> None:
            pass

    monkeypatch.setattr(
        llm_registry, "_LLM_REGISTRY", {"openai_compat": FakeLLM}
    )
    resp = client.post("/api/settings/models/test", json={"tier": "main"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["reply"] == "OK"


async def test_chat_requires_model_config(client) -> None:
    resp = client.post("/api/chat", json={"message": "你好"})
    assert resp.status_code == 400
    assert "模型未配置" in resp.json()["detail"]

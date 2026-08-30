"""host-side compression verification: compression threshold scales with model_archive context_window.

Covers:
- ``_model_context_window_from_archive`` reads from model_archive.sqlite;
- ``InKlingHost.resolve_llm`` builds the compression policy from the archive
  context_window (after behavior-layer wrap, compression_policy().min_chars
  == 0.8 * cw);
- archive missing falls back to tier default (router 32k -> 26214; main 128k -> 104857).
"""

import asyncio
import json
import os
import sqlite3
import tempfile

from ink_engine.core.llm.base import AsyncLLM, LLMChunk, LLMConfig, LLMResult
from inkling_host.host import (
    InKlingHost,
    ThresholdCompressionPolicy,
    _model_config_from_file,
    _model_context_window_from_archive,
)


class _FakeLLM(AsyncLLM):
    adapter = "fake"

    def __init__(self, model_id):
        super().__init__(LLMConfig(adapter="fake", model_id=model_id, base_url="http://fake"))

    async def ainvoke(self, messages, *, tools=None, params=None):
        return LLMResult(content="r")

    async def astream(self, messages, *, tools=None, params=None):
        yield LLMChunk(token="x")

    async def aclose(self):
        pass


def _make_archive(data_dir, model_id, context_window):
    path = os.path.join(data_dir, "model_archive.sqlite")
    with sqlite3.connect(path) as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS model_archive "
            "(model_id TEXT PRIMARY KEY, context_window INTEGER, multimodal INTEGER, "
            "metadata TEXT, discovered_at TEXT)"
        )
        conn.execute(
            "INSERT OR REPLACE INTO model_archive (model_id, context_window) VALUES (?, ?)",
            (model_id, context_window),
        )
    return path


def test_read_context_window_from_archive():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _make_archive(d, "claude-main", 128 * 1024)
        assert _model_context_window_from_archive(d, "claude-main") == 128 * 1024
        # ?????? -> None
        assert _model_context_window_from_archive(d, "nope") is None
    # ? data_dir -> None
    assert _model_context_window_from_archive(None, "x") is None


def test_resolve_llm_builds_dynamic_policy():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _make_archive(d, "gpt-main", 128 * 1024)
        h = InKlingHost(llm=_FakeLLM("gpt-main"), data_dir=d)
        llm = asyncio.run(h.resolve_llm())
        assert llm is not None
        policy = h.compression_policy()
        assert isinstance(policy, ThresholdCompressionPolicy)
        # 128k -> 0.8 = 104857
        assert policy.min_chars == 104857


def test_resolve_llm_no_archive_falls_back_to_default_window():
    # 档案缺失 → 不再按档位推断（infer_compression_tier 已废弃）：
    # 回落 200k 兜底（0.8 × 200k = 160k），model_id 含 router 也不猜档
    h = InKlingHost(llm=_FakeLLM("gpt-router-x"))
    llm = asyncio.run(h.resolve_llm())
    assert llm is not None
    policy = h.compression_policy()
    assert policy.min_chars == 160_000


def test_resolve_llm_no_data_dir_falls_back_to_default_window():
    # 无 data_dir、档案缺失 → 回落 200k 兜底（160k），不报错
    h = InKlingHost(llm=_FakeLLM("some-main-model"))
    llm = asyncio.run(h.resolve_llm())
    assert llm is not None
    policy = h.compression_policy()
    assert policy.min_chars == 160_000


def _write_connection(data_dir, cfg):
    with open(os.path.join(data_dir, "model_connection.json"), "w", encoding="utf-8") as fh:
        json.dump(cfg, fh)


def test_model_config_from_file_full():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(
            d,
            {
                "base_url": "http://a/v1",
                "provider_id": "openai_compat",
                "main_model_id": "m1",
                "router_model_id": "r1",
            },
        )
        cfg = _model_config_from_file(d)
        assert cfg["base_url"] == "http://a/v1"
        assert cfg["model_id"] == "m1"
        assert cfg["adapter"] == "openai_compat"


def test_model_config_from_file_providers_array():
    """提供方数组形态（多提供方唯一权威）：取第一项为当前连接。"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(
            d,
            {
                "providers": [
                    {
                        "provider_id": "openai",
                        "adapter": "openai_compatible",
                        "base_url": "http://o/v1",
                        "api_key": "sk-o",
                        "model_ids": {"main": "gpt-4o", "router": "gpt-4o-mini"},
                        "compression_percent": 60,
                    },
                    {
                        "provider_id": "moonshot",
                        "adapter": "openai_compatible",
                        "base_url": "http://m/v1",
                        "model_ids": {"main": "kimi"},
                    },
                ]
            },
        )
        cfg = _model_config_from_file(d)
        assert cfg["base_url"] == "http://o/v1"
        assert cfg["model_id"] == "gpt-4o"
        assert cfg["adapter"] == "openai_compatible"
        assert cfg["api_key"] == "sk-o"
        assert cfg["compression_percent"] == 60.0


def test_resolve_model_llm_matches_provider_in_array(monkeypatch):
    """多提供方匹配：按 provider 取对应提供方建链（未匹配 = None）。"""
    captured: list[dict] = []

    def _fake_create(config):
        captured.append(dict(config))
        return _FakeLLM(str(config.get("model_id")))

    monkeypatch.setattr("inkling_host.host.create_llm", _fake_create)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(
            d,
            {
                "providers": [
                    {
                        "provider_id": "openai",
                        "adapter": "openai_compatible",
                        "base_url": "http://o/v1",
                        "api_key": "sk-o",
                        "model_ids": {"main": "gpt-4o"},
                    },
                    {
                        "provider_id": "anthropic",
                        "adapter": "anthropic_messages",
                        "base_url": "http://a/v1",
                        "model_ids": {"main": "claude"},
                    },
                ]
            },
        )
        h = InKlingHost(data_dir=d)
        llm = h.resolve_model_llm("anthropic", "claude-3.5")
        assert llm is not None
        assert captured and captured[-1]["model_id"] == "claude-3.5"
        assert captured[-1]["base_url"] == "http://a/v1"
        assert captured[-1]["adapter"] == "anthropic_messages"
        # 未配置提供方 → None
        assert h.resolve_model_llm("gemini", "gemini-2") is None
        # provider 缺省 = 当前连接第一项
        llm2 = h.resolve_model_llm(None, "gpt-5")
        assert llm2 is not None
        assert captured[-1]["base_url"] == "http://o/v1"


def test_model_config_from_file_router_fallback_when_main_empty():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(d, {"base_url": "http://a/v1", "router_model_id": "r1"})
        cfg = _model_config_from_file(d)
        assert cfg["model_id"] == "r1", "main 空时回落 router"


def test_model_config_from_file_missing_or_incomplete_returns_empty():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        # 无文件
        assert _model_config_from_file(d) == {}
        # 缺 base_url
        _write_connection(d, {"main_model_id": "m1"})
        assert _model_config_from_file(d) == {}
        # 缺 model_id
        _write_connection(d, {"base_url": "http://a/v1"})
        assert _model_config_from_file(d) == {}
    # data_dir None -> 空
    assert _model_config_from_file(None) == {}


def test_model_config_from_file_carries_compression_percent():
    """文件配置携带压缩占比（全局唯一旋钮的落盘字段）。"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(
            d,
            {
                "base_url": "http://a/v1",
                "main_model_id": "m1",
                "compression_percent": 60,
            },
        )
        cfg = _model_config_from_file(d)
        assert cfg["compression_percent"] == 60.0
        # 缺失 → 默认 80
        _write_connection(d, {"base_url": "http://a/v1", "main_model_id": "m2"})
        assert _model_config_from_file(d)["compression_percent"] == 80.0


def test_resolve_llm_uses_compression_ratio_knob(monkeypatch):
    """压缩占比旋钮接线：阈值 = 占比 × 档案窗口（不暴露 token 数）。

    create_llm 经 monkeypatch 换假工厂（本环境缺 openai_compat 的
    httpx 依赖；生产路径 create_llm 真建适配器连接）。
    """
    monkeypatch.setattr(
        "inkling_host.host.create_llm",
        lambda config: _FakeLLM(str(config.get("model_id"))),
    )
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _make_archive(d, "gpt-knob", 128 * 1024)
        _write_connection(
            d,
            {
                "base_url": "http://a/v1",
                "provider_id": "openai_compat",
                "main_model_id": "gpt-knob",
                "compression_percent": 50,
            },
        )
        h = InKlingHost(data_dir=d)
        assert asyncio.run(h.resolve_llm()) is not None
        policy = h.compression_policy()
        assert policy is not None
        # 128k × 50% = 65536
        assert policy.min_chars == 65_536


def test_resolve_llm_injected_llm_default_ratio():
    """注入 llm（无文件配置）：占比默认 0.8（128k × 0.8 = 104857）。"""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _make_archive(d, "injected", 128 * 1024)
        h = InKlingHost(llm=_FakeLLM("injected"), data_dir=d)
        assert asyncio.run(h.resolve_llm()) is not None
        policy = h.compression_policy()
        assert policy is not None
        assert policy.min_chars == 104_857


def test_resolve_model_llm_uses_entity_model_reference(monkeypatch):
    """按模型引用解析（EntitySpec.model）：连接提供方一致 → 建链；否则 None。"""
    captured: list[dict] = []

    def _fake_create(config):
        captured.append(dict(config))
        return _FakeLLM(str(config.get("model_id")))

    monkeypatch.setattr("inkling_host.host.create_llm", _fake_create)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        _write_connection(
            d,
            {
                "base_url": "http://a/v1",
                "provider_id": "openai_compat",
                "main_model_id": "m1",
            },
        )
        h = InKlingHost(data_dir=d)
        llm = h.resolve_model_llm("openai_compat", "kimi")
        assert llm is not None
        assert captured and captured[-1]["model_id"] == "kimi"
        assert captured[-1]["base_url"] == "http://a/v1"
        # 提供方不一致（当前连接 openai_compat）= 无此提供方 → None
        assert h.resolve_model_llm("anthropic", "claude") is None
        # 模型引用缺失 = None
        assert h.resolve_model_llm(None, "") is None
        assert h.resolve_model_llm("openai_compat", None) is None


if __name__ == "__main__":
    test_read_context_window_from_archive()
    test_resolve_llm_builds_dynamic_policy()
    test_resolve_llm_no_archive_falls_back_to_default_window()
    test_resolve_llm_no_data_dir_falls_back_to_default_window()
    test_model_config_from_file_full()
    test_model_config_from_file_router_fallback_when_main_empty()
    test_model_config_from_file_missing_or_incomplete_returns_empty()
    test_model_config_from_file_carries_compression_percent()
    test_resolve_llm_uses_compression_ratio_knob()
    test_resolve_llm_injected_llm_default_ratio()
    print("host compression all assertions passed")

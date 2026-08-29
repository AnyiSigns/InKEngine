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


def test_resolve_llm_router_tier_fallback():
    # ?????? router ???model id ? router?-> 32k -> 26214
    h = InKlingHost(llm=_FakeLLM("gpt-router-x"))
    llm = asyncio.run(h.resolve_llm())
    assert llm is not None
    policy = h.compression_policy()
    assert policy.min_chars == 26214


def test_resolve_llm_no_data_dir_tier_default():
    # 无 data_dir、档案缺失 → 按推断档位缺省（main 128k → 104857），不报错
    h = InKlingHost(llm=_FakeLLM("some-main-model"))
    llm = asyncio.run(h.resolve_llm())
    assert llm is not None
    policy = h.compression_policy()
    assert policy.min_chars == 104857


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


if __name__ == "__main__":
    test_read_context_window_from_archive()
    test_resolve_llm_builds_dynamic_policy()
    test_resolve_llm_router_tier_fallback()
    test_resolve_llm_no_data_dir_tier_default()
    test_model_config_from_file_full()
    test_model_config_from_file_router_fallback_when_main_empty()
    test_model_config_from_file_missing_or_incomplete_returns_empty()
    print("host compression all assertions passed")

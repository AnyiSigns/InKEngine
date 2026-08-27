"""logging.redact 的厂商 key 前缀覆盖回归。

修复前仅遮蔽 sk-/bearer/key= 等形态，gsk_/AIza 等厂商前缀明文落日志。
"""
from __future__ import annotations

import pytest

from ink_engine.core.logging import redact


@pytest.mark.parametrize(
    "text",
    [
        "密钥 gsk_AbCdEfGh12345678 已加载",
        "key=xai-AbCdEfGhIjKl12345678",
        "pplx-AbCdEfGh12345678",
        "sk-ant-AbCdEfGh12345678",
        "token=hf_AbCdEfGh12345678",
        "ghp_AbCdEfGh12345678",
        "github_pat_11ABCDEF12345678",
        "glpat-AbCdEfGh12345678",
        "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567890",
    ],
)
def test_redact_covers_vendor_key_prefixes(text):
    assert "[REDACTED]" in redact(text)
    assert text not in redact(text)


def test_redact_keeps_plain_text_and_short_prefixes():
    """非敏感形态原样；前缀后密钥段过短不误伤（防普通词被遮蔽）。"""
    assert redact("普通文本") == "普通文本"
    assert redact("") == ""
    assert redact("gsk_short") == "gsk_short"  # 密钥段过短，不是真凭据
    assert redact("AIza9short") == "AIza9short"


def test_redact_still_covers_legacy_forms():
    """既有形态不回退：sk-/bearer/key= 等仍被遮蔽。"""
    assert "sk-live-key-123" not in redact("sk-live-key-123")
    assert redact("Bearer abc123DEF456") != "Bearer abc123DEF456"
    assert redact("api_key=xyz123456") != "api_key=xyz123456"


def test_redact_idempotent():
    """遮蔽幂等（重复 redact 结果稳定）。"""
    raw = "密钥 gsk_AbCdEfGh12345678 与 AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz1234567890"
    once = redact(raw)
    assert redact(once) == once

"""security.is_sensitive_key / strip_sensitive 的驼峰与无下划线后缀覆盖。

回归 ENG5-2：修复前仅命中 _key/_token/_secret/_password 下划线线索尾，
clientSecret/openAiKey/authToken 等驼峰凭据键不被识别 → 凭据明文落库。
"""
from __future__ import annotations

import pytest

from ink_engine.core.security import SENSITIVE_KEYS, is_sensitive_key, strip_sensitive


@pytest.mark.parametrize(
    "key",
    [
        # 精确集合（含新增驼峰小写形态）
        "api_key",
        "clientsecret",
        "openaikey",
        "authtoken",
        "accesstoken",
        "refreshtoken",
        # 下划线后缀
        "openai_api_key",
        "client_secret",
        "auth_token",
        "db_password",
        # 无下划线后缀（词尾命中）
        "clientSecret",
        "openAiKey",
        "authToken",
        "accessToken",
        "refreshToken",
        "appKey",
        "privateKey",
        "secretKey",
        "masterToken",
        "userPassword",
        # 大小写不敏感
        "API_KEY",
        "ClientSecret",
        "OPENAIKEY",
    ],
)
def test_is_sensitive_key_detects_credential_forms(key):
    assert is_sensitive_key(key)


@pytest.mark.parametrize(
    "key",
    [
        "username",
        "content",
        "title",
        "key",  # 裸 key 字段名（中断键/记录主键等业务通用形态）不误伤
        "token_count",  # 指标键：_count 词尾不误伤
        "key_insight",  # 业务键：_insight 词尾不误伤
        "keywords",
        "keyboard",
    ],
)
def test_is_sensitive_key_does_not_误伤(key):
    assert not is_sensitive_key(key)


def test_camel_case_keys_stripped_recursively():
    """驼峰凭据键在嵌套结构中同样置空（落库路径回归）。"""
    data = {
        "clientSecret": "s3cr3t",
        "nested": {"openAiKey": "sk-abc", "keep": 1},
        "list": [{"authToken": "t"}, {"ok": 2}],
        "token_count": 3,
    }
    out = strip_sensitive(data)
    assert out["clientSecret"] == ""
    assert out["nested"]["openAiKey"] == ""
    assert out["nested"]["keep"] == 1
    assert out["list"][0]["authToken"] == ""
    assert out["list"][1]["ok"] == 2
    assert out["token_count"] == 3


def test_strip_sensitive_pure_and_copy_on_write():
    """无敏感键子树零拷贝（热路径）；有敏感键才产生新对象。"""
    plain = {"url": "https://example.com", "count": 2}
    assert strip_sensitive(plain) is plain
    dirty = {"clientSecret": "x"}
    assert strip_sensitive(dirty) is not dirty
    assert dirty["clientSecret"] == "x"  # 原对象不变（纯函数）


def test_sensitive_keys_set_contains_camel_case_forms():
    """常见驼峰凭据键显式入 SENSITIVE_KEYS（精确集合语义）。"""
    for key in ("clientsecret", "openaikey", "authtoken"):
        assert key in SENSITIVE_KEYS


def test_strip_sensitive_preserves_frozenset_type():
    """ENG6-14 回归：frozenset 输入返回 frozenset（集合类型不漂移）。"""
    from ink_engine.core.security import strip_sensitive

    frozen = frozenset({"a", "b"})
    out = strip_sensitive(frozen)
    assert isinstance(out, frozenset)
    assert out == frozen
    plain = {"a", "b"}
    out_set = strip_sensitive(plain)
    assert isinstance(out_set, set)
    assert out_set == plain

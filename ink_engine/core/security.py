"""checkpoint/事件记录落库前的敏感信息剥离（安全要求：状态永不落 key）。

继承 `_strip_api_key_from_checkpoint` 语义为引擎层默认：任何写入存储的
快照/记录在序列化前递归剔除敏感键（api_key/token/secret/authorization 等），
凭据只存在于运行期内存态，进程崩溃/异常快照也不会残留密钥。
"""
from __future__ import annotations

from typing import Any

from .patch_chain import Patch, PatchChain

# 敏感键（大小写不敏感匹配）：出现即从持久化数据中整体移除
SENSITIVE_KEYS: frozenset[str] = frozenset(
    {
        "api_key",
        "apikey",
        "api-key",
        "token",
        "secret",
        "authorization",
        "password",
        "access_token",
        "refresh_token",
    }
)

# 常见凭据键后缀（openai_api_key/client_secret/auth_token 等前后缀形态，
# 精确匹配覆盖不到；后缀命中基本即凭据，误伤面小）。
# 注意：启发式为保守剥离——任何以 _key/_token/_secret/_password 结尾的
# 非凭据字段也会被置空（当前 state 通道无此形态键；未来新增通道若属
# 业务数据且恰以此后缀命名，须在 SENSITIVE_KEYS 之外显式豁免）。
_SENSITIVE_SUFFIXES: tuple[str, ...] = ("_key", "_token", "_secret", "_password")


def is_sensitive_key(key: Any) -> bool:
    """判定键名是否携带凭据语义（精确集合 + 常见后缀启发式）。"""
    k = str(key).lower()
    return k in SENSITIVE_KEYS or k.endswith(_SENSITIVE_SUFFIXES)


def _strip_from_dict(data: dict[str, Any]) -> dict[str, Any]:
    # copy-on-write：子树无敏感键时返回原对象（事件/checkpoint 热路径零拷贝）
    result: dict[str, Any] = {}
    changed = False
    for key, value in data.items():
        if is_sensitive_key(key):
            # 置空保留（继承 _strip_model_config_api_keys 语义）：
            # 键结构不破坏，下游 .get("api_key") 恒返回空串，防残留密钥
            result[key] = ""
            changed = True
            continue
        stripped = strip_sensitive(value)
        if stripped is not value:
            changed = True
        result[key] = stripped
    return result if changed else data


def strip_sensitive(value: Any) -> Any:
    """递归剥离敏感键（dict 按键剔除；list/tuple 逐项递归；其余原样返回）。

    PatchChain 是引擎主内容通道（正文/设定），其 base 与每条补丁的 value
    同样递归剥离——否则 ``CheckpointRecord.to_dict`` 的序列化会让敏感键经
    PatchChain 绕过。剥离是纯函数（不改原结构，PatchChain 返回新链），
    copy-on-write：子树不含敏感键时返回原对象，热路径零拷贝。
    """
    if isinstance(value, PatchChain):
        return PatchChain(
            base=_strip_from_dict(value.base),
            patches=[
                Patch(op=p.op, path=p.path, value=strip_sensitive(p.value))
                for p in value.patches
            ],
        )
    if isinstance(value, dict):
        return _strip_from_dict(value)
    if isinstance(value, list):
        out = [strip_sensitive(item) for item in value]
        return out if any(o is not v for o, v in zip(out, value, strict=True)) else value
    if isinstance(value, tuple):
        out = tuple(strip_sensitive(item) for item in value)
        return out if any(o is not v for o, v in zip(out, value, strict=True)) else value
    return value


__all__ = ["SENSITIVE_KEYS", "is_sensitive_key", "strip_sensitive"]


"""checkpoint/事件记录落库前的敏感信息剥离（安全要求：状态永不落 key）。

继承 `_strip_api_key_from_checkpoint` 语义为引擎层默认：任何写入存储的
快照/记录在序列化前递归剔除敏感键（api_key/token/secret/authorization 等），
凭据只存在于运行期内存态，进程崩溃/异常快照也不会残留密钥。
"""
from __future__ import annotations

import re
from typing import Any

from .patch_chain import Patch, PatchChain

# 敏感键（大小写不敏感匹配）：出现即从持久化数据中整体移除。
# 含常见驼峰凭据键的小写形态（clientSecret/openAiKey/authToken 等）——
# 精确集合命中优先，无需依赖后缀启发式。
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
        "clientsecret",
        "openaikey",
        "authtoken",
        "accesstoken",
        "refreshtoken",
        "privatekey",
        "secretkey",
    }
)

# 常见凭据键后缀（openai_api_key/client_secret/auth_token 等前后缀形态，
# 精确匹配覆盖不到；分隔符后缀命中基本即凭据，误伤面小）。
_SENSITIVE_SUFFIXES: tuple[str, ...] = (
    "_key",
    "_token",
    "_secret",
    "_password",
    "_keys",
    "_tokens",
    "_secrets",
    "_passwords",
    "_credentials",
)

# 凭据词末组件集合（组件化判定：仅当键名的「末组件」为凭据词时才命中）。
# 与后缀启发式的区别：monkey/keyboard/turkey 等以 key 结尾的普通英文词
# 末组件不是独立凭据词，不再被误伤（S-1 修复：词尾启发式过宽）。
_CREDENTIAL_WORDS: frozenset[str] = frozenset(
    {
        "key",
        "keys",
        "token",
        "tokens",
        "secret",
        "secrets",
        "password",
        "passwords",
        "credential",
        "credentials",
    }
)

# 组件分隔符（_ / - / . 任一分隔后末组件为凭据词 → 敏感）
_COMPONENT_SEPARATORS = ("_", "-", ".")

# 驼峰边界（clientSecret/openAiKey/authToken 等拼接形态的判定依据：
# 原键存在小写→大写边界 + 词尾为凭据词 → 敏感——camelCase 标识符是
# 代码产物形态，出现以 key/token/secret 结尾的驼峰词基本即凭据）
_CAMEL_BOUNDARY_RE = re.compile(r"(?<=[a-z])(?=[A-Z])")


def is_sensitive_key(key: Any) -> bool:
    """判定键名是否携带凭据语义（精确集合 + 后缀 + 组件化词尾判定）。

    判定顺序（fail-closed 优先）：
    1. 精确集合（api_key/token/authorization/常见驼峰小写形态）——恒敏感；
    2. 分隔符后缀（openai_api_key/client_secret/auth_token 等）——恒敏感；
    3. 末组件判定：_ / - / . 分隔的末组件为凭据词（``auth-token``、
       ``my.secret`` 等，需存在分隔符——裸 ``key`` 字段名是业务通用形态，
       如中断键 InterruptState.key，不视为凭据）；
    4. 驼峰拼接判定：原键存在驼峰边界且词尾为凭据词（``clientSecret``/
       ``masterToken``/``userPassword``；``monkey``/``keyboard`` 无驼峰
       边界不命中）。极少见的全小写无分隔拼接形态（如 ``myapikey``）
       不再命中——精确集合已覆盖常见形态，此类键应显式入集合。
    """
    original = str(key)
    k = original.lower()
    if k in SENSITIVE_KEYS or k.endswith(_SENSITIVE_SUFFIXES):
        return True
    # 末组件判定（须有分隔符：末组件完整词才命中，token_count 等指标键
    # 末组件为 count 不误伤；secret_note 末组件 note 不误伤；裸 key 无
    # 分隔符不命中）
    last_sep = max(
        (k.rfind(sep) for sep in _COMPONENT_SEPARATORS),
        default=-1,
    )
    if last_sep > 0 and last_sep < len(k) - 1:
        if k[last_sep + 1 :] in _CREDENTIAL_WORDS:
            return True
    # 驼峰拼接形态（原键判边界：lower 化后边界信息丢失，须用原键）
    if _CAMEL_BOUNDARY_RE.search(original) and k.endswith(tuple(_CREDENTIAL_WORDS)):
        return True
    return False


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

    PatchChain 是引擎主内容通道（内容工作区），其 base 与每条补丁的 value
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
    if isinstance(value, frozenset):
        # frozenset 保持集合类型（ENG6-14）：剥离不漂移类型——frozenset
        # 输入返回 frozenset，set 输入返回 set（同型返回，恒等时零拷贝）
        out = frozenset(strip_sensitive(item) for item in value)
        return out if out != value else value
    if isinstance(value, set):
        out = {strip_sensitive(item) for item in value}
        return out if out != value else value
    return value


__all__ = ["SENSITIVE_KEYS", "is_sensitive_key", "strip_sensitive"]


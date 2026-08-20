"""Forge 数据目录与设置读写（沿用 lite 约定：~/.textforge）。

用户集 = 产品本体，落在 ``sets/<set_id>/`` 下：引擎存储 engine.db、
设置 settings.json、进程锁均在集目录内（当前固定 default 单集）。
凭据独立存放（secrets.db 在集外，key 不落集内数据通道）；settings.json
不保存任何 key 明文。目录可通过 TEXTFORGE_HOME 环境变量整体迁移。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

TEXTFORGE_HOME = Path(
    os.environ.get("TEXTFORGE_HOME") or Path.home() / ".textforge"
)

# Web 壳监听端口（桌面壳与 CLI 附加模式共用，单一来源）
WEB_PORT = 8010

# 用户集（当前固定 default 单集；多集为后续服务化演进）
SET_ID = "default"
SETS_DIR = TEXTFORGE_HOME / "sets"
SET_DIR = SETS_DIR / SET_ID

ENGINE_DB_PATH = SET_DIR / "engine.db"
LOCK_PATH = SET_DIR / ".forge.lock"
SETTINGS_PATH = SET_DIR / "settings.json"
# 凭据独立于集内数据通道（与 lite 同根：同机同用户共享模型密钥）
SECRETS_DB_PATH = TEXTFORGE_HOME / "secrets.db"

DEFAULT_SETTINGS: dict[str, Any] = {
    "theme": "dark",
}


def ensure_home() -> None:
    """创建数据目录（幂等，启动时调用）。"""
    for path in (TEXTFORGE_HOME, SETS_DIR, SET_DIR):
        path.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict[str, Any]:
    """读取 settings.json；不存在或损坏时回落默认值（不覆盖坏文件）。"""
    if not SETTINGS_PATH.exists():
        return json.loads(json.dumps(DEFAULT_SETTINGS))
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return json.loads(json.dumps(DEFAULT_SETTINGS))
    merged = json.loads(json.dumps(DEFAULT_SETTINGS))
    merged.update(data)
    return merged


def save_settings(settings: dict[str, Any]) -> None:
    """写回 settings.json（原子写：临时文件 + rename）。"""
    ensure_home()
    tmp = SETTINGS_PATH.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(SETTINGS_PATH)

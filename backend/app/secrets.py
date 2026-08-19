"""模型 API key 独立存储（集外 secrets.db）。

引擎存储对全部通道（checkpoint/事件/records/补丁链/审批卡）剥离敏感键，
key 不能经 records 落库——故单独存此库（独立文件，避免与 engine.db 的
schema 自检/删库指令互相干扰）。键值不入 checkpoint、不入事件日志、
不入 settings.json。
"""

from __future__ import annotations

import aiosqlite

from . import config

_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_secrets (
    tier TEXT PRIMARY KEY,
    api_key TEXT NOT NULL
);
"""


async def _connect() -> aiosqlite.Connection:
    config.SECRETS_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = await aiosqlite.connect(config.SECRETS_DB_PATH)
    await conn.execute(_SCHEMA)
    return conn


async def get_api_key(tier: str) -> str:
    conn = await _connect()
    try:
        cursor = await conn.execute(
            "SELECT api_key FROM model_secrets WHERE tier = ?", (tier,)
        )
        row = await cursor.fetchone()
        await cursor.close()
        return row[0] if row else ""
    finally:
        await conn.close()


async def set_api_key(tier: str, api_key: str) -> None:
    conn = await _connect()
    try:
        await conn.execute(
            "INSERT INTO model_secrets (tier, api_key) VALUES (?, ?) "
            "ON CONFLICT(tier) DO UPDATE SET api_key = excluded.api_key",
            (tier, api_key),
        )
        await conn.commit()
    finally:
        await conn.close()

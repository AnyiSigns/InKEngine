"""Forge 后端测试共享基础设施。

数据目录隔离：每个用例通过 monkeypatch 把 config 的路径常量指向
临时目录（engine.py/secrets.py 均经 config 模块运行期取路径），
彻底隔离用例间的 sqlite/锁/密钥文件。每个用例前后复位应用级单例
（装配产物/引擎存储/设置缓存），保证用例互不串扰。
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def textforge_home(tmp_path, monkeypatch):
    """隔离的数据目录（~/.textforge 重定向到临时目录）。"""
    from app import config

    home = tmp_path / "textforge"
    set_dir = home / "sets" / "default"
    monkeypatch.setattr(config, "TEXTFORGE_HOME", home)
    monkeypatch.setattr(config, "SETS_DIR", home / "sets")
    monkeypatch.setattr(config, "SET_DIR", set_dir)
    monkeypatch.setattr(config, "ENGINE_DB_PATH", set_dir / "engine.db")
    monkeypatch.setattr(config, "LOCK_PATH", set_dir / ".forge.lock")
    monkeypatch.setattr(config, "SETTINGS_PATH", set_dir / "settings.json")
    monkeypatch.setattr(config, "SECRETS_DB_PATH", home / "secrets.db")
    return home


@pytest.fixture(autouse=True)
async def reset_app(textforge_home):
    """每个用例前后复位应用级单例（装配产物/存储/设置缓存）。"""
    from app import boot, engine, state

    boot._app = None
    engine._storage = None
    engine._process_lock = None
    state._store = None
    yield
    await boot.close_app()


@pytest.fixture
def client(reset_app):
    """带 lifespan 的 ASGI 测试客户端（进入即完成开局装配）。"""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client

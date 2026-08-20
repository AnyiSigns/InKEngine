"""文件域单测：挂载点模型（注册/撤销/清单 + 路径-权限双锁校验 + 系统目录拒绝）。

覆盖：注册/撤销/清单往返、系统级目录硬拒绝、非法权限级拒绝、
路径规范化（相对路径/../ 逃逸）、目录边界匹配（同名前缀不误匹配）、
权限分级满足（read < write < execute）、fail-closed（无挂载点/权限
不足 → None）、挂载点内浏览与越界 403、storage 持久化。
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from app import boot
from app.domains.files.mounts import (
    MOUNT_LEVEL_EXECUTE,
    MOUNT_LEVEL_READ,
    MOUNT_LEVEL_WRITE,
    MountRegistry,
    normalize_path,
)


@pytest.fixture
async def registry(reset_app):
    app = await boot.init_app()
    return MountRegistry(app.storage)


async def test_register_list_revoke_roundtrip(registry) -> None:
    base = tempfile.gettempdir()
    record = await registry.register(path=base, level=MOUNT_LEVEL_READ, note="测试")
    mounts = await registry.list_mounts()
    assert len(mounts) == 1
    assert mounts[0].id == record.id
    assert mounts[0].path == str(Path(base).resolve())
    assert mounts[0].level == MOUNT_LEVEL_READ
    assert mounts[0].app == "forge"
    await registry.revoke(record.id)
    assert await registry.list_mounts() == []


async def test_revoke_leaves_audit_trace(registry) -> None:
    # 撤销留痕：原记录保留 revoked 标记（append-only，历史不撒谎）
    base = Path(tempfile.gettempdir()) / "forge_revoke_trace"
    record = await registry.register(path=str(base), level=MOUNT_LEVEL_READ)
    await registry.revoke(record.id)
    raw = await registry._storage.get_record("file_mounts", record.id)
    assert raw is not None
    assert raw["revoked"] is True


async def test_revoke_unknown_rejected(registry) -> None:
    with pytest.raises(KeyError, match="挂载点不存在"):
        await registry.revoke("missing")


async def test_register_system_dir_rejected(registry) -> None:
    # 系统级目录硬拒绝（白名单外 fail-closed：系统根/系统目录/程序目录）
    system_root = Path(os.environ.get("SYSTEMROOT") or "C:/Windows")
    with pytest.raises(PermissionError, match="系统级目录拒绝"):
        await registry.register(path=str(system_root), level=MOUNT_LEVEL_READ)
    with pytest.raises(PermissionError):
        await registry.register(path=str(system_root.parent), level=MOUNT_LEVEL_READ)
    program_files = Path("C:/Program Files")
    if program_files.exists():
        with pytest.raises(PermissionError):
            await registry.register(path=str(program_files), level=MOUNT_LEVEL_READ)


async def test_register_invalid_level_rejected(registry) -> None:
    with pytest.raises(ValueError, match="权限级非法"):
        await registry.register(path=tempfile.gettempdir(), level="root")


async def test_register_normalizes_relative_and_escape(registry) -> None:
    # 相对路径/../ 逃逸规范化：落库即绝对化（防路径穿越）
    record = await registry.register(
        path=os.path.join(tempfile.gettempdir(), "..", "forge_rel"),
        level=MOUNT_LEVEL_READ,
    )
    assert Path(record.path).is_absolute()
    assert Path(record.path) == normalize_path(record.path)
    assert Path(record.path).name == "forge_rel"


async def test_check_boundary_no_similar_prefix(registry) -> None:
    # 目录边界：D:/Novels 挂载点不匹配 D:/Novels2（同名前缀防误匹配）
    base = Path(tempfile.gettempdir()) / "forge_mount_test"
    mount_a = base / "Novels"
    mount_b = base / "Novels2"
    await registry.register(path=str(mount_a), level=MOUNT_LEVEL_READ)
    assert await registry.check(str(mount_a / "ch1.md"), level=MOUNT_LEVEL_READ) is not None
    assert await registry.check(str(mount_b / "x.txt"), level=MOUNT_LEVEL_READ) is None
    assert await registry.check(str(mount_b), level=MOUNT_LEVEL_READ) is None


async def test_check_level_satisfaction(registry) -> None:
    # 权限分级满足：write 挂载点允许 read 请求；read 挂载点拒绝 write 请求
    base = Path(tempfile.gettempdir()) / "forge_level_test"
    await registry.register(path=str(base / "docs"), level=MOUNT_LEVEL_READ)
    await registry.register(path=str(base / "work"), level=MOUNT_LEVEL_WRITE)
    assert await registry.check(str(base / "work" / "a.txt"), level=MOUNT_LEVEL_READ) is not None
    assert await registry.check(str(base / "work" / "a.txt"), level=MOUNT_LEVEL_WRITE) is not None
    assert await registry.check(str(base / "docs" / "a.txt"), level=MOUNT_LEVEL_WRITE) is None
    assert await registry.check(str(base / "docs" / "a.txt"), level=MOUNT_LEVEL_EXECUTE) is None
    # 非法请求级 fail-closed
    assert await registry.check(str(base / "work"), level="root") is None


async def test_check_fail_closed_unmounted(registry) -> None:
    # 未授权路径 fail-closed（磁盘其余部分不可见）
    elsewhere = Path(tempfile.gettempdir()) / "forge_unmounted_secret"
    assert await registry.check(str(elsewhere), level=MOUNT_LEVEL_READ) is None


async def test_browse_within_mount(registry) -> None:
    base = Path(tempfile.gettempdir()) / "forge_browse_test"
    (base / "sub").mkdir(parents=True, exist_ok=True)
    (base / "a.txt").write_text("hello", encoding="utf-8")
    await registry.register(path=str(base), level=MOUNT_LEVEL_READ)
    result = await registry.browse(str(base))
    assert result is not None
    names = {entry["name"] for entry in result["entries"]}
    assert "a.txt" in names
    assert "sub" in names
    # 挂载点外浏览 fail-closed
    assert await registry.browse(str(base / ".." / "elsewhere")) is None


async def test_mounts_persist_across_restart(reset_app) -> None:
    # 挂载点随集持久化（storage records 通道；重装后仍在）
    from app import engine as engine_store

    app = await boot.init_app()
    await MountRegistry(app.storage).register(
        path=tempfile.gettempdir(), level=MOUNT_LEVEL_READ, app="novel"
    )
    boot._app = None
    engine_store._storage = None
    engine_store._process_lock = None
    app2 = await boot.init_app()
    mounts = await MountRegistry(app2.storage).list_mounts()
    assert len(mounts) == 1
    assert mounts[0].app == "novel"


def test_mounts_api_flow(client) -> None:
    # 端点流程：注册 → 列表 → 浏览 → 撤销；越界浏览 403
    base = Path(tempfile.gettempdir()) / "forge_api_test"
    base.mkdir(parents=True, exist_ok=True)
    (base / "note.md").write_text("# 测试", encoding="utf-8")
    resp = client.post(
        "/api/files/mounts",
        json={"path": str(base), "level": MOUNT_LEVEL_READ, "note": "API 测试"},
    )
    assert resp.status_code == 200
    mount_id = resp.json()["id"]
    mounts = client.get("/api/files/mounts").json()["mounts"]
    assert any(m["id"] == mount_id for m in mounts)
    browse = client.get("/api/files/browse", params={"path": str(base)})
    assert browse.status_code == 200
    assert "note.md" in {e["name"] for e in browse.json()["entries"]}
    denied = client.get(
        "/api/files/browse", params={"path": str(Path.home() / "secret_stuff")}
    )
    assert denied.status_code == 403
    resp = client.delete(f"/api/files/mounts/{mount_id}")
    assert resp.status_code == 200
    assert client.delete("/api/files/mounts/{mount_id}").status_code == 404


def test_mounts_api_rejects_system_and_invalid(client) -> None:
    system_root = Path(os.environ.get("SYSTEMROOT") or "C:/Windows")
    resp = client.post("/api/files/mounts", json={"path": str(system_root)})
    assert resp.status_code == 422
    resp = client.post("/api/files/mounts", json={"path": tempfile.gettempdir(), "level": "root"})
    assert resp.status_code == 422
    resp = client.post("/api/files/mounts", json={"level": MOUNT_LEVEL_READ})
    assert resp.status_code == 422

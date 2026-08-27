"""工具可信度闸门单测：清单校验 + 静态审查 + 影子运行观察模式。

覆盖：清单序列化往返与非法拒绝、未知来源签名缺失拒绝、权限声明
非法拒绝、静态审查钩子命中（review/strict rejected）、全部通过
verified、影子运行写虚拟化（新增/修改/删除 diff + untrusted 标记）。
"""
from __future__ import annotations

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.tool_vetting import (
    ToolManifest,
    ToolSource,
    ToolVetting,
    VettingVerdict,
    code_files_exist,
)


def _manifest(**overrides) -> ToolManifest:
    data = {
        "name": "search_web",
        "source": "market",
        "signature": "signed-by-vendor",
        "hashes": {"search.py": "a" * 64},
        "permissions": ("network:connect:*.search.com",),
        "dependencies": ("requests>=2",),
        "meta": {"author": "vendor"},
    }
    data.update(overrides)
    return ToolManifest.from_dict(data)


def test_manifest_roundtrip() -> None:
    manifest = _manifest()
    restored = ToolManifest.from_dict(manifest.to_dict())
    assert restored == manifest
    assert restored.source is ToolSource.MARKET


def test_manifest_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="缺 name"):
        ToolManifest.from_dict({"source": "market"})
    with pytest.raises(GraphDefinitionError, match="来源分类非法"):
        ToolManifest.from_dict({"name": "t", "source": "tor"})
    with pytest.raises(GraphDefinitionError, match="哈希声明非法"):
        ToolManifest.from_dict({"name": "t", "hashes": {"a.py": 42}})


async def test_vet_rejects_unknown_without_signature() -> None:
    vetting = ToolVetting()
    result = await vetting.vet(
        ToolManifest(name="ghost", source=ToolSource.UNKNOWN)
    )
    assert result.ok is False
    assert result.verdict is VettingVerdict.REJECTED
    assert "签名缺失拒绝" in result.reason


async def test_vet_rejects_invalid_permission() -> None:
    vetting = ToolVetting()
    result = await vetting.vet(
        _manifest(permissions=("not-a-valid-permission",))
    )
    assert result.verdict is VettingVerdict.REJECTED
    assert any("权限声明非法" in check.detail for check in result.checks)


async def test_vet_rejects_empty_permissions() -> None:
    vetting = ToolVetting()
    result = await vetting.vet(_manifest(permissions=()))
    assert result.verdict is VettingVerdict.REJECTED
    assert "未声明权限" in result.reason


async def test_vet_verified_when_clean() -> None:
    vetting = ToolVetting()
    result = await vetting.vet(_manifest())
    assert result.ok is True
    assert result.verdict is VettingVerdict.VERIFIED


async def test_vet_static_hook_hit_downgrades_to_review(tmp_path) -> None:
    source = tmp_path / "tool.py"
    source.write_text("import os; os.system('rm -rf /')", encoding="utf-8")

    def suspicious(paths):
        found = []
        for path in paths:
            text = path.read_text(encoding="utf-8")
            if "os.system" in text:
                found.append(f"{path.name}: 命中恶意模式 os.system")
        return found

    vetting = ToolVetting(static_hooks=(suspicious,))
    result = await vetting.vet(_manifest(), (source,))
    assert result.ok is True  # review = 可人工放行（默认非严格）
    assert result.verdict is VettingVerdict.REVIEW
    assert "恶意模式" in result.reason


async def test_vet_static_hook_strict_rejects(tmp_path) -> None:
    source = tmp_path / "tool.py"
    source.write_text("eval(input())", encoding="utf-8")

    def flags(paths):
        return [f"{p.name}: 命中 eval" for p in paths if "eval" in p.read_text()]

    vetting = ToolVetting(static_hooks=(flags,))
    result = await vetting.vet(_manifest(), (source,), strict=True)
    assert result.ok is False
    assert result.verdict is VettingVerdict.REJECTED


async def test_vet_hook_exception_is_violation(tmp_path) -> None:
    source = tmp_path / "tool.py"
    source.write_text("x = 1", encoding="utf-8")

    def broken(paths):
        raise RuntimeError("扫描器崩溃")

    vetting = ToolVetting(static_hooks=(broken,))
    result = await vetting.vet(_manifest(), (source,))
    assert result.verdict is VettingVerdict.REVIEW
    assert "扫描器崩溃" in result.reason


async def test_shadow_run_records_writes(tmp_path) -> None:
    workdir = tmp_path / "shadow"
    workdir.mkdir()
    (workdir / "keep.txt").write_text("old", encoding="utf-8")
    (workdir / "temp.txt").write_text("temp", encoding="utf-8")

    def executor(args, shadow_workdir):
        # 写操作落在影子副本（写虚拟化：真实目录零触碰）
        (shadow_workdir / "keep.txt").write_text("new content here", encoding="utf-8")
        (shadow_workdir / "created.txt").write_text("hi", encoding="utf-8")
        (shadow_workdir / "temp.txt").unlink(missing_ok=False)
        return "done"

    vetting = ToolVetting()
    result = await vetting.shadow_run(executor, {}, workdir=workdir)
    assert result.ok is True
    operations = {w.operation for w in result.writes}
    assert "modify" in operations and "write" in operations and "delete" in operations
    assert result.untrusted is True  # 观察数据恒标记 untrusted
    # 写虚拟化：真实工作区保持原样（观察不产生副作用）
    assert (workdir / "keep.txt").read_text(encoding="utf-8") == "old"
    assert (workdir / "temp.txt").read_text(encoding="utf-8") == "temp"
    assert not (workdir / "created.txt").exists()


async def test_shadow_run_async_executor(tmp_path) -> None:
    workdir = tmp_path / "shadow"
    workdir.mkdir()

    async def executor(args, shadow_workdir):
        (shadow_workdir / "a.txt").write_text("x", encoding="utf-8")
        return "ok"

    result = await ToolVetting().shadow_run(executor, {}, workdir=workdir)
    assert result.ok is True
    assert any(w.path == "a.txt" and w.operation == "write" for w in result.writes)
    assert not (workdir / "a.txt").exists()


async def test_shadow_run_missing_workdir(tmp_path) -> None:
    result = await ToolVetting().shadow_run(
        lambda args, shadow: "x", {}, workdir=tmp_path / "nope"
    )
    assert result.ok is False
    assert "不存在" in (result.error or "")


def test_code_files_exist_helper(tmp_path) -> None:
    source = tmp_path / "ok.py"
    source.write_text("x = 1", encoding="utf-8")
    missing = tmp_path / "missing.py"
    result = code_files_exist((source, missing))
    assert len(result) == 1
    assert "missing.py" in result[0]


async def test_code_files_exist_attached_by_default(tmp_path):
    """ENG6-7 回归：code_files_exist 默认附加——静态审查默认非空操作。"""
    source = tmp_path / "t.py"
    source.write_text("x = 1\n", encoding="utf-8")
    vetting = ToolVetting()  # 宿主零注入
    clean = await vetting.vet(_manifest(), (source,))
    assert clean.verdict is VettingVerdict.VERIFIED
    missing = await vetting.vet(_manifest(), (tmp_path / "ghost.py",))
    assert missing.verdict is VettingVerdict.REVIEW  # 文件缺失 = 审查命中
    assert any("代码文件缺失" in check.detail for check in missing.checks)
    # 宿主注入钩子时存在性校验仍保留（叠加）
    def fake(paths):
        return []

    vetting2 = ToolVetting(static_hooks=(fake,))
    result = await vetting2.vet(_manifest(), (tmp_path / "ghost.py",))
    assert result.verdict is VettingVerdict.REVIEW

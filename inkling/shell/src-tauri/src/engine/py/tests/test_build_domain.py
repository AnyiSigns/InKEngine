"""构建域组件清单接线单测（ARTIFACT 补丁 → components/manifest.json）。

覆盖：
- component_entry_from_payload：外部 URL 组件 / 本地产物回落 / 无组件声明；
- l2_vetting_hook：外部 URL 组件放行 + 非法形态拒绝（http 白名单/缺 name），
  本地构建产物仍走既有门禁（登记/哈希/冒烟）回归；
- sync_component_manifest：链产物声明 → 写盘清单；回退（空产物）重建为空。

pytest 兼容；无 pytest 依赖时可用 `py test_build_domain.py` 直跑。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_PY = os.path.normpath(os.path.join(_HERE, ".."))
if _ENGINE_PY not in sys.path:
    sys.path.insert(0, _ENGINE_PY)
_REPO_ROOT = os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "..", "..", "..")
)
_ENGINE_PKG = os.path.normpath(os.path.join(_REPO_ROOT, "ink_engine"))
if _ENGINE_PKG not in sys.path:
    sys.path.insert(0, _ENGINE_PKG)


def _build_data() -> dict:
    return {
        "builder": {"allowlist": ["echo"], "default_timeout": 30.0},
        "smoke_probes": {
            "default": {"command": "echo", "args": [], "timeout": 10.0, "expect_exit": 0}
        },
        "deploy": {},
    }


def _domain(tmp_path: Path):
    from inkling_host.build_domain import BuildDomain

    return BuildDomain(_build_data(), artifact_dir=tmp_path / "artifacts")


def _proposal(kind: str, payload: dict):
    from ink_engine.core.self_proposal import PatchKind

    return SimpleNamespace(kind=PatchKind(kind), payload=payload)


def _artifact_payload(component: dict, *, hashes=None, meta_extra=None) -> dict:
    payload: dict = {"artifact_id": "js_bundle-9f26a1", "kind": "js_bundle"}
    if hashes is not None:
        payload["hashes"] = hashes
    meta = dict(meta_extra or {})
    meta["component"] = component
    payload["meta"] = meta
    return payload


def test_external_url_component_entry():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        entry = domain.component_entry_from_payload(
            _artifact_payload(
                {
                    "name": "focus_dashboard",
                    "url": "https://cdn.test/focus_dashboard.js",
                    "version": "0.1.0",
                    "renderer_key": "widget.focus",
                },
                hashes={"index.js": "abc123"},
            )
        )
        assert entry is not None
        assert entry["name"] == "focus_dashboard"
        assert entry["url"] == "https://cdn.test/focus_dashboard.js"
        assert entry["version"] == "0.1.0"
        assert entry["renderer_key"] == "widget.focus"
        assert entry["hash"] == "abc123"


def test_local_artifact_entry_falls_back_to_artifact_path():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        entry = domain.component_entry_from_payload(
            _artifact_payload(
                {"name": "page_clipper"},
                hashes={"index.js": "def456"},
            )
        )
        assert entry is not None
        assert entry["url"] == "artifacts/js_bundle-9f26a1/index.js"
        assert entry["hash"] == "def456"


def test_no_component_declaration_returns_none():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        assert domain.component_entry_from_payload({"artifact_id": "x", "kind": "tool_bin"}) is None


def test_l2_vetting_external_url_component():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        hook = domain.l2_vetting_hook()
        # http(s) + name = 放行（dsh 形态直引）
        assert hook(
            _proposal(
                "artifact",
                _artifact_payload(
                    {"name": "focus_dashboard", "url": "https://cdn.test/a.js"}
                ),
            )
        ) == []
        # 非 http(s) 拒绝
        violations = hook(
            _proposal(
                "artifact",
                _artifact_payload({"name": "x", "url": "file:///etc/passwd"}),
            )
        )
        assert any("http(s)" in v for v in violations)
        # 缺 name 拒绝
        violations = hook(
            _proposal(
                "artifact",
                _artifact_payload({"url": "https://cdn.test/b.js"}),
            )
        )
        assert any("name" in v for v in violations)


def test_l2_vetting_local_artifact_still_needs_build_registry():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        hook = domain.l2_vetting_hook()
        # 无 url 的外部形态回落本地构建门禁：产物未登记 = 拒绝（回归）
        payload = _artifact_payload({"name": "local_comp"}, hashes={"a.js": "abc"})
        violations = hook(_proposal("artifact", payload))
        assert any("构建登记" in v for v in violations)


def test_sync_component_manifest_writes_and_clears():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        manifest = domain.component_manifest_path()
        domain.sync_component_manifest(
            {
                "js_bundle-9f26a1": _artifact_payload(
                    {"name": "focus_dashboard", "url": "https://cdn.test/a.js", "version": "1"}
                ),
                "bin-1": {"artifact_id": "bin-1", "kind": "tool_bin"},
            }
        )
        assert manifest.is_file()
        data = json.loads(manifest.read_text(encoding="utf-8"))
        assert len(data["artifacts"]) == 1
        assert data["artifacts"][0]["name"] == "focus_dashboard"
        # 回退（空链产物）→ 清单清空
        domain.sync_component_manifest({})
        assert json.loads(manifest.read_text(encoding="utf-8"))["artifacts"] == []


def test_restore_component_manifest_rebuilds_from_chain():
    from inkling_host.live_apply import restore_component_manifest

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        domain = _domain(Path(d))
        runtime = SimpleNamespace(builds=domain)
        assembled = {
            "artifacts": {
                "js_bundle-9f26a1": _artifact_payload(
                    {"name": "page_clipper", "url": "https://cdn.test/b.js"}
                )
            }
        }
        restore_component_manifest(runtime, assembled)
        data = json.loads(domain.component_manifest_path().read_text(encoding="utf-8"))
        assert [e["name"] for e in data["artifacts"]] == ["page_clipper"]
        # 无构建域 = 跳过（不抛）
        restore_component_manifest(SimpleNamespace(builds=None), assembled)


if __name__ == "__main__":
    test_external_url_component_entry()
    test_local_artifact_entry_falls_back_to_artifact_path()
    test_no_component_declaration_returns_none()
    test_l2_vetting_external_url_component()
    test_l2_vetting_local_artifact_still_needs_build_registry()
    test_sync_component_manifest_writes_and_clears()
    test_restore_component_manifest_rebuilds_from_chain()
    print("build_domain component manifest assertions passed")

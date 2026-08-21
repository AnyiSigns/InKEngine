"""构建管线单测：声明序列化 + 本机构建 + 哈希 + 冒烟门禁。

覆盖：BuildSpec 序列化往返与非法拒绝、白名单外命令拒绝、产物
缺失/构建失败、产物内容寻址哈希、文件级哈希校验、冒烟门禁
（通过/失败/白名单外探针）。
"""
from __future__ import annotations

import os
import sys

import pytest

from ink_engine.core.builder import (
    BuildArtifact,
    Builder,
    BuildError,
    BuildKind,
    BuildSpec,
    SmokeProbe,
)
from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.sandbox import ProcessSandbox


@pytest.fixture
def builder(tmp_path) -> Builder:
    return Builder(
        ProcessSandbox(
            allowlist=("python",),
            timeout=30.0,
            path=os.environ.get("PATH") or sys.executable,
        ),
        artifact_dir=tmp_path / "artifacts",
    )


def test_spec_roundtrip() -> None:
    spec = BuildSpec(
        kind=BuildKind.JS_BUNDLE,
        command="npm",
        args=("run", "build"),
        workdir="frontend",
        timeout=60.0,
        output_paths=("dist/index.js",),
        meta={"source": "ai_generated"},
    )
    restored = BuildSpec.from_dict(spec.to_dict())
    assert restored == spec
    assert restored.kind is BuildKind.JS_BUNDLE


def test_spec_rejects_invalid() -> None:
    with pytest.raises(GraphDefinitionError, match="类别非法"):
        BuildSpec.from_dict({"command": "npm"})
    with pytest.raises(GraphDefinitionError, match="command"):
        BuildSpec(kind=BuildKind.SERVICE, command="")
    with pytest.raises(GraphDefinitionError, match="超时"):
        BuildSpec(kind=BuildKind.SERVICE, command="x", timeout=-1)


async def test_build_command_outside_allowlist(builder) -> None:
    spec = BuildSpec(
        kind=BuildKind.SERVICE,
        command="evil_installer",
        workdir=".",
        output_paths=("x.py",),
    )
    with pytest.raises(BuildError, match="不在白名单"):
        await builder.build(spec)


async def test_build_missing_output(builder, tmp_path) -> None:
    workdir = tmp_path / "build_dir"
    workdir.mkdir()
    spec = BuildSpec(
        kind=BuildKind.SERVICE,
        command="python",
        args=("-c", "print('built')"),
        workdir=str(workdir),
        output_paths=("dist.js",),  # 未产出 → 构建失败（无半成品记录）
    )
    with pytest.raises(BuildError, match="产物缺失"):
        await builder.build(spec)


async def test_build_failure_keeps_status(builder, tmp_path) -> None:
    workdir = tmp_path / "build_dir"
    workdir.mkdir()
    spec = BuildSpec(
        kind=BuildKind.SERVICE,
        command="python",
        args=("-c", "raise SystemExit(7)"),
        workdir=str(workdir),
        output_paths=("x.txt",),
    )
    with pytest.raises(BuildError, match="构建失败"):
        await builder.build(spec)


async def test_build_success_and_hash(builder, tmp_path) -> None:
    workdir = tmp_path / "build_dir"
    workdir.mkdir()
    (workdir / "app.py").write_text("print('hello')\n", encoding="utf-8")
    spec = BuildSpec(
        kind=BuildKind.PYTHON_PACKAGE,
        command="python",
        args=("-c", "import pathlib; pathlib.Path('out.txt').write_text('ok')"),
        workdir=str(workdir),
        output_paths=("app.py", "out.txt"),
    )
    artifact = await builder.build(spec)
    assert artifact.kind == BuildKind.PYTHON_PACKAGE.value
    assert artifact.artifact_id.startswith("python_package-")
    # 文件级哈希可校验（内容寻址）
    app_hash = artifact.files["app.py"]
    assert len(app_hash) == 64
    assert builder.verify_hash(artifact, "app.py", app_hash)
    assert not builder.verify_hash(artifact, "app.py", "0" * 64)
    # 产物目录存在
    assert builder.artifact_dir(artifact).is_dir()


async def test_build_idempotent_same_content(builder, tmp_path) -> None:
    workdir = tmp_path / "build_dir"
    workdir.mkdir()
    (workdir / "a.txt").write_text("same", encoding="utf-8")
    spec = BuildSpec(
        kind=BuildKind.SERVICE,
        command="python",
        args=("-c", "import pathlib; pathlib.Path('a.txt').write_text('same')"),
        workdir=str(workdir),
        output_paths=("a.txt",),
    )
    first = await builder.build(spec)
    second = await builder.build(spec)
    assert first.artifact_id == second.artifact_id  # 内容寻址：同内容同产物


async def test_smoke_gate(builder, tmp_path) -> None:
    workdir = tmp_path / "build_dir"
    workdir.mkdir()
    (workdir / "run.py").write_text("print('up')\n", encoding="utf-8")
    spec = BuildSpec(
        kind=BuildKind.SERVICE,
        command="python",
        args=("-c", "import pathlib; pathlib.Path('run.py').write_text('print(1)')"),
        workdir=str(workdir),
        output_paths=("run.py",),
    )
    artifact = await builder.build(spec)
    ok = await builder.smoke(
        artifact, SmokeProbe(command="python", args=("run.py",), timeout=10.0)
    )
    assert ok.ok
    failed = await builder.smoke(
        artifact,
        SmokeProbe(command="python", args=("-c", "raise SystemExit(3)"), expect_exit=0),
    )
    assert not failed.ok
    blocked = await builder.smoke(artifact, SmokeProbe(command="malicious_probe"))
    assert not blocked.ok


def test_artifact_roundtrip() -> None:
    artifact = BuildArtifact(
        artifact_id="svc-a1",
        kind="service",
        files={"run.py": "a" * 64},
        built_at=1.5,
        meta={"spec": {"command": "python"}},
    )
    restored = BuildArtifact.from_dict(artifact.to_dict())
    assert restored == artifact
    with pytest.raises(GraphDefinitionError, match="artifact_id"):
        BuildArtifact.from_dict({"kind": "x"})

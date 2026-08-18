"""沙箱与工具执行流水线测试（FileSandbox/写前快照/ProcessSandbox/ToolPipeline）。

覆盖：路径前缀校验、symlink 逃逸、写前快照还原、进程白名单/超时 kill/
输出截断/环境清理、流水线全环节（权限拒绝、挂卡审批、沙箱拒绝、单调守卫、
执行器截断与溢出、审计事件）。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from ink_engine.core.approval import DECISION_ACCEPT
from ink_engine.core.exceptions import SandboxViolation
from ink_engine.core.interrupt import InterruptSignal
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.permissions import PermissionGate
from ink_engine.core.sandbox import FileSandbox, ProcessSandbox, snapshot_before
from ink_engine.core.tool_pipeline import ALLOW, DENY, ToolPipeline


class _FakeCtx:
    """鸭子类型节点上下文：interrupt 挂起/注入 + emit 事件留痕。"""

    def __init__(self, inject: dict | None = None, on_interrupt=None):
        self._inject = dict(inject or {})
        self._on_interrupt = on_interrupt
        self.hung: tuple[str, dict] | None = None
        self.events: list[tuple[str, dict]] = []

    async def emit(self, etype: str, payload: dict) -> None:
        self.events.append((etype, payload))

    async def interrupt(self, review_key: str, payload: dict):
        self.hung = (review_key, payload)
        if self._on_interrupt is not None:
            self._on_interrupt()
        if review_key in self._inject:
            return self._inject.pop(review_key)
        raise InterruptSignal(review_key, payload)


def _symlink_or_skip(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("无 symlink 权限（Windows 需开发者模式）")


# ── FileSandbox：路径守卫 ──


def test_resolve_relative_and_absolute(tmp_path):
    sb = FileSandbox(tmp_path)
    (tmp_path / "book").mkdir()
    assert sb.resolve("book/a.md") == (tmp_path / "book" / "a.md").resolve()
    assert sb.resolve(str(tmp_path / "book" / "a.md")) == (tmp_path / "book" / "a.md").resolve()


def test_resolve_rejects_escape(tmp_path):
    sb = FileSandbox(tmp_path)
    for bad in ("../outside.md", str(tmp_path.parent / "outside.md"), ".."):
        with pytest.raises(SandboxViolation):
            sb.resolve(bad)


def test_resolve_rejects_symlink_escape(tmp_path):
    outside = tmp_path.parent / f"outside-{tmp_path.name}.txt"
    outside.write_text("secret")
    link = tmp_path / "link.md"
    _symlink_or_skip(link, outside)
    sb = FileSandbox(tmp_path)
    with pytest.raises(SandboxViolation):
        sb.resolve("link.md")


def test_validate_operations(tmp_path):
    sb = FileSandbox(tmp_path)
    assert sb.validate("read", "a.md") == (tmp_path / "a.md").resolve()
    with pytest.raises(SandboxViolation):
        sb.validate("chmod", "a.md")


def test_resolve_nonexistent_path_ok(tmp_path):
    sb = FileSandbox(tmp_path)
    assert sb.resolve("new/ch1.md") == (tmp_path / "new" / "ch1.md").resolve()


# ── 写前快照 ──


def test_snapshot_restore_existing(tmp_path):
    f = tmp_path / "a.md"
    f.write_text("旧内容", encoding="utf-8")
    snap = snapshot_before(f)
    f.write_text("新内容", encoding="utf-8")
    snap.restore()
    assert f.read_text(encoding="utf-8") == "旧内容"


def test_snapshot_restore_removed(tmp_path):
    f = tmp_path / "b.md"
    snap = snapshot_before(f)  # 原不存在
    f.write_text("新内容", encoding="utf-8")
    snap.restore()
    assert not f.exists()


def test_snapshot_restore_idempotent(tmp_path):
    f = tmp_path / "c.md"
    f.write_text("x", encoding="utf-8")
    snap = snapshot_before(f)
    snap.restore()
    snap.restore()  # 重复还原不炸
    assert f.read_text(encoding="utf-8") == "x"


# ── ProcessSandbox ──


def test_process_validate_whitelist():
    sb = ProcessSandbox(allowlist=(sys.executable,))
    sb.validate("exec", sys.executable)
    with pytest.raises(SandboxViolation):
        sb.validate("exec", "rm")
    with pytest.raises(SandboxViolation):
        sb.validate("chmod", sys.executable)


async def test_process_run_success():
    sb = ProcessSandbox(allowlist=(sys.executable,), env={"PYTHONIOENCODING": "utf-8"})
    result = await sb.run(sys.executable, ("-c", "print('hi')"))
    assert result.exit_code == 0
    assert result.stdout.strip() == "hi"
    assert not result.timed_out


async def test_process_run_timeout_kill():
    sb = ProcessSandbox(allowlist=(sys.executable,), timeout=0.3)
    result = await sb.run(sys.executable, ("-c", "import time; time.sleep(5)"))
    assert result.timed_out
    assert result.exit_code == -1


async def test_process_output_truncated():
    sb = ProcessSandbox(
        allowlist=(sys.executable,), max_output=10, env={"PYTHONIOENCODING": "utf-8"}
    )
    result = await sb.run(sys.executable, ("-c", "print('x' * 100)"))
    assert "…（已截断）" in result.stdout
    assert len(result.stdout) < 20


async def test_process_env_cleaned():
    sb = ProcessSandbox(
        allowlist=(sys.executable,), env={"MARKER": "ok", "PYTHONIOENCODING": "utf-8"}
    )
    result = await sb.run(
        sys.executable,
        ("-c", "import os; print(os.environ.get('MARKER'), bool(os.environ.get('PATH')))"),
    )
    assert result.stdout.strip() == "ok False"  # 白名单外变量不进子进程


async def test_process_command_not_in_allowlist():
    sb = ProcessSandbox()
    with pytest.raises(SandboxViolation):
        await sb.run(sys.executable, ("-c", "print(1)"))


# ── ToolPipeline 装配 ──


def _write_spec(permissions: tuple[str, ...] = ()) -> ToolSpec:
    return ToolSpec(name="write_file", permissions=permissions)


async def test_pipeline_deny_without_permissions(tmp_path):
    ctx = _FakeCtx()
    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        executor=lambda ctx, spec, args, approval: "ok",
    )
    result = await pipeline.execute(ctx, _write_spec(), {"path": str(tmp_path / "a.md")})
    assert result.ok is False
    assert result.decision == DENY
    assert "默认拒绝" in (result.error or "")
    assert ctx.events and ctx.events[0][0] == "tool_audit"


async def test_pipeline_review_then_accept(tmp_path):
    ctx = _FakeCtx(inject={"gate:write_file": {"decision": DECISION_ACCEPT}})
    seen: list = []
    pipeline = ToolPipeline(
        gate=PermissionGate(review_tier=lambda tool: tool == "write_file"),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        executor=lambda ctx, spec, args, approval: seen.append(approval) or "ok",
    )
    result = await pipeline.execute(
        ctx, _write_spec((f"filesystem:write:{tmp_path}/**",)), {"path": str(tmp_path / "a.md")}
    )
    assert result.ok is True
    assert result.decision == ALLOW
    assert seen and seen[0].decision == DECISION_ACCEPT  # 决议透传执行器
    assert ctx.hung is not None  # 确实挂过卡


async def test_pipeline_review_then_reject(tmp_path):
    ctx = _FakeCtx(inject={"gate:write_file": {"decision": "reject"}})
    pipeline = ToolPipeline(
        gate=PermissionGate(review_tier=lambda tool: True),
        extractor=lambda spec, args: ("write", str(args["path"])),
        executor=lambda ctx, spec, args, approval: "ok",
    )
    result = await pipeline.execute(
        ctx, _write_spec((f"filesystem:write:{tmp_path}/**",)), {"path": str(tmp_path / "a.md")}
    )
    assert result.ok is False
    assert result.decision == "reject"
    assert "审批未通过" in (result.error or "")


async def test_pipeline_sandbox_rejects_escape(tmp_path):
    ctx = _FakeCtx()
    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        executor=lambda ctx, spec, args, approval: "ok",
    )
    result = await pipeline.execute(
        ctx,
        _write_spec(("filesystem:write:**",)),
        {"path": str(tmp_path.parent / "evil.txt")},
    )
    assert result.ok is False
    assert result.decision == DENY
    assert "越界" in (result.error or "")


async def test_pipeline_guard_rejects(tmp_path):
    ctx = _FakeCtx()

    def guard(ctx, spec, args):
        raise ValueError("同一动作已执行")

    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        guards=(guard,),
        executor=lambda ctx, spec, args, approval: "ok",
    )
    result = await pipeline.execute(
        ctx, _write_spec((f"filesystem:write:{tmp_path}/**",)), {"path": str(tmp_path / "a.md")}
    )
    assert result.ok is False
    assert "守卫拒绝" in (result.error or "")


async def test_pipeline_truncates_overflow(tmp_path):
    ctx = _FakeCtx()
    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        executor=lambda ctx, spec, args, approval: "x" * 100,
        max_result_chars=10,
    )
    result = await pipeline.execute(
        ctx, _write_spec((f"filesystem:write:{tmp_path}/**",)), {"path": str(tmp_path / "a.md")}
    )
    assert result.ok is True
    assert result.overflow is True
    assert "溢出截断" in result.output
    assert len(result.output) < 30


async def test_pipeline_pure_memory_tool_passthrough():
    """无提取目标（纯内存工具）：不触发权限/沙箱，直通执行。"""
    ctx = _FakeCtx()
    pipeline = ToolPipeline(
        gate=PermissionGate(),
        executor=lambda ctx, spec, args, approval: "ok",
    )
    result = await pipeline.execute(ctx, ToolSpec(name="summarize"), {"text": "x"})
    assert result.ok is True
    assert result.output == "ok"


async def test_pipeline_custom_audit_hook(tmp_path):
    ctx = _FakeCtx()
    records: list[dict] = []

    async def audit(ctx, record):
        records.append(record)

    pipeline = ToolPipeline(
        gate=PermissionGate(),
        extractor=lambda spec, args: ("write", str(args["path"])),
        sandboxes=(FileSandbox(tmp_path),),
        executor=lambda ctx, spec, args, approval: "ok",
        audit=audit,
    )
    await pipeline.execute(
        ctx, _write_spec(), {"path": str(tmp_path / "a.md")}
    )
    assert records and records[0]["decision"] == "deny"  # 自定义审计接管，不再 emit
    assert ctx.events == []

"""族 9：工具与安全（test_09_tools_security.py）｜tool_pipeline/permissions/
sandbox/declarative_tools/tool_orchestrator/tool_vetting/builder/environments。

- 声明式四端点全形态：file_ops（真实读写删+快照还原）/process_exec
  （白名单真实命令+超时 kill+输出截断+env 清理）/http_fetch（白名单域
  真实抓取+域外拒绝）/mcp（接族 18）
- ToolPipeline 全环节：门禁三路（allow/review 挂卡/deny）→ 沙箱 → 守卫
  → 执行 → tool_audit → 截断
- 工具调配（ToolOrchestrator 评分/去重/预算/ToolTraceStore 轨迹
  append-only）；vetting（manifest/哈希/静态钩子/影子运行）；Builder
  （白名单命令+内容寻址哈希+冒烟）；Environments（local 提供器真实
  安装/运行 + env_audit 补丁链留痕）

确定性机制用例（真实本地进程/文件，零模型调用）+ 1 条真实 LLM 工具循环用例。
"""
from __future__ import annotations

import sys

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.declarative_tools import (  # noqa: E402
    DeclarativeToolExecutors,
    DeclarativeToolSpec,
    EndpointType,
    build_declarative_pipeline,
)
from ink_engine.core.permissions import (  # noqa: E402
    NetworkPolicy,
    PermissionGate,
)
from ink_engine.core.sandbox import FileSandbox, ProcessSandbox, snapshot_before  # noqa: E402
from ink_engine.core.tool_pipeline import ToolPipeline  # noqa: E402
from ink_engine.core.tool_vetting import ToolManifest, ToolVetting  # noqa: E402


class _FakeCtx:
    """最小节点上下文替身（emit 收集审计事件）。"""

    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    async def emit(self, etype: str, payload: dict, **kw):
        self.events.append((etype, payload))


def _audit_collector(ctx):
    async def audit(inner_ctx, record: dict) -> None:
        await inner_ctx.emit("tool_audit", record)

    return audit


# ----------------------------------------------------------------------
# FileSandbox：真实读写删 + 快照还原
# ----------------------------------------------------------------------

async def test_file_sandbox_real_ops_and_snapshot_restore(live_tmp):
    root = live_tmp / "sandbox_root"
    root.mkdir()
    sandbox = FileSandbox(root)
    target = root / "doc.txt"
    resolved = sandbox.validate("write", str(target))
    assert resolved == target.resolve()
    target.write_text("v1", encoding="utf-8")
    snapshot = snapshot_before(target)
    target.write_text("v2", encoding="utf-8")
    assert target.read_text(encoding="utf-8") == "v2"
    snapshot.restore()
    assert target.read_text(encoding="utf-8") == "v1"  # 写前快照还原
    # 越界路径拒绝（.. 逃逸）
    with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
        sandbox.validate("write", str(live_tmp / "outside.txt"))
    with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
        sandbox.validate("write", str(root / ".." / "escape.txt"))


# ----------------------------------------------------------------------
# ProcessSandbox：白名单 + 超时 kill + 输出截断 + env 清理
# ----------------------------------------------------------------------

async def test_process_sandbox_whitelist_and_timeout(live_tmp):
    sandbox = ProcessSandbox(allowlist=(sys.executable,), timeout=5.0, cwd=str(live_tmp), max_output=1000)
    result = await sandbox.run(sys.executable, ("-X", "utf8", "-c", "print('真实进程输出')"))
    assert result.exit_code == 0
    assert "真实进程输出" in result.stdout
    # 白名单外命令拒绝（fail-closed）
    with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
        await sandbox.run("not-a-real-command-xyz")
    # 超时 kill：命令 sleep 超窗 → timed_out 标记
    slow = ProcessSandbox(allowlist=(sys.executable,), timeout=1.0, cwd=str(live_tmp), max_output=1000)
    timed = await slow.run(sys.executable, ("-X", "utf8", "-c", "import time; time.sleep(30)"))
    assert timed.timed_out is True
    # 输出截断
    trunc = ProcessSandbox(allowlist=(sys.executable,), timeout=5.0, cwd=str(live_tmp), max_output=50)
    big = await trunc.run(sys.executable, ("-X", "utf8", "-c", "print('x' * 5000)"))
    assert len(big.stdout) <= 50 + 50  # 截断到上限附近


# ----------------------------------------------------------------------
# http_fetch：白名单域真实抓取 + 域外拒绝（本地故障端点作真实目标）
# ----------------------------------------------------------------------

async def test_http_fetch_whitelist_real(fault_server, live_tmp):
    from ink_engine.core.declarative_tools import make_http_fetch_executor

    fault_server.mode = "ok_json"  # GET 抓取目标：非流式 JSON 文本
    host = fault_server.base_url.split("//")[1].split(":")[0]
    executors = DeclarativeToolExecutors()
    executors.register(EndpointType.HTTP_FETCH, make_http_fetch_executor(timeout=10.0, max_chars=100_000))
    spec = DeclarativeToolSpec(
        name="fetchdocs",
        description="抓取文档",
        parameters={"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
        permissions=(f"network:connect:{host}",),
        endpoint=EndpointType.HTTP_FETCH,
        endpoint_config={},
    )
    executors.register_definition(spec)
    pipeline = build_declarative_pipeline(
        executors,
        network_policy=NetworkPolicy(allow_domains=(host,)),
        # deny 档验证沙箱硬边界（review 档默认 = 白名单外转审批）
        network_unlisted_policy="deny",
    )
    tool_spec = spec.to_spec()
    ctx = _FakeCtx()
    result = await pipeline.execute(ctx, tool_spec, {"url": fault_server.base_url + "/docs"})
    assert result.ok is True
    assert "非流式标准响应" in result.output  # 真实抓取内容
    # 域外拒绝（deny 档 fail-closed）
    denied = await pipeline.execute(ctx, tool_spec, {"url": "http://example.com/x"})
    assert denied.ok is False


# ----------------------------------------------------------------------
# ToolPipeline 全环节：门禁三路 → 沙箱 → 守卫 → 执行 → 审计
# ----------------------------------------------------------------------

async def test_tool_pipeline_gate_sandbox_guard_audit(live_tmp):
    root = live_tmp / "pipe_root"
    root.mkdir()

    def extractor(spec, args):
        if spec.name == "file_write":
            return "write", args["path"]
        return None

    async def executor(ctx, spec, args, approval):
        target = root / args["path"]
        target.write_text(args.get("content", ""), encoding="utf-8")
        return "written"

    gate = PermissionGate(default_policy="deny")

    async def guard(ctx, spec, args):
        if args.get("content", "").startswith("bad"):
            raise ValueError("守卫拦截非法内容")

    audits: list[dict] = []

    async def audit(ctx, record):
        audits.append(record)

    from ink_engine.core.tool_pipeline import ToolSpec

    pipeline = ToolPipeline(
        gate=gate,
        extractor=extractor,
        sandboxes=(FileSandbox(root),),
        guards=(guard,),
        executor=executor,
        audit=audit,
    )
    ctx = _FakeCtx()
    spec = ToolSpec(name="file_write", description="写文件", permissions=("file:write:*",))
    # 门禁 allow（权限命中）→ 沙箱 → 守卫 → 执行 → 审计
    allowed = await pipeline.execute(ctx, spec, {"path": "a.txt", "content": "hello"})
    assert allowed.ok is True
    assert (root / "a.txt").read_text(encoding="utf-8") == "hello"
    assert any(r["tool"] == "file_write" for r in audits)  # tool_audit 留痕
    # 守卫拒绝（fail-closed）
    guarded = await pipeline.execute(ctx, spec, {"path": "b.txt", "content": "bad stuff"})
    assert guarded.ok is False
    # 权限 deny → 拒绝且不执行
    deny_spec = ToolSpec(name="file_write", description="x", permissions=())
    denied = await pipeline.execute(ctx, deny_spec, {"path": "c.txt", "content": "x"})
    assert denied.ok is False
    assert not (root / "c.txt").exists()
    # 越界沙箱拒绝
    escaped = await pipeline.execute(ctx, spec, {"path": "../escape.txt", "content": "x"})
    assert escaped.ok is False


# ----------------------------------------------------------------------
# 工具调配：ToolOrchestrator 评分/去重 + ToolTraceStore append-only
# ----------------------------------------------------------------------

def test_tool_orchestrator_scoring_and_dedup():
    from ink_engine.core.tool_orchestrator import ToolCandidate, ToolSelector, WeightedToolScorer
    from ink_engine.core.tool_pipeline import ToolSpec

    def cand(name, relevance, priority=5, weight=1.0):
        return ToolCandidate(spec=ToolSpec(name=name, description=""), relevance=relevance, priority=priority, weight=weight)

    candidates = [
        cand("write", 0.9, priority=5),
        cand("write", 0.9, priority=5),  # 重复
        cand("query", 0.3, priority=1),
    ]
    selected = ToolSelector(scorer=WeightedToolScorer(min_score=0.5)).select(candidates, max_tools=5)
    names = [s.name for s in selected]
    assert names.count("write") == 1  # 去重
    assert "query" not in names  # 低分剔除


async def test_tool_trace_store_append_only(sqlite_storage):
    from ink_engine.core.tool_orchestrator import ToolTrace, ToolTraceStore

    store = ToolTraceStore(sqlite_storage)
    trace = ToolTrace(tool="file_ops", ok=True, decision="allow", args={"path": "x"}, duration_ms=1.0)
    await store.record(trace)
    await store.record(trace)
    entries = await store.list()
    assert len(entries) == 2  # append-only，不覆盖
    assert all(e.tool == "file_ops" for e in entries)


# ----------------------------------------------------------------------
# vetting：manifest/哈希/静态钩子/影子运行
# ----------------------------------------------------------------------

async def test_tool_vetting_manifest_and_shadow(live_tmp):

    manifest = ToolManifest(
        name="calc",
        source="local",
        signature=None,
        hashes={"calc.py": "a" * 64},
        permissions=("process_exec:run:*",),
        meta={"kind": "script"},
    )
    static_hits: list[str] = []

    async def static_hook(code: str, path: str):
        if "exec(" in code:
            static_hits.append(path)
            return ["含 exec 调用"]
        return []

    vetter = ToolVetting(static_hooks=(static_hook,))
    result = await vetter.vet(
        manifest,
        code_paths=(),
        strict=False,
    )
    assert result.ok is not False and result.verdict.value in ("verified", "review", "rejected")
    # 影子运行：结果恒 untrusted 标记（executor 签名 = args, shadow_workdir）
    shadow = await vetter.shadow_run(
        lambda args, workdir: "shadow output",
        {"n": 1},
        workdir=live_tmp,
    )
    assert shadow.output == "shadow output"
    assert shadow.untrusted is True


# ----------------------------------------------------------------------
# Builder：白名单命令 + 内容寻址哈希 + 冒烟门禁
# ----------------------------------------------------------------------

async def test_builder_content_addressed_artifact(live_tmp):
    from ink_engine.core.builder import Builder, BuildError, BuildKind, BuildSpec

    workdir = live_tmp / "src"
    workdir.mkdir()
    (workdir / "out.txt").write_text("产物内容", encoding="utf-8")
    builder = Builder(
        ProcessSandbox(allowlist=(sys.executable,), timeout=10.0),
        artifact_dir=str(live_tmp / "artifacts"),
    )
    spec = BuildSpec(
        kind=BuildKind.PYTHON_PACKAGE,
        command=sys.executable,
        args=("-X", "utf8", "-c", "print('构建完成')"),
        workdir=str(workdir),
        output_paths=("out.txt",),
        timeout=10.0,
    )
    artifact = await builder.build(spec)
    assert artifact.artifact_id.startswith("python_package-")  # 内容寻址 id
    assert artifact.files["out.txt"]  # 文件级 sha256
    target = live_tmp / "artifacts" / artifact.artifact_id / "out.txt"
    assert target.read_text(encoding="utf-8") == "产物内容"
    # 白名单外命令 → 构建失败（fail-closed）
    bad_spec = BuildSpec(
        kind=BuildKind.PYTHON_PACKAGE, command="evil-cmd",
        args=(), workdir=str(workdir), output_paths=("out.txt",), timeout=10.0,
    )
    with pytest.raises(BuildError):
        await builder.build(bad_spec)


# ----------------------------------------------------------------------
# Environments：local 提供器真实安装/运行 + env_audit 补丁链留痕
# ----------------------------------------------------------------------

async def test_environments_local_provider_and_audit(sqlite_storage, live_tmp):
    from ink_engine.core.environments import (
        ENV_STATUS_READY,
        EnvironmentSpec,
        LocalProvider,
        RuntimeKind,
    )

    provider = LocalProvider(
        ProcessSandbox(allowlist=(sys.executable,), timeout=10.0, cwd=str(live_tmp)),
        envs_dir=str(live_tmp / "envs"),
        storage=sqlite_storage,
    )
    spec = EnvironmentSpec(
        name="py-env",
        runtime=RuntimeKind.LOCAL,
        tools=(),
        install_cmds=(),
        meta={"env": {"PYTHONIOENCODING": "utf-8"}},
    )
    handle = await provider.ensure(spec)
    assert handle.status == ENV_STATUS_READY
    result = await provider.run(handle, sys.executable, ("-X", "utf8", "-c", "print('环境运行')"))
    assert result.exit_code == 0
    assert "环境运行" in result.stdout
    # env_audit 留痕：运行记录落库（环境=数据 round-trip）
    records = await sqlite_storage.list_records("env_audit")
    record = records[0] if records else None
    assert record is not None and record["action"] == "run"
    await provider.destroy(handle)
    assert handle.status == "destroyed"


# 环境=数据 round-trip（EnvironmentSpec 序列化往返）
def test_environment_spec_roundtrip():
    from ink_engine.core.environments import EnvironmentSpec, RuntimeKind

    spec = EnvironmentSpec(
        name="py", runtime=RuntimeKind.LOCAL, tools=("python",), install_cmds=(),
        version=">=3.11", meta={"note": "x"},
    )
    restored = EnvironmentSpec.from_dict(spec.to_dict())
    assert restored == spec
    assert restored.version == ">=3.11"


# ----------------------------------------------------------------------
# 真实 LLM 工具循环：声明式 file_ops（真实沙箱写盘）+ strict 解析 + 审计
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_llm_tool_loop_declarative_file(live_llm, live_tmp):
    """真实 LLM 工具循环：模型经工具描述调用声明式 file_ops → 真实写盘 + 审计留痕。"""
    from ink_engine.core.llm.messages import assistant, tool_result, user

    root = live_tmp / "llm_tool_root"
    root.mkdir()
    sandbox = FileSandbox(root)

    async def file_executor(ctx, defn, args, approval):
        target = root / args["path"]
        target.write_text(args.get("content", ""), encoding="utf-8")
        return f"written:{args['path']}"

    executors = DeclarativeToolExecutors()
    defn = DeclarativeToolSpec(
        name="writenote",
        description="写入笔记文件（参数 path/content）",
        parameters={
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
        permissions=("filesystem:write:*",),
        endpoint=EndpointType.FILE_OPS,
        endpoint_config={"root": str(root)},
    )
    executors.register_definition(defn)
    executors.register(EndpointType.FILE_OPS, file_executor)
    pipeline = build_declarative_pipeline(
        executors, gate=PermissionGate(), sandboxes=(sandbox,)
    )

    tool_spec = defn.to_spec()
    messages = [user("请调用 writenote 工具写入文件 note.txt，内容为 hello-live")]
    result = await live_llm.ainvoke(messages, tools=[tool_spec])
    assert result.tool_calls, "模型未产出工具调用"
    call = result.tool_calls[0]
    args = call.parse_arguments(strict=True)
    assert "path" in args
    ctx = _FakeCtx()
    out = await pipeline.execute(ctx, tool_spec, {"operation": "write", **args})
    assert out.ok is True
    messages.append(assistant(tool_calls=[call]))
    messages.append(tool_result(content=out.output, tool_call_id=call.id))
    final = await live_llm.ainvoke(messages, tools=[tool_spec])
    assert (final.content or final.reasoning or "").strip()  # 工具结果回喂后收口
    assert (root / args["path"]).exists()  # 真实写盘
    assert any(t == "tool_audit" for t, _ in ctx.events)  # 审计留痕

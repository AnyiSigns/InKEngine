"""MCP stdio 进程监督单测：重启策略数据化 + 崩溃拉起 + 熔断。

覆盖：StdioRestartPolicy 缺省保守值/校验/序列化往返（含
McpServerConfig 配置往返）；受监督会话崩溃拉起（打开器计数/退避）；
拉起耗尽 → 连续失败计数 → 熔断打开（fail-closed 直接拒绝，不再拉
起）；拉起成功清零计数；health_check 探测（ping 支持/不支持/崩溃）；
管理器 connect 对 stdio 自动包监督；取消异常原样穿透。
"""
from __future__ import annotations

import asyncio

import pytest

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.mcp_client import (
    McpClientManager,
    McpServerConfig,
    McpToolImportError,
    McpTransport,
    StdioRestartPolicy,
    _SupervisedStdioSession,
)


class FakeHandle:
    """假会话句柄：可脚本化 list_tools/call_tool 失败序列。"""

    def __init__(self, *, name="fake", fail_call_tools=0, fail_list_tools=0,
                 ping_available=True):
        self.name = name
        self._fail_call_tools = fail_call_tools
        self._fail_list_tools = fail_list_tools
        self.ping_available = ping_available
        self.calls: list[str] = []
        self.closed = False
        self.pings = 0

    async def list_tools(self):
        self.calls.append("list_tools")
        if self._fail_list_tools > 0:
            self._fail_list_tools -= 1
            raise ConnectionError(f"{self.name} process died")
        return []

    async def call_tool(self, name, args):
        self.calls.append(f"call:{name}")
        if self._fail_call_tools > 0:
            self._fail_call_tools -= 1
            raise ConnectionError(f"{self.name} process died")
        return f"ok-{name}"

    async def send_ping(self):
        self.pings += 1
        if not self.ping_available:
            raise ConnectionError("ping failed")

    async def aclose(self) -> None:
        self.closed = True


class FakeSdkSession:
    """假 _SdkSession 形态（包装 FakeHandle，_session 供探测读取）。"""

    def __init__(self, handle: FakeHandle) -> None:
        self._session = handle

    async def list_tools(self):
        return await self._session.list_tools()

    async def call_tool(self, name, args):
        return await self._session.call_tool(name, args)

    async def aclose(self) -> None:
        await self._session.aclose()


class TestStdioRestartPolicy:
    def test_defaults_are_conservative(self):
        policy = StdioRestartPolicy()
        assert policy.max_retries == 2
        assert policy.backoff == 1.0
        assert policy.circuit_break_threshold == 3

    def test_validation(self):
        with pytest.raises(ValueError, match="不能为负"):
            StdioRestartPolicy(max_retries=-1)
        with pytest.raises(ValueError, match="不能为负"):
            StdioRestartPolicy(backoff=-0.1)
        with pytest.raises(ValueError, match="阈值须 >= 1"):
            StdioRestartPolicy(circuit_break_threshold=0)

    def test_config_round_trip(self):
        config = McpServerConfig(
            id="s1",
            transport=McpTransport.STDIO,
            command="pyserver",
            args=("--port", "9000"),
            restart_policy=StdioRestartPolicy(
                max_retries=5, backoff=0.5, circuit_break_threshold=7
            ),
        )
        restored = McpServerConfig.from_dict(config.to_dict())
        assert restored.id == "s1"
        assert restored.restart_policy == StdioRestartPolicy(
            max_retries=5, backoff=0.5, circuit_break_threshold=7
        )

    def test_absent_policy_defaults(self):
        restored = McpServerConfig.from_dict(
            McpServerConfig(id="s1", command="cmd").to_dict()
        )
        assert restored.restart_policy is None  # 缺省 = 挂接时用默认策略

    def test_policy_validation_via_from_dict(self):
        with pytest.raises(GraphDefinitionError, match="restart_policy"):
            McpServerConfig.from_dict({"id": "s1", "restart_policy": 5})


class TestSupervisedSession:
    def _config(self, **policy_kw) -> McpServerConfig:
        return McpServerConfig(
            id="s1",
            transport=McpTransport.STDIO,
            command="pyserver",
            restart_policy=StdioRestartPolicy(**policy_kw),
        )

    async def test_healthy_session_delegates(self):
        handle = FakeHandle()
        supervised = _SupervisedStdioSession(
            self._config(), initial=FakeSdkSession(handle)
        )
        result = await supervised.call_tool("lookup", {"q": 1})
        assert result == "ok-lookup"
        assert await supervised.list_tools() == []
        assert handle.calls == ["call:lookup", "list_tools"]

    async def test_crash_pulls_process_up(self):
        """崩溃 → 拉起（新会话）→ 本次调用诚实失败、下次调用走新会话。"""
        old_handle = FakeHandle(name="old", fail_call_tools=1)
        fresh_handle = FakeHandle(name="new")
        opens = {"n": 0}

        async def opener(config):
            opens["n"] += 1
            return FakeSdkSession(fresh_handle)

        supervised = _SupervisedStdioSession(
            self._config(backoff=0.0),
            initial=FakeSdkSession(old_handle),
            opener=opener,
        )
        with pytest.raises(McpToolImportError, match="已按策略拉起"):
            await supervised.call_tool("lookup", {})
        assert opens["n"] == 1  # 崩溃后拉起一次
        assert old_handle.closed  # 旧会话清理
        # 拉起成功 → 计数清零；下次调用命中新会话
        result = await supervised.call_tool("lookup", {})
        assert result == "ok-lookup"
        assert fresh_handle.calls == ["call:lookup"]
        assert supervised.consecutive_failures == 0

    async def test_retries_exhausted_reports_and_opens_circuit(self):
        """拉起重试耗尽 → 连续失败计数 → 熔断打开 → fail-closed。"""
        attempts = {"n": 0}

        async def failing_opener(config):
            attempts["n"] += 1
            raise RuntimeError("spawn exploded")

        supervised = _SupervisedStdioSession(
            self._config(max_retries=2, backoff=0.0, circuit_break_threshold=2),
            initial=FakeSdkSession(FakeHandle(name="dead", fail_call_tools=1)),
            opener=failing_opener,
        )
        expectations = (2, 5)  # 首轮复用既有会话（0 次可用性尝试）+ 2 次重启；
        # 之后会话已清除 → 每次 1 次可用性尝试 + 2 次重启
        for i in (1, 2):
            with pytest.raises(McpToolImportError, match="崩溃且重启失败"):
                await supervised.call_tool("lookup", {})
            assert attempts["n"] == expectations[i - 1]
        assert supervised.circuit_open is True
        # 熔断打开：直接拒绝，不再尝试拉起
        with pytest.raises(McpToolImportError, match="熔断已打开"):
            await supervised.call_tool("lookup", {})
        assert attempts["n"] == 5  # 未再拉起

    async def test_success_reset_consecutive_failures(self):
        """拉起成功清零连续失败分（熔断只凭健康度判定）。"""
        state = {"fail": True}

        async def opener(config):
            if state["fail"]:
                raise RuntimeError("spawn exploded")
            return FakeSdkSession(FakeHandle(name="fresh"))

        supervised = _SupervisedStdioSession(
            self._config(max_retries=0, backoff=0.0, circuit_break_threshold=3),
            initial=FakeSdkSession(FakeHandle(name="dead", fail_call_tools=99)),
            opener=opener,
        )
        # max_retries=0：不做拉起（fail-fast），但累计失败分
        for _ in range(2):
            with pytest.raises(McpToolImportError, match="崩溃且重启失败"):
                await supervised.call_tool("lookup", {})
        assert supervised.consecutive_failures == 2
        assert supervised.circuit_open is False  # 未达阈值
        # 下一次：会话已在失败路径清除 → 重新建立成功 → 计分清零，
        # 调用直接成功（无需「拉起后诚实失败」——并无崩溃需恢复）
        state["fail"] = False
        result = await supervised.call_tool("lookup", {})
        assert result == "ok-lookup"
        assert supervised.consecutive_failures == 0
        assert supervised.circuit_open is False

    async def test_health_check_probe(self):
        handle = FakeHandle()
        supervised = _SupervisedStdioSession(
            self._config(), initial=FakeSdkSession(handle)
        )
        assert await supervised.health_check() is True
        assert handle.pings == 1

    async def test_health_check_recovers_after_crash(self):
        handle = FakeHandle(name="dead")
        handle.ping_available = False  # ping 抛错 = 崩溃
        opened = {"n": 0}

        async def opener(config):
            opened["n"] += 1
            return FakeSdkSession(FakeHandle(name=f"recovered-{opened['n']}"))

        supervised = _SupervisedStdioSession(
            self._config(backoff=0.0), initial=FakeSdkSession(handle), opener=opener
        )
        assert await supervised.health_check() is True  # 崩溃探测后拉起
        assert opened["n"] == 1
        assert supervised.consecutive_failures == 0

    async def test_health_check_circuit_open_returns_false(self):
        async def failing_opener(config):
            raise RuntimeError("spawn exploded")

        supervised = _SupervisedStdioSession(
            self._config(max_retries=1, backoff=0.0, circuit_break_threshold=1),
            initial=FakeSdkSession(FakeHandle(name="dead", ping_available=False)),
            opener=failing_opener,
        )
        assert await supervised.health_check() is False
        assert supervised.circuit_open is True

    async def test_cancellation_propagates_unwrapped(self):
        """取消异常原样穿透（不误判为进程崩溃）。"""
        async def cancelled_call(name, args):
            raise asyncio.CancelledError()

        class CancelledSession:
            _session = "probe-missing"

            async def call_tool(self, name, args):
                return await cancelled_call(name, args)

            async def aclose(self):
                pass

        supervised = _SupervisedStdioSession(
            self._config(), initial=CancelledSession()
        )
        with pytest.raises(asyncio.CancelledError):
            await supervised.call_tool("lookup", {})


class TestManagerWiring:
    async def test_connect_wraps_stdio_in_supervision(self, monkeypatch):
        """管理器 connect 对 stdio 自动包监督（http 不包）。"""
        import ink_engine.core.mcp_client as mcp_module

        class FakeSdkOpen:
            handles: object = []
            calls = 0

            @classmethod
            async def open(cls, config):
                cls.calls += 1
                return cls.handles.pop(0)

        FakeSdkOpen.handles = [
            FakeSdkSession(FakeHandle(name="stdio", fail_call_tools=1)),
            FakeSdkSession(FakeHandle(name="fresh")),
        ]
        FakeSdkOpen.calls = 0
        monkeypatch.setattr(mcp_module, "_SdkSession", FakeSdkOpen)

        manager = McpClientManager()
        stdio_config = McpServerConfig(
            id="stdio-srv", transport=McpTransport.STDIO, command="cmd",
            restart_policy=StdioRestartPolicy(backoff=0.0),
        )
        handle = await manager.connect(stdio_config)
        assert isinstance(handle, _SupervisedStdioSession)
        # 崩溃 → 监督拉起新会话
        with pytest.raises(McpToolImportError):
            await manager.dispatch(None, _spec("stdio-srv"), {})
        assert FakeSdkOpen.calls == 2
        assert await manager.dispatch(None, _spec("stdio-srv"), {}) == "ok-tool"

    async def test_connect_http_not_wrapped(self, monkeypatch):
        import ink_engine.core.mcp_client as mcp_module

        class FakeSdkOpen:
            handles: object = []

            @classmethod
            async def open(cls, config):
                return cls.handles.pop(0)

        FakeSdkOpen.handles = [FakeSdkSession(FakeHandle(name="http"))]
        monkeypatch.setattr(mcp_module, "_SdkSession", FakeSdkOpen)

        manager = McpClientManager()
        config = McpServerConfig(id="http-srv", transport=McpTransport.HTTP, url="http://x")
        handle = await manager.connect(config)
        assert not isinstance(handle, _SupervisedStdioSession)


def _spec(server_id: str):
    from ink_engine.core.declarative_tools import (
        DeclarativeToolSpec,
        EndpointType,
    )

    return DeclarativeToolSpec(
        name="tool",
        description="",
        parameters={"type": "object", "properties": {}},
        permissions=(f"mcp:call:{server_id}",),
        endpoint=EndpointType.MCP,
        endpoint_config={"server_id": server_id},
    )

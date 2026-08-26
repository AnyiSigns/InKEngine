"""live 套件共享基础设施（tests/live/，`-m live` 显式启用）。

测试说明文档第四节执行配置 / 第七节报告与门禁的落地：

- **配置来源**：`INKENGINE_LIVE_BASE_URL/API_KEY/MODEL` 环境变量优先，
  回落仓库根 `.kilo/测试模型配置.txt`（url/key/model_name 行形态）；
  显式 `-m live` 而配置缺失 = fail（门禁不允许空跑，与既有
  test_llm_live.py 约定一致）。
- **连通性探测**：会话级最小 ainvoke；失败 = 环境错误标记（报告
  probe 字段 + 族 5 探测用例红色），依赖 LLM 的用例跳过（不级联噪音、
  不空跑不假绿）。
- **费用熔断记账**：ChargedLLM 包装真实调用（轮数 + token 估算），
  超限后 `real` 标记用例自动跳过并随报告输出（120 轮 / 60 万 token 估算）。
- **失败分类**：report.classify_failure 启发式 + FailureRepro 确定性
  复现归类（同一输入以 mock 协议重放：mock 也失败 = 机制缺陷）。
- **报告**：pytest_sessionfinish 落盘 tests/live/report/（JSON + MD：
  覆盖矩阵 + 费用审计 + 门禁核对 + 失败明细）。
- **共享装配**：auto 审批策略、本地故障端点、本地 MCP http server、
  sqlite 存储、redact 助手。
"""
from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from tests.live.report import (
    CAT_MECHANISM,
    LiveReport,
    TestEntry,
    classify_failure,
    estimate_tokens,
)

# 熔断硬上限（测试说明文档第四/七节）：真实调用轮数 / token 估算
FUSE_MAX_ROUNDS = 120
FUSE_MAX_TOKENS = 600_000
# 每真实调用的输出 token 预留（输入估算之外，保守偏高防费用失控）
_OUTPUT_TOKEN_ALLOWANCE = 300

_SESSION_STATE: dict = {}


# ----------------------------------------------------------------------
# 配置加载
# ----------------------------------------------------------------------

_CONFIG_FILE_NAMES = (".kilo", "测试模型配置.txt")


def _find_config_file() -> Path | None:
    """自 cwd 与 tests/live 逐级向上找 `.kilo/测试模型配置.txt`。"""
    starts = [Path.cwd(), Path(__file__).resolve().parent]
    for start in starts:
        current = start
        while True:
            candidate = current / ".kilo" / "测试模型配置.txt"
            if candidate.is_file():
                return candidate
            if current.parent == current:
                break
            current = current.parent
    return None


def load_live_config() -> dict:
    """环境变量优先，回落配置文件；缺失返回空 dict（fixture 判定 fail）。"""
    base_url = _os_env("INKENGINE_LIVE_BASE_URL")
    api_key = _os_env("INKENGINE_LIVE_API_KEY")
    model = _os_env("INKENGINE_LIVE_MODEL")
    if base_url and api_key and model:
        return {"url": base_url, "key": api_key, "model_name": model}
    config_file = _find_config_file()
    if config_file is None:
        return {}
    data: dict[str, str] = {}
    for line in config_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data


def _os_env(name: str) -> str:
    import os

    return os.environ.get(name, "")


@dataclass
class LiveEnv:
    """连通性探测结果（会话级；probe 失败 = 环境错误标记）。"""

    config: dict
    probe_ok: bool = False
    probe_error: str | None = None

    def run_probe(self) -> None:
        from ink_engine.core.llm.base import LLMConfig, collect_result
        from ink_engine.core.llm.messages import user
        from ink_engine.core.llm.registry import create_llm

        llm = create_llm(
            LLMConfig(
                adapter="openai_compat",
                model_id=self.config["model_name"],
                base_url=self.config["url"],
                api_key=self.config["key"],
                request_timeout=60.0,
            )
        )

        async def _probe_and_close() -> None:
            try:
                await collect_result(llm.astream([user("请只回复两个字：连通")]))
                self.probe_ok = True
            except Exception as exc:  # 探测失败 = 环境错误标记（不假绿）
                self.probe_error = f"{exc.__class__.__name__}: {exc}"
            finally:
                await llm.aclose()  # 同一循环内释放（httpx 循环绑定）

        asyncio.run(_probe_and_close())


# ----------------------------------------------------------------------
# 费用熔断记账
# ----------------------------------------------------------------------

@dataclass
class LiveLedger:
    """真实调用记账（轮数 + token 估算），超限触发熔断。"""

    max_rounds: int = FUSE_MAX_ROUNDS
    max_tokens: int = FUSE_MAX_TOKENS
    rounds: int = 0
    tokens: int = 0

    def charge(self, input_text: str) -> None:
        self.rounds += 1
        self.tokens += estimate_tokens(input_text) + _OUTPUT_TOKEN_ALLOWANCE

    def exhausted(self) -> bool:
        return self.rounds > self.max_rounds or self.tokens > self.max_tokens


class ChargedLLM:
    """真实 LLM 包装：每真实调用记账一次（轮数 + 输入 token 估算 + 输出预留）。

    循环无关性：每次调用完成后 aclose 底层客户端，下轮调用在任意
    asyncio 循环中重建连接——兼容 pytest-asyncio 函数级循环。
    """

    def __init__(self, inner, ledger: LiveLedger) -> None:
        self.inner = inner
        self.config = inner.config
        self._ledger = ledger

    @property
    def adapter(self) -> str:
        return self.inner.adapter

    def _charge(self, messages: Sequence) -> None:
        text = ""
        for message in messages:
            content = getattr(message, "content", None)
            if content:
                text += str(content)
            for call in getattr(message, "tool_calls", None) or []:
                text += str(call.arguments or "")
        self._ledger.charge(text)

    async def ainvoke(self, messages, *, tools=None, params=None):
        self._charge(messages)
        try:
            return await self.inner.ainvoke(messages, tools=tools, params=params)
        finally:
            await self.inner.aclose()

    async def astream(self, messages, *, tools=None, params=None) -> AsyncIterator:
        self._charge(messages)
        try:
            async for chunk in self.inner.astream(messages, tools=tools, params=params):
                yield chunk
        finally:
            await self.inner.aclose()

    async def aclose(self) -> None:
        await self.inner.aclose()


class FailureRepro:
    """确定性复现归类（测试说明文档第二节失败分类流程）。

    live 调用失败 → 以 mock 协议重放同一输入：重放也失败 = 机制缺陷
    （报告 mark mechanism）；重放通过 = 模型行为/环境（启发式分类）。
    """

    def __init__(self, live_report: LiveReport, nodeid: str) -> None:
        self._report = live_report
        self._nodeid = nodeid

    async def run(self, live_call, replay_call):
        if self._nodeid not in self._report.entries:
            self._report.entries[self._nodeid] = TestEntry(
                nodeid=self._nodeid, status="failed"
            )
        try:
            return await live_call()
        except BaseException as exc:
            try:
                await replay_call()
            except BaseException:
                self._report.mark(self._nodeid, CAT_MECHANISM)
            else:
                self._report.mark(self._nodeid, classify_failure(exc, is_real=True))
            raise


class AllowAllPolicy:
    """审批策略直过（确定性用例免挂卡）。"""

    def should_approve(self, key: str, action: dict) -> bool:
        return True

    def timeout_for(self, key: str, action: dict) -> float | None:
        return None


# ----------------------------------------------------------------------
# pytest 钩子
# ----------------------------------------------------------------------

def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "real: 真实 LLM 调用（计入费用熔断）")
    config.addinivalue_line("markers", "fault: 本地故障端点（真实协议故障注入）")


def pytest_runtest_call(item: pytest.Item) -> None:
    """真实调用用例的费用熔断：超限自动跳过（剩余真实族停跑并随报告输出）。"""
    infra = _SESSION_STATE.get("infra")
    if infra is None or item.get_closest_marker("real") is None:
        return
    if infra.ledger.exhausted():
        pytest.skip(
            f"费用熔断：真实调用轮数 {infra.ledger.rounds}/{infra.ledger.max_rounds}，"
            f"token 估算 {infra.ledger.tokens}/{infra.ledger.max_tokens}——停止剩余真实用例"
        )


def pytest_runtest_makereport(item: pytest.Item, call: pytest.CallInfo) -> None:
    infra = _SESSION_STATE.get("infra")
    if infra is None or call.when != "call":
        return
    entry = infra.report.entries.get(item.nodeid)
    if entry is None:
        entry = TestEntry(nodeid=item.nodeid, status="unknown")
        infra.report.entries[item.nodeid] = entry
    if call.excinfo is None:
        outcome = "passed"
    elif call.excinfo.typename == "Skipped":
        outcome = "skipped"
    else:
        outcome = "failed"
    entry.status = outcome
    entry.duration = getattr(call, "duration", 0.0) or 0.0
    entry.is_real = item.get_closest_marker("real") is not None
    entry.family = _family_of(item.nodeid)
    if call.excinfo is not None and entry.status == "failed" and entry.category is None:
        entry.category = classify_failure(call.excinfo.value, is_real=entry.is_real)
    if entry.status == "skipped" and infra.ledger.exhausted():
        entry.category = "fuse"
    if item.get_closest_marker("fault") is not None:
        entry.category = entry.category or "fault"


def pytest_sessionfinish(session: pytest.Session) -> None:
    infra = _SESSION_STATE.get("infra")
    if infra is None:
        return
    infra.report.fuse_exhausted = infra.ledger.exhausted()
    # 费用审计口径：报告与熔断记账同源（轮数/token 估算）
    infra.report.llm_total_rounds = infra.ledger.rounds
    infra.report.token_estimate_total = infra.ledger.tokens
    if infra.env is not None:
        infra.report.probe_ok = infra.env.probe_ok
        infra.report.probe_error = infra.env.probe_error
    json_path, md_path = infra.report.write()
    summary = infra.report.gates()["summary"]
    print(
        f"\n[live 报告] {summary['passed']} 通过 / {summary['failed']} 失败 / "
        f"{summary['skipped']} 跳过；真实调用 {infra.ledger.rounds} 轮 / "
        f"token 估算 {infra.ledger.tokens}"
    )
    print(f"[live 报告] {json_path}")
    print(f"[live 报告] {md_path}")


def _family_of(nodeid: str) -> str:
    match = re.search(r"test_(\d+)", nodeid)
    return match.group(1) if match else ""


# ----------------------------------------------------------------------
# fixtures
# ----------------------------------------------------------------------

@pytest.fixture(scope="session", autouse=True)
def live_infra() -> LiveInfra:
    """会话级基础设施（autouse：报告记账从首个用例起生效，孤儿模块核对不丢族）。"""
    infra = LiveInfra()
    _SESSION_STATE["infra"] = infra
    return infra


@dataclass
class LiveInfra:
    ledger: LiveLedger = field(default_factory=LiveLedger)
    report: LiveReport = field(default_factory=LiveReport)
    env: LiveEnv | None = None


@pytest.fixture(scope="session")
def live_ledger(live_infra: LiveInfra) -> LiveLedger:
    return live_infra.ledger


@pytest.fixture(scope="session")
def live_report(live_infra: LiveInfra) -> LiveReport:
    return live_infra.report


@pytest.fixture(scope="session")
def live_config() -> dict:
    """真实模型配置（env 或 .kilo/测试模型配置.txt）；缺失 = fail。"""
    data = load_live_config()
    if not (data.get("url") and data.get("key") and data.get("model_name")):
        pytest.fail(
            "显式运行 live 套件（-m live）但缺少模型配置——设置 "
            "INKENGINE_LIVE_BASE_URL/API_KEY/MODEL 或提供 .kilo/测试模型配置.txt；"
            "门禁不允许空跑"
        )
    return data


@pytest.fixture(scope="session")
def live_env(live_config: dict, live_infra: LiveInfra) -> LiveEnv:
    """连通性探测（会话级一次）；失败 = 环境错误标记。"""
    if live_infra.env is None:
        env = LiveEnv(config=live_config)
        env.run_probe()
        live_infra.env = env
        live_infra.ledger.charge("连通性探测（最小 ainvoke）")  # 探测计入费用审计
    return live_infra.env


@pytest.fixture
def live_llm(live_env: LiveEnv, live_ledger: LiveLedger):
    """真实模型 LLM 实例（ChargedLLM 包装，记账 + 循环无关）。"""
    from ink_engine.core.llm.base import LLMConfig
    from ink_engine.core.llm.registry import create_llm

    if not live_env.probe_ok:
        pytest.skip(f"连通性探测失败（环境错误）：{live_env.probe_error}")
    llm = create_llm(
        LLMConfig(
            adapter="openai_compat",
            model_id=live_env.config["model_name"],
            base_url=live_env.config["url"],
            api_key=live_env.config["key"],
            request_timeout=120.0,
        )
    )
    return ChargedLLM(llm, live_ledger)


@pytest.fixture
def live_llm_factory(live_env: LiveEnv, live_ledger: LiveLedger):
    """按需构建真实 LLM（备用链/多实例场景），返回 callable。"""

    def make(*, request_timeout: float = 120.0) -> ChargedLLM:
        if not live_env.probe_ok:
            pytest.skip(f"连通性探测失败（环境错误）：{live_env.probe_error}")
        from ink_engine.core.llm.base import LLMConfig
        from ink_engine.core.llm.registry import create_llm

        llm = create_llm(
            LLMConfig(
                adapter="openai_compat",
                model_id=live_env.config["model_name"],
                base_url=live_env.config["url"],
                api_key=live_env.config["key"],
                request_timeout=request_timeout,
            )
        )
        return ChargedLLM(llm, live_ledger)

    return make


@pytest.fixture
def repro(live_report: LiveReport) -> FailureRepro:
    """确定性复现归类器（需在用例内 bind nodeid）。"""
    return FailureRepro(live_report, "")


@pytest.fixture
def policy_auto() -> AllowAllPolicy:
    return AllowAllPolicy()


@pytest.fixture
def fault_server():
    """本地故障端点（真实 OpenAI 兼容 SSE，动态端口）。

    用例经 ``server.mode = "..."`` 设定默认模式，或请求携带
    ``?mode=...`` 查询参数/``X-Fault-Mode`` 头按请求覆盖。
    """
    from tests.live.fault_server import FaultServer

    server = FaultServer().start()
    yield server
    server.stop()


@pytest.fixture
def mcp_http_server():
    """本地真实 MCP http 传输 server（mcp SDK streamable http，动态端口）。"""
    from tests.live.mcp_http_server import start_mcp_http_server

    server = start_mcp_http_server()
    yield server
    server.stop()


@pytest.fixture
def sqlite_storage(tmp_path):
    """真实 sqlite 存储（每用例独立 db 文件；close 为协程，须等待回收）。"""
    import asyncio

    from ink_engine.core.storage import create_storage

    storage = create_storage(f"sqlite:///{tmp_path / 'live.db'}")
    yield storage
    asyncio.run(storage.close())


@pytest.fixture
def live_tmp(tmp_path):
    """live 用例临时目录（返回 Path）。"""
    return tmp_path


__all__ = [
    "AllowAllPolicy",
    "ChargedLLM",
    "FailureRepro",
    "LiveEnv",
    "LiveInfra",
    "LiveLedger",
    "estimate_tokens",
]

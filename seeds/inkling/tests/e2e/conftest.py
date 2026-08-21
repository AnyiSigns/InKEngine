"""e2e 公共夹具：stub AsyncLLM 工厂 + 存储后端参数化 + 装配夹具。

M3 全链路 e2e 必须可离线跑通（PLAN §8 风险表：注入确定性 stub
AsyncLLM，按脚本返回；真实模型 live 评测走 tests/live 单独标记）。
存储后端参数化：memory/sqlite 必跑（三后端矩阵的必跑子集）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from ink_engine.core.llm import AsyncLLM, LLMChunk
from ink_engine.core.llm.base import LLMConfig, LLMResult
from ink_engine.core.llm.tools import ToolSpec

# 仓库根（seeds/inkling/ 的上级两级；e2e 从仓库根以 pytest 运行）
REPO_ROOT = Path(__file__).resolve().parents[4]
SEED_ROOT = REPO_ROOT / "seeds" / "inkling"


class StubLLM(AsyncLLM):
    """确定性 stub 模型：按脚本返回（e2e 离线复现的模型层底座）。

    脚本形态（script 参数，按最后一条用户消息文本匹配）：
    ``{"<匹配子串>": {"reply": "文本"}}``；未命中返回缺省回复。
    记录调用次数（挡位统计钩子消费）。
    """

    adapter = "stub"

    def __init__(
        self,
        config: LLMConfig | dict[str, Any] | None = None,
        *,
        script: dict[str, Any] | None = None,
        default_reply: str = "（stub 缺省回复）",
    ) -> None:
        super().__init__(_coerce_config(config))
        self.script = dict(script or {})
        self.default_reply = default_reply
        self.call_count = 0

    def _reply_for(self, messages: list[Any]) -> str:
        self.call_count += 1
        for message in reversed(messages):
            content = getattr(message, "content", "")
            if not isinstance(content, str):
                continue
            for needle, spec in self.script.items():
                if needle in content:
                    return str(spec.get("reply") or self.default_reply)
        return self.default_reply

    async def ainvoke(
        self,
        messages: list[Any],
        *,
        tools: list[ToolSpec] | None = None,
        params: Any = None,
    ) -> LLMResult:
        return LLMResult(content=self._reply_for(messages))

    async def astream(
        self,
        messages: list[Any],
        *,
        tools: list[ToolSpec] | None = None,
        params: Any = None,
    ):
        reply = self._reply_for(messages)
        for token in _split_tokens(reply):
            yield LLMChunk(token=token)

    async def aclose(self) -> None:
        return None


def _coerce_config(config: LLMConfig | dict[str, Any] | None) -> LLMConfig:
    if isinstance(config, LLMConfig):
        return config
    if isinstance(config, dict):
        return LLMConfig(**config)
    # stub 挡位默认形态（LLMConfig 必填三字段；stub 不发起真实请求）
    return LLMConfig(adapter="stub", model_id="stub-model", base_url="http://stub.local")


def _split_tokens(text: str) -> list[str]:
    """确定性分帧（按字符切分，保证离线流式可断言）。"""
    return [ch for ch in text if ch]


@pytest.fixture
def stub_llm_factory():
    """stub 模型工厂（conftest 对外唯一构造入口，脚本/缺省可注入）。"""

    def make(**kwargs: Any) -> StubLLM:
        return StubLLM(**kwargs)

    return make


@pytest.fixture(params=["memory://", "sqlite:///:memory:"])
def storage_uri(request: pytest.FixtureRequest) -> str:
    """存储后端参数化（memory/sqlite 必跑，postgres 冒烟留待 CI）。"""
    return request.param


@pytest.fixture
def seed_root() -> Path:
    """InKling 种子根（seed_data/manifest 所在目录）。"""
    return SEED_ROOT


class ScriptedApprovalCtx:
    """脚本化审批上下文：审批卡按 key 返回预置决议（离线确定性）。

    形态对齐引擎 ctx 鸭子协议：interrupt(key, payload) 记录卡负载并
    返回预置决议（accept/reject/edit dict）；get_interrupt_payload
    返回最近一次卡负载。edit 决议经 edited_content 重走校验链。
    """

    def __init__(self, decisions: dict[str, Any] | None = None) -> None:
        self._decisions = dict(decisions or {})
        self.cards: list[dict[str, Any]] = []

    def set_decision(self, key: str, decision: Any) -> None:
        self._decisions[key] = decision

    async def interrupt(self, key: str, payload: dict[str, Any]) -> Any:
        self.cards.append({"key": key, "payload": payload})
        if key in self._decisions:
            return self._decisions[key]
        return "accept"

    async def get_interrupt_payload(self, key: str) -> dict[str, Any] | None:
        for card in reversed(self.cards):
            if card["key"] == key:
                return card["payload"]
        return None

    @property
    def card_keys(self) -> list[str]:
        return [card["key"] for card in self.cards]


@pytest.fixture
def approval_ctx():
    """脚本化审批上下文工厂（默认全 accept）。"""

    def make(decisions: dict[str, Any] | None = None) -> ScriptedApprovalCtx:
        return ScriptedApprovalCtx(decisions)

    return make


async def boot_runtime(
    *,
    storage_uri: str = "memory://",
    llm: AsyncLLM | None = None,
    market: dict[str, Any] | None = None,
):
    """InKling 运行时装配（boot_inkling 封装：测试侧统一入口）。"""
    from host.host import boot_inkling

    return await boot_inkling(
        SEED_ROOT,
        llm=llm,
        storage_uri=storage_uri,
        market=market,
    )


@pytest.fixture
async def booted(storage_uri: str):
    """已装配运行时（存储后端参数化；llm = stub 缺省实例）。"""
    runtime, host, mount_service = await boot_runtime(
        storage_uri=storage_uri, llm=StubLLM()
    )
    try:
        yield runtime, host, mount_service
    finally:
        await runtime.stop()


def load_seed(name: str) -> dict[str, Any]:
    """读 seed_data JSON（测试断言与宿主同源数据）。"""
    return json.loads((SEED_ROOT / "seed_data" / name).read_text(encoding="utf-8"))


__all__ = [
    "REPO_ROOT",
    "SEED_ROOT",
    "ScriptedApprovalCtx",
    "StubLLM",
    "boot_runtime",
    "load_seed",
]

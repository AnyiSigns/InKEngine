"""重试/退避/备用切换/流式中断（ModelChain）单测。

用 ScriptedLLM 脚本化调用结果（异常或成功），零网络、确定性验证：
- 瞬时故障指数退避重试（流式仅首块前重试）；
- 确定性失败不重试；
- 重试耗尽切备用模型（ainvoke 与 astream 首块前失败）；
- 流式产出后失败不切换（防重复内容）；
- 链全部失败抛最后一次错误；
- 取消语义：CancelledError 穿透不吞、退避睡眠中取消立即中止。
"""
from __future__ import annotations

import asyncio

import pytest

from engine_core.llm.base import AsyncLLM, LLMChunk, LLMConfig, LLMResult
from engine_core.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMError,
    LLMNetworkError,
    LLMServerError,
    LLMTimeoutError,
)
from engine_core.llm.fallback import ModelChain, RetryPolicy
from engine_core.llm.messages import user

INFINITE_STREAM = object()  # 哨兵：无限流脚本（取消语义测试专用）


class ScriptedLLM(AsyncLLM):
    """按脚本顺序产出调用结果：异常实例 = 抛出；LLMResult = 成功；流式列表逐项产出。"""

    adapter = "scripted"

    def __init__(self, config, *, ainvoke_outcomes=None, astream_outcomes=None):
        super().__init__(config)
        self._ainvoke_outcomes = list(ainvoke_outcomes or [])
        self._astream_outcomes = list(astream_outcomes or [])
        self.ainvoke_calls = 0
        self.astream_calls = 0
        self.aclosed = False

    async def aclose(self) -> None:
        self.aclosed = True

    def _outcome(self, outcomes, calls):
        if not outcomes:
            return None
        return outcomes[min(len(outcomes) - 1, calls - 1)]

    async def ainvoke(self, messages, *, tools=None, params=None):
        self.ainvoke_calls += 1
        outcome = self._outcome(self._ainvoke_outcomes, self.ainvoke_calls)
        if outcome is None:
            return LLMResult(content="ok")
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    async def astream(self, messages, *, tools=None, params=None):
        self.astream_calls += 1
        outcome = self._outcome(self._astream_outcomes, self.astream_calls)
        if outcome is None:
            outcome = [LLMChunk(token="ok")]
        if outcome is INFINITE_STREAM:
            while True:  # 无限流（取消测试用：任务永不自然结束）
                yield LLMChunk(token="x")
                await asyncio.sleep(0)
            return
        if isinstance(outcome, BaseException):
            raise outcome
        for item in outcome:
            if isinstance(item, BaseException):
                raise item
            yield item
            await asyncio.sleep(0)  # 真实流式有 await 点（任务可挂起/取消）


def make_chain(a_outcomes, b_outcomes, *, retry=None, a_stream=None, b_stream=None):
    """双模型链（a 主 + b 备），返回 (chain, {model_id: llm})。"""
    configs = [
        LLMConfig(adapter="scripted", model_id="a", base_url="http://a"),
        LLMConfig(adapter="scripted", model_id="b", base_url="http://b"),
    ]
    made: dict[str, ScriptedLLM] = {}

    def create(cfg):
        llm = ScriptedLLM(
            cfg,
            ainvoke_outcomes=a_outcomes if cfg.model_id == "a" else b_outcomes,
            astream_outcomes=(a_stream if cfg.model_id == "a" else b_stream),
        )
        made[cfg.model_id] = llm
        return llm

    return ModelChain(configs, retry=retry, create=create), made


QUICK = RetryPolicy(attempts=3, base_delay=0.01, max_delay=0.05)


class TestRetryAinvoke:
    async def test_transient_retried_then_success(self):
        chain, made = make_chain(
            a_outcomes=[LLMTimeoutError()],
            b_outcomes=[],
            retry=QUICK,
        )
        result = await chain.ainvoke([user("hi")])
        assert result.content == "ok"
        assert made["a"].ainvoke_calls == 3  # 3 次尝试后成功

    async def test_transient_retry_backoff_count(self):
        chain, made = make_chain(
            a_outcomes=[LLMNetworkError()],
            b_outcomes=[LLMNetworkError()],
            retry=QUICK,
        )
        with pytest.raises(LLMNetworkError):
            await chain.ainvoke([user("hi")])
        assert made["a"].ainvoke_calls == 3  # 主模型重试预算耗尽
        assert made["b"].ainvoke_calls == 3  # 备用模型同样带完整重试预算

    async def test_fallback_after_retries_exhausted(self):
        chain, made = make_chain(
            a_outcomes=[LLMTimeoutError()],
            b_outcomes=[LLMResult(content="备用成功")],
            retry=QUICK,
        )
        result = await chain.ainvoke([user("hi")])
        assert result.content == "备用成功"
        assert made["a"].ainvoke_calls == 3
        assert made["b"].ainvoke_calls == 1

    async def test_chain_exhausted_raises_last(self):
        chain, _ = make_chain(
            a_outcomes=[LLMTimeoutError()],
            b_outcomes=[LLMServerError()],
            retry=QUICK,
        )
        with pytest.raises(LLMServerError):
            await chain.ainvoke([user("hi")])

    async def test_auth_failure_fail_closed(self):
        # 认证失败（fail-closed）：不重试不切备用，直接上抛（密钥失效立即可见）
        chain, made = make_chain(
            a_outcomes=[LLMAuthError()],
            b_outcomes=[],
            retry=RetryPolicy(attempts=1, base_delay=0.01),
        )
        with pytest.raises(LLMAuthError):
            await chain.ainvoke([user("hi")])
        assert made["a"].ainvoke_calls == 1  # 确定性失败不重试
        assert "b" not in made  # 备用未被创建（fail-closed 不切）

    async def test_non_auth_non_transient_still_falls_back(self):
        # 非认证确定性失败（请求非法/模型不存在）仍切备用——配置兜底语义
        chain, made = make_chain(
            a_outcomes=[LLMBadRequestError()],
            b_outcomes=[LLMResult(content="备用成功")],
            retry=QUICK,
        )
        result = await chain.ainvoke([user("hi")])
        assert result.content == "备用成功"
        assert made["a"].ainvoke_calls == 1  # 确定性失败不重试
        assert made["b"].ainvoke_calls == 1  # 但非认证仍切备用

    async def test_auth_failure_fail_closed_stream(self):
        chain, made = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[LLMAuthError()],
        )
        with pytest.raises(LLMAuthError):
            async for _ in chain.astream([user("hi")]):
                pass
        assert "b" not in made  # 流式同样 fail-closed

    async def test_cancel_during_backoff(self):
        chain, made = make_chain(
            a_outcomes=[LLMTimeoutError()],
            b_outcomes=[],
            retry=RetryPolicy(attempts=3, base_delay=30.0),
        )
        task = asyncio.create_task(chain.ainvoke([user("hi")]))
        await asyncio.sleep(0.1)  # 已进入退避睡眠
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert made["a"].ainvoke_calls == 1  # 取消穿透，不再重试


class TestRetryAstream:
    async def test_retry_only_before_first_chunk(self):
        # 首次调用：首块前失败；第二次：正常流
        chain, made = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[LLMNetworkError(), [LLMChunk(token="好")]],
        )
        chunks = [c async for c in chain.astream([user("hi")])]
        assert [c.token for c in chunks] == ["好"]
        assert made["a"].astream_calls == 2

    async def test_no_retry_after_first_chunk(self):
        # 首次调用产出 1 块后失败：不重试不切换，直接上抛
        chain, made = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[[LLMChunk(token="前"), LLMNetworkError()]],
        )
        chunks: list[LLMChunk] = []
        with pytest.raises(LLMNetworkError):
            async for c in chain.astream([user("hi")]):
                chunks.append(c)
        assert [c.token for c in chunks] == ["前"]
        assert made["a"].astream_calls == 1  # 产出后失败不重试
        assert "b" not in made  # 备用模型未被创建（不切换，防重复内容）

    async def test_fallback_before_first_chunk(self):
        chain, made = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[LLMTimeoutError()],
            b_stream=[[LLMChunk(token="备用流")]],
        )
        chunks = [c async for c in chain.astream([user("hi")])]
        assert [c.token for c in chunks] == ["备用流"]
        assert made["a"].astream_calls == 3  # 重试预算耗尽
        assert made["b"].astream_calls == 1

    async def test_chain_exhausted_stream(self):
        chain, _ = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[LLMTimeoutError()],
            b_stream=[LLMServerError()],
        )
        with pytest.raises(LLMServerError):
            async for _ in chain.astream([user("hi")]):
                pass

    async def test_cancel_propagates(self):
        chain, _ = make_chain(
            a_outcomes=[],
            b_outcomes=[],
            retry=QUICK,
            a_stream=[INFINITE_STREAM],
        )
        task = asyncio.create_task(_drain(chain.astream([user("hi")])))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    async def test_aclose_releases_created_llms(self):
        chain, made = make_chain(a_outcomes=[], b_outcomes=[], retry=QUICK)
        await chain.ainvoke([user("hi")])
        assert "a" in made
        await chain.aclose()
        assert made["a"].aclosed  # 链上已创建的模型实例被释放
        await chain.aclose()  # 幂等


async def _drain(stream):
    async for _ in stream:
        pass


class TestConfig:
    def test_from_dict_mapping(self):
        cfg = LLMConfig.from_dict(
            {
                "adapter": "deepseek",
                "model_id": "deepseek-chat",
                "base_url": "https://api.deepseek.com/v1",
                "api_key": "k",
                "temperature": 0.5,
                "max_tokens": 200,
                "request_timeout": 30.0,
                "future_field": 1,
            }
        )
        assert cfg.adapter == "deepseek"
        assert cfg.temperature == 0.5
        assert cfg.max_tokens == 200
        assert cfg.extra == {"future_field": 1}

    @pytest.mark.parametrize("missing", ["adapter", "model_id", "base_url"])
    def test_from_dict_requires_fields(self, missing):
        data = {"adapter": "a", "model_id": "m", "base_url": "http://x"}
        del data[missing]
        with pytest.raises(LLMError):
            LLMConfig.from_dict(data)

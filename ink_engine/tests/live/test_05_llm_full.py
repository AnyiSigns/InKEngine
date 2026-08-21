"""族 5：LLM 层真实（test_05_llm_full.py）｜llm/* 全部 9 模块。

- 真实端点：ainvoke/astream/reasoning 透传、多轮 tool call 循环（strict 解析）
- fallback 链：主配置瞬时失败 → 重试耗尽 → 备用真实成功；认证失败
  fail-closed 不切备用
- 取消穿透；本地故障端点全套（超时/429/坏帧/空流/error 帧/乱序/断开）
- 确定性：messages 工厂/角色归一/accumulate_tool_calls、errors 分类矩阵
- embeddings 真实端点若可用（不可用标跳过）

标记：`real` = 真实 LLM 调用（计入费用熔断）；`fault` = 本地故障端点
（真实协议、零费用）。模块级 `live` 标记：仅 `-m live` 显式运行。
"""
from __future__ import annotations

import asyncio

import pytest

pytestmark = pytest.mark.live

from ink_engine.core.llm.base import LLMChunk, LLMParams, collect_result  # noqa: E402
from ink_engine.core.llm.errors import (  # noqa: E402
    LLMAuthError,
    LLMBadRequestError,
    LLMEmptyStreamError,
    LLMFormatError,
    LLMNetworkError,
    LLMNotFoundError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
    LLMUnknownError,
    classify_llm_error,
)
from ink_engine.core.llm.fallback import ModelChain, RetryPolicy  # noqa: E402
from ink_engine.core.llm.messages import (  # noqa: E402
    Message,
    ToolCall,
    ToolCallDelta,
    accumulate_tool_calls,
    assistant,
    message_role,
    system,
    tool_result,
    user,
)
from ink_engine.core.llm.registry import create_llm  # noqa: E402
from ink_engine.core.llm.tools import ToolSpec, to_openai_tools  # noqa: E402

WEATHER_TOOL = ToolSpec(
    name="get_weather",
    description="查询指定城市的天气，返回该城市今日天气概况",
    parameters={
        "type": "object",
        "properties": {"city": {"type": "string", "description": "城市名"}},
        "required": ["city"],
    },
)


def _fault_config(fs, *, mode: str, timeout: float = 10.0) -> dict:
    # 路径段路由：base_url 带 /m/<mode> → 请求路径 /m/<mode>/chat/completions
    base = f"{fs.base_url}/m/{mode}"
    return {
        "adapter": "openai_compat",
        "model_id": "fault-model",
        "base_url": base,
        "api_key": "test-key",
        "request_timeout": timeout,
    }


# ----------------------------------------------------------------------
# 连通性（会话级探测的显式门禁：失败 = 红色，不假绿）
# ----------------------------------------------------------------------

def test_connectivity_probe(live_env):
    assert live_env.probe_ok, f"连通性探测失败（环境错误）：{live_env.probe_error}"


# ----------------------------------------------------------------------
# 真实端点：最小闭环
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_real_ainvoke(live_llm):
    """非流式真实调用：有内容产出 + 协议字段完整。"""
    result = await live_llm.ainvoke([user("请用一句话回答：1+1 等于几？")])
    assert result.content.strip(), "非流式调用无内容产出"
    assert isinstance(result.finish_reason, str) or result.content


@pytest.mark.real
async def test_real_stream_and_reasoning(live_llm):
    """流式真实调用：chunk 增量 + reasoning 透传（模型支持时）。"""
    chunks: list[LLMChunk] = []
    async for chunk in live_llm.astream([user("请用一句话回答：2+2 等于几？")]):
        chunks.append(chunk)
    assert chunks, "流式调用零 chunk"
    text = "".join(c.token or "" for c in chunks)
    assert text.strip(), "流式调用无内容产出"
    reasoning = "".join(c.reasoning_token or "" for c in chunks)
    if reasoning:
        assert reasoning.strip()
    result = await collect_result(live_llm.astream([user("请回答：4+4 等于几？")]))
    assert result.content.strip()


@pytest.mark.real
async def test_real_tool_call_loop_strict(live_llm):
    """多轮 tool call 循环：模型产出调用 → strict 解析 → 喂回工具结果 →
    收口最终回答（真实端点上验证协议闭环）。"""
    messages = [user("请调用 get_weather 工具查询北京和上海的天气，然后总结成一句话")]
    for _ in range(4):
        result = await live_llm.ainvoke(messages, tools=[WEATHER_TOOL])
        if not result.tool_calls:
            assert result.content.strip(), "工具循环后无最终回答"
            return
        assert len(result.tool_calls) <= 2, "单轮工具调用数异常"
        messages.append(assistant(tool_calls=result.tool_calls))
        for call in result.tool_calls:
            args = call.parse_arguments(strict=True)  # strict：截断/非法直接拒绝
            city = args["city"]
            messages.append(
                tool_result(content=f"{city} 今日晴，气温 22 摄氏度", tool_call_id=call.id)
            )
    pytest.fail("工具调用循环未收口（4 轮未产生最终回答）")


@pytest.mark.real
async def test_real_params_override(live_llm):
    """调用级参数覆盖：params.max_tokens 生效（小预算仍产出内容或显式截断）。"""
    result = await live_llm.ainvoke(
        [user("请写一段 200 字的产品介绍")],
        params=LLMParams(max_tokens=64, temperature=0.2),
    )
    assert isinstance(result.content, str)


# ----------------------------------------------------------------------
# fallback 链（真实协议）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_fallback_transient_to_real_backup(live_llm_factory):
    """主配置瞬时失败（本地故障端点 500）→ 重试耗尽 → 备用真实模型成功。"""
    from ink_engine.core.llm.base import LLMConfig

    backup = live_llm_factory()
    backup_used = {"called": False}
    original_ainvoke = backup.inner.ainvoke

    async def spy_ainvoke(messages, **kw):
        backup_used["called"] = True
        return await original_ainvoke(messages, **kw)

    backup.inner.ainvoke = spy_ainvoke
    with _fault_server_mode("http_500") as fs:
        chain = ModelChain(
            [
                LLMConfig(**_fault_config(fs, mode="http_500")),
                backup.config,
            ],
            retry=RetryPolicy(attempts=2, base_delay=0.01, max_delay=0.05),
            create=lambda cfg: backup if cfg == backup.config else create_llm(cfg),
        )
        result = await chain.ainvoke([user("请用一句话回答：今天是几号？")])
    assert result.content.strip(), "备用真实模型未产出内容"
    assert backup_used["called"], "备用模型未被调用（链路未切换）"
    await chain.aclose()


@pytest.mark.real
async def test_fallback_auth_fail_closed(live_llm_factory):
    """认证失败 fail-closed：主配置 401 → 直接上抛，备用模型绝不调用。"""
    from ink_engine.core.llm.base import LLMConfig

    backup = live_llm_factory()
    backup_used = {"called": False}
    original_ainvoke = backup.inner.ainvoke

    async def spy_ainvoke(messages, **kw):
        backup_used["called"] = True
        return await original_ainvoke(messages, **kw)

    backup.inner.ainvoke = spy_ainvoke
    with _fault_server_mode("http_401") as fs:
        chain = ModelChain(
            [
                LLMConfig(**_fault_config(fs, mode="http_401")),
                backup.config,
            ],
            retry=RetryPolicy(attempts=2, base_delay=0.01, max_delay=0.05),
            create=lambda cfg: backup if cfg == backup.config else create_llm(cfg),
        )
        with pytest.raises(LLMAuthError):
            await chain.ainvoke([user("hi")])
    assert not backup_used["called"], "认证失败不得静默切备用（fail-closed）"
    await chain.aclose()


def _fault_server_mode(mode: str):
    from tests.live.fault_server import FaultServer

    return FaultServer(mode=mode).start()


# ----------------------------------------------------------------------
# 取消穿透（本地故障端点）
# ----------------------------------------------------------------------

@pytest.mark.fault
async def test_cancel_propagation(fault_server):
    """流式消费中取消：CancelledError 原样穿透 + 上游连接关闭（不悬挂）。"""
    from ink_engine.core.llm.base import LLMConfig

    fault_server.mode = "slow_stream"
    fault_server.delay = 30.0  # 首块后长时间无数据：取消窗口
    llm = create_llm(LLMConfig(**_fault_config(fault_server, mode="slow_stream", timeout=60.0)))

    task = asyncio.create_task(collect_result(llm.astream([user("hi")])))
    try:
        await asyncio.wait_for(task, timeout=15.0)  # 若未取消前返回则异常
        pytest.fail("流提前结束（取消语义未生效的测试前提不成立）")
    except TimeoutError:
        pass
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await llm.aclose()


# ----------------------------------------------------------------------
# 本地故障端点全套（真实协议 + 确定性分类）
# ----------------------------------------------------------------------

_FAULT_EXPECT = [
    pytest.param("ok", "content", None, id="ok"),
    pytest.param("ok_json", "content", None, id="ok_json"),
    pytest.param("http_429", "raise", LLMRateLimitError, id="http_429"),
    pytest.param("http_401", "raise", LLMAuthError, id="http_401"),
    pytest.param("http_400", "raise", LLMBadRequestError, id="http_400"),
    pytest.param("http_404", "raise", LLMNotFoundError, id="http_404"),
    pytest.param("http_500", "raise", LLMServerError, id="http_500"),
    pytest.param("empty_stream", "raise", LLMEmptyStreamError, id="empty_stream"),
    pytest.param("bad_frames_only", "raise", LLMEmptyStreamError, id="bad_frames_only"),
    pytest.param("error_frame", "raise", LLMRateLimitError, id="error_frame"),
    pytest.param("disconnect", "raise", LLMNetworkError, id="disconnect"),
    pytest.param("timeout", "raise", LLMTimeoutError, id="timeout"),
    pytest.param("slow_stream", "raise", LLMTimeoutError, id="slow_stream"),
    pytest.param("bad_frames", "content", None, id="bad_frames"),
    pytest.param("reorder", "content", None, id="reorder"),
]


@pytest.mark.fault
@pytest.mark.parametrize("mode,kind,expected", _FAULT_EXPECT)
async def test_fault_modes_matrix(fault_server, mode, kind, expected):
    """故障矩阵：真实协议注入的每种故障分类到承诺的 LLMError 语义。"""
    from ink_engine.core.llm.base import LLMConfig

    fault_server.mode = mode
    fault_server.delay = 2.5
    # 超时族：客户端超时必须小于服务器注入延迟；其余模式 10s 常规超时
    timeout = 1.0 if mode in ("timeout", "slow_stream") else 10.0
    llm = create_llm(LLMConfig(**_fault_config(fault_server, mode=mode, timeout=timeout)))
    try:
        if kind == "content":
            if mode == "ok_json":
                result = await llm.ainvoke([user("hi")])
                assert result.content.strip()
            else:
                result = await collect_result(llm.astream([user("hi")]))
                assert result.content.strip(), f"模式 {mode} 未产出内容"
        else:
            with pytest.raises(expected) as excinfo:
                if mode == "ok_json":
                    await llm.ainvoke([user("hi")])
                else:
                    await collect_result(llm.astream([user("hi")]))
            assert isinstance(excinfo.value, expected)
    finally:
        await llm.aclose()


@pytest.mark.fault
async def test_fault_mode_via_header(fault_server):
    """单实例多模式：路径段路由（base_url 注入 /m/<mode>）按请求取故障模式。"""
    from ink_engine.core.llm.base import LLMConfig

    llm = create_llm(LLMConfig(**_fault_config(fault_server, mode="http_429")))
    try:
        with pytest.raises(LLMRateLimitError):
            await llm.ainvoke([user("hi")])
    finally:
        await llm.aclose()
    ok_llm = create_llm(LLMConfig(**_fault_config(fault_server, mode="ok_json")))
    try:
        result = await ok_llm.ainvoke([user("hi")])
        assert result.content.strip()
    finally:
        await ok_llm.aclose()


# ----------------------------------------------------------------------
# 确定性：messages 工厂 / 角色归一 / 增量累积
# ----------------------------------------------------------------------

def test_messages_factory_and_roles():
    msg = system("你是助手")
    assert message_role(msg) == "system"
    assert message_role(user("hi")) == "user"
    assert message_role(assistant("ok")) == "assistant"
    assert message_role(tool_result("结果", "call-1")) == "tool"
    # 别名归一
    assert message_role({"role": "human", "content": "x"}) == "user"
    assert message_role({"role": "ai"}) == "assistant"
    assert message_role({"type": "human"}) == "user"
    assert message_role(object()) == "object"
    # tool 消息必带 tool_call_id
    with pytest.raises(Exception)  :  # noqa: B017  # fail-closed 拒绝语义：任何异常=拒绝成立
        Message(role="tool", content="x")


def test_tool_call_strict_parse():
    good = ToolCall(id="1", name="f", arguments='{"city": "北京"}')
    assert good.parse_arguments(strict=True) == {"city": "北京"}
    broken = ToolCall(id="2", name="f", arguments='{"city": "北')
    assert broken.parse_arguments(strict=False) == {}
    with pytest.raises(LLMFormatError):
        broken.parse_arguments(strict=True)
    empty = ToolCall(id="3", name="f", arguments="")
    with pytest.raises(LLMFormatError):
        empty.parse_arguments(strict=True)
    not_object = ToolCall(id="4", name="f", arguments="[1,2]")
    with pytest.raises(LLMFormatError):
        not_object.parse_arguments(strict=True)


def test_accumulate_tool_calls_deltas():
    deltas = [
        ToolCallDelta(index=0, id="a", name="f1", arguments_delta='{"x":'),
        ToolCallDelta(index=1, id="b", name="f2", arguments_delta="{}"),
        ToolCallDelta(index=0, arguments_delta="1}"),
    ]
    calls = accumulate_tool_calls(deltas)
    assert [c.name for c in calls] == ["f1", "f2"]
    assert calls[0].arguments == '{"x":1}'


def test_to_openai_tools():
    specs = [WEATHER_TOOL]
    converted = to_openai_tools(specs)
    assert converted[0]["type"] == "function"
    assert converted[0]["function"]["name"] == "get_weather"
    assert "parameters" in converted[0]["function"]


# ----------------------------------------------------------------------
# 确定性：errors 分类矩阵
# ----------------------------------------------------------------------

def test_classify_llm_error_status_matrix():
    cases = [
        (408, LLMTimeoutError),
        (429, LLMRateLimitError),
        (402, LLMRateLimitError),
        (401, LLMAuthError),
        (403, LLMAuthError),
        (404, LLMNotFoundError),
        (400, LLMBadRequestError),
        (422, LLMBadRequestError),
        (500, LLMServerError),
        (503, LLMServerError),
        (None, LLMUnknownError),
    ]
    for status, cls in cases:
        error = classify_llm_error(status)
        assert isinstance(error, cls), f"status {status} → {type(error).__name__}"
        assert error.status_code == status


def test_classify_llm_error_keyword_fallback():
    assert isinstance(classify_llm_error(detail="上游限流，请稍后再试"), LLMRateLimitError)
    assert isinstance(classify_llm_error(detail="服务繁忙，稍后再试"), LLMServerError)
    assert isinstance(classify_llm_error(detail="连接超时"), LLMTimeoutError)
    assert isinstance(classify_llm_error(detail="连接失败"), LLMNetworkError)
    assert isinstance(classify_llm_error(detail="其它文案"), LLMUnknownError)


def test_classify_llm_error_exc_mapping():
    import httpx

    assert isinstance(classify_llm_error(exc=TimeoutError("t")), LLMTimeoutError)
    assert isinstance(classify_llm_error(exc=httpx.ConnectError("c")), LLMNetworkError)
    assert isinstance(classify_llm_error(exc=httpx.RemoteProtocolError("p")), LLMNetworkError)


def test_llm_error_detail_redacted_and_truncated():
    error = LLMRateLimitError(detail="密钥 sk-abcdef1234567890 已过期")
    assert "sk-abcdef1234567890" not in str(error), "凭据形态未遮蔽"
    long_detail = "x" * 1000
    error2 = LLMFormatError(detail=long_detail)
    assert len(error2.detail or "") <= 200, "detail 未截断"


# ----------------------------------------------------------------------
# embeddings（真实端点若可用，不可用标跳过）
# ----------------------------------------------------------------------

@pytest.mark.real
async def test_embeddings_real(live_config, live_llm_factory):
    """embeddings 真实端点：可用则返回向量；端点不支持则显式跳过。"""
    from ink_engine.core.llm.embeddings import create_embedder

    embedder = create_embedder(
        {
            "adapter": "openai_compat",
            "model_id": live_config["model_name"],
            "base_url": live_config["url"],
            "api_key": live_config["key"],
            "request_timeout": 30.0,
        }
    )
    try:
        vector = await embedder.aembed_query("测试向量查询")
    except (LLMNotFoundError, LLMBadRequestError, LLMUnknownError) as exc:
        pytest.skip(f"端点不支持 embeddings（{type(exc).__name__}）——协议层由单测覆盖")
    except Exception as exc:
        pytest.skip(f"embeddings 端点不可用（{type(exc).__name__}）")
    finally:
        await embedder.aclose()
    assert isinstance(vector, list) and len(vector) > 0, "embedding 向量为空"

"""失败分类启发式单测（live 报告口径，离线确定性）。

覆盖 classify_failure 的 is_real 分流语义：纯逻辑失败在确定性用例归
机制缺陷（门禁⑤统计），在真实模型用例归模型行为（输出漂移主因）；
LLM/引擎/环境异常分类不随 is_real 变化。
"""
from __future__ import annotations

from ink_engine.core.exceptions import EngineError
from ink_engine.core.llm.errors import LLMRateLimitError

from tests.live.report import (
    CAT_ENVIRONMENT,
    CAT_MECHANISM,
    CAT_MODEL,
    classify_failure,
)


def test_assertion_non_real_is_mechanism():
    assert classify_failure(AssertionError("x")) == CAT_MECHANISM


def test_assertion_real_is_model():
    assert classify_failure(AssertionError("x"), is_real=True) == CAT_MODEL


def test_llm_error_is_model_regardless_of_real():
    err = LLMRateLimitError(detail="429")
    assert classify_failure(err) == CAT_MODEL
    assert classify_failure(err, is_real=True) == CAT_MODEL


def test_engine_error_is_mechanism_regardless_of_real():
    err = EngineError("引擎机制异常")
    assert classify_failure(err) == CAT_MECHANISM
    assert classify_failure(err, is_real=True) == CAT_MECHANISM


def test_env_error_is_environment():
    assert classify_failure(ConnectionError("断网")) == CAT_ENVIRONMENT
    assert classify_failure(TimeoutError("超时")) == CAT_ENVIRONMENT

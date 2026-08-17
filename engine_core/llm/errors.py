"""LLM 层异常体系（引擎内核模块，零业务依赖）。

层级：LLMError（EngineError 子类）→ 按失败语义细分。classify_llm_error
把 httpx 传输异常 / HTTP 状态码 / 上游错误正文关键词映射为语义化异常，
供重试与备用切换策略判定：

- retryable（瞬时）：超时（含 408）/ 限流（含 402 额度）/ 网络 / 5xx / 空流
  / 上游「服务繁忙/过载」类文案——值得指数退避重试与切备用模型；
- 确定性失败：认证 / 请求非法 / 模型不存在——不重试（认证类亦不切备用，
  fail-closed，防密钥失效被静默掩盖）。

语义对齐 text_forge_backend/core/llm_retry 的瞬时故障集合（429/500/502/503/504
+ 超时 + 网络 + 额度 + 国内 MaaS 中文文案兜底），引擎自包含实现，宿主不再重复维护。

**上游文本规范化（对象级不变量）**：进入异常的任何上游正文（detail）统一执行
控制字符剥离 → 长度截断 → 敏感形态遮蔽——日志侧/出站侧不再二次过滤。
"""
from __future__ import annotations

import re

from engine_core.exceptions import EngineError
from engine_core.logging import redact

# 上游正文进入异常前的规范化上限（与引擎其他错误分支 200 字符口径一致）
_DETAIL_MAX_LEN = 200
# 控制字符（C0 + DEL）剥离：防日志注入（伪造行/ANSI 序列）与终端干扰
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")

# 上游错误正文关键词 → 瞬时故障分类（吸收 v3 core/errors.classify_model_error
# 的文本兜底：国内 MaaS 常见「服务繁忙/过载」等文案错误帧无状态码可依）
_TRANSIENT_KEYWORDS: tuple[tuple[tuple[str, ...], type[LLMError]], ...] = (
    (("timeout", "timed out", "读超时", "连接超时"), "LLMTimeoutError"),
    (("quota", "rate limit", "too many", "限流", "频率", "额度"), "LLMRateLimitError"),
    (("connection", "network", "refused", "连接失败", "网络错误", "网络异常"), "LLMNetworkError"),
    (
        ("overload", "server error", "server_error", "unavailable", "service busy",
         "繁忙", "过载", "服务暂时不可用", "服务不可用", "暂时不可用", "稍后再试"),
        "LLMServerError",
    ),
)


class LLMError(EngineError):
    """LLM 调用失败基类（重试/备用策略按子类语义判定）。

    上游正文（detail）在构造时统一规范化：控制字符剥离 → 截断 → 遮蔽，
    message 与 detail 双遮蔽——「遮蔽」为对象级不变量而非仅日志出口。
    """

    default_message = "LLM 调用失败"
    status_code: int | None = None
    detail: str | None = None

    def __init__(
        self,
        message: str = "",
        detail: str | None = None,
        status_code: int | None = None,
    ) -> None:
        self.status_code = status_code if status_code is not None else type(self).status_code
        if detail:
            detail = _CONTROL_CHAR_RE.sub(" ", detail)[:_DETAIL_MAX_LEN]
            detail = redact(detail)
        self.detail = detail
        base = message or self.default_message
        if detail:
            base = f"{base}（{detail}）"
        super().__init__(base)


class LLMTimeoutError(LLMError):
    """请求超时（HTTP 408/连接/读取/写入），瞬时故障。"""

    default_message = "LLM 请求超时"


class LLMRateLimitError(LLMError):
    """限流/额度不足（HTTP 429/402），瞬时故障，值得退避重试。"""

    default_message = "LLM 请求被限流"
    status_code = 429


class LLMNetworkError(LLMError):
    """网络层失败（连接拒绝/断开/协议错误），瞬时故障。"""

    default_message = "LLM 网络错误"


class LLMServerError(LLMError):
    """服务端错误（HTTP 5xx/上游过载文案），瞬时故障。"""

    default_message = "LLM 服务端错误"


class LLMEmptyStreamError(LLMError):
    """服务端返回 200 但流中零数据帧（空流），视为瞬时故障可重试。"""

    default_message = "LLM 流为空"


class LLMAuthError(LLMError):
    """认证/鉴权失败（HTTP 401/403），确定性失败，不重试不切备用（fail-closed）。"""

    default_message = "LLM 认证失败"


class LLMBadRequestError(LLMError):
    """请求非法（HTTP 400/422：参数错误/上下文超长等），确定性失败。"""

    default_message = "LLM 请求被拒绝"


class LLMNotFoundError(LLMError):
    """资源不存在（HTTP 404：模型名错误等），确定性失败。"""

    default_message = "LLM 模型不存在"


class LLMConfigError(LLMError):
    """LLM 配置/输入非法（未知适配器/缺字段/工具 schema 无法转换）。"""

    default_message = "LLM 配置非法"


class LLMFormatError(LLMError):
    """响应格式非法（非预期 JSON 结构，无法解析出 choices 等）。"""

    default_message = "LLM 响应格式非法"


class LLMUnknownError(LLMError):
    """未分类失败（非 httpx 异常/状态码/关键词均不命中，兜底包装）。"""

    default_message = "LLM 未知错误"


def _status_code_by_keywords(detail: str | None) -> type[LLMError] | None:
    """按上游错误正文关键词判定瞬时错误类型（无状态码可依的兜底）。"""
    if not detail:
        return None
    lowered = detail.lower()
    for keywords, class_name in _TRANSIENT_KEYWORDS:
        if any(keyword in lowered for keyword in keywords):
            return globals()[class_name]
    return None


def classify_llm_error(
    status_code: int | None = None,
    *,
    detail: str | None = None,
    exc: BaseException | None = None,
) -> LLMError:
    """把 HTTP 状态码 / 传输异常 / 上游正文关键词分类为语义化 LLMError。

    Args:
        status_code: 上游 HTTP 状态码（无则 None）。
        detail: 上游错误消息（构造时统一规范化：剥离控制字符/截断/遮蔽）。
        exc: 原始异常（httpx 传输异常优先按异常类型判定）。

    Returns:
        分类后的 LLMError 实例（携带实际 status_code，宿主可对齐判定）。
    """
    if exc is not None:
        name = exc.__class__.__name__
        # httpx 超时族（ConnectTimeout/ReadTimeout/WriteTimeout/PoolTimeout/
        # 任何 *Timeout）→ 超时；内置 TimeoutError 同语义
        if isinstance(exc, TimeoutError) or name.endswith("Timeout"):
            return LLMTimeoutError(detail=detail)
        # httpx 网络族（连接失败/协议错误/流中断）→ 网络
        if name in (
            "ConnectError",
            "RemoteProtocolError",
            "ReadError",
            "StreamError",
            "BrokenStreamError",
            "TransportError",
            "NetworkError",
            "HTTPError",
            "RequestError",
        ):
            return LLMNetworkError(detail=detail)
        return LLMUnknownError(detail=str(exc))

    if status_code is None:
        cls = _status_code_by_keywords(detail)
        return cls(detail=detail) if cls is not None else LLMUnknownError(detail=detail)

    if status_code == 408:
        return LLMTimeoutError(detail=detail, status_code=status_code)
    if status_code == 429 or status_code == 402:
        return LLMRateLimitError(detail=detail, status_code=status_code)
    if status_code == 401 or status_code == 403:
        return LLMAuthError(detail=detail, status_code=status_code)
    if status_code == 404:
        return LLMNotFoundError(detail=detail, status_code=status_code)
    if status_code == 400 or status_code == 422:
        return LLMBadRequestError(detail=detail, status_code=status_code)
    if 500 <= status_code <= 599:
        return LLMServerError(detail=detail, status_code=status_code)
    return LLMUnknownError(detail=detail, status_code=status_code)


def is_transient_llm_error(exc: BaseException) -> bool:
    """瞬时故障判定（重试/备用切换共用）：超时/限流/网络/5xx/空流。"""
    return isinstance(
        exc,
        (LLMTimeoutError, LLMRateLimitError, LLMNetworkError, LLMServerError, LLMEmptyStreamError),
    )


__all__ = [
    "LLMAuthError",
    "LLMBadRequestError",
    "LLMConfigError",
    "LLMEmptyStreamError",
    "LLMError",
    "LLMFormatError",
    "LLMNetworkError",
    "LLMNotFoundError",
    "LLMRateLimitError",
    "LLMServerError",
    "LLMTimeoutError",
    "LLMUnknownError",
    "classify_llm_error",
    "is_transient_llm_error",
]

"""挡位级模型链：主模型 + 备用列表 + 指数退避重试 + 流式中断语义。

吸收 text_forge_backend/core/llm_retry 语义（引擎自包含，宿主不再重复实现）：

- **重试（指数退避）**：仅瞬时故障（超时/限流/网络/5xx/空流）重试，
  确定性失败（认证/请求非法/模型不存在）直接上抛；流式仅「首块前」
  重试——已产出内容后的中断重试会破坏流式语义（重复内容）；
- **备用切换（fallback 链）**：当前模型重试耗尽后仍失败 → 切下一个配置
  重新带完整重试预算（首次块前失败的流式调用同样切换）；已产出内容后
  失败不切换（防重复内容），直接上抛；链全部失败抛最后一次错误；
  **认证失败（401/403，fail-closed）不切备用**——主模型密钥失效/吊销
  时立即上抛 + ERROR 级可告警日志，防同一份数据被静默转发到其它端点、
  防凭据事件被掩盖（其余确定性失败如模型不存在仍切备用——配置兜底）；
- **取消语义**：CancelledError 属 BaseException 不被捕获，原样穿透——
  适配器在退出路径关闭上游连接（客户端中断 → 终止上游请求）。

配置形态（主配置 + 备用列表）：主模型 LLMConfig 在前，
fallback 链为其后的 LLMConfig 列表，层级调用方（挡位装配）负责
把 main_config + main_fallback_configs 组装为 configs 传入。
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ink_engine.core.llm.base import AsyncLLM, LLMChunk, LLMConfig, LLMParams, LLMResult
from ink_engine.core.llm.errors import (
    LLMAuthError,
    LLMConfigError,
    LLMError,
    is_transient_llm_error,
)
from ink_engine.core.llm.messages import Message
from ink_engine.core.llm.registry import create_llm
from ink_engine.core.llm.tools import ToolSpec

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """重试策略（每次调用，与备用切换叠加）。"""

    attempts: int = 3
    base_delay: float = 1.0
    max_delay: float = 10.0


def _backoff_delay(policy: RetryPolicy, n: int) -> float:
    """第 n 次重试前的退避秒数（n 从 1 起：base_delay * 2^(n-1)，封顶）。"""
    return min(policy.base_delay * (2 ** (n - 1)), policy.max_delay)


class ModelChain:
    """主模型 + 备用模型链（挡位级容错：重试 → 备用 → 上抛）。"""

    def __init__(
        self,
        configs: Sequence[LLMConfig | Mapping[str, Any]],
        *,
        retry: RetryPolicy | None = None,
        create: Callable[[LLMConfig], AsyncLLM] | None = None,
    ) -> None:
        if not configs:
            raise LLMConfigError("ModelChain 至少需要一个模型配置")
        self._configs: list[LLMConfig] = [
            cfg if isinstance(cfg, LLMConfig) else LLMConfig.from_dict(cfg) for cfg in configs
        ]
        self._retry = retry or RetryPolicy()
        self._create = create or create_llm
        self._llms: list[AsyncLLM | None] = [None] * len(self._configs)

    # ------------------------------------------------------------------
    # 模型实例（惰性构建：链上备用模型只在需要时创建）
    # ------------------------------------------------------------------
    def _llm(self, index: int) -> AsyncLLM:
        llm = self._llms[index]
        if llm is None:
            llm = self._llms[index] = self._create(self._configs[index])
        return llm

    async def aclose(self) -> None:
        """释放链上已创建的模型实例（长连接 client 等），幂等。"""
        for i, llm in enumerate(self._llms):
            if llm is None:
                continue
            try:
                await llm.aclose()
            except Exception as exc:  # 释放失败不阻断其余实例
                logger.warning(f"[ModelChain] 关闭模型[{i}] {self._configs[i].model_id} 失败: {exc}")
            self._llms[i] = None

    # ------------------------------------------------------------------
    # 非流式：重试（瞬时）→ 备用切换 → 上抛
    # ------------------------------------------------------------------
    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        last_error: LLMError | None = None
        for i in range(len(self._configs)):
            try:
                return await self._ainvoke_one(i, messages, tools=tools, params=params)
            except LLMAuthError:
                # fail-closed：认证失败不切备用（密钥失效/吊销应立即可见，不静默转发数据）
                logger.error(f"[ModelChain] 模型[{i}] {self._configs[i].model_id} 认证失败，不切换备用（fail-closed）")
                raise
            except LLMError as exc:
                last_error = exc
                if i + 1 < len(self._configs):
                    logger.warning(
                        f"[ModelChain] 模型[{i}] {self._configs[i].model_id} 调用失败（{exc}），切换备用模型"
                    )
        assert last_error is not None
        raise last_error

    async def _ainvoke_one(
        self,
        index: int,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
    ) -> LLMResult:
        attempts = max(1, self._retry.attempts)
        for n in range(attempts):
            try:
                return await self._llm(index).ainvoke(messages, tools=tools, params=params)
            except LLMError as exc:
                if not is_transient_llm_error(exc) or n == attempts - 1:
                    raise
                delay = _backoff_delay(self._retry, n + 1)
                logger.warning(
                    f"[ModelChain] 模型[{index}] 瞬时故障（{exc}），{delay:.1f}s 后重试（{n + 1}/{attempts - 1}）"
                )
                await asyncio.sleep(delay)

    # ------------------------------------------------------------------
    # 流式：单模型首块前重试；首块前失败切备用；产出后失败不切换
    # ------------------------------------------------------------------
    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        last_error: LLMError | None = None
        for i in range(len(self._configs)):
            got_chunk = False
            try:
                async for chunk in self._astream_one(i, messages, tools=tools, params=params):
                    got_chunk = True
                    yield chunk
                return
            except LLMAuthError:
                # fail-closed：认证失败不切备用（与 ainvoke 同语义）
                logger.error(f"[ModelChain] 模型[{i}] {self._configs[i].model_id} 认证失败，不切换备用（fail-closed）")
                raise
            except LLMError as exc:
                last_error = exc
                if got_chunk:
                    # 已产出内容后失败：切换会产生重复内容，直接上抛
                    raise
                if i + 1 < len(self._configs):
                    logger.warning(
                        f"[ModelChain] 模型[{i}] {self._configs[i].model_id} 首块前失败（{exc}），切换备用模型"
                    )
        assert last_error is not None
        raise last_error

    async def _astream_one(
        self,
        index: int,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
    ) -> AsyncIterator[LLMChunk]:
        attempts = max(1, self._retry.attempts)
        for n in range(attempts):
            got_chunk = False
            try:
                async for chunk in self._llm(index).astream(messages, tools=tools, params=params):
                    got_chunk = True
                    yield chunk
                return
            except LLMError as exc:
                if got_chunk or not is_transient_llm_error(exc) or n == attempts - 1:
                    raise
                delay = _backoff_delay(self._retry, n + 1)
                logger.warning(
                    f"[ModelChain] 模型[{index}] 首块前瞬时故障（{exc}），{delay:.1f}s 后重试（{n + 1}/{attempts - 1}）"
                )
                await asyncio.sleep(delay)


__all__ = ["ModelChain", "RetryPolicy"]

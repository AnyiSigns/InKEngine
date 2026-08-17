"""fan_out 并行原语（发散并发，替代 asyncio.gather 裸用）。

语义（开放问题已定：部分失败剔除）：并行执行任务（asyncio.Semaphore 限流），
失败任务剔除、成功结果入候选集——v3 T4 发散容错在引擎层统一。
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from .logging import get_logger

logger = get_logger(__name__)

T = TypeVar("T")

# 哨兵：区分「任务未成功（剔除）」与「任务合法返回 None」（None 是有效结果，
# 成功集保持输入下标对齐；直接按 None 过滤会静默吞掉合法 None 返回值）
_UNSET = object()


@dataclass(frozen=True, slots=True)
class FanOutFailure:
    """单任务失败信息（剔除原因留痕，候选卡注明）。"""

    index: int
    error: str


@dataclass(slots=True)
class FanOutResult:
    """发散结果：成功值按输入顺序 + 失败剔除清单。"""

    successes: list[Any] = field(default_factory=list)
    failures: list[FanOutFailure] = field(default_factory=list)

    @property
    def all_succeeded(self) -> bool:
        return not self.failures


async def fan_out(
    tasks: list[Callable[[int], Awaitable[T]]],
    limit: int,
) -> FanOutResult:
    """并发执行任务列表，部分失败剔除（gather(return_exceptions=True) 语义）。

    Args:
        tasks: 任务工厂列表，每项接收自身索引（变体编号注入）。
        limit: 并发上限（成本护栏，发散候选 ≤5 等由业务侧传参）。

    Returns:
        FanOutResult：successes 保持输入顺序，failures 含剔除原因。
    """
    if limit <= 0:
        raise ValueError(f"fan_out 并发上限必须为正: {limit}")
    if not tasks:
        return FanOutResult()
    semaphore = asyncio.Semaphore(limit)
    successes: list[Any] = [_UNSET] * len(tasks)
    failures: list[FanOutFailure] = []

    async def _run_one(index: int, factory: Callable[[int], Awaitable[T]]) -> None:
        async with semaphore:
            try:
                successes[index] = await factory(index)
            except Exception as exc:  # 部分失败剔除：记录原因不中断并行
                failures.append(FanOutFailure(index=index, error=str(exc)))
                logger.warning(f"fan_out 任务[{index}]失败，剔除: {exc}")

    await asyncio.gather(*(_run_one(i, t) for i, t in enumerate(tasks)))
    return FanOutResult(
        successes=[s for s in successes if s is not _UNSET],
        failures=sorted(failures, key=lambda f: f.index),
    )


__all__ = ["FanOutFailure", "FanOutResult", "fan_out"]

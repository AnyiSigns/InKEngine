"""fan_out 并行原语（并发执行，替代 asyncio.gather 裸用）。

语义（部分失败剔除）：并行执行任务（asyncio.Semaphore 限流），
普通失败（Exception）剔除、成功结果保留，并行容错在引擎层统一。
控制流异常（propagate 指定的 BaseException 子类，如中断信号）不做
剔除而是传播：传播时取消全部未完成兄弟任务后上抛——防止父流程已
收尾、兄弟任务仍留在后台写链/写事件的泄漏与存储竞态。
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
    """单任务失败信息（剔除原因留痕，供消费方展示）。"""

    index: int
    error: str


@dataclass(slots=True)
class FanOutResult:
    """并行结果：成功值按输入顺序 + 失败剔除清单。"""

    successes: list[Any] = field(default_factory=list)
    failures: list[FanOutFailure] = field(default_factory=list)
    success_indices: list[int] = field(default_factory=list)

    @property
    def all_succeeded(self) -> bool:
        return not self.failures


async def fan_out(
    tasks: list[Callable[[int], Awaitable[T]]],
    limit: int,
    *,
    propagate: type[BaseException] | tuple[type[BaseException], ...] = (),
) -> FanOutResult:
    """并发执行任务列表，部分失败剔除（gather(return_exceptions=True) 语义）。

    Args:
        tasks: 任务工厂列表，每项接收自身索引（并行项编号注入）。
        limit: 并发上限（成本护栏，由业务侧传参）。
        propagate: 不做剔除、直接传播的控制流异常类型（默认无）。
            传播时取消全部未完成兄弟任务后上抛（防兄弟任务泄漏）。

    Returns:
        FanOutResult：successes 保持输入顺序，success_indices 与 successes
        对齐记录原始下标（失败剔除后仍可定位来源），failures 含剔除原因。
    """
    if limit <= 0:
        raise ValueError(f"fan_out 并发上限必须为正: {limit}")
    if not tasks:
        return FanOutResult()
    propagate_types = (propagate,) if isinstance(propagate, type) else tuple(propagate)
    semaphore = asyncio.Semaphore(limit)
    successes: list[Any] = [_UNSET] * len(tasks)
    failures: list[FanOutFailure] = []

    async def _run_one(index: int, factory: Callable[[int], Awaitable[T]]) -> None:
        async with semaphore:
            try:
                successes[index] = await factory(index)
            except propagate_types:
                raise
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # 部分失败剔除：记录原因不中断并行
                failures.append(FanOutFailure(index=index, error=str(exc)))
                logger.warning(f"fan_out 任务[{index}]失败，剔除: {exc}")

    wrapped = [asyncio.create_task(_run_one(i, t)) for i, t in enumerate(tasks)]
    try:
        await asyncio.gather(*wrapped)
    except BaseException:
        # 控制流异常（InterruptSignal 等）传播：gather 不取消其余兄弟，
        # 显式取消未完成任务防泄漏（普通失败已由 _run_one 内部消化，不至此）
        for task in wrapped:
            if not task.done():
                task.cancel()
        await asyncio.gather(*wrapped, return_exceptions=True)
        raise
    # 独立哨兵区分「任务未成功（剔除）」与「任务成功合法返回 None」：
    # _UNSET 仅标记未成功（失败/未跑），成功值（含 None）一律保留并维持
    # success_indices 与 successes 对齐（与 docstring「None 是合法结果」一致）
    result_successes: list[Any] = []
    result_indices: list[int] = []
    for index, value in enumerate(successes):
        if value is _UNSET:
            continue
        result_successes.append(value)
        result_indices.append(index)
    return FanOutResult(
        successes=result_successes,
        failures=sorted(failures, key=lambda f: f.index),
        success_indices=result_indices,
    )


__all__ = ["FanOutFailure", "FanOutResult", "fan_out"]

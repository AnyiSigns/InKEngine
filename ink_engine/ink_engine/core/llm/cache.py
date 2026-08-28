"""LLM 调用缓存包装器（AsyncLLM 协议；Storage records 通道持久化）。

用途：同一「问句集合 + 工具表 + 模型」的重复调用直接复用上次结果
（路由决策/批处理重试等高频同参场景省 token 与延迟；非确定性对话
场景由宿主决定是否挂缓存）。

设计要点：
- **协议形态**：实现 AsyncLLM（与 ``fallback.ModelChain`` 同族包装），
  宿主在模型链外层套一层即可（``CachingLLM(ModelChain(...), storage=...)``）；
- **指纹**：hash(messages + tools + model + tier + params)——messages 取
  ``to_openai_dict`` 形态（不含自动生成的 id，重构造消息指纹稳定）；
  params 纳入指纹（温度/最大长度改变生成分布，同请求缓存不同参数
  会得到错误的结果，宁可多 miss）；
- **持久化**：走 Storage records 通道（collection 名 ``llm_cache``，
  记录 fingerprint/response/tier/created_at/patch_version 五字段），
  随集导出自然满足（导出 = 复制 records 集；无独立导出路径）；
- **失效**：记录携带 ``patch_version``（外部版本提供者或本地失效代
   际），读取时与当前版本比对，不一致 = 视为 miss（逻辑清空）；
   ``clear()`` 经 Storage.delete_collection 物理删除落库记录并归零计数
   （记录留库有界性仍由 TTL 出局兜底）；
- **TTL**：默认 ``DEFAULT_CACHE_TTL``（24h，常量）；``clock`` 可注入
  （测试用假时钟，配 `ttl=0` 恒过期）；
- **流式不缓存**：ainvoke 缓存命中复用上次完整结果；astream 直通
  （首块延迟是流式的核心语义，缓存收集会破坏流式前进步履）。
"""
from __future__ import annotations

import hashlib
import inspect
import json
import time
from collections.abc import AsyncIterator, Callable, Sequence
from typing import Any

from ink_engine.core.logging import get_logger
from ink_engine.core.storage import Storage

from .base import AsyncLLM, LLMChunk, LLMConfig, LLMParams, LLMResult
from .messages import Message, ToolCall
from .tools import ToolSpec, to_openai_tools

logger = get_logger(__name__)

# 默认 TTL：24 小时（秒，常量——缓存命中与出局的节奏参数）
DEFAULT_CACHE_TTL = 24 * 3600.0

# 缓存记录的集合名（Storage records 通道；随集导出/落库同通道）
CACHE_COLLECTION = "llm_cache"

# 版本提供者签名：() -> 可比较的版本值（int/str/None；None = 不校验）
PatchVersionProvider = Callable[[], int | str | None]


def _result_to_dict(result: LLMResult) -> dict[str, Any]:
    """LLMResult → 记录负载（JSON 形态；ToolCall 与 Message 同款内联）。"""
    return {
        "content": result.content,
        "reasoning": result.reasoning,
        "tool_calls": (
            [
                {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                for tc in result.tool_calls
            ]
            if result.tool_calls
            else None
        ),
        "finish_reason": result.finish_reason,
        "usage": result.usage,
    }


def _result_from_dict(data: dict[str, Any]) -> LLMResult:
    """记录负载 → LLMResult（与 to_dict 往返精确还原）。"""
    calls = data.get("tool_calls")
    return LLMResult(
        content=data.get("content") or "",
        reasoning=data.get("reasoning"),
        tool_calls=(
            [
                ToolCall(
                    id=c["id"], name=c["name"], arguments=c.get("arguments") or ""
                )
                for c in calls
            ]
            if calls
            else None
        ),
        finish_reason=data.get("finish_reason"),
        usage=data.get("usage"),
    )


def _inner_model_label(inner: AsyncLLM) -> str:
    """被包装对象的模型标签（指纹 model 分量）。

    适配器（AsyncLLM 子类）持 ``config.model_id``；组合包装（如
    ModelChain）无 config，取链首模型的标签——链配置变化由宿主层
    重建包装器（包装器生命周期 = 配置生命周期），陈旧标签随引用
    一起失效。
    """
    config = getattr(inner, "config", None)
    model_id = getattr(config, "model_id", None)
    if model_id:
        return str(model_id)
    configs = getattr(inner, "configs", None)
    if configs:
        first = getattr(configs[0], "model_id", None)
        if first:
            return str(first)
    return "unknown"


class CachingLLM(AsyncLLM):
    """LLM 调用缓存包装器（内层任意外部模型/链；缓存失效经版本比对）。"""

    adapter = "cache"

    def __init__(
        self,
        inner: AsyncLLM,
        *,
        storage: Storage | None = None,
        ttl: float = DEFAULT_CACHE_TTL,
        tier: str = "",
        patch_version: PatchVersionProvider | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        """包装内层模型。

        Args:
            inner: 被包装的模型/模型链（AsyncLLM 协议）。
            storage: 缓存记录后端（None = 直通不缓存——包装器可挂任意
                地方而不改变语义）。
            ttl: 记录保质期（秒；0 = 恒过期，仅诊断用途）。
            tier: 挡位标签（随记录落库，审计/命中率按挡位统计用）。
            patch_version: 版本提供者（补丁链等外部版本源；返回值随
                记录落库、读取时比对——版本变了 = 缓存失效）。
            clock: 时钟注入（测试用假时钟推进 TTL；默认 time.time）。
        """
        if ttl < 0:
            raise ValueError(f"TTL 不能为负: {ttl}")
        self._inner = inner
        self._model_label = _inner_model_label(inner)
        super().__init__(
            LLMConfig(
                adapter="cache",
                model_id=self._model_label,
                # 占位根地址：缓存包装器不发网络调用，config 仅是协议形态
                base_url="http://cache.local",
            )
        )
        self._storage = storage
        self._ttl = ttl
        self._tier = tier
        self._patch_version_provider = patch_version
        self._clock = clock
        # 本地失效代际：无外部版本提供者时作为记录的 patch_version 语义
        self._epoch = 0
        # 命中率统计计数（进程内累计；stats() 导出、clear() 重置）
        self._hits = 0
        self._misses = 0

    # ── 失效与版本 ──

    def invalidate(self) -> None:
        """显式失效（建议挂到补丁链 ``PatchChain.on_change``）。

        版本没变过的东西不必清：代际 +1 使既有记录（旧代际）全部
        视为 miss；有外部版本提供者时（宿主以链版本为准），失效
        语义由提供者返回值驱动，本代际只作兜底。
        """
        self._epoch += 1

    async def _patch_version(self) -> int | str:
        """当前版本标识（外部提供者优先，缺省 = 本地代际）。"""
        provider = self._patch_version_provider
        if provider is None:
            return self._epoch
        value = provider()
        if inspect.isawaitable(value):
            value = await value
        return value

    # ── 指纹 ──

    def _fingerprint(
        self,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec] | None,
        params: LLMParams | None,
    ) -> str:
        payload: dict[str, Any] = {
            "messages": [m.to_openai_dict() for m in messages],
            "tools": to_openai_tools(tools) if tools else None,
            "model": self._model_label,
            "tier": self._tier,
        }
        if params is not None:
            payload["params"] = {
                key: value
                for key, value in (
                    ("temperature", params.temperature),
                    ("max_tokens", params.max_tokens),
                    ("extra_body", params.extra_body),
                )
                if value is not None
            }
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    # ── 缓存读写 ──

    async def _get_cached(
        self, fingerprint: str, patch_version: int | str
    ) -> LLMResult | None:
        if self._storage is None:
            return None
        try:
            record = await self._storage.get_record(CACHE_COLLECTION, fingerprint)
        except Exception as exc:
            # 缓存读取失败不影响调用：缓存是增强不是依赖（留痕即可）
            logger.warning("LLM 缓存读取失败（按 miss 处理）: %s", exc)
            return None
        if record is None:
            return None
        if str(record.get("patch_version")) != str(patch_version):
            return None  # 版本变化（补丁链演化等）→ 逻辑失效
        created = float(record.get("created_at") or 0)
        if self._clock() - created > self._ttl:
            return None  # 超出保质期
        return _result_from_dict(record.get("response") or {})

    async def _store(
        self, fingerprint: str, result: LLMResult, patch_version: int | str
    ) -> None:
        if self._storage is None:
            return
        data = {
            "fingerprint": fingerprint,
            "response": _result_to_dict(result),
            "tier": self._tier,
            "created_at": self._clock(),
            "patch_version": str(patch_version),
        }
        try:
            await self._storage.put_record(CACHE_COLLECTION, fingerprint, data)
        except Exception as exc:
            # 缓存写入失败不影响调用结果（留痕即可）
            logger.warning("LLM 缓存写入失败（忽略，不影响调用）: %s", exc)

    # ── AsyncLLM 协议 ──

    async def ainvoke(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> LLMResult:
        patch_version = await self._patch_version()
        fingerprint = self._fingerprint(messages, tools, params)
        cached = await self._get_cached(fingerprint, patch_version)
        if cached is not None:
            self._hits += 1
            logger.info(
                "LLM 缓存命中: model=%s tier=%s", self._model_label, self._tier
            )
            return cached
        self._misses += 1
        result = await self._inner.ainvoke(messages, tools=tools, params=params)
        await self._store(fingerprint, result, patch_version)
        return result

    # ── 统计与清理（命中率导出 + 缓存清空）──

    async def stats(self) -> dict[str, Any]:
        """缓存统计：条目量 + 命中/未命中计数 + 命中率。

        条目量经存储后端实时读取（缺存储 = 0）；命中率 = hits/(hits+misses)
        （无调用 = 0.0）。计数为进程内累计，与存储条目量口径不同（计数
        含历史已失效记录，条目量仅当前有效）。
        """
        entries = 0
        if self._storage is not None:
            try:
                records = await self._storage.list_records(CACHE_COLLECTION)
                entries = len(records)
            except Exception as exc:
                logger.warning("LLM 缓存条目量读取失败: %s", exc)
                entries = 0
        denom = self._hits + self._misses
        hit_rate = (self._hits / denom) if denom > 0 else 0.0
        return {
            "entries": entries,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": hit_rate,
        }

    async def clear(self) -> int:
        """清空缓存：删除全部落库记录并重置命中计数，返回删除条数。

        计数归零与记录清理一致（缓存语义整体清零）；无存储 = 仅计数归零、
        返回 0。清库失败不阻断（留痕即可），计数仍归零。
        """
        count = 0
        if self._storage is not None:
            try:
                count = await self._storage.delete_collection(CACHE_COLLECTION)
            except Exception as exc:
                logger.warning("LLM 缓存清空失败（计数仍归零）: %s", exc)
        self._hits = 0
        self._misses = 0
        return int(count or 0)

    async def astream(
        self,
        messages: Sequence[Message],
        *,
        tools: Sequence[ToolSpec] | None = None,
        params: LLMParams | None = None,
    ) -> AsyncIterator[LLMChunk]:
        """流式直通（不缓存）：缓存化要求收集完整流才能复用——首块
        延迟与流式前进步履是流式语义本身，此路径无可缓存性"""
        async for chunk in self._inner.astream(messages, tools=tools, params=params):
            yield chunk

    async def aclose(self) -> None:
        await self._inner.aclose()


__all__ = [
    "CACHE_COLLECTION",
    "DEFAULT_CACHE_TTL",
    "CachingLLM",
]

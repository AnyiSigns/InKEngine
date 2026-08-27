"""Embedding 接口（AsyncEmbedder + OpenAI 兼容适配器 + 注册工厂）。

文本向量化是语义检索与记忆召回的前置步骤。引擎此前缺少这一接口，宿主
只能借道第三方库创建 embedding 客户端。这里把 embedding 收敛为与 AsyncLLM
同构的统一接口：适配器实现 AsyncEmbedder 并注册到注册表，配置驱动选择，
失败统一抛 LLMError 子类（与聊天补全的错误分类一致）。

OpenAI 兼容适配器覆盖 openai / deepseek / dashscope 兼容端点 / ollama /
zhipu / moonshot 等共用 /embeddings 协议的厂商；其余厂商接口形态差异较大，
由宿主在注册表中挂自定义适配器承接。
"""
from __future__ import annotations

import abc
import asyncio
import contextlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from ink_engine.core.llm.errors import LLMConfigError, LLMError, classify_llm_error
from ink_engine.core.llm.fallback import _backoff_delay, is_transient_llm_error

# embedding 调用重试（ENG4-S4）：瞬时故障最多 3 次指数退避；非瞬时
# 故障（认证失败/参数非法）一次性失败不上抬。
_EMBEDDING_RETRY_ATTEMPTS = 3

# 配置白名单键（模型配置形态兼容，未知键收进 extra 透传不破坏）。
_CONFIG_KEYS = (
    "adapter",
    "model_id",
    "base_url",
    "api_key",
    "request_timeout",
)


@dataclass(frozen=True, slots=True)
class EmbeddingConfig:
    """单个 embedding 接入配置（主模型与备用模型共用同一形态）。

    Args:
        adapter: 适配器注册名（openai_compat 等，见注册表）。
        model_id: 模型标识（如 text-embedding-3-small）。
        base_url: API 根地址（如 https://api.openai.com/v1）。
        api_key: 调用密钥（可空——本地/免鉴权端点）。
        request_timeout: 单请求超时秒数（None = 适配器默认）。
        extra: 厂商扩展字段（透传不校验，适配器按需消费，如 dimensions）。
    """

    adapter: str
    model_id: str
    base_url: str
    # 安全：api_key 不参与 repr（与 LLMConfig 同口径，防日志/异常消息泄漏凭据）
    api_key: str | None = field(default=None, repr=False)
    request_timeout: float | None = None
    extra: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> EmbeddingConfig:
        """从配置字典构建（模型配置形态兼容，未知键收进 extra）。

        Raises:
            LLMConfigError: adapter/model_id/base_url 缺失时。
        """
        for key in ("adapter", "model_id", "base_url"):
            if not data.get(key):
                raise LLMConfigError(f"Embedding 配置缺少必填字段: {key}")
        extra = {k: v for k, v in data.items() if k not in _CONFIG_KEYS}
        d = {key: data.get(key) for key in _CONFIG_KEYS}
        return cls(**d, extra=extra or None)

    def __post_init__(self) -> None:
        # 引擎层强制 http/https scheme（SSRF 面）：私有地址 allowlist 属宿主责任
        scheme = urlparse(self.base_url).scheme
        if scheme not in ("http", "https"):
            raise ValueError(
                f"EmbeddingConfig.base_url 必须使用 http/https 协议（非法 scheme={scheme!r}）"
            )


class AsyncEmbedder(abc.ABC):
    """统一 embedding 接口：适配器实现本类并注册到注册表。

    约定：
    - aembed_query: 单条文本 → 向量；
    - aembed_documents: 文本列表 → 向量列表（按输入顺序）；
    - 失败一律抛 LLMError 子类（classify_llm_error 分类），
      CancelledError 原样透传（取消语义，上游请求由适配器终止）。
    """

    adapter: str = ""

    def __init__(self, config: EmbeddingConfig) -> None:
        self.config = config

    @abc.abstractmethod
    async def aembed_query(self, text: str) -> list[float]:
        """把单条文本编码为向量。"""

    @abc.abstractmethod
    async def aembed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """把文本列表批量编码为向量（顺序与输入一致）。"""


DEFAULT_REQUEST_TIMEOUT = 60.0


class OpenAICompatibleEmbedder(AsyncEmbedder):
    """OpenAI 兼容 embedding 适配器（/embeddings，零第三方 SDK 依赖）。

    覆盖 OpenAI/DeepSeek/DashScope 兼容端点/Zhipu/Moonshot/Ollama 等共用
    OpenAI embeddings 协议的厂商；行为约定与聊天补全适配器对齐：传输异常 /
    HTTP 状态码统一经 classify_llm_error 分类抛 LLMError，取消语义在退出路径
    显式 aclose——上游请求终止，不悬挂连接。
    """

    adapter = "openai_compat"

    def __init__(
        self,
        config: EmbeddingConfig,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(config)
        self._transport = transport  # 测试注入（MockTransport）；None = 生产默认
        self._client: httpx.AsyncClient | None = None  # 惰性长生命周期 client（连接池复用）

    @property
    def _endpoint(self) -> str:
        return self.config.base_url.rstrip("/") + "/embeddings"

    def _timeout(self) -> httpx.Timeout:
        return httpx.Timeout(self.config.request_timeout or DEFAULT_REQUEST_TIMEOUT)

    def _get_client(self) -> httpx.AsyncClient:
        """惰性构建长生命周期 client：连接池跨调用复用（TCP/TLS 免重复握手）。"""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout(), transport=self._transport)
        return self._client

    async def aclose(self) -> None:
        """释放长连接 client（幂等；关闭后再次调用会重建）。"""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        return headers

    # extra 透传白名单：仅厂商扩展字段可进请求体；model/input 等核心键
    # 禁止被配置覆盖（覆盖会静默错配：向量与文本不对应 → 记忆库污染）
    _EXTRA_ALLOWED_KEYS = ("dimensions", "encoding_format", "user")

    def _payload(self, inputs: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": self.config.model_id, "input": inputs}
        if self.config.extra:
            for key, value in self.config.extra.items():
                if key in self._EXTRA_ALLOWED_KEYS:
                    payload[key] = value
        return payload

    @staticmethod
    def _error_detail(body: bytes) -> str | None:
        try:
            obj = json.loads(body.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return None
        error = obj.get("error") if isinstance(obj, dict) else None
        if isinstance(error, dict):
            return error.get("message") or str(error)
        if isinstance(error, str):
            return error
        return None

    async def _post(self, inputs: Any) -> list[dict[str, Any]]:
        client = self._get_client()
        last_error: LLMError | None = None
        for attempt in range(_EMBEDDING_RETRY_ATTEMPTS):
            try:
                response = await client.post(
                    self._endpoint, json=self._payload(inputs), headers=self._headers()
                )
            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPError) as exc:
                last_error = classify_llm_error(exc=exc)
                if not is_transient_llm_error(last_error) or attempt == _EMBEDDING_RETRY_ATTEMPTS - 1:
                    raise last_error from exc
                await asyncio.sleep(_backoff_delay(None, attempt + 1))
                continue
            if response.status_code >= 400:
                body = b""
                with contextlib.suppress(Exception):
                    body = await response.aread()
                last_error = classify_llm_error(response.status_code, detail=self._error_detail(body))
                if not is_transient_llm_error(last_error) or attempt == _EMBEDDING_RETRY_ATTEMPTS - 1:
                    raise last_error
                await asyncio.sleep(_backoff_delay(None, attempt + 1))
                continue
            try:
                obj = response.json()
            except json.JSONDecodeError as exc:
                raise LLMError(detail=f"embedding 非 JSON 响应: {exc}") from exc
            if not isinstance(obj, dict):
                raise LLMError(detail="embedding 响应非对象")
            data = obj.get("data")
            if not isinstance(data, list) or not data:
                raise LLMError(detail=f"embedding 响应缺 data: {str(obj)[:200]}")
            return data
        # 循环正常退出（理论不可达，兜底防御）
        assert last_error is not None
        raise last_error

    @staticmethod
    def _coerce(vector: Any) -> list[float]:
        if not isinstance(vector, list):
            raise LLMError(detail="embedding 响应缺 embedding 向量")
        return [float(x) for x in vector]

    async def aembed_query(self, text: str) -> list[float]:
        data = await self._post(text)
        first = data[0] if isinstance(data[0], dict) else {}
        return self._coerce(first.get("embedding"))

    async def aembed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        data = await self._post(list(texts))
        ordered = sorted(
            (d for d in data if isinstance(d, dict)),
            key=lambda d: d.get("index", 0),
        )
        return [self._coerce(d.get("embedding")) for d in ordered]


_EMBEDDING_REGISTRY: dict[str, type[AsyncEmbedder]] = {}
_BUILTINS_REGISTERED = False

# OpenAI 兼容厂商别名 → 内置适配器（注册表按需扩容，未知厂商显式报错）。
_OPENAI_COMPAT_ALIASES = ("openai_compat", "openai", "deepseek", "dashscope", "ollama", "zhipu", "moonshot")


def register_embedder(name: str, cls: type[AsyncEmbedder]) -> None:
    """注册 embedding 适配器类（可覆盖同名——宿主可换掉内置实现）。

    入口先注册内置（setdefault 不覆盖宿主注册）：宿主先于内置注册的
    同名适配器不被惰性内置注册静默覆盖。
    """
    if not name:
        raise LLMConfigError("embedding 适配器注册名不能为空")
    _ensure_builtins()
    _EMBEDDING_REGISTRY[name] = cls


def _ensure_builtins() -> None:
    """惰性注册内置适配器（首次访问注册表面时执行，防 import 即要求 httpx）。

    只补缺省名（setdefault）：宿主已注册的同名适配器保持生效。
    """
    global _BUILTINS_REGISTERED
    if _BUILTINS_REGISTERED:
        return
    for name in _OPENAI_COMPAT_ALIASES:
        _EMBEDDING_REGISTRY.setdefault(name, OpenAICompatibleEmbedder)
    _BUILTINS_REGISTERED = True


def embedder_names() -> list[str]:
    _ensure_builtins()
    return sorted(_EMBEDDING_REGISTRY)


def get_embedder_class(name: str) -> type[AsyncEmbedder] | None:
    _ensure_builtins()
    return _EMBEDDING_REGISTRY.get(name)


def create_embedder(config: EmbeddingConfig | Mapping[str, Any]) -> AsyncEmbedder:
    """按配置创建 embedding 实例（配置驱动选择适配器）。

    Args:
        config: EmbeddingConfig 或配置字典（dict 形态与模型配置兼容）。

    Raises:
        LLMConfigError: 适配器未注册 / 配置缺字段 / 缺 httpx 依赖时。
    """
    cfg = config if isinstance(config, EmbeddingConfig) else EmbeddingConfig.from_dict(config)
    _ensure_builtins()
    cls = _EMBEDDING_REGISTRY.get(cfg.adapter)
    if cls is None:
        raise LLMConfigError(
            f"未注册的 embedding 适配器: {cfg.adapter!r}（已注册: {', '.join(embedder_names()) or '无'}）"
        )
    return cls(cfg)


__all__ = [
    "AsyncEmbedder",
    "EmbeddingConfig",
    "OpenAICompatibleEmbedder",
    "create_embedder",
    "embedder_names",
    "get_embedder_class",
    "register_embedder",
]

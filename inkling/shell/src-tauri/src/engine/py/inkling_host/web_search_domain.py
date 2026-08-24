"""联网搜索执行体（web_search 端点的宿主侧接线）。

引擎零改动铁律下，搜索实现归壳侧 Rust 域（``domain/web_search.rs``：
本地聚合源免费无 key 默认 → 用户自配 Exa/parallel/bocha 任一 key
降级到厂商源 → 失败结构化可重试）；本模块是 Python 宿主侧的薄执行体：

- **回调委托**：经 JSON 回调桥调用 Rust 侧 ``host.web_search`` 回调
  （查询/限条/域名 → 结构化结果 JSON）；回调桥未装配（无壳环境）=
  结构化降级失败文本（不崩溃、不静默假装可用——与 OS 控制执行器
  未注册同语义）；
- **搜索 key**：用户自配厂商 key 从环境变量读取（``INK_SEARCH_KEY`` +
  ``INK_SEARCH_PROVIDER``，provider 取 exa/parallel/bocha 任一）；
  未配置 = 本地聚合源（免费无 key）；设置页配置位后续数据驱动接入；
- **域名过滤**：结果域名白名单过滤在实现内完成（allow_domains 空 =
  不限制；非空 = 越域结果丢弃），沙箱层不做本地域名判定（与 fetch
  的单 URL 出网语义不同）。
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable

_SEARCH_LIMIT_MIN = 1
_SEARCH_LIMIT_MAX = 20
_SEARCH_LIMIT_DEFAULT = 5


def _search_keys_from_env() -> dict[str, str]:
    """用户自配厂商 key（环境变量形态；provider 缺省 exa 优先序）。"""
    key = os.environ.get("INK_SEARCH_KEY", "").strip()
    if not key:
        return {}
    provider = os.environ.get("INK_SEARCH_PROVIDER", "exa").strip().lower()
    if provider not in ("exa", "parallel", "bocha"):
        provider = "exa"
    return {"search": {provider: key}}


def make_web_search_executor(
    *,
    callback: Callable[[str, dict[str, Any]], Any] | None = None,
) -> Callable[..., Any]:
    """web_search 端点执行体（宿主注册；回调可注入免真实出网）。

    默认回调 = 桥模块的 JSON 回调调用（``host.web_search``，Rust 域
    实现搜索）；注入回调供离线/测试环境使用。参数形态与 tools.json
    声明一致：query（必填）/ limit（1-20，缺省 5）/ domains（可选）。
    """

    async def execute(ctx: Any, definition: Any, args: dict, approval: Any) -> str:
        query = str(args.get("query") or "").strip()
        if not query:
            return json.dumps(
                {
                    "ok": False,
                    "status": "missing_query",
                    "error": "查询语句不能为空",
                },
                ensure_ascii=False,
            )
        try:
            limit = max(
                _SEARCH_LIMIT_MIN,
                min(_SEARCH_LIMIT_MAX, int(args.get("limit") or _SEARCH_LIMIT_DEFAULT)),
            )
        except (TypeError, ValueError):
            limit = _SEARCH_LIMIT_DEFAULT
        domains = [str(d) for d in (args.get("domains") or ()) if isinstance(d, str)]
        payload: dict[str, Any] = {
            "query": query,
            "limit": limit,
            "domains": domains,
        }
        keys = _search_keys_from_env()
        if keys:
            payload["keys"] = keys
        try:
            if callback is not None:
                result = callback("host.web_search", payload)
            else:
                from inkling_bridge import callback_host

                raw = callback_host().invoke(
                    "host.web_search", json.dumps(payload, ensure_ascii=False)
                )
                result = json.loads(raw)
        except (RuntimeError, ImportError) as exc:
            return json.dumps(
                {
                    "ok": False,
                    "status": "shell_unavailable",
                    "error": f"联网搜索执行体不可用（桌面壳未挂载）: {exc}",
                },
                ensure_ascii=False,
            )
        if not isinstance(result, dict):
            return json.dumps(
                {"ok": False, "status": "invalid_response", "error": "搜索执行体返回非法结果"},
                ensure_ascii=False,
            )
        return json.dumps(result, ensure_ascii=False)

    return execute


__all__ = ["make_web_search_executor"]

"""Forge 宿主：Host 五件套实现（存储工厂 / 模型解析 / 审批策略 / 传输工厂 / 关停钩子）。

宿主职责收拢处（实现不变，只从散落模块归位）：
- 存储工厂：进程锁 + SQLite 集目录引擎库（engine.py 现职，模块级
  ``_storage``/``_process_lock`` 访问契约保留——现有测试 patch 目标）；
- 模型解析：settings/secrets LLM 解析（ForgeApp.resolve_llm 现职，
  records 为唯一真相，未配置/解析失败 = None 由路由端引导）；
- 审批策略：默认全挂起 + 超时兜底（种子沉淀等宿主级审批卡用）；
- 传输工厂：SSE 队列桥（web 宿主每次 SSE 请求新建，非进程级单例）；
- 关停钩子：释放进程锁并复位引擎存储（Runtime.stop 的收尾顺序）。
"""
from __future__ import annotations

import logging
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.events import EngineTransport
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS
from ink_engine.core.storage import Storage

from . import engine as engine_store
from . import secrets as secrets_store
from .transport import QueueTransport

logger = logging.getLogger(__name__)


class ForgeHost:
    """Forge 的 Host 五件套（引擎嵌入契约的宿主侧实现）。"""

    def __init__(self) -> None:
        # 模型实例缓存（配置指纹 → 实例）：配置不变复用同一对象——引擎
        # 重建缓存键含模型实例身份，实例稳定 = 回合间不重复建图
        self._llm_cache_key: tuple[tuple[str, Any], ...] | None = None
        self._llm_cache: AsyncLLM | None = None

    async def create_storage(self) -> Storage:
        """存储工厂：进程锁（防双开）+ SQLite 集目录引擎库（幂等）。"""
        await engine_store.init_engine()
        return engine_store.get_storage()

    async def resolve_llm(self) -> AsyncLLM | None:
        """按引擎存储的模型配置解析主模型 LLM（records 为唯一真相）。

        未配置完整（base_url/model_id 必填）或配置解析失败时返回 None，
        由路由端拦截并引导用户进入模型设置。配置指纹不变时复用同一
        实例（settings 变更后自动解析新实例并触发引擎重建）。
        """
        try:
            record = await engine_store.get_storage().get_record("settings", "models")
        except Exception as exc:
            logger.warning("模型配置读取失败: %s", exc)
            return None
        cfg = (record or {}).get("main") or {}
        if not cfg.get("model_id") or not cfg.get("base_url"):
            return None
        cfg = dict(cfg)
        cfg["api_key"] = await secrets_store.get_api_key("main")
        fingerprint = tuple(sorted(cfg.items()))
        if self._llm_cache is not None and self._llm_cache_key == fingerprint:
            return self._llm_cache
        try:
            llm = create_llm(cfg)
        except Exception as exc:  # 配置形态异常不击穿启动
            logger.warning("模型配置解析失败: %s", exc)
            return None
        self._llm_cache = llm
        self._llm_cache_key = fingerprint
        return llm

    def interrupt_policy(self) -> InterruptPolicy:
        """审批策略：全挂起 + 超时兜底（宿主级审批卡，如种子沉淀）。

        补丁审批分级（L0 直过表）由应用管线按分级表自建——本策略
        只覆盖管线之外的宿主审批形态，两者不重复设表。
        """
        return DefaultInterruptPolicy(timeout=APPROVAL_TIMEOUT_SECONDS)

    def build_transport(self) -> EngineTransport:
        """事件传输工厂：web 宿主每次 SSE 请求新建队列桥（非单例）。"""
        return QueueTransport()

    async def close(self) -> None:
        """关停钩子：释放进程锁并复位引擎存储（Runtime.stop 收尾调用）。

        存储的关闭由 Runtime 关停顺序负责（GuardedStorage → 底层引擎
        库）；此处复位模块级访问契约并释放进程锁，close 幂等。
        """
        await engine_store.close_engine()

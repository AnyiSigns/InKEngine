"""干预能力审计落库（append-only 审计统一出口；复用 set_audit 集合）。

四个干预 op（候选选择 / 多径开关 / 缓存失效 / 边档降级）经本模块把审计
记录写入引擎存储的 ``set_audit`` 集合——与沉淀侧审计 sink（host 装配处
``_audit_sink``）同一落库通道，保证干预动作与运行期审计在同一 append-only
审计集合中可追溯。记录 ``type`` 字段复用事件注册表既有审计类型（禁新增
事件类型），``kind`` 取 ``type`` 作为渲染归并键。
"""
from __future__ import annotations

import time
import uuid
from contextlib import AbstractContextManager
from typing import Any, Protocol, runtime_checkable

from .logging import get_logger

logger = get_logger(__name__)

# 干预动作审计落库集合（与沉淀侧 _audit_sink 同一集合名，审计可追溯统一）
AUDIT_COLLECTION = "set_audit"


@runtime_checkable
class AuditStorage(Protocol):
    """审计落库存储的最小契约（ENG5-12：显式 Protocol 替代鸭子类型）。

    接口漂移（缺 put_record/签名变化）不再静默丢审计——运行时探测
    失败即记 warning（fail-open 但可闻）。set_audit 集合的豁免写入
    是可选扩展（:class:`GuardedAuditStorage`），裸存储直接写。
    """

    async def put_record(self, collection: str, key: str, data: dict) -> None: ...


@runtime_checkable
class GuardedAuditStorage(AuditStorage, Protocol):
    """受守卫审计存储：额外实现 ``allow_mechanism`` 豁免上下文。

    可选扩展：受守卫存储（GuardedStorage）的 set_audit 属受守卫集合，
    审计落库须经豁免上下文放行；裸存储（测试态无守卫）直接写。
    """

    def allow_mechanism(self, collection: str | None = None) -> AbstractContextManager[Any]: ...


async def emit_audit(storage: AuditStorage | None, record: dict) -> None:
    """把一条审计记录落库到 set_audit 集合（无存储 = 静默跳过）。

    落库失败只记日志不阻断主流程（审计失败不得污染干预动作结果）。set_audit
    属受守卫集合：受守卫存储（实现 :class:`GuardedAuditStorage`）经豁免
    上下文放行写入；裸内存存储（测试态无守卫）直接写——两种环境都兼容。
    存储缺 :meth:`put_record`（不满足 :class:`AuditStorage`）时记 warning
    跳过，接口漂移不再静默。
    """
    if storage is None:
        return
    ts = record.get("ts") if record.get("ts") is not None else time.time()
    key = f"op-{uuid.uuid4().hex[:12]}"
    data = {**record, "ts": ts, "kind": record.get("type") or "op"}
    try:
        if isinstance(storage, GuardedAuditStorage):
            with storage.allow_mechanism(AUDIT_COLLECTION):
                await storage.put_record(AUDIT_COLLECTION, key, data)
        else:
            await storage.put_record(AUDIT_COLLECTION, key, data)
    except AttributeError as exc:
        # 存储不满足审计契约（缺 put_record）：不静默丢审计，留痕可闻
        logger.warning(
            f"审计落库存储不满足 AuditStorage 契约（接口漂移，跳过）: {exc}"
        )
    except Exception as exc:  # 审计落库失败只记日志，不阻断干预动作
        logger.warning(f"干预审计落库失败（忽略）: {exc}")


__all__ = [
    "AUDIT_COLLECTION",
    "AuditStorage",
    "GuardedAuditStorage",
    "emit_audit",
]

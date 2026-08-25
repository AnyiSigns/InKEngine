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

from .logging import get_logger

logger = get_logger(__name__)

# 干预动作审计落库集合（与沉淀侧 _audit_sink 同一集合名，审计可追溯统一）
AUDIT_COLLECTION = "set_audit"


async def emit_audit(storage: object | None, record: dict) -> None:
    """把一条审计记录落库到 set_audit 集合（无存储 = 静默跳过）。

    落库失败只记日志不阻断主流程（审计失败不得污染干预动作结果）。set_audit
    属受守卫集合：若传入的是受守卫存储（带 ``allow_mechanism``），经豁免上下文
    放行写入；裸内存存储（测试态无守卫）直接写——两种环境都兼容。
    """
    if storage is None:
        return
    ts = record.get("ts") if record.get("ts") is not None else time.time()
    key = f"op-{uuid.uuid4().hex[:12]}"
    data = {**record, "ts": ts, "kind": record.get("type") or "op"}
    allow = getattr(storage, "allow_mechanism", None)
    try:
        if allow is not None:
            with allow(AUDIT_COLLECTION):
                await storage.put_record(AUDIT_COLLECTION, key, data)  # type: ignore[attr-defined]
        else:
            await storage.put_record(AUDIT_COLLECTION, key, data)  # type: ignore[attr-defined]
    except Exception as exc:  # 审计落库失败只记日志，不阻断干预动作
        logger.warning(f"干预审计落库失败（忽略）: {exc}")


__all__ = ["AUDIT_COLLECTION", "emit_audit"]

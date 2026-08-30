"""演化资产统一写入协议（EvolutionWriter：补丁链 + 审计留痕三重闸门）。

机制是引擎，知识是数据，变化是补丁，汇入靠调配：集内可演化资产的写入
（harness / 事件类型 / 记忆 / 边信任档 / 运行时配置）曾经直接落 records
通道（不经补丁链 + 审计），绕过集演化可追溯性。本模块把这类直写统一收口
到一条管线契约：

    EvolutionWriter.write(collection, key, data, *, kind, asset_id, note)
        → ① 补丁链 append（演化补丁链 ``evolution_patch_chain``，内容型
            PatchChain，落点路径按 kind 分段，value = 演化后整条记录）
        → ② 实时数据写（目标集合原样落库，供引擎读取，受 GuardedStorage
            机制豁免上下文放行——fail-closed 闸门仍由 GuardedStorage 兜住）
        → ③ 审计留痕（emit_audit 写入 set_audit，append-only 历史不撒谎）

演化补丁链独立于自指应用管线的集补丁链（set_patch_chain）：引擎机制内部
写入（装配/记忆/降级/配置落地）与用户提案落链（SelfApplicationPipeline）
是两条语义不同的演化通道，互不污染版本与回退（集补丁链的 apply/revert
版本记账不被机制写入干扰）。演化补丁链集合名 ``evolution_patch_chain``
非受守卫集合（无旁路写风险——它只是审计留痕，唯一写入路径即本管线），
受守卫的是 ① 的实时数据写（harness:/event_types: 前缀集合）。

双层互补：GuardedStorage（fail-closed 令牌 + allow_mechanism 双通道）是
底层闸门，EvolutionWriter 是上层管线契约——直写必须经本管线，机制通道
写入由本管线内部豁免上下文放行。
"""
from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from .audit_log import emit_audit
from .patch_chain import Patch, PatchChain, PatchOp
from .storage import Storage

# 演化补丁链持久化集合（独立于集补丁链 set_patch_chain；非受守卫集合，
# 仅作机制写入的审计留痕，唯一写入路径即 EvolutionWriter）
_EVOLUTION_CHAIN_COLLECTION = "evolution_patch_chain"
_EVOLUTION_CHAIN_KEY = "chain"

# 演化审计记录类型（set_audit 集合；与干预审计同集合、append-only）
EVOLUTION_AUDIT_TYPE = "evolution_write"

# 演化资产类型 → 集补丁链落点路径段（与集补丁链路径段同源哲学：同名键
# 整体替换，组装结果即该资产最新态；前缀集合按资产隔离，不串数据）
_KIND_PATH: dict[str, str] = {
    "harness": "harness",
    "event_type": "event_types",
    "entity": "entities",
    "memory": "memory",
    "edge_tier": "edge_tier_overrides",
    "runtime_config": "runtime_config",
}


@runtime_checkable
class EvolutionWriter(Protocol):
    """演化资产统一写入契约（上层管线；底层闸门 = GuardedStorage）。

    实现须提供 :meth:`write`：接受（目标集合, 记录键, 记录数据）→ 内部
    完成补丁链 append + 实时数据写 + 审计留痕三重闸门。
    """

    async def write(
        self,
        collection: str,
        key: str,
        data: dict[str, Any],
        *,
        kind: str,
        asset_id: str,
        note: str = "",
        meta: dict[str, Any] | None = None,
    ) -> None: ...


class DefaultEvolutionWriter:
    """EvolutionWriter 默认实现（内容型补丁链 + 实时写 + 审计）。

    构造接受 storage（可为 GuardedStorage 或非守卫存储）。目标集合为受
    守卫集合（harness:/event_types: 前缀）时，实时写经 allow_mechanism
    机制豁免上下文放行（引擎机制内部写入语义）——fail-closed 闸门仍兜住
    非本管线的直写；非守卫存储直接写，测试态无守卫亦兼容。
    """

    def __init__(self, storage: Storage) -> None:
        self._storage = storage

    async def _load_chain(self) -> PatchChain:
        record = await self._storage.get_record(
            _EVOLUTION_CHAIN_COLLECTION, _EVOLUTION_CHAIN_KEY
        )
        return PatchChain.from_dict(record) if record else PatchChain()

    async def _put_live(self, collection: str, key: str, data: dict[str, Any]) -> None:
        """实时数据写（受守卫集合经机制豁免上下文放行）。

        经 ``self.storage`` 是否为 ``GuardedStorage`` 判定：受守卫集合
        （harness:/event_types: 前缀）经 allow_mechanism 机制豁免上下文
        放行（引擎机制内部写入语义），fail-closed 闸门仍兜住非本管线的
        直写；非守卫存储直接写，测试态无守卫亦兼容。
        """
        from .self_application import GuardedStorage

        storage = self._storage
        if isinstance(storage, GuardedStorage):
            with storage.allow_mechanism():
                await storage.put_record(collection, key, data)
        else:
            await storage.put_record(collection, key, data)

    async def write(
        self,
        collection: str,
        key: str,
        data: dict[str, Any],
        *,
        kind: str,
        asset_id: str,
        note: str = "",
        meta: dict[str, Any] | None = None,
    ) -> None:
        path = _KIND_PATH.get(kind, kind)
        chain = await self._load_chain()
        chain.apply(Patch(op=PatchOp.REPLACE, path=(path, asset_id), value=data))
        await self._storage.put_record(
            _EVOLUTION_CHAIN_COLLECTION, _EVOLUTION_CHAIN_KEY, chain.to_dict()
        )
        await self._put_live(collection, key, data)
        await emit_audit(
            self._storage,
            {
                "type": EVOLUTION_AUDIT_TYPE,
                "evolution_kind": kind,
                "asset_id": asset_id,
                "collection": collection,
                "key": key,
                "note": note,
                "meta": dict(meta or {}),
            },
        )


async def harness_writer(
    writer: EvolutionWriter,
    collection: str,
    chain_key: str,
    chain_dict: dict[str, Any],
    *,
    asset_id: str,
    note: str | None = None,
) -> None:
    """harness 仓库写入（chain:<name> 链记录直写改经本管线）。"""
    await writer.write(
        collection, chain_key, chain_dict,
        kind="harness", asset_id=asset_id, note=note or "",
    )


async def event_type_writer(
    writer: EvolutionWriter,
    collection: str,
    name: str,
    spec_dict: dict[str, Any],
    *,
    note: str | None = None,
) -> None:
    """事件类型注册表写入（按集集合 spec 记录直写改经本管线）。"""
    await writer.write(
        collection, name, spec_dict,
        kind="event_type", asset_id=name, note=note or "",
    )


async def entity_writer(
    writer: EvolutionWriter,
    collection: str,
    entity_id: str,
    spec_dict: dict[str, Any],
    *,
    note: str | None = None,
) -> None:
    """实体注册表写入（按集集合 spec 记录直写改经本管线）。"""
    await writer.write(
        collection, entity_id, spec_dict,
        kind="entity", asset_id=entity_id, note=note or "",
    )


async def memory_writer(
    writer: EvolutionWriter,
    collection: str,
    entry_id: str,
    record: dict[str, Any],
    *,
    note: str | None = None,
) -> None:
    """记忆条目写入（save/update/delete 落链改经本管线）。"""
    await writer.write(
        collection, entry_id, record,
        kind="memory", asset_id=entry_id, note=note or "",
    )


async def edge_tier_writer(
    writer: EvolutionWriter,
    collection: str,
    key_str: str,
    snapshot_dict: dict[str, Any],
    *,
    note: str | None = None,
) -> None:
    """边信任档降级快照写入（edge_tier_overrides 直写改经本管线）。"""
    await writer.write(
        collection, key_str, snapshot_dict,
        kind="edge_tier", asset_id=key_str, note=note or "",
    )


async def runtime_config_writer(
    writer: EvolutionWriter,
    collection: str,
    key: str,
    record: dict[str, Any],
    *,
    asset_id: str,
    note: str | None = None,
) -> None:
    """运行时配置写入（runtime_config/* 直写改经本管线）。"""
    await writer.write(
        collection, key, record,
        kind="runtime_config", asset_id=asset_id, note=note or "",
    )


__all__ = [
    "EVOLUTION_AUDIT_TYPE",
    "DefaultEvolutionWriter",
    "EvolutionWriter",
    "edge_tier_writer",
    "event_type_writer",
    "harness_writer",
    "memory_writer",
    "runtime_config_writer",
]

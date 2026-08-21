"""InKling 宿主：Host 五件套 + 装配动作（PLAN §4 host/ 与 §6 M3）。

Host 五件套（引擎嵌入契约，见 core/runtime.Host）：
- create_storage：存储工厂（memory/sqlite 后端，URI 由装配参数决定；
  后端/路径/进程锁归宿主）；
- resolve_llm：模型解析（注入实例或环境变量配置；None = 未配置，
  路由端引导——离线 stub 评测与真实模型 live 评测同一入口）；
- interrupt_policy：审批策略（直过白名单/超时窗口归宿主）；
- build_transport：事件传输工厂（回合事件收集器；web/stdio 宿主
  按形态换实现，同一签名）；
- close：关停钩子（宿主资源回收；Runtime.stop 在存储关闭后调用）。

装配动作（boot_inkling）：Runtime.boot（配方数据装配）→ 声明式工具
进统一工具表（tools.json 数据形态）→ 宿主执行器注册（propose_mcp_mount
对话安装入口）→ 引擎重建。装配动作是机制路径，不含产品内容。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.declarative_tools import EndpointType
from ink_engine.core.events import CollectorTransport, EngineTransport
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.runtime import Host, Runtime
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS
from ink_engine.core.storage import Storage, create_storage

from .mcp_service import McpMountService
from .recipe_loader import (
    SeedDataBundle,
    declarative_specs_from_tools,
    load_seed_data,
)

# 对话式安装工具名（tools.json 声明；执行器由宿主注册）
_MOUNT_TOOL_NAME = "propose_mcp_mount"


class InKlingHost(Host):
    """InKling 宿主五件套（存储后端/模型/审批策略/事件传输/关停钩子）。"""

    def __init__(
        self,
        *,
        storage_uri: str = "memory://",
        llm: AsyncLLM | None = None,
        transport: EngineTransport | None = None,
        auto_approve_keys: frozenset[str] = frozenset(),
        timeout: float | None = APPROVAL_TIMEOUT_SECONDS,
    ) -> None:
        self._storage_uri = storage_uri
        self._llm = llm
        self._transport = transport or CollectorTransport()
        self._auto_approve_keys = auto_approve_keys
        self._timeout = timeout
        self._storage: Storage | None = None

    async def create_storage(self) -> Storage:
        """存储工厂（memory/sqlite URI 由装配参数决定；幂等，重入返回同一实例）。"""
        if self._storage is None:
            self._storage = create_storage(self._storage_uri)
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        """模型解析：注入实例优先，否则环境变量配置；缺配置返回 None。"""
        if self._llm is not None:
            return self._llm
        config = _model_config_from_env()
        if not config:
            return None
        try:
            return create_llm(config)
        except Exception:
            return None

    def interrupt_policy(self) -> InterruptPolicy:
        """审批策略（直过白名单 + 审批超时窗口；缺省走引擎默认超时）。"""
        return DefaultInterruptPolicy(
            auto_approve_keys=self._auto_approve_keys,
            timeout=self._timeout,
        )

    def build_transport(self) -> EngineTransport:
        """事件传输工厂（回合事件收集；web/stdio 宿主按形态换实现）。"""
        return self._transport

    async def close(self) -> None:
        """关停钩子（宿主资源回收；Runtime.stop 在存储关闭后调用）。"""
        return

    @property
    def events(self) -> list[Any]:
        """已收集回合事件（评测/观测侧读取；CollectorTransport 形态）。"""
        return self._transport.events


def _model_config_from_env() -> dict[str, str]:
    """环境变量模型配置（INK_LLM_* 命名与 examples/stdio_host 同口径）。"""
    base_url = os.environ.get("INK_LLM_BASE_URL", "")
    model_id = os.environ.get("INK_LLM_MODEL", "")
    if not base_url or not model_id:
        return {}
    config: dict[str, str] = {
        "adapter": os.environ.get("INK_LLM_ADAPTER", "openai_compat"),
        "base_url": base_url,
        "model_id": model_id,
    }
    api_key = os.environ.get("INK_LLM_API_KEY")
    if api_key:
        config["api_key"] = api_key
    return config


async def boot_inkling(
    root: Path,
    *,
    llm: AsyncLLM | None = None,
    storage_uri: str = "memory://",
    host: InKlingHost | None = None,
    market: dict[str, Any] | None = None,
) -> tuple[Runtime, InKlingHost, McpMountService]:
    """装配 InKling 运行时（配方数据装配 + 宿主装配动作）。

    流程：
    1. 装载 seed_data → 装配配方（17 字段全落值，纯数据映射）；
    2. Runtime.boot（引擎机制装配：种子/harness/事件类型/审批管线/
       界面基线/元工具流水线/检索源/引擎重建）；
    3. 声明式工具进统一工具表（tools.json 数据形态，与 mcp 挂载
       工具同一张表）；
    4. 宿主执行器注册（propose_mcp_mount 对话式安装入口）；
    5. 引擎重建（工具表变更触发）。

    Returns:
        (runtime, host, mount_service)——mount_service 是挂载双入口
        （设置页一键挂载 / 对话式安装）的共用编排入口。
    """
    bundle = load_seed_data(root)
    hook, mark_vetted = _l2_hook_parts(bundle)
    host = host or InKlingHost(llm=llm, storage_uri=storage_uri)
    from .recipe_loader import build_recipe

    recipe = build_recipe(bundle, l2_vetting_hook=hook)
    runtime = await Runtime().boot(host, recipe)
    mount_service = McpMountService(
        runtime,
        market=market if market is not None else bundle.data["mcp_market.json"],
        external_mark_vetted=mark_vetted,
    )
    register_domain_tools(runtime, bundle)
    register_host_executors(runtime, mount_service)
    runtime.introspection_service._sources.tools = runtime.collect_specs()
    await runtime.rebuild_engine()
    return runtime, host, mount_service


def _l2_hook_parts(
    bundle: SeedDataBundle,
) -> tuple[Any, Any]:
    """L2 验证钩子装配（recipe 默认钩子 + 放行登记器透传给挂载服务）。"""
    from .recipe_loader import build_mcp_l2_vetting_hook

    return build_mcp_l2_vetting_hook()


def register_domain_tools(runtime: Runtime, bundle: SeedDataBundle) -> None:
    """tools.json 声明式工具进统一工具表（挂载/声明同表，机制零差异）。

    声明是数据：工具定义（名称/参数/权限/端点）全部来自 tools.json；
    执行端点由宿主执行器注册兜底（未注册端点在调用时降级为明确
    失败文本，不崩溃）。
    """
    for spec in declarative_specs_from_tools(bundle):
        runtime.harness_registry.declarative.register_definition(spec)
        runtime.tool_registry[spec.name] = spec.to_spec()


def register_host_executors(
    runtime: Runtime, mount_service: McpMountService
) -> None:
    """宿主声明式执行器注册（机制层不代注册执行实现，宿主职责）。

    - process_exec：propose_mcp_mount（对话式安装入口）走挂载服务；
      其余 OS 控制工具（launch_app/open_file 等）执行器归 shell/ 宿主
      注册（M2 桌面壳），未接入时调用降级为明确失败文本。
    """

    async def process_exec_executor(
        ctx: Any, definition: Any, args: dict[str, Any], approval: Any
    ) -> str:
        if definition.name == _MOUNT_TOOL_NAME:
            address = str(args.get("address") or "").strip()
            if not address:
                return json.dumps(
                    {"ok": False, "status": "resolve_failed", "error": "挂载地址为空"},
                    ensure_ascii=False,
                )
            outcome = await mount_service.propose_mount(ctx, address)
            return json.dumps(
                {
                    "ok": outcome.ok,
                    "status": outcome.status,
                    "server_id": outcome.server_id,
                    "tools": list(outcome.tool_names),
                    "error": outcome.error,
                },
                ensure_ascii=False,
            )
        return f"执行器未接入（shell 宿主未挂载）: {definition.name}"

    runtime.harness_registry.declarative.register(
        EndpointType.PROCESS_EXEC, process_exec_executor
    )


__all__ = [
    "InKlingHost",
    "boot_inkling",
    "register_domain_tools",
    "register_host_executors",
]

"""参考宿主：Host 五件套 + 回合驱动（评测底座）。

模型配置来源（与 tests/live 同口径）：INKENGINE_LIVE_BASE_URL /
INKENGINE_LIVE_API_KEY / INKENGINE_LIVE_MODEL 环境变量优先，回落仓库根
`.kilo/测试模型配置.txt`（url/key/model_name 行形态）。未配置 =
resolve_llm 返回 None（回合无回复，评测按环境缺失标记，不误伤）。

决议回流：挂卡出现时由评测脚本经 ``run_round(..., inject=...)`` 注入
（本宿主不内置交互终端——交互形态归产品宿主，参考宿主只保留通道）。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.events import CollectorTransport, EngineTransport
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.runtime import Host, Runtime
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS
from ink_engine.core.storage import Storage, create_storage

_CONFIG_FILE = Path(__file__).resolve().parents[3] / ".kilo" / "测试模型配置.txt"


def load_model_config() -> dict:
    """环境变量优先，回落仓库根 .kilo/测试模型配置.txt；无配置返回 {}。"""
    base_url = os.environ.get("INKENGINE_LIVE_BASE_URL", "")
    api_key = os.environ.get("INKENGINE_LIVE_API_KEY", "")
    model = os.environ.get("INKENGINE_LIVE_MODEL", "")
    if base_url and api_key and model:
        return {"url": base_url, "key": api_key, "model_name": model}
    if not _CONFIG_FILE.is_file():
        return {}
    data: dict[str, str] = {}
    for line in _CONFIG_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return data


class ReferenceHost(Host):
    """Host 五件套：内存存储 / 环境配置 LLM / 默认审批策略 / 事件收集传输 / 关停。"""

    def __init__(self) -> None:
        self.transport = CollectorTransport()
        self._storage: Storage | None = None

    async def create_storage(self) -> Storage:
        self._storage = create_storage("memory://")
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        config = load_model_config()
        if not (config.get("url") and config.get("key") and config.get("model_name")):
            return None
        return create_llm(
            {
                "adapter": "openai_compat",
                "base_url": config["url"],
                "api_key": config["key"],
                "model_id": config["model_name"],
                "request_timeout": 120.0,
            }
        )

    def interrupt_policy(self) -> InterruptPolicy:
        return DefaultInterruptPolicy(timeout=APPROVAL_TIMEOUT_SECONDS)

    def build_transport(self) -> EngineTransport:
        return self.transport

    async def close(self) -> None:
        return None


class _AcceptApprovalCtx:
    """自指工具审批替身：一律 accept（评测自动决议；产品宿主走交互）。"""

    async def interrupt(self, key: str, payload: dict):
        return {"decision": "accept"}

    async def get_interrupt_payload(self, key: str):
        return None


async def run_round(
    runtime: Runtime,
    host: ReferenceHost,
    input_text: str,
    *,
    max_resumes: int = 1,
    inject: dict[str, Any] | None = None,
    event_offset: int = 0,
) -> dict[str, Any]:
    """回合驱动：登记在途 → ainvoke → 挂卡决议回流（最多 max_resumes 次）→ end_run。

    Args:
        event_offset: 事件快照起点（host.transport.events 的下标；评测
            脚本按任务记录增量，避免跨任务事件串扰）。
    Returns:
        {result, state, reason, interrupt, resumes, events}（events =
        本次回合增量事件，含一次决议回流内的事件）。
    """
    if runtime.engine is None:
        raise RuntimeError("runtime 未装配引擎（boot 失败？）")
    ticket = runtime.begin_run()
    try:
        result = await runtime.engine.ainvoke(
            {"input": input_text},
            thread_id=ticket.id,
            transports=[host.transport],
        )
        resumes = 0
        injected: dict[str, Any] = dict(inject or {})
        while result.interrupt is not None and resumes < max_resumes:
            key = result.interrupt.key
            decision = injected.pop(key, "accept")
            result = await runtime.resume_run(
                ticket.id, decision, transports=[host.transport]
            )
            resumes += 1
        events = list(host.transport.events[event_offset:])
        return {
            "result": result,
            "state": dict(result.state),
            "reason": getattr(result.reason, "value", str(result.reason)),
            "interrupt": result.interrupt,
            "resumes": resumes,
            "events": events,
        }
    finally:
        runtime.end_run(ticket)


async def apply_tool_patch(runtime: Runtime, payload: dict[str, Any]) -> None:
    """机制路径注册声明式工具：TOOL 提案 → L1 审批 accept → 落链 →
    活跃态生效（apply target 注册进工具表）→ 引擎重建。"""
    from ink_engine.core.self_proposal import PatchKind, SelfProposal

    proposal = SelfProposal(
        kind=PatchKind.TOOL,
        payload=payload,
        base_version=await runtime.self_pipeline.chain.current_version(),
        rationale="参考宿主开局工具注册",
    )
    outcome = await runtime.self_pipeline.apply(_AcceptApprovalCtx(), proposal)
    if not outcome.applied:
        raise RuntimeError(f"工具注册被拒: {outcome.status} {outcome.reason}")
    await runtime.rebuild_engine()


def register_file_ops_executor(runtime: Runtime, root: Path) -> None:
    """宿主侧声明式执行器注册（宿主职责：机制层不代注册执行实现）。"""
    from ink_engine.core.declarative_tools import EndpointType

    async def file_executor(ctx, defn, args, approval):
        target = root / args["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(args.get("content", ""), encoding="utf-8")
        return f"written:{args['path']}"

    runtime.harness_registry.declarative.register(EndpointType.FILE_OPS, file_executor)


__all__ = [
    "ReferenceHost",
    "apply_tool_patch",
    "load_model_config",
    "register_file_ops_executor",
    "run_round",
]

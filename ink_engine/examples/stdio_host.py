"""stdio 最小宿主：非 web 存在证据（引擎 Runtime 的第二宿主）。

用法（需配置模型环境变量，对齐 OpenAI 兼容端点）::

    INK_LLM_BASE_URL=https://.../compatible-mode/v1 \
    INK_LLM_MODEL=deepseek-v4-pro-0813 \
    INK_LLM_API_KEY=sk-... \
    python examples/stdio_host.py

stdin 每行一个 JSON 回合输入（``{"message": "..."}``），stdout 每行
一个 JSON 事件（引擎事件信封直出）。审批卡出现时终端提示
y/n/e/d 决议（接受/拒绝/编辑/终止），输入行回流引擎续跑（与 web
宿主的 resume 端点同一决议回流通道，只是入口形态不同）。

装配 = Runtime.boot（Host 五件套 + 装配配方）：复用 seeds/boot 数据
（自举提示词/事件类型/自举 harness）装配内省 + 契约自指元工具流水线、
知识集、补丁链、分级审批——自进化闭环在无 web 宿主同样完整成立；
契约演化工具直接复用内核 core/self_tools.py，无需自带任何元工具实现。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid

from ink_engine.core.approval import DefaultInterruptPolicy, InterruptPolicy
from ink_engine.core.events import EngineEvent, EngineTransport
from ink_engine.core.graph import Graph
from ink_engine.core.llm import AsyncLLM, create_llm
from ink_engine.core.llm.messages import (
    Message,
    ToolCall,
    accumulate_tool_calls,
    assistant,
    system,
    tool_result,
    user,
)
from ink_engine.core.runtime import (
    AssemblyRecipe,
    GraphRecipeContext,
    Runtime,
    ToolWiring,
)
from ink_engine.core.self_application import APPROVAL_TIMEOUT_SECONDS, ApprovalLevel
from ink_engine.core.self_proposal import PatchKind
from ink_engine.core.self_tools import make_self_executor, operation_of, self_tool_specs
from ink_engine.core.storage import Storage, create_storage
from ink_engine.seeds.boot import (
    BOOT_EVENT_TYPES,
    BOOT_SYSTEM_PROMPT,
    BOOT_UI_SPEC,
    boot_harness_definition,
    build_boot_seed_entries,
)

# 回合工具循环上限（成本护栏：与宿主样例对齐）
_MAX_TOOL_ROUNDS = 6
# 工具结果回填消息流的截断上限（上下文体积有界）
_TOOL_RESULT_MAX_CHARS = 4000
# 状态通道键（工具循环进度；挂起重入从快照恢复，不丢消息流）
_STATE_MESSAGES = "messages"
_STATE_PENDING_TOOLS = "pending_tools"
_STATE_REPLY = "reply"
_STATE_TOOL_ROUNDS = "tool_rounds"
_STATE_NEXT = "next"


class StdioHost:
    """stdio 宿主五件套：内存存储 / 环境变量 LLM / 终端审批 / JSON 行传输 / 清理钩子。"""

    def __init__(self) -> None:
        self._storage: Storage | None = None

    async def create_storage(self) -> Storage:
        self._storage = create_storage("memory://")
        return self._storage

    async def resolve_llm(self) -> AsyncLLM | None:
        """模型解析：环境变量驱动（base_url/model_id 必填，api_key 可选）。"""
        base_url = os.environ.get("INK_LLM_BASE_URL")
        model_id = os.environ.get("INK_LLM_MODEL")
        if not base_url or not model_id:
            return None
        config: dict = {
            "adapter": os.environ.get("INK_LLM_ADAPTER", "openai_compat"),
            "base_url": base_url,
            "model_id": model_id,
        }
        api_key = os.environ.get("INK_LLM_API_KEY")
        if api_key:
            config["api_key"] = api_key
        try:
            return create_llm(config)
        except Exception as exc:
            _emit("error", {"message": f"模型配置解析失败: {exc}"})
            return None

    def interrupt_policy(self) -> InterruptPolicy:
        """审批策略：全挂起 + 超时兜底（终端决议经回流通道注入）。"""
        return DefaultInterruptPolicy(timeout=APPROVAL_TIMEOUT_SECONDS)

    def build_transport(self) -> EngineTransport:
        """事件传输工厂：单一 JSON 行传输（stdout 直出，非每请求新建）。"""
        return JsonLinesTransport(sys.stdout)

    async def close(self) -> None:
        # 内存存储由 Runtime 关停顺序关闭；本宿主无其它资源
        return None


class JsonLinesTransport:
    """JSON 行事件传输（EngineTransport 实现）：事件信封 → stdout 单行。"""

    def __init__(self, stream) -> None:
        self._stream = stream

    async def send(self, event: EngineEvent) -> None:
        self._stream.write(event.to_json() + "\n")
        self._stream.flush()


def build_stdio_graph(
    llm: AsyncLLM, pipeline, tool_specs, *, storage: Storage | None = None
) -> Graph:
    """最小 chat 图：agent（LLM 流式回复 + 工具决策）→ exec_tool ⇄ agent → finish。

    工具循环进度放状态通道（审批挂起重入从快照恢复，不丢消息流与待执行
    工具）；storage 参数为签名对称保留（stdio 宿主暂不启用位置感知）。
    """

    specs_by_name = {spec.name: spec for spec in tool_specs}

    async def restore_messages(ctx) -> list[Message]:
        raw = ctx.state.get(_STATE_MESSAGES)
        if isinstance(raw, list):
            return [Message.from_dict(item) for item in raw if isinstance(item, dict)]
        return [
            system(BOOT_SYSTEM_PROMPT),
            user(str(ctx.state.get("input") or "")),
        ]

    async def agent(ctx):
        thread_id = str(ctx.state.get("thread_id") or "")
        messages = await restore_messages(ctx)
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        tool_rounds = int(ctx.state.get(_STATE_TOOL_ROUNDS) or 0)
        if tool_rounds >= _MAX_TOOL_ROUNDS:
            await ctx.emit(
                "end", {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id}
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        content = ""
        deltas: list = []
        try:
            stream = llm.astream(messages, tools=list(tool_specs) or None, params=None)
            async for chunk in stream:
                if chunk.token:
                    content += chunk.token
                    reply += chunk.token
                    await ctx.emit(
                        "reply_token", {"token": chunk.token}, step_id="reply:1"
                    )
                if chunk.tool_calls_delta:
                    deltas.extend(chunk.tool_calls_delta)
        except Exception as exc:
            await ctx.emit(
                "error", {"message": f"模型调用失败: {exc}"}, step_id="error:1"
            )
            await ctx.emit(
                "end", {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id}
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        calls = accumulate_tool_calls(deltas)
        messages.append(assistant(content, tool_calls=calls or None))
        if not calls:
            await ctx.emit(
                "end", {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id}
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        return {
            _STATE_MESSAGES: [m.to_dict() for m in messages],
            _STATE_PENDING_TOOLS: [_call_to_dict(call) for call in calls],
            _STATE_REPLY: reply,
            _STATE_TOOL_ROUNDS: tool_rounds + 1,
            _STATE_NEXT: "exec_tool",
        }

    async def exec_tool(ctx):
        thread_id = str(ctx.state.get("thread_id") or "")
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        messages = await restore_messages(ctx)
        pending = ctx.state.get(_STATE_PENDING_TOOLS) or []
        if not pending:
            await ctx.emit(
                "end", {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id}
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        call = _call_from_dict(pending[0])
        step_id = f"tool:{call.id}"
        await ctx.emit(
            "tool_start",
            {"tool": call.name, "category": "query", "tool_call_id": call.id},
            step_id=step_id,
        )
        spec = specs_by_name.get(call.name)
        if spec is None:
            text = f"未知工具: {call.name}"
            success = False
        else:
            try:
                args = call.parse_arguments(strict=True)
                outcome = await pipeline.execute(ctx, spec, args)
                text = outcome.output if outcome.ok else f"执行被拒: {outcome.error}"
                success = outcome.ok
            except Exception as exc:
                text = f"执行异常: {exc}"
                success = False
        await ctx.emit(
            "tool_end",
            {
                "tool": call.name,
                "category": "query",
                "tool_call_id": call.id,
                "success": success,
                "message": text[:200],
            },
            step_id=step_id,
        )
        messages.append(tool_result(text[:_TOOL_RESULT_MAX_CHARS], call.id))
        return {
            _STATE_MESSAGES: [m.to_dict() for m in messages],
            _STATE_PENDING_TOOLS: pending[1:],
            _STATE_REPLY: reply,
            _STATE_NEXT: "agent",
        }

    async def finish(ctx):
        return {}

    def route_after_agent(ctx):
        return ctx.state.get(_STATE_NEXT, "finish") == "exec_tool"

    def route_to_finish(ctx):
        return ctx.state.get(_STATE_NEXT, "finish") != "exec_tool"

    g = Graph(name="stdio_round", entry="agent")
    g.add_node("agent", agent)
    g.add_node("exec_tool", exec_tool)
    g.add_node("finish", finish)
    g.add_conditional_edge("agent", "exec_tool", route_after_agent)
    g.add_conditional_edge("agent", "finish", route_to_finish)
    g.add_edge("exec_tool", "agent")
    g.add_exit("finish")
    return g


def build_stdio_recipe() -> AssemblyRecipe:
    """stdio 装配配方：复用 boot 种子数据（自举提示词/事件/自举 harness）。"""
    return AssemblyRecipe(
        set_id="stdio",
        seeds=[("boot", build_boot_seed_entries)],
        harness_definitions=[boot_harness_definition()],
        event_type_specs=list(BOOT_EVENT_TYPES),
        ui_spec=BOOT_UI_SPEC,
        ui_allowed_components=("column", "message_list", "agent_input"),
        ui_allowed_theme_tokens=("bg", "fg", "accent"),
        tool_wiring=ToolWiring(
            self_specs=self_tool_specs,
            self_executor_factory=make_self_executor,
            self_operation_of=operation_of,
        ),
        approval_levels={
            PatchKind.THEME: ApprovalLevel.L0,
            PatchKind.UI: ApprovalLevel.L0,
        },
        graph_recipe=_stdio_graph_recipe,
    )


def _stdio_graph_recipe(ctx: GraphRecipeContext) -> Graph:
    return build_stdio_graph(ctx.llm, ctx.tool_pipeline, ctx.tool_specs)


async def run_round(runtime: Runtime, host: StdioHost, thread_id: str, message: str) -> None:
    """跑一个回合：登记在途 → 流式事件 → 挂起则终端决议回流续跑。"""
    ticket = runtime.begin_run()
    transport = host.build_transport()
    try:
        result = await runtime.engine.ainvoke(
            {"input": message, "thread_id": thread_id},
            thread_id=thread_id,
            round_id=uuid.uuid4().hex,
            transports=[transport],
        )
        while result.interrupt is not None:
            decision = _prompt_decision(result.interrupt)
            result = await runtime.resume_run(
                thread_id, decision, transports=[transport]
            )
    finally:
        runtime.end_run(ticket)


def _prompt_decision(interrupt) -> dict:
    """终端决议（y/n/e/d）→ 注入值（与 web resume 端点同一注入形态）。"""
    print(
        f"[审批卡] {interrupt.key}: "
        f"{json.dumps(interrupt.payload, ensure_ascii=False)}",
        flush=True,
    )
    while True:
        print("决议 [y]接受 [n]拒绝 [e]编辑 [d]终止: ", end="", flush=True)
        line = sys.stdin.readline()
        if not line:
            return {"decision": "terminate"}
        choice = line.strip().lower()
        if choice == "y":
            return {"decision": "accept"}
        if choice == "n":
            return {"decision": "reject", "reason": "终端拒绝"}
        if choice == "e":
            print("编辑内容（JSON dict，单行）: ", end="", flush=True)
            raw = sys.stdin.readline().strip()
            try:
                edited = json.loads(raw)
            except json.JSONDecodeError:
                print("JSON 解析失败，请重试", flush=True)
                continue
            return {"decision": "edit", "edited_content": edited}
        if choice == "d":
            return {"decision": "terminate"}
        print("未知决议，请重试", flush=True)


def _call_to_dict(call: ToolCall) -> dict:
    return {"id": call.id, "name": call.name, "arguments": call.arguments}


def _call_from_dict(data: dict) -> ToolCall:
    return ToolCall(
        id=str(data.get("id") or ""),
        name=str(data.get("name") or ""),
        arguments=str(data.get("arguments") or ""),
    )


def _emit(etype: str, payload: dict) -> None:
    print(json.dumps({"type": etype, "payload": payload}, ensure_ascii=False), flush=True)


async def main() -> int:
    """stdio 宿主主循环：装配 → 逐行回合 → 决议回流 → 优雅关停。"""
    host = StdioHost()
    runtime = await Runtime().boot(host, build_stdio_recipe())
    if runtime.engine_llm is None:
        _emit(
            "error",
            {
                "message": "模型未配置：请设置 INK_LLM_BASE_URL / INK_LLM_MODEL"
                "（可选 INK_LLM_API_KEY）后重试"
            },
        )
        await runtime.stop()
        return 1
    _emit(
        "ready",
        {"message": "stdio 宿主就绪：每行一个 JSON 回合输入，Ctrl+C 退出"},
    )
    try:
        for line in sys.stdin:
            raw = line.strip()
            if not raw:
                continue
            if raw in ("exit", "quit"):
                break
            try:
                request = json.loads(raw)
            except json.JSONDecodeError as exc:
                _emit("error", {"message": f"回合输入须为 JSON: {exc}"})
                continue
            message = str(request.get("message") or "").strip()
            if not message:
                continue
            thread_id = str(
                request.get("thread_id") or f"thread-{uuid.uuid4().hex[:8]}"
            )
            await run_round(runtime, host, thread_id, message)
    except KeyboardInterrupt:
        pass
    finally:
        await runtime.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))

"""prebuilt 循环：build_agent_graph——声明式可复用 agent 回合图。

「prebuilt 循环」定位：宿主不必手写回合图——本构造器给出开箱即用的
agent 循环（LLM 回合 → 工具调用分发 → 回环 → 收口），宿主只需注入
LLM、工具清单与分发器；挂卡/审批/事件/状态通道语义全部走引擎机制。

状态通道（state keys）：
- messages:  消息流（dict 序列，续跑可还原）
- reply:     收口回复（增量累积）
- pending:   待执行工具调用（dict 序列）
- tool_rounds: 工具循环计数（成本护栏，超限强制收口）

事件：reply_token（流式增量）/ tool_start / tool_end / end。
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from ink_engine.core.graph import Graph
from ink_engine.core.llm import AsyncLLM
from ink_engine.core.llm.messages import (
    Message,
    ToolCall,
    accumulate_tool_calls,
    assistant,
    system,
    tool_result,
    user,
)
from ink_engine.core.tool_pipeline import ToolSpec

# 回合工具循环上限（成本护栏：与宿主样例对齐）
MAX_TOOL_ROUNDS = 6
# 工具结果回填消息流的截断上限（上下文体积有界）
TOOL_RESULT_MAX_CHARS = 4000

_STATE_MESSAGES = "messages"
_STATE_REPLY = "reply"
_STATE_PENDING = "pending"
_STATE_TOOL_ROUNDS = "tool_rounds"
_STATE_NEXT = "next"


def _to_dict_list(messages: Sequence[Message]) -> list[dict]:
    return [m.to_dict() for m in messages]


def _from_dict_list(raw: object) -> list[Message]:
    if isinstance(raw, list):
        return [Message.from_dict(item) for item in raw if isinstance(item, dict)]
    return []


def _call_to_dict(call: ToolCall) -> dict:
    return {"name": call.name, "id": call.id, "arguments": call.arguments}


def _call_from_dict(data: dict) -> ToolCall:
    return ToolCall(name=data["name"], id=data["id"], arguments=data.get("arguments"))


def build_agent_graph(
    llm: AsyncLLM | None,
    *,
    tool_specs: Sequence[ToolSpec] = (),
    pipeline: Any = None,
    dispatch: Callable[[ToolCall], Awaitable[str]] | None = None,
    system_prompt: str = "",
    max_tool_rounds: int = MAX_TOOL_ROUNDS,
    name: str = "agent_loop",
) -> Graph:
    """构造 prebuilt agent 循环图。

    Args:
        llm: 模型实例（None = 图可建但回合无回复，供离线/直连模式）。
        tool_specs: 工具清单（进入模型工具表；空 = 纯对话）。
        pipeline: 统一工具流水线（ToolPipeline；工具调用经
            pipeline.execute(ctx, spec, args) 分发——权限/审计/守卫
            机制全部生效；None = 回落 dispatch 直连分发）。
        dispatch: 工具调用分发器（ToolCall → 结果文本；仅 pipeline
            为空时使用；未注册工具一律返回失败文本，绝不崩溃）。
        system_prompt: 系统提示（回合首条消息之前注入）。
        max_tool_rounds: 工具循环护栏上限。
        name: 图名。

    入口状态：``{"input": "..."}``；出口状态含 ``reply``。
    挂卡/审批/事件/checkpoint 语义全部由引擎机制承载（宿主零实现）。
    """

    specs_by_name = {spec.name: spec for spec in tool_specs}

    async def restore_messages(ctx) -> list[Message]:
        restored = _from_dict_list(ctx.state.get(_STATE_MESSAGES))
        if restored:
            return restored
        messages: list[Message] = []
        if system_prompt:
            messages.append(system(system_prompt))
        messages.append(user(str(ctx.state.get("input") or "")))
        return messages

    async def agent(ctx):
        messages = await restore_messages(ctx)
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        rounds = int(ctx.state.get(_STATE_TOOL_ROUNDS) or 0)
        if rounds >= max_tool_rounds:
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        content = ""
        deltas: list = []
        try:
            stream = llm.astream(messages, tools=list(tool_specs) or None, params=None)
            async for chunk in stream:
                if chunk.token:
                    content += chunk.token
                    reply += chunk.token
                    await ctx.emit("reply_token", {"token": chunk.token})
                if chunk.tool_calls_delta:
                    deltas.extend(chunk.tool_calls_delta)
        except Exception as exc:
            await ctx.emit("error", {"message": f"模型调用失败: {exc}"})
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        calls = accumulate_tool_calls(deltas)
        messages.append(assistant(content, tool_calls=calls or None))
        if not calls:
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        return {
            _STATE_MESSAGES: _to_dict_list(messages),
            _STATE_PENDING: [_call_to_dict(call) for call in calls],
            _STATE_REPLY: reply,
            _STATE_TOOL_ROUNDS: rounds + 1,
            _STATE_NEXT: "exec_tool",
        }

    async def exec_tool(ctx):
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        messages = await restore_messages(ctx)
        pending = ctx.state.get(_STATE_PENDING) or []
        if not pending:
            return {_STATE_REPLY: reply, _STATE_NEXT: "finish"}
        call = _call_from_dict(pending[0])
        step_id = f"tool:{call.id}"
        await ctx.emit(
            "tool_start",
            {"tool": call.name, "tool_call_id": call.id},
            step_id=step_id,
        )
        spec = specs_by_name.get(call.name)
        if spec is None:
            text = f"未知或未启用工具: {call.name}"
            success = False
        else:
            try:
                args = call.parse_arguments(strict=True)
                if pipeline is not None:
                    outcome = await pipeline.execute(ctx, spec, args)
                    text = outcome.output if outcome.ok else f"执行被拒: {outcome.error}"
                    success = outcome.ok
                elif dispatch is not None:
                    text = await dispatch(call)
                    success = True
                else:
                    text = "工具未启用（无分发器）"
                    success = False
            except Exception as exc:
                text = f"工具执行异常: {exc}"
                success = False
        await ctx.emit(
            "tool_end",
            {
                "tool": call.name,
                "tool_call_id": call.id,
                "success": success,
                "message": text[:200],
            },
            step_id=step_id,
        )
        messages.append(tool_result(text[:TOOL_RESULT_MAX_CHARS], call.id))
        return {
            _STATE_MESSAGES: _to_dict_list(messages),
            _STATE_PENDING: pending[1:],
            _STATE_REPLY: reply,
            _STATE_NEXT: "agent",
        }

    async def finish(ctx):
        return {}

    def route_to_exec(ctx):
        return ctx.state.get(_STATE_NEXT, "finish") == "exec_tool"

    def route_to_finish(ctx):
        return ctx.state.get(_STATE_NEXT, "finish") != "exec_tool"

    g = Graph(name=name, entry="agent")
    g.add_node("agent", agent)
    g.add_node("exec_tool", exec_tool)
    g.add_node("finish", finish)
    g.add_conditional_edge("agent", "exec_tool", route_to_exec)
    g.add_conditional_edge("agent", "finish", route_to_finish)
    g.add_edge("exec_tool", "agent")
    g.add_exit("finish")
    return g


__all__ = [
    "MAX_TOOL_ROUNDS",
    "TOOL_RESULT_MAX_CHARS",
    "build_agent_graph",
]

"""自举回合循环：图执行 + LLM 工具循环 → 事件流。

回合以引擎图承载（entry=agent → finish）：LLM 流式对话与元工具调用
循环在 agent 节点内完成，全部事件经引擎信封（EngineEvent）发布到
SSE 传输桥，前端按事件协议渲染。图 = 宿主装配的机制节点，回合
状态（输入/回复）在状态通道内流转，checkpoint 版本链随引擎落库。

回合内事件（对齐前端事件协议）：
- thinking_start/token/end：模型推理过程（reasoning_content 透传）；
- tool_start/tool_end：元工具调用（category=query，展示「查询」类）；
- reply_token：回复正文流（按 step_id=reply:1 归属正文段）；
- end：回合收尾（携带 reply/thread_id/round_id）；
- error：执行失败（LLM/工具异常兜底，引擎另有节点级兜底双保险）。
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from ink_engine.core.graph import Graph
from ink_engine.core.llm import AsyncLLM
from ink_engine.core.llm.messages import (
    Message,
    accumulate_tool_calls,
    assistant,
    system,
    tool_result,
    user,
)
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.storage import Storage
from ink_engine.core.tool_pipeline import ToolPipeline

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 6
REPLY_STEP_ID = "reply:1"
TOOL_CATEGORY = "query"
TOOL_RESULT_MAX_CHARS = 4000

# ui_context 感知：机制通道集合名与汇入窗口（与上报端点对齐）
_UI_CONTEXT_COLLECTION = "ui_context"
_UI_EVENTS_COLLECTION = "ui_events"
_UI_EVENTS_WINDOW = 5
_UI_SELECTION_MAX_CHARS = 120

SYSTEM_PROMPT = """你是 Forge——一个站在 AI 上的自进化产品。引擎是骨骼，种子是基因，\
补丁链是成长史；本回合你可以调用观察工具看清自己的形态：

- inspect_graph：当前执行图结构（节点/边/出口）
- inspect_rules：集内规则集（判断既有规则是否合适）
- inspect_knowledge：知识集概览（已沉淀的知识）
- inspect_ui：当前界面描述（产品呈现形态）
- inspect_tools：工具表与集内领域清单

先观察再作答：需要了解自身状态时先调用相应工具，再基于观察结果
组织回复。用中文回复用户，简明直接。"""


def build_forge_graph(
    llm: AsyncLLM,
    pipeline: ToolPipeline,
    tool_specs: Sequence[ToolSpec],
    *,
    system_prompt: str = SYSTEM_PROMPT,
    storage: Storage | None = None,
) -> Graph:
    """装配回合图（节点闭包持有 LLM/工具流水线，状态经图通道流转）。

    storage 注入 ui_context 感知数据源（位置快照 + 交互事件摘要）；
    缺省 None = 感知禁用（回合照常执行，感知是增强不是收紧）。
    """

    specs_by_name = {spec.name: spec for spec in tool_specs}

    async def agent(ctx):
        input_text = str(ctx.state.get("input") or "").strip()
        thread_id = str(ctx.state.get("thread_id") or "")
        if not input_text:
            await ctx.emit(
                "error", {"message": "消息为空，请重试"}, step_id="error:1"
            )
            return {"done": True}

        messages: list[Message] = [system(system_prompt)]
        if storage is not None:
            ui_note = await _build_ui_context_note(storage)
            if ui_note:
                messages.append(system(ui_note))
        messages.append(user(input_text))
        reply = ""
        tools = list(tool_specs)
        # 思考段计数：每段独立推理各占一张思考卡（thinking:1/thinking:2…），
        # 多轮工具调用间的多次推理不互相堆叠
        thinking_count = 0
        for _turn in range(MAX_TOOL_ROUNDS):
            content_part = ""
            deltas: list[Any] = []
            thinking_step: str | None = None
            try:
                stream = llm.astream(messages, tools=tools or None, params=None)
                async for chunk in stream:
                    if chunk.reasoning_token:
                        if thinking_step is None:
                            thinking_count += 1
                            thinking_step = f"thinking:{thinking_count}"
                            await ctx.emit(
                                "thinking_start", {}, step_id=thinking_step
                            )
                        await ctx.emit(
                            "thinking_token",
                            {"token": chunk.reasoning_token},
                            step_id=thinking_step,
                        )
                    else:
                        # 推理段结束边界：首个非推理增量（正文/工具调用）
                        # 出现即收尾思考卡，正文流不悬挂在思考段之后
                        if thinking_step is not None:
                            await ctx.emit(
                                "thinking_end", {}, step_id=thinking_step
                            )
                            thinking_step = None
                    if chunk.token:
                        content_part += chunk.token
                        reply += chunk.token
                        await ctx.emit(
                            "reply_token",
                            {"token": chunk.token},
                            step_id=REPLY_STEP_ID,
                        )
                    if chunk.tool_calls_delta:
                        deltas.extend(chunk.tool_calls_delta)
            except Exception as exc:
                logger.warning("LLM 调用异常: %s", exc)
                await ctx.emit(
                    "error",
                    {"message": f"模型调用失败: {exc}"},
                    step_id="error:1",
                )
                # 失败也须收尾：前端以 end 事件为回合终点的唯一依据
                await ctx.emit(
                    "end",
                    {
                        "reply": reply,
                        "thread_id": thread_id,
                        "round_id": ctx.round_id,
                    },
                )
                return {"done": True}
            if thinking_step is not None:
                await ctx.emit("thinking_end", {}, step_id=thinking_step)

            calls = accumulate_tool_calls(deltas)
            messages.append(assistant(content_part or "", tool_calls=calls or None))
            if not calls:
                break
            for call in calls:
                await execute_tool(ctx, pipeline, specs_by_name, messages, call)
        else:
            # 工具轮次耗尽：停止追问，把既有回复收尾
            if reply:
                await ctx.emit(
                    "error",
                    {"message": "工具调用轮次已达上限，回复基于既有观察"},
                    step_id="error:1",
                )

        await ctx.emit(
            "end",
            {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id},
        )
        return {"reply": reply, "done": True}

    async def finish(ctx):
        return {}

    g = Graph(name="forge_round", entry="agent")
    g.add_node("agent", agent)
    g.add_node("finish", finish)
    g.add_edge("agent", "finish")
    g.add_exit("finish")
    return g


async def _build_ui_context_note(storage: Storage) -> str | None:
    """用户位置感知汇入：最近位置快照 + 最近交互事件摘要。

    感知环节的最小形态（调配器源注册随能力接入后并入预算/留痕）：
    字段白名单已由上报端点把关，此处只读取组文。读取失败静默跳过
    ——感知是增强不是收紧，不击穿回合。
    """
    try:
        snapshot = await storage.get_record(_UI_CONTEXT_COLLECTION, "latest")
        records = await storage.list_records(_UI_EVENTS_COLLECTION)
    except Exception as exc:
        logger.debug("ui_context 读取失败: %s", exc)
        return None
    lines: list[str] = []
    if snapshot:
        for key in ("active_app", "active_view", "current_layout", "focused_component"):
            value = snapshot.get(key)
            if value:
                lines.append(f"- {key}：{value}")
        selection = snapshot.get("selection")
        if selection:
            lines.append(f"- 选中内容：{selection[:_UI_SELECTION_MAX_CHARS]}")
    for record in records[-_UI_EVENTS_WINDOW:]:
        etype = record.get("type")
        component = record.get("component")
        if etype:
            lines.append(f"- 最近交互：{etype} {component or ''}".rstrip())
    if not lines:
        return None
    return "## 用户位置感知（ui_context）\n" + "\n".join(lines)


async def execute_tool(ctx, pipeline, specs_by_name, messages, call) -> None:
    """执行一次元工具调用：事件发布 + 工具流水线 + 结果回填消息。"""
    step_id = f"tool:{call.id}"
    await ctx.emit(
        "tool_start",
        {"tool": call.name, "category": TOOL_CATEGORY, "tool_call_id": call.id},
        step_id=step_id,
    )
    spec = specs_by_name.get(call.name)
    if spec is None:
        await ctx.emit(
            "tool_end",
            {
                "tool": call.name,
                "category": TOOL_CATEGORY,
                "tool_call_id": call.id,
                "success": False,
                "message": f"未知工具: {call.name}",
            },
            step_id=step_id,
        )
        messages.append(tool_result(f"未知工具: {call.name}", call.id))
        return
    try:
        args = call.parse_arguments(strict=True)
        outcome = await pipeline.execute(ctx, spec, args)
        text = outcome.output if outcome.ok else f"执行被拒: {outcome.error}"
        success = outcome.ok
    except Exception as exc:
        logger.warning("工具执行异常 %s: %s", call.name, exc)
        text = f"执行异常: {exc}"
        success = False
    await ctx.emit(
        "tool_end",
        {
            "tool": call.name,
            "category": TOOL_CATEGORY,
            "tool_call_id": call.id,
            "success": success,
            "message": text[:200],
        },
        step_id=step_id,
    )
    messages.append(tool_result(text[:TOOL_RESULT_MAX_CHARS], call.id))

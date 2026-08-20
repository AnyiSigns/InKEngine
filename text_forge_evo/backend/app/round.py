"""自举回合循环：图级 LLM 工具循环 + 审批挂起重入。

回合以引擎图承载：agent（LLM 流式对话与工具决策）→ exec_tool
（工具执行，审批挂起/注入重入在此发生）→ 条件边回 agent 或收尾。
工具循环进度（消息流/待执行工具/回复/思考计数）全部放状态通道——
审批挂起（interrupt）的 checkpoint 快照保留节点返回的通道更新，
重入时从快照恢复，不丢消息流与待执行工具（节点内进度走通道、
不依赖节点局部变量，与引擎中断语义对齐）。

回合内事件（对齐前端事件协议）：
- thinking_start/token/end：模型推理过程（reasoning_content 透传）；
- tool_start/tool_end：工具调用（category=query，展示「查询」类）；
- reply_token：回复正文流（按 step_id=reply:1 归属正文段）；
- review_card：审批挂起卡（pipeline 挂卡后回合挂起，决议注入重入）；
- end：回合收尾（携带 reply/thread_id/round_id）；
- error：执行失败（LLM/工具异常兜底，引擎另有节点级兜底双保险）。
"""
from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from ink_engine.core.assembly import SOURCE_EVIDENCE
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
from ink_engine.core.llm.tools import ToolSpec
from ink_engine.core.storage import Storage
from ink_engine.core.tool_pipeline import ToolPipeline
from ink_engine.seeds.boot import BOOT_SYSTEM_PROMPT

logger = logging.getLogger(__name__)

MAX_TOOL_ROUNDS = 6
REPLY_STEP_ID = "reply:1"
TOOL_CATEGORY = "query"
TOOL_RESULT_MAX_CHARS = 4000

# 工具循环进度的状态通道键（节点返回的通道更新随 checkpoint 快照
# 保留——审批挂起重入时从状态通道恢复，不丢消息流与待执行工具）
_STATE_MESSAGES = "messages"
_STATE_PENDING_TOOLS = "pending_tools"
_STATE_REPLY = "reply"
_STATE_THINKING_COUNT = "thinking_count"
_STATE_TOOL_ROUNDS = "tool_rounds"
_STATE_NEXT = "next"

# 图路由值（条件边判定依据）
_NEXT_AGENT = "agent"
_NEXT_EXEC_TOOL = "exec_tool"
_NEXT_FINISH = "finish"

# ui_context 感知：机制通道集合名与汇入窗口（与上报端点对齐）
_UI_CONTEXT_COLLECTION = "ui_context"
_UI_EVENTS_COLLECTION = "ui_events"
_UI_EVENTS_WINDOW = 5
_UI_SELECTION_MAX_CHARS = 120

# 自举系统提示词（来自 boot 种子，AI 自描述与工具约定）
SYSTEM_PROMPT = BOOT_SYSTEM_PROMPT


def build_forge_graph(
    llm: AsyncLLM,
    pipeline: ToolPipeline,
    tool_specs: Sequence[ToolSpec],
    *,
    system_prompt: str = SYSTEM_PROMPT,
    storage: Storage | None = None,
) -> Graph:
    """装配回合图（图级工具循环：agent → exec_tool ⇄ agent → finish）。

    storage 注入 ui_context 感知数据源（位置快照 + 交互事件摘要）；
    缺省 None = 感知禁用（回合照常执行，感知是增强不是收紧）。
    """

    specs_by_name = {spec.name: spec for spec in tool_specs}

    async def _restore_messages(ctx) -> list[Message]:
        """消息流恢复：状态通道优先（挂起重入/多轮工具循环续跑），
        无则按常规路径装配（系统提示 + 用户输入 + 感知/证据汇入）。"""
        raw = ctx.state.get(_STATE_MESSAGES)
        if isinstance(raw, list):
            return [Message.from_dict(item) for item in raw if isinstance(item, dict)]
        messages: list[Message] = [system(system_prompt)]
        notes: list[str] = []
        if storage is not None:
            ui_note = await _build_ui_context_note(storage)
            if ui_note:
                notes.append(ui_note)
        # 调配器证据汇入：检索结果经输入调配预装配（RunOptions.assembly
        # 装配 evidence 源），此处取预装配产物拼入上下文——未启用/无
        # 检索结果时静默跳过（感知与检索是增强不是收紧，不击穿回合）
        assembled = await _preassembled_evidence(ctx)
        if assembled:
            notes.append("## 检索证据（经调配器注入）\n" + assembled)
        for note in notes:
            messages.append(system(note))
        input_text = str(ctx.state.get("input") or "").strip()
        messages.append(user(input_text))
        return messages

    async def agent(ctx):
        thread_id = str(ctx.state.get("thread_id") or "")
        messages = await _restore_messages(ctx)
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        thinking_count = int(ctx.state.get(_STATE_THINKING_COUNT) or 0)
        tool_rounds = int(ctx.state.get(_STATE_TOOL_ROUNDS) or 0)
        # 工具轮次耗尽：停止追问，把既有回复收尾
        if tool_rounds >= MAX_TOOL_ROUNDS:
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
            return {
                _STATE_REPLY: reply,
                _STATE_NEXT: _NEXT_FINISH,
            }

        content_part = ""
        deltas: list[Any] = []
        thinking_step: str | None = None
        try:
            stream = llm.astream(messages, tools=list(tool_specs) or None, params=None)
            async for chunk in stream:
                if chunk.reasoning_token:
                    if thinking_step is None:
                        thinking_count += 1
                        thinking_step = f"thinking:{thinking_count}"
                        await ctx.emit("thinking_start", {}, step_id=thinking_step)
                    await ctx.emit(
                        "thinking_token",
                        {"token": chunk.reasoning_token},
                        step_id=thinking_step,
                    )
                else:
                    # 推理段结束边界：首个非推理增量（正文/工具调用）
                    # 出现即收尾思考卡，正文流不悬挂在思考段之后
                    if thinking_step is not None:
                        await ctx.emit("thinking_end", {}, step_id=thinking_step)
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
                {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id},
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: _NEXT_FINISH}
        if thinking_step is not None:
            await ctx.emit("thinking_end", {}, step_id=thinking_step)

        calls = accumulate_tool_calls(deltas)
        messages.append(assistant(content_part or "", tool_calls=calls or None))
        if not calls:
            await ctx.emit(
                "end",
                {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id},
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: _NEXT_FINISH}
        # 有待执行工具：进度落状态通道（快照保留），路由到工具执行节点
        return {
            _STATE_MESSAGES: [m.to_dict() for m in messages],
            _STATE_PENDING_TOOLS: [_tool_call_to_dict(call) for call in calls],
            _STATE_REPLY: reply,
            _STATE_THINKING_COUNT: thinking_count,
            _STATE_TOOL_ROUNDS: tool_rounds + 1,
            _STATE_NEXT: _NEXT_EXEC_TOOL,
        }

    async def exec_tool(ctx):
        thread_id = str(ctx.state.get("thread_id") or "")
        reply = str(ctx.state.get(_STATE_REPLY) or "")
        messages = await _restore_messages(ctx)
        pending = ctx.state.get(_STATE_PENDING_TOOLS) or []
        if not pending:
            # 防御：无待执行工具却路由到本节点 → 直接收尾（不静默死循环）
            await ctx.emit(
                "end",
                {"reply": reply, "thread_id": thread_id, "round_id": ctx.round_id},
            )
            return {_STATE_REPLY: reply, _STATE_NEXT: _NEXT_FINISH}
        call = _tool_call_from_dict(pending[0])
        # 工具执行：审批挂起（interrupt）在此发生——挂卡后回合挂起，
        # 决议注入重入本节点（interrupt 返回注入值后按决议继续）；
        # 挂起前把剩余待执行工具保留在状态通道（快照承载）
        await execute_tool(ctx, pipeline, specs_by_name, messages, call)
        remaining = pending[1:]
        return {
            _STATE_MESSAGES: [m.to_dict() for m in messages],
            _STATE_PENDING_TOOLS: remaining,
            _STATE_REPLY: reply,
            _STATE_NEXT: _NEXT_AGENT,  # 回 agent：消息流已回填，LLM 继续决策
        }

    async def finish(ctx):
        return {}

    async def route_after_agent(ctx):
        return ctx.state.get(_STATE_NEXT, _NEXT_FINISH) == _NEXT_EXEC_TOOL

    def route_to_finish(ctx):
        return ctx.state.get(_STATE_NEXT, _NEXT_FINISH) != _NEXT_EXEC_TOOL

    g = Graph(name="forge_round", entry="agent")
    g.add_node("agent", agent)
    g.add_node("exec_tool", exec_tool)
    g.add_node("finish", finish)
    g.add_conditional_edge("agent", "exec_tool", route_after_agent)
    g.add_conditional_edge("agent", "finish", route_to_finish)
    g.add_edge("exec_tool", "agent")
    g.add_exit("finish")
    return g


def _tool_call_to_dict(call: ToolCall) -> dict:
    """工具调用 → 状态通道可序列化形态（id/name/arguments，arguments
    为 JSON 字符串——与 ToolCall 数据契约一致）。"""
    return {"id": call.id, "name": call.name, "arguments": call.arguments}


def _tool_call_from_dict(data: dict) -> ToolCall:
    """状态通道形态 → 工具调用对象（id/name/arguments 三字段契约）。"""
    return ToolCall(
        id=str(data.get("id") or ""),
        name=str(data.get("name") or ""),
        arguments=str(data.get("arguments") or ""),
    )


async def _preassembled_evidence(ctx) -> str:
    """取节点预装配的检索证据文本（input_assembly 产物）。

    预装配未启用（RunOptions.assembly=None）/无源提供者/装配失败 =
    返回空（调用点静默跳过）。装配产物文本 = 激活源组装结果——
    当前回合只注入 evidence 源，文本即检索证据块。
    """
    try:
        result = await ctx.assemble([])
    except Exception:
        return ""
    if not result.record.sources:
        return ""
    evidence = [
        s for s in result.record.sources if s.source_type == SOURCE_EVIDENCE
    ]
    if not evidence:
        return ""
    return result.text


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
    """执行一次工具调用：事件发布 + 工具流水线 + 结果回填消息。"""
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

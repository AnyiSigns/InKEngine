"""终端事件传输（Forge shell 的第二个原生事件传输）。

引擎事件信封 → 终端文本行：与 QueueTransport（SSE 桥）同为
EngineTransport 接口实现，消费端从浏览器变为终端。渲染语义：
状态行即时输出（思考/工具），正文 token 缓冲至回合收尾统一打印
（终端对话的可读形态）；附加模式（CLI 经 HTTP 附加到运行中的
Web 实例）复用同一渲染函数——直播 = 回放不变。
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from contextlib import suppress
from typing import Any

from ink_engine.core.events import EngineEvent, EngineTransport

# 终端写入回调（默认可重定向 stdout；测试注入收集器）
Writer = Callable[[str], None]


def stdout_writer() -> Writer:
    """标准输出写入器（Windows 控制台按 UTF-8 重配置，防中文乱码）。"""
    stream = sys.stdout
    with suppress(Exception):
        stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    return lambda text: stream.write(text + "\n")


def frame_of(event: EngineEvent) -> dict[str, Any]:
    """事件信封 → 摊平帧（payload 字段上提，同 SSE 桥协议原生形态）。"""
    data = event.to_dict()
    payload = data.pop("payload") or {}
    data.update(payload)
    return data


class TerminalTransport(EngineTransport):
    """引擎事件 → 终端文本（单回合 CLI 与交互终端共用）。

    状态事件即时渲染；正文 token 与思考 token 缓冲，收尾统一打印
    （end 输出完整回复，thinking_end 输出该段思考）——终端流式逐
    token 刷屏噪音大，聚合输出是可读性的取舍。
    """

    def __init__(self, write: Writer | None = None) -> None:
        self._write = write or stdout_writer()
        self._thinking: list[str] = []
        self._reply: list[str] = []

    async def send(self, event: EngineEvent) -> None:
        frame = frame_of(event)
        render_frame(frame, self._write, self._thinking, self._reply)


def render_frame(
    frame: dict[str, Any],
    write: Writer,
    thinking: list[str] | None = None,
    reply: list[str] | None = None,
) -> None:
    """摊平帧 → 终端文本行（附加模式与本地传输共用同一渲染）。"""
    etype = frame.get("type")
    if etype == "thinking_start":
        write("[思考]")
    elif etype == "thinking_token":
        # 段内 token 拼接（多 token 流合并为一段）
        if thinking is not None:
            token = str(frame.get("token") or "")
            if token:
                if thinking:
                    thinking[-1] += token
                else:
                    thinking.append(token)
    elif etype == "thinking_end":
        if thinking and thinking[-1].strip():
            write(f"  {thinking[-1].strip()}")
        if thinking is not None:
            thinking.append("")  # 段分隔
    elif etype == "tool_start":
        write(f"[工具] {frame.get('tool') or frame.get('tool_call_id') or ''} 调用中")
    elif etype == "tool_end":
        success = frame.get("success")
        message = str(frame.get("message") or "")[:120]
        status = "完成" if success is not False else "失败"
        write(f"[工具] {frame.get('tool') or ''} {status}{' · ' + message if message else ''}")
    elif etype == "reply_token":
        if reply is not None:
            reply.append(str(frame.get("token") or ""))
    elif etype == "end":
        text = "".join(reply or [])
        write(f"Forge: {text}")
    elif etype == "error":
        write(f"[错误] {frame.get('message') or '回合执行失败'}")
    elif etype in ("heartbeat", "tool_audit"):
        # 静默信号：工具卡/正文行已承载其展示，不刷终端
        pass
    elif etype == "plan_start":
        # 规划卡：终端一行摘要（与前端 PlanRow 同义）
        write(f"[规划] {str(frame.get('plan') or frame.get('summary') or '开始规划')[:120]}")
    elif etype == "node_start":
        write(f"[节点] {frame.get('node_id') or frame.get('node_label') or '节点开始'}")
    elif etype == "suggestions":
        items = frame.get("items")
        if isinstance(items, list) and items:
            write(f"[建议] {len(items)} 条候选，首条：{str(items[0])[:100]}")
        else:
            write("[建议] 回合收尾建议")
    elif etype == "review_card":
        # 审核卡：审批通道接入前终端只读提示（不回传决议，不伪造审批）
        write("[审核] 弹卡待确认（终端审批通道尚未接入，请经 Web 面板处理）")
    else:
        # 未注册/未知类型折叠兜底：终端一行摘要（不崩，可审计）
        write(f"[事件] {etype}（未渲染，原始帧 {str(frame)[:160]}…）")

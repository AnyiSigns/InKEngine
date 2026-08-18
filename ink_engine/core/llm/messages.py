"""自写消息数据类与工具调用增量累积（替代 langchain 消息类型）。

消息 = 单一 Message 数据类（role/content/tool_calls/tool_call_id/reasoning），
工厂函数按角色构造；to_openai_dict 序列化为 OpenAI 兼容请求负载。
工具调用以增量形式从流式 chunk 累积（accumulate_tool_calls 按 index 合并），
与 OpenAI 兼容协议的工具调用分片语义一一对应。
"""
from __future__ import annotations

import json
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from ink_engine.core.llm.errors import LLMConfigError, LLMFormatError

_ROLES = frozenset({"system", "user", "assistant", "tool"})

# 历史/外部消息形态的角色别名（LangChain 系 human/ai 命名 → 引擎规范角色）
_ROLE_ALIASES = {"human": "user", "ai": "assistant"}


@dataclass(frozen=True, slots=True)
class ToolCallDelta:
    """工具调用增量帧（按 index 归属一次调用，流式累积用）。"""

    index: int
    id: str | None = None
    name: str | None = None
    arguments_delta: str | None = None


@dataclass(slots=True)
class ToolCall:
    """一次工具调用（增量累积过程中可变——accumulate_tool_calls 就地补全）。"""

    id: str
    name: str
    arguments: str = ""

    @property
    def parsed_arguments(self) -> dict[str, Any]:
        """容错解析 arguments JSON（未完成/非法时返回空 dict，不抛错）。"""
        return self.parse_arguments()

    def parse_arguments(self, *, strict: bool = False) -> dict[str, Any]:
        """解析 arguments JSON。

        容错（默认）：未完成/非法返回空 dict——流式累积中的截断碎片是
        常态，容忍解析不抛错；调用方在**执行前**须用 strict=True 校验
        完整参数（防"参数被截断却以空参数执行"的静默降级）。
        strict=True：非法/非对象 JSON 抛 LLMFormatError，调用方显式拒绝。
        """
        if not self.arguments.strip():
            if strict:
                raise LLMFormatError("工具调用参数为空或未完成")
            return {}
        try:
            value = json.loads(self.arguments)
        except json.JSONDecodeError:
            if strict:
                raise LLMFormatError("工具调用参数非法（非完整 JSON）") from None
            return {}
        if not isinstance(value, dict):
            if strict:
                raise LLMFormatError("工具调用参数须为 JSON 对象")
            return {}
        return value


@dataclass(slots=True)
class Message:
    """聊天消息（system/user/assistant/tool 四角色）。

    Args:
        id: 消息唯一 id（add_messages 按 id 去重/RemoveMessage 删除；None = 追加不去重，
            构造时未显式提供则自动生成——对齐 langchain 消息 id 语义）。
        role: 角色（system/user/assistant/tool）。
        content: 文本内容（assistant 可为空——纯工具调用消息）。
        tool_call_id: tool 角色必填，回指 assistant 的工具调用 id。
        tool_calls: assistant 角色的工具调用列表（历史消息回传用）。
        reasoning: assistant 的推理文本（历史消息回传时可选携带，
            当前轮推理以流式 reasoning_token 增量产出，不入此字段）。
    """

    role: str
    content: str = ""
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None
    reasoning: str | None = None
    id: str | None = None

    def __post_init__(self) -> None:
        if self.role not in _ROLES:
            raise LLMConfigError(f"非法消息角色: {self.role!r}")
        if self.role == "tool" and not self.tool_call_id:
            raise LLMConfigError("tool 角色消息必须携带 tool_call_id")
        if self.id is None:
            self.id = uuid.uuid4().hex

    def to_openai_dict(self) -> dict[str, Any]:
        """序列化为 OpenAI 兼容请求负载。"""
        if self.role == "tool":
            return {"role": "tool", "content": self.content, "tool_call_id": self.tool_call_id}
        payload: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.role == "assistant" and self.tool_calls:
            payload["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.name, "arguments": tc.arguments},
                }
                for tc in self.tool_calls
            ]
        return payload

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            "tool_call_id": self.tool_call_id,
            "tool_calls": (
                [
                    {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                    for tc in self.tool_calls
                ]
                if self.tool_calls
                else None
            ),
            "reasoning": self.reasoning,
            "id": self.id,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Message:
        tool_calls = data.get("tool_calls")
        return cls(
            role=data["role"],
            content=data.get("content", ""),
            tool_call_id=data.get("tool_call_id"),
            tool_calls=(
                [ToolCall(**tc) for tc in tool_calls] if tool_calls else None
            ),
            reasoning=data.get("reasoning"),
            id=data.get("id"),
        )


def system(text: str) -> Message:
    return Message(role="system", content=text)


def user(text: str) -> Message:
    return Message(role="user", content=text)


def assistant(text: str = "", *, tool_calls: list[ToolCall] | None = None, reasoning: str | None = None) -> Message:
    return Message(role="assistant", content=text, tool_calls=tool_calls, reasoning=reasoning)


def tool_result(content: str, tool_call_id: str) -> Message:
    return Message(role="tool", content=content, tool_call_id=tool_call_id)


def message_role(msg: Any) -> str:
    """任意消息形态的角色归一（system/user/assistant/tool）。

    消息在引擎执行期统一为 Message，但状态通道里可能混入宿主注入的 dict
    形态（初始输入、删除标记）或历史遗留的鸭子类型消息类——上下文投影、
    窗口裁剪等原语需要一个总函数来判角色，不能假定单一形态。

    识别顺序：

    1. ``role`` 属性（引擎 Message，规范角色直接透传）；
    2. dict 的 ``role`` / ``type`` 键（``type`` 是宿主注入形态的常用键）；
    3. 类名兜底（去掉 ``Message`` 后缀，如 ``AIMessage`` → assistant）。

    human/ai 别名统一归一为 user/assistant；无法识别时返回小写类名或空串，
    调用方按「非已知角色」处理即可（不抛错，防迁移期偶发形态崩）。
    """
    role = getattr(msg, "role", None)
    if role is not None:
        role = str(role)
        return _ROLE_ALIASES.get(role, role)
    if isinstance(msg, dict):
        raw = str(msg.get("role") or msg.get("type") or "")
        return _ROLE_ALIASES.get(raw, raw)
    name = type(msg).__name__.lower()
    # 后缀剥离后为空（类名恰为 "Message"）时退回原类名，避免归一成空串
    stem = name.removesuffix("message") or name
    return _ROLE_ALIASES.get(stem, stem)


def accumulate_tool_calls(deltas: Iterable[ToolCallDelta]) -> list[ToolCall]:
    """按 index 合并流式工具调用增量。

    OpenAI 兼容协议把一次工具调用拆成多个 delta（id/name 首次出现，
    arguments 逐帧拼接）；本函数按 index 累积为完整 ToolCall 列表
    （保持首次出现顺序，index 乱序时仍按首见序输出）。
    """
    by_index: dict[int, ToolCall] = {}
    order: list[int] = []
    for delta in deltas:
        tc = by_index.get(delta.index)
        if tc is None:
            tc = by_index[delta.index] = ToolCall(id=delta.id or "", name=delta.name or "", arguments="")
            order.append(delta.index)
        if delta.id:
            tc.id = delta.id
        if delta.name:
            tc.name = delta.name
        if delta.arguments_delta:
            tc.arguments += delta.arguments_delta
    return [by_index[i] for i in order]


__all__ = [
    "Message",
    "ToolCall",
    "ToolCallDelta",
    "accumulate_tool_calls",
    "assistant",
    "message_role",
    "system",
    "tool_result",
    "user",
]

"""自写消息数据类与工具调用增量累积。

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

# 历史/外部消息形态的角色别名（human/ai 命名 → 引擎规范角色）
_ROLE_ALIASES = {"human": "user", "ai": "assistant"}

# 支持的附件类型（多模态消息的附件类别；kind 枚举化防魔法字符串）
_ATTACHMENT_KINDS = frozenset({"image", "video", "document"})

# 附件序列化段类型映射：OpenAI 兼容请求只原生定义 image_url 段；
# video/document 按同族收敛形态（<kind>_url，与 Qwen/GLM 等多模态
# 端点惯例一致），适配器按后端支持裁剪（附件由宿主显式声明，
# 声明方负责后端兼容性）。
_ATTACHMENT_SEGMENT_TYPES = {
    "image": "image_url",
    "video": "video_url",
    "document": "document_url",
}


@dataclass(frozen=True, slots=True)
class Attachment:
    """多模态附件元数据（附加在 user 消息上的附件段）。

    Attributes:
        kind: 附件类型（image/video/document）。
        url: 附件远端地址（http/https/data URI；适配器可直接请求的形态）。
        path: 附件本地路径（宿主/本地端点可解析；url 缺省时作为回退引用）。
        mime_type: MIME 类型（如 image/png）。
        alt: 替代文本（辅助功能与降级展示）。
        width/height: 像素尺寸（image 类型）。
        duration: 时长（秒，video 类型）。
        name: 原始文件名（展示/诊断）。
    """

    kind: str = "image"
    url: str | None = None
    path: str | None = None
    mime_type: str | None = None
    alt: str | None = None
    width: int | None = None
    height: int | None = None
    duration: float | None = None
    name: str | None = None

    def __post_init__(self) -> None:
        if self.kind not in _ATTACHMENT_KINDS:
            raise LLMConfigError(f"非法附件类型: {self.kind!r}")
        if not self.url and not self.path:
            raise LLMConfigError("附件必须携带 url 或 path（引用缺失无法发送）")

    @property
    def ref(self) -> str:
        """引用值：url 优先，缺省回落 path（本地端点场景）。"""
        return self.url or self.path or ""

    def to_openai_segment(self) -> dict[str, Any]:
        """序列化为 OpenAI 兼容多模态内容段（{type: <segment>, <segment>: {url}}）。"""
        segment = _ATTACHMENT_SEGMENT_TYPES[self.kind]
        return {"type": segment, segment: {"url": self.ref}}

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "url": self.url,
            "path": self.path,
            "mime_type": self.mime_type,
            "alt": self.alt,
            "width": self.width,
            "height": self.height,
            "duration": self.duration,
            "name": self.name,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Attachment:
        fields = (
            "kind",
            "url",
            "path",
            "mime_type",
            "alt",
            "width",
            "height",
            "duration",
            "name",
        )
        return cls(**{f: data.get(f) for f in fields})


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
            构造时未显式提供则自动生成）。
        role: 角色（system/user/assistant/tool）。
        content: 文本内容（assistant 可为空——纯工具调用消息）。
        tool_call_id: tool 角色必填，回指 assistant 的工具调用 id。
        tool_calls: assistant 角色的工具调用列表（历史消息回传用）。
        reasoning: assistant 的推理文本（历史消息回传时可选携带，
            当前轮推理以流式 reasoning_token 增量产出，不入此字段）。
        attachments: user 角色的多模态附件（默认空元组；携带时
            to_openai_dict 以内容段数组形态序列化）。
    """

    role: str
    content: str = ""
    tool_call_id: str | None = None
    tool_calls: list[ToolCall] | None = None
    reasoning: str | None = None
    id: str | None = None
    attachments: tuple[Attachment, ...] = ()

    def __post_init__(self) -> None:
        if self.role not in _ROLES:
            raise LLMConfigError(f"非法消息角色: {self.role!r}")
        if self.role == "tool" and not self.tool_call_id:
            raise LLMConfigError("tool 角色消息必须携带 tool_call_id")
        if self.id is None:
            self.id = uuid.uuid4().hex
        # 归一为不可变元组（list/dict 形态的宽容入参 → 规范形态），
        # 保持消息可哈希引用语义（tuple 字段冻结，序列化确定性）
        self.attachments = tuple(
            a if isinstance(a, Attachment) else Attachment.from_dict(a)
            for a in self.attachments
        )

    def to_openai_dict(self) -> dict[str, Any]:
        """序列化为 OpenAI 兼容请求负载。

        user 消息携带附件时 content 序列化为多模态内容段数组
        （[{"type": "text", ...}, {"type": "image_url", ...}, ...]）；
        无附件时输出形态与既往逐字段一致（回归零影响）。
        """
        if self.role == "tool":
            return {"role": "tool", "content": self.content, "tool_call_id": self.tool_call_id}
        if self.role == "user" and self.attachments:
            content: list[dict[str, Any]] = []
            if self.content:
                content.append({"type": "text", "text": self.content})
            content.extend(a.to_openai_segment() for a in self.attachments)
            return {"role": "user", "content": content}
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
            "attachments": (
                [a.to_dict() for a in self.attachments] if self.attachments else None
            ),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Message:
        tool_calls = data.get("tool_calls")
        attachments = data.get("attachments")
        return cls(
            role=data["role"],
            content=data.get("content", ""),
            tool_call_id=data.get("tool_call_id"),
            tool_calls=(
                [ToolCall(**tc) for tc in tool_calls] if tool_calls else None
            ),
            reasoning=data.get("reasoning"),
            id=data.get("id"),
            attachments=(
                tuple(Attachment.from_dict(a) for a in attachments)
                if attachments
                else ()
            ),
        )


def system(text: str) -> Message:
    return Message(role="system", content=text)


def user(
    text: str,
    *,
    attachments: Iterable[Attachment] | None = None,
) -> Message:
    return Message(
        role="user",
        content=text,
        attachments=tuple(attachments or ()),
    )


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
    "Attachment",
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

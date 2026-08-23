"""附件多模态消息单测：Attachment 元数据 + 多模态序列化 + 事件类别。

覆盖：Attachment 默认值/非法拒绝/引用判定；user 消息携带附件时
to_openai_dict 输出多模态内容段数组（text+image_url/video_url/
document_url）；无附件时输出形态与既往逐字段一致（回归零影响）；
Message to_dict/from_dict 往返保持附件；附件事件类别声明可注册。
"""
from __future__ import annotations

import pytest

from ink_engine.core.event_types import (
    DEFAULT_ATTACHMENT_EVENT_NAME,
    DEFAULT_ATTACHMENT_RENDERER,
    EventTypeRegistry,
    attachment_event_spec,
)
from ink_engine.core.llm.errors import LLMConfigError
from ink_engine.core.llm.messages import (
    Attachment,
    Message,
    ToolCall,
    assistant,
    system,
    tool_result,
    user,
)


class TestAttachment:
    def test_defaults_are_complete(self):
        """全默认字段齐全（kind=image，其余 None/缺省）。"""
        att = Attachment(kind="image", url="https://x/a.png")
        assert att.kind == "image"
        assert att.url == "https://x/a.png"
        assert att.path is None
        assert att.mime_type is None
        assert att.alt is None
        assert att.width is None
        assert att.height is None
        assert att.duration is None
        assert att.name is None

    def test_kind_validated(self):
        with pytest.raises(LLMConfigError, match="非法附件类型"):
            Attachment(kind="audio", url="u")
        for kind in ("image", "video", "document"):
            Attachment(kind=kind, url="u")

    def test_ref_requires_url_or_path(self):
        with pytest.raises(LLMConfigError, match="url 或 path"):
            Attachment(kind="image")

    def test_ref_prefers_url_falls_back_to_path(self):
        assert Attachment(kind="image", url="u", path="p").ref == "u"
        assert Attachment(kind="video", path="p").ref == "p"

    def test_to_openai_segment_shapes(self):
        att = Attachment(kind="image", url="https://x/a.png")
        assert att.to_openai_segment() == {
            "type": "image_url",
            "image_url": {"url": "https://x/a.png"},
        }
        video = Attachment(kind="video", path="v.mp4")
        assert video.to_openai_segment() == {
            "type": "video_url",
            "video_url": {"url": "v.mp4"},
        }
        doc = Attachment(kind="document", url="doc.pdf")
        assert doc.to_openai_segment() == {
            "type": "document_url",
            "document_url": {"url": "doc.pdf"},
        }

    def test_to_dict_from_dict_round_trip(self):
        att = Attachment(
            kind="video",
            url="https://x/v.mp4",
            mime_type="video/mp4",
            alt="演示视频",
            duration=3.5,
            name="demo.mp4",
            width=1920,
            height=1080,
        )
        restored = Attachment.from_dict(att.to_dict())
        assert restored == att


class TestMessageAttachments:
    def test_user_message_serializes_multimodal_content_array(self):
        msg = user(
            "描述这张图",
            attachments=(
                Attachment(kind="image", url="https://x/a.png", alt="示意图"),
                Attachment(kind="video", path="v.mp4"),
            ),
        )
        assert msg.to_openai_dict() == {
            "role": "user",
            "content": [
                {"type": "text", "text": "描述这张图"},
                {
                    "type": "image_url",
                    "image_url": {"url": "https://x/a.png"},
                },
                {"type": "video_url", "video_url": {"url": "v.mp4"}},
            ],
        }

    def test_content_empty_omits_text_segment(self):
        msg = user("", attachments=(Attachment(kind="image", url="u"),))
        assert msg.to_openai_dict() == {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": "u"}},
            ],
        }

    def test_attachments_only_on_user_role(self):
        """非 user 角色的附件字段被忽略（输出形态与既往一致）。"""
        m = Message(
            role="assistant", content="ok",
            attachments=(Attachment(kind="image", url="u"),),
        )
        assert m.to_openai_dict() == {"role": "assistant", "content": "ok"}
        m2 = Message(
            role="system", content="s",
            attachments=(Attachment(kind="image", url="u"),),
        )
        assert m2.to_openai_dict() == {"role": "system", "content": "s"}

    def test_no_attachments_byte_identical_output(self):
        """无附件：四角色输出形态与既往逐字段一致（回归零影响）。"""
        assert user("u").to_openai_dict() == {"role": "user", "content": "u"}
        assert system("s").to_openai_dict() == {"role": "system", "content": "s"}
        assert assistant("a").to_openai_dict() == {"role": "assistant", "content": "a"}
        assert tool_result("r", "c1").to_openai_dict() == {
            "role": "tool",
            "content": "r",
            "tool_call_id": "c1",
        }
        m = assistant(
            "",
            tool_calls=[
                ToolCall(id="call_1", name="get_weather", arguments='{"city": "北京"}')
            ],
        )
        assert m.to_openai_dict() == {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "get_weather", "arguments": '{"city": "北京"}'},
                }
            ],
        }

    def test_to_dict_from_dict_preserves_attachments(self):
        msg = user(
            "看图",
            attachments=(
                Attachment(kind="image", url="https://x/a.png"),
                Attachment(kind="document", path="doc.pdf", name="doc.pdf"),
            ),
        )
        restored = Message.from_dict(msg.to_dict())
        assert restored == msg
        assert restored.to_openai_dict() == msg.to_openai_dict()

    def test_positional_construction_compat(self):
        """位置参数形态（既往构造调用）不受新字段影响。"""
        m = Message("user", "hi", None, None, None, None)
        assert m.role == "user" and m.content == "hi"
        assert m.attachments == ()
        m2 = Message("user", "hi", attachments=(Attachment(kind="image", url="u"),))
        assert m2.attachments[0].kind == "image"

    def test_attachment_sequence_immutable_tuple(self):
        """附件归一为元组（构造入参宽容，存储形态不可变）。"""
        m = user("u", attachments=[Attachment(kind="image", url="u")])
        assert isinstance(m.attachments, tuple)
        assert len(m.attachments) == 1


class TestAttachmentEventCategory:
    def test_spec_defaults(self):
        spec = attachment_event_spec()
        assert spec.name == DEFAULT_ATTACHMENT_EVENT_NAME
        assert spec.renderer == DEFAULT_ATTACHMENT_RENDERER
        assert spec.system is False
        assert spec.schema is None

    def test_spec_customizable(self):
        spec = attachment_event_spec(name="media.attachment", renderer="MediaRow")
        assert spec.name == "media.attachment"
        assert spec.renderer == "MediaRow"

    def test_spec_registers_in_registry(self):
        registry = EventTypeRegistry()
        registry.register(attachment_event_spec())
        assert DEFAULT_ATTACHMENT_EVENT_NAME in registry.names()
        assert registry.get(DEFAULT_ATTACHMENT_EVENT_NAME).renderer == (
            DEFAULT_ATTACHMENT_RENDERER
        )

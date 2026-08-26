"""components/review_card.py 测试：四类卡校验/截断/构造与门控分级。"""
from __future__ import annotations

import pytest

from ink_engine.core.review_card import (
    GATING_OVERRIDE_VALUES,
    PREVIEW_LIMIT_DEFAULT,
    GatingTier,
    build_audit_card,
    build_body_card,
    build_candidate_card,
    build_gate_card,
    gating_tier_of,
    preview_limit_for,
    truncate_preview,
    validate_card,
)


class TestValidateCard:
    def test_unknown_type_rejected(self):
        with pytest.raises(ValueError):
            validate_card({"review_type": "bogus"})

    def test_missing_required_field_rejected(self):
        with pytest.raises(ValueError):
            validate_card({"review_type": "gate", "node_id": "x"})  # 缺 node_label

    def test_negative_numeric_rejected(self):
        with pytest.raises(ValueError):
            validate_card(
                {
                    "review_type": "body",
                    "node_id": "generate_chapter",
                    "node_label": "生成",
                    "target_id": 1,
                    "chapter_index": -1,
                    "chapter_total": 3,
                }
            )

    def test_valid_card_truncates_preview(self):
        card = validate_card(
            {
                "review_type": "body",
                "node_id": "generate_chapter",
                "node_label": "生成",
                "target_id": 1,
                "chapter_index": 1,
                "chapter_total": 3,
                "preview_limit": 8000,
                "output_preview": "x" * 8050,
                "content": "x" * 8050,
            }
        )
        # content 全量保留（编辑回填），preview 按卡内 preview_limit 截断
        assert len(card["content"]) > 8000
        assert len(card["output_preview"]) <= 8020
        assert "已截断" in card["output_preview"]


class TestPreviewLimit:
    def test_limits_injected(self):
        limits = {"write_chapter_content": 8000, "update_entity": 6000}
        assert preview_limit_for("write_chapter_content", limits=limits) == 8000
        assert preview_limit_for("update_entity", limits=limits) == 6000

    def test_missing_limits_fallback_default(self):
        assert preview_limit_for("write_chapter_content") == PREVIEW_LIMIT_DEFAULT

    def test_default_tier(self):
        assert preview_limit_for("anything_else") == PREVIEW_LIMIT_DEFAULT
        assert preview_limit_for("") == PREVIEW_LIMIT_DEFAULT


class TestTruncatePreview:
    def test_returns_new_dict(self):
        card = {"node_id": "x", "output_preview": "short"}
        out = truncate_preview(card)
        assert out is not card

    def test_short_preview_untouched(self):
        card = {"node_id": "x", "output_preview": "short"}
        assert truncate_preview(card)["output_preview"] == "short"

    def test_missing_preview_treated_empty(self):
        out = truncate_preview({"node_id": "x"})
        assert out.get("output_preview", "") == ""


class TestBuilders:
    def test_build_gate_card_single(self):
        action = {"tool": "write_file", "args": {"path": "a.md"}, "summary": "写入 a.md"}
        card = build_gate_card(action)
        assert card["review_type"] == "gate"
        assert card["node_id"] == "write_file"
        assert card["node_label"] == "write_file"
        assert card["action"] == action
        assert card["output_preview"] == "写入 a.md"
        # 统一构建源：产出即过契约校验（四类卡同门禁）
        assert validate_card(card)["review_type"] == "gate"

    def test_build_gate_card_payload_override(self):
        action = {"tool": "write_file", "diff": "宿主摘要"}
        card = build_gate_card(
            action,
            payload={"node_id": "custom_node", "node_label": "自定义卡"},
        )
        assert card["node_id"] == "custom_node"  # 宿主 payload 优先
        assert card["review_type"] == "gate"  # 缺省字段补全
        assert card["output_preview"] == "宿主摘要"

    def test_build_gate_card_batch(self):
        actions = [{"tool": "a", "summary": "s1"}, {"tool": "b", "summary": "s2"}]
        card = build_gate_card(actions=actions)
        assert card["review_type"] == "gate"
        assert card["node_id"] == "approval_batch"
        assert card["node_label"] == "批量审批"
        assert len(card["actions"]) == 2
        assert "- a: s1" in card["output_preview"]
        assert "- b: s2" in card["output_preview"]

    def test_build_gate_card_actions_prefer_over_action(self):
        card = build_gate_card(
            {"tool": "single"},
            actions=[{"tool": "a", "summary": "s1"}],
            payload={"node_label": "批量"},
        )
        assert card["node_id"] == "approval_batch"  # actions 优先
        assert card["node_label"] == "批量"  # payload 字段优先
        assert "action" not in card

    def test_build_gate_card_preview_truncated(self):
        long_diff = "x" * 5000
        card = build_gate_card({"tool": "write_file", "diff": long_diff})
        assert len(card["output_preview"]) <= PREVIEW_LIMIT_DEFAULT + 20
        assert "已截断" in card["output_preview"]

    def test_build_gate_card_missing_fields_rejected(self):
        # payload 缺 node_id/node_label（无 action/actions 兜底）→ 契约拒绝
        with pytest.raises(ValueError):
            build_gate_card(payload={"output_preview": "无定位字段"})

    def test_build_body_card(self):
        card = build_body_card(1, 2, 3, "正文内容", "生成章节", node_id="generate_chapter")
        assert card["review_type"] == "body"
        assert card["content"] == "正文内容"
        assert card["target_id"] == 1
        assert card["chapter_index"] == 2
        assert card["chapter_total"] == 3

    def test_build_body_card_without_node_id_rejected(self):
        with pytest.raises(ValueError):
            build_body_card(1, 2, 3, "正文内容", "生成章节")

    def test_build_audit_card(self):
        card = build_audit_card("writer", "执笔", "wf-1", "输出", "不合格", 1)
        assert card["review_type"] == "audit"
        assert card["workflow_id"] == "wf-1"

    def test_build_candidate_card_workflow(self):
        card = build_candidate_card(
            1, "wf-1", [{"node_id": "n", "output": "x"}], source="workflow", node_id="workflow_candidate"
        )
        assert card["review_type"] == "candidate"
        assert card["source"] == "workflow"
        assert card["node_id"] == "workflow_candidate"

    def test_build_candidate_card_divergent(self):
        card = build_candidate_card(
            1, "divergent", [{"node_id": "d:0", "output": "x"}], source="divergent", node_id="divergent_draft"
        )
        assert card["source"] == "divergent"
        assert card["node_id"] == "divergent_draft"


class TestGatingTier:
    def test_default_is_l2(self):
        assert gating_tier_of("some_tool") is GatingTier.L2

    def test_registry_l1(self):
        registry = {"create_entities": GatingTier.L1}
        assert gating_tier_of("create_entities", registry=registry) is GatingTier.L1

    def test_registry_string_value(self):
        registry = {"create_entities": "l1"}
        assert gating_tier_of("create_entities", registry=registry) is GatingTier.L1

    def test_overrides_win(self):
        registry = {"create_entities": GatingTier.L1}
        assert (
            gating_tier_of("create_entities", overrides={"create_entities": "l2"}, registry=registry)
            is GatingTier.L2
        )

    def test_invalid_override_ignored(self):
        assert (
            gating_tier_of("t", overrides={"t": "l9"}) is GatingTier.L2
        )

    def test_override_values(self):
        assert frozenset({"l1", "l2", "l3"}) == GATING_OVERRIDE_VALUES

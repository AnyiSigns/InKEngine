"""components/review_card.py 测试：四类卡校验/截断/构造与门控分级。"""
from __future__ import annotations

import pytest

from ink_engine.components.review_card import (
    GATING_OVERRIDE_VALUES,
    PREVIEW_LIMIT_CHAPTER,
    PREVIEW_LIMIT_DEFAULT,
    GatingTier,
    build_audit_card,
    build_body_card,
    build_candidate_card,
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
                    "target_chapter_id": 1,
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
                "target_chapter_id": 1,
                "chapter_index": 1,
                "chapter_total": 3,
                "output_preview": "x" * (PREVIEW_LIMIT_CHAPTER + 50),
                "content": "x" * (PREVIEW_LIMIT_CHAPTER + 50),
            }
        )
        # content 全量保留（编辑回填），preview 截断
        assert len(card["content"]) > PREVIEW_LIMIT_CHAPTER
        assert len(card["output_preview"]) <= PREVIEW_LIMIT_CHAPTER + 20
        assert "已截断" in card["output_preview"]


class TestPreviewLimit:
    def test_chapter_tiers(self):
        assert preview_limit_for("write_chapter_content") == PREVIEW_LIMIT_CHAPTER
        assert preview_limit_for("generate_chapter") == PREVIEW_LIMIT_CHAPTER

    def test_entity_tier(self):
        from ink_engine.components.review_card import PREVIEW_LIMIT_ENTITY

        assert preview_limit_for("update_entity") == PREVIEW_LIMIT_ENTITY

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
    def test_build_body_card(self):
        card = build_body_card(1, 2, 3, "正文内容", "生成章节")
        assert card["review_type"] == "body"
        assert card["content"] == "正文内容"
        assert card["target_chapter_id"] == 1
        assert card["chapter_index"] == 2
        assert card["chapter_total"] == 3

    def test_build_audit_card(self):
        card = build_audit_card("writer", "执笔", "wf-1", "输出", "不合格", 1)
        assert card["review_type"] == "audit"
        assert card["workflow_id"] == "wf-1"

    def test_build_candidate_card_workflow(self):
        card = build_candidate_card(1, "wf-1", [{"node_id": "n", "output": "x"}], source="workflow")
        assert card["review_type"] == "candidate"
        assert card["source"] == "workflow"
        assert card["node_id"] == "workflow_candidate"

    def test_build_candidate_card_divergent(self):
        card = build_candidate_card(1, "divergent", [{"node_id": "d:0", "output": "x"}], source="divergent")
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

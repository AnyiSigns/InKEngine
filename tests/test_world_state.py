"""novel_harness/world_state.py 测试：世界状态图模型、状态更新、校验、涟漪扫描、分支。"""

from __future__ import annotations

import asyncio
import json

from ink_engine.novel_harness.narrative_state import (
    STATUS_ADVANCING,
    STATUS_RESOLVED,
    STATUS_SET,
)
from ink_engine.novel_harness.world_state import (
    ISSUE_CAUSAL,
    ISSUE_FINGERPRINT,
    ISSUE_KNOWLEDGE_GAP,
    CausalEvent,
    CausalLink,
    CharacterFingerprint,
    CharacterState,
    CharacterUpdate,
    EntityReference,
    ExtractedStateChanges,
    ForeshadowingNode,
    ForeshadowingUpdate,
    KnowledgeEntry,
    KnowledgeGain,
    LLMStateChangeExtractor,
    RelationshipState,
    RippleHit,
    SettingChange,
    WorldIssue,
    WorldState,
    apply_state_changes,
    branch_world_state,
    check_fingerprint_taboos,
    check_knowledge_gap,
    compare_world_states,
    group_ripple_hits_by_chapter,
    has_hard_conflict,
    parse_extracted_changes,
    run_world_precheck,
    scan_ripple,
    validate_causal_chain,
    validate_foreshadowing_chain,
)


def _char(**kw) -> CharacterState:
    base = {"character_id": "c1", "name": "林晚", "location": "藏剑阁", "health": "完好"}
    base.update(kw)
    return CharacterState(**base)


def _world() -> WorldState:
    world = WorldState()
    world.set_character(_char())
    world.add_knowledge(
        KnowledgeEntry(character_id="c1", fact_id="f1", known_at_chapter=3)
    )
    world.add_event(CausalEvent(event_id="e1", chapter_id=3, summary="主角发现信物"))
    world.add_event(CausalEvent(event_id="e2", chapter_id=23, summary="真相大白"))
    world.link_causality("e1", "e2", note="信物引出真相")
    return world


class TestWorldStateModel:
    def test_character_upsert_and_get(self):
        world = WorldState()
        world.set_character(_char())
        assert world.get_character("c1") is not None
        assert world.get_character(1) is None  # int 归一化为 "1"，不误中 "c1"

    def test_key_normalization_int_and_str(self):
        world = WorldState()
        world.set_character(CharacterState(character_id="7", name="七"))
        assert world.get_character(7) is not None  # int 7 归一化到 "7"

    def test_update_character_partial(self):
        world = _world()
        updated = world.update_character("c1", location="青城山", at_chapter=8)
        assert updated is not None
        assert updated.location == "青城山"
        assert updated.health == "完好"  # 未提供字段保持不变
        assert updated.updated_at_chapter == 8
        assert world.changes[-1].kind == "character"

    def test_update_character_relationships(self):
        world = WorldState()
        world.set_character(_char())
        rel = RelationshipState(target_id="c2", kind="姐妹", strength=0.9, changed_at_chapter=5)
        updated = world.update_character("c1", relationships=(rel,), at_chapter=5)
        assert updated.relationships["c2"].kind == "姐妹"
        # 追加更新保留既有关系
        rel2 = RelationshipState(target_id="c3", kind="敌对", strength=0.1, changed_at_chapter=6)
        updated2 = world.update_character("c1", relationships=(rel2,), at_chapter=6)
        assert set(updated2.relationships) == {"c2", "c3"}

    def test_update_character_unknown_returns_none(self):
        world = _world()
        assert world.update_character("ghost", location="x") is None

    def test_character_knows_by_chapter(self):
        world = _world()
        assert world.character_knows("c1", "f1", at_chapter=3) is True
        assert world.character_knows("c1", "f1", at_chapter=2) is False  # 第 2 章尚不知
        assert world.character_knows("c1", "f1") is True  # 无时间基准 = 任意时间已知

    def test_add_knowledge_idempotent_monotonic(self):
        world = _world()
        assert world.add_knowledge(KnowledgeEntry("c1", "f1", known_at_chapter=5)) is False  # 已登记更早
        assert world.add_knowledge(KnowledgeEntry("c1", "f1", known_at_chapter=1)) is True  # 更早知晓允许
        assert world.add_knowledge(KnowledgeEntry("c1", "f2", known_at_chapter=10)) is True

    def test_causal_link_rejects_unknown_events(self):
        world = _world()
        assert world.link_causality("e1", "ghost") is None
        assert world.link_causality("ghost", "e2") is None

    def test_causal_link_idempotent(self):
        world = _world()
        assert world.link_causality("e1", "e2") is None  # 重复链接幂等跳过

    def test_serialization_round_trip(self):
        world = _world()
        world.upsert_foreshadowing(
            ForeshadowingNode(
                foreshadowing_id="f1",
                description="信物",
                status=STATUS_SET,
                planted_at_chapter=3,
                references=("f2",),
            )
        )
        restored = WorldState.from_dict(world.to_dict())
        assert restored.get_character("c1") == world.get_character("c1")
        assert restored.character_knows("c1", "f1", at_chapter=3)
        assert restored.get_event("e1").summary == "主角发现信物"
        assert restored.causal_links == world.causal_links
        assert restored.get_foreshadowing("f1").references == ("f2",)
        assert len(restored.changes) == len(world.changes)

    def test_from_dict_tolerates_missing_sections(self):
        world = WorldState.from_dict({})
        assert world.characters == {}
        assert world.knowledge == {}
        assert world.causal_links == []


class TestStateChanges:
    def test_apply_character_update(self):
        world = _world()
        result = apply_state_changes(
            world,
            ExtractedStateChanges(
                character_updates=[CharacterUpdate(character_id="c1", location="青城山")],
            ),
            at_chapter=8,
        )
        assert result.applied == 1
        assert world.get_character("c1").location == "青城山"

    def test_apply_skips_unknown_character(self):
        world = _world()
        result = apply_state_changes(
            world,
            ExtractedStateChanges(character_updates=[CharacterUpdate(character_id="ghost", location="x")]),
            at_chapter=8,
        )
        assert result.applied == 0
        assert result.skipped and "不存在" in result.skipped[0]

    def test_apply_knowledge_and_skip_known(self):
        world = _world()
        result = apply_state_changes(
            world,
            ExtractedStateChanges(
                knowledge_gains=[KnowledgeGain("c1", "f1"), KnowledgeGain("c1", "f2")],
            ),
            at_chapter=10,
        )
        assert result.applied == 1  # f1 已登记跳过，f2 新增
        assert world.character_knows("c1", "f2", at_chapter=10)

    def test_apply_events_and_links(self):
        world = WorldState()
        changes = ExtractedStateChanges(
            events=[
                CausalEvent(event_id="e1", chapter_id=1, summary="发现"),
                CausalEvent(event_id="e2", chapter_id=5, summary="后果"),
            ],
            causal_links=[CausalLink("e1", "e2", "连锁")],
        )
        result = apply_state_changes(world, changes, at_chapter=5)
        assert result.applied == 3
        assert len(world.causal_links) == 1

    def test_apply_rejects_dangling_link(self):
        world = _world()
        result = apply_state_changes(
            world,
            ExtractedStateChanges(causal_links=[CausalLink("e1", "ghost")]),
        )
        assert result.skipped and "拒绝" in result.skipped[0]

    def test_apply_foreshadowing_status(self):
        world = WorldState()
        world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="f1", description="信物"))
        result = apply_state_changes(
            world,
            ExtractedStateChanges(
                foreshadowing_updates=[ForeshadowingUpdate("f1", STATUS_ADVANCING)],
            ),
            at_chapter=5,
        )
        assert result.applied == 1
        assert world.get_foreshadowing("f1").status == STATUS_ADVANCING

    def test_apply_skips_unknown_and_illegal_foreshadowing(self):
        world = WorldState()
        world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="f1"))
        result = apply_state_changes(
            world,
            ExtractedStateChanges(
                foreshadowing_updates=[
                    ForeshadowingUpdate("ghost", STATUS_ADVANCING),
                    ForeshadowingUpdate("f1", "bogus"),
                ],
            ),
        )
        assert result.applied == 0
        assert len(result.skipped) == 2


class TestParseExtractedChanges:
    def _json(self) -> str:
        return json.dumps(
            {
                "character_updates": [{"character_id": "c1", "location": "青城山"}],
                "knowledge_gains": [{"character_id": "c1", "fact_id": "f9"}],
                "events": [{"event_id": "e9", "summary": "新事件", "chapter_id": 9}],
                "causal_links": [{"cause_event_id": "e1", "effect_event_id": "e9"}],
                "foreshadowing_updates": [{"foreshadowing_id": "f1", "status": "advancing"}],
            },
            ensure_ascii=False,
        )

    def test_parse_full(self):
        changes = parse_extracted_changes(self._json())
        assert len(changes.character_updates) == 1
        assert changes.character_updates[0].location == "青城山"
        assert len(changes.knowledge_gains) == 1
        assert changes.events[0].event_id == "e9"
        assert changes.causal_links[0].cause_event_id == "e1"
        assert changes.foreshadowing_updates[0].status == "advancing"

    def test_parse_missing_required_fields_skipped(self):
        text = json.dumps(
            {
                "character_updates": [{"location": "x"}],  # 缺 character_id
                "knowledge_gains": [{"character_id": ""}],
                "events": [{}],
            }
        )
        changes = parse_extracted_changes(text)
        assert changes.character_updates == []
        assert changes.knowledge_gains == []
        assert changes.events == []

    def test_parse_non_json_is_empty(self):
        assert parse_extracted_changes("这不是 JSON").character_updates == []
        assert parse_extracted_changes("").events == []

    def test_parse_caps_item_count(self):
        text = json.dumps(
            {
                "character_updates": [{"character_id": f"c{i}"} for i in range(100)],
            }
        )
        assert len(parse_extracted_changes(text).character_updates) == 30


class TestLLMStateChangeExtractor:
    def test_extract_success(self):
        llm = _FakeLLM([json.dumps({"character_updates": [{"character_id": "c1", "location": "青城山"}]})])
        extractor = LLMStateChangeExtractor(llm)
        world = _world()
        changes = asyncio.run(extractor.extract("正文", world=world, chapter_id=8))
        assert len(changes.character_updates) == 1

    def test_extract_failure_returns_empty(self):
        llm = _FakeLLM(fail_with=RuntimeError("boom"))
        extractor = LLMStateChangeExtractor(llm)
        changes = asyncio.run(extractor.extract("正文", world=_world()))
        assert changes.character_updates == []
        assert changes.events == []

    def test_extract_empty_output_returns_empty(self):
        extractor = LLMStateChangeExtractor(_FakeLLM([""]))
        changes = asyncio.run(extractor.extract("正文", world=_world()))
        assert changes.knowledge_gains == []

    def test_prompt_contains_world_context(self):
        llm = _FakeLLM(["{}"])
        extractor = LLMStateChangeExtractor(llm)
        asyncio.run(extractor.extract("正文", world=_world()))
        prompt = str(llm.calls[0][0].content)
        assert "林晚" in prompt
        assert "主角发现信物" in prompt


class TestValidation:
    def test_knowledge_gap_detects_leak(self):
        world = _world()
        issues = check_knowledge_gap(world, "c1", ["f1", "f_secret"], at_chapter=5)
        assert len(issues) == 1  # f1 已知，f_secret 泄漏
        assert issues[0].kind == "knowledge_gap"
        assert issues[0].severity == "error"
        assert "f_secret" in issues[0].message

    def test_causal_chain_flags_dangling_and_reverse(self):
        world = _world()
        world.add_event(CausalEvent(event_id="e3", chapter_id=30, summary="后续"))
        world.link_causality("e1", "ghost")  # 被拒绝，不会出现悬空边
        world.causal_links.append(CausalLink("e2", "e1"))  # 手工注入反向边（e2 第 23 章 → e1 第 3 章）
        issues = validate_causal_chain(world)
        kinds = {i.kind for i in issues}
        assert ISSUE_CAUSAL in kinds
        assert any("后果早于原因" in i.message for i in issues)

    def test_causal_chain_clean(self):
        issues = validate_causal_chain(_world())
        assert issues == []

    def test_foreshadowing_chain_illegal_recovery(self):
        world = WorldState()
        world.upsert_foreshadowing(
            ForeshadowingNode(
                foreshadowing_id="a",
                status=STATUS_RESOLVED,  # 未埋设即回收
                resolved_at_chapter=10,
            )
        )
        issues = validate_foreshadowing_chain(world)
        assert any("未埋设即回收" in i.message for i in issues)

    def test_foreshadowing_chain_reverse_plant_after_resolve(self):
        world = WorldState()
        world.upsert_foreshadowing(
            ForeshadowingNode(foreshadowing_id="a", status=STATUS_RESOLVED, planted_at_chapter=5, resolved_at_chapter=3)
        )
        issues = validate_foreshadowing_chain(world)
        assert any("早于埋设" in i.message for i in issues)

    def test_foreshadowing_chain_reference_unplanted(self):
        world = WorldState()
        world.upsert_foreshadowing(
            ForeshadowingNode(
                foreshadowing_id="a",
                status=STATUS_RESOLVED,
                planted_at_chapter=2,
                resolved_at_chapter=8,
                references=("b",),
            )
        )
        world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="b", status=STATUS_SET))  # 未埋设
        issues = validate_foreshadowing_chain(world)
        assert any("尚未埋设" in i.message for i in issues)

    def test_foreshadowing_chain_invalid_status(self):
        world = WorldState()
        world.upsert_foreshadowing(ForeshadowingNode(foreshadowing_id="a", status="bogus"))
        issues = validate_foreshadowing_chain(world)
        assert any("合法叙事状态" in i.message for i in issues)

    def test_fingerprint_taboos(self):
        fp = CharacterFingerprint(taboos=("不可饶恕",))
        issues = check_fingerprint_taboos(fp, "他说出「不可饶恕」四个字", character_name="林晚")
        assert len(issues) == 1
        assert issues[0].severity == "warning"

    def test_has_hard_conflict(self):
        assert has_hard_conflict([WorldIssue("x", "error", "m")]) is True
        assert has_hard_conflict([WorldIssue("x", "warning", "m")]) is False

    def test_run_world_precheck_composes(self):
        world = _world()
        world.set_character(
            _char(fingerprint=CharacterFingerprint(taboos=("不可饶恕",)))
        )
        world.causal_links.append(CausalLink("e2", "e1"))
        issues = asyncio.run(
            run_world_precheck(
                world,
                text="他说出「不可饶恕」",
                character_id="c1",
                fact_ids=["f_secret"],
                at_chapter=5,
            )
        )
        kinds = {i.kind for i in issues}
        assert ISSUE_KNOWLEDGE_GAP in kinds
        assert ISSUE_CAUSAL in kinds
        assert ISSUE_FINGERPRINT in kinds

    def test_run_world_precheck_verifier_hook(self):
        class _Verifier:
            async def verify(self, fingerprint, text, *, character_name="", context=None):
                return [WorldIssue("fingerprint", "error", "言行偏离严重", entity_type="character")]

        world = _world()
        world.set_character(_char(fingerprint=CharacterFingerprint()))
        issues = asyncio.run(
            run_world_precheck(
                world, text="正文", character_id="c1", verifier=_Verifier()
            )
        )
        assert any("言行偏离严重" in i.message for i in issues)

    def test_run_world_precheck_verifier_failure_skipped(self):
        class _BadVerifier:
            async def verify(self, fingerprint, text, *, character_name="", context=None):
                raise RuntimeError("boom")

        world = _world()
        world.set_character(_char(fingerprint=CharacterFingerprint()))
        issues = asyncio.run(
            run_world_precheck(
                world, text="正文", character_id="c1", verifier=_BadVerifier()
            )
        )
        assert issues == []


class TestRippleScan:
    def _refs(self):
        return [
            EntityReference("c1", "character", 3, paragraph_index=0, excerpt="年龄十八", field="age"),
            EntityReference("c1", "character", 5, paragraph_index=1, excerpt="林晚", field=None),
            EntityReference("c1", "character", 8, paragraph_index=2, excerpt="林晚的剑", field="weapon"),
            EntityReference("c2", "character", 3, paragraph_index=0, excerpt="其他人", field="age"),
        ]

    def test_field_match_is_error(self):
        hits = scan_ripple(SettingChange("c1", "character", field="age", old_value="18", new_value="28"), self._refs())
        matched = [h for h in hits if h.reference.chapter_id == 3]
        assert len(matched) == 1
        assert matched[0].severity == "error"
        assert "age" in matched[0].reason

    def test_entity_wide_change_all_errors(self):
        hits = scan_ripple(SettingChange("c1", "character", field=None), self._refs())
        c1_hits = [h for h in hits if h.reference.entity_id == "c1"]
        assert len(c1_hits) == 3
        assert all(h.severity == "error" for h in c1_hits)

    def test_generic_reference_warning_other_field_skipped(self):
        hits = scan_ripple(SettingChange("c1", "character", field="age"), self._refs())
        warnings = [h for h in hits if h.severity == "warning"]
        errors = [h for h in hits if h.severity == "error"]
        assert len(warnings) == 1  # 第 5 章泛引用需人工核对
        assert len(errors) == 1  # 第 3 章 age 命中
        # 第 8 章 weapon 字段与第 3 章 c2 引用均跳过
        assert all(h.reference.chapter_id in (3, 5) for h in hits)

    def test_group_by_chapter(self):
        hits = [
            RippleHit(EntityReference("c1", "character", 8, paragraph_index=1, field="age"), "r", "error"),
            RippleHit(EntityReference("c1", "character", 3, paragraph_index=0, field="age"), "r", "error"),
            RippleHit(EntityReference("c1", "character", 3, paragraph_index=1, field="age"), "r", "error"),
        ]
        grouped = group_ripple_hits_by_chapter(hits)
        assert sorted(grouped) == [3, 8]
        assert len(grouped[3]) == 2
        assert len(grouped[8]) == 1


class TestWhatIf:
    def test_branch_independent(self):
        world = _world()
        branch = branch_world_state(world, label="如果主角没死", at_chapter=10)
        assert branch.label == "如果主角没死"
        assert branch.world is not world
        assert branch.world is not branch.parent
        assert branch.world.get_character("c1") == world.get_character("c1")
        # 分支上应用替代变更不影响主线
        branch.world.update_character("c1", location="青城山", at_chapter=11)
        assert world.get_character("c1").location == "藏剑阁"
        assert branch.world.get_character("c1").location == "青城山"

    def test_branch_change_logged(self):
        world = _world()
        branch = branch_world_state(world, label="如果主角没死")
        assert branch.world.changes[-1].kind == "branch"
        assert branch.world.changes[-1].detail == "如果主角没死"

    def test_compare_added_removed_changed(self):
        base = _world()
        variant = WorldState.from_dict(base.to_dict())
        variant.set_character(_char(location="青城山"))  # changed
        variant.set_character(_char(character_id="c9", name="新角色"))  # added
        variant.upsert_foreshadowing(
            ForeshadowingNode(foreshadowing_id="f1", description="新增伏笔")
        )
        diffs = compare_world_states(base, variant)
        by_id = {(d.section, d.item_id): d.kind for d in diffs}
        assert by_id[("characters", "c1")] == "changed"
        assert by_id[("characters", "c9")] == "added"
        assert by_id[("foreshadowings", "f1")] == "added"

    def test_compare_removed_in_variant(self):
        base = _world()
        variant = WorldState.from_dict(base.to_dict())
        variant.events.pop("e2", None)
        diffs = compare_world_states(base, variant)
        assert any(d.section == "events" and d.item_id == "e2" and d.kind == "removed" for d in diffs)


class _FakeLLM:
    def __init__(self, script: list | None = None, fail_with: Exception | None = None):
        self.script = list(script or [])
        self.fail_with = fail_with
        self.calls: list = []

    async def ainvoke(self, messages, **kwargs):
        self.calls.append(messages)
        if self.fail_with is not None:
            raise self.fail_with
        return _FakeResult(self.script.pop(0) if self.script else "")


class _FakeResult:
    def __init__(self, content: str):
        self.content = content

"""RoundSteps 回合步骤序列累积器单元测试（D1 回合步骤协议）。

覆盖：
- user：回合边界幂等
- reply_token：正文段切分（工具/审批卡/节点卡边界另起新段）、final_reply 校准
- thinking/plan：流式累积 → 收尾；空思考/空规划不残留
- tool：start/end 状态流转；同 tool_call_id 复用；review_card 置 pending
- node：start/stream/end/fail；按序号分卡；阶段内复用不覆盖标签；标签覆盖表注入
- memory_hit：挂最近 plan/thinking 卡
- seed：从 checkpoint 恢复中断回合，step_id 连续
- step_id 截断：超长 id 不撑爆存储与前端渲染 key
"""

from __future__ import annotations

from ink_engine.core.round_steps import RoundSteps


def _steps_of(rs: RoundSteps) -> list[dict]:
    return rs.steps()


# ---------------------------------------------------------------------------
# 回合边界
# ---------------------------------------------------------------------------


def test_user_step_idempotent():
    rs = RoundSteps("r1")
    assert rs.user("帮我设计几个角色") == "user"
    assert rs.user("帮我设计几个角色") == "user"
    steps = _steps_of(rs)
    assert len(steps) == 1
    assert steps[0] == {
        "step_id": "user",
        "type": "user",
        "payload": {"content": "帮我设计几个角色"},
    }


# ---------------------------------------------------------------------------
# 正文流
# ---------------------------------------------------------------------------


def test_reply_token_segments():
    rs = RoundSteps("r1")
    rs.reply_token("先看大纲，")
    rs.reply_token("再写正文。")
    # 工具边界切段
    rs.tool_start("write", "call-1")
    rs.reply_token("正文已生成，")
    steps = _steps_of(rs)
    assert [s["type"] for s in steps] == ["reply_token", "tool", "reply_token"]
    assert steps[0]["step_id"] == "reply:1"
    assert steps[0]["payload"]["content"] == "先看大纲，再写正文。"
    assert steps[2]["step_id"] == "reply:2"
    assert steps[2]["payload"]["content"] == "正文已生成，"


def test_set_final_reply_replaces_streamed():
    rs = RoundSteps("r1")
    rs.reply_token("流式正文")
    rs.set_final_reply("最终确认正文")
    assert _steps_of(rs)[-1]["payload"]["content"] == "最终确认正文"


def test_set_final_reply_appends_when_no_open_segment():
    rs = RoundSteps("r1")
    rs.reply_token("先说明")
    rs.tool_start("query", "c1")  # 切段
    rs.set_final_reply("最终回复")
    steps = _steps_of(rs)
    assert steps[-1]["type"] == "reply_token"
    assert steps[-1]["payload"]["content"] == "最终回复"
    # 已切段的内容保留（实时两气泡 → 回放两段）
    assert steps[0]["payload"]["content"] == "先说明"


def test_set_final_reply_prefix_avoids_exec_text_duplication():
    """执行层正文（工具卡前段）+ 收尾段：终态回复为完整拼接时，
    末段只保留剩余部分，执行层正文不重复。"""
    rs = RoundSteps("r1")
    rs.reply_token("执行层正文")
    rs.tool_start("query", "c1")
    rs.reply_token("收尾段")
    rs.set_final_reply("执行层正文\n\n收尾段")
    segments = [s for s in _steps_of(rs) if s["type"] == "reply_token"]
    assert len(segments) == 2
    assert segments[0]["payload"]["content"] == "执行层正文"
    assert segments[1]["payload"]["content"] == "收尾段"


def test_set_final_reply_single_open_segment_replaced():
    """单段未切段：末段整段替换为最终回复（与实时定型语义一致）。"""
    rs = RoundSteps("r1")
    rs.reply_token("部分流式内容")
    rs.set_final_reply("完整最终回复")
    steps = _steps_of(rs)
    assert len([s for s in steps if s["type"] == "reply_token"]) == 1
    assert steps[-1]["payload"]["content"] == "完整最终回复"


def test_set_final_reply_same_total_noop():
    """最终回复与已流式段拼接一致：不重复追加。"""
    rs = RoundSteps("r1")
    rs.reply_token("内容A")
    rs.tool_start("query", "c1")
    rs.reply_token("内容B")
    rs.set_final_reply("内容A内容B")
    assert len([s for s in _steps_of(rs) if s["type"] == "reply_token"]) == 2


def test_set_final_reply_empty_is_noop():
    """空终态回复不改动已流式段（防把正文清空）。"""
    rs = RoundSteps("r1")
    rs.reply_token("已流式正文")
    rs.set_final_reply("")
    assert _steps_of(rs)[-1]["payload"]["content"] == "已流式正文"


def test_set_final_reply_without_any_segment_creates_one():
    """整回合无流式正文（非流式产出）：终态回复自成一段。"""
    rs = RoundSteps("r1")
    rs.tool_start("query", "c1")
    rs.set_final_reply("候选已确认")
    steps = _steps_of(rs)
    assert steps[-1]["type"] == "reply_token"
    assert steps[-1]["step_id"] == "reply:1"
    assert steps[-1]["payload"]["content"] == "候选已确认"


# ---------------------------------------------------------------------------
# 思考卡 / 规划卡
# ---------------------------------------------------------------------------


def test_thinking_flow_and_empty_dropped():
    rs = RoundSteps("r1")
    rs.thinking_start()
    rs.thinking_token("先分析用户意图")
    rs.thinking_token("，再决定分支。")
    rs.thinking_end()
    steps = _steps_of(rs)
    assert len(steps) == 1
    assert steps[0]["type"] == "thinking"
    assert steps[0]["step_id"] == "think:1"
    assert steps[0]["payload"] == {
        "status": "completed",
        "content": "先分析用户意图，再决定分支。",
    }
    # 空思考不残留，但返回原 step_id 供前端移除空卡
    empty_id = rs.thinking_start()
    assert rs.thinking_end() == empty_id
    assert len(_steps_of(rs)) == 1


def test_plan_flow():
    rs = RoundSteps("r1")
    rs.plan_start()
    rs.plan_token("先查设定，")
    rs.plan_token("再执行。")
    rs.plan_end()
    steps = _steps_of(rs)
    assert steps[0]["type"] == "plan"
    assert steps[0]["step_id"] == "plan:1"
    assert steps[0]["payload"]["status"] == "completed"
    assert steps[0]["payload"]["content"] == "先查设定，再执行。"


def test_card_end_without_open_card_returns_empty():
    """卡已被其它步骤切断（非末步）→ 收尾无对象，返回空串不误伤其它步骤。"""
    rs = RoundSteps("r1")
    rs.thinking_start()
    rs.thinking_token("思考")
    rs.tool_start("query", "c1")
    assert rs.thinking_end() == ""
    assert rs.plan_end() == ""
    # 思考卡内容保留（未被收尾也未被丢弃）
    assert _steps_of(rs)[0]["payload"]["status"] == "running"


# ---------------------------------------------------------------------------
# 工具卡
# ---------------------------------------------------------------------------


def test_tool_start_end_flow():
    rs = RoundSteps("r1")
    assert rs.tool_start("query", "call-1") == "tool:call-1"
    rs.tool_end("call-1", success=False)
    payload = _steps_of(rs)[0]["payload"]
    assert payload["status"] == "error"
    assert payload["success"] is False


def test_tool_start_same_id_reuses_and_resume():
    """审批 resume 重发同 tool_call_id 的 tool_start：复用步骤并复位 running。"""
    rs = RoundSteps("r1")
    rs.tool_start("entity", "call-9")
    rs.review_card({"tool_call_id": "call-9", "reason": "需确认"})
    assert _steps_of(rs)[0]["payload"]["status"] == "pending"
    rs.tool_start("entity", "call-9")  # resume 重发
    tools = [s for s in _steps_of(rs) if s["type"] == "tool"]
    assert len(tools) == 1
    assert tools[0]["payload"]["status"] == "running"
    rs.tool_end("call-9", success=True)
    assert _steps_of(rs)[0]["payload"]["status"] == "done"


def test_tool_without_call_id_falls_back_to_counter():
    """无 tool_call_id：step_id 回退计数，收尾只认末步工具卡。"""
    rs = RoundSteps("r1")
    assert rs.tool_start("query", "") == "tool:1"
    assert rs.tool_start("query", "") == "tool:2"
    assert rs.tool_end("", success=True) == "tool:2"
    steps = [s for s in _steps_of(rs) if s["type"] == "tool"]
    assert steps[0]["payload"]["status"] == "running"
    assert steps[1]["payload"]["status"] == "done"


def test_tool_end_unmatched_returns_empty():
    """tool_call_id 无匹配卡 → 返回空串（事件层据此跳过配对更新）。"""
    rs = RoundSteps("r1")
    rs.tool_start("query", "call-1")
    assert rs.tool_end("call-unknown", success=True) == ""
    assert _steps_of(rs)[0]["payload"]["status"] == "running"


# ---------------------------------------------------------------------------
# 节点卡
# ---------------------------------------------------------------------------


def test_node_flow_and_label_kept_on_reuse():
    rs = RoundSteps("r1")
    assert rs.node_start("writer", "执笔写手") == "node:writer"
    rs.node_stream("writer", 0, "夜色渐深，")
    rs.node_stream("writer", 0, "少年推门而入。")
    rs.node_end("writer", 0, tokens=12)
    steps = _steps_of(rs)
    assert len(steps) == 1
    assert steps[0]["payload"]["label"] == "执笔写手"
    assert steps[0]["payload"]["status"] == "completed"
    assert steps[0]["payload"]["tokens"] == 12
    assert steps[0]["payload"]["content"] == "夜色渐深，少年推门而入。"
    assert rs.step_label("node:writer") == "执笔写手"


def test_node_reuse_keeps_first_label():
    """阶段内多次 node_start：复用步骤，保留首次标签（内部阶段名不覆盖展示名）。"""
    rs = RoundSteps("r1")
    rs.node_start("pipeline", "阶段一")
    rs.node_start("pipeline", "阶段二")
    steps = _steps_of(rs)
    assert len(steps) == 1
    assert steps[0]["payload"]["label"] == "阶段一"


def test_node_label_overrides_injected_by_host():
    """宿主经 node_labels 扩展点把内部阶段名收敛为对外统一文案。"""
    rs = RoundSteps("r1", node_labels={"pipeline": "统一文案"})
    rs.node_start("pipeline", "阶段一")
    rs.node_start("pipeline", "阶段二")
    steps = _steps_of(rs)
    assert len(steps) == 1
    assert steps[0]["payload"]["label"] == "统一文案"


def test_node_label_falls_back_to_node_id():
    """标签缺省 → 回退 node_id（前端永有可渲染文案）。"""
    rs = RoundSteps("r1")
    rs.node_start("auditor", "")
    assert _steps_of(rs)[0]["payload"]["label"] == "auditor"


def test_node_chapter_index_splits_cards():
    """批量任务：按序号分卡，进度内嵌。"""
    rs = RoundSteps("r1")
    rs.node_start("batch", "批量", {"chapter_index": 1, "chapter_total": 3})
    rs.node_start("batch", "批量", {"chapter_index": 2, "chapter_total": 3})
    steps = _steps_of(rs)
    assert [s["step_id"] for s in steps] == ["node:batch:1", "node:batch:2"]
    assert steps[0]["payload"]["progress"] == {"step": "write", "n": 1, "total": 3}


def test_node_progress_absent_without_total():
    """只有序号没有总数 → 不内嵌进度（避免渲染 n/0）。"""
    rs = RoundSteps("r1")
    rs.node_start("batch", "批量", {"chapter_index": 2})
    assert "progress" not in _steps_of(rs)[0]["payload"]


def test_node_fail_records_reason_and_streamed_content():
    rs = RoundSteps("r1")
    rs.node_start("auditor", "质量审计官")
    rs.node_stream("auditor", 0, "部分输出")
    rs.node_fail("auditor", 0, "输出质量不满足角色节点要求")
    payload = _steps_of(rs)[0]["payload"]
    assert payload["status"] == "failed"
    assert payload["reason"] == "输出质量不满足角色节点要求"
    assert payload["content"] == "部分输出"


def test_node_end_without_tokens_keeps_payload_clean():
    """tokens=None → 不写 tokens 字段（payload 不塞空值）。"""
    rs = RoundSteps("r1")
    rs.node_start("writer", "执笔")
    rs.node_end("writer", 0, tokens=None)
    payload = _steps_of(rs)[0]["payload"]
    assert payload["status"] == "completed"
    assert "tokens" not in payload


# ---------------------------------------------------------------------------
# 审批卡 / 记忆命中 / 建议 / 错误
# ---------------------------------------------------------------------------


def test_review_card_marks_matching_tool_pending():
    rs = RoundSteps("r1")
    rs.tool_start("entity", "call-5")
    rs.review_card({"tool_call_id": "call-5", "reason": "该操作会修改书籍数据"})
    assert _steps_of(rs)[0]["payload"]["status"] == "pending"
    rs.tool_start("query", "call-6")
    rs.review_card({"tool_call_id": "call-5", "reason": "r"})
    tools = [s for s in _steps_of(rs) if s["type"] == "tool"]
    assert tools[1]["payload"]["status"] == "running"


def test_memory_hit_attaches_to_last_plan():
    rs = RoundSteps("r1")
    rs.plan_start()
    rs.plan_token("执行计划")
    rs.plan_end()
    hit = {"id": 7, "title": "偏好", "snippet": "先抑后扬"}
    assert rs.memory_hit([hit]) == "plan:1"
    payload = _steps_of(rs)[0]["payload"]
    assert payload["memories"] == [hit]
    # 幂等：同 id 不重复挂
    rs.memory_hit([hit])
    assert len(_steps_of(rs)[0]["payload"]["memories"]) == 1


def test_memory_hit_dedupes_within_batch():
    """同一批内重复 id 也只挂一次。"""
    rs = RoundSteps("r1")
    rs.thinking_start()
    rs.thinking_token("思考")
    rs.thinking_end()
    rs.memory_hit([{"id": 1, "title": "a"}, {"id": 1, "title": "a"}])
    assert len(_steps_of(rs)[0]["payload"]["memories"]) == 1


def test_memory_hit_standalone_when_no_card():
    rs = RoundSteps("r1")
    assert rs.memory_hit([{"id": 1, "title": "t", "snippet": "s"}]) == "memory:1"
    assert _steps_of(rs)[-1]["type"] == "memory_hit"


def test_suggestions_and_error_steps():
    rs = RoundSteps("r1")
    assert rs.suggestions(["继续写第二章"]) == "suggestions:1"
    assert rs.error("模型调用失败") == "error:1"
    assert [s["type"] for s in _steps_of(rs)] == ["suggestions", "error"]


# ---------------------------------------------------------------------------
# 种子恢复与顺序
# ---------------------------------------------------------------------------


def test_seed_resumes_round_with_continuous_ids():
    """从 checkpoint 种子恢复中断回合：正文段切分与计数连续。"""
    rs0 = RoundSteps("r7")
    rs0.user("写第三章")
    rs0.thinking_start()
    rs0.thinking_token("决策思考")
    rs0.thinking_end()
    rs0.reply_token("先查询")
    rs0.tool_start("query", "c1")
    seed = rs0.steps()

    rs1 = RoundSteps("r7", seed)
    rs1.reply_token("结果汇总")
    rs1.tool_start("write", "c2")
    rs1.thinking_start()
    rs1.thinking_token("第二张思考卡")
    rs1.thinking_end()
    steps = _steps_of(rs1)
    # 思考卡计数从种子推导，不重号
    assert [s["step_id"] for s in steps if s["type"] == "thinking"] == [
        "think:1",
        "think:2",
    ]
    # 种子末步是工具卡（正文段已切段）→ 续流正文另起 reply:2
    assert [s["step_id"] for s in steps if s["type"] == "reply_token"] == [
        "reply:1",
        "reply:2",
    ]
    assert [s["type"] for s in steps] == [
        "user",
        "thinking",
        "reply_token",
        "tool",
        "reply_token",
        "tool",
        "thinking",
    ]


def test_seed_does_not_mutate_source_payloads():
    """种子 payload 浅拷贝：累积期改写不回污 checkpoint 原状态。"""
    seed = [{"step_id": "reply:1", "type": "reply_token", "payload": {"content": "原文"}}]
    rs = RoundSteps("r1", seed)
    rs.reply_token("追加")
    assert seed[0]["payload"]["content"] == "原文"


def test_seed_ignores_non_dict_entries():
    """种子含脏数据（非 dict）时跳过而非崩溃（存储兼容演进容错）。"""
    rs = RoundSteps("r1", ["bad", None, {"step_id": "user", "type": "user", "payload": {}}])
    assert [s["step_id"] for s in _steps_of(rs)] == ["user"]


def test_seed_counts_tool_without_call_id():
    """种子中无 id 的工具卡占计数，续流不与其重号。"""
    seed = [
        {"step_id": "tool:1", "type": "tool", "payload": {"tool_call_id": ""}},
    ]
    rs = RoundSteps("r1", seed)
    # 带 id 的工具卡 step_id 由 id 决定，不占计数；再来一个无 id 的应为 tool:2
    assert rs.tool_start("query", "") == "tool:2"


def test_step_id_is_clamped_consistently():
    """超长 tool_call_id：step_id 截断，且返回值与记录一致（实时事件 == 回放记录）。"""
    rs = RoundSteps("r1")
    step_id = rs.tool_start("query", "x" * 500)
    assert len(step_id) == 200
    assert _steps_of(rs)[0]["step_id"] == step_id


def test_long_node_id_still_updatable():
    """超长 node_id：stream/end 与 start 同口径截断，状态更新不丢。"""
    rs = RoundSteps("r1")
    node_id = "n" * 500
    step_id = rs.node_start(node_id, "长节点")
    assert rs.node_stream(node_id, 0, "内容") == step_id
    assert rs.node_end(node_id, 0, tokens=1) == step_id
    payload = _steps_of(rs)[0]["payload"]
    assert payload["content"] == "内容"
    assert payload["status"] == "completed"


def test_last_step_helpers_on_empty():
    rs = RoundSteps("r1")
    assert rs.last_step() is None
    assert rs.last_step_id() == ""
    assert rs.step_label("nope") == ""


def test_event_order_preserved():
    """录制顺序即回放顺序：user → think → reply → tool → node → plan → card。"""
    rs = RoundSteps("r1")
    rs.user("指令")
    rs.thinking_start()
    rs.thinking_token("思考")
    rs.thinking_end()
    rs.reply_token("正文")
    rs.tool_start("query", "c1")
    rs.tool_end("c1", True)
    rs.node_start("writer", "执笔")
    rs.node_end("writer", 0, tokens=3)
    rs.plan_start()
    rs.plan_token("规划")
    rs.plan_end()
    rs.review_card({"node_id": "x", "node_label": "x", "review_type": "gate"})
    assert [s["type"] for s in _steps_of(rs)] == [
        "user",
        "thinking",
        "reply_token",
        "tool",
        "node",
        "plan",
        "review_card",
    ]


def test_round_id_normalized():
    """round_id 缺省归一为空串（累积器不校验，仅保证类型稳定）。"""
    assert RoundSteps("").round_id == ""
    assert RoundSteps("r1").round_id == "r1"

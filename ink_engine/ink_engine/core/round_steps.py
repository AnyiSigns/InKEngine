"""回合步骤序列累积原语（回合步骤协议）。

回合（用户消息边界）/ 步骤（step_id）/ 回合步骤序列是历史回放的单一事实
来源：实时事件发射顺序 = 录制顺序 = 回放顺序。累积器维护「当前回合」的
步骤数组，宿主把它写入 checkpoint 通道（中断回合续流）并在回合完成时
快照落库——落库与传输是宿主职责，本原语纯内存、无副作用、零依赖。

步骤记录形状：``{"step_id": str, "type": str, "payload": dict}``。

step_id 在回合内稳定唯一（前端渲染 key 与 SSE 配对更新依赖此稳定性）：

- thinking/plan/review_card/memory_hit/suggestions/error 按类计数
  （``think:1`` / ``plan:1`` / ``card:1`` ...）；
- tool 按 tool_call_id（``tool:<id>``，无 id 回退计数）；
- node 按 node_id（``node:<node_id>``；携带进度序号——协议字段
  chapter_index——时按 ``node:<node_id>:<序号>`` 分卡，同 id 的
  node_start 复用更新）；
- reply_token 按回复段计数（``reply:1`` / ``reply:2``——工具卡/审批卡/
  节点卡出现即切新段，与前端回复气泡分段语义一致）；
- user 固定 ``user``（回合边界，单条）。

领域中立：节点展示标签由宿主经 ``node_labels`` 注入（引擎不内置任何
业务节点名或界面文案），其余语义对各类 agent 通用。

预留扩展点（2026-09-01 审查确认）：本模块为引擎通用回合步骤累积
原语（有完整测试），InKling 产品宿主以 Rust 侧 ``domain/steps.rs``
（RoundStepsTransport）原生实现同一职责（rounds.rs 消费），未调用
本模块——供 stdio 等其它宿主消费或未来宿主切换时启用。
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

# step_id 长度上限：超长 node_id / tool_call_id 会撑爆存储行与前端渲染 key，
# 统一在追加时截断（回合内唯一性由前缀 + 计数/调用 id 保证，截断不致冲突）
_STEP_ID_MAX_CHARS = 200

# 按类计数的步骤类型：step_id = <前缀>:<该类序号>，从种子恢复时需重建计数
_COUNTED_KINDS = frozenset(
    {"thinking", "plan", "review_card", "memory_hit", "suggestions", "error"}
)

# 回复段落计数键（reply_token 步骤共用一个计数器，与步骤 type 名不同）
_REPLY_COUNT_KEY = "reply"

# 路由 reply 分支拼接「执行层回复」与「收尾段」的分隔符：不属流式内容，
# set_final_reply 剥离前缀后需连带剥离它（防末段以空行开头）
_REPLY_JOIN_SEPARATOR = "\n\n"

# memory_hit 可挂载的宿主卡类型（就近附着到最近一张思考/规划卡）
_MEMORY_ATTACH_KINDS = ("plan", "thinking")


class RoundSteps:
    """回合步骤累积器（纯内存，无副作用，可单测）。

    从 checkpoint 种子（seed）恢复中断回合：计数由已有步骤反推，保证续流
    回合的 step_id 与中断前连续（前端按 step_id 增量更新既有卡片）。

    Args:
        round_id: 所属回合 id（回合边界标识，累积器本身不做校验）。
        seed: 中断回合的已有步骤（来自 checkpoint 通道），None = 新回合。
        node_labels: 节点展示标签覆盖表（``node_id -> 标签``）。命中即以
            表内标签替代调用方传入的 label，用于把内部环节名收敛为对外
            统一文案；引擎不内置任何业务默认值。
    """

    def __init__(
        self,
        round_id: str,
        seed: list[dict] | None = None,
        *,
        node_labels: Mapping[str, str] | None = None,
    ):
        self.round_id = round_id or ""
        self._node_labels: Mapping[str, str] = node_labels or {}
        # payload 浅拷贝：种子来自 checkpoint 状态，累积期就地改写不得回污原状态
        self._steps: list[dict[str, Any]] = [
            {**s, "payload": dict(s.get("payload") or {})}
            for s in (seed or [])
            if isinstance(s, dict)
        ]
        # step_id → 步骤记录索引：流式高频追加/更新（回复、节点 token）走 O(1)，
        # 避免每 token 全数组扫描（长回合步骤数可达千级时退化为 O(n·tokens)）
        self._index: dict[str, dict[str, Any]] = {
            str(s.get("step_id")): s for s in self._steps if s.get("step_id")
        }
        self._counts: dict[str, int] = {}
        self._reply_open = False
        self._restore_counts()

    def _restore_counts(self) -> None:
        """从种子步骤反推各类计数（续流 step_id 与中断前连续，不重号）。

        node 步骤的 step_id 由 node_id（可含序号）决定，不占计数。
        tool 步骤只在「无 tool_call_id 回退计数」形态（``tool:<纯数字>``）时
        占计数——带 id 的工具卡由 tool_call_id 保证唯一。计数取序号最大值而非
        条数：中断回合里两种形态可能混存，按最大值续号才不会与种子内已有
        ``tool:<n>`` 撞号（纯数字 tool_call_id 被误判为序号时同样只是跳号，
        不会冲突）。
        """
        for step in self._steps:
            kind = str(step.get("type") or "")
            if kind in _COUNTED_KINDS:
                self._counts[kind] = self._counts.get(kind, 0) + 1
            elif kind == "tool":
                suffix = str(step.get("step_id") or "").removeprefix("tool:")
                if suffix.isdigit():
                    self._counts["tool"] = max(
                        self._counts.get("tool", 0), int(suffix)
                    )
            elif kind == "reply_token":
                self._counts[_REPLY_COUNT_KEY] = (
                    self._counts.get(_REPLY_COUNT_KEY, 0) + 1
                )
                self._reply_open = True

    # ---- 读取 ----

    def steps(self) -> list[dict]:
        """当前回合步骤序列（浅拷贝列表，记录本身仍为内部对象）。"""
        return list(self._steps)

    def last_step(self) -> dict | None:
        return self._steps[-1] if self._steps else None

    def last_step_id(self) -> str:
        return str(self.last_step()["step_id"]) if self._steps else ""

    def step_label(self, step_id: str) -> str:
        return str(self._step_payload(step_id).get("label") or "")

    # ---- 内部原语 ----

    def _next_count(self, kind: str) -> str:
        self._counts[kind] = self._counts.get(kind, 0) + 1
        return str(self._counts[kind])

    def _append(self, step_type: str, step_id: str, payload: dict) -> str:
        """追加步骤并返回其**最终** step_id（截断后的值）。

        返回截断值而非原值：调用方拿它作事件负载的 step_id，必须与记录内的
        step_id 一致，否则超长 id 场景下实时事件与回放记录会指向不同 key。

        同 step_id 复用：step_id 是回合内稳定唯一键（文件头契约）——同一
        id 再次出现（如 tool:A 结束后重发同 tool_call_id、条件边回路二次
        进入同名节点）时更新既有记录而非追加重复卡，保证回放/前端 key
        唯一、配对操作命中同一张卡。
        """
        final_id = step_id[:_STEP_ID_MAX_CHARS]
        existing = self._index.get(final_id)
        if existing is not None:
            existing["payload"] = {**(existing.get("payload") or {}), **payload}
            return final_id
        record: dict[str, Any] = {
            "step_id": final_id,
            "type": step_type,
            "payload": payload,
        }
        self._steps.append(record)
        self._index[final_id] = record
        return final_id

    def _pop_last(self) -> dict | None:
        """移除最后一个步骤并同步索引（空思考/空规划卡丢弃用）。"""
        if not self._steps:
            return None
        record = self._steps.pop()
        self._index.pop(str(record.get("step_id")), None)
        return record

    def _update(self, step_id: str, patch: dict) -> None:
        record = self._index.get(step_id)
        if record is not None:
            record["payload"] = {**(record.get("payload") or {}), **patch}

    def _step_payload(self, step_id: str) -> dict:
        record = self._index.get(step_id)
        return (record.get("payload") or {}) if record else {}

    def _last_by_type(self, step_type: str) -> dict | None:
        """最近一个指定类型的步骤（低频路径：回合边界/工具卡/节点卡复用判定）。"""
        for step in reversed(self._steps):
            if step.get("type") == step_type:
                return step
        return None

    def _close_reply(self) -> None:
        """关闭当前回复段：后续 reply_token 另起新段。"""
        self._reply_open = False

    # ---- 回合边界 ----

    def user(self, content: str) -> str:
        """回合边界用户消息步骤（幂等：已存在则不重复记录）。"""
        existing = self._last_by_type("user")
        if existing is not None:
            return str(existing["step_id"])
        self._close_reply()
        return self._append("user", "user", {"content": content})

    # ---- 回复流 ----

    def reply_token(self, token: str) -> str:
        """回复流累积：当前段追加；无打开段时新建 reply 步骤。"""
        if self._reply_open and self._steps and self._steps[-1]["type"] == "reply_token":
            self._steps[-1]["payload"]["content"] = (
                self._steps[-1]["payload"].get("content", "") + token
            )
            return str(self._steps[-1]["step_id"])
        step_id = f"reply:{self._next_count(_REPLY_COUNT_KEY)}"
        self._append("reply_token", step_id, {"content": token})
        self._reply_open = True
        return step_id
    def set_final_reply(self, reply: str) -> None:
        """回合完成时以最终回复校准回复（防执行层回复重复）。

        终态回复常是「执行层回复 + 收尾段」的完整拼接，而执行层回复已流式
        进更早的 reply 段，按三种情形处理：

        - 多段且 reply 以「前 N-1 段拼接」为前缀 → 仅替换末段为剩余部分；
        - 单段且该段仍是最后一步（未切段）→ 整段替换为 reply（与实时流式
          气泡定型语义一致）；
        - 末段已被切段（工具/审批卡之后）或与既有段无前缀关系（非流式内容）
          → 保留已流式段，另起新段（与实时分气泡一致）。
        """
        if not reply:
            return
        reply_steps = [s for s in self._steps if s["type"] == "reply_token"]
        if not reply_steps:
            self._append(
                "reply_token", f"reply:{self._next_count(_REPLY_COUNT_KEY)}", {"content": reply}
            )
            return
        last = reply_steps[-1]
        prefix = "".join(str(s["payload"].get("content") or "") for s in reply_steps[:-1])
        if prefix and reply.startswith(prefix):
            remainder = reply[len(prefix):]
            if remainder.startswith(_REPLY_JOIN_SEPARATOR):
                remainder = remainder[len(_REPLY_JOIN_SEPARATOR):]
            if remainder:
                last["payload"]["content"] = remainder
            else:
                # 终态回复恰等于前缀（末段流式内容被前缀覆盖/冗余）：清空末段，
                # 与单段路径「整段定型为 reply」语义一致，避免末段残留重复内容
                last["payload"]["content"] = ""
            return
        if self.last_step() is last:
            # 末段仍是最后一步（回复段未切段）：整段定型替换
            if last["payload"].get("content") != reply:
                last["payload"]["content"] = reply
            return
        total = "".join(str(s["payload"].get("content") or "") for s in reply_steps)
        if reply != total:
            self._append(
                "reply_token", f"reply:{self._next_count(_REPLY_COUNT_KEY)}", {"content": reply}
            )

    # ---- 思考卡 / 规划卡 ----

    def thinking_start(self) -> str:
        self._close_reply()
        return self._append(
            "thinking", f"think:{self._next_count('thinking')}", {"status": "running", "content": ""}
        )

    def thinking_token(self, token: str) -> None:
        if self._steps and self._steps[-1]["type"] == "thinking":
            self._steps[-1]["payload"]["content"] += token

    def thinking_end(self) -> str:
        """思考卡收尾。返回收尾卡的 step_id。

        空思考被丢弃时仍返回其原 step_id（供事件层携带，前端据此移除对应
        空卡，不指向其它步骤）。
        """
        return self._end_streaming_card("thinking")

    def plan_start(self) -> str:
        self._close_reply()
        return self._append(
            "plan", f"plan:{self._next_count('plan')}", {"status": "running", "content": ""}
        )

    def plan_token(self, token: str) -> None:
        if self._steps and self._steps[-1]["type"] == "plan":
            self._steps[-1]["payload"]["content"] += token

    def plan_end(self) -> str:
        """规划卡收尾（与 thinking_end 同语义：空规划返回原 step_id 供前端移除）。"""
        return self._end_streaming_card("plan")

    def _end_streaming_card(self, step_type: str) -> str:
        """流式文本卡（思考/规划）收尾：内容非空置 completed，空卡丢弃。

        空卡不残留（与前端空卡自动移除一致，回放不渲染空卡）；仅当末步就是
        该类卡时生效——中途插入其它步骤即视为已收尾，返回 ""。
        """
        if not (self._steps and self._steps[-1]["type"] == step_type):
            return ""
        step_id = str(self._steps[-1]["step_id"])
        if not (self._steps[-1]["payload"].get("content") or "").strip():
            self._pop_last()
            return step_id
        self._steps[-1]["payload"]["status"] = "completed"
        return step_id

    # ---- 组装阶段（固定单步，折叠为一条轨迹步骤）----

    def assembly_start(self, started_at: float) -> str:
        """组装阶段开始（固定 ``assembly`` 步；重复进入同 id 复用）。

        组装时间线事件（assembly_started → assembly_done）在回合中至多
        折叠为一条「组装」步骤——承载组装阶段墙钟（耗时在收尾时定型）。
        """
        step_id = "assembly"
        return self._append(
            step_id,
            step_id,
            {"status": "running", "started_at": started_at},
        )

    def assembly_end(self, ended_at: float) -> str:
        """组装阶段收尾（定型 done + 耗时；缺 start = 幂等空操作）。"""
        step_id = "assembly"
        record = self._index.get(step_id)
        if record is None:
            return ""
        started = record["payload"].get("started_at")
        elapsed = None
        if isinstance(started, (int, float)) and ended_at > started:
            elapsed = round((ended_at - started) * 1000)
        patch: dict[str, Any] = {"status": "done"}
        if elapsed is not None:
            patch["elapsed_ms"] = elapsed
        self._update(step_id, patch)
        return step_id

    # ---- 记忆命中（挂所属步骤） ----

    def memory_hit(self, hits: list) -> str:
        """记忆命中：挂到最近一张规划/思考卡，否则独立 memory 步骤。

        同 id 命中幂等（重复注入不重复挂载），返回承载步骤的 step_id。
        """
        attach = None
        for step in reversed(self._steps):
            if step["type"] in _MEMORY_ATTACH_KINDS:
                attach = step
                break
        if attach is None:
            return self._append(
                "memory_hit",
                f"memory:{self._next_count('memory_hit')}",
                {"hits": hits, "attach_step_id": ""},
            )
        memories = list(attach["payload"].get("memories") or [])
        known_ids = {m.get("id") for m in memories}
        for hit in hits:
            if hit.get("id") not in known_ids:
                memories.append(hit)
                known_ids.add(hit.get("id"))
        attach["payload"]["memories"] = memories
        return str(attach["step_id"])

    # ---- 工具卡 ----

    def tool_start(self, category: str, tool_call_id: str) -> str:
        """工具卡开始。同 tool_call_id 复用既有卡并复位 running（审批 resume
        重发同一工具调用时不产生重复卡）。"""
        self._close_reply()
        if tool_call_id:
            existing = self._last_by_type("tool")
            if existing and existing["payload"].get("tool_call_id") == tool_call_id:
                existing["payload"].update(
                    {"category": category, "status": "running", "success": None}
                )
                return str(existing["step_id"])
            step_id = f"tool:{tool_call_id}"
        else:
            step_id = f"tool:{self._next_count('tool')}"
        return self._append(
            "tool",
            step_id,
            {"category": category, "tool_call_id": tool_call_id, "status": "running"},
        )

    def tool_end(self, tool_call_id: str, success: bool) -> str:
        """工具卡收尾。返回命中的 step_id（供事件层配对更新），未命中返回 ""。"""
        status = "done" if success else "error"
        if tool_call_id:
            for step in reversed(self._steps):
                if step["type"] == "tool" and step["payload"].get("tool_call_id") == tool_call_id:
                    step["payload"].update({"status": status, "success": success})
                    return str(step["step_id"])
            return ""
        # 无 tool_call_id：只认末步工具卡（无从配对更早的卡）
        if self._steps and self._steps[-1]["type"] == "tool":
            self._steps[-1]["payload"].update({"status": status, "success": success})
            return str(self._steps[-1]["step_id"])
        return ""

    def tool_pending(self, tool_call_id: str) -> str:
        """审批卡到达：把匹配的写工具卡置 pending（等待审批）。返回命中的 step_id。"""
        for step in reversed(self._steps):
            if step["type"] == "tool" and step["payload"].get("tool_call_id") == tool_call_id:
                step["payload"]["status"] = "pending"
                return str(step["step_id"])
        return ""

    # ---- 节点卡 ----

    @staticmethod
    def _node_step_id(node_id: str, index: int = 0) -> str:
        """节点 step_id：带序号即分卡（批量任务每项一卡），否则同 id 复用。

        与 :meth:`_append` 同口径截断——stream/end/fail 按此 id 查索引，
        不截断会在超长 node_id 时查不到已追加的记录。
        """
        step_id = f"node:{node_id}:{index}" if index else f"node:{node_id}"
        return step_id[:_STEP_ID_MAX_CHARS]

    def node_start(self, node_id: str, label: str, extra: dict | None = None) -> str:
        """节点卡开始。extra 携带进度序号（chapter_index/chapter_total）时按序号分卡并内嵌进度。

        同 step_id 复用时只刷新状态/进度，保留首次标签——节点内部多环节
        各自 start 不覆盖对外展示名。
        """
        self._close_reply()
        extra = extra or {}
        chapter_index = int(extra.get("chapter_index") or 0)
        step_id = self._node_step_id(node_id, chapter_index)
        progress = self._progress_from(extra)
        existing = self._last_by_type("node")
        if existing and existing["step_id"] == step_id:
            existing["payload"].update(
                {"status": "running", **({"progress": progress} if progress else {})}
            )
            return str(existing["step_id"])
        payload: dict[str, Any] = {
            "node_id": node_id,
            # 宿主注入的展示标签优先（内部环节名收敛为对外统一文案）
            "label": self._node_labels.get(node_id, label) or node_id,
            "status": "running",
        }
        if progress:
            payload["progress"] = progress
        return self._append("node", step_id, payload)

    @staticmethod
    def _progress_from(extra: dict) -> dict | None:
        """批量进度内嵌（第 n/total 项）；缺任一维度即无进度。"""
        chapter_index = extra.get("chapter_index") or 0
        chapter_total = extra.get("chapter_total") or 0
        if chapter_total and chapter_index:
            return {"step": "write", "n": int(chapter_index), "total": int(chapter_total)}
        return None

    def node_stream(self, node_id: str, index: int, token: str) -> str:
        step_id = self._node_step_id(node_id, int(index or 0))
        self._update(
            step_id, {"content": self._step_payload(step_id).get("content", "") + token}
        )
        return step_id

    def node_end(self, node_id: str, index: int, tokens: int | None) -> str:
        step_id = self._node_step_id(node_id, int(index or 0))
        patch: dict[str, Any] = {"status": "completed"}
        if tokens is not None:
            patch["tokens"] = tokens
        self._update(step_id, patch)
        return step_id

    def node_fail(self, node_id: str, index: int, reason: str) -> str:
        step_id = self._node_step_id(node_id, int(index or 0))
        self._update(step_id, {"status": "failed", "reason": reason})
        return step_id

    # ---- 审批卡 ----

    def review_card(self, payload: dict) -> str:
        """审批卡步骤。payload 携带 tool_call_id 时连带把该工具卡置 pending。"""
        self._close_reply()
        step_id = self._append(
            "review_card", f"card:{self._next_count('review_card')}", {"payload": payload}
        )
        tool_call_id = payload.get("tool_call_id")
        if tool_call_id:
            self.tool_pending(str(tool_call_id))
        return step_id

    # ---- 建议 / 错误 ----

    def suggestions(self, items: list) -> str:
        return self._append(
            "suggestions", f"suggestions:{self._next_count('suggestions')}", {"items": items}
        )

    def error(self, content: str) -> str:
        return self._append("error", f"error:{self._next_count('error')}", {"content": content})


__all__ = ["RoundSteps"]

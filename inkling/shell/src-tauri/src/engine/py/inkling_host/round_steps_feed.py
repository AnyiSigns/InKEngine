"""回合步骤记录传输（引擎 core.round_steps 原语的产品化接线）。

引擎事件协议 v2（core.events.EngineEvent）已携带 step_id（回合内稳定、
前端渲染 key 与 SSE 配对更新依赖）；RoundSteps（core.round_steps）提供
「步骤序列累积/合并/checkpoint 种子恢复」的回合历史形态：

- user 幂等（回合边界单条）；
- thinking/plan 流式拼接、空卡丢弃；
- tool 卡按 tool_call_id 复用更新（running → done/error/pending）；
- review_card/memory_hit/suggestions/error 按类计数（step_id 连续）；
- checkpoint 恢复：seed = RoundSteps.steps()（中断回合续流步骤不重号）。

宿主把它挂在事件传输前：``feed(event)`` 按事件类型喂入累积器，回合
收尾 ``snapshot()`` 快照落库（checkpoint/回放形态）；失败零噪声
（记录失败仅日志，不阻断主流程——观测不影响执行）。
"""
from __future__ import annotations

from collections.abc import Mapping

from ink_engine.core.events import EngineEvent
from ink_engine.core.logging import get_logger
from ink_engine.core.round_steps import RoundSteps

logger = get_logger("host.round_steps")


class RoundStepsTransport:
    """引擎事件流 → RoundSteps 步骤序列（回合记录器；种子由 checkpoint 提供）。

    Args:
        round_id: 回合 id（回合边界标识）。
        seed: 中断回合已有步骤（checkpoint 通道形态），None = 新回合。
        node_labels: 节点展示标签覆盖表（内部环节名 → 对外统一文案）。
    """

    def __init__(
        self,
        round_id: str = "",
        seed: list[dict] | None = None,
        *,
        node_labels: Mapping[str, str] | None = None,
    ) -> None:
        self.round_id = round_id or ""
        self.steps = RoundSteps(
            self.round_id, seed=seed, node_labels=node_labels
        )

    def begin_round(self, round_id: str) -> None:
        """新回合边界（换累积器；旧回合快照由消费方先行落库）。"""
        self.round_id = round_id or ""
        self.steps = RoundSteps(self.round_id)

    def snapshot(self) -> list[dict]:
        """当前回合步骤序列（checkpoint/回放形态的边界快照）。"""
        return self.steps.steps()

    def feed(self, event: EngineEvent) -> EngineEvent:
        """协议事件 → 步骤累积（事件类型未命中 = 不记录，透传原事件）。

        失败零噪声：累积异常仅记日志，事件原样透传（观测不影响执行）。
        """
        try:
            self._feed_one(event)
        except Exception as exc:  # noqa: BLE001 —— 记录失败不阻断主流程
            logger.warning("步骤累积失败（跳过该事件）: %s", exc)
        return event

    # ---- 类型分发（事件协议 → RoundSteps 原语调用）----

    def _feed_one(self, event: EngineEvent) -> None:
        etype = event.type
        payload = event.payload or {}
        source = str(
            payload.get("tool")
            or payload.get("name")
            or payload.get("node")
            or event.node
            or ""
        )
        if etype == "user":
            self.steps.user(str(payload.get("content") or ""))
        elif etype == "thinking_start":
            self.steps.thinking_start()
        elif etype == "thinking_token":
            self.steps.thinking_token(str(payload.get("token") or ""))
        elif etype == "thinking_end":
            self.steps.thinking_end()
        elif etype == "plan_start":
            self.steps.plan_start()
        elif etype == "plan_token":
            self.steps.plan_token(str(payload.get("token") or ""))
        elif etype == "plan_end":
            self.steps.plan_end()
        elif etype == "tool_start":
            self.steps.tool_start(
                category=source,
                tool_call_id=str(payload.get("tool_call_id") or ""),
            )
        elif etype == "tool_end":
            self.steps.tool_end(
                str(payload.get("tool_call_id") or ""),
                bool(payload.get("success", True)),
            )
        elif etype == "tool_pending":
            self.steps.tool_pending(str(payload.get("tool_call_id") or ""))
        elif etype == "review_card":
            self.steps.review_card(payload)
        elif etype == "reply_token":
            self.steps.reply_token(
                str(payload.get("token") or payload.get("content") or "")
            )
        elif etype == "memory_hit":
            hits = payload.get("hits") or []
            self.steps.memory_hit(list(hits) if isinstance(hits, list) else [hits])
        elif etype == "node_start":
            self.steps.node_start(
                source,
                str(payload.get("label") or source),
                extra=dict(payload.get("extra") or {}),
            )
        elif etype == "node_stream":
            self.steps.node_stream(
                source,
                int(payload.get("index") or 0),
                str(payload.get("token") or ""),
            )
        elif etype == "node_end":
            self.steps.node_end(
                source,
                int(payload.get("index") or 0),
                payload.get("tokens"),
            )
        elif etype == "node_fail":
            self.steps.node_fail(
                source,
                int(payload.get("index") or 0),
                str(payload.get("reason") or "节点失败"),
            )
        elif etype == "suggestions":
            items = payload.get("items") or []
            self.steps.suggestions(list(items) if isinstance(items, list) else [items])
        elif etype == "error":
            self.steps.error(
                str(payload.get("content") or payload.get("message") or "错误")
            )


__all__ = ["RoundStepsTransport"]

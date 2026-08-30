"""验证器门控（VTM）：节点产出评审 + 违规驱动重做。

背景（实验结论，tools/benchmarks/bench_confidence_head.py Q7/Q9，2026-08-30）：
- 预测成败不可信（LLM 自评 p≥0.9 仍漏 19% 失败），评审产出才可信
  （验证器漏抓 3%，抓到 7/8 失败）；
- 违规清单驱动定向重做 73% vs 盲重试 28%（+45%）——violations 是生成信号。

落点（引擎接线）：
- 节点返回值携带保留键 ``__verify__`` 声明评审规格（task/requirements/可选
  entity_id）；引擎挂 ``RunOptions.output_verifier`` 时对节点产出做评审；
- 评审 fail → 违规清单写入 ``state["__verify_feedback__"]`` 后重做节点
  （有界，上限 ``verify_retry_limit``）——节点可读反馈做定向修复；
- 重做耗尽仍 fail → 抛 ``OutputVerificationError``，执行器按 error 收口
  （消息带违规清单 → 演化管线自动归为 pitfall 教训，定向变异）。
"""
from __future__ import annotations

import json
from typing import Any, Protocol

# 节点返回值保留键：声明评审规格（{"task": str, "requirements": list[str],
# "entity_id": str | None}）——缺省不评审，既有图零行为变化。
VERIFY_KEY = "__verify__"
# 重做反馈键：违规清单写入 ctx.state，节点重跑时读取做定向修复。
VERIFY_FEEDBACK_KEY = "__verify_feedback__"


class OutputVerifier(Protocol):
    """产出评审器：对节点产出做验收判断（宿主注入——LLM 验证器/确定性检查）。"""

    async def verify(
        self,
        ctx: Any,
        *,
        node: str,
        output: dict,
        spec: dict,
    ) -> dict:
        """评审节点产出，返回 {"pass": bool, "violations": [str, ...]}。"""


class OutputVerificationError(RuntimeError):
    """产出验证终败（违规驱动重做耗尽）：按节点失败收口。

    Attributes:
        entity_id: 评审规格携带的实体归因（演化管线据此定向变异；
            None = 无实体关联，仅留痕不变异）。
    """

    def __init__(self, message: str, *, entity_id: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.entity_id = entity_id


class LLMOutputVerifier:
    """LLM 验证器：按评审规格对产出做硬性要求验收（复用统一 AsyncLLM 接口）。"""

    def __init__(self, llm: Any) -> None:
        self._llm = llm

    async def verify(self, ctx: Any, *, node: str, output: dict, spec: dict) -> dict:
        from .llm.messages import Message

        requirements = spec.get("requirements") or []
        req_text = "\n".join(f"- {r}" for r in requirements)
        prompt = (
            "给定任务、硬性要求与节点产出，判断产出是否通过验收。\n"
            f"任务：{spec.get('task') or ''}\n"
            f"硬性要求：\n{req_text}\n"
            f"节点产出：\n{json.dumps(output, ensure_ascii=False)}\n"
            '输出严格 JSON：{"pass": true/false, "violations": ["违反了什么"]}\n'
            "只输出 JSON。产出不满足任何硬性要求就 pass=false，不要宽容。"
        )
        result = await self._llm.ainvoke(
            [
                Message(role="system", content="你是验收评审器。"),
                Message(role="user", content=prompt),
            ]
        )
        return _parse_verdict(result.content or "")


def _parse_verdict(text: str) -> dict:
    text = text.strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {"pass": False, "violations": ["评审输出无法解析"]}
    try:
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return {"pass": False, "violations": ["评审输出无法解析"]}
    if not isinstance(data, dict):
        return {"pass": False, "violations": ["评审输出无法解析"]}
    return {
        "pass": bool(data.get("pass")),
        "violations": [str(v) for v in (data.get("violations") or [])],
    }


__all__ = [
    "VERIFY_FEEDBACK_KEY",
    "VERIFY_KEY",
    "LLMOutputVerifier",
    "OutputVerificationError",
    "OutputVerifier",
    "_parse_verdict",
]

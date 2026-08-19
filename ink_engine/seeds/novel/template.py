"""novel 领域种子的默认编排模板（纯数据：工作流图定义形态）。

默认编排模板 = 用户集初始化注入的中等深度工作流数据（与通用种子模板
条目同构），宿主按图适配节点类型后经
:class:`~ink_engine.core.workflow.WorkflowSpec` 编译为可执行图——模板
内容是图定义数据（节点+边+入口），「壳（流程编排）不用写」的示范：
领域流程以数据承载，打磨成熟后可蒸馏/晋升为知识集模板条目。

模板节点名以领域语义声明，宿主绑定节点类型时保持语义即可；边表达
「提取 → 校验 → 生成 → 评审 → 收敛」的依赖序。
"""
from __future__ import annotations

from typing import Any

# 默认编排模板名称（用户集内引用的稳定键）
NOVEL_DEFAULT_TEMPLATE = "novel.template.default"

# 模板条目数据形态（与知识集 KIND_TEMPLATE 条目 data 同构）
_TEMPLATE_DATA: dict[str, Any] = {
    "template": {
        "name": "novel_default",
        "description": "novel 领域默认编排（提取 → 校验 → 生成 → 评审 → 收敛）",
        "plan": {
            "steps": [
                {"nodes": ["extract"]},
                {"nodes": ["validate"]},
                {"nodes": ["generate"]},
                {"nodes": ["review"]},
                {"nodes": ["converge"]},
            ]
        },
    }
}


def build_novel_default_template() -> dict[str, Any]:
    """novel 领域默认编排模板数据（图定义形态，宿主按图适配节点类型）。"""
    return {**dict(_TEMPLATE_DATA["template"]), "plan": dict(_TEMPLATE_DATA["template"]["plan"])}


__all__ = [
    "NOVEL_DEFAULT_TEMPLATE",
    "build_novel_default_template",
]

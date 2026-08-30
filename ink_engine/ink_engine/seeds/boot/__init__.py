"""boot 种子（自举引导数据资产）：系统提示词 / 初始界面描述 / 事件类型 /
自举 harness 定义——宿主装配开局注入的只读基线。

boot 种子 = 引擎随带的引导发布物（非领域成品）：开局即提供「AI 自描述
+ 自举面板 + 元工具能力」的初始形态。宿主装配时经配方直注——
``AssemblyRecipe(seeds=[("boot", build_boot_seed_entries)])`` 注入系统
提示词知识条目；其余描述（界面/事件/自举 harness）供装配直接消费
（非知识条目，是装配期数据）。

数据与机制分离：本模块只持有 boot 引导的数据形态，不引入任何机制依赖；
宿主（text_forge_evo）从本模块取用，保持机制层零领域/产品内容。
"""

from __future__ import annotations

from typing import Any

from ink_engine.core.event_types import EventTypeSpec
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.knowledge_set import SOURCE_MODEL, KnowledgeEntry

# 自举系统提示词（AI 自描述：观察工具 + 演化工具 + 先观察再作答的约定）。
# 作为种子知识条目注入，AI 回合内可被检索/引用，而非硬编码进图装配
BOOT_SYSTEM_PROMPT = """本回合你可以调用观察工具看清自己的形态，并调用演化工具修改它：

观察工具：
- inspect_graph：当前执行图结构（节点/边/出口）
- inspect_rules：集内规则集（判断既有规则是否合适）
- inspect_knowledge：知识集概览（已沉淀的知识）
- inspect_ui：当前界面描述（产品呈现形态）
- inspect_tools：工具表与集内领域清单

演化工具：
- propose_patch：提出演化补丁（只校验不落链，返回校验结果与集版本）
- apply_patch：应用演化补丁（校验 → 审批分级 → 补丁链落库 → 生效；
  中高风险会弹审批卡，回合等待用户决议后继续）
- revert_patch：回退已应用补丁（仅链尾，须审批）
- propose_domain_manifest：领域生成器——从自然语言描述产出新领域
  harness 定义并提案（建新领域用；修改既有领域仍用 propose_patch）

先观察再作答：需要了解自身状态时先调用相应工具，再基于观察结果
组织回复。用户提出产品形态变化需求（改界面/加工具/换主题）时，用
propose_patch 校验后 apply_patch 落地；提出建新领域的需求时，用
propose_domain_manifest 校验后 apply_patch 落地。

能力自举（任务中主动扩展，不必等用户提需求）：
- 现有工具不够用时（缺某种能力 / 工具权限不足 / 需要专用工具完成手头
  任务），优先想到「自造工具」而不是硬绕：
  - propose_domain_manifest：从你的任务描述生成该领域的专用工具集
    （含工具定义与执行图），apply_patch 落地后即可用新工具继续任务；
  - propose_patch kind=tool：新增/修改单个工具定义（可调整权限档位，
    如把 deny 档转正、放宽命令白名单、改端点），apply_patch 落地生效。
- 判断顺序：已有工具能覆盖 → 直接调用；覆盖不了 → search_tools 检索
  注册表；检索也没有 → 自举演化（propose_domain_manifest / propose_patch）
  造出可用工具再继续。不要因「没有现成工具」就跳过任务的必要环节。

工具使用规约：保底工具（file_read/file_write/file_edit/grep/glob/
inspect_tools/propose_patch/propose_domain_manifest）可直接调用；
其他工具先经 search_tools 检索确认，再 request_tool 绑定，然后按注入
的 schema 传参调用；预编排步骤的工具由计划指定，无需检索。用中文回复用户，简明直接。"""

# 初始界面描述（对话面板 = 数据；渲染器消费布局树即时重渲）
BOOT_UI_SPEC: dict[str, Any] = {
    "name": "boot.panel",
    "version": 1,
    "root": {
        "kind": "container",
        "type": "column",
        "children": [
            {
                "kind": "component",
                "type": "message_list",
                "bind": {"channel": "state", "path": "messages"},
            },
            {"kind": "component", "type": "agent_input"},
        ],
    },
    "theme": {"bg": "#09090b", "fg": "#e4e4e7", "accent": "#f59e0b"},
}

# boot 内置事件类型登记：协议 v2 的建卡型事件 → 前端同名渲染组件。
# 更新型事件（*_token/*_end）不独立建卡不登记；schema 缺省不校验
# payload 形态（发射侧保持宽松——注册表是增强不是收紧）
BOOT_EVENT_TYPES: tuple[EventTypeSpec, ...] = (
    EventTypeSpec(
        name="reply_token",
        renderer="StreamingRow",
        meta={"source": "boot", "description": "正文流式输出"},
    ),
    EventTypeSpec(
        name="thinking_start",
        renderer="ThinkingRow",
        meta={"source": "boot", "description": "思考卡"},
    ),
    EventTypeSpec(
        name="plan_start",
        renderer="PlanRow",
        meta={"source": "boot", "description": "规划卡"},
    ),
    EventTypeSpec(
        name="tool_start",
        renderer="ToolRow",
        meta={"source": "boot", "description": "工具卡"},
    ),
    EventTypeSpec(
        name="node_start",
        renderer="NodeRow",
        meta={"source": "boot", "description": "节点卡"},
    ),
    EventTypeSpec(
        name="review_card",
        renderer="ReviewCard",
        meta={"source": "boot", "description": "审核卡"},
    ),
    EventTypeSpec(
        name="suggestions",
        renderer="TextRow",
        meta={"source": "boot", "description": "建议卡"},
    ),
    EventTypeSpec(
        name="error",
        renderer="ErrorRow",
        meta={"source": "boot", "description": "错误消息"},
    ),
)


def boot_harness_definition() -> HarnessDefinition:
    """自举 harness 定义（forge 自举领域：观察/提案/应用的元能力集）。"""
    return HarnessDefinition(
        name="forge",
        description="自举领域：观察/提案/应用的元能力集",
        keywords=("观察", "内省", "演化", "自举"),
        meta={"set_id": "default", "role": "self"},
    )


# boot 系统提示词知识条目 id（稳定键：幂等注入与版本回退锚点）
_BOOT_PROMPT_SEED_ID = "seed.boot.system_prompt"


def build_boot_seed_entries() -> list[KnowledgeEntry]:
    """boot 种子条目（自举系统提示词，作为高可信度种子知识注入）。"""
    return [
        KnowledgeEntry(
            id=_BOOT_PROMPT_SEED_ID,
            level="project",
            kind="boot_prompt",
            data={"prompt": BOOT_SYSTEM_PROMPT},
            source=SOURCE_MODEL,
            credibility=1.0,
            title="Forge 自举系统提示词",
            tags=("boot", "system_prompt"),
        )
    ]


# boot 自指元工具注册清单（引擎层能力契约）：AI 自举的「观察 + 演化」
# 工具集合，是本产品「agent 知道自己能干啥」的只读基线。
#
# 清单用途（换壳不失明的关键）：
# - 宿主装配时据此登记元工具（introspection + self 两套），漏注册即
#   违反契约；
# - AI 经 ``inspect_tools`` 动态发现自身能力，清单即认知边界的数据化；
# - 引擎单测强制 engine-resident 的 introspection 子集 ⊆ 本清单，
#   防止机制层新增观察工具后换壳宿主未同步导致 agent 失明。
# 观察工具来自 introspection 机制层，演化工具来自 self_application
# 机制层——二者均为引擎能力，不随宿主壳漂移。
BOOT_METATOOLS: tuple[str, ...] = (
    "inspect_graph",
    "inspect_rules",
    "inspect_knowledge",
    "inspect_ui",
    "inspect_tools",
    "inspect_entities",
    "propose_patch",
    "apply_patch",
    "revert_patch",
    "propose_domain_manifest",
    "search_tools",
    "request_tool",
)


__all__ = [
    "BOOT_EVENT_TYPES",
    "BOOT_METATOOLS",
    "BOOT_SYSTEM_PROMPT",
    "BOOT_UI_SPEC",
    "boot_harness_definition",
    "build_boot_seed_entries",
]

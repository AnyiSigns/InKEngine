"""世界状态层：创作关键状态的显式数据层。

把创作关键状态从 LLM 隐式上下文移出为引擎可追踪/校验/查询的显式数据——
**世界状态图** = 角色状态机 + 知识矩阵 + 因果链 + 伏笔矩阵：

- **角色状态机**：只显式建模关键状态（位置/健康/关系/目标），琐碎状态
  （穿着等）留给 LLM 隐式携带，防建模爆炸（粒度方案 A）；
- **知识矩阵**：追踪"角色在何时知道什么"，支撑信息差查询
  （"此刻女二是否知道真相"——防上帝视角泄漏）；
- **因果链**：事件节点 + 后果边，跨章追踪（第 3 章事件的后果在第 23 章
  是否体现）；
- **伏笔矩阵**：叙事状态机的泛化——伏笔互引/回收链合法性
  （不能先回收 B 再埋 A）。

本包提供四类原语（按职责分层，包内子模块可独立演进）：

1. **模型**（models）：:class:`WorldState` 世界状态图 + 各实体数据类
   （可序列化落库）；
2. **状态更新**（extract + apply）：确定性更新（结构化变更直接应用）+
   LLM 提取（:class:`StateChangeExtractor`，best-effort，失败不阻断主流程）；
3. **写时校验**（validate）：:class:`WorldIssue` 统一问题模型 + 确定性规则
   （信息差/因果链/伏笔合法性/指纹禁忌）+ LLM 指纹判定钩子
   （:class:`FingerprintVerifier`，宿主可注册实现）；
4. **操作层**（ripple + diff）：涟漪扫描（:func:`scan_ripple` 输出需修订
   清单）+ What-if 分支（:func:`branch_world_state` +
   :func:`compare_world_states`）。

**补丁链统一**：每次写操作 = 一条 :class:`WorldStateChange`（append-only），
当前状态 = 最后应用结果，分支 = 深拷贝分叉——回溯/回滚/分支语义与引擎
补丁链一致。

零宿主依赖：本包不 import 任何 TextForge 业务模块，也不依赖 ORM——
落库、检索、外部服务调用由宿主实现并经接口注入。
"""
from __future__ import annotations

from ink_engine.novel_harness.narrative_state import (
    ACTOR_AGENT,
    ACTOR_PRECHECK,
    ACTOR_SYSTEM,
    ACTOR_USER,
)

from .apply import ApplyResult, apply_state_changes
from .diff import WorldStateBranch, WorldStateDiff, branch_world_state, compare_world_states
from .extract import (
    CharacterUpdate,
    ExtractedStateChanges,
    ForeshadowingUpdate,
    KnowledgeGain,
    LLMStateChangeExtractor,
    StateChangeExtractor,
    parse_extracted_changes,
)
from .models import (
    CHANGE_BRANCH,
    CHANGE_CAUSAL,
    CHANGE_CHARACTER,
    CHANGE_EVENT,
    CHANGE_FORESHADOWING,
    CHANGE_KNOWLEDGE,
    CausalEvent,
    CausalLink,
    CharacterFingerprint,
    CharacterState,
    ForeshadowingNode,
    KnowledgeEntry,
    RelationshipState,
    WorldState,
    WorldStateChange,
)
from .ripple import (
    EntityReference,
    RippleHit,
    SettingChange,
    group_ripple_hits_by_chapter,
    scan_ripple,
)
from .validate import (
    ISSUE_CAUSAL,
    ISSUE_FINGERPRINT,
    ISSUE_FORESHADOWING,
    ISSUE_KNOWLEDGE_GAP,
    SEVERITY_ERROR,
    SEVERITY_WARNING,
    FingerprintVerifier,
    WorldIssue,
    check_fingerprint_taboos,
    check_knowledge_gap,
    has_hard_conflict,
    run_world_precheck,
    validate_causal_chain,
    validate_foreshadowing_chain,
)

__all__ = [
    "ACTOR_AGENT",
    "ACTOR_PRECHECK",
    "ACTOR_SYSTEM",
    "ACTOR_USER",
    "CHANGE_BRANCH",
    "CHANGE_CAUSAL",
    "CHANGE_CHARACTER",
    "CHANGE_EVENT",
    "CHANGE_FORESHADOWING",
    "CHANGE_KNOWLEDGE",
    "ISSUE_CAUSAL",
    "ISSUE_FINGERPRINT",
    "ISSUE_FORESHADOWING",
    "ISSUE_KNOWLEDGE_GAP",
    "SEVERITY_ERROR",
    "SEVERITY_WARNING",
    "ApplyResult",
    "CausalEvent",
    "CausalLink",
    "CharacterFingerprint",
    "CharacterState",
    "CharacterUpdate",
    "EntityReference",
    "ExtractedStateChanges",
    "FingerprintVerifier",
    "ForeshadowingNode",
    "ForeshadowingUpdate",
    "KnowledgeEntry",
    "KnowledgeGain",
    "LLMStateChangeExtractor",
    "RelationshipState",
    "RippleHit",
    "SettingChange",
    "StateChangeExtractor",
    "WorldIssue",
    "WorldState",
    "WorldStateBranch",
    "WorldStateChange",
    "WorldStateDiff",
    "apply_state_changes",
    "branch_world_state",
    "check_fingerprint_taboos",
    "check_knowledge_gap",
    "compare_world_states",
    "group_ripple_hits_by_chapter",
    "has_hard_conflict",
    "parse_extracted_changes",
    "run_world_precheck",
    "scan_ripple",
    "validate_causal_chain",
    "validate_foreshadowing_chain",
]

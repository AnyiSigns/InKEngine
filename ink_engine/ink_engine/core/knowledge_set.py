"""知识集封装层（用户集知识：种子注入 → 演化补丁链 → 分层晋升 → 可移植）。

知识集 = 在 memory 原语与补丁链之上新建的封装层：规则条目 = 补丁链
数据（演化 = 新补丁，回退 = 旧版本，分支 = 平行版本）；晋升 = 层级
字段迁移（工作 → 项目 → 用户，身份 id 跨层级稳定）；可移植 = 补丁链
导出/导入（跨部署迁移复用）。

层级（AgentScope 双层记忆 + 「毕业」机制）：
- 工作级（work）：细粒度流水账（append-only，不丢事实）；
- 项目级（project）：常用沉淀（领域上下文中的稳定积累）；
- 用户级（user）：通用教训「毕业」晋升（供该用户全部会话复用）。

来源留痕 + 可信度分级：知识条目携带 source（web/dialog/model/user）
与 credibility（0-1）——防 web 注入污染知识集（来源分级：web <
dialog < 用户确认；L1 安全扫描见闸门模块）。

知识集注入 = 调配器思想复用：条目可转为 :class:`ContextSource`
（type=层级、weight=可信度、relevance=任务相关度、ttl=时效）——
:meth:`KnowledgeEntry.as_context_source` 提供适配，知识预算分配与
逐源留痕由 :mod:`ink_engine.core.context` 承接（本模块零重复实现）。
"""
from __future__ import annotations

import json
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from typing import Any

from .context import ContextSource
from .exceptions import GraphDefinitionError
from .logging import get_logger
from .patch_chain import Patch, PatchChain, PatchOp
from .source_grading import (  # 来源分级单源（ENG3-4/ENG3-19：与检索/记忆共享）
    _SOURCE_CREDIBILITY,  # noqa: F401 — 重导出（外部消费方沿用 knowledge_set._SOURCE_CREDIBILITY 形态）
    SOURCE_DIALOG,
    SOURCE_MODEL,
    SOURCE_ORDER,
    SOURCE_USER,
    SOURCE_WEB,
)
from .source_grading import (
    default_credibility as _default_credibility,
)
from .storage import Storage

logger = get_logger(__name__)

# 修正方法 value 参数的空值哨兵（显式 None 与未传区分——精准补丁可
# 合法地写入 None）
_UNSET = object()

# 知识层级（晋升方向固定：工作流水账 → 项目沉淀 → 用户毕业）
LEVEL_WORK = "work"
LEVEL_PROJECT = "project"
LEVEL_USER = "user"
_LEVELS = (LEVEL_WORK, LEVEL_PROJECT, LEVEL_USER)

# 层级晋升方向（工作 → 项目 → 用户，顺序固定——先沉淀后压缩）
_LEVEL_ORDER = {LEVEL_WORK: 0, LEVEL_PROJECT: 1, LEVEL_USER: 2}

# 条目失败日志留存上限（反思式变异的输入窗口：只留近期，防无限膨胀）
_MAX_FAILURE_LOGS = 20

# 条目渲染软上限（ENG3-14：非 rule/insight 条目的 JSON 摘要截断——
# 渲染层防超长 data 撑爆注入上下文；截断带溢出标记，留痕可重建）
_MAX_RENDER_CHARS = 4000

# 复用检索默认上限（ENG3-5：search(limit=5) 魔法数字数据化；检索 =
# 复用优先于生成的窗口，取 5 条命中即够决策，防超大集全量注入）
DEFAULT_SEARCH_LIMIT = 5

# 知识条目对外错误码（ENG3-8：桥接透传不泄露内部字段形态——文案统一
# 携带错误码前缀，内部结构（层级枚举/类型名）不以 Python 形态裸透）
KS_ERR_INVALID_LEVEL = "KS_001"
KS_ERR_CREDIBILITY_RANGE = "KS_002"
KS_ERR_GATE_TYPE = "KS_003"

# 来源分级（web < dialog < model < user）与默认可信度基准 = 单源
# 定义（source_grading，与检索/记忆共享同一分级类型——ENG3-4/ENG3-19）
# SOURCE_*/_SOURCE_CREDIBILITY 经上方 import 重导出（外部消费方沿用
# ``knowledge_set.SOURCE_*`` / ``knowledge_set._SOURCE_CREDIBILITY`` 形态）


def default_credibility(source: str) -> float:
    """按来源取默认可信度（未知来源 = 模型级，保守不激进）。"""
    return _default_credibility(source)

# 知识条目 kind（规则/模板/权重/工具规则/教训/路径技能/脚本——集内能力的数据形态）
KIND_RULE = "rule"
KIND_TEMPLATE = "template"
KIND_WEIGHT = "weight"
KIND_TOOL_RULE = "tool_rule"
KIND_INSIGHT = "insight"
# path = 证据化路径技能（结晶路径图 + 证据快照 + 测试报告，消费方 = 路径组装）；
# script = 确定性脚本技能（外部 SKILL.md 脚本段导入形态，消费方 = 工具执行）
KIND_PATH = "path"
KIND_SCRIPT = "script"

# path 技能条目的容器内集合前缀（技能 id 稳定命名 = skill:<name>@v<version>）
SKILL_ID_PREFIX = "skill:"

# 存储集合前缀（knowledge:<user_id>）
_COLLECTION_PREFIX = "knowledge:"
# 补丁链存储键（用户集内唯一链）
_CHAIN_KEY = "chain"

# 种子条目 id 前缀（回退种子基线的过滤依据：注入开关关闭时仅种子注入）
SEED_ID_PREFIX = "seed."


def _render_entry_content(entry: KnowledgeEntry) -> str:
    """条目内容渲染（知识注入的模型可见形态：标题 + 结构化内容摘要）。

    规则条目取声明中的 message（规则的自述），其余条目输出紧凑 JSON
    摘要——内容随源一起进入预算分配与组装，留痕可重建。
    """
    parts = [entry.title] if entry.title else []
    raw = entry.data.get("rule")
    if isinstance(raw, dict) and raw.get("message"):
        parts.append(str(raw["message"]))
        return " ".join(p for p in parts if p)
    insight = entry.data.get("insight")
    if entry.kind == KIND_INSIGHT and isinstance(insight, dict) and insight.get("message"):
        parts.append(str(insight["message"]))
        if insight.get("note"):
            parts.append(f"（教训来源：{insight['note']}）")
        return " ".join(p for p in parts if p)
    parts.append(json.dumps(entry.data, ensure_ascii=False, sort_keys=True))
    # 渲染层软上限（ENG3-14）：非规则条目的 JSON 摘要超限截断 + 溢出
    # 标记——条目 data 失控不得撑爆注入上下文（截断内容仍可经条目
    # 自身重建，留痕最小化原则不受影响）
    rendered = parts[-1]
    if len(rendered) > _MAX_RENDER_CHARS:
        parts[-1] = rendered[:_MAX_RENDER_CHARS] + "…（渲染截断）"
    return " ".join(p for p in parts if p)


def knowledge_collection(user_id: str) -> str:
    """用户集存储集合名（多用户隔离：一用户一集，集内条目补丁链承载）。"""
    return f"{_COLLECTION_PREFIX}{user_id}"


@dataclass(frozen=True, slots=True)
class KnowledgeEntry:
    """一条知识条目（结构化数据，随补丁链版本化）。

    Attributes:
        id: 条目 id（集内唯一，晋升不换 id——身份跨层级稳定）。
        level: 当前层级（work/project/user）。
        kind: 条目类别（rule/template/weight/tool_rule/insight）。
        data: 结构化内容（规则 = Rule 声明数据；模板 = 编排模板数据）。
        source: 来源（web/dialog/model/user——注入污染审计基准）。
        credibility: 可信度（0-1；来源分级 + 验证闸门产物）。
        title: 标题（检索/展示可读）。
        tags: 标签（关键词检索索引）。
        usage_count: 调用次数（复用检索/进化优先级依据）。
        fail_count: 失败次数（进化工厂优先入队依据）。
        failure_logs: 近期失败日志（反思式变异的输入——进化工厂按
            日志定向修订；留痕截尾保留最近 ``_MAX_FAILURE_LOGS`` 条）。
        archived: 归档标记（True = 移出活跃索引，可恢复——生命周期
            = 归档不删除，见归档语义）。
        created_at: 创建时间戳（epoch 秒）。
        updated_at: 更新时间戳（epoch 秒）。
    """

    id: str
    level: str
    kind: str
    data: dict[str, Any] = field(default_factory=dict)
    source: str = SOURCE_MODEL
    credibility: float = 0.5
    title: str = ""
    tags: tuple[str, ...] = ()
    usage_count: int = 0
    fail_count: int = 0
    failure_logs: tuple[str, ...] = ()
    archived: bool = False
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def __post_init__(self) -> None:
        # 错误码前缀（ENG3-8）：文案统一携带 KS_ 码，桥接透传不泄露
        # 内部字段形态（层级枚举以可读形态呈现，不裸 Python 结构）
        if self.level not in _LEVELS:
            raise GraphDefinitionError(
                f"[{KS_ERR_INVALID_LEVEL}] 知识条目层级非法: {self.level!r}"
                f"（仅 {', '.join(_LEVELS)}）"
            )
        if not 0 <= self.credibility <= 1:
            raise GraphDefinitionError(
                f"[{KS_ERR_CREDIBILITY_RANGE}] 知识条目 {self.id} 的可信度"
                f"必须在 [0, 1] 内: {self.credibility}"
            )

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.id,
            "level": self.level,
            "kind": self.kind,
            "data": self.data,
            "source": self.source,
            "credibility": self.credibility,
        }
        if self.title:
            data["title"] = self.title
        if self.tags:
            data["tags"] = list(self.tags)
        if self.usage_count:
            data["usage_count"] = self.usage_count
        if self.fail_count:
            data["fail_count"] = self.fail_count
        if self.failure_logs:
            data["failure_logs"] = list(self.failure_logs)
        if self.archived:
            data["archived"] = True
        data["created_at"] = self.created_at
        data["updated_at"] = self.updated_at
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> KnowledgeEntry:
        """反序列化（单点结构校验；校验归口说明（ENG3-13）见类注释）。

        条目形态校验集中在本方法（类型/枚举/数值域），与
        :class:`~ink_engine.core.schema_validator.SchemaValidator` 的
        声明式校验体系并存但职责不重叠：本方法是条目数据形态的权威
        校验器（纯数据载体，不套用声明式）；需要声明式 L1 schema
        校验时经 :meth:`KnowledgeSet.verify_through_gate` 注入
        ``schema``（闸门路径）——两条体系按各自职责归口。
        """
        if not isinstance(data, dict):
            raise GraphDefinitionError(
                f"知识条目声明非法: 期望 dict，收到 {type(data).__name__}"
            )
        entry_id = data.get("id")
        level = data.get("level")
        kind = data.get("kind")
        if not entry_id or not isinstance(entry_id, str):
            raise GraphDefinitionError("知识条目缺 id（字符串）")
        if level not in _LEVELS:
            raise GraphDefinitionError(
                f"[{KS_ERR_INVALID_LEVEL}] 知识条目层级非法: {level!r}"
                f"（仅 {', '.join(_LEVELS)}）"
            )
        if not kind or not isinstance(kind, str):
            raise GraphDefinitionError(f"知识条目 {entry_id} 缺 kind（字符串）")
        raw_data = data.get("data")
        if not isinstance(raw_data, dict):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 data 须为 dict，收到 {type(raw_data).__name__}"
            )
        tags = data.get("tags") or ()
        if not isinstance(tags, (list, tuple)) or not all(
            isinstance(tag, str) for tag in tags
        ):
            raise GraphDefinitionError(f"知识条目 {entry_id} 的 tags 须为字符串清单")
        failure_logs = data.get("failure_logs") or ()
        if not isinstance(failure_logs, (list, tuple)) or not all(
            isinstance(log, str) for log in failure_logs
        ):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 failure_logs 须为字符串清单"
            )
        source = data.get("source", SOURCE_MODEL)
        raw_credibility = data.get("credibility", default_credibility(source))
        if not isinstance(raw_credibility, (int, float)):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 credibility 须为数值，"
                f"收到 {type(raw_credibility).__name__}"
            )
        credibility = float(raw_credibility)
        if not 0 <= credibility <= 1:
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的可信度必须在 [0, 1] 内: {credibility}"
            )
        raw_usage = data.get("usage_count", 0)
        raw_fail = data.get("fail_count", 0)
        if not isinstance(raw_usage, int) or isinstance(raw_usage, bool):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 usage_count 须为整数，"
                f"收到 {type(raw_usage).__name__}"
            )
        if not isinstance(raw_fail, int) or isinstance(raw_fail, bool):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 fail_count 须为整数，"
                f"收到 {type(raw_fail).__name__}"
            )
        raw_created = data.get("created_at", time.time())
        raw_updated = data.get("updated_at", time.time())
        if not isinstance(raw_created, (int, float)):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 created_at 须为数值，"
                f"收到 {type(raw_created).__name__}"
            )
        if not isinstance(raw_updated, (int, float)):
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的 updated_at 须为数值，"
                f"收到 {type(raw_updated).__name__}"
            )
        return cls(
            id=entry_id,
            level=level,
            kind=kind,
            data=raw_data,
            source=source,
            credibility=credibility,
            title=data.get("title", ""),
            tags=tuple(tags),
            usage_count=raw_usage,
            fail_count=raw_fail,
            failure_logs=tuple(failure_logs)[-_MAX_FAILURE_LOGS:],
            archived=bool(data.get("archived", False)),
            created_at=float(raw_created),
            updated_at=float(raw_updated),
        )

    def render_content(self) -> str:
        """条目内容渲染（知识注入的模型可见形态：标题 + 结构化内容摘要）。

        规则条目取声明中的 message（规则的自述），其余条目输出紧凑 JSON
        摘要——内容随源一起进入预算分配与组装，留痕可重建。注入前
        :func:`build_knowledge_sources` 对渲染内容做指令注入扫描。
        """
        return _render_entry_content(self)

    def as_context_source(
        self,
        relevance: float = 0.5,
        ttl: float | None = None,
        budget_chars: int | None = None,
    ) -> ContextSource:
        """知识条目 → 上下文源（调配器接入：type=层级、weight=可信度）。

        知识集注入 = 调配器思想复用：条目作为源进入预算分配（高可信
        常驻、低可信按任务相关度裁剪），逐源留痕由调配器承接。内容
        = :func:`_render_entry_content` 的条目渲染（标题 + 结构化摘要），
        与元数据一起进入组装——模型可见皆可重建。
        """
        if not 0 <= relevance <= 1:
            raise ValueError(f"任务相关度必须在 [0, 1] 内: {relevance}")
        return ContextSource(
            type=self.level,
            content=_render_entry_content(self),
            title=self.title or self.id,
            weight=self.credibility,
            relevance=relevance,
            priority=self.usage_count,
            ttl=ttl,
            max_chars=budget_chars,
            dedup_key=f"knowledge:{self.id}",
            meta={
                "entry_id": self.id,
                "kind": self.kind,
                "source": self.source,
                "level": self.level,
            },
            created_at=self.updated_at,
        )


def _make_entry_id() -> str:
    """新条目 id 生成（uuid 短前缀，集内唯一即可）。"""
    return f"k-{uuid.uuid4().hex[:12]}"


def _entry_path(entry_id: str) -> tuple[str, ...]:
    """补丁链中条目所在路径（entries/<id>，层级经条目自身字段承载）。"""
    return ("entries", entry_id)


class KnowledgeSet:
    """用户知识集：种子注入 + 演化补丁链 + 分层晋升 + 可移植。

    数据形态：补丁链 base = {"entries": {id: 条目数据}}，演化 = 追加
    补丁（新增 replace、修正 replace 同路径、删除 delete）——链即全部
    变更历史（append-only 可回退）；快照 = assemble 产物（可导出）。

    Attributes:
        user_id: 用户集 id（存储隔离键）。
        chain: 条目补丁链（None = 尚未落库；write 后初始化）。
        storage: 存储服务（None = 纯内存集，不持久化）。
        on_mutation: 变更钩子（每次内存链变更后同步回调；None = 不回调）。

    持久化语义（ENG3-17）：add/update/record_usage 等只改内存链，
    落库 = 调用方显式 :meth:`save`（写 ``knowledge:<user>`` 集合，受
    宿主旁路写防护约束）。关键路径显式持久化 = 宿主经 ``on_mutation``
    钩子在变更发生后立即调度落库（在自身机制上下文内执行）；未注入
    钩子 = 维持「调用方显式 save」语义（钩子不改变默认行为）。
    """

    def __init__(
        self,
        user_id: str,
        *,
        storage: Storage | None = None,
        chain: PatchChain | None = None,
        on_mutation: Callable[[], None] | None = None,
    ) -> None:
        self.user_id = user_id
        self.storage = storage
        self.chain = chain or PatchChain()
        self.on_mutation = on_mutation

    def _notify_mutated(self) -> None:
        """变更钩子（内存链变更后的同步回调；异常不阻断主流程）。"""
        if self.on_mutation is not None:
            try:
                self.on_mutation()
            except Exception as exc:
                logger.warning("知识集变更钩子异常（忽略）: %s", exc)

    # ── 条目读写 ──

    def entries(
        self, level: str | None = None, *, include_archived: bool = False
    ) -> list[KnowledgeEntry]:
        """当前快照的条目清单（按层级过滤可选；升序 = 插入序稳定）。

        默认只返回活跃条目（归档 = 移出活跃索引，可恢复——生命周期
        语义：低使用归档不删除）；``include_archived=True`` 取全量。
        """
        if level is not None and level not in _LEVELS:
            raise GraphDefinitionError(f"未知知识层级: {level}")
        snapshot = self.chain.assemble()
        raw_entries = snapshot.get("entries") or {}
        entries = [
            KnowledgeEntry.from_dict(record)
            for record in raw_entries.values()
            if isinstance(record, dict)
        ]
        if not include_archived:
            entries = [e for e in entries if not e.archived]
        if level is not None:
            entries = [e for e in entries if e.level == level]
        return sorted(entries, key=lambda e: e.id)

    def archived_entries(self, level: str | None = None) -> list[KnowledgeEntry]:
        """归档条目清单（低使用移出活跃索引后的可恢复视图）。"""
        return [
            e for e in self.entries(level, include_archived=True) if e.archived
        ]

    def get(self, entry_id: str) -> KnowledgeEntry | None:
        """按 id 取条目（不存在返回 None）。"""
        snapshot = self.chain.assemble()
        raw = (snapshot.get("entries") or {}).get(entry_id)
        return KnowledgeEntry.from_dict(raw) if isinstance(raw, dict) else None

    async def verify_through_gate(
        self,
        entry: KnowledgeEntry,
        *,
        gate: Any = None,
        schema: Any = None,
        fixtures: Any = None,
        regression: Any = None,
        new_metrics: dict[str, float] | None = None,
        old_metrics: dict[str, float] | None = None,
    ) -> None:
        """落库闸门（样例测试非谈判项的存储边界强制）。

        注入三层闸门实例（KnowledgeGate）时，条目在写入前必须通过
        L1 准入 → L2 效果评估 → L3 目标筛选——任一关不过即抛
        :class:`~ink_engine.core.rules.FixtureGateError`，条目不落库。
        未注入闸门 = 调用方自行把关（种子注入等已验证发布物路径），
        机制不替策略设默认。

        Args:
            entry: 待落库条目。
            gate: 闸门实例（None = 跳过闸门）。
            schema: L1 schema 声明（形式合法关）。
            fixtures: L2 完整样例库（效果关，非谈判项）。
            regression: L2 历史回归用例（追加评估；None = 不追加）。
            new_metrics: L3 新条目维度指标（None = 无旧版直接通过）。
            old_metrics: L3 旧版指标（None = 首版）。
        """
        if gate is None:
            return
        from .knowledge_gate import KnowledgeGate
        from .rules import FixtureGateError

        if not isinstance(gate, KnowledgeGate):
            raise GraphDefinitionError(
                f"[{KS_ERR_GATE_TYPE}] 落库闸门形态非法（须为知识闸门实例）"
            )
        l1, l2, l3 = await gate.check(
            entry,
            schema=schema,
            fixtures=fixtures,
            new_metrics=new_metrics,
            old_metrics=old_metrics,
            regression=regression,
        )
        if not (l1.passed and l2.passed and l3.passed):
            raise FixtureGateError(
                f"知识条目 {entry.id} 未通过落库闸门"
                f"（L1: {l1.errors or '通过'} / L2: {l2.note or '通过'} / "
                f"L3: {l3.reason or '通过'}）"
            )

    async def add_gated(
        self,
        entry: KnowledgeEntry,
        *,
        gate: Any,
        schema: Any = None,
        fixtures: Any = None,
        regression: Any = None,
    ) -> KnowledgeEntry:
        """带闸门落库：写入前过三层闸门（样例不绿在存储边界即被拒绝）。

        闸门为异步评估（L2 含完整样例执行），与同步的 :meth:`add` 分离
        为独立入口——种子注入等已验证发布物走同步 add（幂等且不重复
        评估），演化产物走本入口（非谈判项 fail-closed）。
        """
        await self.verify_through_gate(
            entry, gate=gate, schema=schema, fixtures=fixtures, regression=regression
        )
        return self.add(entry)

    def add(self, entry: KnowledgeEntry) -> KnowledgeEntry:
        """新增条目（补丁链 append-only：replace 到 entries/<id>）。

        同 id 已存在 = 重复添加（防静默覆盖既有知识，应走 update 修正）。
        本入口为同步直落（种子注入等已验证发布物路径）；演化产物须过
        三层闸门，走 :meth:`add_gated`（样例测试非谈判项 fail-closed）。
        """
        if self.get(entry.id) is not None:
            raise GraphDefinitionError(
                f"知识条目已存在（修正请用 update）: {entry.id}"
            )
        self.chain.apply(
            Patch(
                op=PatchOp.REPLACE,
                path=_entry_path(entry.id),
                value=entry.to_dict(),
            )
        )
        self._notify_mutated()
        return entry

    def update(
        self,
        entry_id: str,
        *,
        data: dict | None = None,
        path: tuple[str | int, ...] | None = None,
        value: Any = _UNSET,
        **changes: Any,
    ) -> KnowledgeEntry:
        """修正条目（精准补丁：只替换变更字段，不重写整条知识）。

        与蒸馏「精准补丁（replace 语义，只改对应段落）」对齐，三种
        修正形态互不混叠：
        - ``data``：结构化字段级替换（合并进现有 data 顶层）；
        - ``path`` + ``value``：嵌套精准补丁（沿路径只改 data 内对应
          段落，兄弟字段不受影响——落链为深路径 replace 补丁）；
        - 关键字参数：顶层字段替换。
        旧值均在链历史中，回退可取；data 与 path 互斥（一次修正只走
        一种精准语义）。
        """
        existing = self.get(entry_id)
        if existing is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        if data is not None and path is not None:
            raise GraphDefinitionError(
                f"知识条目 {entry_id} 的修正须在 data 与 path 二选一"
            )
        if path is not None:
            if not path:
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 的精准补丁路径不能为空"
                )
            if value is _UNSET:
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 的精准补丁缺 value"
                )
            # 精准补丁契约（ENG12 接线2：build_precise_patch 单点定义）：
            # 由 build_precise_patch 生成 path/value 声明（蒸馏侧精准
            # 补丁与此处修正语义同源——避免两条并行实现漂移），本处仅
            # 补充 entry 前缀（修正作用域 = 该条目 data 字段内部）后落
            # 链为深路径 replace 补丁；updated_at 顶层时间戳一并刷新。
            # 函数内 import 防 knowledge_set ↔ knowledge_signals 循环
            from .knowledge_signals import build_precise_patch

            inner = build_precise_patch(existing.data, path, value)
            inner_path = tuple(inner["path"])
            self.chain.apply(
                Patch(
                    op=PatchOp.REPLACE,
                    path=(*_entry_path(entry_id), "data", *inner_path),
                    value=inner["value"],
                )
            )
            self.chain.apply(
                Patch(
                    op=PatchOp.REPLACE,
                    path=(*_entry_path(entry_id), "updated_at"),
                    value=time.time(),
                )
            )
            entry = self.get(entry_id)
            if entry is None:  # 链形态保证存在；兜底防御
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 精准补丁后不可读"
                )
            self._notify_mutated()
            return entry
        updated = existing.to_dict()
        if data is not None:
            if not isinstance(data, dict):
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 的修正 data 须为 dict"
                )
            updated["data"] = {**existing.data, **data}
        for key, value in changes.items():
            if key in ("id", "created_at"):
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 的 {key} 为身份字段，不可修正"
                )
            updated[key] = value
        updated["updated_at"] = time.time()
        self.chain.apply(
            Patch(op=PatchOp.REPLACE, path=_entry_path(entry_id), value=updated)
        )
        entry = KnowledgeEntry.from_dict(updated)
        self._notify_mutated()
        return entry

    def remove(self, entry_id: str) -> bool:
        """删除条目（补丁链 delete，幂等：不存在返回 False）。"""
        if self.get(entry_id) is None:
            return False
        self.chain.apply(Patch(op=PatchOp.DELETE, path=_entry_path(entry_id)))
        self._notify_mutated()
        return True

    # ── 归档/淘汰（生命周期 = 归档不删除：低使用移出活跃索引，可恢复）──

    def archive(self, entry_id: str) -> KnowledgeEntry:
        """归档条目：移出活跃索引（entries/search 不再命中），不删除。

        与风险表「条目归档/淘汰机制（低使用 + 低引用/价值标记 → 归档
        不删除）」对齐：归档是生命周期管理（防规则集膨胀拖慢每次组装），
        数据与演化历史完整保留——:meth:`unarchive` 随时可恢复。
        """
        entry = self.get(entry_id)
        if entry is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        if entry.archived:
            return entry
        return self.update(entry_id, archived=True)

    def unarchive(self, entry_id: str) -> KnowledgeEntry:
        """恢复归档条目（重新进入活跃索引，内容与计数原样保留）。"""
        entry = self.get(entry_id)
        if entry is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        if not entry.archived:
            return entry
        return self.update(entry_id, archived=False)

    def record_usage(
        self, entry_id: str, *, failed: bool = False, log: str = ""
    ) -> None:
        """调用留痕（usage_count/fail_count 累积 + 失败日志留存）。

        失败日志 = 反思式变异的输入（进化工厂按近期失败定向修订）——
        留痕截尾保留最近 ``_MAX_FAILURE_LOGS`` 条，防无限膨胀。
        """
        existing = self.get(entry_id)
        if existing is None:
            return
        changes: dict[str, Any] = {
            "usage_count": existing.usage_count + 1,
            "updated_at": time.time(),
        }
        if failed:
            changes["fail_count"] = existing.fail_count + 1
            if log:
                changes["failure_logs"] = (
                    *existing.failure_logs[-_MAX_FAILURE_LOGS + 1 :],
                    log,
                )
        self.update(entry_id, **changes)

    # ── 分层晋升（先沉淀后压缩，顺序固定）──

    def promote(self, entry_id: str, *, to_level: str | None = None) -> KnowledgeEntry:
        """晋升：条目层级 namespace 迁移（工作 → 项目 → 用户，不跳级）。

        晋升是知识「毕业」：通用教训升到用户级供全部会话复用。条目 id
        跨层级稳定（身份不变，层级字段迁移）；补丁链 replace 单点落链。
        """
        existing = self.get(entry_id)
        if existing is None:
            raise GraphDefinitionError(f"知识条目不存在: {entry_id}")
        current_rank = _LEVEL_ORDER[existing.level]
        if to_level is None:
            if current_rank >= len(_LEVELS) - 1:
                raise GraphDefinitionError(
                    f"知识条目 {entry_id} 已处于最高层级（{existing.level}）"
                )
            target = _LEVELS[current_rank + 1]
        else:
            target = to_level
            if target not in _LEVELS:
                raise GraphDefinitionError(f"未知知识层级: {target}")
            if _LEVEL_ORDER[target] != current_rank + 1:
                raise GraphDefinitionError(
                    f"晋升只能逐级向上（工作→项目→用户）: {existing.level} → {target}"
                )
        return self.update(entry_id, level=target)

    # ── 可移植（导出/导入：内容永远可带走）──

    def export(self) -> dict[str, Any]:
        """导出为补丁链数据（跨部署迁移复用；链 = 全部演化历史）。

        导出内容 = 机制数据（补丁链），权属使用方——「可移植」是权属
        边界的内置承诺：引擎管机制，内容永远可带走。
        """
        return self.chain.to_dict()

    @classmethod
    def from_export(
        cls, user_id: str, data: dict[str, Any], *, storage: Storage | None = None
    ) -> KnowledgeSet:
        """从导出数据重建知识集（round-trip：export → import 无损还原）。

        非法导出数据显式拒绝（缺 base/patches 形态），不静默建空集。
        """
        if not isinstance(data, dict) or not isinstance(data.get("base"), dict):
            raise GraphDefinitionError("知识集导出数据非法（缺 base 结构）")
        chain = PatchChain.from_dict(data)
        return cls(user_id=user_id, storage=storage, chain=chain)

    # ── 持久化（存储三后端共用：knowledge:<user> 集合）──

    @property
    def collection(self) -> str:
        """持久化集合名（knowledge:<user_id>）。

        守卫豁免对齐兼容点：旁路写守卫按集合名（精确/前缀）判定，runtime
        侧的 ``allow_mechanism`` 需与此名一致（见另一片的豁免修复），避免
        "knowledge_set" 字面量与真实集合名 knowledge:<user> 不匹配导致豁免
        失效。宿主侧应改用 ``knowledge_set.collection`` 而非硬编码字面量。
        """
        return knowledge_collection(self.user_id)

    async def save(self) -> None:
        """落库（补丁链写入存储；storage=None 时跳过——纯内存集）。"""
        if self.storage is None:
            return
        await self.storage.put_record(
            knowledge_collection(self.user_id), _CHAIN_KEY, self.export()
        )

    @classmethod
    async def load(
        cls, user_id: str, *, storage: Storage | None = None
    ) -> KnowledgeSet:
        """从存储读回（无记录 = 空集；存储不可用 = 空集——种子注入由
        使用方在初始化时调用 :meth:`seed`）。"""
        if storage is None:
            return cls(user_id=user_id)
        data = await storage.get_record(knowledge_collection(user_id), _CHAIN_KEY)
        if data is None:
            return cls(user_id=user_id, storage=storage)
        return cls.from_export(user_id, data, storage=storage)

    # ── 复用检索（复用优先于生成，防知识膨胀）──

    def search(
        self,
        query: str,
        *,
        level: str | None = None,
        kind: str | None = None,
        limit: int = DEFAULT_SEARCH_LIMIT,
        include_archived: bool = False,
    ) -> list[KnowledgeEntry]:
        """相似任务检索：标题/标签/数据文本的关键词命中 + 可信度排序。

        检索 = 复用优先于生成的第一步（AgentFactory 教训）：相似任务先
        检索已有条目，命中复用而非从头蒸馏。实现为关键词子串匹配（无
        语义检索时仍可用的确定性基线；语义检索为可选扩展，可注入）。

        检索作用域 = 活跃索引（归档条目默认不参与检索——归档语义 =
        移出活跃索引；``include_archived=True`` 可显式检索归档条目）。
        """
        if not query or limit <= 0:
            return []
        needles = [token for token in query.lower().split() if token]
        if not needles:
            return []
        hits: list[KnowledgeEntry] = []
        for entry in self.entries(level, include_archived=include_archived):
            if kind is not None and entry.kind != kind:
                continue
            haystack = " ".join(
                [entry.title, *entry.tags, entry.id, str(entry.data)]
            ).lower()
            if all(needle in haystack for needle in needles):
                hits.append(entry)
        hits.sort(key=lambda e: (e.credibility, e.usage_count), reverse=True)
        return hits[:limit]


def seed_knowledge_set(
    knowledge_set: KnowledgeSet, entries: list[KnowledgeEntry]
) -> int:
    """种子注入：批量写入最小可用种子（幂等——同 id 跳过，不覆盖演化）。

    通用种子（引擎内置）与领域种子（随引擎随带）统一经此入口注入；
    幂等性保证「种子只读基线 + 演化补丁链」的分层语义——重复初始化
    不会覆盖使用中沉淀的知识。同 id 跳过时记 warning（ENG3-9）：种子
    基线长期遮蔽演化沉淀属可观测信号，静默跳过会让「种子与演化冲突」
    不可见。
    """
    injected = 0
    for entry in entries:
        if knowledge_set.get(entry.id) is None:
            knowledge_set.add(entry)
            injected += 1
        else:
            logger.warning(
                "种子条目跳过（同 id 已存在，不覆盖演化）: %s", entry.id
            )
    return injected


def build_knowledge_sources(
    entries: list[KnowledgeEntry],
    *,
    relevance: float = 0.5,
    ttl: float | None = None,
    max_chars: int | None = None,
    injection_enabled: bool = True,
    injection_scan: bool = True,
    source_type: str = "knowledge",
) -> list[ContextSource]:
    """知识条目 → 上下文源清单（知识注入 = 调配器思想复用的组装入口）。

    .. deprecated:: E-P6 之后知识注入走 Retriever 注册路线
       （:class:`~ink_engine.core.retrieval.KnowledgeSetRetriever` 注册为
       检索源，runtime 回合装配统一经检索合并汇入——ENG3-18 标注）。
       本入口保留为**显式条目清单**的注入形态（宿主/测试直接注入命中
       条目时使用），不再承担回合级知识注入的唯一装配入口职责。

    检索命中条目经此转为 :class:`ContextSource`（type=装配源类别、
    weight=可信度、relevance=任务相关度、ttl=时效、内容 = 条目渲染，
    层级留在 meta——装配分级按源类别分配预算，层级供常驻基线/任务
    激活的判定消费）——进入调配器的预算分配（知识集不整包注入，按
    任务预算只组装相关条目）、跨源去重、逐源留痕（模型可见皆留痕，
    防污染的审计基础）全由 context 模块承接。

    ``injection_enabled=False`` = 一键关闭知识注入：只保留种子条目
    （id 以 ``seed.`` 前缀）作为注入源——回退到种子基线（引擎内置
    最小可用），演化沉淀的知识不再进入上下文。

    ``injection_scan=True`` = 注入防线：渲染内容过
    :func:`~ink_engine.core.knowledge_gate.scan_text_injection`——
    检出指令型措辞的条目剔除（web/用户来源知识条目可能携带指令型
    措辞进提示词，与检索结果注入防线同口径；检出即剔除，不放行）。

    Args:
        entries: 检索命中的知识条目（复用优先于生成的产物）。
        relevance: 任务相关度（0-1，本次任务的匹配度，预算分配次因子）。
        ttl: 注入时效秒数（None = 不过期）。
        max_chars: 单条目注入字符上限（None = 不设额外上限）。
        injection_enabled: 知识注入开关（False = 回退种子基线）。
        injection_scan: 注入前指令注入扫描（True = 检出剔除）。
        source_type: 装配源类别（知识池的分配键；须在输入调配管线的
            源类别集合内——未知类别在装配处显式拒绝）。

    Returns:
        按可信度降序的源清单（调配器据此做预算分配与组装）。
    """
    if not injection_enabled:
        entries = [e for e in entries if e.id.startswith(SEED_ID_PREFIX)]
    # 执行类 kind（path/script）剔除：执行物非 prompt 文本，不进上下文
    # 注入——消费分派（path=路径组装先例 / script=工具执行）与注入面分离。
    entries = [e for e in entries if e.kind not in (KIND_PATH, KIND_SCRIPT)]
    sources: list[ContextSource] = []
    for entry in entries:
        if injection_scan:
            from .knowledge_gate import scan_text_injection

            hits = scan_text_injection(entry.render_content())
            if hits:
                logger.warning(
                    "知识条目注入前检出指令注入措辞，剔除: %s（命中: %s）",
                    entry.id,
                    "；".join(hits),
                )
                continue
        sources.append(
            entry.as_context_source(
                relevance=relevance, ttl=ttl, budget_chars=max_chars
            )
        )
    if source_type:
        sources = [replace(s, type=source_type) for s in sources]
    sources.sort(key=lambda s: (s.weight, s.priority), reverse=True)
    return sources


__all__ = [
    "DEFAULT_SEARCH_LIMIT",
    "KIND_INSIGHT",
    "KIND_PATH",
    "KIND_RULE",
    "KIND_SCRIPT",
    "KIND_TEMPLATE",
    "KIND_TOOL_RULE",
    "KIND_WEIGHT",
    "LEVEL_PROJECT",
    "LEVEL_USER",
    "LEVEL_WORK",
    "SEED_ID_PREFIX",
    "SKILL_ID_PREFIX",
    "SOURCE_DIALOG",
    "SOURCE_MODEL",
    "SOURCE_ORDER",
    "SOURCE_USER",
    "SOURCE_WEB",
    "KnowledgeEntry",
    "KnowledgeSet",
    "build_knowledge_sources",
    "default_credibility",
    "knowledge_collection",
    "seed_knowledge_set",
]

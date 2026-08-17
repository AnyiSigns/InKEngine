"""内容型补丁链（Event Sourcing 核心原语）。

心智模型：变化 = 补丁（append-only），状态 = 基础(base) + 补丁链，
取用 = 组装(assemble)，压缩 = 压扁(rebase)。正文/设定工作区、发散候选
段落级混合、编辑重放截断分支都建立在此原语上。

补丁类型：
- append：列表追加 / 字符串拼接（路径不存在时自动创建容器）；
- replace：路径指向的值整体替换（路径不存在时新建）；
- delete：删除路径指向的值（路径不存在时静默成功，幂等）。

路径：元组 (str | int, ...)——dict 键用 str，list 索引用 int。
组装是纯函数（不改 base/patches），rebase 返回新链（原链不变）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

Path = tuple[str | int, ...]

# 组装模式：full=基础+全部补丁；base_only=仅基础；partial=基础+指定区间补丁
class AssembleMode(StrEnum):
    FULL = "full"
    BASE_ONLY = "base_only"
    PARTIAL = "partial"


class PatchOp(StrEnum):
    APPEND = "append"
    REPLACE = "replace"
    DELETE = "delete"


@dataclass(frozen=True, slots=True)
class Patch:
    """单条内容补丁。

    Attributes:
        op: 操作类型（append/replace/delete）。
        path: 目标路径（元组，dict 键 str / list 索引 int）。
        value: 操作值（delete 时为 None，忽略）。
    """

    op: PatchOp
    path: Path
    value: Any = None


def _resolve(doc: dict, path: Path) -> Any:
    """沿路径取叶子值（不存在返回 None，键缺失/索引越界一律视为缺失）。"""
    current: Any = doc
    for seg in path:
        if isinstance(current, dict):
            if seg not in current:
                return None
            current = current[seg]
        elif isinstance(current, list) and isinstance(seg, int) and 0 <= seg < len(current):
            current = current[seg]
        else:
            return None
    return current


def _set(doc: dict, path: Path, value: Any) -> None:
    """就地写入叶子值：中间容器不存在时按下一段类型自动创建（str 段→dict，int 段→list）。

    list 段越界时自动填充 None 到目标索引（防 IndexError，组装稳定）。
    """
    node: Any = doc
    for i, seg in enumerate(path[:-1]):
        if isinstance(node, dict):
            child = node.get(seg)
            if child is None:
                child = {} if isinstance(path[i + 1], str) else []
                node[seg] = child
        else:  # list 容器
            while len(node) <= seg:  # type: ignore[arg-type]
                node.append(None)  # type: ignore[union-attr]
            child = node[seg]  # type: ignore[index]
            if child is None:
                child = {} if isinstance(path[i + 1], str) else []
                node[seg] = child  # type: ignore[index]
        node = child
    last = path[-1]
    if isinstance(node, list) and isinstance(last, int):
        while len(node) <= last:
            node.append(None)
        node[last] = value
    else:
        node[last] = value


def _apply_one(doc: dict, patch: Patch) -> None:
    """把单条补丁应用到文档（就地）。"""
    if patch.op is PatchOp.APPEND:
        current = _resolve(doc, patch.path)
        if current is None:
            _set(doc, patch.path, [patch.value] if patch.value is not None else [])
        elif isinstance(current, list):
            current.append(patch.value)
        elif isinstance(current, str):
            _set(doc, patch.path, current + str(patch.value or ""))
        else:
            raise TypeError(f"append 目标必须是 list/str，实际 {type(current).__name__}: {patch.path}")
    elif patch.op is PatchOp.REPLACE:
        _set(doc, patch.path, patch.value)
    elif patch.op is PatchOp.DELETE:
        node: Any = doc
        for seg in patch.path[:-1]:
            if not isinstance(node, dict) or seg not in node:
                return  # 幂等：中间路径缺失即视为已删除
            node = node[seg]
        last = patch.path[-1]
        if isinstance(node, dict):
            node.pop(last, None)
        elif isinstance(node, list) and isinstance(last, int) and 0 <= last < len(node):
            node.pop(last)
    else:  # pragma: no cover - StrEnum 穷尽，防御未知 op
        raise ValueError(f"未知补丁操作: {patch.op}")


@dataclass(slots=True)
class PatchChain:
    """内容型补丁链：base + 有序补丁列表。

    组装（assemble）为纯函数；rebase 返回压扁后的新链；truncate 就地截断
    （编辑重放 = 截断 + 新分支）；branch 派生共享前缀的新链（What-if 分支）。
    """

    base: dict = field(default_factory=dict)
    patches: list[Patch] = field(default_factory=list)

    @property
    def length(self) -> int:
        return len(self.patches)

    def apply(self, patch: Patch) -> None:
        """追加一条补丁（append-only）。"""
        self.patches.append(patch)

    def apply_many(self, patches: list[Patch]) -> None:
        self.patches.extend(patches)

    def assemble(
        self,
        mode: AssembleMode = AssembleMode.FULL,
        start: int = 0,
        end: int | None = None,
    ) -> dict:
        """组装当前链，返回新文档（不改 base/patches）。

        full：基础 + 全部补丁按序应用；
        base_only：仅返回基础的深拷贝（非破坏性压缩的降级视图）；
        partial：基础 + [start:end) 区间补丁（候选段落级混合的分段取用）。

        Complexity: O(n × depth)，n = 补丁数（100 补丁组装基准 <5ms）。
        """
        if mode is AssembleMode.BASE_ONLY:
            return _deep_copy(self.base)
        if mode is AssembleMode.PARTIAL:
            patches = self.patches[start : end if end is not None else len(self.patches)]
        else:
            patches = self.patches
        doc = _deep_copy(self.base)
        for patch in patches:
            _apply_one(doc, patch)
        return doc

    def rebase(self) -> PatchChain:
        """压扁：把当前链组装结果作为新 base，返回空补丁链的新链。

        用于链超长/落库时的压缩（非破坏性——原链保留，新链独立）。
        Complexity: O(n × depth)（100 补丁压扁基准 <10ms）。
        """
        return PatchChain(base=self.assemble(), patches=[])

    def truncate(self, keep: int) -> None:
        """就地截断：仅保留前 keep 条补丁（编辑重放 = 截断 + 新分支）。"""
        if keep < 0:
            raise ValueError(f"截断数量不能为负: {keep}")
        del self.patches[keep:]

    def branch(self, at: int | None = None) -> PatchChain:
        """派生分支：共享 base 与 [0:at] 前缀补丁的新链（What-if 平行宇宙/重放分叉）。

        新链的 base/patches 均为深拷贝，与原链互不影响。
        """
        cut = at if at is not None else len(self.patches)
        return PatchChain(base=_deep_copy(self.base), patches=list(self.patches[:cut]))

    def to_dict(self) -> dict:
        """序列化（存储层用）：{base, patches:[{op, path, value}]}。"""
        return {
            "base": _deep_copy(self.base),
            "patches": [
                {"op": p.op.value, "path": list(p.path), "value": _deep_copy(p.value)}
                for p in self.patches
            ],
        }

    @classmethod
    def from_dict(cls, data: dict) -> PatchChain:
        """反序列化（存储层用），兼容加字段演进（未知字段忽略）。"""
        patches = [
            Patch(op=PatchOp(p["op"]), path=tuple(p["path"]), value=p.get("value"))
            for p in data.get("patches", [])
        ]
        return cls(base=_deep_copy(data.get("base") or {}), patches=patches)


def _deep_copy(value: Any) -> Any:
    """JSON 兼容深拷贝（dict/list/标量；非 JSON 类型原样返回，防自定义对象误伤）。"""
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(v) for v in value]
    if isinstance(value, tuple):
        return tuple(_deep_copy(v) for v in value)
    return value


__all__ = [
    "AssembleMode",
    "Patch",
    "PatchChain",
    "PatchOp",
    "Path",
]

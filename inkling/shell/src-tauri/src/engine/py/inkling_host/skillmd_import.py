"""外部技能导入：SKILL.md 多形态源 → 知识集条目（合并容器；provenance 留痕）。

外部生态（SKILL.md）不是黑盒直挂——导入 = 拆解转换进统一条目模型：
- 指令段 → kind=template 条目（declarative，走上下文注入）；
- 脚本段 → kind=script 条目（确定性执行物）；
- 参考信息 → data.provenance（溯源留痕，支持重导入 diff）。

源形态（``source`` 按前缀分派；全部归一为「取文本 → 解析 → 闸门 → 落知识集」）：
- ``url:<url>``   直接 URL（原始 .md）；
- ``git:<repo>``  GitHub 仓库（解析 raw.githubusercontent HEAD/SKILL.md，
  仅 URL 拉取，不执行 git 二进制——与 MCP 获取同纪律）；
- ``npm:<pkg>``   npm 包（解析 unpkg SKILL.md，仅 URL 拉取）；
- ``file:<path>`` 本地文件（.md）或目录（SKILL.md + scripts/ 收集）；
- ``text:<内联>`` 直接粘贴 SKILL.md 文本。

provenance = {source_type, source_ref, format, fetched_at}——重导入按
source_ref 重拉 → 与原条目 diff → 升级版本或标记漂移（保持「活连接」）。
"""
from __future__ import annotations

import os
import re
import time
import urllib.request
import uuid
from typing import Any

from ink_engine.core.knowledge_gate import KnowledgeGate
from ink_engine.core.knowledge_set import (
    KIND_SCRIPT,
    KIND_TEMPLATE,
    KnowledgeEntry,
    KnowledgeSet,
)
from ink_engine.core.rules import FixtureSet
from ink_engine.core.schema_validator import SchemaField, SchemaSpec

_FETCH_TIMEOUT = 15.0

# L1 schema：导入条目声明形态（id/level/kind 字段关；注入扫描由闸门 L1 兜底）
_IMPORT_SCHEMA = SchemaSpec(
    name="skillmd.import",
    fields=(
        SchemaField(name="id", required=True, kind="string"),
        SchemaField(name="level", required=True, kind="string"),
        SchemaField(name="kind", required=True, kind="string"),
    ),
)

# L2 fixtures（template/script 条目无规则执行语义——L2 跳过执行，空样例库即可）
_EMPTY_FIXTURES = FixtureSet(name="skillmd", cases=())

_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_YAML_LINE_RE = re.compile(r"^([A-Za-z0-9_\-]+):\s*(.*)$")
_SCRIPT_FILE_RE = re.compile(r"scripts/[A-Za-z0-9_\-./]+")


def parse_skillmd(text: str, *, provenance: dict[str, Any]) -> list[KnowledgeEntry]:
    """SKILL.md 文本 → 知识条目（template 主条目 + script 条目）。

    frontmatter 取 name/description；正文为指令内容。内置脚本引用
    （scripts/ 前缀路径）产出 kind=script 条目（仅声明引用，脚本载荷
    由调用方按源补全——单文件导入无文件载荷 = 空脚本体，留痕声明）。
    结构非法（空正文）＝ 空清单（调用方结构化失败，不静默落垃圾）。
    """
    if not text or not text.strip():
        return []
    provenance = {**provenance, "format": provenance.get("format", "skillmd")}
    frontmatter: dict[str, str] = {}
    body = text
    match = _FRONTMATTER_RE.match(text)
    if match:
        for line in match.group(1).splitlines():
            yaml = _YAML_LINE_RE.match(line)
            if yaml:
                frontmatter[yaml.group(1)] = yaml.group(2).strip()
        body = text[match.end():].strip() or "（无正文说明，见元数据）"

    name = frontmatter.get("name") or frontmatter.get("title") or "外部技能"
    entries: list[KnowledgeEntry] = []
    entries.append(
        KnowledgeEntry(
            id=f"import:{uuid.uuid4().hex[:12]}",
            level="project",
            kind=KIND_TEMPLATE,
            data={
                "content": body,
                "description": frontmatter.get("description", ""),
                "provenance": provenance,
            },
            source="web",
            credibility=0.3,
            title=name,
            tags=("skillmd", name),
        )
    )
    for script_ref in sorted(set(_SCRIPT_FILE_RE.findall(body))):
        entries.append(
            KnowledgeEntry(
                id=f"import:{uuid.uuid4().hex[:12]}",
                level="project",
                kind=KIND_SCRIPT,
                data={
                    "script": {"path": script_ref, "language": _script_lang(script_ref)},
                    "provenance": provenance,
                },
                source="web",
                credibility=0.3,
                title=f"{name} · {script_ref}",
                tags=("skillmd", "script", name),
            )
        )
    return entries


def _script_lang(path: str) -> str:
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    return ext or "plain"


# ── 源解析（多形态 → 拉取文本）──

_SOURCE_PREFIXES = ("url:", "git:", "npm:", "file:", "text:")


def resolve_import_source(source: str) -> tuple[dict[str, Any], str]:
    """source → (provenance, 拉取函数结果文本)。

    返回 (provenance, text)；任何失败抛 ``ImportError``（桥接层转结构化
    错误）。git/npm 只经 URL 拉取，不执行包管理器/版本控制二进制。
    """
    if not isinstance(source, str) or not source.strip():
        raise ImportError("导入源为空")
    for prefix in _SOURCE_PREFIXES:
        if source.startswith(prefix):
            ref = source[len(prefix):].strip()
            return _dispatch(prefix[:-1], ref)
    raise ImportError(
        f"无法识别导入源形态: {source[:80]!r}"
        "（支持 url: / git: / npm: / file: / text: 前缀）"
    )


def _dispatch(kind: str, ref: str) -> tuple[dict[str, Any], str]:
    if kind == "url":
        text = _fetch_text(ref)
        return _provenance("url", ref), text
    if kind == "git":
        m = re.match(r"^([A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+)(?:/|$)", ref)
        if not m:
            raise ImportError(f"git 仓库地址非法: {ref!r}（须为 owner/repo）")
        raw_url = f"https://raw.githubusercontent.com/{m.group(1)}/HEAD/SKILL.md"
        text = _fetch_text(raw_url)
        return _provenance("git", ref), text
    if kind == "npm":
        if not re.match(r"^[@A-Za-z0-9_\-./]+$", ref):
            raise ImportError(f"npm 包名非法: {ref!r}")
        text = _fetch_text(f"https://unpkg.com/{ref}/SKILL.md")
        return _provenance("npm", ref), text
    if kind == "file":
        path = os.path.expanduser(ref)
        if os.path.isdir(path):
            md_path = os.path.join(path, "SKILL.md")
            if not os.path.isfile(md_path):
                raise ImportError(f"目录缺 SKILL.md: {path!r}")
            text = _read_file(md_path)
        elif os.path.isfile(path):
            text = _read_file(path)
        else:
            raise ImportError(f"本地文件不存在: {path!r}")
        return _provenance("file", path), text
    if kind == "text":
        return _provenance("text", "inline"), ref
    raise ImportError(f"未知导入源: {kind!r}")


def _provenance(source_type: str, source_ref: str) -> dict[str, Any]:
    return {
        "source_type": source_type,
        "source_ref": source_ref,
        "format": "skillmd",
        "fetched_at": time.time(),
    }


def _fetch_text(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=_FETCH_TIMEOUT) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception as exc:
        raise ImportError(f"拉取失败: {url[:120]!r}: {exc}") from exc


def _read_file(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        raise ImportError(f"读取失败: {path!r}: {exc}") from exc


# ── 导入编排（拉取 → 解析 → 闸门 → 知识集）──


async def import_skill_source(
    runtime: Any,
    source: str,
    *,
    preview: bool = False,
    gate: KnowledgeGate | None = None,
) -> dict[str, Any]:
    """导入一次外部技能：source → 解析条目 → 三层闸门 → 知识集落位。

    ``preview=True`` 只解析 + 过闸门评估，不落库（前端导入预览：展示将
    创建的条目）。任一源失败 = 结构化失败（绝不裸抛）。落库 = 显式
    save（与 knowledge.add 同持久化语义）。
    """
    knowledge_set = getattr(runtime, "knowledge_set", None)
    if not isinstance(knowledge_set, KnowledgeSet):
        return {"ok": False, "error": "知识集未装配"}
    try:
        provenance, text = resolve_import_source(source)
    except ImportError as exc:
        return {"ok": False, "error": str(exc)}
    entries = parse_skillmd(text, provenance=provenance)
    if not entries:
        return {"ok": False, "error": "SKILL.md 解析无产物（内容为空或形态非法）"}
    gate_inst = gate or KnowledgeGate(human_review_enabled=False)
    accepted: list[KnowledgeEntry] = []
    rejected: list[dict[str, Any]] = []
    for entry in entries:
        l1, l2, l3 = await gate_inst.check(
            entry, schema=_IMPORT_SCHEMA, fixtures=_EMPTY_FIXTURES
        )
        if l1.passed and l2.passed and l3.passed:
            accepted.append(entry)
        else:
            rejected.append(
                {
                    "id": entry.id,
                    "reason": f"L1: {l1.errors or '通过'} / "
                    f"L2: {l2.note or '通过'} / L3: {l3.reason or '通过'}",
                }
            )
    added: list[dict[str, Any]] = []
    if not preview:
        for entry in accepted:
            if knowledge_set.get(entry.id) is None:
                knowledge_set.add(entry)
            added.append(
                {
                    "id": entry.id,
                    "kind": entry.kind,
                    "title": entry.title,
                }
            )
        if getattr(knowledge_set, "storage", None) is not None:
            await knowledge_set.save()
    else:
        added = [
            {"id": e.id, "kind": e.kind, "title": e.title} for e in accepted
        ]
    return {
        "ok": True,
        "source_type": provenance["source_type"],
        "added": added,
        "rejected": rejected,
    }


async def reimport_skill_source(
    runtime: Any,
    entry_id: str,
) -> dict[str, Any]:
    """重导入：按既有条目 provenance 重拉源 → 与原条目 diff。

    内容变化 = 覆盖更新条目（版本信息进 data.provenance.updated_at）；
    不可读源/条目缺 provenance = 结构化失败。保持外部连接「活」——
    重拉即同步，diff 落留痕。
    """
    knowledge_set = getattr(runtime, "knowledge_set", None)
    if not isinstance(knowledge_set, KnowledgeSet):
        return {"ok": False, "error": "知识集未装配"}
    existing = knowledge_set.get(entry_id)
    if existing is None:
        return {"ok": False, "error": f"知识条目不存在: {entry_id}"}
    provenance = (existing.data or {}).get("provenance")
    if not isinstance(provenance, dict) or not provenance.get("source_ref"):
        return {"ok": False, "error": f"条目无 provenance（非外部导入物，不可重导入）: {entry_id}"}
    source_ref = provenance["source_ref"]
    source_type = provenance.get("source_type", "url")
    try:
        text = resolve_import_source(f"{source_type}:{source_ref}")[1]
    except ImportError as exc:
        return {"ok": False, "error": str(exc)}
    entries = parse_skillmd(
        text,
        provenance={**provenance, "updated_at": time.time()},
    )
    if not entries:
        return {"ok": False, "error": "重拉解析无产物"}
    changed = False
    fresh = entries[0]
    if fresh.data.get("content") != existing.data.get("content"):
        changed = True
        knowledge_set.update(entry_id, data=fresh.data)
    return {
        "ok": True,
        "changed": changed,
        "note": "已同步" if not changed else "内容变化已更新",
    }


__all__ = [
    "import_skill_source",
    "parse_skillmd",
    "reimport_skill_source",
    "resolve_import_source",
]

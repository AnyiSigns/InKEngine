"""外部技能导入测试：SKILL.md 解析 / 源分派 / 闸门落库 / 重导入 diff。

覆盖（外部生态接入 = 统一条目模型的一侧通道）：
- SKILL.md frontmatter + 正文 → template 条目（内容 + provenance）；
- 脚本引用 → script 条目；
- 多形态源分派（text:/file:/非法源结构化失败）；
- import preview（只评估不落库）与真实落库（过闸门 + 知识集）；
- reimport 按 provenance 重拉 → diff → 更新 / 缺 provenance 结构化失败。

纯算法 + 本地文件/text 源，零网络。
"""
from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PY_DIR = os.path.join(_HERE, "..")
if _PY_DIR not in sys.path:
    sys.path.insert(0, _PY_DIR)

from types import SimpleNamespace

from ink_engine.core.knowledge_set import KIND_SCRIPT, KIND_TEMPLATE, KnowledgeSet
from inkling_host.skillmd_import import (
    import_skill_source,
    parse_skillmd,
    reimport_skill_source,
    resolve_import_source,
)

_SKILLMD = """---
name: web.chart_extract
description: 从网页抓取图表数据并转结构化表
---

1. 打开目标网页，定位图表容器
2. 提取图表内数据点，转为表格
3. 调用 scripts/extract.py 清洗数据
"""


def _runtime(ks: KnowledgeSet) -> SimpleNamespace:
    return SimpleNamespace(knowledge_set=ks)


# ── ① SKILL.md 解析 ──


def test_parse_skillmd_frontmatter_and_body():
    entries = parse_skillmd(_SKILLMD, provenance={"source_type": "text", "source_ref": "inline"})
    assert entries
    main = entries[0]
    assert main.kind == KIND_TEMPLATE
    assert main.title == "web.chart_extract"
    assert main.level == "project"
    assert "清洗数据" in main.data["content"]
    assert main.data["provenance"]["format"] == "skillmd"
    # 脚本引用 → script 条目
    scripts = [e for e in entries if e.kind == KIND_SCRIPT]
    assert scripts
    assert scripts[0].data["script"]["path"] == "scripts/extract.py"
    assert scripts[0].data["script"]["language"] == "py"


def test_parse_skillmd_empty_returns_empty():
    assert parse_skillmd("", provenance={}) == []
    assert parse_skillmd("   ", provenance={}) == []


# ── ② 源分派 ──


def test_resolve_text_source():
    provenance, text = resolve_import_source("text:" + _SKILLMD)
    assert provenance["source_type"] == "text"
    assert "web.chart_extract" in text


def test_resolve_file_source(tmp_path):
    md = tmp_path / "SKILL.md"
    md.write_text(_SKILLMD, encoding="utf-8")
    provenance, text = resolve_import_source(f"file:{md}")
    assert provenance["source_type"] == "file"
    assert "web.chart_extract" in text
    # 目录形态
    d = tmp_path / "pkg"
    d.mkdir()
    (d / "SKILL.md").write_text(_SKILLMD, encoding="utf-8")
    _provenance2, _text2 = resolve_import_source(f"file:{d}")
    assert "web.chart_extract" in _text2


def test_resolve_invalid_source():
    import pytest

    with pytest.raises(Exception, match="导入源"):
        resolve_import_source("nonsense")
    with pytest.raises(Exception, match="git 仓库地址非法"):
        resolve_import_source("git:not-a-repo")


# ── ③ 导入落库（闸门 + 知识集）──

import asyncio


def test_import_preview_not_persisted():
    ks = KnowledgeSet("u1")
    outcome = asyncio.run(
        import_skill_source(_runtime(ks), "text:" + _SKILLMD, preview=True)
    )
    assert outcome["ok"] is True
    assert outcome["added"]
    assert ks.entries() == []


def test_import_persists_through_gate():
    ks = KnowledgeSet("u1")
    outcome = asyncio.run(import_skill_source(_runtime(ks), "text:" + _SKILLMD))
    assert outcome["ok"] is True
    templates = [e for e in ks.entries() if e.kind == KIND_TEMPLATE]
    assert templates
    entry = templates[0]
    assert entry.kind == KIND_TEMPLATE
    assert entry.source == "web"


def test_import_failed_source_structured():
    ks = KnowledgeSet("u1")
    outcome = asyncio.run(import_skill_source(_runtime(ks), "git:no/repo!!"))
    assert outcome["ok"] is False
    assert outcome["error"]


# ── ④ 重导入 diff ──


def test_reimport_requires_provenance():
    ks = KnowledgeSet("u1")
    from ink_engine.core.knowledge_set import KnowledgeEntry

    ks.add(
        KnowledgeEntry(
            id="k-rule-1", level="project", kind="rule",
            data={"rule": {"message": "本地规则"}}, title="本地规则",
        )
    )
    outcome = asyncio.run(reimport_skill_source(_runtime(ks), "k-rule-1"))
    assert outcome["ok"] is False
    assert "无 provenance" in outcome["error"]


def test_reimport_syncs_content(tmp_path):
    ks = KnowledgeSet("u1")
    md = tmp_path / "SKILL.md"
    md.write_text(_SKILLMD, encoding="utf-8")
    outcome = asyncio.run(import_skill_source(_runtime(ks), f"file:{md}"))
    entry_id = outcome["added"][0]["id"]
    # 上游更新
    md.write_text(_SKILLMD.replace("1. 打开", "1. 先登录再打开"), encoding="utf-8")
    result = asyncio.run(reimport_skill_source(_runtime(ks), entry_id))
    assert result["ok"] is True
    assert result["changed"] is True
    fresh = ks.get(entry_id)
    assert "先登录再打开" in fresh.data["content"]

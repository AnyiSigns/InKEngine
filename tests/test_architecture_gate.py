"""架构门禁：机制层/脚手架层语义中立（领域词零出现）。

core/ 与 components/ 源码（含 docstring/注释/字符串）不得出现创作领域词
（章节/小说/叙事/伏笔/读者/书级/平行起草/世界状态/情节/创作/发散/正文）；
novel_harness/domain_novel 为领域层豁免，宿主语义只允许出现在领域层与宿主。

与「零宿主 import」门禁同族：让领域词在 CI 上报错，防止宿主业务词汇
静默回渗机制层——机制层 API 语义中立、不留领域默认值，策略注入点归
脚手架（components），注入值归宿主。
"""
from __future__ import annotations

from pathlib import Path

_DOMAIN_TERMS: tuple[str, ...] = (
    "章节",
    "小说",
    "叙事",
    "伏笔",
    "读者",
    "书级",
    "平行起草",
    "世界状态",
    "情节",
    "创作",
    "发散",
    "正文",
)

# 门禁覆盖目录（机制层 + 脚手架层）
_GATED_DIRS: tuple[str, ...] = ("core", "components")

_ENGINE_ROOT = Path(__file__).resolve().parents[1] / "ink_engine"


def test_mechanism_layer_is_domain_neutral():
    """core/components 源码零领域词（领域词只允许出现在领域层与宿主）。"""
    hits: list[str] = []
    for sub in _GATED_DIRS:
        base = _ENGINE_ROOT / sub
        for py in sorted(base.rglob("*.py")):
            for lineno, line in enumerate(
                py.read_text(encoding="utf-8").splitlines(), 1
            ):
                for term in _DOMAIN_TERMS:
                    if term in line:
                        rel = py.relative_to(_ENGINE_ROOT)
                        hits.append(
                            f"{rel}:{lineno} 命中领域词「{term}」: {line.strip()[:60]}"
                        )
    assert not hits, (
        "机制层/脚手架层混入领域词（领域词只允许出现在 novel_harness/"
        "domain_novel 与宿主，机制层 API 须语义中立）:\n" + "\n".join(hits)
    )

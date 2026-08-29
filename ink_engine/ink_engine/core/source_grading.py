"""来源分级常量（单一事实来源：知识/检索/记忆共享）。

来源分级顺序（web < dialog < model < user）与默认可信度基准在本模块
单点定义——knowledge_set（知识条目来源）、retrieval（检索 chunk 分级）、
memory（记忆来源权重）三侧复用同一常量，杜绝多份定义漂移
（ENG3-4：两份定义抽单源；ENG3-19：来源/权重概念统一为一套分级类型）。
"""
from __future__ import annotations

# 来源分级（web < dialog < model < user：可信度由使用方按此基准定值）
SOURCE_WEB = "web"
SOURCE_DIALOG = "dialog"
SOURCE_MODEL = "model"
SOURCE_USER = "user"

# 来源分级顺序（升序：web 最低；合并排序/分级映射的次序依据）
SOURCE_ORDER: tuple[str, ...] = (
    SOURCE_WEB,
    SOURCE_DIALOG,
    SOURCE_MODEL,
    SOURCE_USER,
)

# 来源 → 默认可信度基准（web 最低——防 web 注入污染知识集；经落库
# 路径（from_dict）的条目按此分级定值，显式声明的可信度优先）
_SOURCE_CREDIBILITY: dict[str, float] = {
    SOURCE_WEB: 0.3,
    SOURCE_DIALOG: 0.6,
    SOURCE_MODEL: 0.7,
    SOURCE_USER: 0.9,
}


def default_credibility(source: str) -> float:
    """按来源取默认可信度（未知来源 = 模型级，保守不激进）。"""
    return _SOURCE_CREDIBILITY.get(source, _SOURCE_CREDIBILITY[SOURCE_MODEL])


def grade_level_for_credibility(credibility: float) -> str:
    """credibility → 来源分级档（单源函数，检索/知识注入三路径共用）。

    复用 _SOURCE_CREDIBILITY 分级基准：按可信度由高到低匹配，
    首个 credibility ≥ 档位的来源即为该条目分级（同源同权，杜绝多路径
    漂移）。均不匹配最低档时回退 web。
    """
    ranking = sorted(
        ((source, weight) for source, weight in _SOURCE_CREDIBILITY.items()),
        key=lambda pair: pair[1],
        reverse=True,
    )
    for source, weight in ranking:
        if credibility >= weight - 1e-9:
            return source
    return SOURCE_WEB


__all__ = [
    "SOURCE_DIALOG",
    "SOURCE_MODEL",
    "SOURCE_ORDER",
    "SOURCE_USER",
    "SOURCE_WEB",
    "default_credibility",
    "grade_level_for_credibility",
]

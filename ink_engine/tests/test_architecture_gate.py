"""架构门禁：机制层语义中立（领域词零出现）+ 零宿主绑定 + 配方类型白名单。

core/ 源码（含 docstring/注释/字符串）不得出现创作领域词
（章节/小说/叙事/伏笔/读者/书级/平行起草/世界状态/情节/创作/发散/正文）；
领域种子包（seeds/）与宿主为领域词豁免，宿主语义只允许出现在领域层与宿主。

与「零宿主绑定」门禁同族：让领域词与宿主框架词在 CI 上报错，防止宿主
业务词汇/框架绑定静默回渗机制层——机制层 API 语义中立、不留领域默认值，
策略注入点归种子包（seeds/），注入值归宿主；机制层零平台依赖承诺由
「core/ 全目录禁宿主框架字样（含字符串内出现，防绕行）」强制。

装配数据（AssemblyRecipe）字段注解类型白名单：配方只允许核心类型与
鸭子协议（Callable/Protocol）——宿主类型进入配方 = 机制层开始认识宿主。
"""
from __future__ import annotations

import re
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

# 零宿主绑定门禁词表（web 框架与宿主包名；含字符串内出现一并拦截——
# 字符串形态的「提到」即证明机制层知道宿主存在，语义中立要求零知晓）
_HOST_BINDING_TERMS: tuple[str, ...] = (
    "fastapi",
    "starlette",
    "uvicorn",
    "flask",
    "django",
    "text_forge_evo",
)

# 装配数据字段注解类型白名单：核心类型 + 鸭子协议（新增配方类型须
# 同步登记——宿主类型进入配方 = 机制层认识宿主，违反零绑定）
_RECIPE_TYPE_WHITELIST: frozenset[str] = frozenset(
    {
        "Any",
        "ApplyTarget",
        "ApprovalLevel",
        "Callable",
        "ConvergenceHook",
        "EventTypeSpec",
        "Graph",
        "GraphRecipeContext",
        "HarnessDefinition",
        "InterruptPolicy",
        "KnowledgeEntry",
        "None",
        "PatchKind",
        "Path",
        "Retriever",
        "Sequence",
        "ToolSpec",
        "ToolWiring",
        "bool",
        "dict",
        "float",
        "int",
        "list",
        "str",
        "tuple",
    }
)

# 门禁覆盖目录（机制层）
_GATED_DIRS: tuple[str, ...] = ("core",)

_ENGINE_ROOT = Path(__file__).resolve().parents[1] / "ink_engine"


def _scan_source(term: str, *, case_sensitive: bool) -> list[str]:
    """全目录源码扫描命中清单（相对路径:行号 命中词 行预览）。"""
    hits: list[str] = []
    for sub in _GATED_DIRS:
        base = _ENGINE_ROOT / sub
        for py in sorted(base.rglob("*.py")):
            for lineno, line in enumerate(
                py.read_text(encoding="utf-8").splitlines(), 1
            ):
                haystack = line if case_sensitive else line.lower()
                needle = term if case_sensitive else term.lower()
                if needle in haystack:
                    rel = py.relative_to(_ENGINE_ROOT)
                    hits.append(
                        f"{rel}:{lineno} 命中「{term}」: {line.strip()[:60]}"
                    )
    return hits


def test_mechanism_layer_is_domain_neutral():
    """core 源码零领域词（领域词只允许出现在种子包与宿主）。"""
    hits: list[str] = []
    for term in _DOMAIN_TERMS:
        hits.extend(_scan_source(term, case_sensitive=True))
    assert not hits, (
        "机制层混入领域词（领域词只允许出现在 seeds/ 与宿主，机制层 API "
        "须语义中立）:\n" + "\n".join(hits)
    )


def test_mechanism_layer_is_host_binding_free():
    """core 全目录零宿主框架/宿主包字样（含字符串内出现，防绕行）。

    零平台依赖是机制层的承诺：装配与执行只依赖 Storage/LLM/Transport
    等注入式契约，core 源码不得出现任何宿主与 web 框架形态——一旦
    出现即证明机制层开始认识宿主（绑定边界失守）。
    """
    hits: list[str] = []
    for term in _HOST_BINDING_TERMS:
        hits.extend(_scan_source(term, case_sensitive=False))
    assert not hits, (
        "机制层出现宿主/框架字样（零绑定门禁：web 框架与宿主包名在 "
        "core/ 全目录禁止，含字符串内出现）:\n" + "\n".join(hits)
    )


def test_assembly_recipe_annotation_whitelist():
    """装配数据字段注解类型白名单（文本级检查：宿主类型不得进入配方）。

    注解中的每个类型名必须在白名单内（核心类型 + 鸭子协议）——宿主
    类型进入配方 = 机制层认识宿主，违反零绑定承诺。字段默认值表达式
    不做类型判定（默认值只是数据，注解才是边界）。
    """
    source = (_ENGINE_ROOT / "core" / "runtime.py").read_text(encoding="utf-8")
    block = _class_block(source, "class AssemblyRecipe")
    assert block, "runtime.py 未找到 AssemblyRecipe 类体（门禁失守：类被改名/移除）"
    forbidden: list[str] = []
    for lineno, line in enumerate(block.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        match = re.match(r"^[a-zA-Z_][a-zA-Z0-9_]*:\s*(.*)$", stripped)
        if match is None:
            continue
        annotation = match.group(1)
        default_marker = annotation.find("=")
        if default_marker >= 0:
            annotation = annotation[:default_marker]
        # 注解是类型语法（恒为 ASCII）：docstring 的属性说明行含全角字符
        # 与自由文本，不参与类型判定
        if not annotation.isascii():
            continue
        for name in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", annotation):
            if name not in _RECIPE_TYPE_WHITELIST:
                forbidden.append(f"line {lineno}: 注解含白名单外类型 {name!r}")
    assert not forbidden, (
        "装配数据字段注解混入宿主/未知类型（配方只允许核心类型与鸭子协议; "
        "新增合法核心类型须同步登记白名单）:\n" + "\n".join(forbidden)
    )


def _class_block(source: str, marker: str) -> str:
    """取类体源码（marker 行到下一个零缩进行之间；方法体不纳入扫描）。"""
    lines = source.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(marker)), -1)
    if start < 0:
        return ""
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line and not line[0].isspace():
            break
        if line.lstrip().startswith("def "):
            continue
        body.append(line)
    return "\n".join(body)

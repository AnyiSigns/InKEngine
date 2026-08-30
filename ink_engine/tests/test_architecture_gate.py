"""架构门禁：机制层语义中立（领域词零出现）+ 零宿主绑定 + 配方类型白名单。

core/ 源码与机制文档（docs/ 概念/扩展点/宿主/安全/API/架构）不得出现
创作领域词（中文形态 + 已实证的英文标识符形态：novel/world_state）；
领域种子包（seeds/）与宿主为领域词豁免，宿主语义只允许出现在领域层与宿主。
注：「发散」不在词表——其为引擎机制术语（fan_out 发散-收敛）中文译名，
字面扫描无法与创作语境区分，故豁免并依赖文档语义审查。

与「零宿主绑定」门禁同族：让领域词与宿主框架词在 CI 上报错，防止宿主
业务词汇/框架绑定静默回渗机制层——机制层 API 语义中立、不留领域默认值，
策略注入点归种子包（seeds/），注入值归宿主；机制层零平台依赖承诺由
「core/ 全目录禁宿主框架字样（含字符串内出现，防绕行）」强制。

装配数据（AssemblyRecipe）字段注解类型白名单：配方只允许核心类型与
鸭子协议（Callable/Protocol）——宿主类型进入配方 = 机制层开始认识宿主。
"""
from __future__ import annotations

import ast
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
    "正文",
    # 英文标识符形态（证据驱动：曾以英文形态逃过中文词表，如 novel.world_state）
    "novel",
    "world_state",
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
        "CompressionPolicy",
        "ConvergenceHook",
        "EntitySpec",
        "EventTypeSpec",
        "Graph",
        "GraphRecipeContext",
        "HarnessDefinition",
        "InterruptPolicy",
        "KnowledgeEntry",
        "NetworkPolicy",
        "None",
        "PatchKind",
        "Path",
        "Retriever",
        "RunOptions",
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

# 机制文档（docs/ 下与门禁同权的文档；README 为门面、CHANGELOG 为历史
# 沿革记录，均豁免——门面与历史不是机制契约的载体）
_GATED_DOCS: tuple[str, ...] = (
    "api",
    "architecture",
    "concepts",
    "extensions",
    "hosts",
    "security",
)

# 装配数据字段文档化清单（与 runtime.py AssemblyRecipe 声明逐一对应；
# 新增/改名/删除字段须同步更新，防「文档-源码漂移」——引擎侧自省防线）
_ASSEMBLY_RECIPE_FIELDS: tuple[str, ...] = (
    "set_id",
    "seeds",
    "harness_definitions",
    "event_type_specs",
    "entity_specs",
    "ui_spec",
    "ui_allowed_channels",
    "ui_allowed_components",
    "ui_allowed_theme_tokens",
    "tool_wiring",
    "vetting_static_hooks",
    "vetting_l2_hook",
    "approval_levels",
    "retrieval_sources",
    "apply_targets",
    "graph_recipe",
    "on_reverted",
    "convergence_provider",
    "run_options",
    "compress_policy",
    "verify_retry_limit",
    "emit_timeline_events",
)

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


def test_mechanism_docs_are_domain_neutral():
    """机制文档零领域词（文档与源码同权；README/CHANGELOG 豁免）。

    领域词曾以「机制章节」形态渗入概念文档（世界状态层整节）而门禁
    只扫源码未覆盖——docs/ 与 core/ 同为机制契约载体，一并拦截。
    """
    hits: list[str] = []
    for term in _DOMAIN_TERMS:
        needle = term.lower()
        for doc in _GATED_DOCS:
            path = _ENGINE_ROOT.parent / "docs" / f"{doc}.md"
            for lineno, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), 1
            ):
                if needle in line.lower():
                    hits.append(
                        f"{doc}.md:{lineno} 命中「{term}」: {line.strip()[:60]}"
                    )
    assert not hits, (
        "机制文档混入领域词（领域词只允许出现在 seeds/ 与宿主，机制文档 "
        "与机制源码同权）:\n" + "\n".join(hits)
    )


def test_assembly_recipe_documented_fields():
    """装配数据字段与文档化清单一致（AST 提取 vs 声明清单）。

    文档化清单是「文档-源码漂移」防线的引擎侧版本：字段改名/删除/新增
    未登记都会失配（与种子侧 AST 计数门禁同族但名字级更严），防止数据
    基线按错误口径落盘。
    """
    source = (_ENGINE_ROOT / "core" / "runtime.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    fields: list[str] = []
    for node in tree.body:
        if not (isinstance(node, ast.ClassDef) and node.name == "AssemblyRecipe"):
            continue
        for stmt in node.body:
            if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
                fields.append(stmt.target.id)
            elif isinstance(stmt, ast.Assign):
                for target in stmt.targets:
                    if isinstance(target, ast.Name):
                        fields.append(target.id)
        break
    assert tuple(fields) == _ASSEMBLY_RECIPE_FIELDS, (
        "AssemblyRecipe 字段与文档化清单失配（字段变更须同步更新 "
        f"_ASSEMBLY_RECIPE_FIELDS；实际={tuple(fields)} "
        f"期望={_ASSEMBLY_RECIPE_FIELDS}）"
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

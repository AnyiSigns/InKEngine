"""种子沉淀池（seed harvesting）：集内成熟形态 → 共享种子包。

集内经实战验证的领域形态（harness + 工具 + 领域知识）经 vetting
（质量/通用性/去隐私三道检查）后导出为种子包，落 ``~/.textforge/seeds/``
目录——新集/新机器开局注入即得（种子只读基线，注入后即演化）。

vetting 语义（信任行为证据不信任生成物）：
- 质量：harness 定义可往返解析、名称/描述/关键词齐全；
- 通用性：种子基线条目（seed. 前缀）不回捞，本机路径形态仅告警
  （跨机通用性风险提示，不阻断）；
- 去隐私：疑似密钥字段（api_key/secret/token 等 JSON 键）直接拒绝
  ——fail-closed，隐私泄漏宁可拒收不可外流。
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from ink_engine.core.exceptions import GraphDefinitionError
from ink_engine.core.harness import HarnessDefinition
from ink_engine.core.knowledge_set import KIND_RULE, KnowledgeEntry

from . import config

# 种子包格式版本（结构演进而非兼容破坏的判据）
_SEED_FORMAT = "forge.seed.v1"
# 种子包清单文件名（每个种子一个目录）
_MANIFEST_NAME = "manifest.json"
# 种子条目 id 前缀（种子基线只读注入物；沉淀时回捞过滤依据）
_SEED_ID_PREFIX = "seed."

# 去隐私：疑似密钥字段的 JSON 键形态（对象键命中即拒绝沉淀）
_SECRET_KEY_PATTERN = re.compile(
    r'"([^"]*(?:api[_-]?key|secret|password|passwd|private[_-]?key|authorization|credential)[^"]*)"\s*:',
    re.IGNORECASE,
)
# 去隐私：疑似密钥的值形态（键=值 赋值式与常见凭据 token 形状——
# 值内嵌密钥同样拒绝，fail-closed 覆盖键与值两种形态）
_SECRET_VALUE_PATTERN = re.compile(
    r"(?:api[_-]?key|password|passwd|secret|private[_-]?key|authorization|credential)"
    r"\s*[=:]\s*[^\s,}\"'，。]+|"
    r"\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|"
    r"AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})\b",
    re.IGNORECASE,
)
# 通用性告警：本机路径形态（Windows 盘符 / Unix home / 环境变量展开）
_PATH_PATTERN = re.compile(
    r"(?:\b[A-Za-z]:\\)|(?:/(?:Users|home)/)|(?:\$HOME)|(?:~[/\\])"
)
# 领域知识回捞上限（种子包体积有界）
_KNOWLEDGE_LIMIT = 20


def is_safe_seed_name(name: Any) -> bool:
    """种子名校验（目录段安全）：非空字符串且不含路径分隔/穿越段。

    落盘侧与读取侧共用同一判定（不对称防护 = 越界写入口）：
    拒绝 ``/`` ``\\`` ``..`` 与绝对路径形态（盘符/根开头）。
    """
    if not isinstance(name, str) or not name.strip():
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return not (re.match(r"^[A-Za-z]:", name) or name.startswith(("/", "~")))


def seeds_dir() -> Path:
    """种子仓库目录（幂等创建）。"""
    path = config.SEEDS_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def harvest_package(app: Any, domain_name: str, *, note: str = "") -> dict:
    """从集内成熟形态组装种子包（vetting 未通过 = 抛错，不落盘）。

    Args:
        app: Forge 装配产物（harness 注册表 + 知识集）。
        domain_name: 要沉淀的领域名（须已注册 harness）。
        note: 沉淀说明（用途/版本语义，入包留痕）。

    Returns:
        种子包 dict（含 vetting 摘要；调用方经审批后落盘）。

    Raises:
        GraphDefinitionError: 领域不存在或 vetting 未通过（violations）。
    """
    definition = app.harness_registry.get(domain_name)
    if definition is None:
        raise GraphDefinitionError(
            f"领域不存在（无法沉淀）: {domain_name}（须先注册 harness）"
        )
    # 领域知识：关键词命中的演化产物（种子基线不回捞——只沉淀实战经验）
    knowledge: list[dict] = []
    for entry in app.knowledge_set.search(domain_name, limit=_KNOWLEDGE_LIMIT, kind=KIND_RULE):
        if entry.id.startswith(_SEED_ID_PREFIX):
            continue
        knowledge.append(entry.to_dict())
    package: dict[str, Any] = {
        "format": _SEED_FORMAT,
        "name": domain_name,
        "description": str(getattr(definition, "description", "") or ""),
        "note": note,
        "harness": definition.to_dict(),
        "knowledge": knowledge,
        "source_set": config.SET_ID,
        "harvested_at": time.time(),
        "vetting": {"violations": [], "warnings": []},
    }
    # 全量校验并写入 vetting 摘要（警告入包留痕供审批方判断）
    violations, _warnings = vet_package(package)
    if violations:
        raise GraphDefinitionError("种子沉淀校验未通过: " + "；".join(violations))
    return package


def vet_package(package: dict) -> tuple[list[str], list[str]]:
    """种子包 vetting（质量/通用性/去隐私）；violations 非空 = 拒收。

    质量失败 = 硬拒绝（种子包须可被注入方直接消费）；隐私风险 =
    硬拒绝（fail-closed，隐私泄漏宁可拒收不可外流）；本机路径 =
    告警（跨机通用性风险，入包留痕供审批方判断）。
    """
    violations: list[str] = []
    warnings: list[str] = []
    name = package.get("name")
    if not is_safe_seed_name(name):
        violations.append("种子名非法（须为非空字符串，且不含路径分隔/穿越段）")
    if not package.get("description"):
        violations.append("种子缺 description（通用性说明）")
    harness = package.get("harness")
    if not isinstance(harness, dict):
        violations.append("种子缺 harness（领域定义 dict）")
    else:
        try:
            parsed = HarnessDefinition.from_dict(harness)
            if not parsed.keywords:
                violations.append("harness 缺 keywords（路由匹配依据）")
        except GraphDefinitionError as exc:
            violations.append(f"harness 定义非法: {exc}")
    blob = json.dumps(package, ensure_ascii=False)
    if _SECRET_KEY_PATTERN.search(blob):
        violations.append(
            "种子含疑似密钥字段（api_key/secret/token/authorization 等 JSON 键），"
            "已拒绝沉淀（隐私保护 fail-closed）"
        )
    if _SECRET_VALUE_PATTERN.search(blob):
        violations.append(
            "种子含疑似密钥内容（键=值 赋值式或凭据 token 形状），"
            "已拒绝沉淀（隐私保护 fail-closed）"
        )
    for match in _PATH_PATTERN.finditer(blob):
        warnings.append(f"种子含本机路径形态 {match.group(0)!r}（跨机通用性风险）")
        if len(warnings) >= 3:
            break
    for raw in package.get("knowledge") or []:
        if not isinstance(raw, dict):
            violations.append("知识条目非法（非 dict）")
            continue
        try:
            KnowledgeEntry.from_dict(raw)
        except GraphDefinitionError as exc:
            violations.append(f"知识条目非法: {exc}")
    package["vetting"]["violations"] = violations
    package["vetting"]["warnings"] = warnings
    return violations, warnings


async def save_seed_package(package: dict) -> Path:
    """种子包落盘（原子写：临时文件 + rename；重名覆盖为版本更新）。

    落盘侧名称防护（与读取侧同一判定 + 解析后约束）：名称含路径
    分隔/穿越段 = 拒绝——防恶意领域名把清单写到种子仓库之外。
    """
    name = package.get("name")
    if not is_safe_seed_name(name):
        raise GraphDefinitionError("种子包名称非法（含路径分隔/穿越段），拒绝落盘")
    target_dir = seeds_dir() / name
    # 解析后双重约束：目标目录必须仍在种子仓库内（防符号链接/边界绕过）
    resolved = target_dir.resolve()
    root = seeds_dir().resolve()
    if not str(resolved).startswith(str(root)):
        raise GraphDefinitionError("种子包落盘路径越界，拒绝写入")
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest = target_dir / _MANIFEST_NAME
    tmp = manifest.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(manifest)
    return manifest


def list_seeds() -> list[dict]:
    """本地种子仓库清单（目录 → 摘要；损坏清单跳过不阻断）。"""
    results: list[dict] = []
    root = config.SEEDS_DIR
    if not root.is_dir():
        return results
    for entry in sorted(root.iterdir(), key=lambda p: p.name):
        manifest = entry / _MANIFEST_NAME
        if not manifest.is_file():
            continue
        try:
            package = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(package, dict):
            continue
        results.append(
            {
                "name": package.get("name") or entry.name,
                "description": package.get("description") or "",
                "format": package.get("format") or "",
                "source_set": package.get("source_set") or "",
                "harvested_at": float(package.get("harvested_at") or 0),
                "knowledge_count": len(package.get("knowledge") or []),
                "note": package.get("note") or "",
            }
        )
    return results


def read_seed(name: str) -> dict | None:
    """按名读取种子包（不存在/损坏 = None）。

    读取侧名称防护与落盘侧同一判定（is_safe_seed_name）：注入路径
    的读入口——新集/新机器开局「注入即得」时按名取包消费。
    """
    if not is_safe_seed_name(name):
        return None
    manifest = config.SEEDS_DIR / name / _MANIFEST_NAME
    try:
        package = json.loads(manifest.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return package if isinstance(package, dict) else None


__all__ = [
    "harvest_package",
    "is_safe_seed_name",
    "list_seeds",
    "read_seed",
    "save_seed_package",
    "seeds_dir",
    "vet_package",
]

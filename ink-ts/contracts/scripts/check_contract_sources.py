"""契约 fixture 与旧侧事实源的双向一致性断言（P0 门禁雏形）。

对照关系：
- endpoint_registry.fixture.json  ↔  ink_engine/core/declarative_tools.py 内置注册表
- patch_protocol.fixture.json    ↔  self_proposal.py / self_application.py /
                                   patch_chain.py 枚举与常量（含声明顺序）
- event_types 名称               ↔  inkling/seed_data/event_types.json 与
                                   inkling/frontend/src/shared/session/eventTypes.ts

机制层纪律：本脚本只读旧侧源码与契约文件，任一方向漂移即非零退出。
运行环境：仓库根 venv（Python），入口为仓库根相对路径。
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve()
while not (ROOT / "AGENTS.md").exists() and ROOT.parent != ROOT:
    ROOT = ROOT.parent
CONTRACTS = ROOT / "ink-ts" / "contracts"
CORE = ROOT / "ink_engine" / "ink_engine" / "core"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def enum_values(path: Path, class_name: str) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            out = []
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1:
                    t = stmt.targets[0]
                    if isinstance(t, ast.Name) and t.id.isupper() and isinstance(stmt.value, ast.Constant):
                        out.append(stmt.value.value)
            return out
    raise SystemExit(f"{class_name} 未找到: {path}")


def guarded_frozenset(path: Path, name: str) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    consts = {}
    for n in ast.walk(tree):
        target = n.target if isinstance(n, ast.AnnAssign) else (
            n.targets[0] if isinstance(n, ast.Assign) and len(n.targets) == 1 else None)
        if isinstance(target, ast.Name) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str):
            consts[target.id] = n.value.value
    for node in ast.walk(tree):
        target = node.target if isinstance(node, ast.AnnAssign) else (
            node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None)
        if (isinstance(target, ast.Name) and target.id == name and isinstance(node.value, ast.Call)
                and getattr(node.value.func, "id", "") == "frozenset"):
            args = node.value.args
            if args and isinstance(args[0], (ast.Set, ast.Tuple, ast.List)):
                vals = []
                for e in args[0].elts:
                    if isinstance(e, ast.Name) and e.id in consts:
                        vals.append(consts[e.id])
                    elif isinstance(e, ast.Constant):
                        vals.append(e.value)
                return vals
    raise SystemExit(f"{name} 未找到: {path}")


def members(path: Path, class_name: str) -> dict[str, str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            m = {}
            for stmt in node.body:
                if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Constant):
                    for tg in stmt.targets:
                        if isinstance(tg, ast.Name):
                            m[tg.id] = stmt.value.value
            return m
    return {}


def source_order_strs(path: Path, prefix: str) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in ast.walk(tree):
        target = node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None
        if (isinstance(target, ast.Name) and target.id.startswith(prefix)
                and isinstance(node.value, ast.Constant)):
            out.append(node.value.value)
    return out


def check_endpoint_registry(issues: list[str]) -> None:
    fixture = load_json(CONTRACTS / "fixtures" / "endpoint_registry.fixture.json")
    sys.path.insert(0, str(ROOT))
    from ink_engine.ink_engine.core.declarative_tools import EndpointType, endpoint_registry

    enum_names = [e.value for e in EndpointType]
    if set(enum_names) != set(endpoint_registry.names):
        issues.append(f"端点枚举/注册表不一致: {enum_names} vs {endpoint_registry.names}")
    snap_map = {b["name"]: b for b in fixture["builtin_endpoints"]}
    if sorted(enum_names) != sorted(snap_map):
        issues.append(f"fixture 名称 ≠ 枚举: {sorted(snap_map)} vs {sorted(enum_names)}")
    for spec in endpoint_registry._specs.values():
        b = snap_map.get(spec.name)
        if b is None:
            issues.append(f"fixture 缺失端点: {spec.name}")
            continue
        if tuple(b["actions"]) != tuple(spec.actions):
            issues.append(f"{spec.name} actions: {b['actions']} != {spec.actions}")
        if tuple(b["config_requirements"]) != tuple(spec.config_requirements):
            issues.append(f"{spec.name} config_requirements: {b['config_requirements']} != {spec.config_requirements}")
        if tuple(b["sandbox_ops"]) != tuple(spec.sandbox_ops):
            issues.append(f"{spec.name} sandbox_ops: {b['sandbox_ops']} != {spec.sandbox_ops}")
        snap_fields = [(f["name"], f["required"], f["kind"]) for f in b["output_fields"]]
        reg_fields = [(f.name, f.required, f.kind) for f in spec.output_fields]
        if snap_fields != reg_fields:
            issues.append(f"{spec.name} output_fields: {snap_fields} != {reg_fields}")


def check_patch_protocol(issues: list[str]) -> None:
    fixture = load_json(CONTRACTS / "fixtures" / "patch_protocol.fixture.json")
    self_application = (CORE / "self_application.py").read_text(encoding="utf-8")

    patch_kinds = enum_values(CORE / "self_proposal.py", "PatchKind")
    levels = enum_values(CORE / "self_application.py", "ApprovalLevel")
    ops = enum_values(CORE / "patch_chain.py", "PatchOp")
    guarded = guarded_frozenset(CORE / "self_application.py", "_GUARDED_COLLECTIONS")
    audit_order = source_order_strs(CORE / "self_application.py", "AUDIT_STATUS_")
    prefix_match = re.search(
        r"_GUARDED_PREFIXES: tuple\[str, ...\] = \(\n((?:\s+\"[^\"]+\",\n)+)\)", self_application)
    prefix_vals = re.findall(r'"([^"]+)"', prefix_match.group(1)) if prefix_match else []

    kind_members = members(CORE / "self_proposal.py", "PatchKind")
    lvl_members = members(CORE / "self_application.py", "ApprovalLevel")
    default_levels = {}
    tree = ast.parse(self_application)
    for node in ast.walk(tree):
        target = node.target if isinstance(node, ast.AnnAssign) else (
            node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None)
        if isinstance(target, ast.Name) and target.id == "DEFAULT_APPROVAL_LEVELS" and isinstance(node.value, ast.Dict):
            for k, v in zip(node.value.keys, node.value.values):
                if isinstance(k, ast.Attribute) and isinstance(v, ast.Attribute):
                    default_levels[kind_members.get(k.attr, k.attr)] = lvl_members.get(v.attr, v.attr)

    if fixture["patch_kinds"] != patch_kinds:
        issues.append(f"patch_kinds: {fixture['patch_kinds']} != {patch_kinds}")
    if fixture["approval_levels"] != levels:
        issues.append(f"approval_levels: {fixture['approval_levels']} != {levels}")
    if fixture["audit_statuses"] != audit_order:
        issues.append(f"audit_statuses: {fixture['audit_statuses']} != {audit_order}")
    if set(fixture["guarded_collections"]) != set(guarded):
        issues.append(f"guarded_collections: {fixture['guarded_collections']} != {guarded}")
    if fixture["guarded_prefixes"] != prefix_vals:
        issues.append(f"guarded_prefixes: {fixture['guarded_prefixes']} != {prefix_vals}")
    if fixture["patch_ops"] != ops:
        issues.append(f"patch_ops: {fixture['patch_ops']} != {ops}")
    if fixture["default_approval_levels"] != default_levels:
        issues.append(f"default_approval_levels: {fixture['default_approval_levels']} != {default_levels}")


def check_schema_self_and_fixtures(issues: list[str]) -> None:
    try:
        from jsonschema import Draft7Validator
    except ImportError:
        issues.append("jsonschema 未安装，schema 自检与 fixture 校验跳过")
        return
    schemas = {
        "endpoint_registry": "endpoint_registry",
        "patch_protocol": "patch_protocol",
        "assembly_recipe": None,
    }
    for schema_name, fixture_name in schemas.items():
        schema_path = CONTRACTS / "schemas" / f"{schema_name}.schema.json"
        schema_doc = load_json(schema_path)
        try:
            Draft7Validator.check_schema(schema_doc)
        except Exception as exc:
            issues.append(f"{schema_name}: 非法 draft-07: {exc}")
            continue
        if fixture_name is None:
            continue
        data = load_json(CONTRACTS / "fixtures" / f"{fixture_name}.fixture.json")
        errs = sorted(Draft7Validator(schema_doc).iter_errors(data), key=lambda e: list(e.path))
        if errs:
            issues.append(f"{schema_name}: fixture 未过 schema: {errs[0].message} @ {list(errs[0].path)}")


def check_seed_tools_endpoints(issues: list[str]) -> None:
    fixture = load_json(CONTRACTS / "fixtures" / "endpoint_registry.fixture.json")
    builtin = {b["name"] for b in fixture["builtin_endpoints"]}
    tools = load_json(ROOT / "inkling" / "seed_data" / "tools.json")["tools"]
    used = {t["endpoint"] for t in tools if "endpoint" in t}
    if not used <= builtin:
        issues.append(f"tools.json 端点越界: {sorted(used - builtin)}")
    missing = builtin - used
    if missing:
        issues.append(f"tools.json 未覆盖内置端点: {sorted(missing)}")


def check_recipe_data_plane(issues: list[str]) -> None:
    rs = (ROOT / "inkling" / "shell" / "src-tauri" / "src" / "domain" / "recipe.rs").read_text(encoding="utf-8")
    block = re.search(r"pub struct AssemblyRecipeData \{(.*?)\n\}", rs, re.S)
    if not block:
        issues.append("recipe.rs: AssemblyRecipeData 结构体未找到")
        return
    fields = re.findall(r"^\s+pub (\w+):", block.group(1), re.M)
    schema_doc = load_json(CONTRACTS / "schemas" / "assembly_recipe.schema.json")
    schema_fields = [k for k in schema_doc["required"] if k != "version"]
    if sorted(fields) != sorted(schema_fields):
        issues.append(f"AssemblyRecipeData 数据面漂移: rust={sorted(fields)} schema={sorted(schema_fields)}")


def check_event_type_names(issues: list[str]) -> None:
    seed_names = [e["name"] for e in load_json(ROOT / "inkling" / "seed_data" / "event_types.json")["events"]]
    ts = (ROOT / "inkling" / "frontend" / "src" / "shared" / "session" / "eventTypes.ts").read_text(encoding="utf-8")
    block = re.search(r"export const EVENT_TYPE_NAMES = \[(.*?)\] as const;", ts, re.S)
    front_names = re.findall(r"'([^']+)'", block.group(1))
    if set(seed_names) != set(front_names):
        issues.append(
            "事件类型名称漂移: seed_only=%s front_only=%s"
            % (sorted(set(seed_names) - set(front_names)), sorted(set(front_names) - set(seed_names)))
        )
    if len(seed_names) != len(set(seed_names)) or len(front_names) != len(set(front_names)):
        issues.append("事件类型名称存在重复")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    issues: list[str] = []
    check_schema_self_and_fixtures(issues)
    check_endpoint_registry(issues)
    check_patch_protocol(issues)
    check_event_type_names(issues)
    check_seed_tools_endpoints(issues)
    check_recipe_data_plane(issues)
    if issues:
        print("FAIL")
        for item in issues:
            print(" -", item)
        return 1
    print("PASS: schema 自检 / 端点注册表 / 补丁协议 / 事件类型 / tools 端点 / 配方数据面 与旧侧事实源一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())

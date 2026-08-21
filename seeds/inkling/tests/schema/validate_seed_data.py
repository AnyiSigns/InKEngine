"""InKling 种子数据全量校验（M0 出厂门禁之一：schema 检查）。

单一入口校验全部 seed_data JSON：先按各自 JSON Schema 逐文件校验
（缺失字段/多余字段/类型错误/空值边界全覆盖），再做跨文件一致性
检查（graph↔workflow、ui_spec↔event_types↔manifest、rules↔review、
tools↔workflow、samples↔rules），最后运行内置自检夹具验证本脚本
自身的检查器行为无误（正例通过、反例报错），并核实引擎源码事实
（AssemblyRecipe 字段数以 runtime.py 为准、engine 版本以 pyproject
为准）。

脚本零第三方依赖（仅标准库），单命令运行：python validate_seed_data.py
退出码 0 = 全绿；非 0 = 存在违规（输出含文件与原因，可直接定位修复）。
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

# ── 路径与文件清单（脚本所在 tests/schema/ 向上四级 = 仓库根）──
REPO_ROOT = Path(__file__).resolve().parents[4]
SEED_ROOT = REPO_ROOT / "seeds" / "inkling"
SEED_DATA_DIR = SEED_ROOT / "seed_data"
SCHEMA_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = SEED_ROOT / "manifest.json"
ENGINE_PYPROJECT = REPO_ROOT / "ink_engine" / "pyproject.toml"
ENGINE_RUNTIME = REPO_ROOT / "ink_engine" / "ink_engine" / "core" / "runtime.py"

# 必须交付的 16 个 seed_data 文件（缺一即失败，防漏交付）
EXPECTED_SEED_FILES: tuple[str, ...] = (
    "boot_prompt.json",
    "ui_spec.json",
    "event_types.json",
    "graph.json",
    "tools.json",
    "rules.json",
    "samples.json",
    "templates.json",
    "knowledge.json",
    "workflow.json",
    "signals.json",
    "tiers.json",
    "review.json",
    "memory.json",
    "env.json",
    "mcp_market.json",
)

# ── 引擎事实常量（以源码为准的核对基准；与 ink_engine 源码对齐）──
# AssemblyRecipe 字段数以 runtime.py 源码为准：出厂基线 16 字段，M3 接线
# 期新增 ui_allowed_channels（界面绑定通道白名单，装配数据扩展）后为 17
# 字段；计划文本原写「17 字段」的表述与此计数偶合。引擎侧任何字段增删
# 都会让本门禁失配，须同步更新本常量
ASSEMBLY_RECIPE_FIELD_COUNT = 17
# 引擎 pyproject 当前版本（核实失败时回落值；实际以 pyproject.toml 解析结果优先）
ENGINE_VERSION_FALLBACK = "0.1.0"

# ── manifest 身份定稿值（§5 表）──
MANIFEST_ID = "inkling"
MANIFEST_NAME = "InKling"
MANIFEST_POSITIONING = "你用得越多，它越懂你的领域"
MANIFEST_DOMAIN_BOOT = "知识/研究孵化"
MANIFEST_VERSION = "0.1.0"
MANIFEST_THEME: dict[str, str] = {
    "bg.base": "#09090b",
    "text.base": "#e4e4e7",
    "accent.approval": "#f59e0b",
}

# ── 自举提示词定稿（§5.1 原文，逐字比对）──
BOOT_PROMPT_FINAL = (
    "你是 InKling——一个自进化认知伙伴。你对用户的领域起初只有隐约的理解，"
    "通过观察、检索、校验与孵化，把使用中积累的理解沉淀为可信的知识；每一次"
    "变化都经审批、可审计、可回退；你也可以提议接入外部工具/插件来扩展能力，"
    "经你确认后生效。用中文简明作答。"
)

# ── 领域契约枚举（与引擎源码常量对齐，防魔法字符串）──
SIGNAL_KINDS = ("pitfall", "user_correction", "insight", "gap", "repeated_root_cause")
SOURCE_KINDS = ("web", "dialog", "model", "user")
KNOWLEDGE_LEVELS = ("work", "project", "user")
KNOWLEDGE_KINDS = ("rule", "template", "weight", "tool_rule")
PATCH_KINDS = ("ui", "theme", "tool", "rule", "knowledge", "harness", "event_type", "environment", "artifact")
ENDPOINT_TYPES = ("http_fetch", "process_exec", "file_ops", "mcp")
APPROVAL_TIERS = ("allow", "review", "deny")
TIER_NAMES = ("router", "tool", "main", "audit")
ENV_RUNTIMES = ("local", "web_bridge", "container")
MCP_TRANSPORTS = ("http", "stdio", "in_memory")
RISK_LEVELS = ("low", "medium", "high")

# 出厂注册的两个通用节点类型（§2 图结构演化边界，HARNESS 可改）
GRAPH_NODE_TYPES = ("research_orchestrator", "tool_pipeline")
# 研究编排节点返回的保留键（§2）
ORCHESTRATOR_RESERVED_KEYS = ("__plan__", "__spawn__", "__simulate__")

# 领域工具（M1 exec 执行体一一对应：采集/解析/校验/评分/评审/蒸馏/变异）
DOMAIN_TOOLS = (
    "collect_material",
    "parse_material",
    "validate_material",
    "score_material",
    "review_material",
    "distill_knowledge",
    "mutate_knowledge",
)
# shell 执行器注册（§5.3 七件：感知/控制，M2 契约测试同源）
SHELL_EXECUTORS = ("launch_app", "open_file", "system_query", "set_volume", "set_brightness", "notify", "schedule")
# OS 控制类（六件；system_query 属感知/状态查询）
OS_CONTROL_TOOLS = ("launch_app", "open_file", "set_volume", "set_brightness", "notify", "schedule")
# 设备感知类（屏幕/文件状态，经 inkling_shell 设备感知 server 挂载接线）
DEVICE_SENSE_TOOLS = ("screen_query", "file_query")
# 挂载提案 + 文件开发工具（对话式安装入口 / 工作区沙箱端点）
SELF_AND_FILE_TOOLS = ("propose_mcp_mount", "file_read", "file_write", "file_edit")

# 规则谓词（M1 Rust 谓词执行体实现清单，数据↔执行件绑定的契约面）
DOMAIN_PREDICATES = ("has_fields", "in_enum", "max_length", "non_empty_string", "min_value", "no_injection_phrase")

# 样例库边界值（与 samples.json 对应用例绑定：max_length 上限 120 的边界用例）
TITLE_MAX_CHARS = 120
SAMPLE_AT_MAX = "material_title_at_max"
SAMPLE_OVER_MAX = "material_title_over_max"

# 跨文件数值联动基准（review 阈值 ↔ 规则阈值，防双源漂移）
REVIEW_PASS_THRESHOLD = 0.75
REVIEW_MAX_ROUNDS = 2
REVIEW_BEAM_WIDTH = 1
REVIEW_NEUTRAL_SCORE = 0.5

# 信号蒸馏阈值（引擎 knowledge_signals 常量）
DISTILL_COMPLEXITY_THRESHOLD = 5
DISTILL_INTERVENTION_THRESHOLD = 1
REPEAT_THRESHOLD = 3

# 记忆失效窗口（默认 90 天，设置页可调）
MEMORY_DEFAULT_WINDOW_DAYS = 90

# 绑定路径保留前缀（引擎 ui_schema：_ 开头路径段为内部数据，禁绑定）
RESERVED_BIND_PREFIX = "_"
# 事件通道前缀（ui_spec 的 events.* 通道须与 event_types.json 逐一对应）
EVENT_CHANNEL_PREFIX = "events."


class SchemaError(Exception):
    """Schema 定义本身非法（$ref 指向不存在的 definitions 等）。"""


class MiniSchemaValidator:
    """JSON Schema 子集检查器（零依赖，覆盖本仓库全部 schema 用到的关键字）。

    支持的关键字：type（含联合类型数组）/properties/required/
    additionalProperties（false = 多余字段违规）/items/minItems/maxItems/
    uniqueItems/enum/const/pattern/minLength/minimum/maximum/$ref
    （仅 "#/definitions/<名>" 形态，随 schema 内联）。未知关键字忽略
    （schema 演进宽容），与引擎 SchemaValidator 的校验哲学同构。
    """

    def __init__(self, schema: dict[str, Any]) -> None:
        self._schema = schema
        self._defs = schema.get("definitions") or {}

    def _resolve(self, node: dict[str, Any]) -> dict[str, Any]:
        ref = node.get("$ref")
        if ref is None:
            return node
        if not ref.startswith("#/definitions/"):
            raise SchemaError(f"不支持的 $ref 形态: {ref!r}（仅 #/definitions/<名>）")
        name = ref[len("#/definitions/") :]
        definition = self._defs.get(name)
        if definition is None:
            raise SchemaError(f"$ref 指向不存在的 definitions: {name!r}")
        return definition

    def validate(self, instance: Any, node: dict[str, Any], path: str) -> list[str]:
        """按单节点 schema 校验实例，返回违规清单（空 = 通过）。

        检查顺序固定为：类型 → 枚举/常量 → 字符串约束 → 数值边界 →
        对象结构（必填/多余字段/属性递归）→ 数组结构（长度/唯一性/元素递归），
        违规消息带数据路径，可直接定位修复。
        """
        schema = self._resolve(node)
        violations: list[str] = []
        path_text = path or "$"

        raw_type = schema.get("type")
        if raw_type is not None:
            expected = raw_type if isinstance(raw_type, list) else [raw_type]
            if not self._type_ok(instance, expected):
                return [f"{path_text} 类型错误: 期望 {raw_type}，收到 {type(instance).__name__}"]

        if "const" in schema and instance != schema["const"]:
            violations.append(f"{path_text} 取值错误: 期望常量 {schema['const']!r}，收到 {instance!r}")

        if "enum" in schema and instance not in schema["enum"]:
            violations.append(f"{path_text} 取值非法: {instance!r}（仅允许 {schema['enum']}）")

        if isinstance(instance, str):
            if "minLength" in schema and len(instance) < schema["minLength"]:
                violations.append(f"{path_text} 字符串过短: {len(instance)} < {schema['minLength']}（空值/过短边界）")
            if "pattern" in schema and re.fullmatch(schema["pattern"], instance) is None:
                violations.append(f"{path_text} 不满足模式约束: {schema['pattern']!r}（实际 {instance[:40]!r}）")

        if isinstance(instance, (int, float)) and not isinstance(instance, bool):
            if "minimum" in schema and instance < schema["minimum"]:
                violations.append(f"{path_text} 低于下限: {instance} < {schema['minimum']}")
            if "maximum" in schema and instance > schema["maximum"]:
                violations.append(f"{path_text} 超过上限: {instance} > {schema['maximum']}")

        if isinstance(instance, dict):
            for field_name in schema.get("required", []):
                if field_name not in instance:
                    violations.append(f"{path_text} 缺失必填字段: {field_name}")
            props = schema.get("properties") or {}
            if schema.get("additionalProperties") is False:
                extras = sorted(set(instance) - set(props))
                if extras:
                    violations.append(f"{path_text} 存在未声明字段（多余字段）: {extras}")
            for key, value in instance.items():
                if key in props:
                    violations.extend(self.validate(value, props[key], f"{path_text}.{key}"))

        if isinstance(instance, list):
            if "minItems" in schema and len(instance) < schema["minItems"]:
                violations.append(f"{path_text} 数组过短（空值边界）: {len(instance)} < {schema['minItems']}")
            if "maxItems" in schema and len(instance) > schema["maxItems"]:
                violations.append(f"{path_text} 数组过长: {len(instance)} > {schema['maxItems']}")
            if schema.get("uniqueItems") and len(instance) != len(set(instance)):
                violations.append(f"{path_text} 存在重复元素")
            if "items" in schema:
                for index, item in enumerate(instance):
                    violations.extend(self.validate(item, schema["items"], f"{path_text}[{index}]"))
        return violations

    @staticmethod
    def _type_ok(instance: Any, expected: list[str]) -> bool:
        """类型匹配判定：number 兼容 int/float 但不认 bool；integer 只认原生 int。"""
        for kind in expected:
            if kind == "object" and isinstance(instance, dict):
                return True
            if kind == "array" and isinstance(instance, list):
                return True
            if kind == "string" and isinstance(instance, str):
                return True
            if kind == "boolean" and isinstance(instance, bool):
                return True
            if kind == "number" and isinstance(instance, (int, float)) and not isinstance(instance, bool):
                return True
            if kind == "integer" and isinstance(instance, int) and not isinstance(instance, bool):
                return True
            if kind == "null" and instance is None:
                return True
        return False


# ── 引擎源码事实核实（AST 只读解析，不改动引擎任何文件）──


def count_assembly_recipe_fields() -> int | None:
    """统计 runtime.py 中 AssemblyRecipe dataclass 的字段数（AST 解析）。

    计划文本写「17 字段」，验收要求以源码为准：此函数从源码类体提取
    注解赋值语句（AnnAssign）计数，引擎侧任何字段增删都会让本门禁
    与常量 ASSEMBLY_RECIPE_FIELD_COUNT 失配而失败（防口径漂移）。
    """
    if not ENGINE_RUNTIME.exists():
        return None
    source = ENGINE_RUNTIME.read_text(encoding="utf-8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "AssemblyRecipe":
            fields = [
                stmt
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign)
                and isinstance(stmt.target, ast.Name)
                and not stmt.target.id.startswith("_")
            ]
            return len(fields)
    return None


def read_engine_version() -> str | None:
    """从 ink_engine/pyproject.toml 读取版本（manifest 锁定的核实基准）。"""
    if not ENGINE_PYPROJECT.exists():
        return None
    match = re.search(r'^version\s*=\s*"([^"]+)"', ENGINE_PYPROJECT.read_text(encoding="utf-8"), re.MULTILINE)
    return match.group(1) if match else None


# ── 数据装载 ──


def load_json(path: Path) -> Any:
    """装载 JSON；损坏文件抛出带文件名与行号的异常（明确报错定位）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 解析失败（{path.name}: 第 {exc.lineno} 行第 {exc.colno} 列）: {exc.msg}") from exc


# ── 跨文件一致性检查（防双源漂移；每项均带可读说明）──


def check_manifest(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """manifest 定稿值核对 + 契约清单引用闭环。"""
    if data.get("id") != MANIFEST_ID:
        issues.append(f"manifest.id 应为 {MANIFEST_ID!r}")
    if data.get("name") != MANIFEST_NAME:
        issues.append(f"manifest.name 应为 {MANIFEST_NAME!r}")
    if data.get("positioning") != MANIFEST_POSITIONING:
        issues.append(f"manifest.positioning 应为 {MANIFEST_POSITIONING!r}")
    if data.get("domain_boot") != MANIFEST_DOMAIN_BOOT:
        issues.append(f"manifest.domain_boot 应为 {MANIFEST_DOMAIN_BOOT!r}")
    if data.get("version") != MANIFEST_VERSION:
        issues.append(f"manifest.version 应为 {MANIFEST_VERSION!r}")
    theme = data.get("theme") or {}
    for token, value in MANIFEST_THEME.items():
        if theme.get(token) != value:
            issues.append(f"manifest.theme.{token} 应为 {value!r}（§5 墨色系定稿）")
    engine_version = read_engine_version()
    if engine_version is not None and data.get("engine_version_compat") != engine_version:
        issues.append(f"manifest.engine_version_compat {data.get('engine_version_compat')!r} 与 pyproject 版本 {engine_version!r} 不一致")
    contracts = data.get("contracts") or {}
    if contracts.get("exec_mcp_id") != "inkling_exec":
        issues.append("contracts.exec_mcp_id 应为 inkling_exec")
    if contracts.get("host_id") != "inkling_shell":
        issues.append("contracts.host_id 应为 inkling_shell")
    tools = (payload.get("tools") or {}).get("tools") or []
    tool_names = {tool["name"] for tool in tools}
    mcp_ids = {tool["endpoint_config"]["server_id"] for tool in tools if tool.get("endpoint") == "mcp"}
    if "inkling_exec" not in mcp_ids:
        issues.append("contracts.exec_mcp_id=inkling_exec 未在 tools.json 的任何 mcp 工具中被引用")
    if "inkling_shell" not in mcp_ids:
        issues.append("contracts.host_id=inkling_shell 未在 tools.json 的任何 mcp 工具中被引用")
    if tool_names != set(DOMAIN_TOOLS) | set(SHELL_EXECUTORS) | set(DEVICE_SENSE_TOOLS) | set(SELF_AND_FILE_TOOLS):
        issues.append(
            "tools.json 工具集合与契约清单不一致"
            f"（域工具 {DOMAIN_TOOLS} + shell 执行器 {SHELL_EXECUTORS} + 设备感知 {DEVICE_SENSE_TOOLS} + {SELF_AND_FILE_TOOLS}）"
        )
    # 主题 token 白名单 = manifest.theme_tokens，且 ui_spec 使用的主题键必须 ⊆ 白名单
    theme_tokens = set(contracts.get("theme_tokens") or [])
    if theme_tokens != set(MANIFEST_THEME):
        issues.append(f"contracts.theme_tokens 应恰好为 {sorted(MANIFEST_THEME)}")
    ui_theme = set(((payload.get("ui_spec") or {}).get("theme") or {}).keys())
    if not ui_theme <= theme_tokens:
        issues.append(f"ui_spec 使用的主题键 {sorted(ui_theme)} 超出白名单 {sorted(theme_tokens)}")


def _walk_nodes(node: dict[str, Any]) -> list[dict[str, Any]]:
    """递归收集布局树全部节点（含嵌套 children），供组件/绑定核查。"""
    collected = [node]
    for child in node.get("children") or []:
        collected.extend(_walk_nodes(child))
    return collected


def check_ui_spec(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """ui_spec 与 manifest 契约、event_types 的双向一致（绑定通道三线闭环）。"""
    manifest = payload.get("manifest") or {}
    contracts = manifest.get("contracts") or {}
    allowed_components = set(contracts.get("renderer_components") or [])
    allowed_channels = set(contracts.get("bind_channels") or [])
    event_names = {event["name"] for event in (payload.get("event_types") or {}).get("events", [])}
    nodes = _walk_nodes(data["root"])
    for node in nodes:
        if node["kind"] == "component":
            if node["type"] not in allowed_components:
                issues.append(f"ui_spec 组件未在白名单: {node['type']!r}")
            if node.get("children"):
                issues.append(f"ui_spec 组件节点不允许携带 children: {node['type']!r}")
        bind = node.get("bind")
        if bind is None:
            continue
        channel = bind["channel"]
        if channel not in allowed_channels:
            issues.append(f"ui_spec 绑定通道未放行: {channel!r}")
        if channel.startswith(EVENT_CHANNEL_PREFIX):
            event_name = channel[len(EVENT_CHANNEL_PREFIX) :]
            if event_name not in event_names:
                issues.append(f"ui_spec 绑定通道 {channel!r} 无对应事件类型（event_types.json 缺 {event_name!r}）")
        for segment in bind["path"].split("."):
            if segment.startswith(RESERVED_BIND_PREFIX):
                issues.append(f"ui_spec 绑定路径命中保留前缀: {channel!r} path={bind['path']!r}（内部数据不可绑定）")
    for event in (payload.get("event_types") or {}).get("events", []):
        if event.get("renderer") and event["renderer"] not in allowed_components:
            issues.append(f"事件 {event['name']} 的 renderer {event['renderer']!r} 未在组件白名单")


def check_event_types(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """事件类型：名称唯一 + schema 字段声明形态合法 + renderer 闭环。"""
    names = [event["name"] for event in data["events"]]
    if len(names) != len(set(names)):
        issues.append("event_types.json 存在重复事件名")
    for event in data["events"]:
        schema = event.get("schema")
        if schema is None:
            continue
        field_names = [field["name"] for field in schema["fields"]]
        if len(field_names) != len(set(field_names)):
            issues.append(f"事件 {event['name']} 的 schema 字段名重复")
        for field in schema["fields"]:
            if field.get("min") is not None and field.get("max") is not None and field["min"] > field["max"]:
                issues.append(f"事件 {event['name']} 字段 {field['name']} 范围自相矛盾")


def check_graph(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """图声明：拓扑合法性 + 节点类型注册边界 + 与 workflow 约束域一致。"""
    nodes = data["nodes"]
    if data["entry"] not in nodes:
        issues.append(f"graph.entry {data['entry']!r} 不在节点集合中")
    for node_name, spec in nodes.items():
        if spec["type"] not in GRAPH_NODE_TYPES:
            issues.append(f"graph 节点 {node_name!r} 引用了未注册类型 {spec['type']!r}（出厂仅 {GRAPH_NODE_TYPES}）")
    for source, edge_list in data["edges"].items():
        if source not in nodes:
            issues.append(f"graph 边来源 {source!r} 不在节点集合中")
        for edge in edge_list:
            if edge["target"] not in nodes:
                issues.append(f"graph 边 {source} → {edge['target']} 目标不在节点集合中")
    for exit_name in data["exits"]:
        if exit_name not in nodes:
            issues.append(f"graph 出口 {exit_name!r} 不在节点集合中")
    orchestrator = nodes.get("research_orchestrator")
    if orchestrator is None:
        issues.append("graph 缺少 research_orchestrator 节点（§2 出厂编排节点）")
    else:
        config = orchestrator.get("config") or {}
        if tuple(config.get("reserved_keys") or ()) != ORCHESTRATOR_RESERVED_KEYS:
            issues.append(f"research_orchestrator 保留键应为 {ORCHESTRATOR_RESERVED_KEYS}")
        workflow_name = config.get("workflow")
        expected_workflow = (payload.get("workflow") or {}).get("name")
        if workflow_name != expected_workflow:
            issues.append(f"graph 引用 workflow {workflow_name!r} 与 workflow.json 名称 {expected_workflow!r} 不一致")
    if "tool_pipeline" not in nodes:
        issues.append("graph 缺少 tool_pipeline 节点（统一工具分发编排）")


def check_workflow(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """WorkflowSpec 约束域：节点/边/入口合法 + 节点类型 ⊆ 领域工具（防双源漂移）。"""
    node_ids = [node["id"] for node in data["nodes"]]
    if len(node_ids) != len(set(node_ids)):
        issues.append("workflow 节点 id 重复")
    node_set = set(node_ids)
    if data["entry"] not in node_set:
        issues.append(f"workflow.entry {data['entry']!r} 不在节点集合中")
    incoming: dict[str, int] = {}
    for edge in data["edges"]:
        if edge["source"] not in node_set or edge["target"] not in node_set:
            issues.append(f"workflow 边引用未知节点: {edge['source']} → {edge['target']}")
        incoming[edge["target"]] = incoming.get(edge["target"], 0) + 1
    # 环检测（Kahn 拓扑）：有环 = 约束域不可编译，建图期同样拒绝
    degree = dict(incoming)
    queue = [nid for nid in node_ids if degree.get(nid, 0) == 0]
    ordered: list[str] = []
    while queue:
        current = queue.pop(0)
        ordered.append(current)
        for edge in data["edges"]:
            if edge["source"] == current:
                degree[edge["target"]] = degree.get(edge["target"], 0) - 1
                if degree[edge["target"]] == 0:
                    queue.append(edge["target"])
    if len(ordered) != len(node_ids):
        issues.append("workflow 存在环（约束域不可编译）")
    domain_tool_set = set(DOMAIN_TOOLS)
    for node in data["nodes"]:
        if node["type"] not in domain_tool_set:
            issues.append(f"workflow 节点类型 {node['type']!r} 不在领域工具集内（tools.json）")


def check_tools(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """工具声明：唯一性/权限非空/端点白名单必填/权限分级枚举/执行器归属。"""
    names = [tool["name"] for tool in data["tools"]]
    if len(names) != len(set(names)):
        issues.append("tools.json 存在重复工具名")
    domain_seen: set[str] = set()
    shell_seen: set[str] = set()
    for tool in data["tools"]:
        if not tool["permissions"]:
            issues.append(f"工具 {tool['name']} 权限声明为空（fail-closed：未声明权限默认拒绝）")
        endpoint = tool["endpoint"]
        config = tool["endpoint_config"] or {}
        if endpoint == "process_exec":
            allowlist = config.get("allowlist")
            if not isinstance(allowlist, list) or not allowlist or not all(isinstance(c, str) and c for c in allowlist):
                issues.append(f"工具 {tool['name']} 的 process_exec 端点须声明非空命令白名单 allowlist")
        elif endpoint == "file_ops":
            if not isinstance(config.get("root"), str) or not config["root"]:
                issues.append(f"工具 {tool['name']} 的 file_ops 端点须声明非空根目录 root（沙箱端点）")
        elif endpoint == "mcp":
            if not isinstance(config.get("server_id"), str) or not config["server_id"]:
                issues.append(f"工具 {tool['name']} 的 mcp 端点须声明 server_id 路由密钥")
        if tool["approval"] not in APPROVAL_TIERS:
            issues.append(f"工具 {tool['name']} 权限分级非法: {tool['approval']!r}")
        domain = (tool.get("meta") or {}).get("domain")
        if domain == "research":
            domain_seen.add(tool["name"])
        executor = (tool.get("meta") or {}).get("executor")
        # shell 执行器归属判定：executor 声明必须与工具名一致（M2 契约测试同口径）；
        # 感知类（screen_query/file_query）走设备感知 server，executor 非 shell:<工具名>，不计入
        if executor == f"shell:{tool['name']}":
            shell_seen.add(tool["name"])
    if domain_seen != set(DOMAIN_TOOLS):
        issues.append(f"领域工具集合应为 {DOMAIN_TOOLS}，实际 {sorted(domain_seen)}（与 M1 exec 执行体一一对应）")
    if shell_seen != set(SHELL_EXECUTORS):
        issues.append(f"shell 执行器注册集合应为 {SHELL_EXECUTORS}，实际 {sorted(shell_seen)}（与 M2 shell 契约一致）")
    control_tools = {tool["name"] for tool in data["tools"] if (tool.get("meta") or {}).get("control") is True}
    if control_tools != set(OS_CONTROL_TOOLS):
        issues.append(f"OS 控制工具集合应为 {OS_CONTROL_TOOLS}，实际 {sorted(control_tools)}")


def check_rules(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """规则集：id/谓词唯一性 + 谓词 ∈ M1 实现清单 + 阈值与 review.json 联动。"""
    rule_ids = [rule["id"] for rule in data["rules"]]
    if len(rule_ids) != len(set(rule_ids)):
        issues.append("rules.json 存在重复规则 id")
    rule_kinds = {rule["kind"] for rule in data["rules"]}
    for rule in data["rules"]:
        if rule["predicate"] not in DOMAIN_PREDICATES:
            issues.append(f"规则 {rule['id']} 谓词 {rule['predicate']!r} 不在 M1 谓词实现清单 {DOMAIN_PREDICATES}")
    floor_rules = [r for r in data["rules"] if r["id"] == "rule.review.score_floor"]
    if floor_rules:
        floor = floor_rules[0]["config"].get("min")
        review_threshold = (payload.get("review") or {}).get("pass_threshold")
        if floor != review_threshold:
            issues.append(f"rule.review.score_floor.min={floor} 与 review.json pass_threshold={review_threshold} 不一致（防双源漂移）")
    # 样例库的期望违规类别必须能在规则集中找到对应规则
    sample_kinds = set()
    for case in (payload.get("samples") or {}).get("cases", []):
        sample_kinds.update(case.get("expected_kinds") or ())
    unknown_kinds = sample_kinds - rule_kinds
    if unknown_kinds:
        issues.append(f"samples.json 期望违规类别在规则集中不存在: {sorted(unknown_kinds)}")
    # 每个违规类别至少有一个反例覆盖（L2 闸门的负向证明面）
    for kind in rule_kinds:
        if kind not in sample_kinds:
            issues.append(f"规则类别 {kind!r} 无样例反例覆盖（每个规则类别须有 fail 用例）")


def check_samples(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """样例库：用例 id 唯一 + 全规则可评估（复合记录结构）+ 边界值精确。"""
    case_ids = [case["id"] for case in data["cases"]]
    if len(case_ids) != len(set(case_ids)):
        issues.append("samples.json 存在重复用例 id")
    section_keys = ("material", "entry", "review", "case")
    for case in data["cases"]:
        missing = [key for key in section_keys if key not in case["data"]]
        if missing:
            issues.append(f"样例 {case['id']} 缺规则作用域段 {missing}（八条规则均须可评估）")
    # 边界值断言：恰在上限通过、超上限违规（与 rules.json max_length 联动）
    by_id = {case["id"]: case for case in data["cases"]}
    at_max = by_id.get(SAMPLE_AT_MAX)
    if at_max is not None:
        title = at_max["data"]["material"].get("title") or ""
        if len(title) != TITLE_MAX_CHARS:
            issues.append(f"样例 {SAMPLE_AT_MAX} 标题长度 {len(title)} 应恰好 {TITLE_MAX_CHARS}（边界通过）")
    over_max = by_id.get(SAMPLE_OVER_MAX)
    if over_max is not None:
        title = over_max["data"]["material"].get("title") or ""
        if len(title) != TITLE_MAX_CHARS + 1:
            issues.append(f"样例 {SAMPLE_OVER_MAX} 标题长度 {len(title)} 应恰好 {TITLE_MAX_CHARS + 1}（边界违规）")


def check_entries(entries: list[dict[str, Any]], source_label: str, issues: list[str]) -> None:
    """知识条目通用核查（templates/knowledge 共用）：身份/来源/可信度/形状。"""
    ids = [entry["id"] for entry in entries]
    if len(ids) != len(set(ids)):
        issues.append(f"{source_label} 存在重复条目 id")
    for entry in entries:
        if entry["level"] not in KNOWLEDGE_LEVELS:
            issues.append(f"{source_label} 条目 {entry['id']} 层级非法: {entry['level']!r}")
        if entry["kind"] not in KNOWLEDGE_KINDS:
            issues.append(f"{source_label} 条目 {entry['id']} kind 非法: {entry['kind']!r}")
        if entry["source"] not in SOURCE_KINDS:
            issues.append(f"{source_label} 条目 {entry['id']} 来源非法: {entry['source']!r}")
        if not 0 <= entry["credibility"] <= 1:
            issues.append(f"{source_label} 条目 {entry['id']} 可信度越界: {entry['credibility']}")
        if entry["kind"] == "rule":
            rule = (entry["data"] or {}).get("rule")
            if not isinstance(rule, dict) or not isinstance(rule.get("message"), str) or not rule["message"]:
                issues.append(f"{source_label} 条目 {entry['id']} 的 rule.message 缺失或为空")
        if entry["kind"] == "template":
            template = (entry["data"] or {}).get("template")
            if not isinstance(template, dict) or not template.get("name"):
                issues.append(f"{source_label} 条目 {entry['id']} 的 template.name 缺失")


def check_templates(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """模板基线：条目核查 + 编排步骤节点 ⊆ 领域工具（模板可执行性）。"""
    check_entries(data["templates"], "templates.json", issues)
    workflow_node_ids = {node["id"] for node in (payload.get("workflow") or {}).get("nodes", [])}
    for entry in data["templates"]:
        template = (entry["data"] or {}).get("template") or {}
        for step in (template.get("plan") or {}).get("steps") or []:
            for node_name in step.get("nodes") or []:
                if node_name not in workflow_node_ids and node_name not in DOMAIN_TOOLS:
                    issues.append(f"模板 {entry['id']} 步骤节点 {node_name!r} 不在 workflow 节点/领域工具集内")


def check_knowledge(data: dict[str, Any], payload: dict[str, Any], issues: list[str]) -> None:
    """冷启动知识条目：条目核查 + 与模板/规则集 id 不冲突（单事实源）。"""
    check_entries(data["entries"], "knowledge.json", issues)
    template_ids = {entry["id"] for entry in (payload.get("templates") or {}).get("templates", [])}
    knowledge_ids = {entry["id"] for entry in data["entries"]}
    if knowledge_ids & template_ids:
        issues.append(f"knowledge.json 与 templates.json 条目 id 冲突: {sorted(knowledge_ids & template_ids)}（单事实源防双源漂移）")
    rule_ids = {rule["id"] for rule in (payload.get("rules") or {}).get("rules", [])}
    if knowledge_ids & rule_ids:
        issues.append(f"knowledge.json 与 rules.json id 冲突: {sorted(knowledge_ids & rule_ids)}")


def check_signals(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """信号映射：五类齐全 + 蒸馏器归属 + 阈值与引擎常量对齐。"""
    kinds = [item["kind"] for item in data["signal_kinds"]]
    if tuple(kinds) != SIGNAL_KINDS:
        issues.append(f"信号类别应恰好为 {SIGNAL_KINDS}，实际 {kinds}")
    by_kind = {item["kind"]: item for item in data["signal_kinds"]}
    for kind in ("pitfall", "gap", "repeated_root_cause"):
        item = by_kind.get(kind)
        if item is not None and item["produced_kind"] is not None:
            issues.append(f"信号 {kind} 不直接产出知识（produced_kind 应为 null）")
    for kind in ("user_correction", "insight"):
        item = by_kind.get(kind)
        if item is not None and item["produced_kind"] != "rule":
            issues.append(f"信号 {kind} 应蒸馏为 rule 条目")
    distill = data["distill"]
    if distill["complexity_threshold"] != DISTILL_COMPLEXITY_THRESHOLD:
        issues.append(f"蒸馏复杂度阈值应为 {DISTILL_COMPLEXITY_THRESHOLD}")
    if distill["intervention_threshold"] != DISTILL_INTERVENTION_THRESHOLD:
        issues.append(f"蒸馏干预阈值应为 {DISTILL_INTERVENTION_THRESHOLD}")
    if distill["repeat_threshold"] != REPEAT_THRESHOLD:
        issues.append(f"重复根因升级阈值应为 {REPEAT_THRESHOLD}")


def check_tiers(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """四挡位：挡位清单/缺省回退与引擎 tiers 语义一致。"""
    if tuple(data["tiers"]) != TIER_NAMES:
        issues.append(f"挡位清单应恰好为 {TIER_NAMES}，实际 {data['tiers']}")
    if data["default_tier"] != "main":
        issues.append("缺省挡位应为 main（引擎 tier_key 未知回落语义）")
    if set(data["model_config"]) != {"router_config", "tool_config", "main_config", "audit_config"}:
        issues.append("model_config 应恰好包含四挡位配置键")
    if data["fallback"]["unknown_tier_falls_to"] != "main":
        issues.append("未知挡位应回落 main")
    if data["fallback"]["missing_tier_config_falls_to"] != "main_config":
        issues.append("缺挡位配置应回落 main_config")


def check_review(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """评审配置：数值与引擎 review 模块默认对齐 + 维度权重归一。"""
    if data["pass_threshold"] != REVIEW_PASS_THRESHOLD:
        issues.append(f"pass_threshold 应为 {REVIEW_PASS_THRESHOLD}")
    if data["max_rounds"] != REVIEW_MAX_ROUNDS:
        issues.append(f"max_rounds 应为 {REVIEW_MAX_ROUNDS}")
    if data["beam_width"] != REVIEW_BEAM_WIDTH:
        issues.append(f"beam_width 应为 {REVIEW_BEAM_WIDTH}")
    if data["neutral_score"] != REVIEW_NEUTRAL_SCORE:
        issues.append(f"neutral_score 应为 {REVIEW_NEUTRAL_SCORE}")
    total = sum(dimension["weight"] for dimension in data["dimensions"])
    if abs(total - 1.0) > 1e-6:
        issues.append(f"评审维度权重之和应为 1.0，实际 {total:.4f}")


def check_memory(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """记忆策略：召回策略名与失效窗口声明核对。"""
    if data["policy"] != "PriorityRecallPolicy":
        issues.append("记忆召回策略应为 PriorityRecallPolicy（引擎默认确定性召回）")
    if data["expiry"]["default_window_days"] != MEMORY_DEFAULT_WINDOW_DAYS:
        issues.append(f"记忆失效窗口应为 {MEMORY_DEFAULT_WINDOW_DAYS} 天")


def check_env(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """环境声明：三环境齐全且 runtime 覆盖三形态。"""
    names = [env["name"] for env in data["environments"]]
    if len(names) != len(set(names)):
        issues.append("env.json 存在重复环境名")
    runtimes = {env["runtime"] for env in data["environments"]}
    if runtimes != set(ENV_RUNTIMES):
        issues.append(f"环境 runtime 应覆盖 {ENV_RUNTIMES}，实际 {sorted(runtimes)}")
    for env in data["environments"]:
        if (env.get("meta") or {}).get("versioned_by_patch_chain") is not True:
            issues.append(f"环境 {env['name']} 未声明补丁链版本化（versioned_by_patch_chain 应为 true）")


def check_mcp_market(data: dict[str, Any], _payload: dict[str, Any], issues: list[str]) -> None:
    """市场目录：零预挂 + 传输端点配套 + 风险档枚举。"""
    if data["premounted"] is not False:
        issues.append("mcp_market 出厂必须零预挂（premounted 应为 false）")
    ids = [server["id"] for server in data["servers"]]
    if len(ids) != len(set(ids)):
        issues.append("mcp_market 存在重复 server id")
    categories = {server["category"] for server in data["servers"]}
    if not {"web_fetch", "web_search", "file_system"} <= categories:
        issues.append("市场示例应含 web 抓取/搜索/文件系统三类")
    for server in data["servers"]:
        if server["premounted"] is not False:
            issues.append(f"市场条目 {server['id']} 不得预挂")
        if server["transport"] == "http" and not server["url"]:
            issues.append(f"市场条目 {server['id']} http 传输缺 url")
        if server["transport"] == "stdio" and not server["command"]:
            issues.append(f"市场条目 {server['id']} stdio 传输缺 command")


# ── 校验编排 ──


def main() -> int:
    """执行全量校验；返回退出码（0 = 全绿）。"""
    # Windows 控制台默认代码页可能不是 UTF-8，强制按 UTF-8 输出防乱码
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    problems: list[str] = []

    # 第一步：文件完整性——16 个 seed_data 缺一不可，损坏 JSON 定位到行
    missing = [name for name in EXPECTED_SEED_FILES if not (SEED_DATA_DIR / name).exists()]
    if not MANIFEST_PATH.exists():
        problems.append(f"缺失 manifest 文件: {MANIFEST_PATH.name}")
    if missing:
        problems.append(f"缺失 seed_data 文件: {missing}")
        print("\n".join(problems))
        return 1
    payload: dict[str, Any] = {}
    try:
        payload["manifest"] = load_json(MANIFEST_PATH)
    except ValueError as exc:
        problems.append(str(exc))
    for name in EXPECTED_SEED_FILES:
        try:
            payload[name[:-5]] = load_json(SEED_DATA_DIR / name)
        except ValueError as exc:
            problems.append(str(exc))

    # 第二步：逐文件 schema 校验（缺失/多余/类型/空值边界；manifest 一并校验）
    schema_names = {f"{name[:-5]}.schema.json" for name in EXPECTED_SEED_FILES} | {"manifest.schema.json"}
    missing_schemas = sorted(schema_names - {p.name for p in SCHEMA_DIR.glob("*.schema.json")})
    if missing_schemas:
        problems.append(f"缺失 schema 定义: {missing_schemas}")
    for key, data in payload.items():
        if data is None:
            continue
        schema_path = SCHEMA_DIR / f"{key}.schema.json"
        if not schema_path.exists():
            continue
        try:
            validator = MiniSchemaValidator(json.loads(schema_path.read_text(encoding="utf-8")))
            violations = validator.validate(data, validator._schema, key)
        except SchemaError as exc:
            problems.append(f"{key}.schema.json: schema 定义非法——{exc}")
            continue
        if violations:
            problems.extend(violations)

    # 第三步：引擎源码事实核实（只读，不改动引擎）
    recipe_field_count = count_assembly_recipe_fields()
    if recipe_field_count is None:
        problems.append(f"无法核实 AssemblyRecipe 字段数（未找到 {ENGINE_RUNTIME}）")
    elif recipe_field_count != ASSEMBLY_RECIPE_FIELD_COUNT:
        problems.append(
            f"AssemblyRecipe 实际 {recipe_field_count} 字段，与常量 {ASSEMBLY_RECIPE_FIELD_COUNT} 不符"
            "（计划文本写 17 字段，以 runtime.py 源码为准；若引擎字段已增删请更新本常量）"
        )
    engine_version = read_engine_version()
    if engine_version is None:
        problems.append(f"无法核实引擎版本（未找到 {ENGINE_PYPROJECT}）")
    else:
        manifest = payload.get("manifest") or {}
        if manifest.get("engine_version_compat") != engine_version:
            problems.append(
                f"manifest.engine_version_compat={manifest.get('engine_version_compat')!r} 应锁定为 pyproject 版本 {engine_version!r}"
            )

    # 第四步：跨文件一致性检查（防双源漂移）
    if payload.get("manifest"):
        check_manifest(payload["manifest"], payload, problems)
    if payload.get("boot_prompt"):
        if payload["boot_prompt"].get("prompt") != BOOT_PROMPT_FINAL:
            problems.append("boot_prompt.json 未使用 §5.1 定稿原文")
    if payload.get("ui_spec"):
        check_ui_spec(payload["ui_spec"], payload, problems)
    if payload.get("event_types"):
        check_event_types(payload["event_types"], payload, problems)
    if payload.get("graph"):
        check_graph(payload["graph"], payload, problems)
    if payload.get("workflow"):
        check_workflow(payload["workflow"], payload, problems)
    if payload.get("tools"):
        check_tools(payload["tools"], payload, problems)
    if payload.get("rules"):
        check_rules(payload["rules"], payload, problems)
    if payload.get("samples"):
        check_samples(payload["samples"], payload, problems)
    if payload.get("templates"):
        check_templates(payload["templates"], payload, problems)
    if payload.get("knowledge"):
        check_knowledge(payload["knowledge"], payload, problems)
    if payload.get("signals"):
        check_signals(payload["signals"], payload, problems)
    if payload.get("tiers"):
        check_tiers(payload["tiers"], payload, problems)
    if payload.get("review"):
        check_review(payload["review"], payload, problems)
    if payload.get("memory"):
        check_memory(payload["memory"], payload, problems)
    if payload.get("env"):
        check_env(payload["env"], payload, problems)
    if payload.get("mcp_market"):
        check_mcp_market(payload["mcp_market"], payload, problems)

    # 第五步：本脚本自检夹具——检查器正例全通过、反例全部命中（防检查器自身失效）
    fixture_problems = run_self_checks()
    problems.extend(fixture_problems)

    for line in problems:
        print(f"[FAIL] {line}")
    if not problems:
        print(f"全绿：{len(EXPECTED_SEED_FILES)} 个 seed_data 文件 schema 校验通过，跨文件一致性通过，自检夹具通过。")
        print(f"引擎核实：AssemblyRecipe 字段数 = {recipe_field_count}（以 runtime.py 源码为准）")
        print(f"引擎核实：engine_version = {engine_version}（pyproject.toml）")
        return 0
    print(f"\n共 {len(problems)} 项违规。")
    return 1


# ── 自检夹具（正例/反例；运行即验证检查器行为）──


def run_self_checks() -> list[str]:
    """检查器自身的行为验证：正例应零违规、反例应精确命中。

    夹具覆盖：必填缺失、多余字段、类型错误、枚举越界、空值边界
    （空字符串/空数组）、字符串过短、数值越界、$ref 解析、重复元素，
    以及 AssemblyRecipe 字段计数器的解析行为。
    """
    problems: list[str] = []

    base_schema: dict[str, Any] = {
        "type": "object",
        "required": ["name", "count"],
        "additionalProperties": False,
        "properties": {
            "name": {"type": "string", "minLength": 1},
            "count": {"type": "integer", "minimum": 0},
            "mode": {"type": "string", "enum": ["a", "b"]},
            "items": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"type": "string"}},
            "child": {"$ref": "#/definitions/child"},
        },
        "definitions": {"child": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}}},
    }
    validator = MiniSchemaValidator(base_schema)

    def expect(payload_value: dict[str, Any], expected_count: int, label: str) -> None:
        violations = validator.validate(payload_value, base_schema, label)
        if len(violations) != expected_count:
            problems.append(f"自检夹具 {label}: 期望 {expected_count} 条违规，实际 {len(violations)} 条: {violations}")

    # 正例：完整合法对象零违规（含 $ref 子对象与边界值 count=0）
    expect({"name": "x", "count": 0, "mode": "a", "items": ["i"], "child": {"id": "c"}}, 0, "positive_ok")
    # 反例：必填缺失 / 多余字段 / 类型错误 / 枚举越界 / 空字符串 / 负数 / 空数组 / 重复元素 / $ref 缺必填
    expect({"count": 1}, 1, "missing_required")
    expect({"name": "x", "count": 1, "extra": True}, 1, "extra_field")
    expect({"name": 1, "count": 1}, 1, "wrong_type")
    expect({"name": "x", "count": 1, "mode": "z"}, 1, "enum_violation")
    expect({"name": "", "count": 1}, 1, "empty_string")
    expect({"name": "x", "count": -1}, 1, "below_minimum")
    expect({"name": "x", "count": 1, "items": []}, 1, "empty_array")
    expect({"name": "x", "count": 1, "items": ["a", "a"]}, 1, "duplicate_items")
    expect({"name": "x", "count": 1, "child": {}}, 1, "ref_missing_required")
    # $ref 指向不存在的 definitions 应抛 SchemaError（检查器自身拒绝坏 schema）
    try:
        MiniSchemaValidator({"$ref": "#/definitions/ghost"}).validate({}, {"$ref": "#/definitions/ghost"}, "bad_ref")
        problems.append("自检夹具 bad_ref: 应抛 SchemaError 但未抛")
    except SchemaError:
        pass

    # AssemblyRecipe 计数器自检：喂入 3 字段的合成类体应数出 3
    fake_source = "from dataclasses import dataclass\n@dataclass\nclass AssemblyRecipe:\n    a: int = 1\n    b: str = ''\n    c: dict | None = None\n"
    fake_tree = ast.parse(fake_source)
    count = None
    for node in ast.walk(fake_tree):
        if isinstance(node, ast.ClassDef) and node.name == "AssemblyRecipe":
            count = sum(
                1
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign)
                and isinstance(stmt.target, ast.Name)
                and not stmt.target.id.startswith("_")
            )
    if count != 3:
        problems.append(f"自检夹具 recipe_counter: 期望 3，实际 {count}")

    return problems


if __name__ == "__main__":
    sys.exit(main())

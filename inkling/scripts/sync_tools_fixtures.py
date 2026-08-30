#!/usr/bin/env python3
"""同步生成壳执行器声明夹具（fixtures/tools_os.json），seed 为唯一真源。

职责边界（决议 6 / 审查 D2-D4）：
- ``seed_data/tools.json`` = 引擎代理工具目录真源（引擎/宿主消费的声明）；
- ``shell/src-tauri/fixtures/tools_os.json`` = 壳执行器声明**生成物**——
  本脚本从 seed 派生，禁止手工维护（生成产物与 seed 成员/档位/端点漂移
  由出厂自检「跨注册表一致性闸门」硬校验）。

成员集合规则（生成器显式映射，勿静默改动）：
- 种子 = seed 中 ``meta.domain == "os"`` 的 OS 域工具（引擎代理目录的
  OS 能力面）；
- 追加 = 壳执行器实现的 seed 非 OS 域工具（文档/导入/自指演化，固定清单）；
- deny 档样例 = ``shell_exec``：seed 的 deny 档工具，壳侧以 deny 档执行器
  fail-closed 仅登记（守卫恒拒绝，执行面不存在；转正须经补丁链审批改档，
  守卫执行体见 inkling_host/security_domain.py 的 host:shell_exec_guard）——
  声明进入夹具，签名与执行器逐项比对，与其它工具同纪律。

schema 形态差异映射（seed 嵌套 schema → 夹具扁平签名）：
- 参数：取 seed ``parameters.properties`` 中除固定 ``command`` 枚举外的
  参数（执行器签名契约 = 壳运行面，固定 command 由端点判定消费）；
  类型映射 string/integer/number/boolean，required 取自 seed required 清单。
- 端点：seed ``endpoint``（process_exec / mcp）→ 夹具
  process_exec / device_mcp（mcp+inkling_shell 的感知类）。
- 档位：seed ``approval``（allow/review/deny）→ 夹具 ``permission``。
- 沙箱：夹具沙箱值为壳执行器守卫数据（seed 只承载模式类别 meta.sandbox，
  不含白名单值），由本脚本内 ``SANDBOX_MAPPING`` 显式承载（与执行器
  签名契约同源，任一成员缺映射即生成失败）。

幂等：输出为确定性 JSON（排序键 + 固定成员顺序）；重复运行 diff 为空。
``--check`` 模式只校验不落盘（供门禁/CI 使用，漂移即非零退出）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_TOOLS = REPO_ROOT / "inkling" / "seed_data" / "tools.json"
FIXTURE = REPO_ROOT / "inkling" / "shell" / "src-tauri" / "fixtures" / "tools_os.json"

# seed 非 OS 域但壳执行器实现的工具（文档/导入/自指演化；固定清单，新增须显式登记）
FIXTURE_EXTRA_TOOLS: list[str] = [
    "doc_parse",
    "doc_generate",
    "material_import",
    "propose_patch",
]

# 豁免：seed 有声明、壳侧无执行器实现的工具（当前为空——deny 档样例
# shell_exec 已补入壳侧 deny 档执行器，见模块 docstring；新增豁免须显式登记）
FIXTURE_EXEMPTIONS: dict[str, str] = {}

# seed 参数面与执行器签名面有意的形态分叉（agent 面向 vs 壳运行面）：
# 这些 seed 参数不进入壳执行器签名，由执行器侧同名/同义参数承接，显式登记防静默漂移。
DIVERGED_SEED_PARAMS: dict[str, set[str]] = {
    "system_query": {"scope"},  # 执行器以 query 承载查询面（seed 的 scope 枚举为引擎面向）
    "set_volume": {"level"},  # 执行器以 percent 承载档位（0-100 边界守卫）
    "set_brightness": {"level"},  # 同上
    "screen_query": {"region"},  # 执行器以 target 承载查询面（resolution/work_area 白名单）
    "file_query": {"pattern"},  # 执行器侧暂未实现文件名过滤
    "shell_exec": {"argv"},  # deny 档样例：执行器签名空（argv 为引擎面向，壳侧恒拒绝）
}

# 夹具扁平参数（name/type/required）：seed 的固定 command 枚举参数与执行器
# 未实现的参数（如 launch_app.args）不进入壳执行器签名面。
# type: string | integer | number | boolean
PARAMS_MAPPING: dict[str, list[tuple[str, str, bool]]] = {
    "launch_app": [("app", "string", True)],
    "open_file": [("path", "string", True)],
    "system_query": [("query", "string", True)],
    "set_volume": [("percent", "integer", True)],
    "set_brightness": [("percent", "integer", True)],
    "notify": [("title", "string", True), ("body", "string", True)],
    "sleep": [("seconds", "integer", True)],
    "screen_query": [("target", "string", True)],
    "file_query": [("path", "string", True)],
    "ui_tree_query": [("scope", "string", False)],
    "ui_click": [
        ("x", "integer", True),
        ("y", "integer", True),
        ("button", "string", True),
    ],
    "ui_type": [("text", "string", True)],
    "window_list": [("scope", "string", False)],
    "window_focus": [("handle", "string", True)],
    "window_minimize": [("handle", "string", True)],
    "doc_parse": [("path", "string", True)],
    "doc_generate": [
        ("format", "string", True),
        ("title", "string", True),
        ("body", "string", False),
        ("table", "string", False),
    ],
    "material_import": [("path", "string", True), ("recursive", "boolean", False)],
    "screenshot_capture": [("model_class", "string", True), ("destination", "string", False)],
    "run_typecheck": [("command", "string", True)],
    "run_test_cargo": [("command", "string", True), ("filter", "string", False)],
    "run_test_python": [("command", "string", True), ("filter", "string", False)],
    "run_test_web": [("command", "string", True), ("filter", "string", False)],
    "propose_patch": [
        ("kind", "string", True),
        ("payload", "string", True),
        ("base_version", "integer", False),
        ("rationale", "string", False),
    ],
    "shell_exec": [],  # deny 档样例：签名空（守卫恒拒绝，执行面不存在）
}

# 夹具沙箱规则（壳执行器守卫数据；与执行器签名契约同源，值以本表为唯一源）
SANDBOX_MAPPING: dict[str, dict[str, Any]] = {
    "launch_app": {"mode": "command_allowlist", "allowlist": ["notepad", "calc", "mspaint"]},
    "open_file": {"mode": "path_roots", "roots": ["~/.inkling/workspace"]},
    "system_query": {
        "mode": "query_allowlist",
        "allowlist": ["os", "arch", "hostname", "home", "cwd", "uptime"],
    },
    "set_volume": {"mode": "bounds", "min": 0, "max": 100},
    "set_brightness": {"mode": "bounds", "min": 0, "max": 100},
    "notify": {"mode": "length_caps", "title_max": 80, "body_max": 300},
    "sleep": {"mode": "bounds", "min": 1, "max": 86400},
    "screen_query": {"mode": "query_allowlist", "allowlist": ["resolution", "work_area"]},
    "file_query": {"mode": "path_roots", "roots": ["~/.inkling/workspace"]},
    "ui_tree_query": {"mode": "query_allowlist", "allowlist": ["foreground", "all"]},
    "ui_click": {
        "mode": "coordinate_click",
        "x_min": 0,
        "x_max": 32767,
        "y_min": 0,
        "y_max": 32767,
        "buttons": ["left", "right", "middle"],
    },
    "ui_type": {"mode": "text_input", "max_chars": 256},
    "window_list": {"mode": "window_target", "scopes": ["all", "foreground"]},
    "window_focus": {"mode": "window_target", "scopes": []},
    "window_minimize": {"mode": "window_target", "scopes": []},
    "doc_parse": {
        "mode": "path_roots",
        "roots": ["~/.inkling/workspace", "~/.inkling/attachments"],
    },
    "doc_generate": {"mode": "path_roots", "roots": ["~/.inkling/workspace"]},
    "material_import": {
        "mode": "path_roots",
        "roots": ["~/.inkling/workspace", "~/.inkling/attachments", "~"],
    },
    "screenshot_capture": {"mode": "query_allowlist", "allowlist": ["local", "cloud"]},
    "run_typecheck": {
        "mode": "process_template",
        "argv": ["tsc", "--noEmit"],
        "timeout_secs": 180,
    },
    "run_test_cargo": {
        "mode": "process_template",
        "argv": ["cargo", "test"],
        "timeout_secs": 180,
        "filter_arg": "--",
    },
    "run_test_python": {
        "mode": "process_template",
        "argv": ["python", "-m", "pytest"],
        "timeout_secs": 180,
        "filter_arg": "-k",
    },
    "run_test_web": {
        "mode": "process_template",
        "argv": ["npx", "vitest", "run"],
        "timeout_secs": 180,
        "filter_arg": "-t",
    },
    "propose_patch": {"mode": "command_allowlist", "allowlist": ["propose_patch"]},
    "shell_exec": {"mode": "command_allowlist", "allowlist": ["shell_exec"]},
}

FIXTURE_NOTE = (
    "壳执行器声明生成物：由 seed_data/tools.json 经 inkling/scripts/"
    "sync_tools_fixtures.py 生成（seed=引擎代理工具目录真源，fixtures=壳执行器声明，"
    "禁手工维护）；成员 = seed OS 域工具 ∪ 壳执行工具（含 deny 档样例 shell_exec，"
    "fail-closed 仅登记），漂移由出厂自检跨注册表一致性闸门硬校验。"
    "params 为扁平签名形态——声明 ↔ 执行器签名一致性校验的直接比对面；shell 只读声明，禁硬编码。"
)

_MCP_TO_DEVICE = {"inkling_shell": "device_mcp"}


def _mcp_to_device_mcp(endpoint: str, seed_tool: dict[str, Any]) -> str:
    """seed mcp 端点 → 夹具端点：inkling_shell 的感知/文档/导入类映射为
    device_mcp（壳执行器端点），其余保持原样（process_exec）。"""
    if endpoint != "mcp":
        return endpoint
    config = seed_tool.get("endpoint_config")
    server_id = str(config.get("server_id")) if isinstance(config, dict) else ""
    return _MCP_TO_DEVICE.get(server_id, endpoint)


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        raise SystemExit(f"读取失败: {path}（{exc}）") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"JSON 解析失败: {path}（{exc}）") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"JSON 顶层应为对象: {path}")
    return data


def derive_fixture(seed: dict[str, Any]) -> dict[str, Any]:
    tools = seed.get("tools")
    if not isinstance(tools, list):
        raise SystemExit("seed tools.json 缺 tools 清单")
    by_name: dict[str, dict[str, Any]] = {
        str(tool["name"]): tool for tool in tools if isinstance(tool, dict) and "name" in tool
    }

    os_tools: list[str] = [
        str(tool["name"])
        for tool in tools
        if isinstance(tool, dict)
        and tool.get("meta", {}).get("domain") == "os"
    ]

    # 成员集合 = OS 域 ∪ 追加 − 豁免（顺序确定性：OS 域按 seed 序，追加按固定清单）
    member_order: list[str] = []
    for name in os_tools + FIXTURE_EXTRA_TOOLS:
        if name in FIXTURE_EXEMPTIONS:
            continue
        if name not in member_order:
            member_order.append(name)

    missing = [name for name in member_order if name not in by_name]
    if missing:
        raise SystemExit(f"成员集合含 seed 缺失工具: {missing}")

    # 显式豁免硬断言：豁免项必须是 seed 真实存在的 OS 域工具
    for exempt in FIXTURE_EXEMPTIONS:
        if exempt not in by_name:
            raise SystemExit(f"豁免项 {exempt} 在 seed 中不存在（豁免登记失真）")
        if by_name[exempt].get("meta", {}).get("domain") != "os":
            raise SystemExit(f"豁免项 {exempt} 非 OS 域工具（豁免登记失真）")

    decls: list[dict[str, Any]] = []
    for name in member_order:
        seed_tool = by_name[name]
        approval = str(seed_tool.get("approval") or "")
        if approval not in ("allow", "review", "deny"):
            raise SystemExit(f"工具 {name} approval 档位非法: {approval!r}")
        endpoint = str(seed_tool.get("endpoint") or "")
        fixture_endpoint = _mcp_to_device_mcp(endpoint, seed_tool)
        if fixture_endpoint not in ("process_exec", "device_mcp"):
            raise SystemExit(f"工具 {name} 端点无法映射到壳执行器端点: {endpoint!r}")

        params = PARAMS_MAPPING.get(name)
        sandbox = SANDBOX_MAPPING.get(name)
        if params is None or sandbox is None:
            raise SystemExit(f"工具 {name} 缺生成映射（params/sandbox 须显式登记）")

        _assert_seed_params_shape(name, seed_tool)
        decls.append(
            {
                "name": name,
                "description": str(seed_tool.get("description") or ""),
                "permission": approval,
                "endpoint": fixture_endpoint,
                "sandbox": sandbox,
                "params": [
                    {"name": pname, "type": ptype, "required": required}
                    for pname, ptype, required in params
                ],
            }
        )
    return {"note": FIXTURE_NOTE, "tools": decls}


def _assert_seed_params_shape(name: str, seed_tool: dict[str, Any]) -> None:
    """核对 seed 参数面与生成映射的一致性（防 seed 参数变更静默漂移）。

    - process_exec 工具须声明固定 command 枚举（端点操作判定同源）；
    - 生成映射的参数名须是 seed 声明的参数（除固定 command 与显式忽略项）。
    """
    parameters = seed_tool.get("parameters") or {}
    props = parameters.get("properties")
    if not isinstance(props, dict):
        raise SystemExit(f"工具 {name} 缺 parameters.properties（seed 声明不完整）")
    seed_names = set(props)

    if seed_tool.get("endpoint") == "process_exec":
        command_prop = props.get("command")
        command_enum = (command_prop or {}).get("enum") if isinstance(command_prop, dict) else None
        if command_enum != [name]:
            raise SystemExit(
                f"工具 {name} 的固定 command 枚举应为 [{name!r}]（实际 {command_enum!r}）"
            )

    mapped_names = {pname for pname, _ptype, _req in PARAMS_MAPPING.get(name, [])}
    diverged = DIVERGED_SEED_PARAMS.get(name, set())
    # seed 参数未进映射的：固定 command + 有意分叉参数 + 执行器未实现参数（显式忽略清单）
    ignored = seed_names - mapped_names - {"command"} - diverged
    allowed_ignored = {
        "launch_app": {"args"},
    }.get(name, set())
    unexpected = ignored - allowed_ignored
    if unexpected:
        raise SystemExit(
            f"工具 {name} 的 seed 参数未在生成映射中: {sorted(unexpected)}"
            "（新增参数须显式登记到 PARAMS_MAPPING）"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验不落盘：现有夹具与生成产物不一致即非零退出",
    )
    args = parser.parse_args()

    seed = load_json(SEED_TOOLS)
    generated = derive_fixture(seed)
    rendered = json.dumps(generated, ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    if args.check:
        if not FIXTURE.is_file():
            print(f"夹具缺失: {FIXTURE}", file=sys.stderr)
            return 1
        current = FIXTURE.read_text(encoding="utf-8")
        if current != rendered:
            print(f"夹具漂移: {FIXTURE} 与 seed 派生产物不一致（重跑 sync_tools_fixtures.py）", file=sys.stderr)
            return 1
        print("夹具与 seed 派生产物一致")
        return 0

    FIXTURE.write_text(rendered, encoding="utf-8")
    print(f"已生成 {FIXTURE.relative_to(REPO_ROOT)}（{len(generated['tools'])} 件声明，seed 真源）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

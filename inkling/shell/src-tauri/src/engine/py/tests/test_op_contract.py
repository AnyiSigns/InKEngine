"""Rust op 名 ⊆ bridge 注册表 契约测试。

引擎侧第一批验收项：Rust 侧经 ``call_engine_op`` / ``call_engine_op_async``
（含测试助手 ``block_on_op``）调用的每个 op 名必须在 bridge.py 的同步或
异步注册表中有对应实现——Rust 调了桥未注册 = 运行期 KeyError 断点
（如 engine.propose_patch 曾缺失）。本测试扫描 src-tauri/src 下全部
Rust 源码提取 op 名，逐一断言已注册，防契约差集回归。

无 pytest 依赖：`py test_op_contract.py` 与 pytest 均可运行。
"""

import importlib.util
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
_BRIDGE_PATH = os.path.join(_HERE, "..", "bridge.py")
_RUST_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", ".."))

# Rust 侧 op 调用形态（host.rs 的同步/异步通道 + 测试助手 block_on_op）
_OP_CALL_RE = re.compile(
    r"(?:call_engine_op|call_engine_op_async|block_on_op)\(\s*\"([A-Za-z0-9_.]+)\""
)


def _load_bridge():
    spec = importlib.util.spec_from_file_location("bridge_under_test", _BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _rust_op_names():
    names: set[str] = set()
    for dirpath, _, filenames in os.walk(_RUST_ROOT):
        for filename in filenames:
            if not filename.endswith(".rs"):
                continue
            path = os.path.join(dirpath, filename)
            with open(path, encoding="utf-8") as handle:
                names.update(_OP_CALL_RE.findall(handle.read()))
    return names


def test_all_rust_op_names_registered_in_bridge():
    bridge = _load_bridge()
    registered = set(bridge._OPS_SYNC) | set(bridge._OPS_ASYNC)
    missing = sorted(_rust_op_names() - registered)
    assert not missing, (
        "Rust 调用但桥未注册的 op（运行期 KeyError 断点）: "
        + ", ".join(missing)
        + "——请到 bridge.py 补注册"
    )


def test_engine_propose_patch_registered_both_channels():
    """断点回归：engine.propose_patch 须在注册表（Rust 走同步通道调用，
    同步形态驱动引擎异步 API；异步形态为切换通道预留）。"""
    bridge = _load_bridge()
    assert "engine.propose_patch" in bridge._OPS_SYNC
    assert "engine.propose_patch" in bridge._OPS_ASYNC


def test_builtin_mcp_ops_registered():
    """内置 server 入口：注册表查询与真实连接 op 均已登记。"""
    bridge = _load_bridge()
    assert "mcp.builtin_registry" in bridge._OPS_SYNC
    assert "mcp.builtin_connect" in bridge._OPS_ASYNC


def test_assembly_batch_ops_registered():
    """第二批组装域新增 op：assemble_stats（ENG9a-8）与 path.clear_candidate
    （ENG9a-9）须在异步注册表（前端仪表盘/clearChoice 消费）。"""
    bridge = _load_bridge()
    assert "assemble_stats" in bridge._OPS_ASYNC
    assert "path.clear_candidate" in bridge._OPS_ASYNC
    assert "path.assemble" in bridge._OPS_ASYNC
    assert "path.choose_candidate" in bridge._OPS_ASYNC
    assert "path.set_multipath" in bridge._OPS_ASYNC


def test_backend_gap_commands_registered():
    """补齐 Rust 命令面断链：A 类转换 op + B 类知识/记忆 op + 运行时生命周期
    + 流水线安全状态，全部须在桥注册表（前端按命令名调用，缺注册 = 断链）。"""
    bridge = _load_bridge()
    registered = set(bridge._OPS_SYNC) | set(bridge._OPS_ASYNC)
    expected = [
        # A 类转换 op（已在既有 op，此处断言仍登记）
        "assemble_stats", "graph.snapshot", "pool.snapshot", "pool.evaluate",
        "edge_evidence.list", "edge_evidence.update", "path.assemble",
        "path.clear_candidate", "path.set_assembler_enabled", "cache.stats",
        "cache.clear", "why.audit", "sovereignty.snapshot", "suggestion.scan",
        # B 类知识集 op（_register_knowledge_ops 新增）
        "knowledge.list", "knowledge.add", "knowledge.promote",
        "knowledge.archive", "knowledge.restore", "knowledge.export",
        "knowledge.skill_import", "knowledge.skill_reimport",
        "knowledge.graph",
        # B 类记忆 op（_register_memory_ops 新增）
        "memory.list", "memory.invalidate", "memory.update_frontmatter",
        # 运行时生命周期（_register_runtime_ops 新增）
        "engine.runtime_state", "engine.runtime_pause",
        "engine.runtime_resume", "engine.runtime_stop",
    ]
    missing = sorted(set(expected) - registered)
    assert not missing, "桥未注册的新增 op: " + ", ".join(missing)


if __name__ == "__main__":
    test_all_rust_op_names_registered_in_bridge()
    test_engine_propose_patch_registered_both_channels()
    test_builtin_mcp_ops_registered()
    test_assembly_batch_ops_registered()
    test_backend_gap_commands_registered()
    print("op 契约全部通过")

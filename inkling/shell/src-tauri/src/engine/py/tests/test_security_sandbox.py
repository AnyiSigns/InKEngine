"""声明式沙箱代理（DeclarativeSandboxProxy）实质守卫回归测试。

审查 S6 落地项：代理守卫必须从声明（seed tools.json → DeclarativeToolSpec）
读取真实白名单做实质判定，而非「target == command」式的 no-op——白名单
成员放行、非成员拒绝，且守卫语义随声明数据驱动（单一真相源）。

与出厂自检的「跨注册表一致性闸门」（Rust）同源互补：Rust 侧校验声明生成
物成员/档位/端点一致，本测试校验守卫按声明现取白名单执行实质拦截。
"""

import json
import sys
import unittest
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[6]
_SEED_TOOLS = _REPO_ROOT / "inkling" / "seed_data" / "tools.json"

sys.path.insert(0, str(_HERE.parent))


def _seed_tool(name: str) -> dict:
    with _SEED_TOOLS.open(encoding="utf-8") as fh:
        data = json.load(fh)
    for tool in data["tools"]:
        if tool["name"] == name:
            return tool
    raise AssertionError(f"seed tools.json 缺工具 {name}")


class DeclarativeSandboxProxyGuardTests(unittest.TestCase):
    """声明式沙箱代理的实质守卫（白名单现取 + 拒绝路径携带错误码）。"""

    def _build_proxy(self, tools: list[dict]):
        from ink_engine.core.declarative_tools import (
            DeclarativeToolExecutors,
            DeclarativeToolSpec,
        )

        executors = DeclarativeToolExecutors()
        for tool in tools:
            spec = DeclarativeToolSpec.from_dict(tool)
            executors.register_definition(spec)

        from inkling_host.security_domain import DeclarativeSandboxProxy

        return DeclarativeSandboxProxy(executors)

    def _validate_as(self, proxy, name: str, operation: str, target: str):
        from inkling_host.security_domain import _current_spec

        token = _current_spec.set(name)
        try:
            return proxy.validate(operation, target)
        finally:
            _current_spec.reset(token)

    def test_process_exec_allowlist_is_substantive(self):
        """process_exec 守卫按声明 allowlist 判定：白名单成员放行、非成员拒绝。"""
        from ink_engine.core.exceptions import SandboxViolation

        from inkling_host.security_domain import ErrorCode

        proxy = self._build_proxy([_seed_tool("launch_app")])
        # 白名单成员（端点命令 = 工具名）放行
        self.assertEqual(
            self._validate_as(proxy, "launch_app", "exec", "launch_app"),
            "launch_app",
        )
        # 非白名单命令实质拒绝（修复前 target==command 形同 no-op）
        with self.assertRaises(SandboxViolation) as ctx:
            self._validate_as(proxy, "launch_app", "exec", "rm -rf /")
        self.assertIn(ErrorCode.PROCESS_NOT_ALLOWLISTED, str(ctx.exception))

    def test_guard_follows_declaration_not_hardcode(self):
        """守卫读声明：改声明白名单，守卫判定随之变化（单一真相源）。"""
        from ink_engine.core.exceptions import SandboxViolation

        from inkling_host.security_domain import ErrorCode

        tool = _seed_tool("launch_app")
        tool = dict(tool)
        tool["endpoint_config"] = {"allowlist": ["custom_launcher"]}
        proxy = self._build_proxy([tool])
        self.assertEqual(
            self._validate_as(proxy, "launch_app", "exec", "custom_launcher"),
            "custom_launcher",
        )
        with self.assertRaises(SandboxViolation) as ctx:
            self._validate_as(proxy, "launch_app", "exec", "launch_app")
        self.assertIn(ErrorCode.PROCESS_NOT_ALLOWLISTED, str(ctx.exception))

    def test_http_fetch_domain_allowlist_from_declaration(self):
        """http_fetch 守卫按声明 network_policy.allow_domains 判定（越域拒绝）。"""
        from ink_engine.core.exceptions import SandboxViolation

        proxy = self._build_proxy([_seed_tool("fetch")])
        self.assertEqual(
            self._validate_as(proxy, "fetch", "connect", "arxiv.org"),
            "arxiv.org",
        )
        with self.assertRaises(SandboxViolation) as ctx:
            self._validate_as(proxy, "fetch", "connect", "127.0.0.1")
        self.assertIn("白名单", str(ctx.exception))

    def test_file_ops_unauthorized_fail_closed(self):
        """file_ops 守卫：工作区未授权即拒绝（占位符未解析 = 无根可越）。"""
        from ink_engine.core.exceptions import SandboxViolation

        proxy = self._build_proxy([_seed_tool("file_read")])
        with self.assertRaises(SandboxViolation) as ctx:
            self._validate_as(proxy, "file_read", "read", "/anywhere/secret.txt")
        self.assertIn("未授权", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()

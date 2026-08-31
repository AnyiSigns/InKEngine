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

    def _build_executors(self, tools: list[dict]):
        from ink_engine.core.declarative_tools import (
            DeclarativeToolExecutors,
            DeclarativeToolSpec,
        )

        executors = DeclarativeToolExecutors()
        for tool in tools:
            spec = DeclarativeToolSpec.from_dict(tool)
            executors.register_definition(spec)
        return executors

    def _build_proxy(self, tools: list[dict]):
        from inkling_host.security_domain import DeclarativeSandboxProxy

        return DeclarativeSandboxProxy(self._build_executors(tools))

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

    def test_http_fetch_connect_passes_sandbox(self):
        """http_fetch 出网经审批网关裁决（出厂 review 档弹卡），
        沙箱层不再按 allow_domains 二次硬拦——审批即网关（定义级白名单
        是装配提示而非执行期网关）。"""
        proxy = self._build_proxy([_seed_tool("fetch")])
        # 任一域名放行：审批卡是网关，沙箱不再拦截
        self.assertEqual(
            self._validate_as(proxy, "fetch", "connect", "arxiv.org"),
            "arxiv.org",
        )
        self.assertEqual(
            self._validate_as(proxy, "fetch", "connect", "127.0.0.1"),
            "127.0.0.1",
        )

    def test_file_ops_unauthorized_fail_closed(self):
        """file_ops 守卫：工作区未授权即拒绝（占位符未解析 = 无根可越）。"""
        from ink_engine.core.exceptions import SandboxViolation

        proxy = self._build_proxy([_seed_tool("file_read")])
        with self.assertRaises(SandboxViolation) as ctx:
            self._validate_as(proxy, "file_read", "read", "/anywhere/secret.txt")
        self.assertIn("未授权", str(ctx.exception))

    def test_tier_override_changes_gate_decision(self):
        """档位覆盖（权限矩阵写面）：review→allow = 直过；覆盖等于出厂档
        = 撤销覆盖回到弹卡。"""
        from ink_engine.core.permissions import ALLOW, REVIEW

        from inkling_host.security_domain import TieredGate

        tiers = {"fetch": "review"}
        gate = TieredGate(tiers, executors=self._build_executors([_seed_tool("fetch")]))
        # 出厂 review 档 → 弹卡（REVIEW）
        result = gate.check("fetch", "connect", "arxiv.org")
        self.assertEqual(result.decision, REVIEW)
        # review → allow 覆盖后 → 直过
        gate.set_tier_override("fetch", "allow")
        result = gate.check("fetch", "connect", "arxiv.org")
        self.assertEqual(result.decision, ALLOW)
        # 覆盖等于出厂档 = 撤销覆盖，回到 review 弹卡
        gate.set_tier_override("fetch", "review")
        result = gate.check("fetch", "connect", "arxiv.org")
        self.assertEqual(result.decision, REVIEW)
        # 批量覆盖只保留非出厂档（配置面快照）
        gate.set_tier_overrides({"fetch": "allow"})
        self.assertEqual(gate.tier_overrides(), {"fetch": "allow"})
        self.assertEqual(gate.effective_tier("fetch"), "allow")

    def test_tier_override_deny_factory_tool_rejected(self):
        """出厂 deny 档不可档位覆盖（权限变更须经补丁链审批转正）；
        未登记工具 / 非法档位 = 显式拒绝。"""
        from inkling_host.security_domain import TieredGate

        gate = TieredGate({"forbidden_ctl": "deny", "fetch": "review"})
        with self.assertRaises(ValueError):
            gate.set_tier_override("forbidden_ctl", "allow")
        with self.assertRaises(ValueError):
            gate.set_tier_override("unknown_tool", "allow")
        with self.assertRaises(ValueError):
            gate.set_tier_override("fetch", "bogus")

    def test_shell_exec_escalation_gate_reviews_non_allowlisted(self):
        """混合 shell（meta.escalation）：白名单外命令门禁升级为 REVIEW
        （弹卡裁决）而非 fail-closed DENY；白名单内命令保持原判定。"""
        from ink_engine.core.permissions import ALLOW, REVIEW

        from inkling_host.security_domain import TieredGate

        tool = _seed_tool("shell_exec")
        gate = TieredGate({"shell_exec": "review"}, executors=self._build_executors([tool]))
        # 白名单内命令：权限命中 + review 档 → REVIEW（弹卡）
        inside = gate.check("shell_exec", "exec", "python")
        self.assertEqual(inside.decision, REVIEW)
        # 白名单外命令：升级审批（REVIEW + 升级语义），不 fail-closed 拒绝
        outside = gate.check("shell_exec", "exec", "where")
        self.assertEqual(outside.decision, REVIEW)
        self.assertIn("升级", outside.reason)
        # 非 escalation 工具（launch_app）：白名单外仍硬拒（fail-closed）
        launcher = _seed_tool("launch_app")
        gate2 = TieredGate({"launch_app": "review"}, executors=self._build_executors([launcher]))
        verdict = gate2.check("launch_app", "exec", "evil.exe")
        self.assertEqual(verdict.decision, "deny")

    def test_shell_exec_sandbox_passes_non_allowlisted_for_escalation(self):
        """混合 shell 沙箱：白名单外命令放行到审批闸（审批即网关），
        不再 SEC_007 二次硬拦；非 escalation 工具照常拦截。"""
        proxy = self._build_proxy([_seed_tool("shell_exec")])
        self.assertEqual(
            self._validate_as(proxy, "shell_exec", "exec", "where"),
            "where",
        )
        self.assertEqual(
            self._validate_as(proxy, "shell_exec", "exec", "python"),
            "python",
        )
        # 非 escalation 工具白名单外仍拒绝
        from ink_engine.core.exceptions import SandboxViolation

        launcher_proxy = self._build_proxy([_seed_tool("launch_app")])
        with self.assertRaises(SandboxViolation):
            self._validate_as(launcher_proxy, "launch_app", "exec", "evil.exe")

    def test_shell_exec_executor_marks_escalated_on_approved_non_allowlisted(self):
        """混合 shell 执行体：审批通过 + 白名单外命令 → 分发带 _escalated
        标记；白名单内命令不带标记。"""
        import asyncio

        from ink_engine.core.approval import ApprovalDecision, DECISION_ACCEPT

        from inkling_host.security_domain import (
            OsControlRegistry,
            make_process_exec_executor,
        )

        tool = _seed_tool("shell_exec")
        captured: dict = {}

        def impl(ctx, definition, args):
            captured["args"] = args
            return "mock-ok"

        registry = OsControlRegistry()
        registry.register("shell_exec", impl)
        executor = make_process_exec_executor(
            mount_service=object(),
            os_registry=registry,
            tiers={"shell_exec": "review"},
        )
        approval = ApprovalDecision(
            decision=DECISION_ACCEPT, action={"tool": "shell_exec"}, reason="升级审批通过"
        )
        # 白名单外命令 + 审批通过 → _escalated 标记注入
        asyncio.run(
            executor(
                ctx=None,
                definition=_spec_from_seed(tool),
                args={"command": "shell_exec", "argv": ["where", "git"]},
                approval=approval,
            )
        )
        self.assertIs(captured["args"].get("_escalated"), True)
        # 白名单内命令 → 不带标记
        asyncio.run(
            executor(
                ctx=None,
                definition=_spec_from_seed(tool),
                args={"command": "shell_exec", "argv": ["python", "--version"]},
                approval=approval,
            )
        )
        self.assertNotIn("_escalated", captured["args"])


def _spec_from_seed(tool: dict):
    from ink_engine.core.declarative_tools import DeclarativeToolSpec

    return DeclarativeToolSpec.from_dict(tool)


class HttpFetchExecutorTest(unittest.TestCase):
    """http_fetch 执行体：审批即网关，不再按 allow_domains 二次硬拦。

    与 Rust 侧 ``execute_http_fetch`` 同口径：只做协议收口（http/https），
    域名放行与否由审批卡裁决（fetch 出厂 review 档弹卡）。
    """

    def _seed(self):
        return _seed_tool("fetch")

    def test_unlisted_domain_passes_to_fetch(self):
        """allow_domains 空白名单不再拦截：审批即网关（取回实现注入 stub）。"""
        import asyncio

        from inkling_host.security_domain import make_http_fetch_executor

        captured: dict = {}

        def fetch(definition, args):
            captured["url"] = args["url"]
            return "body-ok"

        executor = make_http_fetch_executor(fetch=fetch)
        spec = _spec_from_seed(self._seed())
        # 出厂 allow_domains=[]（留空）+ 非白名单域名 → 仍可执行（审批已裁决）
        result = asyncio.run(
            executor(
                ctx=None,
                definition=spec,
                args={"url": "https://arxiv.org/abs/2401.12345"},
                approval=None,
            )
        )
        self.assertEqual(captured["url"], "https://arxiv.org/abs/2401.12345")
        self.assertIn("body-ok", str(result))

    def test_scheme_enforced(self):
        """协议收口：非 http/https 拒绝（SEC_006），http/https 放行。"""
        import asyncio

        from inkling_host.security_domain import ErrorCode, make_http_fetch_executor

        def fetch(definition, args):
            return "body-ok"

        executor = make_http_fetch_executor(fetch=fetch)
        spec = _spec_from_seed(self._seed())
        blocked = asyncio.run(
            executor(
                ctx=None,
                definition=spec,
                args={"url": "file:///etc/passwd"},
                approval=None,
            )
        )
        self.assertIn(ErrorCode.NETWORK_DOMAIN_BLOCKED, str(blocked))
        ok = asyncio.run(
            executor(
                ctx=None,
                definition=spec,
                args={"url": "http://127.0.0.1/x"},
                approval=None,
            )
        )
        self.assertIn("body-ok", str(ok))


class GrepSearchIncludeRegressionTest(unittest.TestCase):
    """grep（file_ops search）带 include 类型过滤回归：fnmatch 须可用。

    预存缺陷：`_search` 在 include 分支调用 ``fnmatch.fnmatch`` 但未导入
    （导入只在 ``_search_paths`` 局部），带 include 参数的 grep 检索
    报 ``name 'fnmatch' is not defined``——工具全覆盖巡检实测捕获。
    """

    def _search_with_include(self, root: Path, include: str) -> dict:
        import dataclasses

        from inkling_host.security_domain import make_file_ops_executor

        executor = make_file_ops_executor()
        definition = _spec_from_seed(_seed_tool("grep"))
        definition = dataclasses.replace(
            definition, endpoint_config={"root": str(root), "operation": "search"}
        )
        text = executor._search(
            {"pattern": "hello", "include": include, "max_results": 100},
            definition,
        )
        return json.loads(text)

    def test_search_include_does_not_raise(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_text("print('hello')\n", encoding="utf-8")
            (root / "b.txt").write_text("hello\n", encoding="utf-8")
            result = self._search_with_include(root, "*.py")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["total"], 1)
            self.assertEqual(result["matches"][0]["path"], "a.py")

    def test_search_include_extension_variant(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_text("hello\n", encoding="utf-8")
            (root / "b.txt").write_text("hello\n", encoding="utf-8")
            result = self._search_with_include(root, "py")
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["total"], 1)


class AutoApproveAllMountTest(unittest.TestCase):
    """统一自动审批开关：auto_approve_all=True 时 propose_mcp_mount
    跳过挂载审批卡（require_approval=False 传入挂载服务）。

    headless 离线验证/自动化巡检形态需要「所有工具共用同一个自动审批
    开关」：propose_mcp_mount 的挂载审批卡（L2 挂载）在回合级
    auto_accept_review 覆盖不到（executor 内部 interrupt），须在此
    处放行。
    """

    def _build_executor(self, auto_approve_all: bool, captured: dict):
        import asyncio

        from inkling_host.security_domain import (
            OsControlRegistry,
            make_process_exec_executor,
        )

        class FakeMount:
            async def propose_mount(self, ctx, address, *, require_approval=True):
                captured["require_approval"] = require_approval
                captured["ctx"] = ctx
                return type(
                    "Outcome",
                    (),
                    {
                        "ok": True,
                        "status": "mounted",
                        "server_id": "fake",
                        "tool_names": ["fake_tool"],
                        "error": None,
                    },
                )()

        executor = make_process_exec_executor(
            mount_service=FakeMount(),
            os_registry=OsControlRegistry(),
            tiers={"propose_mcp_mount": "review"},
            require_approval=not auto_approve_all,
        )
        return asyncio.run(
            executor(
                ctx=None,
                definition=_spec_from_seed(_seed_tool("propose_mcp_mount")),
                args={"address": "npm:@modelcontextprotocol/server-filesystem"},
                approval=None,
            )
        )

    def test_auto_approve_all_skips_mount_card(self):
        captured: dict = {}
        result = self._build_executor(True, captured)
        self.assertIs(captured["require_approval"], False)
        self.assertIn("mounted", str(result))

    def test_default_keeps_mount_approval(self):
        captured: dict = {}
        result = self._build_executor(False, captured)
        self.assertIs(captured["require_approval"], True)
        self.assertIn("mounted", str(result))


if __name__ == "__main__":
    unittest.main()

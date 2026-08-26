"""复杂项目基准（SWE-bench 式简化代码任务集）。

通用执行闭环的实证：每道任务 = 一个独立小工程（源码含已知缺陷 + 失败测试）。
评测闭环为「改源码 → 跑测试 → 据结果再改」的多轮迭代，记录：
- 成功率（测试最终全绿比例）
- 平均轮数（到全绿或触达回合上限）
- 单任务回合上限（30）
- 测试全绿率（以跑测试为准，不靠目测）

任务集 N≥20，任务本身与代码域产品化无关——只测执行闭环是否打通。

三种执行后端：
- SmokeAgentDriver（默认门禁）：不调用真实 agent，仅搭建工程、确认基线红、
  验证「跑测试」闭环机制；成功率指标留待 live 模式。
- ReferenceAgentDriver（--self-test）：应用参考修复，验证闭环收敛能力。
- LiveAgentDriver（--live）：进程内装配引擎（参考宿主 + 自举种子配方），
  接真实模型（配置：INKENGINE_LIVE_BASE_URL/API_KEY/MODEL 环境变量优先，
  回落仓库根 .kilo/测试模型配置.txt），agent 经文件工具（file_read/file_write/
  file_edit，file_ops 端点沙箱到工作根）实际完成「改→测」迭代。
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import sys
import tempfile
import time
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# 仓库根入路径：脚本可自任意 cwd 被调用（引擎包与示例宿主经仓库根解析）
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


ROUND_CAP = 30


@dataclass
class TaskSpec:
    name: str
    sig: str
    buggy_body: str
    fixed_body: str
    cases: list[tuple[tuple, object]]


# 八类缺陷模板，按不同用例实例化出 ≥20 道任务
_TEMPLATES = [
    TaskSpec(
        "sum_range", "def solve(n):",
        "    return sum(range(1, n))",
        "    return sum(range(1, n + 1))",
        [((5,), 15), ((1,), 1), ((10,), 55)],
    ),
    TaskSpec(
        "add_two", "def solve(a, b):",
        "    return a - b",
        "    return a + b",
        [((2, 3), 5), ((7, 1), 8), ((0, 0), 0)],
    ),
    TaskSpec(
        "abs_diff", "def solve(a, b):",
        "    return a - b",
        "    return abs(a - b)",
        [((3, 7), 4), ((10, 2), 8), ((-4, 4), 8)],
    ),
    TaskSpec(
        "boundary", "def solve(x):",
        "    return x > 10",
        "    return x >= 10",
        [((10,), True), ((9,), False), ((11,), True)],
    ),
    TaskSpec(
        "multiply", "def solve(a, b):",
        "    return a + b",
        "    return a * b",
        [((3, 4), 12), ((6, 7), 42), ((0, 5), 0)],
    ),
    TaskSpec(
        "reverse_str", "def solve(s):",
        "    return s",
        "    return s[::-1]",
        [(("abc",), "cba"), (("hello",), "olleh")],
    ),
    TaskSpec(
        "count_even", "def solve(xs):",
        "    return len(xs)",
        "    return sum(1 for x in xs if x % 2 == 0)",
        [(((1, 2, 3, 4),), 2), (((2, 4, 6),), 3)],
    ),
    TaskSpec(
        "max_of", "def solve(xs):",
        "    return min(xs)",
        "    return max(xs)",
        [(((3, 9, 1),), 9), (((5, 2, 8, 1),), 8)],
    ),
]


def build_tasks(count: int = 20) -> list[TaskSpec]:
    tasks: list[TaskSpec] = []
    idx = 0
    while len(tasks) < count:
        tmpl = _TEMPLATES[idx % len(_TEMPLATES)]
        variant = idx // len(_TEMPLATES)
        name = f"{tmpl.name}_{variant + 1}"
        tasks.append(
            TaskSpec(name, tmpl.sig, tmpl.buggy_body, tmpl.fixed_body, tmpl.cases)
        )
        idx += 1
    return tasks


def _render_module(spec: TaskSpec, body: str) -> str:
    return f"{spec.sig}\n{body}\n"


def _render_test(spec: TaskSpec) -> str:
    cases_repr = repr(list(spec.cases))
    return (
        "import importlib.util\n"
        "from pathlib import Path\n"
        "import pytest\n\n"
        "_CASES = " + cases_repr + "\n\n"
        "def _load():\n"
        "    spec = importlib.util.spec_from_file_location('solution', "
        "Path(__file__).with_name('solution.py'))\n"
        "    mod = importlib.util.module_from_spec(spec)\n"
        "    spec.loader.exec_module(mod)\n"
        "    return mod\n\n"
        "def test_solution():\n"
        "    mod = _load()\n"
        "    for args, expected in _CASES:\n"
        "        assert mod.solve(*args) == expected\n"
    )


def scaffold(spec: TaskSpec, directory: Path, *, fixed: bool = False) -> None:
    (directory / "solution.py").write_text(
        _render_module(spec, spec.fixed_body if fixed else spec.buggy_body),
        encoding="utf-8",
    )
    (directory / "test_solution.py").write_text(_render_test(spec), encoding="utf-8")


_load_counter = 0


def _load_solution(path: Path):
    """进程内加载待测模块：每次从源码重编，绕过 .pyc 缓存（同路径快速改写时
    字节码 mtime 不变会被复用，导致读到旧实现）。"""
    global _load_counter
    _load_counter += 1
    mod = types.ModuleType(f"bench_solution_{_load_counter}")
    mod.__file__ = str(path)
    source = path.read_text(encoding="utf-8")
    code = compile(source, str(path), "exec")
    exec(code, mod.__dict__)
    return mod


def _load_cases(directory: Path) -> list | None:
    """从测试文件读用例清单（_CASES 常量；缺失/损坏返回 None）。"""
    path = directory / "test_solution.py"
    try:
        mod = _load_solution(path)
        cases = getattr(mod, "_CASES", None)
    except Exception:
        return None
    return cases if isinstance(cases, list) else None


def run_tests(directory: Path) -> bool:
    """跑测试工具等价物：进程内执行用例断言（live 模式替换为 run_test_* op）。

    进程内执行避免子进程反复拉起与本地安全软件对新建 .py 的扫描抖动，
    对这类隔离小工程足够且确定性更强；真实后端走白名单 run_test_* op。
    用例清单来自测试文件（_CASES 常量），与 solution.py 解耦——agent
    整体重写 solution.py 不影响判定。
    """
    path = directory / "solution.py"
    try:
        mod = _load_solution(path)
        cases = _load_cases(directory)
        if cases is None:
            return False
        for args, expected in cases:
            got = mod.solve(*args)
            if got != expected:
                return False
    except Exception:
        return False
    return True


def first_failure(directory: Path) -> str:
    """首个未通过用例的判定文本（回合反馈用；无失败返回空串）。"""
    path = directory / "solution.py"
    try:
        mod = _load_solution(path)
        cases = _load_cases(directory)
        if cases is None:
            return "test_solution.py 用例清单缺失或损坏"
        for args, expected in cases:
            try:
                got = mod.solve(*args)
            except Exception as exc:
                return f"solve{args} 抛异常: {type(exc).__name__}: {exc}"
            if got != expected:
                return f"solve{args} = {got!r}（期望 {expected!r}）"
    except Exception as exc:
        return f"solution.py 无法加载: {type(exc).__name__}: {exc}"
    return ""


# ── 执行后端 ──

class AgentDriver:
    def fix_round(self, spec: TaskSpec, directory: Path, round_no: int) -> bool:
        """返回 True 表示本轮已应用修改（随后由框架跑测试判定）。"""
        raise NotImplementedError


class SmokeAgentDriver(AgentDriver):
    """门禁默认后端：不调用真实 agent，仅暴露闭环机制。"""

    def fix_round(self, spec: TaskSpec, directory: Path, round_no: int) -> bool:
        return False


class ReferenceAgentDriver(AgentDriver):
    """自测后端（--self-test 专用）：应用参考修复，验证闭环能收敛到全绿。"""

    def fix_round(self, spec: TaskSpec, directory: Path, round_no: int) -> bool:
        if round_no == 1:
            scaffold(spec, directory, fixed=True)
            return True
        return False


# ── live 后端（真实模型；引擎进程内装配）─────────────────────────

_FILE_TOOL_DEFS = [
    {
        "name": "file_read",
        "description": "读取工程内文件内容（path=相对工程根目录的路径）",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["read"]},
                "path": {"type": "string", "description": "相对路径"},
            },
            "required": ["operation", "path"],
        },
        "permissions": ["filesystem:read:*"],
    },
    {
        "name": "file_write",
        "description": "写入/覆盖工程内文件（path=相对路径，content=完整新内容）",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["write"]},
                "path": {"type": "string", "description": "相对路径"},
                "content": {"type": "string", "description": "写入内容"},
            },
            "required": ["operation", "path", "content"],
        },
        "permissions": ["filesystem:write:*"],
    },
    {
        "name": "file_edit",
        "description": "按 old_text 定位替换为 new_text（path=相对路径；old_text 须唯一命中）",
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {"type": "string", "enum": ["edit"]},
                "path": {"type": "string", "description": "相对路径"},
                "old_text": {"type": "string", "description": "待替换原文"},
                "new_text": {"type": "string", "description": "替换后文本"},
            },
            "required": ["operation", "path", "old_text", "new_text"],
        },
        "permissions": ["filesystem:write:*"],
    },
]

_MAX_READ_BYTES = 64 * 1024


class LiveAgentDriver(AgentDriver):
    """真实模型后端：进程内装配参考宿主 + 自举种子配方，文件工具挂
    file_ops 端点、沙箱根 = 基准工作根；每轮一次回合驱动（真实 LLM），
    框架侧跑测试判定。配置来源与测试套件同口径（env 优先，回落
    .kilo/测试模型配置.txt）。"""

    def __init__(self, work_root: Path | None = None) -> None:
        self._work_root = work_root or Path(tempfile.mkdtemp(prefix="bench_complex_live_"))
        self._active_dir: Path | None = None
        self._runtime = None
        self._host = None
        # 最近一轮的归因信息（工具调用/错误/失败点；供失败任务的 0 轮归因）
        self._last_round: dict | None = None

    async def boot(self) -> None:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType
        from ink_engine.core.runtime import Runtime
        from ink_engine.examples.e2e.host import ReferenceHost
        from ink_engine.examples.e2e.recipe import build_reference_recipe

        class _BenchHost(ReferenceHost):
            """基准宿主：审批策略直过（免挂卡），其余与参考宿主一致。"""

            def interrupt_policy(self):
                from ink_engine.core.approval import InterruptPolicy

                class _PassPolicy(InterruptPolicy):
                    def should_approve(self, key, action):
                        return False

                    def timeout_for(self, key, action):
                        return None

                return _PassPolicy()

        self._host = _BenchHost()
        self._runtime = await Runtime().boot(self._host, build_reference_recipe())
        await self._register_file_tools()

    async def _register_file_tools(self) -> None:
        from ink_engine.core.declarative_tools import DeclarativeToolSpec, EndpointType

        async def file_executor(ctx, defn, args, approval):
            op = str(args.get("operation") or "")
            rel = str(args.get("path") or "")
            base = self._active_dir if self._active_dir is not None else self._work_root
            if Path(rel).is_absolute():
                target = Path(rel)
            else:
                target = base / rel
            try:
                target = target.resolve()
            except OSError:
                return f"路径无效: {rel}"
            work_root = self._work_root.resolve()
            if not str(target).startswith(str(work_root)):
                return f"路径越界（沙箱拒绝）: {rel}"
            if op == "read":
                if not target.is_file():
                    return f"文件不存在: {rel}"
                text = target.read_text(encoding="utf-8")
                if len(text) > _MAX_READ_BYTES:
                    text = text[:_MAX_READ_BYTES] + "\n[截断]"
                return text
            if op == "write":
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(str(args.get("content") or ""), encoding="utf-8")
                return f"已写入 {rel}（{target.stat().st_size} 字节）"
            if op == "edit":
                if not target.is_file():
                    return f"文件不存在: {rel}"
                old_text = str(args.get("old_text") or "")
                new_text = str(args.get("new_text") or "")
                text = target.read_text(encoding="utf-8")
                if old_text not in text:
                    return f"替换失败：old_text 未命中 {rel}"
                target.write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
                return f"已替换 {rel}"
            return f"不支持的 operation: {op}"

        self._runtime.harness_registry.declarative.register(
            EndpointType.FILE_OPS, file_executor
        )
        for item in _FILE_TOOL_DEFS:
            spec = DeclarativeToolSpec(
                name=item["name"],
                description=item["description"],
                parameters=item["parameters"],
                permissions=tuple(item["permissions"]),
                endpoint=EndpointType.FILE_OPS,
                endpoint_config={"root": str(self._work_root)},
            )
            self._runtime.harness_registry.declarative.register_definition(spec)
            self._runtime.tool_registry[spec.name] = spec.to_spec()
        await self._runtime.rebuild_engine()

    async def fix_round(self, spec: TaskSpec, directory: Path, round_no: int) -> bool:
        from ink_engine.examples.e2e.host import run_round

        self._active_dir = directory
        digest_before = _digest(directory / "solution.py")
        detail = first_failure(directory)
        if round_no == 1:
            prompt = (
                f"你在完成一个代码修复任务。工程目录：{directory}\n"
                f"- solution.py 含函数 solve，当前实现有缺陷；\n"
                f"- test_solution.py 是测试文件，内含用例清单 _CASES"
                f"（（参数, 期望）元组列表），断言 solve(*参数) == 期望。\n"
                f"任务：用 file_read 查看两个文件，用 file_write 或 file_edit 修改"
                f" solution.py，使测试全部通过。\n"
                f"约束：只改 solution.py（保持 solve 的函数签名不变，只修实现）；"
                f"不得修改 test_solution.py；文件操作路径用相对路径"
                f"（如 solution.py），相对于工程目录。\n"
                f"完成后用一句话说明你改了什么。"
            )
        else:
            prompt = (
                f"上一轮修改后测试仍未全绿。当前失败点：{detail}\n"
                f"工程目录：{directory}。请用 file_read 确认 solution.py 当前内容，"
                f"再用 file_write 或 file_edit 修正实现，使测试全部通过。\n"
                f"约束：只改 solution.py（保持 solve 的函数签名），"
                f"不得修改 test_solution.py；文件操作路径用相对路径。\n"
                f"完成后用一句话说明你改了什么。"
            )
        outcome = await run_round(
            self._runtime, self._host, prompt, max_resumes=4, event_offset=0
        )
        tool_calls = [
            str(e.payload.get("tool", ""))
            for e in outcome["events"]
            if e.type == "tool_start"
        ]
        errors = [
            str(e.payload.get("message", ""))
            for e in outcome["events"]
            if e.type == "error"
        ]
        self._last_round = {
            "round": round_no,
            "tool_calls": tool_calls,
            "errors": errors,
            "failure": detail,
            "reason": getattr(outcome["result"].reason, "value", str(outcome["result"].reason)),
        }
        digest_after = _digest(directory / "solution.py")
        return digest_before != digest_after

    async def close(self) -> None:
        if self._runtime is not None:
            await self._runtime.stop()


def _digest(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


async def evaluate_async(
    tasks: list[TaskSpec],
    driver: LiveAgentDriver,
    *,
    round_cap: int = ROUND_CAP,
    work_root: Path | None = None,
) -> dict:
    """live 后端评测核心（单事件循环内完成，避免跨循环句柄借用）。"""
    work = work_root or driver._work_root
    work.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    baseline_red = 0
    for spec in tasks:
        proj = work / spec.name
        proj.mkdir(parents=True, exist_ok=True)
        scaffold(spec, proj, fixed=False)
        green_at_start = run_tests(proj)
        if not green_at_start:
            baseline_red += 1
        success = green_at_start
        rounds = 0
        last_round: dict | None = None
        for r in range(1, round_cap + 1):
            changed = await driver.fix_round(spec, proj, r)
            last_round = getattr(driver, "_last_round", None)
            if not changed:
                break
            rounds = r
            if run_tests(proj):
                success = True
                break
        result: dict = {"name": spec.name, "success": success, "rounds": rounds}
        if last_round is not None:
            result["last_round"] = last_round
        results.append(result)
    passed = sum(1 for r in results if r["success"])
    avg_rounds = (
        sum(r["rounds"] for r in results if r["success"]) / passed if passed else 0.0
    )
    return {
        "total": len(results),
        "passed": passed,
        "baseline_red": baseline_red,
        "avg_rounds": avg_rounds,
        "round_cap": round_cap,
        "success_rate": (passed / len(results)) if results else 0.0,
        "all_green_rate": (passed / len(results)) if results else 0.0,
        "results": results,
        "work_root": str(work),
    }


def evaluate(
    tasks: list[TaskSpec],
    driver: AgentDriver,
    *,
    round_cap: int = ROUND_CAP,
    work_root: Path | None = None,
) -> dict:
    work = work_root or Path(tempfile.mkdtemp(prefix="bench_complex_"))
    work.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    baseline_red = 0
    for spec in tasks:
        proj = work / spec.name
        proj.mkdir(parents=True, exist_ok=True)
        scaffold(spec, proj, fixed=False)
        green_at_start = run_tests(proj)
        if not green_at_start:
            baseline_red += 1
        success = green_at_start
        rounds = 0
        for r in range(1, round_cap + 1):
            if not driver.fix_round(spec, proj, r):
                break
            rounds = r
            if run_tests(proj):
                success = True
                break
        results.append({"name": spec.name, "success": success, "rounds": rounds})
    passed = sum(1 for r in results if r["success"])
    avg_rounds = (
        sum(r["rounds"] for r in results if r["success"]) / passed if passed else 0.0
    )
    return {
        "total": len(results),
        "passed": passed,
        "baseline_red": baseline_red,
        "avg_rounds": avg_rounds,
        "round_cap": round_cap,
        "success_rate": (passed / len(results)) if results else 0.0,
        "all_green_rate": (passed / len(results)) if results else 0.0,
        "results": results,
        "work_root": str(work),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="复杂项目基准（SWE-bench 式）")
    parser.add_argument("--live", action="store_true", help="接入真实 agent（需 live 后端）")
    parser.add_argument("--self-test", action="store_true", help="用参考修复自测闭环收敛")
    parser.add_argument("--count", type=int, default=20, help="任务数（默认 20）")
    parser.add_argument("--target-rate", type=float, default=0.80, help="成功率达标线（默认 0.80）")
    parser.add_argument("--target-rounds", type=float, default=8.0, help="平均轮数达标上限")
    parser.add_argument("--detail", action="store_true", help="输出失败任务归因明细（工具调用/错误/失败点）")
    args = parser.parse_args()

    tasks = build_tasks(args.count)
    if args.self_test:
        driver: AgentDriver = ReferenceAgentDriver()
        mode = "self-test(参考修复)"
    elif args.live:
        driver = LiveAgentDriver()
        mode = "live(真实模型)"
    else:
        driver = SmokeAgentDriver()
        mode = "smoke(门禁默认)"

    start = time.perf_counter()
    if args.live:
        async def _run_live() -> dict:
            await driver.boot()
            try:
                return await evaluate_async(tasks, driver)
            finally:
                await driver.close()

        report = asyncio.run(_run_live())
    else:
        report = evaluate(tasks, driver)
    elapsed = time.perf_counter() - start

    print("=" * 78)
    print(f"复杂项目基准 [{mode}]  任务数={report['total']}  回合上限={report['round_cap']}")
    print("=" * 78)
    print(f"  基线红（初始测试失败）= {report['baseline_red']}/{report['total']}")
    print(f"  成功（测试全绿）= {report['passed']}/{report['total']} "
          f"（成功率 {report['success_rate']:.1%}）")
    print(f"  平均轮数 = {report['avg_rounds']:.2f}（达标上限 {args.target_rounds:.0f}）")
    print(f"  测试全绿率 = {report['all_green_rate']:.1%}  耗时 {elapsed:.2f}s")
    print(f"  工程目录 = {report['work_root']}")
    if args.live:
        for item in report["results"]:
            print(f"    - {item['name']}: {'全绿' if item['success'] else '失败'}"
                  f"（{item['rounds']} 轮）")
        if args.detail:
            print("  [归因明细：失败任务的最后一轮]")
            for item in report["results"]:
                if item["success"] or "last_round" not in item:
                    continue
                lr = item["last_round"]
                tools = ", ".join(lr.get("tool_calls") or []) or "（未调用工具）"
                errors = "；".join(lr.get("errors") or []) or "（无错误事件）"
                print(f"    - {item['name']} 第{lr.get('round')}轮: 工具=[{tools}]"
                      f" 错误=[{errors}] 失败点=[{lr.get('failure')}]")
    if args.self_test:
        ok = (
            report["passed"] == report["total"]
            and report["avg_rounds"] <= args.target_rounds
        )
        print(f"自测结论：{'闭环收敛达标' if ok else '闭环未收敛'}")
        return 0 if ok else 1
    if args.live:
        ok = (
            report["success_rate"] >= args.target_rate
            and report["avg_rounds"] <= args.target_rounds
        )
        print(f"live 结论：{'达标' if ok else '未达标'}（成功率 {report['success_rate']:.1%}"
              f" ≥ {args.target_rate:.0%}，平均轮数 {report['avg_rounds']:.2f}"
              f" ≤ {args.target_rounds:.0f}）")
        return 0 if ok else 1
    print("门禁冒烟结论：任务集搭建 + 基线红确认 + 跑测试闭环机制可用；"
          "成功率指标需 live 模式接真实 agent")
    return 0


if __name__ == "__main__":
    sys.exit(main())

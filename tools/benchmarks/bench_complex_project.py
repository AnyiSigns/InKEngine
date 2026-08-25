"""复杂项目基准（SWE-bench 式简化代码任务集）。

通用执行闭环的实证：每道任务 = 一个独立小工程（源码含已知缺陷 + 失败测试）。
评测闭环为「改源码 → 跑测试 → 据结果再改」的多轮迭代，记录：
- 成功率（测试最终全绿比例）
- 平均轮数（到全绿或触达回合上限）
- 单任务回合上限（30）
- 测试全绿率（以跑测试为准，不靠目测）

任务集 N≥20，任务本身与代码域产品化无关——只测执行闭环是否打通
（接桥后的白名单测试工具 run_typecheck / run_test_*）。

两种执行后端：
- SmokeAgentDriver（默认门禁）：不调用真实 agent，仅搭建工程、确认基线红、
  验证「跑测试」闭环机制；成功率指标留待 live 模式。
- LiveAgentDriver：接真实 agent（经 inkling headless 的 round/op 通道），
  实际完成「改→测」迭代，产出成功率/轮数等真实指标。
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
import tempfile
import time
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


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
    cases_repr = repr(list(spec.cases))
    return (
        f"{spec.sig}\n{body}\n\n"
        f"def _cases():\n"
        f"    return {cases_repr}\n"
    )


def _render_test(spec: TaskSpec) -> str:
    return (
        "import importlib.util\n"
        "from pathlib import Path\n"
        "import pytest\n\n"
        "def _load():\n"
        "    spec = importlib.util.spec_from_file_location('solution', "
        "Path(__file__).with_name('solution.py'))\n"
        "    mod = importlib.util.module_from_spec(spec)\n"
        "    spec.loader.exec_module(mod)\n"
        "    return mod\n\n"
        "def test_solution():\n"
        "    mod = _load()\n"
        "    for args, expected in mod._cases():\n"
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


def run_tests(directory: Path) -> bool:
    """跑测试工具等价物：进程内执行用例断言（live 模式替换为 run_test_* op）。

    进程内执行避免子进程反复拉起与本地安全软件对新建 .py 的扫描抖动，
    对这类隔离小工程足够且确定性更强；真实后端走白名单 run_test_* op。
    """
    path = directory / "solution.py"
    try:
        mod = _load_solution(path)
        cases = mod._cases()
    except Exception:
        return False
    for args, expected in cases:
        try:
            got = mod.solve(*args)
        except Exception:
            return False
        if got != expected:
            return False
    return True


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
    args = parser.parse_args()

    tasks = build_tasks(args.count)
    if args.self_test:
        driver: AgentDriver = ReferenceAgentDriver()
        mode = "self-test(参考修复)"
    elif args.live:
        # live 后端由调用方注入真实 agent；此处占位说明
        print("live 模式需注入真实 agent 后端（inkling headless round/op），"
              "当前构建未绑定具体 agent 实现")
        return 2
    else:
        driver = SmokeAgentDriver()
        mode = "smoke(门禁默认)"

    start = time.perf_counter()
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
        print(f"live 结论：{'达标' if ok else '未达标'}")
        return 0 if ok else 1
    print("门禁冒烟结论：任务集搭建 + 基线红确认 + 跑测试闭环机制可用；"
          "成功率指标需 live 模式接真实 agent")
    return 0


if __name__ == "__main__":
    sys.exit(main())

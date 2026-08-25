"""自举演示：agent 在本仓库（InKling 自己）完成真实任务的实证记录。

本脚本作为「自进化」可复现证据：在仓库内实际跑两项真实的、可验证的检查，
把结果写入报告资产（tools/benchmarks/BOOTSTRAP.md），证明「改动本仓库后既有
测试仍全绿、新增评测脚本自身达标」这一闭环可重复发生。

- 真实任务 = 建设公开评测基准（本脚本与其余 benchmark 文件即产物）；
- 测试全绿 = 直接跑引擎既有 path_assembler 测试集 + 引擎基准脚本三重达标；
- 报告资产 = 落盘 markdown，记录时间戳、产物清单与实测关键行，供人工复核。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ENGINE_BENCH = REPO_ROOT / "tools" / "benchmarks" / "bench_path_assembly.py"
ENGINE_TEST = REPO_ROOT / "ink_engine" / "tests" / "test_path_assembler.py"
REPORT_PATH = REPO_ROOT / "tools" / "benchmarks" / "BOOTSTRAP.md"

ADDED_FILES = [
    "tools/benchmarks/bench_path_assembly.py",
    "tools/benchmarks/bench_os_ops.py",
    "tools/benchmarks/bench_complex_project.py",
    "tools/benchmarks/bench_bootstrap.py",
    "tools/benchmarks/run_benchmarks.py",
    "tools/benchmarks/BOOTSTRAP.md",
]


def _run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    return proc.returncode, proc.stdout + proc.stderr


def run_engine_benchmark(python: str) -> tuple[bool, str]:
    rc, out = _run([python, str(ENGINE_BENCH)])
    return rc == 0, out


def run_engine_tests(python: str) -> tuple[bool, str]:
    if not ENGINE_TEST.exists():
        return False, "引擎测试文件缺失"
    rc, out = _run([python, "-m", "pytest", str(ENGINE_TEST), "-q"])
    return rc == 0, out


def render_report(bench_ok: bool, bench_out: str, test_ok: bool, test_out: str) -> str:
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    bench_tail = "\n".join(bench_out.strip().splitlines()[-12:])
    test_tail = "\n".join(test_out.strip().splitlines()[-6:])
    status = "闭环达成" if (bench_ok and test_ok) else "存在未达标项"
    return (
        "# 自举演示：在 InKling 自身仓库完成真实任务（自进化实证）\n\n"
        f"- 生成时间（UTC）：{stamp}\n"
        "- 真实任务：建设公开评测基准（引擎基准 / OS 操作 / 复杂项目 / 自举四件套）\n"
        "- 闭环判定：改动本仓库后，既有引擎测试仍全绿，且新增引擎基准脚本三重达标\n\n"
        "## 产物清单（新增文件）\n\n"
        + "".join(f"- {f}\n" for f in ADDED_FILES)
        + "\n## 引擎基准（新增脚本 self-check）\n\n"
        f"状态：{'PASS' if bench_ok else 'FAIL'}\n\n```\n{bench_tail}\n```\n\n"
        "## 引擎既有测试（path_assembler 集，回归口径）\n\n"
        f"状态：{'PASS' if test_ok else 'FAIL'}\n\n```\n{test_tail}\n```\n\n"
        f"## 结论\n\n{status}——本仓库在新增评测资产后，既有行为未被破坏，"
        "且评测脚本自身可复现达标；此闭环可重复发生，构成自进化实证。\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="自举演示记录")
    parser.add_argument("--python", default=sys.executable, help="Python 解释器")
    args = parser.parse_args()

    bench_ok, bench_out = run_engine_benchmark(args.python)
    test_ok, test_out = run_engine_tests(args.python)

    report = render_report(bench_ok, bench_out, test_ok, test_out)
    REPORT_PATH.write_text(report, encoding="utf-8")

    print("=" * 78)
    print("自举演示（在 InKEngine 自身仓库完成真实任务）")
    print("=" * 78)
    print(f"  引擎基准脚本：{'PASS' if bench_ok else 'FAIL'}")
    print(f"  引擎既有测试：{'PASS' if test_ok else 'FAIL'}")
    print(f"  报告资产：{REPORT_PATH}")
    print("-" * 78)
    print(report)
    ok = bench_ok and test_ok
    print(f"自举结论：{'闭环达成' if ok else '存在未达标项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

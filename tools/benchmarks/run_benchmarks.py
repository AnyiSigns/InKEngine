"""基准编排入口：一站式运行四类公开评测基准。

四件套：
1. 引擎基准（bench_path_assembly.py）——可复现硬门禁：组装 <500ms / 缓存命中率
   ≥60% / spawn 展开 <2s；任一未达标即非零退出。
2. OS 操作评测（bench_os_ops.py）——元素树 + click 序列断言；无真实桌面时走
   离线模拟驱动（验证框架与口径），达标率以 live 模式跑真实桌面为准。
3. 复杂项目基准（bench_complex_project.py）——SWE-bench 式简化代码任务集，
   测通用执行闭环；门禁默认冒烟（搭建 + 基线红 + 跑测试闭环机制），成功率
   指标以 live 模式接真实 agent 为准。
4. 自举演示（bench_bootstrap.py）——在本仓库完成真实任务 + 既有测试全绿，落盘
   报告资产；含引擎 path_assembler 测试集回归检查，失败则非零退出。

退出码：引擎基准或自举回归任一未通过 → 非零（门禁失败）；其余为信息性呈现。
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH_DIR = REPO_ROOT / "tools" / "benchmarks"


def _run(python: str, script: str, *extra: str) -> tuple[int, str]:
    cmd = [python, str(BENCH_DIR / script), *extra]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    parser = argparse.ArgumentParser(description="InKling 公开评测基准编排")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--live", action="store_true", help="OS/复杂基准改走 live 后端（需真实环境）")
    args = parser.parse_args()
    py = args.python

    hard_fail = False

    print("=" * 80)
    print("InKling 公开评测基准")
    print("=" * 80)

    # 1. 引擎基准（硬门禁）
    print("\n[1/4] 引擎基准（组装<500ms / 缓存≥60% / spawn<2s）")
    rc, out = _run(py, "bench_path_assembly.py")
    print(out)
    if rc != 0:
        hard_fail = True
        print("  [FAIL] 引擎基准未达标——门禁失败")
    else:
        print("  [PASS] 引擎基准达标")

    # 2. OS 操作评测
    print("\n[2/4] OS 操作评测（元素树 + click 序列断言）")
    os_args = ["--live"] if args.live else []
    rc, out = _run(py, "bench_os_ops.py", *os_args)
    print(out)
    print("  [INFO] OS 评测已纳入；" + ("live 模式跑真实桌面" if args.live else "离线模拟驱动，达标率以 live 模式为准"))

    # 3. 复杂项目基准
    print("\n[3/4] 复杂项目基准（SWE-bench 式简化代码任务集）")
    cx_args = ["--live"] if args.live else []
    rc, out = _run(py, "bench_complex_project.py", *cx_args)
    print(out)
    print("  [INFO] 复杂项目基准已纳入；" + ("live 模式接真实 agent" if args.live else "门禁冒烟：搭建+基线红+跑测试闭环机制"))

    # 4. 自举演示（含引擎测试回归）
    print("\n[4/4] 自举演示（本仓库真实任务 + 既有测试全绿）")
    rc, out = _run(py, "bench_bootstrap.py", "--python", py)
    print(out)
    if rc != 0:
        hard_fail = True
        print("  [FAIL] 自举回归未通过——门禁失败")
    else:
        print("  [PASS] 自举闭环达成（报告资产已落盘 BOOTSTRAP.md）")

    print("\n" + "=" * 80)
    if hard_fail:
        print("基准编排结论：存在硬门禁未通过——不合并")
        return 1
    print("基准编排结论：硬门禁全部通过（引擎基准 + 自举回归）；OS/复杂为纳入项，达标率待 live 环境复核")
    return 0


if __name__ == "__main__":
    sys.exit(main())

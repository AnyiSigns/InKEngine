"""InKling 出厂自检一键聚合：manifest.json self_check 四门禁 → 矩阵化报告。

PLAN §7 自检矩阵的出厂门禁入口：单个命令跑四项门禁（schema 校验 /
cargo test / frontend typecheck / e2e 全量），输出每项的命令、状态、
耗时与输出摘要；任一失败结构化显示并以非零退出码结束。与
tests/e2e/coverage_matrix.md 逐行呼应（矩阵行 → 门禁 → 落点用例）。

运行（仓库根或任意目录）::

    python seeds/inkling/self_check.py

门禁命令来自 manifest.json ``self_check``（单一事实源，防文档-脚本
漂移——脚本不重复声明命令，只做聚合执行与报告）；脚本零第三方依赖
（纯标准库）。e2e 的容器/环境类用例以 skip 形态显式标注，不阻塞
门禁（skip 明细见 coverage_matrix.md「skip 明细」节）。
"""
from __future__ import annotations

import json
import shlex
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path

# 仓库根（self_check.py 位于 seeds/inkling/，上级两级 = 仓库根）
REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_ROOT = REPO_ROOT / "seeds" / "inkling"
MANIFEST = SEED_ROOT / "manifest.json"

# 门禁超时（秒）：cargo 首次构建/e2e 全量耗时较长，超时按失败结构化
# 呈现（不裸抛、不悬挂）
GATE_TIMEOUTS: dict[str, float] = {
    "schema": 120.0,
    "cargo_test": 1800.0,
    "frontend": 900.0,
    "e2e": 2400.0,
}

# 门禁失败修复指引（人类可读，出厂遇到红时的第一步方向）
GATE_HINTS: dict[str, str] = {
    "schema": "seed_data 或 schema 定义问题：修复后重跑；检查 validate_seed_data.py 输出定位",
    "cargo_test": "Rust 执行件问题：按 cargo 输出定位（编译/断言）；首次运行会自动构建",
    "frontend": "TS 前端问题：npm --prefix seeds/inkling/frontend install 后重跑",
    "e2e": "装配 e2e 问题：按 pytest 输出定位；引擎环境依赖 .venv 安装 ink_engine",
}

# 门禁 → PLAN §7 矩阵行 → coverage_matrix 节的呼应关系（报告头部展示）
GATE_RECIPES: dict[str, tuple[str, str]] = {
    "schema": ("数据", "一、身份与数据基线"),
    "cargo_test": ("机制件 + 执行件协议", "一（绑定）"),
    "frontend": ("渲染器（M2 门禁，frontend typecheck）", "二、装配与界面"),
    "e2e": ("装配 + 机制覆盖 + 执行深度", "三～十三"),
}

_SUMMARY_MAX = 120


@dataclass(frozen=True)
class GateResult:
    """单项门禁结果（命令/状态/耗时/输出摘要，失败不吞细节）。"""

    key: str
    label: str
    command: str
    passed: bool
    seconds: float
    summary: str
    tail: str


def _python_exe() -> str:
    """当前解释器（Windows 上 python/pytest 未必在 PATH，统一用 sys.executable）。"""
    return sys.executable


def _resolve_command(command: str) -> list[str]:
    """manifest 命令 → 进程 argv（python/pytest 换当前解释器，其余原样）。

    仅做最小改写：以 ``python`` 开头的命令换成当前解释器；以 ``pytest``
    开头的换成 ``<解释器> -m pytest``。cargo/npm 经 shutil.which 解析
    （Windows 下 npm 为 .cmd 形态，须按 PATHEXT 找到实际可执行文件）。
    """
    parts = shlex.split(command)
    if not parts:
        raise ValueError("self_check 命令为空")
    if parts[0] == "python":
        return [_python_exe(), *parts[1:]]
    if parts[0] == "pytest":
        return [_python_exe(), "-m", "pytest", *parts[1:]]
    resolved = shutil.which(parts[0])
    return [resolved if resolved else parts[0], *parts[1:]]


def _decode(raw: bytes) -> str:
    """字节 → 文本（UTF-8 优先，失败按替换符降级，不中断报告）。"""
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _passed_count(line: str) -> int:
    """从 ``N passed`` 文本提取通过数（0 缺省；N 与 passed 为相邻 token）。"""
    tokens = line.split()
    for index, token in enumerate(tokens):
        if token.rstrip(";,") == "passed" and index > 0:
            prev = tokens[index - 1].rstrip(";,")
            if prev.isdigit():
                return int(prev)
    return 0


def _summarize(output: str, *, key: str = "") -> str:
    """输出摘要：优先匹配已知结论行（cargo/pytest/tsc/schema），
    缺省取末尾非空行——失败门禁另有失败行提取，两者不混淆。

    cargo 多段 ``test result``（lib/集成/doc）取通过数最大的一段，
    避免 doc-test 的「0 passed」误导摘要；typecheck 零错且无输出的
    门禁按门禁语义给规范摘要（tsc 成功时无结论行是常态）。
    """
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    result_lines = [line for line in lines if "test result:" in line]
    if result_lines:
        best = max(result_lines, key=_passed_count)
        if _passed_count(best) > 0 or len(result_lines) == 1:
            return best[:_SUMMARY_MAX]
    for line in reversed(lines):
        if "Found 0 errors" in line:
            return line[:_SUMMARY_MAX]
        if line.startswith("全绿：") or "schema 校验通过" in line:
            return line[:_SUMMARY_MAX]
        if "passed" in line and "skipped" in line:
            return line[:_SUMMARY_MAX]
        if "passed" in line and "failed" in line:
            return line[:_SUMMARY_MAX]
    if key == "frontend":
        return "typecheck 零错（tsc 无结论行，退出码 0）"
    return lines[-1][:_SUMMARY_MAX] if lines else "（无输出）"


def _run_gate(key: str, command: str) -> GateResult:
    """执行单门禁：子进程 + 超时 + 结构化结果（失败不裸抛）。"""
    argv = _resolve_command(command)
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(REPO_ROOT),
            capture_output=True,
            timeout=GATE_TIMEOUTS.get(key, 600.0),
        )
        output = _decode(proc.stdout + proc.stderr)
        passed = proc.returncode == 0
        summary = _summarize(output, key=key) if passed else _failure_summary(output)
    except subprocess.TimeoutExpired as exc:
        output = _decode((exc.stdout or b"") + (exc.stderr or b""))
        passed = False
        summary = f"超时（> {GATE_TIMEOUTS.get(key, 600.0):.0f}s）"
    except OSError as exc:
        output = f"进程启动失败: {exc}"
        passed = False
        summary = output[: _SUMMARY_MAX]
    tail = "\n".join(output.splitlines()[-12:])
    return GateResult(
        key=key,
        label=_gate_label(key),
        command=command,
        passed=passed,
        seconds=time.monotonic() - started,
        summary=summary,
        tail=tail,
    )


def _failure_summary(output: str) -> str:
    """失败摘要：取错误/失败类行（保持可读，截断）。"""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    hits = [line for line in lines if _is_failure_line(line)]
    return (hits[0] if hits else lines[-1])[:_SUMMARY_MAX]


def _is_failure_line(line: str) -> bool:
    lower = line.lower()
    return any(
        marker in lower
        for marker in ("error", "failed", "failures", "exception", "not found")
    ) and not line.startswith("::")


def _gate_label(key: str) -> str:
    labels = {
        "schema": "数据 schema",
        "cargo_test": "机制件 cargo test",
        "frontend": "前端 typecheck",
        "e2e": "装配 e2e 全量",
    }
    return labels.get(key, key)


def _load_self_check() -> dict[str, str]:
    """manifest.json self_check → 有序门禁命令表（单一事实源）。"""
    if not MANIFEST.is_file():
        raise FileNotFoundError(f"manifest 不存在: {MANIFEST}")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    checks = manifest.get("self_check")
    if not isinstance(checks, dict) or not checks:
        raise ValueError("manifest.json 缺 self_check 门禁表（出厂门禁入口无法聚合）")
    commands: dict[str, str] = {}
    for key, entry in checks.items():
        if not isinstance(entry, dict) or not entry.get("command"):
            continue
        commands[key] = str(entry["command"])
    return commands


def _render_matrix(results: list[GateResult]) -> str:
    """矩阵化报告（定宽文本表：命令/状态/耗时/摘要）。"""
    headers = ("门禁", "命令", "状态", "耗时", "输出摘要")
    rows = [
        (
            f"{r.label}（{r.key}）",
            r.command,
            (r.passed and "PASS") or "FAIL",
            f"{r.seconds:6.1f}s",
            r.summary,
        )
        for r in results
    ]
    widths = [
        max(len(headers[i]), *(len(row[i]) for row in rows)) for i in range(len(headers))
    ]
    line = "+" + "+".join("-" * (w + 2) for w in widths) + "+"
    out = [line]
    out.append(
        "|" + "|".join(f" {headers[i].ljust(widths[i])} " for i in range(len(headers))) + "|"
    )
    out.append(line)
    for row in rows:
        out.append(
            "|" + "|".join(f" {row[i].ljust(widths[i])} " for i in range(len(headers))) + "|"
        )
    out.append(line)
    return "\n".join(out)


def _render_header(commands: dict[str, str]) -> str:
    """报告头部：门禁 ↔ PLAN §7 矩阵行 ↔ coverage_matrix 节呼应。"""
    out = [
        "InKling 出厂自检矩阵（PLAN §7 终态）",
        f"入口：seeds/inkling/self_check.py ｜ manifest: {MANIFEST.relative_to(REPO_ROOT)}",
        "门禁命令 = manifest.json self_check（单一事实源）；矩阵行呼应：",
    ]
    for key, (layer, matrix_section) in GATE_RECIPES.items():
        if key in commands:
            out.append(f"  - {_gate_label(key)}（{key}）↔ PLAN §7「{layer}」层 ↔ coverage_matrix {matrix_section}")
    return "\n".join(out)


def main(argv: list[str] | None = None) -> int:
    from contextlib import suppress

    with suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    argv = list(sys.argv[1:] if argv is None else argv)
    show_full = "--full" in argv
    try:
        commands = _load_self_check()
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"[self_check] 门禁配置读取失败: {exc}")
        return 2

    print(_render_header(commands))
    results: list[GateResult] = []
    for key, command in commands.items():
        print(f"\n== 门禁 {_gate_label(key)}（{key}）: {command}")
        print("   执行中…（超时阈值 "
              f"{GATE_TIMEOUTS.get(key, 600.0):.0f}s）")
        result = _run_gate(key, command)
        results.append(result)
        print(f"   状态 {(result.passed and 'PASS') or 'FAIL'} ｜ "
              f"耗时 {result.seconds:6.1f}s ｜ {result.summary}")
        if show_full:
            print("   —— 输出尾部 ——")
            for line in result.tail.splitlines():
                print(f"   | {line}")
        elif not result.passed:
            print("   —— 失败输出尾部（--full 查看完整输出）——")
            for line in result.tail.splitlines():
                print(f"   | {line}")
            print(f"   —— 修复方向：{GATE_HINTS.get(key, '见门禁输出')}")

    print("\n" + _render_matrix(results))
    failed = [r for r in results if not r.passed]
    if failed:
        print("\n自检未全绿：")
        for result in failed:
            print(f"  - FAIL {result.label}：{result.summary}")
            print(f"    修复方向：{GATE_HINTS.get(result.key, '见门禁输出')}")
        return 1
    print("\n自检全绿：四项门禁全部 PASS（e2e 容器/环境类用例显式 skip，"
          "不阻塞出厂门禁；明细见 coverage_matrix.md「skip 明细」节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

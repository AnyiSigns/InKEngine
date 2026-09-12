"""难域（复合域）：任务规格 + 确定性验收。

设计目标（针对 v2 的"域名太浅"审查）：
  1. **单角色必失败**：验收不仅要内容，还要一个由确定性检查器产出的 verdict
     通道，且验收会真实重跑规格测试/回译/数值代入——一个 LLM 角色节点无法喂饱；
  2. **族不再由出题者给**：family 由图中 classify 节点产出（见 hard_demo），
     本模块只提供 task 的 spec（验收规格），不含"路由答案"；
  3. 三族（code / translate / math）各自的最短合法路径都 ≥2 个异构节点协作：
       code      : classify→code→run_tests→save→exit   （run_tests 落盘验证日志）
       translate : classify→translate→backtranslate→roundtrip_check→save→exit
       math      : classify→math→verify_math→save→exit

验收是强信号（审查 #2.9）：code=真实执行规格测试 + 验证日志；translate=回译
CJK 字符重合率；math=数值代入。复述原题/写入错误通道都无法通过。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unicodedata

CONTENT_FIELDS = ("code", "translated", "math_answer")

# 各族验收必需的 verdict 通道（由确定性检查器节点 provides）
ACCEPT_FIELDS = {
    "code": ("test_verdict",),
    "translate": ("roundtrip_verdict",),
    "math": ("math_verdict",),
}

_ALIASES = {"python": "code", "program": "code", "代码": "code",
            "翻译": "translate", "english": "translate",
            "方程": "math", "数学": "math", "equation": "math"}


def strip_fences(code: str) -> str:
    """去掉 LLM 常见的 ```python ... ``` 围栏。"""
    m = re.search(r"```(?:python|py)?\s*\n(.*?)\n```", code, re.S)
    return m.group(1).strip() if m else code


def run_spec_tests(module_path: str, asserts: list[str], workdir: str,
                   timeout_s: int = 20) -> tuple[bool, str]:
    """把规格断言跑在给定模块文件上（真实 subprocess）。返回 (passed, report)。"""
    if not os.path.exists(module_path):
        return False, "module file missing"
    runner = os.path.join(workdir, "_run_spec.py")
    src = (
        "import importlib.util\n"
        "spec = importlib.util.spec_from_file_location('m', r'%s')\n"
        "m = importlib.util.module_from_spec(spec)\n"
        "spec.loader.exec_module(m)\n"
        "%s\n"
        "print('ALL_TESTS_PASS')\n"
        % (module_path.replace("\\", "\\\\"), "\n".join(asserts or []))
    )
    try:
        os.makedirs(workdir, exist_ok=True)
        with open(runner, "w", encoding="utf-8") as f:
            f.write(src)
        r = subprocess.run([sys.executable, runner], capture_output=True,
                           text=True, timeout=timeout_s, cwd=workdir)
        report = (r.stdout or "") + (r.stderr or "")
        return "ALL_TESTS_PASS" in (r.stdout or ""), report[-1200:]
    except Exception as e:  # noqa: BLE001
        return False, f"<RUNNER ERROR {type(e).__name__}: {e}>"
    finally:
        for p in (runner,):
            if os.path.exists(p):
                os.remove(p)


def _cjk_chars(text: str) -> set[str]:
    return {ch for ch in text
            if unicodedata.category(ch).startswith("L") and ord(ch) > 0x2E80}


def roundtrip_overlap(source: str, back: str) -> float:
    """回译与原文的 CJK 字符集重合率（忽略标点/拉丁/空白）。"""
    s, b = _cjk_chars(source), _cjk_chars(back)
    if not s:
        return 0.0
    return len(s & b) / len(s)


def math_verify(spec: dict, answer: str) -> bool:
    """数值代入：从答案提取 x 值，代回 a·x±b=c 验证。"""
    a, op = float(spec.get("a", 0)), spec.get("op", "+")
    b, c = float(spec.get("b", 0)), float(spec.get("c", 0))
    m = re.search(r"(?<!\d)x\s*=\s*([-+]?\d+(?:\.\d+)?)", answer or "")
    if not m:
        return False
    x = float(m.group(1))
    lhs = a * x + b if op == "+" else a * x - b
    return abs(lhs - c) < 0.01


def hash_anchor(text: str) -> tuple[float, ...]:
    """16 维字符直方图锚点（离线确定性；真嵌入可换 embedding 适配器）。"""
    v = [0.0] * 16
    for ch in text:
        v[ord(ch) % 16] += 1.0
    n = sum(v) or 1.0
    return tuple(x / n for x in v)


def accept(state: dict) -> bool:
    """复合验收（强信号）：内容通道 + verdict 通道 + 落盘产物，全部从磁盘重验。"""
    fam = state.get("family")
    spec = state.get("spec") or {}
    workdir = state.get("workdir", ".")
    if fam == "code":
        if state.get("test_verdict") != "pass":
            return False
        path = state.get("path")
        log = spec.get("log")
        if not path or not log:
            return False
        log_path = log if os.path.isabs(log) else os.path.join(workdir, log)
        if not os.path.exists(log_path) or "ALL_TESTS_PASS" not in _read(log_path):
            return False  # 验证日志必须由 run_tests 真实落盘
        passed, _ = run_spec_tests(path, spec.get("tests", []), workdir)
        return passed  # 对磁盘产物重跑规格测试（状态字段无法伪造）
    if fam == "translate":
        if not (state.get("translated") or "").strip():
            return False
        return state.get("roundtrip_verdict") == "pass"
    if fam == "math":
        if state.get("math_verdict") != "pass":
            return False
        return math_verify(spec, state.get("math_answer") or "")
    return False


def _read(path: str) -> str:
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:  # noqa: BLE001
        return ""


# ---------------- 训练 / held-out 规格 ----------------

TRAIN_TASKS: list[dict] = [
    {"type": "code", "file": "gcd.py", "log": "gcd.tests.log",
     "desc": "写一个 Python 模块 gcd.py：实现 gcd(a, b) 返回 a 与 b 的最大公约数",
     "spec": {"log": "gcd.tests.log",
              "tests": ["assert m.gcd(12, 18) == 6",
                        "assert m.gcd(7, 13) == 1",
                        "assert m.gcd(0, 5) == 5"]}},
    {"type": "code", "file": "count_chars.py", "log": "count_chars.tests.log",
     "desc": "写一个 Python 模块 count_chars.py：实现 count_chars(s) 返回每个字符出现次数的字典",
     "spec": {"log": "count_chars.tests.log",
              "tests": ["assert m.count_chars('aab') == {'a': 2, 'b': 1}",
                        "assert m.count_chars('') == {}"]}},
    {"type": "code", "file": "fib.py", "log": "fib.tests.log",
     "desc": "写一个 Python 模块 fib.py：实现 fib(n) 返回第 n 个斐波那契数（fib(0)=0, fib(1)=1）",
     "spec": {"log": "fib.tests.log",
              "tests": ["assert m.fib(0) == 0", "assert m.fib(1) == 1",
                        "assert m.fib(7) == 13"]}},
    {"type": "translate", "file": "t1.txt",
     "desc": "把这句话翻译成英文：今天天气很好，我们去公园散步吧",
     "spec": {"source": "今天天气很好，我们去公园散步吧", "min_overlap": 0.5}},
    {"type": "translate", "file": "t2.txt",
     "desc": "把这句话翻译成英文：知识就是力量",
     "spec": {"source": "知识就是力量", "min_overlap": 0.5}},
    {"type": "math", "file": "m1.txt",
     "desc": "解方程 2x + 5 = 17，给出步骤",
     "spec": {"a": 2, "op": "+", "b": 5, "c": 17, "x": 6}},
    {"type": "math", "file": "m2.txt",
     "desc": "解方程 3x - 7 = 8，给出步骤",
     "spec": {"a": 3, "op": "-", "b": 7, "c": 8, "x": 5}},
]

EVAL_TASKS: list[dict] = [
    {"type": "code", "file": "is_prime.py", "log": "is_prime.tests.log",
     "desc": "写一个 Python 模块 is_prime.py：实现 is_prime(n) 判断 n 是否为素数",
     "spec": {"log": "is_prime.tests.log",
              "tests": ["assert m.is_prime(7)", "assert not m.is_prime(9)",
                        "assert m.is_prime(2)", "assert not m.is_prime(1)"]}},
    {"type": "translate", "file": "t3.txt",
     "desc": "把这句话翻译成英文：他每天都坚持跑步",
     "spec": {"source": "他每天都坚持跑步", "min_overlap": 0.5}},
    {"type": "math", "file": "m3.txt",
     "desc": "解方程 5x + 3 = 28，给出步骤",
     "spec": {"a": 5, "op": "+", "b": 3, "c": 28, "x": 5}},
]

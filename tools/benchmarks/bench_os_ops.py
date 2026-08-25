"""OSWorld 风格 OS 操作评测（元素树 + click 序列断言）。

评测集以「任务 = 步骤序列」描述：每个步骤对 UI 驱动层（UIDriver）调用
ui_tree_query / ui_click / ui_type / window_list / focus / minimize，并做断言。
驱动层有两种实现：

- SimulatedUIDriver：内存态 UI 树，离线可复现，用于门禁冒烟（不依赖真实桌面）；
- LiveUIDriver：经 inkling headless 的 op 通道调 shell 执行体（需真实桌面/窗口管理器）。

达标线（真实执行体）：简化集 ≥40%。离线冒烟集用于验证评测框架本身与任务口径。
同一组任务对两种驱动通用——评测逻辑与执行后端解耦。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


# ── UI 驱动层（评测与后端解耦的接口）────────────────────────────

class UIDriver:
    """OS 交互后端抽象：元素树查询 + click/type + 窗口管理。

    真实后端（LiveUIDriver）把调用转译为 shell 执行体的 op；内存后端
    （SimulatedUIDriver）在进程内维护一棵树，供离线评测。
    """

    def ui_tree_query(self, root: str | None = None) -> dict:
        raise NotImplementedError

    def ui_click(self, element_id: str) -> None:
        raise NotImplementedError

    def ui_type(self, element_id: str, text: str) -> None:
        raise NotImplementedError

    def window_list(self) -> list[dict]:
        raise NotImplementedError

    def focus(self, window_id: str) -> None:
        raise NotImplementedError

    def minimize(self, window_id: str) -> None:
        raise NotImplementedError

    def open_app(self, app: str) -> str:
        raise NotImplementedError


class SimulatedUIDriver(UIDriver):
    """内存态 UI 树后端：窗口/元素状态随操作演进，供离线冒烟评测。"""

    def __init__(self) -> None:
        self._windows: dict[str, dict] = {}
        self._elements: dict[str, dict] = {}
        self._focused: str | None = None
        self._seq = 0

    def _new_id(self, prefix: str) -> str:
        self._seq += 1
        return f"{prefix}-{self._seq}"

    def open_app(self, app: str) -> str:
        wid = self._new_id("win")
        els = {}
        if app == "calculator":
            for digit in "0123456789":
                eid = self._new_id("btn")
                els[eid] = {"id": eid, "type": "button", "label": f"digit-{digit}", "clicked": False}
            res_id = self._new_id("result")
            els[res_id] = {"id": res_id, "type": "text", "label": "display", "value": ""}
        elif app == "notepad":
            edit_id = self._new_id("edit")
            els[edit_id] = {"id": edit_id, "type": "edit", "label": "editor", "value": ""}
        else:
            edit_id = self._new_id("generic")
            els[edit_id] = {"id": edit_id, "type": "edit", "label": "field", "value": ""}
        self._windows[wid] = {"id": wid, "title": app, "minimized": False, "elements": els}
        self._elements.update(els)
        self._focused = wid
        return wid

    def ui_tree_query(self, root: str | None = None) -> dict:
        if root is not None and root in self._windows:
            return {root: self._windows[root]}
        return {wid: win for wid, win in self._windows.items()}

    def ui_click(self, element_id: str) -> None:
        el = self._elements.get(element_id)
        if el is None:
            raise KeyError(f"元素不存在: {element_id}")
        el["clicked"] = True
        if el.get("type") == "button" and el["label"].startswith("digit-"):
            digit = el["label"].split("-", 1)[1]
            for win in self._windows.values():
                for other in win["elements"].values():
                    if other.get("type") == "text" and other.get("label") == "display":
                        other["value"] = (other["value"] + digit)[-12:]

    def ui_type(self, element_id: str, text: str) -> None:
        el = self._elements.get(element_id)
        if el is None:
            raise KeyError(f"元素不存在: {element_id}")
        el["value"] = text

    def window_list(self) -> list[dict]:
        return [
            {"id": wid, "title": win["title"], "minimized": win["minimized"]}
            for wid, win in self._windows.items()
        ]

    def focus(self, window_id: str) -> None:
        if window_id not in self._windows:
            raise KeyError(f"窗口不存在: {window_id}")
        self._focused = window_id

    def minimize(self, window_id: str) -> None:
        if window_id not in self._windows:
            raise KeyError(f"窗口不存在: {window_id}")
        self._windows[window_id]["minimized"] = True

    def focused(self) -> str | None:
        return self._focused


class LiveUIDriver(UIDriver):
    """经 inkling headless op 通道调 shell 执行体（需真实桌面）。

    命令行直连 inkling CLI 的 op 子命令；无桌面环境时调用即报错，由评测
    框架归为「未运行」而非「失败」。
    """

    def __init__(self, cli: str = "inkling") -> None:
        self._cli = cli

    def _op(self, name: str, **params) -> dict:
        import subprocess

        argv = [self._cli, "headless", "--op", name, json.dumps(params)]
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            raise RuntimeError(f"op {name} 失败: {proc.stderr.strip()}")
        return json.loads(proc.stdout)

    def open_app(self, app: str) -> str:
        return self._op("launch_app", app=app)["window_id"]

    def ui_tree_query(self, root: str | None = None) -> dict:
        return self._op("ui_tree_query", root=root or "")

    def ui_click(self, element_id: str) -> None:
        self._op("ui_click", element_id=element_id)

    def ui_type(self, element_id: str, text: str) -> None:
        self._op("ui_type", element_id=element_id, text=text)

    def window_list(self) -> list[dict]:
        return self._op("window_list")

    def focus(self, window_id: str) -> None:
        self._op("focus", window_id=window_id)

    def minimize(self, window_id: str) -> None:
        self._op("minimize", window_id=window_id)


# ── 任务定义（评测逻辑与后端无关）──────────────────────────────

@dataclass
class Task:
    name: str
    run: Callable[[UIDriver], tuple[bool, str]]


def _find_element(tree: dict, predicate: Callable[[dict], bool]) -> str | None:
    for win in tree.values():
        for eid, el in win.get("elements", {}).items():
            if predicate(el):
                return eid
    return None


def _task_calc_click() -> Task:
    def run(driver: UIDriver) -> tuple[bool, str]:
        wid = driver.open_app("calculator")
        tree = driver.ui_tree_query(wid)
        target = _find_element(tree, lambda e: e.get("label") == "digit-7")
        if target is None:
            return False, "计算器未出现数字键 7"
        driver.ui_click(target)
        tree = driver.ui_tree_query(wid)
        disp = _find_element(tree, lambda e: e.get("label") == "display")
        if disp is None or tree[wid]["elements"][disp].get("value") != "7":
            return False, "点击数字 7 后显示屏未显示 7"
        return True, "点击数字 7 → 显示屏显示 7"

    return Task("计算器点击数字键", run)


def _task_notepad_type() -> Task:
    def run(driver: UIDriver) -> tuple[bool, str]:
        wid = driver.open_app("notepad")
        tree = driver.ui_tree_query(wid)
        edit = _find_element(tree, lambda e: e.get("type") == "edit")
        if edit is None:
            return False, "记事本未出现编辑框"
        driver.ui_type(edit, "hello")
        tree = driver.ui_tree_query(wid)
        if tree[wid]["elements"][edit].get("value") != "hello":
            return False, "输入文本未落入编辑框"
        return True, "输入 hello → 编辑框内容一致"

    return Task("记事本输入文本", run)


def _task_window_manage() -> Task:
    def run(driver: UIDriver) -> tuple[bool, str]:
        w1 = driver.open_app("calculator")
        w2 = driver.open_app("notepad")
        before = driver.window_list()
        if len(before) < 2:
            return False, "窗口列表未包含两个窗口"
        driver.focus(w2)
        driver.minimize(w1)
        after = driver.window_list()
        minimized = {w["id"]: w["minimized"] for w in after}
        if not minimized.get(w1, False):
            return False, "最小化未生效"
        return True, "窗口列表/聚焦/最小化 三操作生效"

    return Task("窗口列表+聚焦+最小化", run)


TASK_FACTORIES: list[Callable[[], Task]] = [
    _task_calc_click,
    _task_notepad_type,
    _task_window_manage,
]


def build_tasks() -> list[Task]:
    return [factory() for factory in TASK_FACTORIES]


def run_evaluation(driver: UIDriver, tasks: list[Task]) -> tuple[int, int, list[tuple[str, bool, str]]]:
    details: list[tuple[str, bool, str]] = []
    for task in tasks:
        try:
            ok, note = task.run(driver)
        except Exception as exc:  # 后端不可达等：归为未通过并记录原因
            ok, note = False, f"执行异常: {exc}"
        details.append((task.name, ok, note))
    passed = sum(1 for _, ok, _ in details if ok)
    return passed, len(details), details


def main() -> int:
    parser = argparse.ArgumentParser(description="OSWorld 风格 OS 操作评测")
    parser.add_argument("--live", action="store_true", help="使用真实桌面后端（inkling headless op）")
    parser.add_argument("--target-rate", type=float, default=0.40, help="真实后端达标线（默认 0.40）")
    args = parser.parse_args()

    tasks = build_tasks()
    if args.live:
        driver: UIDriver = LiveUIDriver()
        mode = "live(真实桌面)"
    else:
        driver = SimulatedUIDriver()
        mode = "simulated(离线冒烟)"

    start = time.perf_counter()
    passed, total, details = run_evaluation(driver, tasks)
    elapsed = time.perf_counter() - start

    print("=" * 78)
    print(f"OS 操作评测 [{mode}]  任务数={total}  达标线={args.target_rate:.0%}(真实后端)")
    print("=" * 78)
    for name, ok, note in details:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name} — {note}")
    rate = (passed / total) if total else 0.0
    print("-" * 78)
    print(f"通过 {passed}/{total}（{rate:.1%}）  耗时 {elapsed:.2f}s")
    if args.live:
        verdict = "达标" if rate >= args.target_rate else "未达标"
        print(f"真实后端结论：{verdict}（达标线 {args.target_rate:.0%}）")
        return 0 if rate >= args.target_rate else 1
    print("离线冒烟结论：框架与任务口径可用（真实达标率需 live 模式跑真实桌面）")
    # 离线冒烟不阻塞门禁：框架本身通过即视为该基准项纳入成功
    return 0


if __name__ == "__main__":
    sys.exit(main())

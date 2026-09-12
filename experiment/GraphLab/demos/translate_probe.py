"""translate_probe.py - translate 族诊断探针（真实 API）。

背景：hard 六臂实验 translate 全灭（所有臂 0/4，含人工链）。观测日志证据：
  1. 全实验 backtranslate 调用次数 = 0（translate 节点从未被调）；
  2. classify 节点缺专属提示词（落 generic「直接回答任务」），翻译任务的输出是
     纯英文译文、不含族 token -> family=None -> 选链前死路；
  3. 潜伏缺陷：backtranslate 也无专属提示词，即使族修好也会把英文回成英文。

本探针验证修复（llm_adapter.ROLE_PROMPTS 新增 classify/backtranslate）：
  pass A：新提示词 classify -> translate -> backtranslate -> roundtrip_check
  pass B：对照（backtranslate 恢复 generic 提示词），预期 CJK 重合率 ~0
输出：每任务的 family / 译文 / 回译 / 重合率 / 阈值扫描 / verdict。

Usage:
  python experiment/GraphLab/demos/translate_probe.py
"""

from __future__ import annotations

import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import hard_demo as H  # noqa: E402   (导入即注入 sys.path / API / 契约表)


def pick_tasks():
    tasks = [t for t in H.C.TRAIN_TASKS if t["type"] == "translate"]
    tasks += [t for t in H.C.EVAL_TASKS if t["type"] == "translate"]
    return tasks


def run_chain(g, state, nids):
    return H.run_sequence(g, state, nids)


def probe_pass(name: str, tasks: list[dict], old_backtranslate: bool) -> None:
    H.reset_instances()
    H.CALLS["n"] = 0
    g = H.build_graph(0, "probe")
    if old_backtranslate:
        H.llm_instances["backtranslate"].set_prompt(
            "你是图中的通用回答节点。如果当前状态已有产出（代码/章节等），"
            "改进它；否则直接回答用户任务。只输出结果本身，不要解释。")
    print(f"\n===== pass: {name} ({'旧 generic backtranslate 提示词' if old_backtranslate
          else '新 backtranslate 提示词'}) =====")
    for t in tasks:
        state = H.initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = H.CALLS["n"]
        s0, _ = run_chain(g, state, ["classify"])
        if s0 is None:
            print(f"  [{t['file']}] classify FAILED")
            continue
        fam = s0.get("family")
        s1, run = run_chain(g, s0, ["translate", "backtranslate", "roundtrip_check"])
        calls = H.CALLS["n"] - c0
        src = t["spec"]["source"]
        if s1 is None:
            print(f"  [{t['file']}] family={fam}  chain FAILED (ran: {run}) calls={calls}")
            continue
        back = s1.get("backtranslated") or ""
        ov = H.C.roundtrip_overlap(src, back)
        ths = {th: ov >= th for th in (0.3, 0.4, 0.5, 0.6)}
        print(f"  [{t['file']}] family={fam} overlap={ov:.3f} "
              f"verdict={s1.get('roundtrip_verdict')} calls={calls}")
        print(f"      pass@{ths}")
        print(f"      classify     : {str(s0.get('_out'))[:70]!r}")
        print(f"      translated   : {str(s1.get('translated'))[:70]!r}")
        print(f"      backtranslated: {back[:70]!r}")


def main() -> None:
    tasks = pick_tasks()
    print(f"translate tasks: {[t['file'] for t in tasks]}")
    probe_pass("A 修复后（新提示词）", tasks, old_backtranslate=False)
    probe_pass("B 对照（旧 generic backtranslate）", tasks, old_backtranslate=True)


if __name__ == "__main__":
    main()

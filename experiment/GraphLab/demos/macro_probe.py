"""macro_probe.py - 宏检索锚点对照（hash 字符直方图 vs embed 语义向量）。

背景：095555 六臂中 skills_macro_only held-out 2/3——hash_anchor（16 维字符
直方图）对未见任务描述匹配失败 1 个 held-out 任务。本探针用同一 teacher 宏
（FULL_CHAIN 直构，每族 1 条）在 EVAL_TASKS 上做 hash vs embed 双模式对照，
输出每任务的余弦相似度与命中/通过明细。

Usage:
  python experiment/GraphLab/demos/macro_probe.py
"""

from __future__ import annotations

import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import hard_demo as H  # noqa: E402
from skills import cosine  # noqa: E402


def build_lib() -> H.MacroLibrary:
    lib = H.MacroLibrary(threshold=0.6, log_fn=H.log_event)
    for fam, chain in H.FULL_CHAIN.items():
        first = next(t for t in H.C.TRAIN_TASKS if t["type"] == fam)
        lib.add_or_replace(H.SkillMacro(fam, chain, H.anchor_fn(first["desc"]),
                                        1, 0))
    return lib


def probe_mode(mode: str) -> None:
    H.reset_instances()
    H.CALLS["n"] = 0
    H.ANCHOR = mode
    lib = build_lib()
    print(f"\n===== anchor={mode} "
          f"(宏锚点={[f'{m}:dim{len(m.anchor)}' for m in lib.macros.values()]}) =====")
    for t in H.C.EVAL_TASKS:
        state = H.initial_state(t)
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = H.CALLS["n"]
        g = H.build_graph(0, "macro_probe")
        s0, run0 = H.run_sequence(g, state, ["classify"])
        fam = s0.get("family") if s0 is not None else None
        q = H.anchor_fn(t["desc"])
        m = lib.match(fam, q) if fam else None
        ma = lib.macros.get(fam) if fam else None
        sim = cosine(q, ma.anchor) if ma else None
        sim_s = f"{sim:.3f}" if sim is not None else "n/a"
        if m is not None:
            s1, run1 = H.run_sequence(g, s0, m.path)
            ok = bool(s1 is not None and s1.get("ok"))
            path = "->".join(run0 + run1)
        else:
            ok, path = False, "->".join(run0) + f" (NO MATCH sim={sim_s})"
        print(f"  [{t['file']}] family={fam} sim={sim_s} hit={m is not None} "
              f"ok={ok} calls={H.CALLS['n'] - c0}")
        print(f"      {path}")


def main() -> None:
    if not os.environ.get("LLM_EMBED_KEY"):
        os.environ.setdefault("LLM_EMBED_KEY", H.PROVIDERS[1]["api_key"])
    print(f"embed provider: {H.PROVIDERS[1]['name']} / "
          f"{os.environ['LLM_EMBED_KEY'][:6]}...")
    probe_mode("hash")
    probe_mode("embed")


if __name__ == "__main__":
    main()

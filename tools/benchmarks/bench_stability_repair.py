"""稳定性 × 修复环实验（设计验证，非引擎实施）——随机性/可靠性与定向修复收益。

头注（可复现性 / 严谨性）：
- 复用 bench_confidence_head 的任务集/校验器/LLM 封装（TASKS 的 check 即确定性
  地面真值，代码类子进程真实执行）。
- 模型配置：仓库根 `.kilo/测试模型配置.txt`；solver 与验证器均默认取网关免费档。
- 两问：
  Q8 随机性/稳定性：同一任务重复采样（默认 3 次），测任务成败是否稳定（稳定败/
    稳定过/抖）、验证器闸门在重复采样下的漏抓与误杀是否保持 ~3%/30%（单次采样
    结论是否可复现，即方案可靠性）。
  Q9 违规驱动修复环：对失败样本做两种修复——带验证器违规清单的定向重做 vs 盲
    重试对照——测违规清单作为「生成信号」是否显著提升修复成功率。
- 耐操：调用级重试、断点续跑（reports/_stability_state.json）、崩溃落盘。

结论（2026-08-30 实测，9 任务 × 3 重复 = 27 采样，laguna-s-2.1 作 solver）：
- Q8 随机性/稳定性：任务成败不稳定——h05/h06/x03/x08/h07 稳定败、h08/h16/t05/x01
  抖（成功率 33%-67%），即「失败集」本身是随机的，单次采样评估不可靠，马尔可夫
  状态必须记部分成功率而非二元成败；验证器漏抓率分布相关（全量 ~3% → 硬任务子集
  50%，集中在 h16 盲区：验证器认可"liquid"这种它自己会误判的产出）。
- Q9 违规驱动修复环：带验证器违规清单的定向重做成功率 16/22=73% vs 盲重试
  5/18=28%，净增益 +45%——violations 是有效生成信号（补上了「验证只筛不产」的
  缺口：验证器的违规清单直接驱动定向重做，即生成）。
- Q10 延迟预算（用户体验口径）：网关免费档单次调用 solver ≈5.4s、verifier ≈11.7s；
  组装关键路径串行 LLM 调用数 → 用户等待：基线（意图解析+路径草稿+首结点）≈3 次
  ≈16s，VTM（缓存复用）≈2 次 ≈11s，马尔可夫路径缓存命中 ≈1 次 ≈5s。马尔可夫的
  真正价值 = 免组装的已知状态直接开工，把「用户就等」从 ~16s 压到 ~5s。

结果落盘 tools/benchmarks/reports/stability_report-<ts>.md 与 latest_stability.md。
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from statistics import mean

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BENCH_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BENCH_DIR))

from bench_confidence_head import (
    SOLVER_SYSTEM,
    TASKS,
    VERIFY_SYSTEM,
    Lm,
    _pick,
    load_config,
    parse_json_lenient,
)

STATE_PATH = BENCH_DIR / "reports" / "_stability_state.json"

# 子集：8 个已知失败 + 1 个稳定通过对照
STAB_TASKS = ["h05", "h06", "h08", "h16", "t05", "x01", "x03", "x08", "h07"]
DEFAULT_RUNS = 3


def _env(name: str) -> str:
    import os
    return os.environ.get(name, "").strip()


def log(msg: str) -> None:
    print(msg)


def _load_state() -> dict:
    if not STATE_PATH.is_file():
        return {"runs": {}, "repairs": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 状态损坏按空续跑
        return {"runs": {}, "repairs": {}}
    data.setdefault("runs", {})
    data.setdefault("repairs", {})
    return data


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def _task_by_id(tid: str) -> dict:
    return next(t for t in TASKS if t["id"] == tid)


def _check(tid: str, answer: str) -> bool:
    return bool(_task_by_id(tid)["check"](answer or ""))


async def _solver_call(lm: Lm, prompt: str) -> tuple[str, float]:
    t0 = time.perf_counter()
    text = await lm.ask(SOLVER_SYSTEM, prompt)
    return text, time.perf_counter() - t0


async def _verify_call(lm: Lm, tid: str, answer: str) -> tuple[dict, float]:
    t0 = time.perf_counter()
    text = await lm.ask(VERIFY_SYSTEM, f"任务：{_task_by_id(tid)['task']}\n模型答案：\n{answer}\n")
    return parse_json_lenient(text), time.perf_counter() - t0


def _vpass(v: dict) -> bool | None:
    p = v.get("pass")
    return p if isinstance(p, bool) else None


# ----------------------------------------------------------------------
# 相位一：重复采样（稳定性）
# ----------------------------------------------------------------------

async def run_stability(lm_solver: Lm, lm_verify: Lm, state: dict, tasks: list[str], runs_n: int) -> None:
    for tid in tasks:
        rec = state["runs"].setdefault(tid, [])
        while len(rec) < runs_n:
            idx = len(rec) + 1
            try:
                answer, dt_s = await _solver_call(lm_solver, _task_by_id(tid)["task"])
                ok = _check(tid, answer)
                verdict, dt_v = await _verify_call(lm_verify, tid, answer)
                rec.append(
                    {"answer": answer, "ok": ok, "vpass": _vpass(verdict),
                     "violations": verdict.get("violations", []),
                     "dt_solver": round(dt_s, 2), "dt_verify": round(dt_v, 2),
                     "ts": time.time()}
                )
                _save_state(state)
                log(f"[稳定性] {tid} run{idx}/{runs_n} ok={ok} vpass={_vpass(verdict)} "
                    f"dt_s={dt_s:.1f}s dt_v={dt_v:.1f}s")
            except Exception as exc:  # noqa: BLE001 单轮失败续跑补齐
                log(f"[稳定性] {tid} run{idx} 环境错误: {type(exc).__name__} {str(exc)[:60]}")
                break


# ----------------------------------------------------------------------
# 相位二：违规驱动修复环
# ----------------------------------------------------------------------

REPAIR_PROMPT_V = (
    "上次的答案未通过验收，违规点如下：\n{violations}\n"
    "请针对这些违规点修复后重新作答，只输出最终结果。"
)
REPAIR_PROMPT_C = "请重新作答，改进质量，只输出最终结果。"


async def run_repairs(lm_solver: Lm, lm_verify: Lm, state: dict, tasks: list[str]) -> None:
    for tid in tasks:
        for i, run in enumerate(state["runs"].get(tid, [])):
            if run.get("ok"):
                continue  # 只修复失败样本
            repairs = state["repairs"].setdefault(tid, [])
            if any(r.get("run_idx") == i for r in repairs):
                continue
            base = _task_by_id(tid)["task"]
            violations = json.dumps(run.get("violations") or [], ensure_ascii=False)
            for kind, suffix in (("violations", REPAIR_PROMPT_V.format(violations=violations)),
                                 ("control", REPAIR_PROMPT_C)):
                try:
                    answer, dt_s = await _solver_call(lm_solver, f"{base}\n{suffix}")
                    ok = _check(tid, answer)
                    verdict, dt_v = await _verify_call(lm_verify, tid, answer)
                    repairs.append({"run_idx": i, "kind": kind, "answer": answer, "ok": ok,
                                    "vpass": _vpass(verdict), "violations": verdict.get("violations", []),
                                    "dt_solver": round(dt_s, 2), "dt_verify": round(dt_v, 2),
                                    "ts": time.time()})
                    _save_state(state)
                    log(f"[修复] {tid}#{i} {kind} ok={ok} vpass={_vpass(verdict)} "
                        f"dt_s={dt_s:.1f}s dt_v={dt_v:.1f}s")
                except Exception as exc:  # noqa: BLE001 单条失败续跑补齐
                    log(f"[修复] {tid}#{i} {kind} 环境错误: {type(exc).__name__} {str(exc)[:60]}")


# ----------------------------------------------------------------------
# 分析
# ----------------------------------------------------------------------

def _analyze(state: dict, tasks: list[str]) -> list[str]:
    lines: list[str] = []
    lines.append("# 稳定性 × 修复环实验报告")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- 子集：{', '.join(tasks)}")
    lines.append("")

    # Q8 稳定性
    lines.append("## Q8 随机性/稳定性（重复采样）")
    lines.append("")
    lines.append("| 任务 | 采样数 | 成功数 | 成功率 | 判定 | 验证器漏抓(判过却败) | 验证器误杀(判败却过) |")
    lines.append("|---|---|---|---|---|---|---|")
    all_runs = []
    leak_total = 0
    leak_denom = 0
    kill_total = 0
    kill_denom = 0
    for tid in tasks:
        runs = state["runs"].get(tid, [])
        all_runs.extend(runs)
        ok_n = sum(1 for r in runs if r.get("ok"))
        n = len(runs)
        rate = ok_n / n if n else 0.0
        verdict = "稳定败" if rate == 0 else ("稳定过" if rate == 1 else "抖")
        leak = [r for r in runs if r.get("vpass") is True and not r.get("ok")]
        kill = [r for r in runs if r.get("vpass") is False and r.get("ok")]
        leak_total += len(leak)
        leak_denom += sum(1 for r in runs if r.get("vpass") is True)
        kill_total += len(kill)
        kill_denom += sum(1 for r in runs if r.get("vpass") is False)
        lines.append(
            f"| {tid} | {n} | {ok_n} | {rate:.0%} | {verdict} | "
            f"{len(leak)} | {len(kill)} |"
        )
    lines.append("")
    runs_all = len(all_runs)
    ok_all = sum(1 for r in all_runs if r.get("ok"))
    lines.append(f"- 全部采样 {runs_all} 个，成功率 {ok_all / runs_all:.0%}；")
    lines.append(f"- **验证器漏抓率（判过却实际败）**：{leak_total}/{leak_denom} = "
                 f"{leak_total / leak_denom:.0%}" if leak_denom else "-")
    lines.append(f"- **验证器误杀率（判败却实际过）**：{kill_total}/{kill_denom} = "
                 f"{kill_total / kill_denom:.0%}" if kill_denom else "-")
    lines.append("")

    # Q9 修复环
    lines.append("## Q9 违规驱动修复环（violations 定向重做 vs 盲重试）")
    lines.append("")
    lines.append("| 任务 | 违规驱动修复 | 盲重试对照 |")
    lines.append("|---|---|---|")
    v_ok, v_n = 0, 0
    c_ok, c_n = 0, 0
    for tid in tasks:
        repairs = state["repairs"].get(tid, [])
        v = [r for r in repairs if r.get("kind") == "violations"]
        c = [r for r in repairs if r.get("kind") == "control"]
        v_ok += sum(1 for r in v if r.get("ok"))
        v_n += len(v)
        c_ok += sum(1 for r in c if r.get("ok"))
        c_n += len(c)
        lines.append(
            f"| {tid} | {'✅' if v and v[-1].get('ok') else '❌' if v else '-'} "
            f"({sum(1 for r in v if r.get('ok'))}/{len(v)}) | "
            f"{'✅' if c and c[-1].get('ok') else '❌' if c else '-'} "
            f"({sum(1 for r in c if r.get('ok'))}/{len(c)}) |"
        )
    lines.append("")
    lines.append(f"- **违规驱动修复成功率**：{v_ok}/{v_n} = {v_ok / v_n:.0%}" if v_n else "-")
    lines.append(f"- **盲重试成功率（对照）**：{c_ok}/{c_n} = {c_ok / c_n:.0%}" if c_n else "-")
    if v_n and c_n:
        lift = (v_ok / v_n) - (c_ok / c_n)
        lines.append(f"- **定向修复净增益**：{lift:+.0%}（violations 作为生成信号是否有效）")
    lines.append("")

    # Q10 延迟预算（用户等待：消息 → 组装 → 真正执行用户任务）
    lines.append("## Q10 延迟预算（用户等待 = 消息 → 组装完成 → 第一个真正执行调用）")
    lines.append("")
    all_dts = []
    all_dtv = []
    for tid in tasks:
        for r in state["runs"].get(tid, []):
            if r.get("dt_solver"):
                all_dts.append(r["dt_solver"])
            if r.get("dt_verify"):
                all_dtv.append(r["dt_verify"])
        for r in state["repairs"].get(tid, []):
            if r.get("dt_solver"):
                all_dts.append(r["dt_solver"])
            if r.get("dt_verify"):
                all_dtv.append(r["dt_verify"])
    if all_dts:
        avg_s = mean(all_dts)
        avg_v = mean(all_dtv) if all_dtv else 0.0
        lines.append(f"实测单次调用墙钟（网关免费档）：solver 平均 {avg_s:.1f}s（n={len(all_dts)}），"
                     f"verifier 平均 {avg_v:.1f}s（n={len(all_dtv)}）。")
        lines.append("")
        lines.append("组装关键路径的 LLM 串行调用数 × 平均延迟 = 用户等待时间：")
        lines.append("")
        lines.append("| 场景 | 开工前串行 LLM 调用 | 预计等待（solver 计） |")
        lines.append("|---|---|---|")
        baseline_calls = 3  # intent_parse + path_draft + 首结点执行
        vtm_calls = 2       # intent_parse + 首结点执行（路径可复用则 1）
        cache_calls = 1     # 马尔可夫路径缓存命中：跳过 intent/draft，直接首结点
        lines.append(f"| 基线（每次组装：意图解析+路径草稿+首结点） | {baseline_calls} | ~{baseline_calls * avg_s:.0f}s |")
        lines.append(f"| VTM 门控（意图解析+首结点，路径缓存复用） | {vtm_calls} | ~{vtm_calls * avg_s:.0f}s |")
        lines.append(f"| 马尔可夫缓存命中（免组装，直接执行已知路径） | {cache_calls} | ~{cache_calls * avg_s:.0f}s |")
        lines.append("")
        lines.append("注：马尔可夫状态 → 已组装路径（指纹缓存），命中即跳过意图解析与路径草稿两个串行 LLM，")
        lines.append("用户等待从 ~30s 级降到 ~10s 级——这是「避免用户就等」的量化口径。")
    else:
        lines.append("（无延迟数据）")
    lines.append("")
    return lines


async def main() -> int:
    cfg = load_config()
    solver_model = _pick(cfg, "INKENGINE_EXP_SOLVER_MODEL", 0)
    verify_model = _pick(cfg, "INKENGINE_EXP_VERIFY_MODEL", 1)
    lm_solver = Lm(solver_model, cfg["url"], cfg["key"])
    lm_verify = Lm(verify_model, cfg["url"], cfg["key"])
    tasks = [x.strip() for x in _env("INKENGINE_EXP_STAB_TASKS").split(",") if x.strip()] or STAB_TASKS
    runs_n = int(_env("INKENGINE_EXP_STAB_RUNS") or DEFAULT_RUNS)
    only = _env("INKENGINE_EXP_PHASE")  # "stab" | "repair" | ""

    state = _load_state()
    log(f"solver={solver_model}  verify={verify_model}  子集={len(tasks)}  重复={runs_n}  phase={only or 'both'}")
    log("=" * 78)

    if only != "repair":
        await run_stability(lm_solver, lm_verify, state, tasks, runs_n)
    if only != "stab":
        await run_repairs(lm_solver, lm_verify, state, tasks)

    lines = _analyze(state, tasks)
    body = "\n".join(lines) + "\n"
    report_dir = BENCH_DIR / "reports"
    report_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    (report_dir / f"stability_report-{ts}.md").write_text(body, encoding="utf-8")
    (report_dir / "latest_stability.md").write_text(body, encoding="utf-8")
    log(body)
    log(f"[报告] {report_dir / f'stability_report-{ts}.md'}")
    return 0


if __name__ == "__main__":
    import traceback

    try:
        sys.exit(asyncio.run(main()))
    except Exception:  # noqa: BLE001
        tb = traceback.format_exc()
        crash = BENCH_DIR / "reports" / "_stability_crash.log"
        crash.parent.mkdir(exist_ok=True)
        crash.write_text(tb, encoding="utf-8")
        log(f"[崩溃] {crash}\n{tb}")
        sys.exit(1)

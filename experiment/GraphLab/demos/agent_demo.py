"""agent_demo.py - trainable agent engine prototype.

Two phases, mirroring foundation-model pretraining + user finetuning:

  Phase 1 (pretrain): a messy random graph is trained on a DIVERSE base task
    set (code / novel / article / translate / math). Result: a usable base
    graph, checkpointed to disk (like a pretrained model).
  Phase 2 (interact): the USER issues tasks through stdin; the graph thinks
    (internal rollouts), acts (routes through LLM collaborator nodes and
    self-grown tool nodes), and finetunes after every task (online).

Production-oriented properties:
  - workdir: every session gets a real working directory; grown tool nodes
    (save_file / list_dir / read_file / append_file) read and write it
  - NO tools initially: tool nodes GROW through structure evolution
  - LLM node params (prompts) are finetuned: low-quality used nodes get prompt
    mutation; unused/harmful nodes get discarded; new LLM nodes grow from
    mutated prompts (params come from mutation of existing prompts)
  - routing observes LLM node quality (bias field, updated from path outcomes)
  - collaborators / subagents ARE graph nodes (role-specialized LLM nodes)
  - every round: artifacts cleaned, observations logged, graph snapshot,
    prompt mutations audited, structure events audited

Usage:
  $env:LLM_BASE_URL="https://api.b.ai/v1"; $env:LLM_KEY="sk-..."; $env:LLM_MODEL="qwen3.8-flash"
  python experiment/GraphLab/demos/agent_demo.py --auto   # pretrain + 3 scripted user tasks
  python experiment/GraphLab/demos/agent_demo.py          # interactive mode
    user> task 写一个 Python 脚本，列出目录文件，保存到 list_dir.py
    user> stats | graph | log | save | exit
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()
from serialization import Serialization  # noqa: E402
from tool_adapter import ToolAdapter  # noqa: E402

from graph_engine import GraphEngine
from llm_adapter import LLMAdapter, ROLE_PROMPTS
from credit import CreditAssigner, clamp
from evolution import Evolution


CREDIT = CreditAssigner()
EVOLUTION = Evolution()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
API = (os.environ.get("LLM_BASE_URL", ""),
       os.environ.get("LLM_KEY", ""),
       os.environ.get("LLM_MODEL", "qwen3.8-flash"))

RUN_TS = time.strftime("%Y%m%d_%H%M%S")  # 每次运行独立归档，日志不互相覆盖
obs_log = os.path.join(OUT, f"agent_observations_{RUN_TS}.jsonl")
round_log = os.path.join(OUT, f"agent_rounds_{RUN_TS}.jsonl")
event_log = os.path.join(OUT, f"agent_events_{RUN_TS}.jsonl")
prompt_log = os.path.join(OUT, f"agent_prompts_{RUN_TS}.jsonl")
base_ckpt = os.path.join(OUT, "base_graph.json")   # 阶段 1 产物：基础图
final_ckpt = os.path.join(OUT, "final_graph.json")  # 阶段 2 产物：用户微调后图

MUTATIONS = ["", " 输出要简洁专业。", " 先列出要点再输出。",
             " 输出使用中文。", " 输出要完整详尽。", " 输出格式要清晰，使用标题。"]

ROLES = ["plan", "code", "chapter", "review", "polish", "article", "translate", "math"]

# 基础任务集（预训练用，控制规模：每任务 1 轮 × beam 2，整体 ~10 分钟）：
# (type, desc, filename)
BASE_TASKS = [
    ("code", "写一个 Python 计算器：实现 add/sub/mul/div 四个函数", "calc.py"),
    ("novel", "写一篇短篇小说《雾中灯塔》的第一章和第二章", "novel.txt"),
    ("article", "写一篇关于人工智能未来的短文", "article.txt"),
    ("translate", "把这句话翻译成英文：今天天气很好，我们去公园散步吧", "trans.txt"),
]


# ---------------- 观测 / 审计 ----------------



def obs_logger(nid, role, task, inp, out, secs, provider=""):
    Serialization.log_jsonl(obs_log, {"ts": round(time.time(), 3), "node": nid, "role": role,
                        "task": task, "input": inp, "output": out,
                        "secs": round(secs, 1), "provider": provider})


# ---------------- 任务域（真实用户场景） ----------------

def detect_task(desc: str) -> str:
    if any(k in desc for k in ("python", "代码", "程序", "脚本", ".py")):
        return "code"
    if any(k in desc for k in ("小说", "章节", "章")):
        return "novel"
    if any(k in desc for k in ("翻译", "英文")):
        return "translate"
    if any(k in desc for k in ("方程", "数学", "求解")):
        return "math"
    return "article"


def extract_filename(desc: str, workdir: str) -> str:
    m = re.search(r'[\w\-.]+\.(?:py|txt|md|json)', desc)
    if m:
        return os.path.join(workdir, m.group(0))
    return os.path.join(workdir, "output.txt")


def _exec_code_test(code: str, workdir: str, fns: list[str],
                    timeout_s: int = 15) -> bool:
    """生产域验收：代码任务真实执行 + 指定函数存在，不可被路由策略污染。"""
    import subprocess
    os.makedirs(workdir, exist_ok=True)
    test_file = os.path.join(workdir, "_accept_test.py")
    try:
        with open(test_file, "w", encoding="utf-8") as f:
            f.write(code)
        asserts = "\n".join(
            f"assert callable(m.{fn}), '{fn} not defined'" for fn in fns)
        test = (
            "import importlib.util\n"
            "spec = importlib.util.spec_from_file_location('acc', r'%s')\n"
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "%s\nprint('ACCEPT_OK')\n"
            % (test_file.replace("\\", "\\\\"), asserts))
        test_src = os.path.join(workdir, "_accept_runner.py")
        with open(test_src, "w", encoding="utf-8") as f:
            f.write(test)
        r = subprocess.run([sys.executable, test_src], capture_output=True,
                           text=True, timeout=timeout_s, cwd=workdir)
        return "ACCEPT_OK" in r.stdout
    except Exception:
        return False
    finally:
        for p in (test_file, os.path.join(workdir, "_accept_runner.py")):
            if os.path.exists(p):
                os.remove(p)


def accept(task_type: str, state: dict) -> bool:
    """验收标准（生产域规格：可执行检查优先，确定性检查兜底；spec 来自任务样本）。"""
    spec = state.get("spec") or {}
    if task_type == "code":
        c = state.get("code") or state.get("answer") or ""
        if len(c) < 30 or "def " not in c:
            return False
        return _exec_code_test(c, state.get("workdir", os.path.join(OUT, "workspace")),
                               spec.get("fns", ["add", "sub", "mul", "div"]))
    if task_type == "novel":
        ch = state.get("chapters", [])
        return len(ch) >= spec.get("chapters", 2) \
            and sum(len(x) for x in ch) > spec.get("min_chars", 200)
    if task_type == "article":
        c = state.get("article") or state.get("answer") or ""
        return len(c) > spec.get("min_chars", 150)
    if task_type == "translate":
        c = state.get("translated") or state.get("answer") or ""
        return len(c) > 10 and any(ch.isascii() and ch.isalpha() for ch in c)
    if task_type == "math":
        c = state.get("math_answer") or state.get("answer") or ""
        return len(c) > 10 and ("x" in c.lower() if spec.get("has_x", True) else True)
    return False


def initial_state(task_type: str, desc: str, workdir: str, spec: dict | None = None) -> dict:
    return {"payload": desc, "task": task_type,
            "workdir": workdir, "path": extract_filename(desc, workdir),
            "require_file": ("保存" in desc), "spec": spec or {},
            "chapters": [], "plan": None, "code": None, "review": None,
            "polished": None, "article": None, "translated": None,
            "math_answer": None}


# ---------------- 节点构造（LLM 实例可被微调） ----------------

llm_instances: dict[str, LLMAdapter] = {}

ROLE_FIELD = {"plan": "plan", "code": "code", "article": "article",
              "translate": "translated", "math": "math_answer",
              "review": "review", "polish": "polished"}


def make_llm(nid: str, role: str) -> LLMAdapter:
    inst = LLMAdapter(role=role, api=API, logger=obs_logger, nid=nid)
    llm_instances[nid] = inst
    return inst


def field_setter(inst: LLMAdapter, field: str):
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        return {**st, field: st["_out"]}  # _out = LLM 输出，payload 保持原始任务
    return fn


def chapter_fn(inst: LLMAdapter):
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        return {**st, "chapters": list(state.get("chapters", [])) + [st["_out"]]}
    return fn


def generic_llm(nid: str):
    inst = make_llm(nid, "generic")
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        return {**st, "answer": st["_out"]}
    return fn


# ---------------- 工具节点（初始不提供，演化生长） ----------------

def save_fn(state):
    content = state.get("polished") or state.get("code") or state.get("answer") or ""
    if not content:
        content = state.get("article") or state.get("translated") or state.get("math_answer") or ""
    if not content:
        content = "\n\n".join(state.get("chapters", []))
    if len(content) < 30:
        return None
    os.makedirs(state["workdir"], exist_ok=True)
    with open(state["path"], "w", encoding="utf-8") as f:
        f.write(content)
    return {**state, "saved": True}


def exit_fn(state):
    """验收门：内容合格 且（任务要求保存时）文件已落盘。"""
    ok = accept(state["task"], state)
    if ok and state.get("require_file"):
        ok = bool(state.get("saved")) or (os.path.exists(state["path"])
                                          and os.path.getsize(state["path"]) > 0)
    return {**state, "ok": ok}


def noise_fn(state):
    return None


def pass_fn(state):
    return dict(state)


FUNC_LIBRARY = {"save_file": save_fn, "append_file": ToolAdapter.append_fn,
                "list_dir": ToolAdapter.list_fn, "read_file": ToolAdapter.read_fn}


def build_graph(seed: int, workdir: str) -> GraphEngine:
    """混乱初始图：11 个 LLM 节点（3 通用串联 + 8 角色协作者）+ 噪声/中性干扰。
    没有工具节点 -- 工具靠结构演化长出来。"""
    g = GraphEngine(seed=seed)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", exit_fn, kind="exit")
    for role in ROLES:
        nid = role
        inst = make_llm(nid, role)
        fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
        g.add_node(nid, fn, kind="llm")
    for i in (1, 2, 3):  # 三个同 prompt 通用 LLM，串联（还原旧组装）
        g.add_node(f"llm_{i}", generic_llm(f"llm_{i}"), kind="llm")
    g.add_edge("llm_1", "llm_2", 2.0)
    g.add_edge("llm_2", "llm_3", 2.0)
    g.add_edge("llm_3", "exit", 1.0)
    # chapter 自环先验：多章任务需同一节点迭代访问
    g.add_edge("chapter", "chapter", 1.0)
    for i in (1, 2):
        g.add_node(f"noise_{i}", noise_fn, kind="noise")
        g.add_node(f"pass_{i}", pass_fn, kind="pass")
    g.randomize(p=0.25)
    return g


def mutate_prompt(prompt: str, rng: random.Random) -> str:
    return prompt + rng.choice(MUTATIONS)


def grow_node(graph: GraphEngine, rng: random.Random):
    """结构生长：LLM 节点（通用/角色，提示词来自变异）或工具节点。"""
    roll = rng.random()
    if roll < 0.5:
        n = 1
        while f"llm_g{n}" in graph.nodes:
            n += 1
        inst = make_llm(f"llm_g{n}", "generic")
        inst.set_prompt(mutate_prompt(inst.prompt, rng))
        Serialization.log_jsonl(prompt_log, {"event": "grow", "node": f"llm_g{n}",
                               "prompt": inst.prompt})
        return f"llm_g{n}", field_setter(inst, "answer"), "llm"
    if roll < 0.8:
        role = rng.choice(ROLES)
        n = 1
        while f"{role}_{n}" in graph.nodes:
            n += 1
        inst = make_llm(f"{role}_{n}", role)
        inst.set_prompt(mutate_prompt(inst.prompt, rng))
        Serialization.log_jsonl(prompt_log, {"event": "grow", "node": f"{role}_{n}",
                               "prompt": inst.prompt})
        fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
        return f"{role}_{n}", fn, "function"
    for nid, fn in FUNC_LIBRARY.items():  # 工具节点：初始不给，自己长出来
        if nid not in graph.nodes:
            Serialization.log_jsonl(event_log, {"event": "grow_tool", "node": nid})
            return nid, fn, "tool"
    return grow_node(graph, rng)


def attach_growth_priors(graph: GraphEngine, nid: str, kind: str) -> None:
    """生长先验：新节点接入图的锚点（入口可达、出口可达），使新节点可被探索。"""
    if not any(e.dst == nid for e in graph.out[graph.entry]):
        graph.add_edge(graph.entry, nid, 1.2)
    if not any(e.dst == graph.exit for e in graph.out[nid]):
        graph.add_edge(nid, graph.exit, 1.2)


# ---------------- 训练 / 演化 ----------------

def reward(path, graph) -> float:
    r = 10.0 - 1.0 * (len(path.nodes) - 1) if path.ok else -2.0
    if path.ok and any(graph.nodes[n].kind == "tool" for n in path.nodes):
        r += 1.0  # 工具加分：成功且落盘
    for nid in path.nodes:
        k = graph.nodes[nid].kind
        if k in ("noise", "fake"):
            r -= 3.0
        elif k == "pass":
            r -= 2.0
    return r


def update_llm_quality(graph: GraphEngine, paths, rng: random.Random) -> list[str]:
    """路由学习注意 LLM 变量：按路径成败更新 LLM 节点 bias（质量信号），
    bias 变化超阈值的事件返回供审计。"""
    events = []
    for nid, n in graph.nodes.items():
        if n.kind not in ("llm", "function"):
            continue
        in_paths = [p for p in paths if nid in p.nodes]
        if not in_paths:
            continue
        hit = sum(1 for p in in_paths if p.ok)
        before = n.bias
        n.bias = clamp(n.bias + 0.3 * (hit / len(in_paths) - 0.5), -1.5, 3.0)
        if abs(n.bias - before) >= 0.25:
            events.append(f"bias {nid} {before:+.2f}->{n.bias:+.2f}")
    return events


ROLE_OF_TASK = {"code": "code", "novel": "chapter", "article": "article",
                "translate": "translate", "math": "math"}


def repair_after_failure(graph: GraphEngine, failed_tasks: list[str], rng: random.Random) -> list[str]:
    """需求驱动的结构修复：任务失败 -> 给"该任务需要的主角色节点"补入口/出口先验边，
    并确保 save_file 可达。这是失败信号转结构补丁的生产机制。"""
    events = []
    for task in set(failed_tasks):
        role = ROLE_OF_TASK.get(task)
        if role and role in graph.nodes:
            if not any(e.dst == role for e in graph.out[graph.entry]):
                graph.add_edge(graph.entry, role, 1.5)
                events.append(f"repair entry->{role}")
            if not any(e.dst == graph.exit for e in graph.out[role]):
                graph.add_edge(role, graph.exit, 1.5)
                events.append(f"repair {role}->exit")
        if "save_file" in graph.nodes:
            if not any(e.dst == "save_file" for e in graph.out[graph.entry]):
                graph.add_edge(graph.entry, "save_file", 1.0)
                events.append("repair entry->save_file")
            if not any(e.dst == graph.exit for e in graph.out["save_file"]):
                graph.add_edge("save_file", graph.exit, 1.0)
                events.append("repair save_file->exit")
    for e in events:
        Serialization.log_jsonl(event_log, {"event": e, "ts": round(time.time(), 3)})
    return events


def evolve_graph(graph: GraphEngine, rng: random.Random, failed_tasks: list[str] | None = None) -> list[str]:
    """结构演化（保守：真实域轮次少，不剪未探索边）+ 失败驱动修复 + 提示词微调 + 生长。"""
    events = EVOLUTION.evolve(graph, conservative=True, new_node_maker=lambda g: grow_node(g, rng))
    for e in events:
        if e.startswith("grow"):
            nid = e.split(" ")[2].split("(")[0]
            attach_growth_priors(graph, nid, graph.nodes[nid].kind)
    if failed_tasks:
        events += repair_after_failure(graph, failed_tasks, rng)
    # 提示词微调：被使用但窗口内零成功贡献的 LLM/函数节点，变异其提示词
    for nid, n in graph.nodes.items():
        if n.kind in ("llm", "function") and nid in llm_instances:
            if n.uses > 0 and n.success_uses == 0 and rng.random() < 0.5:
                inst = llm_instances[nid]
                new_p = mutate_prompt(inst.prompt, rng)
                inst.set_prompt(new_p)
                Serialization.log_jsonl(prompt_log, {"event": "mutate", "node": nid, "prompt": new_p})
                events.append(f"mutate prompt {nid}")
    EVOLUTION.reset_usage(graph)
    return events


def run_round(g: GraphEngine, task_type: str, desc: str, workdir: str, rnd: int,
              rng: random.Random, beam: int = 2, max_steps: int = 8,
              spec: dict | None = None) -> dict:
    """一次任务：清理产物 -> 采样探索 -> 执行最优 -> 全路径微调 -> 质量更新。"""
    task = initial_state(task_type, desc, workdir, spec)
    if os.path.exists(task["path"]):  # 严谨性：无上轮产物假阳性
        os.remove(task["path"])
    paths = g.forward(task, beam=beam, max_steps=max_steps, greedy=False)
    g.collect_stats(paths)  # 显式统计（训练用），推理/评估不污染
    path = max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
    rewards = [reward(p, g) for p in paths]
    CREDIT.train(g, paths, rewards)  # 微调：全部路径按奖励更新
    update_llm_quality(g, paths, rng)
    saved = os.path.exists(task["path"])
    record = {"round": rnd, "task": task_type, "ok": bool(path.ok), "saved": saved,
              "beam_ok": sum(1 for p in paths if p.ok), "beam": len(paths),
              "path": "->".join(path.nodes), "reward": round(reward(path, g), 2),
              "snapshot": g.snapshot()}
    Serialization.log_jsonl(round_log, record)
    return record


def checkpoint(g: GraphEngine, path: str) -> None:
    """存图（含 LLM 提示词参数）。"""
    data = {"graph": g.to_dict(),
            "prompts": {nid: inst.prompt for nid, inst in llm_instances.items()},
            "ts": time.time()}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def load_checkpoint(path: str) -> GraphEngine:
    """恢复图并保持验收门语义（exit_fn 用 agent 域 accept，非玩具域 expected 比较）。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    g = GraphEngine.from_dict(data["graph"], build_node_pool_from_disk(data),
                        entry_fn=lambda s: dict(s), exit_fn=exit_fn)
    for nid, p in data.get("prompts", {}).items():
        if nid in llm_instances:
            llm_instances[nid].set_prompt(p)
    return g


def build_node_pool_from_disk(data: dict) -> dict:
    """从 checkpoint 的节点表重建 func（entry/exit 由 from_dict 注入验收语义，
    LLM 节点按 id 重建实例，role 从 id 前缀反推）。"""
    pool = {}
    for nid, meta in data["graph"]["nodes"].items():
        if nid in ("entry", "exit"):
            continue
        kind = meta["kind"]
        if kind == "tool":
            pool[nid] = (FUNC_LIBRARY[nid], "tool") if nid in FUNC_LIBRARY else (pass_fn, "tool")
        elif kind == "noise":
            pool[nid] = (noise_fn, "noise")
        elif kind == "pass":
            pool[nid] = (pass_fn, "pass")
        else:
            if nid in llm_instances:  # 已在本进程重建（含变异提示词）的复用
                pool[nid] = (llm_instances[nid], kind)
                continue
            if nid.startswith("llm"):
                role = "generic"
            else:
                role = nid
                for sep in ("_1", "_2", "_3", "_4", "_5", "_6", "_7", "_8"):
                    if role.endswith(sep):
                        role = role[: -len(sep)]
                        break
                role = role if role in ROLES else "generic"
            inst = make_llm(nid, role)
            fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
            pool[nid] = (fn, kind)
    return pool


# ---------------- 报告 ----------------

def report_graph(g: GraphEngine, title: str) -> str:
    lines = [f"== {title} ==", f"  {g.snapshot()}"]
    for nid, n in sorted(g.nodes.items()):
        lines.append(f"  {nid:<12} {n.kind:<9} alive={n.alive} bias={n.bias:+.2f}"
                     + (f" prompt={llm_instances[nid].prompt[:40]}..." if nid in llm_instances else ""))
    return "\n".join(lines)


def print_graph(g: GraphEngine):
    print(report_graph(g, "graph"))
    top = []
    for edges in g.out.values():
        for e in edges:
            if e.logit > 1.0:
                top.append((e.logit, f"{e.src}->{e.dst}"))
    print("top edges:")
    for l, s in sorted(top, reverse=True)[:12]:
        print(f"  {l:+.2f}  {s}")


# ---------------- 主流程 ----------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--auto", action="store_true",
                    help="pretrain + scripted user tasks, no stdin interaction")
    ap.add_argument("--pretrain_rounds", type=int, default=1, help="rounds per base task")
    ap.add_argument("--beam", type=int, default=2, help="rollouts per round (LLM call budget)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dataset", action="store_true",
                    help="train on the graph training set (dataset.py) then evaluate "
                         "on held-out tasks (generalization metric)")
    ap.add_argument("--train_rounds", type=int, default=20,
                    help="rounds sampled from TRAIN_TASKS (dataset mode)")
    ap.add_argument("--no-embedding", action="store_true",
                    help="disable semantic routing (default: qwen3.7-text-embedding-flash "
                         "via LLM_EMBED_KEY, hash fallback when unset)")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if not (API[0] and API[1]):
        print("ERROR: set LLM_BASE_URL / LLM_KEY / LLM_MODEL env vars first.")
        return
    rng = random.Random(args.seed)
    workdir = os.path.join(OUT, "workspace")
    os.makedirs(workdir, exist_ok=True)
    print(f"LLM: {API[0]} model={API[2]} | workdir={workdir}")
    print(f"logs: {os.path.basename(obs_log)} / {os.path.basename(round_log)} / "
          f"{os.path.basename(event_log)} / {os.path.basename(prompt_log)}")

    # ---- 阶段 1：预训练基础图 ----
    print("\n===== PHASE 1: pretrain base graph on diverse tasks =====")
    feature_fn = None
    if not args.no_embedding:
        from embedding import embed_state
        feature_fn = embed_state  # 语义路由观察（默认启用）：qwen3.7-text-embedding-flash
        print("routing observation: semantic embedding "
              "(qwen3.7-text-embedding-flash, 1024-dim)")
    g = build_graph(args.seed, workdir)
    g.feature_fn = feature_fn
    print(report_graph(g, "initial messy graph"))

    # ---- 阶段 1a：图训练集模式（生产域规格）----
    if args.dataset:
        from dataset import EVAL_TASKS, TRAIN_TASKS
        print(f"\n===== TRAIN on graph training set: {len(TRAIN_TASKS)} samples, "
              f"{args.train_rounds} sampled rounds =====")
        rnd = 0
        for i in range(1, args.train_rounds + 1):
            sample = rng.choice(TRAIN_TASKS)
            desc_full = f"{sample['desc']}，保存到 {sample['file']}"
            rnd += 1
            rec = run_round(g, sample["type"], desc_full, workdir, rnd, rng,
                            beam=args.beam, spec=sample["spec"])
            print(f"  [t{i:>2}] {sample['type']:<9} ok={rec['ok']} saved={rec['saved']} "
                  f"reward={rec['reward']} path={rec['path']}")
            if i % 5 == 0:
                evs = evolve_graph(g, rng)
                grown = [e for e in evs if e.startswith(("grow", "mutate", "repair"))]
                print(f"  evolve: {len(evs)} events | {g.snapshot()}")
                for e in grown[:4]:
                    print(f"    {e}")
        checkpoint(g, base_ckpt)
        print(f"\nbase graph checkpointed -> {base_ckpt}")

        print(f"\n===== HELD-OUT EVAL (generalization, {len(EVAL_TASKS)} unseen tasks) =====")
        results = []
        for s in EVAL_TASKS:
            desc_full = f"{s['desc']}，保存到 {s['file']}"
            task = initial_state(s["type"], desc_full, workdir, s["spec"])
            paths = g.forward(task, beam=4, max_steps=8, greedy=False)  # 纯推理，不污染统计
            best = max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
            results.append({"task": s["type"], "desc": s["desc"][:30],
                            "ok": bool(best.ok), "path": "->".join(best.nodes)})
            print(f"  [eval] {s['type']:<9} ok={best.ok} path={'->'.join(best.nodes)}")
        sr = sum(1 for r in results if r["ok"]) / len(results)
        print(f"\ngeneralization success rate (held-out): {sr:.2f} "
              f"({sum(1 for r in results if r['ok'])}/{len(results)})")
        checkpoint(g, final_ckpt)
        print(f"final graph checkpointed -> {final_ckpt}")
        with open(os.path.join(OUT, f"dataset_eval_{RUN_TS}.json"), "w", encoding="utf-8") as f:
            json.dump({"train_rounds": args.train_rounds, "eval": results,
                       "success_rate": sr, "graph": g.snapshot()},
                      f, ensure_ascii=False, indent=1)
        return

    rnd = 0
    for task_type, desc, _fn in BASE_TASKS:
        desc_full = f"{desc}，保存到 {_fn}"
        block_records = []
        for _ in range(args.pretrain_rounds):
            rnd += 1
            rec = run_round(g, task_type, desc_full, workdir, rnd, rng, beam=args.beam)
            block_records.append(rec)
            print(f"  [r{rnd:>2}] {task_type:<9} ok={rec['ok']} saved={rec['saved']} "
                  f"reward={rec['reward']} path={rec['path']}")
        failed = [task_type for r in block_records if not r["ok"]]
        evs = evolve_graph(g, rng, failed_tasks=failed)
        grown = [e for e in evs if e.startswith(("grow", "mutate", "repair"))]
        print(f"  evolve: {len(evs)} events (grow/mutate/repair={len(grown)}) | {g.snapshot()}")
        for e in grown[:6]:
            print(f"    {e}")
    checkpoint(g, base_ckpt)
    print(f"\nbase graph checkpointed -> {base_ckpt}")
    print(report_graph(g, "base graph after pretrain"))

    # ---- 阶段 2：用户任务（脚本化 / 交互） ----
    print("\n===== PHASE 2: user tasks (finetune) =====")
    if args.auto:
        user_tasks = [
            "写一个 Python 脚本，读取当前目录文件列表并打印，保存到 list_dir.py",
            "写一篇短文《我的一天》，保存到 day.txt",
        ]
        for desc in user_tasks:
            rnd += 1
            t = detect_task(desc)
            rec = run_round(g, t, desc, workdir, rnd, rng, beam=args.beam)
            print(f"  [u{rnd}] task={t} ok={rec['ok']} saved={rec['saved']} "
                  f"reward={rec['reward']}\n      path={rec['path']}")
            if rnd % 3 == 0:
                evs = evolve_graph(g, rng, failed_tasks=[t] if not rec["ok"] else [])
                if evs:
                    print(f"      evolve: {len(evs)} events | {g.snapshot()}")
        checkpoint(g, final_ckpt)
        print(f"\nfinal graph checkpointed -> {final_ckpt}")
        print(report_graph(g, "final graph after user tasks"))
        print(f"\nobservations: {obs_log} | rounds: {round_log} | prompts: {prompt_log}")
        return

    # 交互模式
    print("interactive mode. commands:")
    print("  task <描述>   发布任务（图会思考、执行、微调）")
    print("  stats         图结构统计（节点/边/熵 + 各节点状态）")
    print("  graph         输出图和 top 边权重")
    print("  save          存 checkpoint")
    print("  exit          退出")
    while True:
        try:
            cmd = input("user> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not cmd:
            continue
        if cmd in ("exit", "quit"):
            break
        if cmd == "stats":
            print(report_graph(g, "graph"))
        elif cmd == "graph":
            print_graph(g)
        elif cmd == "save":
            checkpoint(g, final_ckpt)
            print(f"saved -> {final_ckpt}")
        elif cmd.startswith("task "):
            desc = cmd[5:].strip()
            rnd += 1
            t = detect_task(desc)
            rec = run_round(g, t, desc, workdir, rnd, rng, beam=args.beam)
            print(f"  ok={rec['ok']} saved={rec['saved']} reward={rec['reward']}")
            print(f"  path: {rec['path']}")
            if rec["saved"]:
                with open(initial_state(t, desc, workdir)["path"], encoding="utf-8") as f:
                    print(f"  artifact head: {f.read()[:120]!r}")
            if rnd % 3 == 0:
                evs = evolve_graph(g, rng, failed_tasks=[t] if not rec["ok"] else [])
                if evs:
                    print(f"  evolve: {len(evs)} events | {g.snapshot()}")
        else:
            print("unknown command (task/stats/graph/save/exit)")


if __name__ == "__main__":
    main()

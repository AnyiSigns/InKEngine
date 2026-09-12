"""agent_demo2.py - 下一版 agent 图原型：契约门控（阶段 A）+ 三臂基线对照。

v1（agent_demo.py）真实域实验失败证据（run7/8/dataset1：成功率 0%、路由熵上升、
无基线对照）指向的结论：真实域失败的不是"图可训练"，而是"策略梯度在无契约、
无基线的真实域里白手起家"。本版按重设计三机制的第一优先阶段重构：

  A. 契约先行 typed-state（本文件）：
     1. 每个节点声明 requires/provides；引擎调用前查契约，
        不满足 = 零代价死路（不执行函数、不调 LLM）——恢复玩具域类型门控的
        硬死路信号，且零 API 成本；
     2. 验收通道收口：每族任务只读本族角色节点的 provides 字段，
        错误生产者（code 节点）喂不饱 translate 验收（v1 漏洞）；
     3. LLM 输入契约：prompt 只接收节点声明的输入字段，
        不再整包 json.dumps 注入 state（v1 污染链）；
     4. 路由观察 = 任务族离散特征（typed-state），弃用整包 state 的 embedding
        （v1 的 e.cond[tuple] 死信道 bug 因此绕开）。
  B. 基线对照（本文件）：三臂同一数据集、同一批 LLM 节点实例、同一验收函数：
     臂1 = 10 行硬编码启发式路由（关键词->角色节点->save_file->exit）
     臂2 = 不训练随机图（与臂3同初始图，只 forward 不 train_step）
     臂3 = 训练图（契约门控 + REINFORCE + 演化）
     主指标 = 技能习得曲线（每族首次成功轮次 / 连续 3 次成功轮次 + 调用数）
     + held-out 泛化。

阶段 B（技能宏/规划层模拟）与 C（演化闸门/拓扑不变量焊死）随后实施。

Usage:
  python experiment/GraphLab/demos/agent_demo2.py --compare --train_rounds 33 --beam 2
  python experiment/GraphLab/demos/agent_demo2.py --smoke   # 离线管线冒烟（stub LLM）
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from copy import deepcopy

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # GraphLab 根目录（分层非包：sys.path 注入）
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
import _paths  # noqa: E402

_paths.setup()
from serialization import Serialization  # noqa: E402
from tool_adapter import ToolAdapter  # noqa: E402

from store import Contract
from graph_engine import GraphEngine
from router import Router
from contract_gate import ContractGate
from llm_adapter import LLMAdapter, ROLE_PROMPTS
from credit import CreditAssigner, clamp
from evolution import Evolution
from llm_adapter import PROVIDERS
from embedding import embed


CREDIT = CreditAssigner()
EVOLUTION = Evolution()

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
WORKDIR = os.path.join(OUT, "workspace2")

RUN_TS = time.strftime("%Y%m%d_%H%M%S")
obs_log = os.path.join(OUT, f"v2_observations_{RUN_TS}.jsonl")
event_log = os.path.join(OUT, f"v2_events_{RUN_TS}.jsonl")
prompt_log = os.path.join(OUT, f"v2_prompts_{RUN_TS}.jsonl")
base_ckpt = os.path.join(OUT, "v2_base_graph.json")
final_ckpt = os.path.join(OUT, "v2_final_graph.json")


def resolve_api() -> tuple[str, str, str]:
    """API 配置：env LLM_BASE_URL/LLM_KEY 优先（v1 语义），否则 fallback 链首提供商。"""
    if os.environ.get("LLM_BASE_URL") and os.environ.get("LLM_KEY"):
        return (os.environ["LLM_BASE_URL"], os.environ["LLM_KEY"],
                os.environ.get("LLM_MODEL", PROVIDERS[0]["models"][0]))
    return (PROVIDERS[0]["base_url"], PROVIDERS[0]["api_key"], PROVIDERS[0]["models"][0])


API = resolve_api()
MUTATIONS = ["", " 输出要简洁专业。", " 先列出要点再输出。",
             " 输出使用中文。", " 输出要完整详尽。", " 输出格式要清晰，使用标题。"]
ROLES = ["plan", "code", "chapter", "review", "polish", "article", "translate", "math"]
ROLE_OF_TASK = {"code": "code", "novel": "chapter", "article": "article",
                "translate": "translate", "math": "math"}
ROLE_FIELD = {"plan": "plan", "code": "code", "article": "article",
              "translate": "translated", "math": "math_answer",
              "review": "review", "polish": "polished"}

# 内容产物字段全集：任何能作为"任务产出物"的 state 字段
CONTENT_FIELDS = ("code", "article", "translated", "math_answer",
                  "polished", "chapters", "answer")

# ---------------- 契约表（typed-state 声明，静态随角色走，不学习） ----------------
# 角色节点用值约束 requires={"task": ("code",)}：任务族错配 = 零代价死路
# （translate 任务上 code 节点连路由都看不到 —— 审计 #2"LLM 愿意接任何活"修复）。
# 通用/工具节点用存在/析取约束（payload 恒在；content 需先有产出）。

ALL_TASKS = ("code", "novel", "article", "translate", "math")

CONTRACTS: dict[str, Contract] = {
    "plan":        Contract(requires={"task": ALL_TASKS}, provides="plan"),
    "code":        Contract(requires={"task": ("code",)}, provides="code"),
    "chapter":     Contract(requires={"task": ("novel",)}, provides="chapters"),
    "article":     Contract(requires={"task": ("article",)}, provides="article"),
    "translate":   Contract(requires={"task": ("translate",)}, provides="translated"),
    "math":        Contract(requires={"task": ("math",)}, provides="math_answer"),
    "review":      Contract(requires={"content": CONTENT_FIELDS}, provides="review"),
    "polish":      Contract(requires={"review": (), "content": CONTENT_FIELDS},
                           provides="polished"),
    "generic":     Contract(requires={"payload": ()}, provides="answer"),
    "save_file":   Contract(requires={"content": CONTENT_FIELDS}, provides="saved"),
    "append_file": Contract(requires={"content": CONTENT_FIELDS}, provides="saved"),
    "list_dir":    Contract(requires={"workdir": ()}, provides="answer"),
    "read_file":   Contract(requires={"path": ()}, provides="answer"),
}

# LLM 输入契约：各角色 prompt 只接收这些字段
INPUT_FIELDS: dict[str, tuple[str, ...]] = {
    "plan":      ("payload",),
    "code":      ("payload", "plan"),
    "chapter":   ("payload", "chapters"),
    "article":   ("payload",),
    "translate": ("payload",),
    "math":      ("payload",),
    "review":    ("payload",) + CONTENT_FIELDS,
    "polish":    ("payload", "review") + CONTENT_FIELDS,
    "generic":   ("payload",),
}


# ---------------- 观测 / 审计 ----------------

CALLS = {"n": 0}  # LLM 调用计数（每臂独立归零，主成本指标）




def obs_logger(arm: str):
    def logger(nid, role, task, inp, out, secs, provider=""):
        CALLS["n"] += 1
        Serialization.log_jsonl(obs_log, {"ts": round(time.time(), 3), "arm": arm, "node": nid,
                            "role": role, "task": task, "input": inp, "output": out,
                            "secs": round(secs, 1), "provider": provider})
    return logger


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


def task_feature(state: dict) -> str:
    """路由观察 = 任务族离散特征（typed-state，替代 v1 的整包 embedding）。"""
    return detect_task(str(state.get("payload") or ""))


def family_of(task: dict) -> str:
    """任务族由系统从描述推断（detect_task），不再吃数据集 gold label
    （审查 #3.1 oracle 泄漏：state['task'] 之前由出题者写入）。"""
    return detect_task(desc_full(task))


def extract_filename(desc: str, workdir: str) -> str:
    m = re.search(r'[\w\-.]+\.(?:py|txt|md|json)', desc)
    if m:
        return os.path.join(workdir, m.group(0))
    return os.path.join(workdir, "output.txt")


def _strip_fences(code: str) -> str:
    """去掉 LLM 常见的 ```python ... ``` 围栏，避免内容格式误杀（对三臂同等生效）。"""
    m = re.search(r"```(?:python|py)?\s*\n(.*?)\n```", code, re.S)
    return m.group(1).strip() if m else code


def _exec_code_test(code: str, workdir: str, fns: list[str],
                    timeout_s: int = 15) -> bool:
    """生产域验收：代码任务真实执行 + 指定函数存在（不可被路由策略污染）。"""
    import subprocess
    code = _strip_fences(code)
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


def accept_channel(task_type: str, state: dict) -> bool:
    """验收通道收口：每族任务只读本族角色节点的 provides 字段。

    与 v1 的差异：不再 `or state.get("answer")` —— 错误生产者（如 code 节点
    写的 answer/code）喂不饱 translate 验收。字段只可能由对应 provides 的
    节点写入（契约 + field_setter 双保险）。
    强验收优先（code=可执行、math=数值代入）；弱验收（translate 长度/ASCII）
    是已知待加强项（回译往返需额外 LLM 调用，见 TODO）。
    """
    spec = state.get("spec") or {}
    if task_type == "code":
        c = state.get("code") or ""
        if len(c) < 30 or "def " not in c:
            return False
        return _exec_code_test(c, state.get("workdir", WORKDIR),
                               spec.get("fns", ["add", "sub", "mul", "div"]))
    if task_type == "novel":
        ch = state.get("chapters") or []
        return len(ch) >= spec.get("chapters", 2) \
            and sum(len(x) for x in ch) > spec.get("min_chars", 200)
    if task_type == "article":
        return len(state.get("article") or "") > spec.get("min_chars", 150)
    if task_type == "translate":
        c = state.get("translated") or ""
        return len(c) > 10 and any(ch.isascii() and ch.isalpha() for ch in c)
    if task_type == "math":
        c = state.get("math_answer") or ""
        return len(c) > 10 and _math_numeric_check(state.get("payload") or "", c)
    return False


def _math_numeric_check(desc: str, answer: str) -> bool:
    """数值代入验收：从题目解析 a·x±b=c，从答案提取 x 值代入验证。
    替换 v2 弱验收 'len>10 且含 x'（复述原题即可过，审查 #9）。
    解析不出方程时保守失败（不强过）。"""
    m = re.search(
        r'([-+]?\d+(?:\.\d+)?)\s*\*?\s*x\s*([+-])\s*([-+]?\d+(?:\.\d+)?)'
        r'\s*=\s*([-+]?\d+(?:\.\d+)?)', desc)
    if not m:
        return False
    a, op, b, c = float(m.group(1)), m.group(2), float(m.group(3)), float(m.group(4))
    # 负向后顾：不抓 "2x=12" 里的 x=12（x 前有数字时不是解的声明）
    xm = re.search(r'(?<!\d)x\s*=\s*([-+]?\d+(?:\.\d+)?)', answer)
    if not xm:
        return False
    x = float(xm.group(1))
    lhs = a * x + b if op == "+" else a * x - b
    return abs(lhs - c) < 0.01


def initial_state(task_type: str, desc: str, workdir: str, spec: dict | None = None) -> dict:
    # 不预置空容器（chapters 等由生产者写入；None 字段契约视为缺失）
    return {"payload": desc, "task": task_type,
            "workdir": workdir, "path": extract_filename(desc, workdir),
            "require_file": ("保存" in desc), "spec": spec or {},
            "plan": None, "code": None, "review": None,
            "polished": None, "article": None, "translated": None,
            "math_answer": None}


# ---------------- 节点构造（LLM 实例可被微调；契约随角色声明） ----------------

llm_instances: dict[str, LLMAdapter] = {}


def make_llm(nid: str, role: str, arm: str) -> LLMAdapter:
    inst = LLMAdapter(role=role, api=API, logger=obs_logger(arm), nid=nid,
                   input_fields=list(INPUT_FIELDS[role]), provides=CONTRACTS[role].provides,
                   models=MODELS, timeout=LLM_TIMEOUT)
    llm_instances[nid] = inst
    return inst


def reset_instances():
    llm_instances.clear()


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


def generic_llm(nid: str, arm: str):
    inst = make_llm(nid, "generic", arm)
    def fn(state):
        st = inst(state)
        if st is None:
            return None
        return {**st, "answer": st["_out"]}
    return fn


# ---------------- 工具节点（初始不提供，演化生长；契约声明前置内容） ----------------

def save_fn(state):
    content = state.get("polished") or state.get("code") or state.get("answer") or ""
    if not content:
        content = state.get("article") or state.get("translated") or state.get("math_answer") or ""
    if not content:
        content = "\n\n".join(state.get("chapters") or [])
    if len(content) < 30:
        return None
    os.makedirs(state["workdir"], exist_ok=True)
    with open(state["path"], "w", encoding="utf-8") as f:
        f.write(content)
    return {**state, "saved": True}


def exit_fn(state):
    """验收门（通道收口）：内容合格 且（任务要求保存时）文件已落盘。"""
    ok = accept_channel(state.get("task"), state)
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


def build_graph(seed: int, workdir: str, arm: str) -> GraphEngine:
    """混乱初始图：11 个 LLM 节点（3 通用串联 + 8 角色协作者，全部带契约）
    + 噪声/中性干扰。无工具节点——工具靠结构演化长出来（同样带契约）。"""
    g = GraphEngine(seed=seed, feature_fn=task_feature)
    g.add_node("entry", lambda s: dict(s), kind="entry")
    g.add_node("exit", exit_fn, kind="exit")
    for role in ROLES:
        nid = role
        inst = make_llm(nid, role, arm)
        fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
        g.add_node(nid, fn, kind="llm", contract=CONTRACTS[role])
    for i in (1, 2, 3):
        g.add_node(f"llm_{i}", generic_llm(f"llm_{i}", arm), kind="llm",
                   contract=CONTRACTS["generic"])
    g.add_edge("llm_1", "llm_2", 2.0)
    g.add_edge("llm_2", "llm_3", 2.0)
    g.add_edge("llm_3", "exit", 1.0)
    g.add_edge("chapter", "chapter", 1.0)  # 多章任务自环先验
    # save_file = 基础图叶子（内容汇聚/落盘算子，域级必备；技能/增长不再靠时钟生长）
    g.add_node("save_file", save_fn, kind="tool", contract=CONTRACTS["save_file"])
    g.add_edge("save_file", "exit", 1.0)
    for i in (1, 2):
        g.add_node(f"noise_{i}", noise_fn, kind="noise")
        g.add_node(f"pass_{i}", pass_fn, kind="pass")
    g.randomize(p=0.25)
    return g


def mutate_prompt(prompt: str, rng: random.Random) -> str:
    return prompt + rng.choice(MUTATIONS)


def grow_node(graph: GraphEngine, rng: random.Random, arm: str):
    """结构生长：LLM 节点（角色克隆换名，kind 如实标 llm——修正 v1 标签撒谎）。
    契约/输入字段随角色声明；纯 prompt 变异不换能力（阶段 C 修需求驱动）。"""
    roll = rng.random()
    if roll < 0.5:
        n = 1
        while f"llm_g{n}" in graph.nodes:
            n += 1
        inst = make_llm(f"llm_g{n}", "generic", arm)
        inst.set_prompt(mutate_prompt(inst.prompt, rng))
        Serialization.log_jsonl(prompt_log, {"event": "grow", "node": f"llm_g{n}",
                               "prompt": inst.prompt})
        fn = field_setter(inst, "answer")
        fn.contract = CONTRACTS["generic"]
        return f"llm_g{n}", fn, "llm"
    if roll < 0.8:
        role = rng.choice(ROLES)
        n = 1
        while f"{role}_{n}" in graph.nodes:
            n += 1
        inst = make_llm(f"{role}_{n}", role, arm)
        inst.set_prompt(mutate_prompt(inst.prompt, rng))
        Serialization.log_jsonl(prompt_log, {"event": "grow", "node": f"{role}_{n}",
                               "prompt": inst.prompt})
        fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
        fn.contract = CONTRACTS[role]
        return f"{role}_{n}", fn, "llm"
    for nid, fn in FUNC_LIBRARY.items():
        if nid not in graph.nodes:
            Serialization.log_jsonl(event_log, {"event": "grow_tool", "node": nid})
            fn.contract = CONTRACTS[nid]
            return nid, fn, "tool"
    return grow_node(graph, rng, arm)


def attach_growth_priors(graph: GraphEngine, nid: str) -> None:
    if not any(e.dst == nid for e in graph.out[graph.entry]):
        graph.add_edge(graph.entry, nid, 1.2)
    if not any(e.dst == graph.exit for e in graph.out[nid]):
        graph.add_edge(nid, graph.exit, 1.2)


# ---------------- 训练 / 演化 ----------------

def reward(path, graph) -> float:
    r = 10.0 - 1.0 * (len(path.nodes) - 1) if path.ok else -2.0
    if path.ok and any(graph.nodes[n].kind == "tool" for n in path.nodes):
        r += 1.0
    for nid in path.nodes:
        k = graph.nodes[nid].kind
        if k in ("noise", "fake"):
            r -= 3.0
        elif k == "pass":
            r -= 2.0
    return r


def update_llm_quality(graph: GraphEngine, paths, rng: random.Random) -> list[str]:
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


def repair_after_failure(graph: GraphEngine, failed_tasks: list[str], rng: random.Random) -> list[str]:
    """失败信号转结构补丁：缺失边才加；已有边只提权重（v2 修复：v1 对稠密随机图
    完全失效——entry->role 边早已存在，repair 从不触发）。"""
    events = []
    def boost(src: str, dst: str, target: float):
        for e in graph.out[src]:
            if e.dst == dst:
                if e.logit < target:
                    e.logit = target
                    events.append(f"repair boost {src}->{dst} {target}")
                return
        graph.add_edge(src, dst, target)
        events.append(f"repair add {src}->{dst} {target}")

    for task in set(failed_tasks):
        role = ROLE_OF_TASK.get(task)
        if role and role in graph.nodes:
            boost(graph.entry, role, 1.5)
            boost(role, graph.exit, 1.5)
        if "save_file" in graph.nodes:
            boost(graph.entry, "save_file", 1.0)
            boost("save_file", graph.exit, 1.0)
    for e in events:
        Serialization.log_jsonl(event_log, {"event": e, "ts": round(time.time(), 3)})
    return events


def evolve_graph(graph: GraphEngine, rng: random.Random, arm: str,
                 failed_tasks: list[str] | None = None) -> list[str]:
    events = EVOLUTION.evolve(graph, conservative=True,
                    new_node_maker=lambda g: grow_node(g, rng, arm))
    for e in events:
        if e.startswith("grow"):
            nid = e.split(" ")[2].split("(")[0]
            attach_growth_priors(graph, nid)
    if failed_tasks:
        events += repair_after_failure(graph, failed_tasks, rng)
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


def desc_full(task: dict) -> str:
    return f"{task['desc']}，保存到 {task['file']}"


def run_round(g: GraphEngine, task: dict, rnd: int, rng: random.Random,
              beam: int, max_steps: int = 8, train: bool = True,
              skills: bool = False) -> dict:
    """一次任务：清理产物 -> （技能臂先查宏：命中=top-1 执行，一次成功 O(1)）
    -> beam 探索 -> 选优 -> （训练臂）全路径微调 + 质量更新 + 成功结晶成宏。
    契约查闸在 GraphEngine.forward 内：错误路由零代价死路。"""
    desc_txt = desc_full(task)
    fam = family_of(task)
    state = initial_state(fam, desc_txt, WORKDIR, task["spec"])
    if os.path.exists(state["path"]):
        os.remove(state["path"])
    if skills:
        m = LIBRARY.match(fam, embed(desc_txt))
        if m is not None:
            s, mc, run = execute_macro(state, m, g)
            if s is not None and s.get("ok"):
                m.hits += 1
                m.ok += 1
                m.fails = 0
                return {"round": rnd, "task": fam, "ok": True,
                        "saved": os.path.exists(state["path"]),
                        "beam_ok": 1, "macro": True, "path": "->".join(run),
                        "calls": mc, "reward": 10.0 - len(run)}
            LIBRARY.note_fail(m)  # 执行完成但验收不过 / 中途失败 = 漂移信号
    paths = g.forward(state, beam=beam, max_steps=max_steps, greedy=False)
    if train:
        g.collect_stats(paths)  # 显式统计（训练用），推理/评估不污染
    best = max(paths, key=lambda p: (p.ok, -len(p.nodes), p.logprob))
    if train:
        rewards = [reward(p, g) for p in paths]
        CREDIT.train(g, paths, rewards)
        update_llm_quality(g, paths, rng)
        if skills and best.ok:
            crystallize(g, fam, best.nodes, desc_txt, rnd)
    return {"round": rnd, "task": fam, "ok": bool(best.ok),
            "saved": os.path.exists(state["path"]),
            "beam_ok": sum(1 for p in paths if p.ok),
            "macro": False, "path": "->".join(best.nodes),
            "reward": round(reward(best, g), 2)}


# ---------------- 基线对照：臂 1 = 10 行硬编码启发式路由 ----------------

def heuristic_route(task: dict, arm: str) -> dict:
    """对照臂：关键词->角色节点->save_file->exit。不训练、不演化。
    与训练臂共用同一批 LLM 节点实例与同一验收函数，只差路由策略。
    成功时附带 macro_path（供 B1 teacher 沉淀技能宏）。"""
    fam = family_of(task)
    role = ROLE_OF_TASK[fam]
    desc_txt = desc_full(task)
    state = initial_state(fam, desc_txt, WORKDIR, task["spec"])
    if os.path.exists(state["path"]):
        os.remove(state["path"])
    inst = llm_instances[role]
    st = inst(state)
    if st is None:
        return {"ok": False, "calls": 0, "path": role, "task": fam,
                "reason": "llm_failed"}
    if fam == "novel":
        state = {**st, "chapters": [st["_out"]]}
        st2 = inst(state)  # 第二章（novel 验收需 >= 2 章）
        if st2 is not None:
            state = {**st2, "chapters": state["chapters"] + [st2["_out"]]}
    else:
        state = {**st, ROLE_FIELD[role]: st["_out"]}
    state = save_fn(state)
    if state is None:  # 无可存内容（质量闸 <30 字符拒绝）
        return {"ok": False, "calls": 0, "path": role, "task": fam,
                "reason": "no_saveable_content"}
    state = exit_fn(state)
    ok = bool(state.get("ok"))
    macro_path = ([role] + (["chapter"] if fam == "novel" and ok else [])
                  + ["save_file", "exit"]) if ok else []
    return {"ok": ok, "calls": 0, "task": fam, "desc_full": desc_txt,
            "macro_path": macro_path, "path": f"{role}->save_file->exit"}


# ---------------- 技能宏（阶段 B1：情景式技能习得，O(1) 学习） ----------------
# 一次经验证成功轨迹 → 带 typed 前置条件 + 检索锚点的宏：
#   命中 = 族一致（typed 硬闸）且余弦≥阈值（召回护栏，相似≠可用）
#   执行 = top-1 强制路径（无 beam、无探索），exit 验收才算命中
#   弃权 = 无宏命中 / 执行失败 / 验收不过 → 回退图探索
#   漂移护栏 = 宏连续 2 次验收失败即移除（技能腐烂检测）

class SkillMacro:
    def __init__(self, family: str, path: list[str], anchor: tuple,
                 calls: int, round_: int):
        self.family = family
        self.path = list(path)  # 不含 entry，以 exit 结尾
        self.anchor = anchor    # 成功时任务描述的 embedding（检索锚点）
        self.calls = calls      # 路径内 LLM 调用数 = 学习成本
        self.round = round_
        self.hits = 0
        self.ok = 0
        self.fails = 0          # 连续验收失败（漂移信号）

    def to_dict(self) -> dict:
        return {"family": self.family, "path": self.path, "calls": self.calls,
                "round": self.round, "hits": self.hits, "ok": self.ok,
                "anchor": list(self.anchor) if self.anchor else []}


class MacroLibrary:
    def __init__(self, threshold: float = 0.6):
        self.macros: dict[str, SkillMacro] = {}  # family -> 宏（每族保留最省调用的一条）
        self.threshold = threshold

    def match(self, family: str, anchor: tuple) -> SkillMacro | None:
        m = self.macros.get(family)
        if m is None:
            return None
        sim = Router.cosine(anchor, m.anchor) if anchor and m.anchor else 0.0
        if sim >= self.threshold:
            return m
        return None  # 检索相似度不足：弃权（宁可探索，不盲目复用）

    def add_or_replace(self, macro: SkillMacro) -> bool:
        cur = self.macros.get(macro.family)
        if cur is None or macro.calls < cur.calls:
            self.macros[macro.family] = macro
            return True
        return False

    def note_fail(self, macro: SkillMacro) -> None:
        macro.fails += 1
        if macro.fails >= 2:
            Serialization.log_jsonl(event_log, {"event": "skill_drop", "family": macro.family,
                                  "fails": macro.fails,
                                  "ts": round(time.time(), 3)})
            self.macros.pop(macro.family, None)


LIBRARY = MacroLibrary()


def execute_macro(state: dict, macro: SkillMacro, graph: GraphEngine):
    """top-1 执行宏路径：逐节点过契约/函数；exit 验收。零探索成本。
    返回 (终态|None, 调用数, 实际执行节点序)；任一步失败 = 弃权。"""
    s = deepcopy(state)
    c0 = CALLS["n"]
    run: list[str] = []
    for nid in macro.path:
        node = graph.nodes.get(nid)
        if node is None or not node.alive:
            return None, CALLS["n"] - c0, run  # 宏引用的节点已死/不存在
        if node.contract and not ContractGate.ok(node.contract, s):
            return None, CALLS["n"] - c0, run  # 契约不满足
        s = node.func(s)
        if s is None:
            return None, CALLS["n"] - c0, run
        run.append(nid)
        if nid == graph.exit:
            break
    return s, CALLS["n"] - c0, run


def crystallize(graph: GraphEngine, task_type: str, path_nodes: list[str],
                desc_text: str, round_: int) -> bool:
    """成功轨迹 → 技能宏（一次成功 O(1) 沉淀；只认以 exit 验收收尾的路径）。"""
    if len(path_nodes) < 3 or path_nodes[-1] != graph.exit:
        return False
    body = path_nodes[1:]  # 去 entry
    calls = sum(1 for nid in body if graph.nodes[nid].kind in ("llm", "function"))
    m = SkillMacro(task_type, body, embed(desc_text), calls, round_)
    if LIBRARY.add_or_replace(m):
        Serialization.log_jsonl(event_log, {"event": "skill_crystal", "family": task_type,
                              "path": "->".join(body), "calls": calls,
                              "round": round_, "ts": round(time.time(), 3)})
        return True
    return False


# ---------------- 契约导向确定性路由（审查 #3.7 缺失的关键臂） ----------------
# 验证命题：仅凭 requires/provides 声明 + 验收规格做约束满足贪心，
# 能否不学、不随机而复现 10 行启发式？能 => 契约先行就是启发式的推广。

ACCEPT_CHANNEL = {"code": ("code",), "novel": ("chapters",),
                  "article": ("article",), "translate": ("translated",),
                  "math": ("math_answer",)}


def contract_route(g: GraphEngine, state: dict, max_steps: int = 8):
    """声明即调度器：类型导向搜索（审查 #3.7/方案 B）。
    候选 = 全图存活 + 契约合法 + 非 entry 的节点集（边不再是约束）；
    按声明贪心：验收已满足且无需落盘 -> exit(10)；缺验收通道 -> 其
    provides 命中者(5)；要求落盘未落 -> save_file(4)；内容类兜底(2)。
    目标边缺失则当场补边（需求驱动生长，审计落盘）——随机图的边稀疏
    证明：路由是平凡问题，真正要学的是结构补全而非逐边权重。
    返回 (path, state, ok, edges_added)。"""
    s = dict(state)
    path = [g.entry]
    cur = g.entry
    added = 0
    sticky = {"chapters"}  # 可累积字段（逐章生成）允许节点重访；其余重访=死循环
    for _ in range(max_steps):
        fam = s.get("task")
        ok_now = accept_channel(fam, s)
        need_saved = bool(s.get("require_file")) and not (
            s.get("saved") or (os.path.exists(s.get("path", ""))
                               and os.path.getsize(s.get("path", "")) > 0))
        cands = [nid for nid, n in g.nodes.items()
                 if n.alive and nid != g.entry and nid != cur
                 and not ContractGate.statically_dead(g.store, n, s)
                 and (n.contract is None or ContractGate.ok(n.contract, s))]
        if not cands:
            return path, s, bool(s.get("ok")), added

        def score(nid):
            n = g.nodes[nid]
            p = n.contract.provides if n.contract else None
            if nid == g.exit and ok_now and not need_saved:
                return 10
            if not ok_now and p in ACCEPT_CHANNEL.get(fam, ()):
                return 5
            if need_saved and p == "saved":
                return 4
            if p in CONTENT_FIELDS:
                return 2
            return 0

        best = max(cands, key=score)
        p = g.nodes[best].contract.provides if g.nodes[best].contract else None
        if best in path[1:] and p not in sticky:
            break  # 已访问过且不累积：重跑无意义（死循环守卫）
        if not any(e.dst == best for e in g.out[cur]):
            g.add_edge(cur, best, 1.0)
            added += 1
            Serialization.log_jsonl(event_log, {"event": "contract_edge", "src": cur,
                                  "dst": best, "ts": round(time.time(), 3)})
        s2 = g.nodes[best].func(s)
        if s2 is None:
            return path, s, bool(s.get("ok")), added
        s = s2
        path.append(best)
        cur = best
        if cur == g.exit and s.get("ok"):
            break  # 验收通过即终止
    return path, s, bool(s.get("ok")), added


def arm_contract(tasks: list[dict], arm: str = "contract_only") -> dict:
    """契约臂：零学习零随机，声明即调度器。与启发式臂同预算（每任务 1 路径）。"""
    reset_instances()
    CALLS["n"] = 0
    g = build_graph(0, WORKDIR, arm)
    records = []
    for i, t in enumerate(tasks, 1):
        fam = family_of(t)
        state = initial_state(fam, desc_full(t), WORKDIR, t["spec"])
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        path, s, ok, added = contract_route(g, state)
        records.append({"round": i, "task": fam, "ok": ok,
                        "calls": CALLS["n"] - c0, "path": "->".join(path),
                        "edges_added": added})
    return {"records": records, "calls": CALLS["n"],
            "skill": skill_curve(records),
            "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


# ---------------- 三臂实验 ----------------

def skill_curve(records: list[dict]) -> dict:
    """技能习得：每族 seen/ok/首成轮次/连续 3 次成功轮次/调用数。"""
    fam: dict[str, dict] = {}
    for i, r in enumerate(records, 1):
        f = r["task"]
        d = fam.setdefault(f, {"seen": 0, "ok": 0, "first_ok": None,
                               "streak": 0, "streak3": None, "calls": 0})
        d["seen"] += 1
        d["calls"] += r.get("calls", 0)
        if r["ok"]:
            d["ok"] += 1
            if d["first_ok"] is None:
                d["first_ok"] = i
            d["streak"] += 1
            if d["streak"] >= 3 and d["streak3"] is None:
                d["streak3"] = i
        else:
            d["streak"] = 0
    return fam


def arm_heuristic(tasks: list[dict], arm: str) -> dict:
    reset_instances()
    CALLS["n"] = 0
    for role in set(ROLE_OF_TASK.values()):
        make_llm(role, role, arm)
    records = []
    for i, t in enumerate(tasks, 1):
        c0 = CALLS["n"]
        rec = heuristic_route(t, arm)
        rec["calls"] = CALLS["n"] - c0
        rec["round"] = i
        records.append(rec)
    return {"records": records, "calls": CALLS["n"],
            "skill": skill_curve(records),
            "ok": sum(1 for r in records if r["ok"]),
            "total": len(records)}


def arm_graph(tasks: list[dict], seed: int, beam: int, arm: str,
              train: bool, evolve_every: int = 5, max_steps: int = 8,
              skills: bool = False) -> tuple[GraphEngine, dict]:
    reset_instances()
    CALLS["n"] = 0
    g = build_graph(seed, WORKDIR, arm)
    rng = random.Random(seed)
    records = []
    for i, t in enumerate(tasks, 1):
        c0 = CALLS["n"]
        rec = run_round(g, t, i, rng, beam, max_steps, train=train, skills=skills)
        rec["calls"] = CALLS["n"] - c0
        records.append(rec)
        print(f"    [r{i:>2}] {t['type']:<9} ok={rec['ok']} beam_ok={rec['beam_ok']} "
              f"calls={rec['calls']} path={rec['path']}", flush=True)
        if train and i % evolve_every == 0:
            failed = [t0["type"] for rec0, t0 in
                      zip(records[-evolve_every:], tasks[i - evolve_every:i])
                      if not rec0["ok"]]
            evs = evolve_graph(g, rng, arm, failed_tasks=failed)
            if evs:
                grown = [e for e in evs if e.startswith(("grow", "mutate", "repair"))]
                print(f"    evolve: {len(evs)} events | {g.snapshot()}", flush=True)
                for e in grown[:4]:
                    print(f"      {e}")
    return g, {"records": records, "calls": CALLS["n"],
               "skill": skill_curve(records),
               "ok": sum(1 for r in records if r["ok"]),
               "total": len(records)}


def arm_skills(tasks: list[dict], seed: int, beam: int,
               teacher_records: list[dict]) -> tuple[GraphEngine, dict]:
    """B1 技能臂：teacher（启发式）成功轨迹 → 技能宏库 → 宏优先路由。
    宏命中 = O(1) 调用；未命中/弃权回退图探索，成功后结晶新宏。"""
    reset_instances()
    CALLS["n"] = 0
    LIBRARY.macros.clear()
    n_taught = 0
    for r in teacher_records:
        if r.get("ok") and r.get("macro_path"):
            m = SkillMacro(r["task"], r["macro_path"], embed(r["desc_full"]),
                           r.get("calls", 1), r.get("round", 0))
            if LIBRARY.add_or_replace(m):
                n_taught += 1
                Serialization.log_jsonl(event_log, {"event": "skill_teach", "family": r["task"],
                                      "path": "->".join(m.path),
                                      "ts": round(time.time(), 3)})
    print(f"    teacher: {n_taught} 条技能宏入库 -> "
          f"{list(LIBRARY.macros)}", flush=True)
    g = build_graph(seed, WORKDIR, "trained_skills")
    rng = random.Random(seed)
    records = []
    for i, t in enumerate(tasks, 1):
        c0 = CALLS["n"]
        rec = run_round(g, t, i, rng, beam, 8, train=True, skills=True)
        rec["calls"] = CALLS["n"] - c0
        records.append(rec)
        print(f"    [r{i:>2}] {t['type']:<9} ok={rec['ok']} "
              f"macro={rec.get('macro')} calls={rec['calls']} path={rec['path']}",
              flush=True)
        if i % 5 == 0:
            failed = [t0["type"] for rec0, t0 in
                      zip(records[-5:], tasks[i - 5:i]) if not rec0["ok"]]
            evs = evolve_graph(g, rng, "trained_skills", failed_tasks=failed)
            if evs:
                grown = [e for e in evs if e.startswith(("grow", "mutate", "repair"))]
                print(f"    evolve: {len(evs)} events | {g.snapshot()}", flush=True)
                for e in grown[:4]:
                    print(f"      {e}")
    return g, {"records": records, "calls": CALLS["n"],
               "skill": skill_curve(records),
               "ok": sum(1 for r in records if r["ok"]),
               "total": len(records),
               "library": {f: m.to_dict() for f, m in LIBRARY.macros.items()}}


def evaluate(g: GraphEngine | None, tasks: list[dict], arm: str) -> dict:
    """held-out 推理（不污染统计）。协议：greedy pass@1（审查 #4.3 协议不均：
    v2 之前图臂 beam=4 多次验收重试 vs 启发式 1 次——不公平，现全部钉死 greedy）。"""
    if arm == "heuristic":
        return arm_heuristic(tasks, arm)
    if arm == "contract_only":
        return arm_contract(tasks, arm)
    records = []
    CALLS["n"] = 0
    for i, t in enumerate(tasks, 1):
        fam = family_of(t)
        state = initial_state(fam, desc_full(t), WORKDIR, t["spec"])
        if os.path.exists(state["path"]):
            os.remove(state["path"])
        c0 = CALLS["n"]
        paths = g.forward(state, beam=1, max_steps=8, greedy=True)
        best = paths[0]
        records.append({"round": i, "task": fam, "ok": bool(best.ok),
                        "calls": CALLS["n"] - c0, "path": "->".join(best.nodes)})
    return {"records": records, "calls": CALLS["n"],
            "ok": sum(1 for r in records if r["ok"]), "total": len(records)}


def fmt_arm(name: str, res: dict, indent: str = "  ") -> str:
    lines = [f"{indent}== {name}: ok {res['ok']}/{res['total']} "
             f"({res['ok'] / max(1, res['total']):.0%}) calls={res['calls']}"]
    skill = res.get("skill")
    if skill:
        lines.append(f"{indent}  skill(首成/3连/seen/ok/calls):")
        for fam, d in sorted(skill.items()):
            lines.append(f"{indent}    {fam:<9} first={d['first_ok']} "
                         f"streak3={d['streak3']} seen={d['seen']} "
                         f"ok={d['ok']} calls={d['calls']}")
    return "\n".join(lines)


def run_compare(args) -> None:
    from dataset import EVAL_TASKS, TRAIN_TASKS
    tasks = [TRAIN_TASKS[i % len(TRAIN_TASKS)] for i in range(args.train_rounds)]
    print(f"train rounds={len(tasks)} (dataset {len(TRAIN_TASKS)} samples "
          f"循环至 {args.train_rounds}) | beam={args.beam} | seed={args.seed}")

    print("\n----- arm 1/5: heuristic (10行硬编码路由，不训练) -----")
    h = arm_heuristic(tasks, "heuristic")
    print(fmt_arm("heuristic", h))

    print("\n----- arm 2/5: contract_only (声明即调度器，零学习零随机) -----")
    c = arm_contract(tasks)
    print(fmt_arm("contract_only", c))

    print("\n----- arm 3/5: untrained random graph (只 forward，不训练) -----")
    g_u, u = arm_graph(tasks, args.seed, args.beam, "untrained", train=False)
    print(fmt_arm("untrained", u))

    print("\n----- arm 4/5: trained graph (契约门控 + REINFORCE + 演化) -----")
    g_t, t = arm_graph(tasks, args.seed, args.beam, "trained", train=True)
    print(fmt_arm("trained", t))

    if args.skills:
        print("\n----- arm 5/5: trained + skills (teacher 宏 + 宏优先路由) -----")
        g_s, s = arm_skills(tasks, args.seed, args.beam, h["records"])
        print(fmt_arm("trained_skills", s))

    print("\n----- held-out eval (dataset.py EVAL_TASKS, greedy pass@1) -----")
    he = evaluate(None, EVAL_TASKS, "heuristic")
    ce = evaluate(None, EVAL_TASKS, "contract_only")
    ue = evaluate(g_u, EVAL_TASKS, "untrained")
    te = evaluate(g_t, EVAL_TASKS, "trained")
    evals = {"heuristic": he, "contract_only": ce, "untrained": ue, "trained": te}
    if args.skills:
        # 技能臂 held-out：宏优先 + 探索（skills=True 但 teacher 复用已学宏）
        LIBRARY.macros.clear()
        for f, md in s["library"].items():
            LIBRARY.macros[f] = SkillMacro(f, md["path"], tuple(md["anchor"]),
                                           md["calls"], md["round"])
        CALLS["n"] = 0
        se_records = []
        for i, t in enumerate(EVAL_TASKS, 1):
            desc_txt = desc_full(t)
            state = initial_state(t["type"], desc_txt, WORKDIR, t["spec"])
            if os.path.exists(state["path"]):
                os.remove(state["path"])
            c0 = CALLS["n"]
            m = LIBRARY.match(t["type"], embed(desc_txt))
            if m is not None:
                s0, mc, run = execute_macro(state, m, g_s)
                ok = bool(s0 is not None and s0.get("ok"))
                if not ok:
                    LIBRARY.note_fail(m)
            else:
                paths = g_s.forward(state, beam=1, max_steps=8, greedy=True)
                best = paths[0]
                s0, mc, run, ok = best.state, 0, best.nodes, bool(best.ok)
            se_records.append({"round": i, "task": t["type"], "ok": ok,
                               "calls": CALLS["n"] - c0, "path": "->".join(run)})
        se = {"records": se_records, "calls": CALLS["n"],
              "ok": sum(1 for r in se_records if r["ok"]),
              "total": len(se_records)}
        evals["trained_skills"] = se
    for name, res in evals.items():
        print(fmt_arm(name, res))

    checkpoint(g_t, final_ckpt)
    result = {
        "ts": RUN_TS, "seed": args.seed, "beam": args.beam,
        "train_rounds": args.train_rounds,
        "train": {"heuristic": h, "contract_only": c, "untrained": u, "trained": t,
                  **({"trained_skills": s} if args.skills else {})},
        "eval": evals,
        "final_graph": g_t.snapshot(),
    }
    path = os.path.join(OUT, f"v2_compare_{RUN_TS}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    print(f"\nresult -> {path}")
    print(f"logs -> {os.path.basename(obs_log)} / {os.path.basename(event_log)}")


# ---------------- checkpoint ----------------

def checkpoint(g: GraphEngine, path: str) -> None:
    data = {"graph": g.to_dict(),
            "prompts": {nid: inst.prompt for nid, inst in llm_instances.items()},
            "ts": time.time()}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def build_node_pool_from_disk(data: dict, arm: str) -> dict:
    """重建节点函数池；契约由 to_dict 序列化恢复（from_dict 内回填）。"""
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
            if nid in llm_instances:
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
            inst = make_llm(nid, role, arm)
            fn = chapter_fn(inst) if role == "chapter" else field_setter(inst, ROLE_FIELD[role])
            pool[nid] = (fn, kind)
    return pool


def load_checkpoint(path: str, arm: str) -> GraphEngine:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    g = GraphEngine.from_dict(data["graph"], build_node_pool_from_disk(data, arm),
                        entry_fn=lambda s: dict(s), exit_fn=exit_fn)
    for nid, p in data.get("prompts", {}).items():
        if nid in llm_instances:
            llm_instances[nid].set_prompt(p)
    return g


# ---------------- 主流程 ----------------

MODELS: list[str] | None = None
LLM_TIMEOUT = 60  # 节点单次 LLM 超时（秒）：v2 实测 25s 会把长章节生成误杀成死路


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--compare", action="store_true",
                    help="三臂对照实验（heuristic vs untrained vs trained）")
    ap.add_argument("--smoke", action="store_true",
                    help="离线冒烟：stub LLM 跑通三臂管线（零网络）")
    ap.add_argument("--train_rounds", type=int, default=33,
                    help="训练臂轮数（默认 33 = dataset 11 样本 × 3）")
    ap.add_argument("--beam", type=int, default=2, help="rollouts per round")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--models", default="",
                    help="固定模型列表，逗号分隔（平稳性；默认 fallback 链全模型）")
    ap.add_argument("--llm_timeout", type=int, default=60,
                    help="节点单次 LLM 超时秒数（默认 60；长文生成需 >25）")
    ap.add_argument("--resume", default="", help="从 checkpoint 恢复图继续训练")
    ap.add_argument("--skills", action="store_true",
                    help="第 4 臂：teacher 技能宏 + 宏优先路由（阶段 B1）")
    ap.add_argument("--macro_threshold", type=float, default=0.6,
                    help="宏检索余弦阈值（相似≠可用；弃权回退探索）")
    args = ap.parse_args()
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    global MODELS, API, LLM_TIMEOUT
    LLM_TIMEOUT = args.llm_timeout
    LIBRARY.threshold = args.macro_threshold
    if args.models:
        MODELS = [m.strip() for m in args.models.split(",") if m.strip()]
    if args.smoke:
        API = ("", "", "")  # stub LLM：payload.upper()，零网络
        print("SMOKE mode: LLM = deterministic stub (no network)")
    elif not API[0]:  # 只看 base：匿名网关 key 可为空（kilo_gateway）
        print("ERROR: no LLM credentials (env LLM_BASE_URL/LLM_KEY or fallback_chain PROVIDERS).")
        return
    print(f"LLM: {API[0] or '(stub)'} model={API[2]} models_pinned={MODELS}")
    print(f"workdir={WORKDIR} | logs: {os.path.basename(obs_log)} / "
          f"{os.path.basename(event_log)} / {os.path.basename(prompt_log)}")

    if args.resume:
        g = load_checkpoint(args.resume, "trained")
        print(f"resumed graph: {g.snapshot()}")
        return

    if args.compare or args.smoke:
        run_compare(args)
        return
    ap.print_help()


if __name__ == "__main__":
    main()

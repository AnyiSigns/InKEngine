"""域层节点函数库：有用算子、噪声/伪装/中性干扰节点。

（LLM 节点适配器已拆至 adapters/llm_adapter.py = LLMAdapter，原 LLMNode。）

节点函数签名统一：func(state: dict) -> dict | None
  - state["payload"]：当前数据（元组或字符串或数字）
  - 返回 None = 该节点无法处理当前类型的数据（死路，路径失败）
  - 返回 dict = 变换后的新状态
"""

from __future__ import annotations

from llm_adapter import LLMAdapter

# ---------------- 有用算子（类型门控） ----------------
# 注：entry/exit 不在节点库中（各域自行构造：main.py 用 lambda 验收、
# agent_demo 用 accept()），这里只放可复用的变换算子。

def _add(state):
    p = state["payload"]
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, int) for x in p):
        return {**state, "payload": p[0] + p[1]}
    return None


def _mul(state):
    p = state["payload"]
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, int) for x in p):
        return {**state, "payload": p[0] * p[1]}
    return None


def _double(state):
    p = state["payload"]
    if isinstance(p, int):
        return {**state, "payload": p * 2}
    return None


def _upper(state):
    p = state["payload"]
    if isinstance(p, str):
        return {**state, "payload": p.upper()}
    return None


def _reverse(state):
    p = state["payload"]
    if isinstance(p, str):
        return {**state, "payload": p[::-1]}
    return None


def _concat(state):
    p = state["payload"]
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, str) for x in p):
        return {**state, "payload": p[0] + p[1]}
    return None


# ---------------- 干扰节点 ----------------

def _fake_add(state):  # 伪装者：声称会加法，实际 +1（迷惑路由）
    p = state["payload"]
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, int) for x in p):
        return {**state, "payload": p[0] + p[1] + 1}
    return None


def _fake_upper(state):  # 伪装者：声称大写，实际小写
    p = state["payload"]
    if isinstance(p, str):
        return {**state, "payload": p.lower()}
    return None


def _noise(state):  # 噪声：随机破坏数据，直接死路
    return None


def _pass_(state):  # 中性：原样通过但消耗步数
    return dict(state)


def feature(state) -> str:
    """输入特征提取：条件路由的观察（LLM 注意力的类比）。

    路由边权重按此特征分裂，使 entry 能按输入形态分流到正确的算子族。
    str 进一步分裂为大小写形态：upper_reverse 验收失败弹回时 payload 已是
    全大写，exit 在该特征下应路由到 reverse；若只按 str 分流则无法区分
    "需要 reverse" 与 "已经 upper 过"，形成次优吸引子。
    """
    p = state.get("payload")
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, int) for x in p):
        return "int_pair"
    if isinstance(p, tuple) and len(p) == 2 and all(isinstance(x, str) for x in p):
        return "str_pair"
    if isinstance(p, int):
        return "int"
    if isinstance(p, str):
        return "upper_str" if p.isupper() else "lower_str"
    return "other"


# ---------------- 节点库组装 ----------------

def build_node_pool(llm: bool = False) -> dict[str, tuple[object, str]]:
    """返回 {id: (func, kind)}。17 节点：6 有用算子、2 伪装、3 噪声、4 中性、entry/exit。"""
    pool: dict[str, tuple[object, str]] = {
        "add": (_add, "function"),
        "mul": (_mul, "function"),
        "double": (_double, "function"),
        "upper": (_upper, "function"),
        "reverse": (_reverse, "function"),
        "concat": (_concat, "function"),
        "fake_add": (_fake_add, "fake"),
        "fake_upper": (_fake_upper, "fake"),
        "noise_a": (_noise, "noise"),
        "noise_b": (_noise, "noise"),
        "noise_c": (_noise, "noise"),
        "pass_1": (_pass_, "pass"),
        "pass_2": (_pass_, "pass"),
        "pass_3": (_pass_, "pass"),
        "pass_4": (_pass_, "pass"),
    }
    if llm:
        pool["llm"] = (LLMAdapter(), "llm")
    return pool


# 各任务类型的最短正确路径（对照参考，训练器不用它，仅用于报告验证）
# 注：exit 是验收门，验收未过会弹回图继续变换；但直接串联（如 add->double）
# 往往比"验收失败再弹回"更短，图训练中会自行发现两者并偏好更短的。
OPTIMAL = {
    "add": ["entry", "add", "exit"],
    "add_double": ["entry", "add", "double", "exit"],
    "double_direct": ["entry", "double", "exit"],
    "upper": ["entry", "upper", "exit"],
    "upper_reverse": ["entry", "upper", "reverse", "exit"],
    "concat": ["entry", "concat", "exit"],
}

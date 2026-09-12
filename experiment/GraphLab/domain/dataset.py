"""Graph training set -- the analogue of a model training set for the graph.

Each sample: a natural-language task description + acceptance spec.
TRAIN: diverse samples covering 5 task families (code/novel/article/translate/math).
EVAL: held-out samples in the SAME families but unseen descriptions -- measures
      whether the graph learned family-level routing policy (generalization)
      instead of memorizing specific task strings.

Used by agent_demo --dataset mode: pretrain samples TRAIN repeatedly, then
evaluate on EVAL (generalization metric).

Acceptance (production-grade): code samples run REAL executable tests
(exec + required function definitions); text samples use deterministic checks.
"""

from __future__ import annotations

TRAIN_TASKS: list[dict] = [
    # ---- code（验收：真实执行 + 指定函数存在）----
    {"type": "code", "desc": "写一个 Python 计算器：实现 add/sub/mul/div 四个函数",
     "file": "calc.py", "spec": {"fns": ["add", "sub", "mul", "div"]}},
    {"type": "code", "desc": "写一个 Python 脚本：实现 count_chars 函数，统计字符串中每个字符出现次数",
     "file": "count.py", "spec": {"fns": ["count_chars"]}},
    {"type": "code", "desc": "写一个 Python 脚本：实现 fibonacci 函数，返回第 n 个斐波那契数",
     "file": "fib.py", "spec": {"fns": ["fibonacci"]}},
    # ---- novel（验收：章节数 + 总字数）----
    {"type": "novel", "desc": "写一篇短篇小说《雾中灯塔》的第一章和第二章",
     "file": "novel.txt", "spec": {"chapters": 2, "min_chars": 200}},
    {"type": "novel", "desc": "写一篇短篇小说《星空下》的第一章和第二章",
     "file": "star.txt", "spec": {"chapters": 2, "min_chars": 200}},
    # ---- article ----
    {"type": "article", "desc": "写一篇关于人工智能未来的短文",
     "file": "ai.txt", "spec": {"min_chars": 150}},
    {"type": "article", "desc": "写一篇关于如何养成阅读习惯的短文",
     "file": "read.txt", "spec": {"min_chars": 150}},
    # ---- translate ----
    {"type": "translate", "desc": "把这句话翻译成英文：今天天气很好，我们去公园散步吧",
     "file": "t1.txt", "spec": {}},
    {"type": "translate", "desc": "把这句话翻译成英文：知识就是力量",
     "file": "t2.txt", "spec": {}},
    # ---- math ----
    {"type": "math", "desc": "解方程 2x + 5 = 17，给出步骤",
     "file": "m1.txt", "spec": {"has_x": True}},
    {"type": "math", "desc": "解方程 3x - 7 = 8，给出步骤",
     "file": "m2.txt", "spec": {"has_x": True}},
]

EVAL_TASKS: list[dict] = [
    # held-out：同族、未见描述 —— 泛化指标
    {"type": "code", "desc": "写一个 Python 脚本：实现 gcd 函数，计算两个数的最大公约数",
     "file": "gcd.py", "spec": {"fns": ["gcd"]}},
    {"type": "novel", "desc": "写一篇短篇小说《雨夜》的第一章和第二章",
     "file": "rain.txt", "spec": {"chapters": 2, "min_chars": 200}},
    {"type": "article", "desc": "写一篇关于旅行的意义的短文",
     "file": "trip.txt", "spec": {"min_chars": 150}},
    {"type": "translate", "desc": "把这句话翻译成英文：他每天都坚持跑步",
     "file": "t3.txt", "spec": {}},
    {"type": "math", "desc": "解方程 5x + 3 = 28，给出步骤",
     "file": "m3.txt", "spec": {"has_x": True}},
]

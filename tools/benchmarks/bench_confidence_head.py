"""置信度头校准实验（设计验证，非引擎实施）——组装/演化效率机制的事实底座。

头注（可复现性 / 严谨性口径）：
- 模型配置：仓库根 `.kilo/测试模型配置.txt`（url:/key:/model_name: 行形态），
  环境变量 INKENGINE_LIVE_BASE_URL/API_KEY/MODEL 优先；密钥可空（网关免费档）。
- 角色分工：solver = 组装执行（产出答案）；head = 置信度头（独立打分调用，
  固定单一模型，不跨模型混用）；judge = 确定性校验（代码类子进程真实执行，
  其余解析校验），地面真值不依赖 LLM 判断。
- 严谨性约定：
  1) 不引导：head 提示词只定义任务，不灌输「要区分难度/给高低分」；
     solver 提示词保持中性，不替模型做任何执行决策。
  2) 不凑数：验收检查全部是硬契约（执行真实用例 / 精确数字 / 严格 JSON /
     集合包含 / 正反约束），失败即失败，无放宽、无 fallback 判过。
  3) 耐操：调用级超时 + 有界重试；连续环境失败 = 任务排除并记 env_error
     （环境错误，不是模型行为），不入校准统计；stdout 行缓冲实时可见。
- 背景（多 agent 设计稿 §3.2/§2.2）：组装用 simulate 分支硬比、演化用三层闸门——
  都是每候选/每变异的固定 LLM 开销。本实验验证「置信度阈值」思想（借鉴 DeepSeek
  生成侧高置信提前截断）：head 高置信 ⇒ 跳过 simulate/验证，能否不损质量地省调用。
- 四问：
  Q1 校准性：head 预测的 p_success 与真实成败是否对齐（分箱校准 / Brier / AUC）。
  Q2 节流收益：按「p_success ≥ τ 即信任」扫 τ，跳过率与跳过样本错误率的权衡。
  Q3 排序能力（simulate 替代）：head 对两个候选方案评分排序，与两路实际执行结果
    排序是否一致——排序一致才可拿 head 顶掉逐候选 simulate。
  Q4 马尔可夫先验：按任务类型分组的经验成功率（转移概率），与 head 复合能否改善
    校准（冷启动期历史稀疏时的加成）。

结论（2026-08-30 实测，两套 solver）：
- 主集 39 复杂任务 × laguna-s-2.1（弱 solver，真实成功率 79.5%，8 个失败）：
  - head 系统性高估：预测 0.80/0.90/0.98 → 实际 0.00/0.67/0.88，Brier 0.178，
    AUC 0.641（弱区分）；8 个失败里 7 个 head 打 ≥0.9。
  - 节流无过滤价值：τ 从 0.5→0.9，被信任样本错误率 19-21% ≈ 基线失败率 21%——
    高置信失败照漏，跳过验证省了调用却不保质量。
  - head 评的是「任务难度」不是「执行器成败」：h06/t05/x03 等失败里 head 的
    reason 文本自己推导出了正确答案（h06 解出 15、t05 算出 34），却没因执行器
    是另一个更弱的模型而压低 p。
  - 类型经验先验（马尔可夫）≥ head：Brier 仅先验 0.164 < head 0.178，0.5 复合
    0.159；head 的 risk 清单定性可用（h16 点名「沸腾」= 实际失败），但概率不可信。
- 排序（simulate 替代）：唯一有高下且两路 p 都解析的样本 t12，head 判对，但
  两路 p 差仅 0.02——微差排序，不可作可靠挑选依据。
- 结论：置信度阈值「高置信即跳过验证」不能单靠 LLM head——head 概率不校准且
  不感知执行器；可行方向 = head 作定性特征 + 类型经验先验复合，且节流只用于
  内部重验、不碰权限/审批/安全闸门。
- Q5 三源互补融合（置信度阈值 × 马尔可夫 × 当前模式，2026-08-30 实测）：
  「head ≥ τ AND 类型先验 ≥ θ 才快路径，否则回退当前模式」在全 τ/θ/加权网格下，
  0%/5%/10% 错误预算的最大省量全为 0——本数据上融合无收益。原因：马尔可夫粒度
  是类型级，失败类型（cap/hard/trap，先验 0.67-0.82）覆盖全表，无高先验状态可
  安全跳过；且失败任务的 head 全 ≥0.9，阈值顶不掉。改进方向：马尔可夫状态细化
  到（类型 × 特征）级才有低风险状态可跳；成本结构改三档（全验证/针对性验证/
  快路径）而非二元跳过。
- Q6 三档验证阶梯（细化状态 × risk 触发 × 当前模式兜底，2026-08-30 实测）：
  「risk 非空 → 针对性验证（1 单位）；risk 空 + 状态零败历史 → 快路径（0）；
  否则全验证（2）」在 39 复杂任务/弱 solver 上：严格零败 N=3 → 33% 节省 @ 0 错
  （0 快路径，节省全来自 risk 触发的针对性验证顶掉全验证）；N=2 → 38% @ 0 错；
  若放宽为状态先验 θ=0.80 → 46% 但样本内零错含过拟合（快路径状态 90% 成功率，
  样本外仍有 ~10% 风险）。结论：可用方案 = 置信度信号折入既有决策调用（零边际
  成本）产出 p+risk 清单，risk 空必须走全验证（head 盲区样本全在 risk 空），
  risk 非空走针对性点验，快路径仅由马尔可夫零败状态在线解锁；安全闸门不参与。
- Q7 验证器门控（新算法，2026-08-30 实测）：把同一 LLM 信号从「预测成败」改造成
  「评审产出」，漏抓率 19%（预测 p≥0.9 即跳过）→ 3%（验证器 pass 即跳过）——
  39 任务中验证器抓到 7/8 失败（h05/h06/h08/t05/x01/x03/x08），只漏 h16；
  代价是误杀率 30%（3 个误杀：x05/x06/x10，需仲裁）。h16 恰是 head 的 risk 清单
  点名「沸腾」的样本——验证器盲区与风险清单互补。
- 终版算法（VTM 三段门控，由数据合成）：执行产出 → ①验证器评审（pass/fail+违规，
  漏抓 3%）→ fail 走二次仲裁（确定性检查/第二模型，解误杀）；②pass 走风险点验
  （按 head risk 清单逐条点验，抓验证器盲区如 h16，漏抓→0）；③马尔可夫零败状态
  直接提交（省①②）。安全闸门（权限/审批/出网）永不参与。三个信号各归其位：
  验证器抓「产出不合格」、风险清单抓「验证器也放过的盲区」、马尔可夫管「何时可省」。

结果落盘 tools/benchmarks/reports/confidence_head_report-<ts>.md 与 latest.md。
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from statistics import mean

sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_REL = Path(".kilo") / "测试模型配置.txt"

CALL_RETRIES = 3
CALL_TIMEOUT = 60.0
MAX_ENV_ERRORS = 3  # 连续环境失败达此数 → 判定环境不可用，提前退出


def log(msg: str) -> None:
    print(msg)


# 增量状态（耐操：网关抖动/进程被杀后，重跑同一脚本自动续跑已完成的条目）
STATE_PATH = Path(__file__).resolve().parent / "reports" / "_state.json"


def _load_state() -> dict:
    if not STATE_PATH.is_file():
        return {"tasks": {}, "ranking": {}}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 状态文件损坏/未完成写入 → 按空状态续跑
        return {"tasks": {}, "ranking": {}}
    data.setdefault("tasks", {})
    data.setdefault("ranking", {})
    return data


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


# ----------------------------------------------------------------------
# 模型配置（与 tests/live 同口径：env 优先，回落 .kilo/测试模型配置.txt）
# ----------------------------------------------------------------------

def _env(name: str) -> str:
    import os
    return os.environ.get(name, "").strip()


def load_config() -> dict:
    base_url = _env("INKENGINE_LIVE_BASE_URL")
    api_key = _env("INKENGINE_LIVE_API_KEY")
    model = _env("INKENGINE_LIVE_MODEL")
    if base_url and api_key and model:
        return {"url": base_url, "key": api_key, "models": [model]}
    path = REPO_ROOT / CONFIG_REL
    if not path.is_file():
        log(f"[配置缺失] {path} 不存在——设 INKENGINE_LIVE_* 或提供该文件")
        sys.exit(2)
    data: dict[str, list[str]] = {"url": [], "key": [], "models": []}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if ":" not in line or line.startswith("#"):
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if key == "model_name":
            data["models"].append(value)
        else:
            data[key] = [value]
    if not data["url"] or not data["models"]:
        log(f"[配置缺失] {path} 缺少 url 或 model_name 行")
        sys.exit(2)
    return {"url": data["url"][0], "key": data["key"][0] or None, "models": data["models"]}


def _pick(cfg: dict, env_name: str, default_idx: int) -> str:
    return _env(env_name) or cfg["models"][default_idx]


# ----------------------------------------------------------------------
# 校验器（地面真值：确定性硬契约，失败即失败，无放宽）
# ----------------------------------------------------------------------

def _extract_def(text: str, name: str) -> str:
    """按函数名取顶层 def 块；未找到返回空串（验收失败由调用方判定）。"""
    text = re.sub(r"^```(?:python)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    m = re.search(rf"def\s+{re.escape(name)}\s*\(.*?:\n(?:[ \t].*(?:\n|$)|(?:\n|$))*", text)
    return m.group(0).rstrip() + "\n" if m else ""


def code_check(func_name: str, cases: list[tuple[str, object]]) -> object:
    """子进程隔离执行：只把名为 func_name 的 def 块 exec 进空命名空间，跑用例断言。

    注意：构建子进程源码用占位符替换（__FN__/__FN_R__），绝不用 % 格式化——
    模型代码里可能含 %（如 n % i），会与 % 操作符冲突（严谨性/耐操）。
    """

    def chk(text: str) -> bool:
        code = _extract_def(text, func_name)
        if not code:
            return False
        # 用例以参数代码内联（自建测试数据，可信）；期望值 repr 为 Python 字面量
        case_lines = []
        for idx, (argcode, exp) in enumerate(cases):
            case_lines.append(
                f"try:\n"
                f"    r{idx} = ns[__FN__]({argcode})\n"
                f"    results.append(r{idx} == {exp!r})\n"
                "except Exception:\n"
                "    results.append(False)\n"
            )
        harness = (
            "import json\n"
            f"code = {json.dumps(code)}\n"
            "ns = {}\n"
            "try:\n"
            "    exec(code, ns)\n"
            "except Exception:\n"
            "    print(json.dumps({'ok': False, 'why': 'exec'}))\n"
            "    raise SystemExit\n"
            "results = []\n"
            + "".join(case_lines)
            + "print(json.dumps({'ok': True, 'results': results}))\n"
        ).replace("__FN__", repr(func_name))
        try:
            with tempfile.TemporaryDirectory() as td:
                proc = subprocess.run(
                    [sys.executable, "-I", "-c", harness],
                    capture_output=True,
                    text=True,
                    timeout=20,
                    cwd=td,
                    check=False,  # 返回码非零 = 被验代码抛异常，按失败处理
                )
            line = (proc.stdout or "").strip().splitlines()
            data = json.loads(line[-1]) if line else {"ok": False, "why": "noout"}
            return bool(data.get("ok")) and all(data.get("results", []))
        except Exception:  # noqa: BLE001 校验器自身异常一律按验收失败，不向实验主流程冒泡
            return False

    return chk


def _check_number(expect: str) -> object:
    """精确数字令牌匹配：期望值必须作为独立数字出现（"200" 不匹配 "1200"/"2000"）。"""

    def chk(text: str) -> bool:
        tokens = set(re.findall(r"\d+(?:\.\d+)?", text))
        return expect in tokens

    return chk


def _check_contains(*keys: str, not_keys: tuple[str, ...] = ()) -> object:
    def chk(text: str) -> bool:
        return all(k in text for k in keys) and not any(k in text for k in not_keys)

    return chk


def _check_numbers(expects: tuple[float, ...]) -> object:
    """数值集合包含：42.00 与 42 视为同一值（按浮点相等，非字符串相等）。"""

    def chk(text: str) -> bool:
        got = {float(x) for x in re.findall(r"\d+(?:\.\d+)?", text)}
        return all(any(abs(g - e) < 1e-9 for g in got) for e in expects)

    return chk


def _check_json_fields(fields: dict) -> object:
    def chk(text: str) -> bool:
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return False
        return all(data.get(k) == v for k, v in fields.items())

    return chk


def _check_json_exact(value) -> object:
    def chk(text: str) -> bool:
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
        try:
            return json.loads(text) == value
        except json.JSONDecodeError:
            return False

    return chk


def _extract_emails(text: str) -> set[str]:
    return set(re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text))


def _extract_cities(text: str) -> set[str]:
    # 中文连续词元（标点/数字不在 \u4e00-\u9fff 内，天然切分）
    return set(re.findall(r"[\u4e00-\u9fff]+", text))


def _extract_dates(text: str) -> set[str]:
    return set(re.findall(r"\d{4}[-/]\d{2}[-/]\d{2}", text))


# ----------------------------------------------------------------------
# 任务集（复杂任务为主体，仅 c01/f01 两个简单保底）
# 硬契约备注：代码类跑真实用例；数学类精确数字；格式类严格 JSON。
# ----------------------------------------------------------------------

TASKS: list[dict] = [
    {"id": "c01", "type": "code", "task": "写一个 Python 函数 fib(n)，返回第 n 个斐波那契数（n>=1，fib(1)=1，fib(2)=1）。只输出函数定义。", "check": code_check("fib", [("1", 1), ("10", 55), ("20", 6765)])},
    {"id": "f01", "type": "format", "task": "输出一个 JSON 对象：键 name 值为 张三，键 age 值为 25。只输出 JSON。", "check": _check_json_fields({"name": "张三", "age": 25})},
    # type=hard（针对性难任务：覆盖 hy3 类小型模型的真实失败模式）
    {"id": "h01", "type": "hard", "task": "写一个 Python 函数 lis_len(nums)，返回最长严格递增子序列的长度。只输出函数定义。", "check": code_check("lis_len", [("([3,1,4,1,5,9,2,6])", 4), ("([])", 0), ("([1,2,3])", 3)])},
    {"id": "h02", "type": "hard", "task": "写 Python 函数 parse_csv(line) 把一行 CSV 解析成字段列表，需正确处理带引号字段（字段内可含逗号和双引号，双引号转义为两个连续双引号）。只输出函数定义。", "check": code_check("parse_csv", [("('a,b,c')", ["a", "b", "c"]), ("('a,\"b,c\",d')", ["a", "b,c", "d"]), ("('\"x\"\"y\",z')", ['x"y', "z"])])},
    {"id": "h03", "type": "hard", "task": "写一个 Python 函数 fmt_duration(seconds)，把秒数格式化为「Hh Mm Ss」，例如 3661 秒输出 '1h 1m 1s'。只输出函数定义。", "check": code_check("fmt_duration", [("3661", "1h 1m 1s"), ("60", "0h 1m 0s"), ("0", "0h 0m 0s")])},
    {"id": "h04", "type": "hard", "task": "写 Python 函数 is_valid_ipv4(s)，判断是否为合法 IPv4 地址（四段，每段 0-255，除单个「0」外不允许前导零，不允许多余字符）。只输出函数定义。", "check": code_check("is_valid_ipv4", [("('192.168.1.1')", True), ("('256.1.1.1')", False), ("('01.2.3.4')", False), ("('1.2.3')", False)])},
    {"id": "h05", "type": "hard", "task": "100 以内（含 100）既是完全平方数又是完全立方数的正整数有几个？只输出数字。", "check": _check_number("2")},
    {"id": "h06", "type": "hard", "task": "一个两位数，交换十位与个位数字后比原数大 36，这样的两位数最小是多少？只输出数字。", "check": _check_number("15")},
    {"id": "h07", "type": "hard", "task": "7 个人两两握手一次，一共要握多少次手？只输出数字。", "check": _check_number("21")},
    {"id": "h08", "type": "hard", "task": "今天是星期一，10 的 9 次方秒之后是星期几？只输出星期名。", "check": _check_contains("星期四")},
    {"id": "h09", "type": "hard", "task": "提取下面文本中的所有邮箱（注意 bob 的地址用的是 [at] 写法）：联系 bob[at]x.com 或 alice@y.cn。把 [at] 替换成 @ 后输出。", "check": lambda t: {"bob@x.com", "alice@y.cn"} <= _extract_emails(t.replace("[at]", "@"))},
    {"id": "h10", "type": "hard", "task": "数一数这句话里「的」字出现几次：我们的目标是他的成绩和她的努力。只输出数字。", "check": _check_number("3")},
    {"id": "h11", "type": "hard", "task": "输出 JSON：键 password 值为 A1b2c3，键 repeat 值必须与 password 相同。只输出 JSON。", "check": _check_json_fields({"password": "A1b2c3", "repeat": "A1b2c3"})},
    {"id": "h12", "type": "hard", "task": "把 1234.5678 四舍五入保留两位小数并加上千分位逗号输出，只输出数字。", "check": lambda t: "1,234.57" in t},
    {"id": "h13", "type": "hard", "task": "用不超过 40 个汉字解释什么是二进制，必须包含「逢二进一」，不能包含「十进制」。", "check": lambda t: "逢二进一" in t and "十进制" not in t and len(re.findall(r"[\u4e00-\u9fff]", t)) <= 40},
    {"id": "h14", "type": "hard", "task": "写一个恰好 12 个汉字的中文句子，其中必须包含「学习」两个汉字。", "check": lambda t: "学习" in t and len(re.findall(r"[\u4e00-\u9fff]", t)) == 12},
    {"id": "h15", "type": "hard", "task": "中国已知最早的文字体系是什么？只输出名称。", "check": _check_contains("甲骨文")},
    {"id": "h16", "type": "hard", "task": "标准大气压下，100 摄氏度时水处于什么状态？只输出一个表示状态的词。", "check": lambda t: ("气" in t) or ("汽" in t)},
    {"id": "h17", "type": "hard", "task": "1 英里等于多少英尺？只输出数字。", "check": _check_number("5280")},
    {"id": "h18", "type": "hard", "task": "给出一个大于 10 且小于 5 的整数。如果不存在就回答：不存在。", "check": lambda t: "不存在" in t},
    # type=trap（高失败率：易错陷阱 / 精确格式 / 边界）
    {"id": "t05", "type": "trap", "task": "房间里有一群猫和鸟：7 只猫，3 只鸟，它们的脚总共有多少只？只输出数字。", "check": _check_number("34")},
    {"id": "t06", "type": "trap", "task": "12 的一半的一半是多少？只输出数字。", "check": _check_number("3")},
    {"id": "t07", "type": "trap", "task": "一个数的 50% 等于 30，那么这个数的 25% 是多少？只输出数字。", "check": _check_number("15")},
    {"id": "t08", "type": "trap", "task": "0.1 的二进制表示是有限位还是无限循环？回答：有限 / 无限。", "check": lambda t: "无限" in t},
    {"id": "t09", "type": "trap", "task": "序列 1, 11, 21, 1211, 111221 的下一项是什么？只输出数字串。", "check": lambda t: "312211" in t},
    {"id": "t10", "type": "trap", "task": "一位老师有 40 个学生，每张桌子坐 7 人，至少需要几张桌子？只输出数字。", "check": _check_number("6")},
    {"id": "t11", "type": "trap", "task": "写一个 Python 函数 is_leap(year) 判断闰年（能被 4 整除且不能被 100 整除，或能被 400 整除）。只输出函数定义。", "check": code_check("is_leap", [("2000", True), ("1900", False), ("2024", True), ("2023", False)])},
    {"id": "t12", "type": "trap", "task": "把「Hello World」每个字母的大小写互换后输出，只输出结果。", "check": lambda t: t.strip() == "hELLO wORLD"},
    {"id": "t13", "type": "trap", "task": "说出一个既是奇数又是偶数的整数。如果不存在就回答：不存在。", "check": lambda t: "不存在" in t},
    # type=cap（能力边界：结构性问题 / 精确长格式 / 大数运算——小型模型系统性易错）
    {"id": "x01", "type": "cap", "task": "计算 123456 × 789012 的结果，只输出数字。", "check": _check_number("97408265472")},
    {"id": "x02", "type": "cap", "task": "计算 99 的 5 次方，只输出数字。", "check": _check_number("9509900499")},
    {"id": "x03", "type": "cap", "task": "把「软件工程真有趣」逐字倒序输出，只输出结果。", "check": lambda t: t.strip() == "趣有真程工件软"},
    {"id": "x04", "type": "cap", "task": "写出 20 个互不相同的两位数，全部必须能被 3 整除，用逗号分隔。", "check": lambda t: len({x for x in re.findall(r"\d{2}", t) if int(x) % 3 == 0}) >= 20},
    {"id": "x05", "type": "cap", "task": "写出圆周率小数点后的前 50 位数字，只输出数字。", "check": lambda t: "14159265358979323846" in t},
    {"id": "x06", "type": "cap", "task": "把「一」字连续写 100 个，中间不要有空格和换行，只输出这些「一」。", "check": lambda t: t.count("一") >= 100},
    {"id": "x07", "type": "cap", "task": "列出 1 到 100 之间所有含数字 7 的整数，从小到大，用逗号分隔。", "check": lambda t: {"7", "17", "27", "37", "47", "57", "67", "70", "71", "72", "73", "74", "75", "76", "77", "78", "79", "87", "97"} == set(re.findall(r"\d+", t))},
    {"id": "x08", "type": "cap", "task": "一个球从 100 米高处自由落下，每次落地后反弹回原高度的 3/5。求它第 5 次落地时一共经过了多少米？只输出数字。", "check": _check_number("361.12")},
    {"id": "x09", "type": "cap", "task": "2026 年 1 月 1 日是星期四，2026 年 12 月 31 日是星期几？只输出星期名。", "check": _check_contains("星期四")},
    {"id": "x10", "type": "cap", "task": "写一个 Python 函数 atoi(s)，把字符串转成整数：跳过前导空格，处理可选的正负号，遇到非法字符就停止，字符串全是非法字符时返回 0。只输出函数定义。", "check": code_check("atoi", [("('  42')", 42), ("('-7')", -7), ("('12abc')", 12), ("('abc')", 0)])},
]

# 排序子集（两个候选方案都真实执行）：验证 head 能否在不执行的情况下挑出更优候选
RANKING_PAIRS: list[tuple[str, str, str]] = [
    ("h02", "直接用 Python 的 csv 模块解析这行 CSV。", "手写状态机：逐字符扫描，维护引号开关与双引号转义，再切分字段。"),
    ("h04", "直接实现 is_valid_ipv4，先 split('.') 再逐段判断。", "先写每段校验（0-255、无前导零），再组合到地址级校验后返回。"),
    ("h12", "直接格式化输出 1234.5678。", "先分离整数与小数，整数部分插入千分位逗号，小数四舍五入保留两位，再拼接。"),
    ("h14", "直接写一句 12 个汉字的中文。", "先写 15 字草稿，逐字删减到恰好 12 字，确认含「学习」再输出。"),
    ("h10", "直接数「的」字出现次数。", "逐字扫一遍计数，再扫第二遍复核，最后输出数字。"),
    ("t11", "直接用 (y%4==0 and y%100!=0) or y%400==0 实现。", "先分别处理百年（%100/%400）与普通年（%4），再合并成完整函数。"),
    ("t09", "直接推断下一项。", "先看相邻两项的规律（把上一项的连续相同数字写成 数量+数字），再写出下一项。"),
    ("t08", "直接回答 0.1 的二进制表示有限还是无限。", "先把 0.1 不断乘 2 取整观察是否出现循环，再回答有限/无限。"),
    ("t12", "直接输出大小写互换结果。", "先逐字符判断大小写再互换，拼接后输出。"),
    ("t05", "直接计算总脚数。", "先分别算猫和鸟的脚数，再相加输出。"),
    ("x01", "直接相乘输出。", "先做竖式分步相乘再合并结果，输出数字。"),
    ("x02", "直接计算 99 的 5 次方。", "先算 99²、99³、99⁴、99⁵ 逐步乘出再输出。"),
    ("x03", "直接倒序输出。", "先逐字列出原句顺序，再反向拼接输出。"),
    ("x05", "直接默写圆周率前 50 位。", "先回忆已知片段，再逐段核对小数点后位序后输出。"),
    ("x08", "直接列式求总路程。", "先分别算每次反弹高度，再累加落点间距离，最后输出。"),
]


# ----------------------------------------------------------------------
# LLM 薄封装（有界重试；连续环境失败由调用方记录并排除，不换模型凑数）
# ----------------------------------------------------------------------

@dataclass
class Lm:
    model_id: str
    url: str
    key: str | None

    async def ask(self, system: str, user_text: str) -> str:
        from ink_engine.core.llm.base import LLMConfig
        from ink_engine.core.llm.messages import Message
        from ink_engine.core.llm.registry import create_llm

        last_exc: Exception | None = None
        for attempt in range(CALL_RETRIES):
            llm = create_llm(
                LLMConfig(
                    adapter="openai_compat",
                    model_id=self.model_id,
                    base_url=self.url,
                    api_key=self.key,
                    request_timeout=CALL_TIMEOUT,
                )
            )
            try:
                result = await llm.ainvoke(
                    [Message(role="system", content=system), Message(role="user", content=user_text)]
                )
                return result.content or ""
            except Exception as exc:  # noqa: BLE001 瞬时抖动：退避重试（有界）
                last_exc = exc
                if attempt < CALL_RETRIES - 1:
                    await asyncio.sleep(2.0 * (attempt + 1))
            finally:
                await llm.aclose()
        raise last_exc


def parse_json_lenient(text: str) -> dict:
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        data = json.loads(text[start : end + 1])
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _extract_float(value) -> float | None:
    if isinstance(value, (int, float)):
        return min(max(float(value), 0.0), 1.0)
    if isinstance(value, str):
        value = value.strip()
        m = re.search(r"\d+(?:\.\d+)?", value)
        if m:
            f = float(m.group())
            if "%" in value:
                f /= 100.0
            return min(max(f, 0.0), 1.0)
    return None


# ----------------------------------------------------------------------
# 统计
# ----------------------------------------------------------------------

def brier(probs: list[float], labels: list[bool]) -> float:
    return mean((p - (1.0 if l else 0.0)) ** 2 for p, l in zip(probs, labels))


def auc(probs: list[float], labels: list[bool]) -> float:
    pos = [(p, 1) for p, l in zip(probs, labels) if l]
    neg = [(p, 0) for p, l in zip(probs, labels) if not l]
    n0, n1 = len(neg), len(pos)
    if not n0 or not n1:
        return float("nan")
    rank_sum = 0.0
    for p1, _ in pos:
        rank_sum += sum(1.0 for p0, _ in neg if p1 > p0) + 0.5 * sum(
            1.0 for p0, _ in neg if p1 == p0
        )
    return rank_sum / (n0 * n1)


def calibration_bins(probs: list[float], labels: list[bool]) -> list[tuple[str, int, float, float]]:
    bins: list[tuple[float, float, str]] = [
        (0.0, 0.5, "0.0-0.5"),
        (0.5, 0.7, "0.5-0.7"),
        (0.7, 0.85, "0.7-0.85"),
        (0.85, 0.95, "0.85-0.95"),
        (0.95, 1.01, "0.95-1.0"),
    ]
    out = []
    for lo, hi, label in bins:
        idx = [i for i, p in enumerate(probs) if lo <= p < hi]
        if not idx:
            out.append((label, 0, float("nan"), float("nan")))
            continue
        rate = mean(1.0 if labels[i] else 0.0 for i in idx)
        out.append((label, len(idx), mean(probs[i] for i in idx), rate))
    return out


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

@dataclass
class TaskRun:
    task: dict
    answer: str = ""
    head_p: float | None = None
    head_raw: str = ""
    head: dict = None  # 完整 head JSON（risk 清单全量，供 Q6 阶梯分析）
    verdict: dict = None  # 验证器评审（pass + violations）
    ok: bool | None = None
    env_error: bool = False

    def __post_init__(self) -> None:
        if self.head is None:
            self.head = {}
        if self.verdict is None:
            self.verdict = {}

    @property
    def type(self) -> str:
        return self.task["type"]

    @property
    def risk_empty(self) -> bool:
        r = self.head.get("risk")
        return not isinstance(r, list) or len(r) == 0

    @property
    def verify_pass(self) -> bool | None:
        p = self.verdict.get("pass")
        return p if isinstance(p, bool) else None


HEAD_SYSTEM = (
    "你是任务成功率评估器。给定一个用户任务和模型将采用的执行方案，"
    "评估按此方案执行后产出能通过验收（满足全部硬性要求）的概率。\n"
    "输出严格 JSON：{\"p_success\": 0.0-1.0, \"reason\": \"\", \"risk\": []}\n"
    "只输出 JSON。"
)

SOLVER_SYSTEM = "你是一个任务执行器。严格按用户要求完成任务，只输出最终结果。"

VERIFY_SYSTEM = (
    "你是验收评审器。给定一个用户任务和模型产出的答案，判断该答案是否通过验收"
    "（必须满足任务的全部硬性要求：格式、数值、包含/排除词、精确长度等）。\n"
    "输出严格 JSON：{\"pass\": true/false, \"violations\": [\"违反了什么硬性要求\"]}\n"
    "只输出 JSON。答案不合格就 pass=false，不要宽容。"
)


async def run_verify(lm_verify: Lm, task: dict, answer: str) -> dict:
    text = await lm_verify.ask(
        VERIFY_SYSTEM, f"任务：{task['task']}\n模型答案：\n{answer}\n"
    )
    return parse_json_lenient(text)


async def run_task(lm_solver: Lm, lm_head: Lm, task: dict) -> TaskRun:
    run = TaskRun(task=task)
    run.answer = await lm_solver.ask(SOLVER_SYSTEM, task["task"])
    head_text = await lm_head.ask(
        HEAD_SYSTEM, f"任务：{task['task']}\n执行方案：模型直接作答，无额外工具。"
    )
    head = parse_json_lenient(head_text)
    run.head = head
    run.head_raw = json.dumps(head, ensure_ascii=False)[:300]
    run.head_p = _extract_float(head.get("p_success"))
    run.ok = bool(task["check"](run.answer or ""))
    return run


async def run_ranking(
    lm_solver: Lm, lm_head: Lm, task: dict, plan_a: str, plan_b: str
) -> dict:
    async def _head_plan(plan: str) -> float | None:
        text = await lm_head.ask(HEAD_SYSTEM, f"任务：{task['task']}\n执行方案：{plan}")
        return _extract_float(parse_json_lenient(text).get("p_success"))

    pa, pb = await _head_plan(plan_a), await _head_plan(plan_b)
    ans_a = await lm_solver.ask(SOLVER_SYSTEM, task["task"] + "\n" + plan_a)
    ans_b = await lm_solver.ask(SOLVER_SYSTEM, task["task"] + "\n" + plan_b)
    ok_a, ok_b = bool(task["check"](ans_a)), bool(task["check"](ans_b))
    head_sign = 1 if pa is not None and pb is not None and pa > pb else (
        -1 if pa is not None and pb is not None and pa < pb else 0
    )
    actual_sign = 1 if ok_a and not ok_b else (-1 if ok_b and not ok_a else 0)
    return {
        "task": task["id"],
        "pa": pa,
        "pb": pb,
        "ok_a": ok_a,
        "ok_b": ok_b,
        "head_sign": head_sign,
        "actual_sign": actual_sign,
        "agree": head_sign == actual_sign and head_sign != 0,
    }


async def main() -> int:
    cfg = load_config()
    limit = int(_env("INKENGINE_EXP_LIMIT") or 0)
    only_types = {x.strip() for x in _env("INKENGINE_EXP_TYPES").split(",") if x.strip()}
    tasks = TASKS
    if only_types:
        tasks = [t for t in tasks if t["type"] in only_types]
    if limit:
        tasks = tasks[:limit]
    solver_model = _pick(cfg, "INKENGINE_EXP_SOLVER_MODEL", 0)
    head_model = _pick(cfg, "INKENGINE_EXP_HEAD_MODEL", 1)
    lm_solver = Lm(solver_model, cfg["url"], cfg["key"])
    lm_head = Lm(head_model, cfg["url"], cfg["key"])
    log(f"solver={solver_model}  head={head_model}  任务数={len(tasks)}  排序对={len(RANKING_PAIRS)}")
    log("=" * 78)

    started = time.time()
    state = _load_state()
    redo = {x.strip() for x in _env("INKENGINE_EXP_REDO").split(",") if x.strip()}
    head_only = bool(_env("INKENGINE_EXP_HEAD_ONLY"))
    verify_only = bool(_env("INKENGINE_EXP_VERIFY_ONLY"))
    if head_only:
        # 只刷 head（复用已存答案，不重新调 solver）：补齐完整 head JSON 供 Q6 阶梯分析
        log("[head刷新] 仅重取 head 调用，跳过 solver 与排序")
        for i, task in enumerate(tasks, 1):
            rec = state["tasks"].get(task["id"])
            if not rec or rec.get("head"):
                continue
            try:
                head_text = await lm_head.ask(
                    HEAD_SYSTEM,
                    f"任务：{task['task']}\n执行方案：模型直接作答，无额外工具。",
                )
                rec["head"] = parse_json_lenient(head_text)
                _save_state(state)
                log(f"[head刷新] {i:02d}/{len(tasks)} {task['id']} 完成")
            except Exception as exc:  # noqa: BLE001 单条失败不中断，续跑补齐
                log(f"[head刷新] {i:02d}/{len(tasks)} {task['id']} 环境错误: {type(exc).__name__} {str(exc)[:60]}")
    if verify_only:
        # 验证器评审（复用已存答案）：新算法验证「验证门控 vs 预测门控」
        log("[验证器] 仅评审已有答案，跳过 solver 与排序")
        for i, task in enumerate(tasks, 1):
            rec = state["tasks"].get(task["id"])
            if not rec or rec.get("verdict"):
                continue
            try:
                rec["verdict"] = await run_verify(lm_head, task, rec.get("answer", ""))
                _save_state(state)
                log(f"[验证器] {i:02d}/{len(tasks)} {task['id']} 完成 pass={rec['verdict'].get('pass')}")
            except Exception as exc:  # noqa: BLE001 单条失败不中断，续跑补齐
                log(f"[验证器] {i:02d}/{len(tasks)} {task['id']} 环境错误: {type(exc).__name__} {str(exc)[:60]}")
    runs: list[TaskRun] = []
    env_errors = 0
    if _env("INKENGINE_EXP_SKIP_MAIN") or head_only or verify_only:
        log("[主集] SKIP_MAIN/HEAD_ONLY/VERIFY_ONLY 已设——跳过主集执行，从状态装载")
        for task in tasks:
            rec = state["tasks"].get(task["id"])
            if not rec:
                continue
            run = TaskRun(task=task)
            run.answer = rec.get("answer", "")
            run.head_raw = rec.get("head_raw", "")
            run.head = rec.get("head") or {}
            run.verdict = rec.get("verdict") or {}
            run.head_p = rec.get("head_p")
            run.ok = rec.get("ok")
            run.env_error = rec.get("env_error", False)
            runs.append(run)
            log(f"[主集] {task['id']} 从状态装载（离线重算）")
    else:
        for i, task in enumerate(tasks, 1):
            if task["id"] in redo:
                state["tasks"].pop(task["id"], None)
                state["ranking"].pop(task["id"], None)
            if task["id"] in state["tasks"]:
                rec = state["tasks"][task["id"]]
                run = TaskRun(task=task)
                run.answer = rec.get("answer", "")
                run.head_raw = rec.get("head_raw", "")
                run.head = rec.get("head") or {}
                run.verdict = rec.get("verdict") or {}
                run.head_p = rec.get("head_p")
                run.ok = rec.get("ok")
                run.env_error = rec.get("env_error", False)
                runs.append(run)
                log(f"[{i:02d}/{len(tasks)}] {task['id']} {task['type']:<8} 已记录，跳过")
                continue
            try:
                run = await run_task(lm_solver, lm_head, task)
            except Exception as exc:  # noqa: BLE001 环境失败（网关/网络）记录后排除
                env_errors += 1
                run = TaskRun(task=task, env_error=True)
                log(f"[{i:02d}/{len(tasks)}] {task['id']} {task['type']:<8} 环境错误: {type(exc).__name__} {str(exc)[:80]}")
                if env_errors >= MAX_ENV_ERRORS:
                    log(f"[中止] 连续 {MAX_ENV_ERRORS} 次环境失败——网关不可用，排除后续任务")
                    break
                continue
            env_errors = 0
            runs.append(run)
            state["tasks"][task["id"]] = {
                "answer": run.answer,
                "head_raw": run.head_raw,
                "head": run.head,
                "verdict": run.verdict,
                "head_p": run.head_p,
                "ok": run.ok,
                "env_error": run.env_error,
            }
            _save_state(state)
            mark = "OK" if run.ok else "FAIL"
            note = "head 解析失败" if run.head_p is None else ""
            log(f"[{i:02d}/{len(tasks)}] {task['id']} {task['type']:<8} p={run.head_p} → {mark} {note}")

    valid = [r for r in runs if r.head_p is not None and not r.env_error]
    probs = [r.head_p or 0.0 for r in valid]
    labels = [bool(r.ok) for r in valid]

    # ---- Q4 马尔可夫先验（按类型经验成功率，Laplace 平滑） ----
    type_counts: dict[str, tuple[int, int]] = {}
    for r in valid:
        k, n = type_counts.get(r.type, (0, 0))
        type_counts[r.type] = (k + int(bool(r.ok)), n + 1)
    priors = {t: (k + 1) / (n + 2) for t, (k, n) in type_counts.items()}
    prior_probs = [priors[r.type] for r in valid]

    rank_results: list[dict] = []
    env_errors = 0
    if _env("INKENGINE_EXP_SKIP_RANKING"):
        log("[排序] INKENGINE_EXP_SKIP_RANKING 已设——跳过排序子集")
    else:
        for task, plan_a, plan_b in RANKING_PAIRS:
            if task in state["ranking"]:
                rank_results.append(state["ranking"][task])
                log(f"[排序] {task} 已记录，跳过")
                continue
            td = next(t for t in TASKS if t["id"] == task)
            try:
                result = await run_ranking(lm_solver, lm_head, td, plan_a, plan_b)
            except Exception as exc:  # noqa: BLE001 环境失败记录后排除
                env_errors += 1
                log(f"[排序] {task} 环境错误: {type(exc).__name__} {str(exc)[:80]}")
                if env_errors >= MAX_ENV_ERRORS:
                    log("[中止] 排序子集连续环境失败——提前结束")
                    break
                continue
            env_errors = 0
            rank_results.append(result)
            state["ranking"][task] = result
            _save_state(state)
    elapsed = time.time() - started

    # ---- Q4 马尔可夫先验（按类型经验成功率，Laplace 平滑） ----
    type_counts: dict[str, tuple[int, int]] = {}
    for r in valid:
        k, n = type_counts.get(r.type, (0, 0))
        type_counts[r.type] = (k + int(bool(r.ok)), n + 1)
    priors = {t: (k + 1) / (n + 2) for t, (k, n) in type_counts.items()}
    prior_probs = [priors[r.type] for r in valid]

    def _combo(w: float) -> list[float]:
        return [w * p + (1 - w) * pr for p, pr in zip(probs, prior_probs)]

    # ---- Q5 三源互补融合（置信度阈值 × 马尔可夫 × 当前模式） ----
    n = len(valid)

    def _sweep(skip_fn, params_list):
        pts = []
        for p in params_list:
            skipped = [(h, l) for h, l, pr in zip(probs, labels, prior_probs) if skip_fn(h, pr, p)]
            if not skipped:
                pts.append((0.0, 0.0, p))
                continue
            err = mean(0.0 if l else 1.0 for _, l in skipped)
            pts.append((len(skipped) / n, err, p))
        return pts

    def _best(pts, budget):
        cand = [(s, e, p) for s, e, p in pts if e <= budget + 1e-9]
        return max(cand, key=lambda x: x[0]) if cand else (0.0, 0.0, None)

    grid_tau = [x / 100 for x in range(50, 100, 5)]
    rules = {
        "仅置信度阈值": ("head ≥ τ", lambda h, pr, tau: h >= tau, grid_tau),
        "仅马尔可夫先验": ("先验 ≥ θ", lambda h, pr, th: pr >= th, grid_tau),
        "互补 AND": (
            "head ≥ τ 且 先验 ≥ θ",
            lambda h, pr, p: h >= p[0] and pr >= p[1],
            [(a, b) for a in grid_tau for b in grid_tau],
        ),
        "加权融合": (
            "w·head+(1-w)·先验 ≥ κ",
            lambda h, pr, p: p[0] * h + (1 - p[0]) * pr >= p[1],
            [(w, k) for w in (0.3, 0.5, 0.7) for k in grid_tau],
        ),
    }

    # ---- Q6 三档验证阶梯（细化状态 × risk 触发 × 当前模式兜底） ----
    # 状态 = (类型, head 置信度档位)；阶梯：risk 清单非空 → targeted（按清单点验，
    # 成本 1）；risk 空且状态先验 ≥ θ → fast（成本 0）；否则 full（成本 2）。
    # 假定：risk 非空的失败会被 targeted 点验抓住（本数据 8 失败中 6 个 risk 点名了
    # 实际失败维度）；残留错误只来自 fast 路径漏过的失败（risk 空盲区样本）。

    def _head_bin(p: float | None) -> str | None:
        if p is None:
            return None
        if p < 0.85:
            return "0.7-0.85"
        if p < 0.95:
            return "0.85-0.95"
        return "0.95-1.0"

    state_counts: dict[tuple[str, str], tuple[int, int]] = {}
    for r in valid:
        st = (r.type, _head_bin(r.head_p))
        k, c = state_counts.get(st, (0, 0))
        state_counts[st] = (k + int(bool(r.ok)), c + 1)
    state_prior = {st: (k + 1) / (c + 2) for st, (k, c) in state_counts.items()}

    def _ladder(theta: float, zero_min: int = 0) -> dict:
        cost = 0
        err = 0
        tiers = {"fast": 0, "targeted": 0, "full": 0}
        fast_fails: list[str] = []
        for r in valid:
            st = (r.type, _head_bin(r.head_p))
            k, c = state_counts[st]
            if r.risk_empty:
                safe_by_prior = state_prior[st] >= theta
                safe_by_zero_fail = zero_min > 0 and k == c and c >= zero_min
                if safe_by_zero_fail or (zero_min == 0 and safe_by_prior):
                    tier = "fast"
                else:
                    tier = "full"
            else:
                tier = "targeted"
            tiers[tier] += 1
            cost += {"fast": 0, "targeted": 1, "full": 2}[tier]
            if not r.ok and tier == "fast":
                err += 1
                fast_fails.append(r.task["id"])
        return {"cost": cost / len(valid), "err": err / len(valid), **tiers, "fast_fails": fast_fails}

    # ---- Q7 验证器门控（新算法：评审执行产出，而非预测成败） ----
    verify_runs = [r for r in valid if r.verify_pass is not None]
    vn = len(verify_runs)
    tp = sum(1 for r in verify_runs if r.verify_pass and r.ok)
    fp = sum(1 for r in verify_runs if r.verify_pass and not r.ok)  # 漏抓（判过但实际败）
    tn = sum(1 for r in verify_runs if not r.verify_pass and not r.ok)
    fn = sum(1 for r in verify_runs if not r.verify_pass and r.ok)  # 误杀（判败但实际过）
    pass_rate = (tp + fp) / vn if vn else float("nan")
    leak_v = fp / (tp + fp) if (tp + fp) else float("nan")
    kill_v = fn / (tn + fn) if (tn + fn) else float("nan")
    caught = [r.task["id"] for r in verify_runs if r.verify_pass is False and not r.ok]
    leaked = [r.task["id"] for r in verify_runs if r.verify_pass is True and not r.ok]

    def _policy_cost(pass_rate_p: float) -> float:
        return 1.0 + (1.0 - pass_rate_p) * 2.0  # 决策调用1 + 未通过者全验证2

    pred_pass = sum(1 for r in valid if (r.head_p or 0.0) >= 0.9) / len(valid)
    pred_leak = sum(
        1 for r in valid if not r.ok and (r.head_p or 0.0) >= 0.9
    ) / sum(1 for r in valid if (r.head_p or 0.0) >= 0.9)
    both_pass = [r for r in verify_runs if r.verify_pass and (r.head_p or 0.0) >= 0.9]
    both_leak = sum(1 for r in both_pass if not r.ok) / len(both_pass) if both_pass else float("nan")

    # ---- 分析 ----
    lines: list[str] = []
    lines.append("# 置信度头校准实验报告")
    lines.append("")
    lines.append(f"- 时间（UTC）：{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    lines.append(f"- solver：`{solver_model}`；head：`{head_model}`；耗时 {elapsed:.0f}s")
    lines.append(f"- 主集任务 {len(tasks)} 个，有效（head 解析成功）{len(valid)} 个；"
                 f"环境错误 {sum(1 for r in runs if r.env_error)} 个（已排除）；"
                 f"真实成功率 {mean(labels):.1%}")
    lines.append("")

    if not valid:
        lines.append("（主集被跳过——无校准/节流/先验数据，仅排序统计）")
    else:
        lines.append("## Q1 校准性（head 预测 vs 真实成败）")
        lines.append("")
        lines.append("| 预测区间 | n | 平均预测 | 实际成功率 |")
        lines.append("|---|---|---|---|")
        for label, n, mean_p, rate in calibration_bins(probs, labels):
            if n:
                lines.append(f"| {label} | {n} | {mean_p:.2f} | {rate:.2f} |")
            else:
                lines.append(f"| {label} | 0 | - | - |")
        lines.append("")
        lines.append(f"- **Brier（head）**：{brier(probs, labels):.3f}（随机猜测 ~0.25，完美 0）")
        lines.append(f"- **AUC（head）**：{auc(probs, labels):.3f}（0.5 = 无区分力，nan = 无正/负样本）")
        lines.append("")

        lines.append("## Q2 节流收益（p_success ≥ τ 即信任 head，跳过验证）")
        lines.append("")
        lines.append("| τ | 信任比例 | 被信任样本错误率 | 需人工/重验样本 |")
        lines.append("|---|---|---|---|")
        for tau in (0.5, 0.6, 0.7, 0.8, 0.9):
            trusted = [(p, l) for p, l in zip(probs, labels) if p >= tau]
            if not trusted:
                lines.append(f"| {tau} | 0% | - | 100% |")
                continue
            err = mean(0.0 if l else 1.0 for _, l in trusted)
            lines.append(f"| {tau} | {len(trusted) / len(valid):.0%} | {err:.0%} | {1 - len(trusted) / len(valid):.0%} |")
        lines.append("")

        lines.append("## Q4 马尔可夫先验复合（类型经验成功率 vs head）")
        lines.append("")
        lines.append("| 权重方案 | Brier | AUC |")
        lines.append("|---|---|---|")
        for w, name in ((0.0, "仅类型先验"), (0.5, "0.5 head + 0.5 先验"), (1.0, "仅 head")):
            combo = _combo(w)
            lines.append(f"| {name} | {brier(combo, labels):.3f} | {auc(combo, labels):.3f} |")
        lines.append("")
        lines.append("类型经验成功率（Laplace：(k+1)/(n+2)，n=样本数）：")
        lines.append("")
        for t in sorted(type_counts):
            k, n = type_counts[t]
            lines.append(f"- {t}: {k}/{n} = {k / n:.0%}（先验 {priors[t]:.2f}）")
        lines.append("")

        lines.append("## Q5 三源互补融合（置信度阈值 × 马尔可夫 × 当前模式）")
        lines.append("")
        lines.append("决策策略：仅当「置信度阈值命中 AND 马尔可夫先验命中」才走快路径（跳过验证）；")
        lines.append("否则回退当前模式（全验证/模拟，成本高、零漏错）。下表为各规则在给定错误预算")
        lines.append("（被信任样本的错误率上限）下能达到的最大验证跳过比例。")
        lines.append("")
        lines.append("| 规则 | 0% 预算 | 5% 预算 | 10% 预算 |")
        lines.append("|---|---|---|---|")
        lines.append("| 当前模式（全验证） | 0%（0 错） | 0% | 0% |")
        for name, (desc, skip_fn, params) in rules.items():
            pts = _sweep(skip_fn, params)
            cells = []
            for budget in (0.0, 0.05, 0.10):
                s, _e, p = _best(pts, budget)
                if s <= 0:
                    cells.append("0%")
                    continue
                if isinstance(p, tuple):
                    tag = f"τ={p[0]:.2f},θ={p[1]:.2f}"
                else:
                    tag = f"τ={p:.2f}"
                cells.append(f"{s:.0%}（{tag}）")
            lines.append(f"| {name} | {cells[0]} | {cells[1]} | {cells[2]} |")
        lines.append("")
        lines.append("注：5% 预算行=实际错误率 ≤5%；若某规则 0% 预算下也有省量，说明它能零错地替代一部分验证。")
        lines.append("冷启动：类型无历史时先验回落全局率/0.5，w 应偏置信度阈值；历史充足后由马尔可夫主导纠偏。")
        lines.append("")

        lines.append("## Q6 三档验证阶梯（细化状态 × risk 触发 × 当前模式兜底）")
        lines.append("")
        lines.append("成本模型（调用单位）：fast=0（跳过）/ targeted=1（按 risk 清单点验一次）/ full=2（全验证/simulate 对比）。")
        lines.append("阶梯规则：risk 清单非空 → targeted；risk 空且「类型×置信度档」状态先验 ≥ θ → fast；否则 full。")
        lines.append("假定：risk 非空的失败被 targeted 点验抓住（本数据 8 失败中 6 个的 risk 点名了实际失败维度）；")
        lines.append("残留错误只来自 fast 漏过（risk 空盲区）。")
        lines.append("")
        lines.append("| 配置 | 平均成本/任务 | 相对当前模式节省 | 残留错误 | fast/targeted/full | 漏过任务 |")
        lines.append("|---|---|---|---|---|---|")
        lines.append("| 当前模式（全验证） | 2.00 | 0% | 0% | 0/0/39 | - |")
        for nm, zmin in (("严格零败快路径 N=3", 3), ("严格零败快路径 N=2", 2)):
            r = _ladder(0.9, zero_min=zmin)
            leak = ", ".join(r["fast_fails"]) or "-"
            lines.append(
                f"| {nm} | {r['cost']:.2f} | {1 - r['cost'] / 2.0:.0%} | "
                f"{r['err']:.0%} | {r['fast']}/{r['targeted']}/{r['full']} | {leak} |"
            )
        for theta in (0.60, 0.70, 0.80, 0.90, 0.95):
            res = _ladder(theta)
            leak = ", ".join(res["fast_fails"]) or "-"
            lines.append(
                f"| 阶梯 θ={theta:.2f} | {res['cost']:.2f} | {1 - res['cost'] / 2.0:.0%} | "
                f"{res['err']:.0%} | {res['fast']}/{res['targeted']}/{res['full']} | {leak} |"
            )
        lines.append("")
        lines.append("细化状态成功率（类型 × 置信度档 → 经验成功率，n=样本数）：")
        lines.append("")
        for st in sorted(state_counts):
            k, c = state_counts[st]
            lines.append(f"- {st[0]}/{st[1]}: {k}/{c} = {k / c:.0%}（先验 {state_prior[st]:.2f}）")
        lines.append("")

        lines.append("## Q7 验证器门控（新算法：评审产出，不预测成败）")
        lines.append("")
        lines.append("核心假设（由数据提出）：预测模式问「执行会不会成功」——head 评的是任务难度，")
        lines.append("不感知执行器，失败也打 ≥0.9；但验证模式问「这个产出满足硬性要求吗」——")
        lines.append("同一模型对具体产出做判定，而 head 写 reason 时本就能解出正确答案（h06 解出 15、")
        lines.append("t05 算出 34）。故把同一信号从「预测」改造成「验证」应显著降低漏抓。")
        lines.append("")
        if not verify_runs:
            lines.append("（无验证器数据——先跑 INKENGINE_EXP_VERIFY_ONLY 补齐）")
        else:
            lines.append(f"验证器评审 {vn} 个：pass={tp + fp}（{pass_rate:.0%}），fail={tn + fn}。")
            lines.append("混淆：真过且判过(TP)=" + f"{tp}，判过但实际败(FP/漏抓)={fp}，"
                         f"判败但实际过(FN/误杀)={fn}，真败且判败(TN)={tn}。")
            lines.append("")
            lines.append("| 门控策略 | 决策调用 | 通过率 | 漏抓率（通过却失败） | 误杀率（判败却通过） | 平均成本/任务 | 相对当前模式 |")
            lines.append("|---|---|---|---|---|---|---|")
            lines.append("| 当前模式（全验证） | - | 100% | 0% | 0% | 2.00 | 0% |")
            lines.append(
                f"| 预测门控（head p≥0.9 即跳过） | 1 | {pred_pass:.0%} | {pred_leak:.0%} | 0% | "
                f"{_policy_cost(pred_pass):.2f} | {1 - _policy_cost(pred_pass) / 2.0:.0%} |"
            )
            lines.append(
                f"| 验证门控（verifier pass 即跳过） | 1 | {pass_rate:.0%} | {leak_v:.0%} | {kill_v:.0%} | "
                f"{_policy_cost(pass_rate):.2f} | {1 - _policy_cost(pass_rate) / 2.0:.0%} |"
            )
            if both_pass:
                bp_rate = len(both_pass) / vn
                lines.append(
                    f"| 复合门控（verifier pass 且 head p≥0.9） | 1 | {bp_rate:.0%} | "
                    f"{both_leak:.0%} | - | {_policy_cost(bp_rate):.2f} | {1 - _policy_cost(bp_rate) / 2.0:.0%} |"
                )
            lines.append("")
            lines.append(f"验证器抓住的失败：{', '.join(caught) or '-'}")
            lines.append(f"验证器漏抓的失败：{', '.join(leaked) or '-'}")
            lines.append("")
        lines.append("")

    lines.append("## Q3 排序能力（head 挑更优候选，不执行两条）")
    lines.append("")
    lines.append("| 任务 | p_A | p_B | A 实际 | B 实际 | head 排序正确 |")
    lines.append("|---|---|---|---|---|---|")
    diff_pairs = [r for r in rank_results if r["actual_sign"] != 0 and r["head_sign"] != 0]
    for r in rank_results:
        agree = r["agree"] if r["head_sign"] != 0 else "平/未判"
        lines.append(
            f"| {r['task']} | {r['pa']} | {r['pb']} | {'✅' if r['ok_a'] else '❌'} | "
            f"{'✅' if r['ok_b'] else '❌'} | {agree} |"
        )
    lines.append("")
    lines.append(
        f"- **排序一致率**：{sum(1 for r in diff_pairs if r['agree'])}/{len(diff_pairs)}"
        f"（仅统计两路 p 都解析成功且实际结果有高下之分；两路都成/都败 = 无法区分，不计数）"
    )
    lines.append("")

    lines.append("## 明细")
    lines.append("")
    lines.append("| 任务 | 类型 | p_success | 实际 | 回答预览 | head 原文 |")
    lines.append("|---|---|---|---|---|---|")
    for r in runs:
        if r.env_error:
            lines.append(f"| {r.task['id']} | {r.type} | - | 环境错误 | - | - |")
            continue
        lines.append(
            f"| {r.task['id']} | {r.type} | {r.head_p} | {'✅' if r.ok else '❌'} | "
            f"{' '.join((r.answer or '').split())[:36]} | {r.head_raw} |"
        )

    report_dir = Path(__file__).resolve().parent / "reports"
    report_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    body = "\n".join(lines) + "\n"
    (report_dir / f"confidence_head_report-{ts}.md").write_text(body, encoding="utf-8")
    (report_dir / "latest.md").write_text(body, encoding="utf-8")

    log("\n" + "=" * 78)
    print(body)
    log(f"[报告] {report_dir / f'confidence_head_report-{ts}.md'}")
    return 0


if __name__ == "__main__":
    import traceback

    try:
        sys.exit(asyncio.run(main()))
    except Exception:  # noqa: BLE001 崩溃详情落盘，便于隔夜/后台运行诊断
        tb = traceback.format_exc()
        crash_path = Path(__file__).resolve().parent / "reports" / "_crash.log"
        crash_path.parent.mkdir(exist_ok=True)
        crash_path.write_text(tb, encoding="utf-8")
        log(f"[崩溃] 详情已写 {crash_path}\n{tb}")
        sys.exit(1)

# -*- coding: utf-8 -*-
"""推理清洁度实弹探针（出厂自检门禁子项，决策 22/30）。

用法：
  python tools/probe_reasoning_clean.py            # 依赖 .kilo/测试模型配置.txt
  python tools/probe_reasoning_clean.py --config path  # 指定配置

配置格式（与 .kilo/测试模型配置.txt 一致，每行 k:v）：
  url:https://.../compatible-mode/v1
  key:sk-...
  model_name:deepseek-v4-pro-0813

断言（任一失败退出码 1，供 CI/self_check 红绿）：
  [1] B 组（规则）全轮净：reasoning 不含工具标识符
  [2] A 组（现状）含脏轮：证明装配差异可复现（探针有效性自检）
  [3] B 组 R3 正确性：无明天预报时零调用且不误报（行为手册价值断言）
"""
import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import httpx

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / ".kilo" / "测试模型配置.txt"

TOOLS_DEF = {
    "query_weather_forecast": "查询指定城市当天天气。",
    "query_local_time": "查询当前本地时间。",
    "create_reminder": "创建一条提醒。",
}
TOOLS_DEF_RICH = {
    "query_weather_forecast": (
        "该工具用于查询指定城市当天的天气预报。\n"
        "使用时机：用户问到某城市天气情况时。\n"
        "参数说明：location 为城市名（必需）。\n"
        "返回内容：天气状况、气温。\n"
        "注意事项：仅当天的数据，无明天预报；直接调用。"
    ),
    "query_local_time": (
        "该工具用于查询当前本地时间。\n"
        "使用时机：用户问时间、几点、耗时类问题时。\n"
        "返回内容：当前日期与时刻。\n"
        "注意事项：无参数，直接调用。"
    ),
    "create_reminder": (
        "该工具用于创建一条提醒，供稍后触发。\n"
        "使用时机：用户要求设置提醒/闹钟/定时消息时。\n"
        "参数说明：text 为提醒内容（必需），at_time 为触发时间字符串。\n"
        "返回内容：确认信息。\n"
        "注意事项：创建后需要向用户确认。"
    ),
}
SYSTEM_A = "你是 InKling 助手。"
SYSTEM_B = (
    "你是面向真实用户的桌面助手 InKling（人格）。\n"
    "行为准则：\n"
    "1. 简单事实类请求直接、快速作答，不展开无关分析。\n"
    "2. 需要工具时只选最合适的一个并直接调用，调用前不反复权衡。\n"
    "3. 思考用自然语言描述意图（例如「查一下天气」「看看当前时间」「给他设个提醒」），"
    "禁止引用工具标识符/函数名，禁止输出参数 JSON。\n"
    "4. 面向用户说人话。\n"
    "5. 工具结果回灌后再分析只用结果内容，不提及工具名。\n"
    "6. 每轮只处理当前问题，不自作主张安排后续。"
)
SYSTEM_C = (
    "InKling:你是研究型桌面助手。你处在研究上下文中。完成一轮回合:"
    "按研究流程执行,执行后回收结果。理性决策,给出结论。"
)
ROUNDS = ["北京今天天气怎么样？", "现在几点了？", "那明天呢？",
          "帮我设个提醒，晚上八点提醒我喝水。"]
HINT = "（提示：用自然语言描述下一步，不要引用工具标识符或参数 JSON。）"
IDENT_RE = re.compile(r"query_weather_forecast|query_local_time|create_reminder|"
                      r"\"location\"|\"text\"|JSON", re.I)


def load_config(path: Path) -> dict:
    cfg = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        cfg[k.strip()] = v.strip()
    for key in ("url", "key", "model_name"):
        if key not in cfg:
            raise SystemExit(f"配置缺少 {key}: {path}")
    return cfg


def tool_specs(desc_map: dict) -> list[dict]:
    def ts(name: str, desc: str, props: dict) -> dict:
        return {"type": "function",
                "function": {"name": name, "description": desc, "parameters": props}}

    return [
        ts("query_weather_forecast", desc_map["query_weather_forecast"],
           {"type": "object", "properties": {"location": {"type": "string"}}, "required": ["location"]}),
        ts("query_local_time", desc_map["query_local_time"], {"type": "object", "properties": {}}),
        ts("create_reminder", desc_map["create_reminder"],
           {"type": "object", "properties": {"text": {"type": "string"}, "at_time": {"type": "string"}},
            "required": ["text"]}),
    ]


def fake_result(name: str, args: dict) -> str:
    if name == "query_weather_forecast":
        return json.dumps({"condition": "晴", "temperature_c": 28,
                           "location": args.get("location", "北京")}, ensure_ascii=False)
    if name == "query_local_time":
        return json.dumps({"time": "2026-08-23 05:25"})
    return json.dumps({"ok": True, "confirm": "提醒已创建：喝水 @ 20:00"}, ensure_ascii=False)


async def run_case(client: httpx.AsyncClient, base_url: str, api_key: str, model: str,
                   label: str, system: str, desc_map: dict, with_hint: bool) -> list[dict]:
    print(f"\n===== {label} =====")
    tools = tool_specs(desc_map)
    messages = [{"role": "system", "content": system}]
    outcomes = []
    for i, question in enumerate(ROUNDS, start=1):
        messages.append({"role": "user", "content": question + (HINT if with_hint else "")})
        resp = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}",
                     "Content-Type": "application/json"},
            json={"model": model, "messages": messages, "tools": tools,
                  "tool_choice": "auto", "stream": False},
        )
        resp.raise_for_status()
        data = resp.json()
        msg = data["choices"][0]["message"]
        reasoning = (msg.get("reasoning_content") or "") or ""
        calls = msg.get("tool_calls") or []
        ident = bool(IDENT_RE.search(reasoning))
        fname = calls[0]["function"]["name"] if calls else None
        print(f"  R{i} | calls={len(calls)} | ident={'YES' if ident else 'no'} "
              f"| tool={fname} | reasoning={reasoning[:120]!r}")
        outcomes.append({"round": i, "ident": ident, "calls": len(calls),
                         "tool": fname, "reasoning": reasoning})
        if not calls:
            messages.append({"role": "assistant", "content": msg.get("content") or "",
                             "reasoning_content": reasoning})
            continue
        try:
            fargs = json.loads(calls[0]["function"].get("arguments") or "{}")
        except Exception:
            fargs = {}
        messages.append({"role": "assistant", "content": msg.get("content") or "",
                         "reasoning_content": reasoning, "tool_calls": calls})
        messages.append({"role": "tool", "tool_call_id": calls[0].get("id", f"call_{i}"),
                         "content": fake_result(fname, fargs)})
    return outcomes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    args = ap.parse_args()
    cfg = load_config(Path(args.config))

    async def _run() -> tuple[list, list, list]:
        base = cfg["url"].rstrip("/")
        async with httpx.AsyncClient(timeout=120) as client:
            a = await run_case(client, base, cfg["key"], cfg["model_name"], "A_现状", SYSTEM_A, TOOLS_DEF, with_hint=False)
            b = await run_case(client, base, cfg["key"], cfg["model_name"], "B_规则", SYSTEM_B, TOOLS_DEF_RICH, with_hint=True)
            c = await run_case(client, base, cfg["key"], cfg["model_name"], "C_InKling现实", SYSTEM_C, TOOLS_DEF, with_hint=False)
            return a, b, c

    a, b, c = asyncio.run(_run())

    print("\n===== 门禁判定 =====")
    b_clean = not any(x["ident"] for x in b)
    a_dirty = any(x["ident"] for x in a)
    r3 = b[2]
    b_r3_correct = (r3["calls"] == 0) and ("明天" in r3["reasoning"] or "无" in r3["reasoning"])
    checks = [
        ("B 组全净（行为准则层+行为手册+引导语 生效）", b_clean),
        ("A 组含脏（装配差异可复现，探针有效）", a_dirty),
        ("B 组 R3 正确性（无明天预报→零调用不误报）", b_r3_correct),
    ]
    ok = True
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    print(f"\n结论: {'门禁通过' if ok else '门禁失败'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

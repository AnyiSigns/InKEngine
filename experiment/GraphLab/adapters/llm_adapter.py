"""适配层 LLMAdapter：多提供商回退链（原 graph_lab/fallback_chain.py）+
LLM 图节点适配器（原 nodes.py 的 LLMNode，逐行搬入并更名）。
网络 I/O，mockable：base 未配置 = 确定性 stub，零网络。

Usage:
  python experiment/GraphLab/adapters/llm_adapter.py   # 回退链自检（真实网络）
  # or import:
  from llm_adapter import get_chat_completion, LLMAdapter, PROVIDERS

Design:
  Each provider has a list of models tried in order.
  A provider is exhausted (all models failed) before falling back
  to the next provider.
  Failures include network errors, HTTP errors, rate limits,
  and empty/malformed responses.
"""
from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.request
from typing import Any

# ── provider definitions ──────────────────────────────────────────────
# 只保留实测可用的模型（2026-09-12 观测：dashscope 各模型 1-14s 可响应；
# b_ai 模型名多失效。kilo_gateway 需真实 key，未配置时快速失败，默认去掉）。
PROVIDERS: list[dict[str, Any]] = [
    {
        "name": "kilo_gateway",
        "base_url": "https://api.kilo.ai/api/gateway",
        "api_key": "",  # 匿名免费档：Bearer 空 token 即可
        "models": [
            "stepfun/step-3.7-flash:free",
        ],
    },
    {
        "name": "dashscope",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key": "sk-da98029948304384b660c0f07656e020",
        "models": [
            "qwen3.8-max-0902",
            "kimi-k2.7-code",
            "qwen3.5-ocr",
        ],
    },
    {
        "name": "b_ai",
        "base_url": "https://api.b.ai/v1",
        "api_key": "sk-lyargjf5p6ilwrxbhezgmz78yg2wkzkk",
        "models": [
            "qwen3.8-flash",
            "glm-5.3-flash",
        ],
    },
]

DEFAULT_TEMPERATURE = 0.4
DEFAULT_TIMEOUT_MS = 60_000


# ── low-level call ────────────────────────────────────────────────────

def _post_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    temperature: float = DEFAULT_TEMPERATURE,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    path: str = "/chat/completions",
) -> dict[str, Any]:
    url = base_url.rstrip("/") + path
    body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_ms / 1000) as resp:
        raw = resp.read()
    data = json.loads(raw)
    choices = data.get("choices") or []
    if not choices:
        raise ValueError(f"empty choices from {url}")
    msg = choices[0].get("message", {})
    content = (msg.get("content") or "").strip()
    if not content:
        raise ValueError(f"empty content from {url}")
    return {
        "model": model,
        "provider": base_url,
        "content": content,
        "raw": data,
    }


# ── fallback orchestrator ─────────────────────────────────────────────

def get_chat_completion(
    messages: list[dict[str, str]],
    models: list[str] | None = None,
    temperature: float = DEFAULT_TEMPERATURE,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    retry_delay_s: float = 0.5,
    jitter: float = 0.5,
    fast_fail_s: float = 30.0,
) -> dict[str, Any]:
    """Try models across providers in order, falling back on any failure.

    fast_fail_s: skip a provider entirely once it has failed (timeout/conn)
    this many times in this call chain, so a dead endpoint does not burn the
    full timeout on every model.

    Returns the first successful response dict.
    Raises RuntimeError with the full failure trail if every attempt fails.
    """
    trail: list[dict[str, Any]] = []
    provider_fails: dict[str, int] = {}

    for provider in PROVIDERS:
        pool = models if models else provider["models"]
        base_url = provider["base_url"]
        api_key = provider["api_key"]
        provider_name = provider["name"]
        if provider_fails.get(provider_name, 0) >= 1 and any(
            t["provider"] == provider_name and t["error"].startswith(("TimeoutError", "URLError", "ConnectionError"))
            for t in trail
        ):
            trail.append({"provider": provider_name, "model": pool[0],
                          "error": "SKIPPED (provider unhealthy)", "latency_s": 0.0})
            continue

        for model in pool:
            start = time.time()
            try:
                result = _post_chat(
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                    messages=messages,
                    temperature=temperature,
                    timeout_ms=timeout_ms,
                    path=provider.get("path", "/chat/completions"),
                )
                result["latency_s"] = round(time.time() - start, 2)
                result["trail"] = trail
                return result
            except Exception as exc:
                trail.append({
                    "provider": provider_name,
                    "model": model,
                    "error": f"{type(exc).__name__}: {exc}",
                    "latency_s": round(time.time() - start, 2),
                })
                provider_fails[provider_name] = provider_fails.get(provider_name, 0) + 1
                time.sleep(retry_delay_s + random.uniform(0, jitter))

    raise RuntimeError(
        "all fallback attempts failed:\n"
        + json.dumps(trail, ensure_ascii=False, indent=2)
    )


# ── convenience wrapper ───────────────────────────────────────────────

def chat(user_prompt: str, system_prompt: str = "") -> str:
    """Single-turn completion returning just the assistant text."""
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})
    return get_chat_completion(messages)["content"]


# ── LLM 节点适配器（原 graph_lab/nodes.py 的 LLMNode，逐行搬入） ───────

ROLE_PROMPTS = {
    "generic": "你是图中的通用回答节点。如果当前状态已有产出（代码/章节等），改进它；否则直接回答用户任务。只输出结果本身，不要解释。",
    "plan": "你是图中的规划节点。把用户任务拆成可执行的步骤清单，每行一步，只输出步骤清单。",
    "code": "你是图中的代码生成节点。根据用户任务输出完整可运行的 Python 代码。只输出代码本身，不要解释，不要 markdown 代码块围栏。",
    "chapter": "你是图中的小说章节生成节点。用户状态里给出任务与已写章节；写出下一章。格式：'第X章 标题' 换行后接正文，只输出本章内容。",
    "review": "你是图中的审查节点。审查已产出的内容（代码或文本），输出简短审查意见；如果合格，以 OK 开头。",
    "polish": "你是图中的精修节点。根据审查意见改进已有产出，只输出改进后的完整内容。",
    "article": "你是图中的文章写作节点。根据用户任务写一篇通顺完整的短文，只输出文章正文，不要解释。",
    "translate": "你是图中的翻译节点。把用户输入翻译成目标语言（任务里指定），只输出译文，不要解释。",
    "backtranslate": "你是图中的回译校验节点。把输入中的英文句子翻译回中文原文，只输出中文译文，不要解释，不要输出其他内容。",
    "classify": "你是图中的任务分类节点。判断用户任务的类型，只输出一个类别词：code、translate 或 math，不要解释，不要输出其他内容。",
    "math": "你是图中的数学解题节点。求解用户给出的方程/数学问题，给出步骤和最终答案，只输出解答内容。",
}

# 各角色 LLM 节点的输入契约：prompt 只接收声明字段（不再整包 dump state）
DEFAULT_INPUT_FIELDS = ("payload", "plan", "code", "chapters", "review", "polished")


class LLMAdapter:
    """LLM 作为图节点：角色提示词 + 真实 API + 观测日志（即原 LLMNode）。

    节点函数签名 func(state) -> dict | None：
      - 调用真实 LLM（OpenAI 兼容 chat/completions），返回 {**state, "payload": 输出}
      - API 未配置时退回确定性 stub（能力 = 字符串转大写，玩具域可复现）
      - API 调用失败返回 None（该节点当前任务上不可用 -> 死路，路由学会避开）
    logger(role, task, input_summary, output_summary) 每调用一次，用于观测节点 IO。
    """

    def __init__(self, role: str = "generic", api: tuple | None = None, logger=None,
                 timeout: int = 25, nid: str | None = None,
                 input_fields: list[str] | None = None,
                 provides: str | None = None, models: list[str] | None = None):
        self.role = role
        self.nid = nid or role  # 观测日志里的节点身份（llm_1 / code / code_2 ...）
        self.logger = logger
        self.timeout = timeout
        self.prompt = ROLE_PROMPTS.get(role, ROLE_PROMPTS["generic"])  # 可微调参数
        # 输入契约：prompt 只接收声明的字段，杜绝整包 state 序列化污染
        self.input_fields = list(input_fields) if input_fields else list(DEFAULT_INPUT_FIELDS)
        self.provides = provides  # 该节点成功时写入的字段（验收通道收口依据）
        self.models = models  # 固定模型列表（平稳性）；None = fallback 链全模型
        if api is not None:
            self.base, self.key, self.model = api[0].rstrip("/"), api[1], api[2]
        else:
            self.base = (os.environ.get("LLM_BASE_URL", "") or os.environ.get("LAB_LLM_BASE_URL", "")).rstrip("/")
            self.key = os.environ.get("LLM_KEY", "") or os.environ.get("LAB_LLM_KEY", "")
            self.model = os.environ.get("LLM_MODEL", "default") or os.environ.get("LAB_LLM_MODEL", "default")

    def set_prompt(self, prompt: str) -> None:
        """微调该节点的提示词参数（审计由调用方记录）。"""
        self.prompt = prompt

    def __call__(self, state):
        if not self.base:  # 只看 base：匿名网关 key 可为空（kilo_gateway）
            p = state["payload"]
            if isinstance(p, str):
                return {**state, "payload": p.upper(), "_out": p.upper()}  # stub：玩具域 payload 变换语义
            return None
        return self._call_llm(state)

    def _call_llm(self, state) -> dict | None:
        # 输入契约：只取节点声明的输入字段（None 值不注入 prompt）
        inputs = {k: state.get(k) for k in self.input_fields}
        inputs = {k: v for k, v in inputs.items() if v is not None}
        t0 = time.time()
        try:
            # 多提供商回退链（同文件上方）
            result = get_chat_completion(
                messages=[
                    {"role": "system", "content": self.prompt},
                    {"role": "user", "content": json.dumps(inputs, ensure_ascii=False)},
                ],
                models=self.models,
                temperature=0.4,
                timeout_ms=self.timeout * 1000,
            )
            msg = result["content"]
            if self.logger:
                self.logger(self.nid, self.role, state.get("task"),
                            str(inputs)[:200], msg[:200], result.get("latency_s", 0.0),
                            f"{result.get('provider', '')}/{result.get('model', '')}")
            # 关键：输出放 _out 独立字段，payload（原始任务描述）不被覆盖，
            # 杜绝"状态被反复 JSON 包裹、在节点间传递"的污染链
            return {**state, "_out": msg}
        except Exception as e:
            if self.logger:
                self.logger(self.nid, self.role, state.get("task"),
                            str(inputs)[:200], f"<ERROR {type(e).__name__}>",
                            round(time.time() - t0, 1), "")
            return None


# ── self-test ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    test_messages = [
        {"role": "user", "content": "Say OK in one word."},
    ]
    try:
        res = get_chat_completion(test_messages)
        print(f"OK  provider={res['provider']}  model={res['model']}  "
              f"latency={res['latency_s']}s")
        print(f"content: {res['content'][:120]}")
    except RuntimeError as exc:
        print(f"FAILED: {exc}")

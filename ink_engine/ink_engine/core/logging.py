"""结构化 JSON 日志（引擎自包含，零外部依赖）。

对齐 config.logging 的 JSON 日志风格（ts/level/logger/msg + trace_id），
但引擎包零反向依赖，不 import text_forge_backend 任何模块——自带最小实现。
trace_id 经 contextvars 传递，贯穿一次 run() 全链路（可观测性要求）。

库侧遵循标准 logging 语义：只 getLogger + NullHandler，不抢占 handler/
级别/propagate——宿主可自行接管（挂 root 或 core 上的采集器）。
开箱即用的 JSON 输出由宿主显式调用 configure_engine_logging() 启用
（examples/ 已调用）。
"""
from __future__ import annotations

import contextvars
import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

# 链路追踪 ID：执行器在 run() 入口注入，节点内日志自动携带
trace_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default="-")

# 日志遮蔽规则（凭据形态：sk- 密钥、key=/token= 赋值、Authorization 头、
# 连接串用户信息、主流厂商 key 前缀）。与 security.SENSITIVE_KEYS 同源
# 维护，覆盖日志侧出口。
_REDACT_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"sk-[A-Za-z0-9_\-]{8,}"),
    # 厂商密钥前缀（Groq/xAI/Perplexity/Anthropic 旧形态/HuggingFace/
    # GitHub PAT/GitLab PAT；前缀后须有足够长密钥段，防误伤普通词）
    re.compile(r"(?<![A-Za-z0-9])(?:gsk_|xai-|pplx-|sk-ant-|hf_|ghp_|github_pat_|glpat-)[A-Za-z0-9_\-]{8,}"),
    # Google API key（AIza 前缀 + 35 位密钥段）
    re.compile(r"\bAIza[0-9A-Za-z_\-]{25,}\b"),
    re.compile(r"(?i)(api[-_]?key|token|secret|password|authorization)\s*[=:]\s*\S+"),
    re.compile(r"(?i)\b(authorization|proxy-authorization)\b[^,;\r\n]*"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+"),
    re.compile(r"(?i)\"(api[-_]?key|token|secret|password|authorization)\"\s*:\s*\"[^\"]*\""),
    re.compile(r"(?:postgres(?:ql)?|mysql|redis|amqp)://[^@\s/]+@"),
    re.compile(r"[?&](?:key|token|api_key|access_token|secret)=[^&\s]+"),
)


def redact(text: str) -> str:
    """对日志文本统一遮蔽敏感形态（失败安全：异常时不遮蔽也不崩溃）。"""
    try:
        for pattern in _REDACT_PATTERNS:
            text = pattern.sub("[REDACTED]", text)
    except Exception:
        return str(text)  # 失败安全：非 str 输入等异常不遮蔽也不崩溃
    return text


class JsonFormatter(logging.Formatter):
    """结构化 JSON 格式器（ts/level/logger/msg/trace_id，异常附堆栈，敏感形态遮蔽）。"""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            # UTC ISO8601（跨服务对账无时区歧义）
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": redact(record.getMessage()),
            "trace_id": trace_id_var.get(),
        }
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, default=str)


class _RedactFilter(logging.Filter):
    """logger 级强制脱敏 Filter：消息内容中的敏感形态统一遮蔽。

    下沉到 logger 层（而非仅 JsonFormatter）——引擎 logger 无论宿主挂
    何种 handler/formatter（宿主接管日志、basicConfig、自挂 StreamHandler
    等）都强制 redact，敏感信息不因格式化差异明文落盘。filter 在 logger
    层应用后 record.msg/record.args 已被遮蔽，下游所有 handler 看到的
    都是脱敏文本。

    对 args 逐元素脱敏（保持 % 格式化占位符与参数对齐——整体 str()
    替换会破坏 logging 的惰性格式化）。
    """

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = redact(record.msg)
            elif isinstance(record.msg, (dict, list)):
                record.msg = redact(
                    json.dumps(record.msg, ensure_ascii=False, default=str)
                )
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {
                        k: (redact(v) if isinstance(v, str) else v)
                        for k, v in record.args.items()
                    }
                else:
                    record.args = tuple(
                        redact(arg) if isinstance(arg, str) else arg
                        for arg in record.args
                    )
        except Exception:
            pass  # 失败安全：遮蔽异常不阻断日志
        return True


_REDACT_FILTER = _RedactFilter()


def get_logger(name: str) -> logging.Logger:
    """获取引擎日志器（标准库语义：不抢占 handler/级别/propagate）。

    强制挂载脱敏 Filter：所有引擎 logger（含宿主接管日志路径）的消息
    都经敏感形态遮蔽后才进入 handler 链。
    """
    logger = logging.getLogger(name)
    if _REDACT_FILTER not in logger.filters:
        logger.addFilter(_REDACT_FILTER)
    if not logger.handlers:
        logger.addHandler(logging.NullHandler())
    return logger


def configure_engine_logging(level: int = logging.INFO) -> None:
    """显式启用引擎 JSON 日志（宿主调用；未调用时引擎日志并入宿主日志体系）。

    幂等：只挂一次 JSON handler。包根 logger（``ink_engine``）挂 handler，
    子模块 logger（``ink_engine.core.*`` 等）经层级 propagate 输出，宿主
    root 采集器同样可接收。
    """
    root = logging.getLogger("ink_engine")
    for handler in root.handlers:
        if isinstance(handler, logging.StreamHandler) and not isinstance(
            handler, logging.NullHandler
        ):
            root.setLevel(level)
            return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)


__all__ = ["configure_engine_logging", "get_logger", "redact", "trace_id_var"]

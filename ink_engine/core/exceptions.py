"""引擎异常体系。

层级：EngineError（基类）→ 按语义细分。执行器只捕获 EngineError 子类
用于图终止判定；节点内部抛出的业务异常由执行器包装为 NodeExecutionError
（保留原异常链，异常快照随 checkpoint 持久化可诊断）。
"""
from __future__ import annotations

from typing import Any


class EngineError(Exception):
    """引擎异常基类。"""


class GraphDefinitionError(EngineError):
    """图定义非法（节点缺失/边目标缺失/多入口等，compile 期校验抛出）。"""


class NodeNotFoundError(GraphDefinitionError):
    """引用了不存在的节点。"""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"节点不存在: {name}")


class NodeExecutionError(EngineError):
    """节点执行失败（原异常链保留，快照随 checkpoint 持久化）。"""

    def __init__(self, node: str, cause: BaseException) -> None:
        self.node = node
        self.cause = cause
        super().__init__(f"节点执行失败 [{node}]: {cause}")


class CheckpointConflictError(EngineError):
    """checkpoint 并发写冲突（乐观锁版本号不匹配/链尾已前进，调用方应重读后重试）。"""


class InterruptError(EngineError):
    """interrupt 注入非法（未知中断点/注入值缺失等）。"""


class BudgetExceededError(EngineError):
    """执行预算超限（步骤上限/轮数上限等，触发图终止）。"""

    def __init__(self, kind: str, limit: int, current: int) -> None:
        self.kind = kind
        self.limit = limit
        self.current = current
        super().__init__(f"执行预算超限[{kind}]: {current} >= {limit}")


class StorageError(EngineError):
    """存储服务错误（后端不可用/写入失败等）。"""


class GraphVersionMismatchError(EngineError):
    """图定义版本与恢复锚点不匹配（恢复语义不保证，显式拒绝而非静默错位）。

    非存储故障：宿主不应走存储重试/降级路径，应重建会话或换锚点。
    """


class FixtureGateError(EngineError):
    """样例闸门未通过（新规则必须先让 fixture 全绿才允许落库——非谈判项）。

    异常消息携带失败用例明细（可审计）；调用方应拒绝该规则集变更落库。
    """


class SandboxViolation(EngineError):
    """沙箱守卫拒绝（路径越界/symlink 逃逸/命令不在白名单等）。"""


class ProtocolVersionError(EngineError):
    """事件协议版本不兼容（增量演进范围内加字段兼容，破坏性变更需升级版本）。"""

    def __init__(self, found: Any, expected: int) -> None:
        super().__init__(f"事件协议版本不兼容: found={found}, expected={expected}")


__all__ = [
    "BudgetExceededError",
    "CheckpointConflictError",
    "EngineError",
    "FixtureGateError",
    "GraphDefinitionError",
    "GraphVersionMismatchError",
    "InterruptError",
    "NodeExecutionError",
    "NodeNotFoundError",
    "ProtocolVersionError",
    "SandboxViolation",
    "StorageError",
]

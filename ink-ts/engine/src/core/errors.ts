/**
 * 领域错误体系：镜像 Python ink_engine.core.exceptions。
 * 执行器只捕获 EngineError 子类用于图终止判定；节点内部抛出的业务
 * 异常由执行器包装为 NodeExecutionError（保留原异常链）。
 */

/** 引擎异常基类。 */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

/** 图定义非法（节点缺失/边目标缺失/多入口等，编译期校验抛出）。 */
export class GraphDefinitionError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'GraphDefinitionError';
  }
}

/** 引用了不存在的节点。 */
export class NodeNotFoundError extends GraphDefinitionError {
  readonly name: string;

  constructor(name: string) {
    super(`节点不存在: ${name}`);
    this.name = 'NodeNotFoundError';
  }
}

/** 节点执行失败（原异常链保留，快照随 checkpoint 持久化）。 */
export class NodeExecutionError extends EngineError {
  readonly node: string;
  readonly cause: unknown;

  constructor(node: string, cause: unknown) {
    super(`节点执行失败 [${node}]: ${String(cause)}`);
    this.node = node;
    this.cause = cause;
    this.name = 'NodeExecutionError';
  }
}

/** checkpoint 并发写冲突（乐观锁版本号不匹配/链尾已前进，调用方应重读后重试）。 */
export class CheckpointConflictError extends EngineError {
  constructor(message = 'checkpoint 并发写冲突') {
    super(message);
    this.name = 'CheckpointConflictError';
  }
}

/** interrupt 注入非法（未知中断点/注入值缺失等）。 */
export class InterruptError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptError';
  }
}

/** 存储服务错误（后端不可用/写入失败等）。 */
export class StorageError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** 图定义版本与恢复锚点不匹配（恢复语义不保证，显式拒绝而非静默错位）。 */
export class GraphVersionMismatchError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'GraphVersionMismatchError';
  }
}

/** 样例闸门未通过（新规则必须先让 fixture 全绿才允许落库）。 */
export class FixtureGateError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureGateError';
  }
}

/** 沙箱守卫拒绝（路径越界/symlink 逃逸/命令不在白名单等）。 */
export class SandboxViolation extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolation';
  }
}

/** 决策点推演失败（分支清单非法/评估器未注入/全部分支失败等）。 */
export class SimulationError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

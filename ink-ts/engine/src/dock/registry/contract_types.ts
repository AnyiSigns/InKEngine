/**
 * 机制件契约类型（MechanismContract）——机制件装配闭集的声明面。
 *
 * 机制件不是插件（插件走 CapabilityComponent，见 PLUGINS.md §1/§3），机制件
 * 走独立 MechanismContract：契约化后归 engine/src/kernel/<mechanism>/，每件
 * contract.ts 声明契约（effects 端口白名单 + depends 依赖图），impl.ts 为
 * 注入工厂；boot 组密封（registry.ts）校验单向依赖 + 完整 + 循环拒绝。
 *
 * effects 语义 = 0-IO 白名单：只允许引用已声明端口（storage_seam/llm_port/
 * exec_envelope/rounds.port…）。端口 id 与依赖 id 共用同一命名空间（点分或
 * 下划线均可），由 registry 的 external 名单放行非本注册表内 id。
 */

/** 机制件契约：装配闭集内的最小声明单元（目录级契约，每机制一份 contract.ts）。 */
export interface MechanismContract {
  /** 注册表键：全局唯一，与目录同名（真实代码目录名，勿用概念名）。 */
  id: string;
  /** 契约面：inputs/outputs 形状（可选）+ effects 声明端口白名单。 */
  contract: {
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    effects: readonly string[];
  };
  /** 依赖其它机制 id / 机制端口 id（形成 DAG；装配期校验单向 + 完整 + 循环拒绝）。 */
  depends: readonly string[];
  /** 注入工厂：boot 密封时调用一次，宿主装配期注入端口实现。 */
  inject?: (deps: Record<string, unknown>) => unknown;
}

/** 契约可引用、但不在本注册表内的外部端口 id（引擎内核导出的机制端口等）。 */
export interface MechanismRegistryOptions {
  /** 已知副作用端口名（effects 白名单）；空 = 只校验已声明项是否被外部名单放行。 */
  effectAllowlist?: readonly string[];
  /** 外部依赖 id 名单（如 rounds.port 等引擎导出端口）；不在此名单的未知 id = 违规。 */
  externalDeps?: readonly string[];
}

/** 密封结果：契约表（按 id）+ 拓扑装配序（depends 先于依赖者）。 */
export interface SealedMechanismRegistry {
  contracts: ReadonlyMap<string, MechanismContract>;
  order: readonly string[];
}

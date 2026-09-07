/**
 * 机制件注册表公共面：契约类型 + 端口词汇 + 装配密封。
 *
 * 机制件契约声明（kernel/<mechanism>/contract.ts）经本公共面取类型与端口
 * 常量；boot 密封与 verify 经 seal_mechanism_registry 校验依赖图（单向/
 * 完整/循环拒绝）并取拓扑装配序。
 */

export type {
  MechanismContract,
  MechanismRegistryOptions,
  SealedMechanismRegistry,
} from './contract_types.js';

export {
  find_cycles,
  seal_mechanism_registry,
  topo_order,
  validate_mechanism_registry,
} from './registry.js';
export type { RegistryViolation } from './registry.js';

export {
  MECHANISM_PORT_IDS,
  PORT_EXEC_ENVELOPE,
  PORT_LLM_PORT,
  PORT_ROUNDS,
  PORT_STORAGE_SEAM,
} from './ports.js';

/**
 * 机制注册 seal 声明壳：kernel/registry 公共符号的 dock 侧取径（计划 §3.2
 * kernel/registry → dock/registry、§5.1.1 layer-dag 白名单、P1 裁决 4）。
 *
 * 四件→dock 只放行 dock/ports(.ts|/*) 与 dock/registry(.ts|/*) 两个声明面前缀；
 * 机制契约消费方（verify_mechanisms/boot 密封）经本壳取 ALL_MECHANISM_CONTRACTS
 * 与密封函数，端口词表真源在姊妹面 dock/ports.ts。本壳与 kernel/registry/index.ts
 * 公共符号集逐字一致；kernel/registry 本体本轮不搬迁，P3 迁 registry 本体入
 * dock/registry/ 后本壳随迁收敛。本壳不经 dock/index.ts 出公共面（现有符号集
 * 保持，宿主不从此处取机制契约）。
 */

export type {
  MechanismContract,
  MechanismRegistryOptions,
  SealedMechanismRegistry,
} from '../kernel/registry/index.js';

export {
  ALL_MECHANISM_CONTRACTS,
  find_cycles,
  seal_mechanism_registry,
  topo_order,
  validate_mechanism_registry,
} from '../kernel/registry/index.js';
export type { RegistryViolation } from '../kernel/registry/index.js';

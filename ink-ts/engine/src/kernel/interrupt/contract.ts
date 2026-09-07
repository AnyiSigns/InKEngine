/**
 * interrupt 机制件契约声明：挂起/注入重入原语的纯逻辑面。
 *
 * 契约面：effects 声明本机制消费的副作用端口白名单——interrupt 承载中断
 * 键基底运算（interrupt_base_key）、宽容命中判定（interrupt_key_matches）
 * 与 InterruptCoordinator 注入协调状态机，为纯内存实例态逻辑（零全局状态、
 * 零 IO）；checkpoint 持久化/恢复由引擎（executor/graph/storage）接线，
 * 本模块不感知存储。中断是引擎控制流一等能力——interrupt 自身是原语提供
 * 方而非端口消费方，storage/llm/exec/rounds 四端口均不消费。
 *
 * depends 为空：interrupt 不直接依赖任何其它机制件（仅 core 错误面与
 * 同目录数据面）。契约化归属见
 * engine/src/kernel/registry/contract_types.ts。
 */

import type { MechanismContract } from '../registry/contract_types.js';

/** interrupt 机制契约：零机制间依赖，零副作用端口（纯内存协调原语）。 */
export const interrupt_contract: MechanismContract = {
  id: 'interrupt',
  contract: {
    effects: [],
  },
  depends: [],
};

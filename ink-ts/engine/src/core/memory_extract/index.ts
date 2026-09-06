/**
 * 记忆无感提取域公开 re-export（snake_case 镜像 Python `__all__`，
 * 并附带契约常量 ROUND_FACT_EVENTS / CONFIRMATION_EVENTS——账本事实事件
 * 口径的权威声明）。
 *
 * 文件拆分纪律：提取规则 / 冲突消解逻辑单文件（memory_extract），
 * 回合抽取 settle 钩子落 settle.ts，存储复用 memory 域（MemoryEntry /
 * StorageBackedMemoryStore）。
 *
 * 状态标注（机制已接线）：回合记忆抽取 settle 钩子（MemoryExtractSettleHook）
 * 默认随 Runtime 装配（每回合收尾触发一次，见 runtime/_runtime_self_learning）；
 * 存储面 = StorageBackedMemoryStore（runtime 默认装配，EvolutionWriter
 * kind=memory 受控通道）。
 */

export {
  CONFIRMATION_EVENTS,
  DEFAULT_NAMESPACE,
  PRIORITY_CONCLUSION,
  PRIORITY_CONFIRMATION,
  PRIORITY_INTENT,
  ROUND_FACT_EVENTS,
  arbitrate_and_store,
  extract_entries_from_ledger,
} from './memory_extract.js';

export type {
  ArbitrateStoreResult,
  ExtractLedgerOptions,
  MemoryExtractArbitration,
} from './memory_extract.js';

export { MemoryExtractSettleHook } from './settle.js';
export type {
  LedgerFactsProvider,
  MemoryExtractSettleHookOptions,
} from './settle.js';

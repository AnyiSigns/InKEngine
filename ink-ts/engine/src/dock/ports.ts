/**
 * 机制端口 id 规范常量（effects/depends 命名空间单一事实源）。
 *
 * 契约的 effects（端口白名单）与 depends（可依赖机制端口）统一引用本文件
 * 常量，不散写字面量——verify（0-IO/装配完整）与 boot 密封共用同一词汇表。
 * 端口 = 引擎导出的可注入副作用面（宿主装配期注入实现），非插件、非机制。
 */

/** 存储 seam：审计/补丁链/记录等受守卫落库端口。 */
export const PORT_STORAGE_SEAM = 'storage_seam';
/** LLM/嵌入端口：按协议适配的模型推理 seam。 */
export const PORT_LLM_PORT = 'llm_port';
/** exec 信封：子进程/沙箱执行端口（宿主注入 Rust 原生信封）。 */
export const PORT_EXEC_ENVELOPE = 'exec_envelope';
/** 回合端口：组装回合/恢复/审批重入的引擎导出机制端口（插件 depends 可依赖）。 */
export const PORT_ROUNDS = 'rounds.port';

/** 全部已知机制端口（契约 effects 白名单默认集）。 */
export const MECHANISM_PORT_IDS: readonly string[] = [
  PORT_STORAGE_SEAM,
  PORT_LLM_PORT,
  PORT_EXEC_ENVELOPE,
  PORT_ROUNDS,
];

/**
 * dock 公共面收敛者：引擎对外边界的声明面聚合入口。
 *
 * dock = 引擎唯一对外边界（纯契约/声明面，零行为）。本文件聚合各声明面：
 * 端口词表（`MECHANISM_PORT_IDS` 与 `PORT_*` 常量，effects/depends
 * 命名空间单一事实源）。取径：宿主经 `@ink-ts/engine` 入口消费，机制件按
 * 层向纪律只允许 import `dock/ports` 前缀声明面（gate `layer-dag` 执法）。
 */

export * from './ports.js';

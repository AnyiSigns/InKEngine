/**
 * @ink-ts/engine 入口：只转发 dock（计划 §2/§4.5，P1 裁决 2）。
 *
 * 公共面全部符号与分组注释收敛在 engine/src/dock/index.ts（单一不可拆
 * 收敛面，超限豁免注记在该文件头）；宿主 @ink-ts/engine import 零改动。
 * dock/ports.ts 与 dock/registry.ts 是四件→dock 层向白名单的内部声明面，
 * 不经本入口出公共面。取径：dump_api_surface 自本文件沿 export * 递归展开。
 */

export * from './dock/index.js';

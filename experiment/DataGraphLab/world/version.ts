/**
 * 世界版本 = 算子契约表的规范 hash（G0.1 与 GateResult 的共同口径）。
 *
 * 契约表任一字段变化（id/kind/requires/when/provides/out_type）都会改变版本号，
 * 旧数据的 `task_hash` 随之失效——这是数据集可追溯、可回滚的前提。`entry`/`exit`
 * 是结构节点、无契约，不计入；`MAX_REPEAT` 属 runner 常量，也不计入本版本。
 */

import { hashObj } from './hash.js';
import { OPS } from './operators.js';

const CONTRACT_TABLE = OPS.map((o) => ({
  id: o.id,
  kind: o.kind,
  requires: o.requires,
  when: o.when ?? {},
  provides: o.provides,
  out_type: o.out_type,
}));

/** 稳定版本串（sha1 前 16 位，随契约表内容变化）。 */
export const worldVersion: string = hashObj(CONTRACT_TABLE);

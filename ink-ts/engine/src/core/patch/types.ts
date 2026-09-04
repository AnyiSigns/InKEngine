/**
 * patch 域数据形态（内容型补丁链 Event Sourcing 原语）。
 * op 字符串与 contracts patch_protocol fixture 保持一致，由一致性测试钉住。
 */

import type { Json, JsonRecord } from '../json.js';

export type { Json };
export type { JsonRecord };

/** 路径：dict 段用 string，list 段用 number（与契约序列化 path 数组同构）。 */
export type Path = readonly (string | number)[];

export const PATCH_OP_VALUES = ['append', 'replace', 'delete'] as const;
export type PatchOp = (typeof PATCH_OP_VALUES)[number];

export const ASSEMBLE_MODE_VALUES = ['full', 'base_only', 'partial'] as const;
export type AssembleMode = (typeof ASSEMBLE_MODE_VALUES)[number];

export interface Patch {
  op: PatchOp;
  path: Path;
  value?: Json;
}

export interface PatchChainState {
  base: { [key: string]: Json };
  patches: Patch[];
}

export interface PatchChainSerialized {
  base: { [key: string]: Json };
  patches: { op: PatchOp; path: (string | number)[]; value: Json }[];
}

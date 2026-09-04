/**
 * 种子路径导入（沉淀侧统一入口形态）。
 *
 * 对标 ink_engine.core.settle.import_seed_paths：复用 edge_evidence 的
 * import_seed_paths，本层为沉淀侧的统一入口。出厂资产通道只供数据——
 * 边证据初始化；已存在同键行（运行期证据在先）不覆盖。
 */

import { EdgeEvidenceStore } from '../edge_evidence/store.js';
import { import_seed_paths as _import_seed_paths } from '../edge_evidence/seed.js';
import type { SeedEdgeRaw } from '../edge_evidence/seed.js';

/** 种子路径导入（沉淀侧统一入口）：返回写入条数。 */
export async function import_seed_paths(
  store: EdgeEvidenceStore,
  seed_edges: readonly SeedEdgeRaw[] | readonly Record<string, unknown>[],
): Promise<number> {
  return await _import_seed_paths(store, seed_edges as readonly SeedEdgeRaw[]);
}

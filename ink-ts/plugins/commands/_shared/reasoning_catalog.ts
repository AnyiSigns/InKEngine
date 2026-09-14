/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/reasoning_catalog.ts 原样迁入（S3 命令逻辑下沉，
 * 语义零改）：推理能力手工维护目录（兜底真源，默认空——不硬编码模型）。
 *
 * 维护提示：本目录仅供「厂商不发布能力」的模型做显式备份；**默认留空**，避免
 * 把模型名写死进代码。某模型官方语义已知时，由用户在此加一条（pattern +
 * reasoning_style）；未命中目录且厂商也未发布 → 视为未知，UI 不显示推理控件
 * （不伪造档位，符合「能力来自数据」）。
 */

export interface ReasoningCatalogEntry {
  pattern: RegExp;
  reasoning: boolean;
  reasoning_style?: 'effort' | 'boolean' | 'budget' | 'none';
  reasoning_efforts?: Array<'off' | 'low' | 'medium' | 'high'>;
  reasoning_budget?: number[];
}

/** 厂商未发布能力时的手工兜底条目（默认空，逐条按需维护）。 */
export const REASONING_CATALOG: ReasoningCatalogEntry[] = [];

/** 按 model_id 匹配目录（首条命中；未命中 = null）。 */
export function matchReasoningCatalog(modelId: string): ReasoningCatalogEntry | null {
  const id = modelId.trim().toLowerCase();
  for (const entry of REASONING_CATALOG) {
    if (entry.pattern.test(id)) return entry;
  }
  return null;
}

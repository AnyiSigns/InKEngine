/**
 * model_archive 命令面（模型档案快照）。
 *
 * Rust 壳侧读 model_archive.sqlite（探测补录档案库）；TS host 无该存储，
 * 快照从**运行 model_config 聚合**（agent/router 主槽 + 备用链端点），与
 * config.json 同源、不引入探测/补录。各端点 model_id 去重按字典序输出；
 * context_window/multimodal 属探测产物，TS 侧未知字段从略（web 消费端
 * 容缺省）。
 *
 * 档案语义说明：web 输入胶囊/模型设置消费 archives（model_id 选择面），
 * 空配置 = 空清单（ok:true, archives:[]），不误报。
 */

import type { ModelArchiveCommand } from './commands.generated.js';
export { MODEL_ARCHIVE_COMMANDS, type ModelArchiveCommand } from './commands.generated.js';
import type { BridgeHandler, HostBridgeDeps } from './_types.js';
import { matchReasoningCatalog } from './reasoning_catalog.js';
import {
  fetchModelCatalog,
  type CatalogFetch,
  type ModelCapabilityMap,
} from './model_catalog.js';
import { fetchModelsDevCatalog, lookupModelsDevCapability } from './model_modelsdev.js';

/** 厂商 /models 能力抓取的默认网络缓存（TTL + 在途去重；注入的 fetch 不缓存）。 */
const VENDOR_FETCH_TTL_MS = 10 * 60 * 1000;
const _vendorCache = new Map<
  string,
  { at: number; value: Promise<{ ok: boolean; catalog: ModelCapabilityMap }> }
>();

/** 厂商 /models 抓取（注入 fetchImpl = 测试桩直调不缓存；缺省 = 默认网络
 *  走 TTL/在途缓存，避免热路径重复外呼）。失败降级空目录（.catch 收敛）。 */
function vendorCatalogFetch(
  base_url: string,
  api_key: string | null,
  fetchImpl: CatalogFetch | undefined,
): Promise<{ ok: boolean; catalog: ModelCapabilityMap }> {
  const run = (): Promise<{ ok: boolean; catalog: ModelCapabilityMap }> =>
    fetchModelCatalog(base_url, api_key, fetchImpl).catch(() => ({
      ok: false as const,
      catalog: {} as ModelCapabilityMap,
    }));
  if (fetchImpl !== undefined) return run();
  const cacheKey = `${base_url}\u0001${api_key ?? ''}`;
  const hit = _vendorCache.get(cacheKey);
  if (hit !== undefined && Date.now() - hit.at < VENDOR_FETCH_TTL_MS) return hit.value;
  const value = run();
  _vendorCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 端点记录是否含有效 model_id（角色槽主配置与备用链同一形态）。 */
function endpointModelId(value: unknown): { model_id: string } | null {
  if (!isRecord(value)) return null;
  const modelId = value['model_id'];
  return typeof modelId === 'string' && modelId !== '' ? { model_id: modelId } : null;
}

/** 推理档位取值（与前端对齐；仅字段透传，不解释语义）。允许 xhigh/max/minimal 等非标准档。 */
type ArchiveReasoningEffort = string;

/**
 * 推理模式（引擎 base.ts 语义）：effort=档位(off/low/medium/high)；
 * boolean=enable_thinking 开关；budget=thinking budget；none=固定推理不注入档位。
 * 真源 = 模型 LLM 配置的 extra.reasoning_style（非独立官方档案）。
 */
type ArchiveReasoningStyle = 'effort' | 'boolean' | 'budget' | 'none';

/** 厂商模型条目可声明的推理能力（配置档案透传；未声明 = 未知）。 */
interface ReasoningCapability {
  reasoning?: boolean;
  reasoning_style?: ArchiveReasoningStyle;
  reasoning_efforts?: Array<ArchiveReasoningEffort>;
  reasoning_budget?: number[];
}

function normalizeReasoningStyle(value: unknown): ArchiveReasoningStyle | undefined {
  if (value === 'effort' || value === 'boolean' || value === 'budget' || value === 'none') {
    return value;
  }
  return undefined;
}

function parseReasoning(value: unknown): ReasoningCapability {
  if (!isRecord(value)) return {};
  const capability: ReasoningCapability = {};
  const extra = isRecord(value['extra']) ? value['extra'] : null;
  const style =
    normalizeReasoningStyle(value['reasoning_style']) ??
    normalizeReasoningStyle(extra?.['reasoning_style']);
  if (style !== undefined) {
    capability.reasoning_style = style;
    capability.reasoning = style !== 'none';
  }
  if (typeof value['reasoning'] === 'boolean') {
    capability.reasoning = value['reasoning'];
  }
  if (Array.isArray(value['reasoning_efforts'])) {
    const efforts: ArchiveReasoningEffort[] = [];
    for (const item of value['reasoning_efforts']) {
      if (typeof item === 'string' && item !== '') efforts.push(item);
    }
    if (efforts.length > 0) capability.reasoning_efforts = efforts;
  }
  if (Array.isArray(value['reasoning_budget']) || Array.isArray(extra?.['reasoning_budget'])) {
    const raw = Array.isArray(value['reasoning_budget']) ? value['reasoning_budget'] : extra?.['reasoning_budget'];
    const budgets: number[] = [];
    for (const item of (raw as unknown[])) {
      if (typeof item === 'number' && item > 0) budgets.push(item);
    }
    if (budgets.length > 0) capability.reasoning_budget = budgets;
  }
  return capability;
}

/** 厂商记录（providers[] 元素：base_url + models 清单 + provider_id）。 */
function providerRecordModels(
  value: unknown,
): Array<{ model_id: string; context_window?: number } & ReasoningCapability> | null {
  if (!isRecord(value)) return null;
  if (typeof value['provider_id'] !== 'string' || !Array.isArray(value['models'])) return null;
  if (typeof value['base_url'] !== 'string') return null;
  const rows: Array<{ model_id: string; context_window?: number } & ReasoningCapability> = [];
  for (const entry of value['models']) {
    if (typeof entry === 'string') {
      if (entry !== '') rows.push({ model_id: entry });
    } else if (isRecord(entry)) {
      const modelId = entry['model_id'];
      if (typeof modelId === 'string' && modelId !== '') {
        const row: { model_id: string; context_window?: number } & ReasoningCapability = {
          model_id: modelId,
          ...parseReasoning(entry),
        };
        if (typeof entry['context_window'] === 'number') {
          row.context_window = entry['context_window'];
        }
        rows.push(row);
      }
    }
  }
  return rows.length > 0 ? rows : null;
}

/** 模型档案行（含归属厂商与上下文窗口，web 选择面可显示/回指）。 */
export interface ArchiveRow {
  model_id: string;
  provider_id?: string;
  context_window?: number;
  /** 推理能力（厂商配置档案透传；未声明/未知 = undefined）。 */
  reasoning?: boolean;
  reasoning_style?: 'effort' | 'boolean' | 'budget' | 'none';
  reasoning_efforts?: string[];
  reasoning_budget?: number[];
}

/** 从 model_config 记录聚合全部已配置/已添加模型（角色槽主配置 + 备用链 +
 *  厂商清单；保持字典序、按 厂商+model 去重）。 */
export function collectArchiveRows(modelConfig: Record<string, unknown>): ArchiveRow[] {
  const seen = new Set<string>();
  const rows: ArchiveRow[] = [];
  const hasProviders =
    Array.isArray(modelConfig['providers']) && modelConfig['providers'].length > 0;
  const pushRow = (row: ArchiveRow): void => {
    const key = row.provider_id !== undefined
      ? `${row.provider_id}/${row.model_id}`
      : row.model_id;
    if (!seen.has(key)) {
      seen.add(key);
      rows.push(row);
    }
  };
  const visit = (value: unknown): void => {
    if (isRecord(value)) {
      const providerRows = providerRecordModels(value);
      if (providerRows !== null) {
        const providerId = typeof value['provider_id'] === 'string' ? value['provider_id'] : undefined;
        for (const entry of providerRows) {
          pushRow({ ...entry, ...(providerId !== undefined ? { provider_id: providerId } : {}) });
        }
        return;
      }
      // 角色槽端点 = 厂商清单派生（agent/router 槽模型均在 providers 内）；
      // 厂商面存在时不重复收录槽端点行（避免档案双份）。无厂商（旧直写
      // 槽/备用链配置）时保留端点行语义。
      if (hasProviders) return;
      const endpoint = endpointModelId(value);
      if (endpoint !== null) {
        const providerId = typeof value['provider_id'] === 'string' ? value['provider_id'] : undefined;
        const row: ArchiveRow = {
          model_id: endpoint.model_id,
          ...parseReasoning(value),
        };
        if (typeof value['context_window'] === 'number') {
          row.context_window = value['context_window'];
        }
        if (providerId !== undefined) row.provider_id = providerId;
        pushRow(row);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    }
  };
  for (const value of Object.values(modelConfig)) {
    visit(value);
  }
  rows.sort((a, b) => a.model_id.localeCompare(b.model_id));
  return rows;
}

/** 从 model_config 收集所有端点 base_url（providers[] 与槽/备用链端点）。
 *  去重；每项附带同层 api_key（可为空/掩码）。 */
function collectBaseUrls(modelConfig: Record<string, unknown>): Array<{ base_url: string; api_key: string | null }> {
  const seen = new Map<string, string | null>();
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record['base_url'] === 'string' && record['base_url'] !== '') {
      const key = record['base_url'];
      if (!seen.has(key)) {
        const apiKey = typeof record['api_key'] === 'string' ? record['api_key'] : null;
        seen.set(key, apiKey);
      }
      return;
    }
    for (const item of Object.values(record)) walk(item);
  };
  walk(modelConfig);
  return [...seen.entries()].map(([base_url, api_key]) => ({ base_url, api_key }));
}

/** 应用厂商元数据能力（优先级：显式配置 > 厂商元数据 > 手工目录）。 */
function applyVendorCapabilities(rows: ArchiveRow[], vendor: ModelCapabilityMap): void {
  for (const row of rows) {
    if (row.reasoning !== undefined) continue;
    const cap = lookupModelsDevCapability(vendor, row.model_id);
    if (cap === undefined) continue;
    row.reasoning = cap.reasoning;
    if (cap.reasoning_style !== undefined) row.reasoning_style = cap.reasoning_style;
    if (cap.reasoning_efforts !== undefined) row.reasoning_efforts = cap.reasoning_efforts;
    if (cap.reasoning_budget !== undefined) row.reasoning_budget = cap.reasoning_budget;
  }
}

/** 模型条目仍无推理能力时按手工目录兜底（真源 reasoning_catalog.ts）。 */
function applyFileCatalog(rows: ArchiveRow[]): void {
  for (const row of rows) {
    if (row.reasoning !== undefined) continue;
    const cat = matchReasoningCatalog(row.model_id);
    if (cat === null) continue;
    row.reasoning = cat.reasoning;
    if (cat.reasoning_style !== undefined) row.reasoning_style = cat.reasoning_style;
    if (cat.reasoning_efforts !== undefined) row.reasoning_efforts = cat.reasoning_efforts;
    if (cat.reasoning_budget !== undefined) row.reasoning_budget = cat.reasoning_budget;
  }
}

export function buildModelArchiveCommands(deps: HostBridgeDeps): Readonly<Record<ModelArchiveCommand, BridgeHandler>> {
  const snapshot: BridgeHandler = async (): Promise<unknown> => {
    const state = deps.host.model_config_state();
    const modelConfig = isRecord(state['model_config']) ? state['model_config'] : {};
    const rows = collectArchiveRows(modelConfig);

    // 能力优先级：显式配置 > models.dev 快照（最完整档位） > 厂商 /models > 手工目录
    const modelsDev = await fetchModelsDevCatalog(deps.catalogFetch).catch(() => ({} as ModelCapabilityMap));
    applyVendorCapabilities(rows, modelsDev);

    // 厂商元数据抓取：各端点 base_url 的 /models 能力（开箱即官方，失败回退目录；
    // 并发外呼 + 缺省 TTL/在途缓存，单端点 8s abort 不串行叠加）
    const vendorResults = await Promise.all(
      collectBaseUrls(modelConfig).map(({ base_url, api_key }) =>
        vendorCatalogFetch(base_url, api_key, deps.catalogFetch),
      ),
    );
    const vendor: ModelCapabilityMap = {};
    for (const result of vendorResults) {
      if (result.ok) Object.assign(vendor, result.catalog);
    }
    applyVendorCapabilities(rows, vendor);
    applyFileCatalog(rows);

    return { ok: true, archives: rows };
  };

  return { 'model_archive.snapshot': snapshot };
}

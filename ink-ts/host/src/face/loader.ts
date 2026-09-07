/**
 * host logic face 装载器（阶段 7a：物理单目录 + 装配期按声明装载）。
 *
 * 读取 plugins/manifest.json 派生视图 plugins[]：faces.logic.target='host' 的
 * 插件行 → 解析 `plugins/<dir>/<entry>`（相对路径、禁越界逃逸）→ 动态 import。
 * - 插件源不可用（无 manifest）= 返回空集（消费方降级；如 docParse 缺省 =
 *   仅文件名引用、不做文本注入）；
 * - 已声明 host logic face 的 entry 装载失败 = fail-closed 抛错（装配期可见，
 *   不静默降级——代码错误必须在装配期暴露）；
 * - loader 不解释模块内部形态：逻辑 face 契约（默认导出工厂 + init 形状）由
 *   插件 spec/AGENTS 自证，装配侧按插件 id 取用并注入。
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { findPluginsManifest, pluginsRootOf } from '../plugins_fs.js';

/** manifest plugins[] 中 faces.logic.target='host' 的行（声明面）。 */
export interface HostLogicFaceRow {
  pluginId: string;
  dir: string;
  entry: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** entry 越界判定：禁绝对路径 / 盘符 / `..` 段（须在插件目录内相对）。 */
function entryUnsafe(entry: unknown): boolean {
  return (
    typeof entry !== 'string' ||
    entry === '' ||
    entry.startsWith('/') ||
    /^[a-zA-Z]:/.test(entry) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(entry)
  );
}

/** 列出 host logic face 声明（无 manifest = 空；manifest 缺 faces 行不报）。 */
export function listHostLogicFaces(seedDir?: string | null): HostLogicFaceRow[] {
  const manifestPath = findPluginsManifest(seedDir);
  if (manifestPath === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  const plugins = isRecord(parsed) && Array.isArray(parsed['plugins']) ? parsed['plugins'] : [];
  const rows: HostLogicFaceRow[] = [];
  for (const row of plugins) {
    if (!isRecord(row)) continue;
    const id = row['id'];
    const dir = row['dir'];
    const faces = row['faces'];
    if (typeof id !== 'string' || id === '' || typeof dir !== 'string' || dir === '' || !isRecord(faces)) {
      continue;
    }
    const logic = faces['logic'];
    if (!isRecord(logic) || logic['target'] !== 'host') continue;
    if (entryUnsafe(logic['entry'])) continue;
    rows.push({ pluginId: id, dir, entry: logic['entry'] as string });
  }
  return rows.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

/** 装配期装载全部 host logic face → { 插件 id: 模块命名空间 }。 */
export async function loadHostLogicFaces(seedDir?: string | null): Promise<Record<string, unknown>> {
  const loaded: Record<string, unknown> = {};
  const manifestPath = findPluginsManifest(seedDir);
  if (manifestPath === null) return loaded;
  const root = pluginsRootOf(manifestPath);
  for (const row of listHostLogicFaces(seedDir)) {
    const pluginDir = join(root, row.dir);
    const absEntry = join(pluginDir, row.entry);
    const rel = relative(pluginDir, absEntry);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`host logic face ${row.pluginId} entry 越界: ${row.entry}`);
    }
    const module = await import(pathToFileURL(absEntry).href);
    loaded[row.pluginId] = module;
  }
  return loaded;
}

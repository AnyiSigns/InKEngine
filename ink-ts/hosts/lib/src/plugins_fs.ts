/**
 * 插件源定位（plugins/manifest.json 派生视图路径探测）——host 消费面共享。
 *
 * seed_dir 优先：目录内直接含 manifest.json；缺省 = 沿模块目录（host 包位置）
 * 向上探测 `plugins/manifest.json`（深度上限 PROBE_DEPTH）。找不到 = null，
 * 调用方决定语义（mcp.market 报不可用；host logic-face loader 降级为空集）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_MANIFEST = 'manifest.json';

/** manifest 文件探测深度（seed_dir 未给时沿包位置上探 plugins/）。 */
const PROBE_DEPTH = 6;

/** 定位 plugins/manifest.json（不存在 = null；存在但不可读也归 null）。 */
export function findPluginsManifest(seedDir?: string | null): string | null {
  if (seedDir !== undefined && seedDir !== null && seedDir !== '') {
    const explicit = join(seedDir, PLUGIN_MANIFEST);
    try {
      readFileSync(explicit);
      return explicit;
    } catch {
      return null;
    }
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < PROBE_DEPTH; depth += 1) {
    const candidate = join(dir, 'plugins', PLUGIN_MANIFEST);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  return null;
}

/** plugins 根目录（manifest.json 所在目录 = plugins/ 真源根）。 */
export function pluginsRootOf(manifestPath: string): string {
  return dirname(manifestPath);
}

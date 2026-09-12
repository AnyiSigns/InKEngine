/**
 * layer-dag 层向门禁（计划 §5.1.1 + §2 依赖目标）：引擎新七层
 * `engine/src/{model,loop,graph,gate,evolve,dock,adapters}` 的 import 方向矩阵。
 * 目录不存在即跳过（与 scan.ts 行为一致；未搬迁波次自然静默）。
 *
 * 矩阵（白名单前缀写死于本实现，不做模糊匹配）：
 * - model：零依赖（禁 import 其余任何层）；
 * - loop|graph|gate|evolve → model：放行；
 * - 四件 → dock：仅放行前缀 `dock/ports(.ts|/*)` 与 `dock/registry(.ts|/*)`；
 *   其余 `dock/**` 禁入；
 * - dock → 四件：只允许 import 各机制 `contract.ts` 且只能 re-export；
 * - adapters：只 import `dock/ports` 前缀与 model；
 * - 四件间允许边：loop→graph、evolve→gate；其余四件互引违规；
 * - 未定义的层间边一律违规（矩阵闭合，防漂移）。
 * 目标层判定只认上述七层目录；engine/src 下其余旧区（core/kernel 等）过渡期
 * 不参与层向判定（其纪律由 core-import/core-token/private-seam 现规则执法）。
 *
 * 红线（机制层 loop/graph/gate/evolve 文件，§2.1/§2.2）：禁相对 import 命中
 * 旧组装模块（path_assembler/thread_skeleton/fingerprint_cache/core/assembly），
 * 禁 token（组装路径/出厂图/默认拓扑/每回合拼图）——防旧组装借重排回潮。
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GateConfig } from './config.js';
import type { Violation } from './rules.js';

const LAYERS = ['model', 'loop', 'graph', 'gate', 'evolve', 'dock', 'adapters'] as const;
type Layer = (typeof LAYERS)[number];
const FOUR: readonly string[] = ['loop', 'graph', 'gate', 'evolve'];
const SRC_PREFIX = 'engine/src/';
/** 四件 → dock 仅放行这两个声明面前缀（§5.1 精确口径，写死不模糊）。 */
const DOCK_ALLOWED_PREFIXES: readonly string[] = ['dock/ports', 'dock/registry'];
/** 机制层红线：旧组装模块子串（相对 import 说明符命中即违规）。 */
const REDLINE_REL_SUBSTRINGS: readonly string[] = ['path_assembler', 'thread_skeleton', 'fingerprint_cache', 'core/assembly'];
/** 机制层红线：组装语义 token（文件文本命中即违规）。 */
const REDLINE_TOKENS: readonly string[] = ['组装路径', '出厂图', '默认拓扑', '每回合拼图'];

const IMPORT_FROM_RE = /(import|export)(?:\s+[\w*{},\s$]*?)?\s*from\s*['"](\.\/[^'"]+|\.\.\/[^'"]+)['"]/g;
const BARE_REL_IMPORT_RE = /import\s*['"](\.[^'"]+)['"]/g;

async function collectTs(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectTs(full, out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

function layerOf(rel: string): Layer | null {
  if (!rel.startsWith(SRC_PREFIX)) return null;
  const head = rel.slice(SRC_PREFIX.length).split('/')[0] ?? '';
  return (LAYERS as readonly string[]).includes(head) ? (head as Layer) : null;
}

/** NodeNext 风格说明符解析：`.js` → `.ts`。返回 root 相对 posix 路径（engine/src 内）。 */
function resolveSpec(root: string, importerRel: string, spec: string): string | null {
  const dir = importerRel.slice(0, importerRel.lastIndexOf('/'));
  let abs = resolve(root, dir, spec);
  if (abs.endsWith('.js')) abs = `${abs.slice(0, -3)}.ts`;
  if (!abs.startsWith(root)) return null;
  const rel = abs
    .slice(root.length + 1)
    .split('\\')
    .join('/');
  return rel.startsWith(SRC_PREFIX) ? rel : null;
}

/** 前缀放行：`p` 恰为 `dock/ports`/`dock/registry` 时，仅 `.ts` 文件或 `/` 子目录。 */
function matchesAllowedPrefix(targetRel: string, prefixes: readonly string[]): boolean {
  const inSrc = targetRel.slice(SRC_PREFIX.length);
  return prefixes.some((p) => inSrc === `${p}.ts` || inSrc.startsWith(`${p}/`));
}

interface EdgeVerdict {
  message: string | null;
}

/** 判定一条层间 import 边（importerLayer 与 targetRel 均属七层且不同层）。 */
function classifyEdge(importerRel: string, importerLayer: Layer, targetRel: string, targetLayer: Layer, isReExport: boolean): EdgeVerdict {
  if (importerLayer === targetLayer) return { message: null };
  if (importerLayer === 'model') {
    return { message: `model 零依赖：禁 import 其余层（命中 ${targetLayer}）` };
  }
  if (FOUR.includes(importerLayer)) {
    if (targetLayer === 'model') return { message: null };
    if (FOUR.includes(targetLayer)) {
      const allowed = (importerLayer === 'loop' && targetLayer === 'graph') || (importerLayer === 'evolve' && targetLayer === 'gate');
      return allowed ? { message: null } : { message: `四件间仅允许 loop→graph、evolve→gate（发现 ${importerLayer}→${targetLayer}）` };
    }
    if (targetLayer === 'dock') {
      return matchesAllowedPrefix(targetRel, DOCK_ALLOWED_PREFIXES)
        ? { message: null }
        : { message: `四件→dock 仅放行 dock/ports(.ts|/*)、dock/registry(.ts|/*)（命中 ${targetRel.slice(SRC_PREFIX.length)}）` };
    }
    return { message: `${importerLayer} 禁 import ${targetLayer}` };
  }
  if (importerLayer === 'dock') {
    if (FOUR.includes(targetLayer)) {
      const inSrc = targetRel.slice(SRC_PREFIX.length);
      const isContract = /^[^/]+\/[^/]+\/contract\.ts$/.test(inSrc);
      if (isContract && isReExport) return { message: null };
      return { message: `dock→四件只允许 re-export 各机制 contract.ts（命中 ${inSrc}${isContract ? '，非 re-export' : ''}）` };
    }
    return { message: `dock 层禁 import ${targetLayer}（dock 仅经 contract re-export 聚合声明面）` };
  }
  // adapters：只 import dock/ports 前缀与 model
  if (targetLayer === 'model') return { message: null };
  if (targetLayer === 'dock') {
    return matchesAllowedPrefix(targetRel, ['dock/ports'])
      ? { message: null }
      : { message: `adapters 只允许 import dock/ports(.ts|/*)、model（命中 ${targetRel.slice(SRC_PREFIX.length)}）` };
  }
  return { message: `adapters 只允许 import dock/ports(.ts|/*)、model（命中 ${targetLayer}）` };
}

/** 全仓层向扫描：返回违规清单（whitelist 条目 `<file>:<spec|token:词>` 精确豁免）。 */
export async function scanLayerDag(root: string, cfg: GateConfig): Promise<Violation[]> {
  const whitelist = new Set(cfg.layerDagWhitelist);
  const violations: Violation[] = [];
  for (const layer of LAYERS) {
    const dir = join(root, SRC_PREFIX.slice(0, -1), layer);
    const files: string[] = [];
    try {
      await collectTs(dir, files);
    } catch {
      continue; // 目录不存在（尚未搬到该层）→ 跳过
    }
    for (const file of files) {
      const rel = file.slice(root.length + 1).split('\\').join('/');
      const content = await readFile(file, 'utf8');
      const owner = layerOf(rel);
      if (owner === null) continue;
      // 红线：机制层禁旧组装模块 import 与组装 token
      if (FOUR.includes(owner)) {
        for (const spec of [
          ...[...content.matchAll(IMPORT_FROM_RE)].map((m) => m[2] ?? ''),
          ...[...content.matchAll(BARE_REL_IMPORT_RE)].map((m) => m[1] ?? ''),
        ]) {
          const hit = REDLINE_REL_SUBSTRINGS.find((sub) => spec.includes(sub));
          if (hit !== undefined) {
            const key = `${rel}:${spec}`;
            if (!whitelist.has(key)) {
              violations.push({ path: rel, rule: 'layer-dag', message: `机制层红线：禁 import 旧组装模块（命中 ${hit}）：${spec}` });
            }
          }
        }
        for (const token of REDLINE_TOKENS) {
          if (content.includes(token)) {
            const key = `${rel}:token:${token}`;
            if (!whitelist.has(key)) {
              violations.push({ path: rel, rule: 'layer-dag', message: `机制层红线：禁组装语义 token「${token}」（§2.1 拓扑只能是数据/路由）` });
            }
          }
        }
      }
      // 层间边
      for (const m of content.matchAll(IMPORT_FROM_RE)) {
        const keyword = m[1] ?? '';
        const spec = m[2] ?? '';
        const targetRel = resolveSpec(root, rel, spec);
        if (targetRel === null) continue;
        const targetLayer = layerOf(targetRel);
        if (targetLayer === null) continue; // 旧区（core/kernel 等）不参与层向判定
        const verdict = classifyEdge(rel, owner, targetRel, targetLayer, keyword === 'export');
        if (verdict.message === null) continue;
        const key = `${rel}:${spec}`;
        if (whitelist.has(key)) continue;
        violations.push({ path: rel, rule: 'layer-dag', message: verdict.message });
      }
    }
  }
  return violations;
}

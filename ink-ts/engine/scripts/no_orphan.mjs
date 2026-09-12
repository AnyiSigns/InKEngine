#!/usr/bin/env node
/**
 * no_orphan —— 引擎模块消费者扫描器（计划 §13.10/§6 P0 行；S6 判删工具）。
 *
 * 扫描 engine/src 全部 `.ts` 的相对 import 边，对每个模块列「目录外消费者数」
 * （同目录互引不计——目录内引用不构成跨模块消费证据）。零外部消费者 = 孤儿
 * 候选（入口 src/index.ts 为宿主直取面，不计候选）。
 *
 * 用法：
 *   node engine/scripts/no_orphan.mjs                 # report 模式：列候选，exit 0
 *   node engine/scripts/no_orphan.mjs --strict        # 有孤儿候选 → exit 1（S6 执法用）
 *   node engine/scripts/no_orphan.mjs --src <dir>     # 覆盖扫描根（自测夹具用）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = join(HERE, '..', 'src');

const args = process.argv.slice(2);
let strict = false;
let src = DEFAULT_SRC;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--strict') strict = true;
  else if (a === '--src') {
    i += 1;
    src = resolve(args[i] ?? '');
  } else {
    console.error(`no_orphan: 未知参数 ${a}（用法见头注）`);
    process.exit(2);
  }
}
src = resolve(src);

const REL_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g;

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
}

function main() {
  const files = [];
  walk(src, files);
  if (files.length === 0) {
    console.error(`no_orphan: 未找到 .ts 文件（${src}）`);
    process.exit(1);
  }
  const modules = new Set(files.map((f) => resolve(f)));
  const external = new Map();
  const rel = (p) => p.slice(src.length + 1).split('\\').join('/');
  for (const mod of modules) external.set(rel(mod), 0);

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const importerDir = dirname(resolve(file));
    const seen = new Set();
    for (const m of content.matchAll(REL_IMPORT_RE)) {
      const spec = (m[1] ?? m[2]);
      if (!spec || seen.has(spec)) continue;
      seen.add(spec);
      let target = resolve(importerDir, spec);
      if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`;
      if (!modules.has(target)) continue;
      if (dirname(target) === importerDir) continue; // 同目录互引不计
      const key = rel(target);
      external.set(key, (external.get(key) ?? 0) + 1);
    }
  }

  const entryRel = 'index.ts';
  const orphans = [...external.entries()]
    .filter(([modPath, count]) => count === 0 && modPath !== entryRel)
    .map(([modPath]) => modPath)
    .sort();

  console.log(`no_orphan: 扫描 ${modules.size} 个模块（${rel(src) || '.'}），目录外消费者为零的孤儿候选 ${orphans.length} 个`);
  for (const o of orphans) console.log(`  orphan-candidate: ${o}`);
  if (orphans.length > 0) {
    console.log(strict ? 'no_orphan: STRICT —— 存在孤儿候选 = FAIL' : 'no_orphan: report 模式（exit 0）；S6 执法用 --strict');
  }
  if (strict && orphans.length > 0) process.exit(1);
}
main();

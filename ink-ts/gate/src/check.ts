/**
 * gate CLI：对 ink-ts 工作区执行架构门禁（行数/import/词汇/生成文件），
 * 违规非零退出。供 CI 与 pre-commit 调用：`tsx gate/src/check.ts`。
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scan } from './scan.js';

async function findInkTsRoot(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as {
        name?: string;
        workspaces?: string[];
      };
      if (pkg.name === 'ink-ts' && Array.isArray(pkg.workspaces) && pkg.workspaces.includes('engine')) {
        return dir;
      }
    } catch {
      // 继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<number> {
  const root = (await findInkTsRoot(join(here, '..'))) ?? process.cwd();
  const violations = await scan({ root });
  if (violations.length === 0) {
    console.log('gate: PASS');
    return 0;
  }
  for (const v of violations) {
    console.log(`gate: FAIL [${v.rule}] ${v.path}: ${v.message}`);
  }
  console.log(`gate: ${violations.length} 处违规`);
  return 1;
}

const code = await main();
process.exitCode = code;

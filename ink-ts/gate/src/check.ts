/**
 * gate CLI：对 ink-ts 工作区执行架构门禁（行数/import/词汇/层向/测试保护/
 * 公共面快照/待定字面），违规非零退出。供 CI 与 pre-commit 调用：
 * `tsx gate/src/check.ts`。
 *
 * 子进程输入：
 * - test-protection：`git diff --name-only HEAD` 收集本批变更清单传入扫描
 *   （git 不可用 = 跳过该规则并注明，不视为违规）；
 * - public-api：`node engine/scripts/dump_api_surface.mjs --print` 生成当前
 *   导出面，与 `engine/api.surface.snapshot` 基线逐字比对（漂移即红）。
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanAll } from './scan.js';
import { compareApiSurface, type Violation } from './rules.js';

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

/** 本批变更清单（root 相对 posix 路径）；git 不可用/非仓库 = null。 */
function collectGitChanges(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['-C', root, 'diff', '--relative', '--name-only', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((l) => l.trim().split('\\').join('/')).filter((l) => l !== '');
  } catch {
    return null;
  }
}

/** public-api：dump 当前导出面与快照逐字比对（dump 脚本自身失败 = 违规）。 */
async function checkPublicApi(root: string): Promise<Violation[]> {
  const dumpScript = join(root, 'engine', 'scripts', 'dump_api_surface.mjs');
  const snapshotPath = join(root, 'engine', 'api.surface.snapshot');
  let current: string;
  try {
    current = execFileSync(process.execPath, [dumpScript, '--print'], { encoding: 'utf8' }).replace(/\r\n/g, '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return [{ path: 'engine/src/index.ts', rule: 'public-api', message: `dump_api_surface 执行失败：${message}` }];
  }
  let snapshot: string;
  try {
    snapshot = (await readFile(snapshotPath, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    return [{ path: 'engine/api.surface.snapshot', rule: 'public-api', message: '快照基线缺失（应由 dump_api_surface.mjs 生成并提交）' }];
  }
  const violation = compareApiSurface(snapshot, current);
  return violation ? [violation] : [];
}

async function main(): Promise<number> {
  const root = (await findInkTsRoot(join(here, '..'))) ?? process.cwd();
  const gitChanged = collectGitChanges(root);
  const { violations, warnings, notes } = await scanAll({
    root,
    changedFiles: gitChanged ?? undefined,
  });
  violations.push(...(await checkPublicApi(root)));

  for (const note of notes) {
    console.log(`gate: NOTE ${note}`);
  }
  for (const w of warnings) {
    console.log(`gate: WARN [${w.rule}] ${w.path}: ${w.message}`);
  }
  if (violations.length === 0) {
    const suffix = warnings.length > 0 ? `（报告模式命中 ${warnings.length} 项：${[...new Set(warnings.map((w) => w.rule))].join('/')}）` : '';
    console.log(`gate: PASS${suffix}`);
    return 0;
  }
  for (const v of violations) {
    console.log(`gate: FAIL [${v.rule}] ${v.path}: ${v.message}`);
  }
  console.log(`gate: ${violations.length} 处违规${warnings.length > 0 ? `（另报告模式命中 ${warnings.length} 项）` : ''}`);
  return 1;
}

const code = await main();
process.exitCode = code;

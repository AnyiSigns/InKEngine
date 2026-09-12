/**
 * test-protection（CODING §11.1/计划 §13.2.3）：基于本批变更清单（git diff）的
 * 测试保护检查，防「改源码不动测试」与「改测试让绿灯」两向漂移。
 *
 * 判据（root 相对 posix 路径）：
 * - 范围内源码改动（engine/src、hosts/<host>/src、renderer/src、plugins 下非 docs 的
 *   `.ts`/`.tsx` 非测试文件）须满足其一：本批含镜像测试路径改动；或文件头带
 *   `// gate: test-exempt - 原因` 豁免标注；
 * - `.test.ts(x)` 改动须本批含对应 src 改动（镜像 src 路径或同住 src 文件）；
 * - `.mjs`/`.json`/快照与脚本目录（engine/scripts、gate 自身）豁免。
 * 强制/报告模式由调用方按 cfg.testProtectionEnforce 分流（P0 报告模式）。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Violation } from './rules.js';
import { hasTestExemptMark } from './rules.js';

const SRC_SCOPE_RE = /^(engine\/src\/|hosts\/[^/]+\/src\/|renderer\/src\/|plugins\/)/;
const TEST_SCOPE_RE = /^(engine\/test\/|hosts\/[^/]+\/test\/|renderer\/test\/|plugins\/)/;
const SOURCE_EXT_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.test\.tsx?$/;
const SNAP_EXEMPT_RE = /(\.mjs|\.json|\.snapshot)$/;

function isExcludedPath(rel: string): boolean {
  if (SNAP_EXEMPT_RE.test(rel)) return true;
  if (rel.startsWith('engine/scripts/')) return true;
  if (rel.startsWith('gate/')) return true; // gate 自身（规则实现与其样例）
  if (rel.startsWith('plugins/') && /(^|\/)docs\//.test(rel)) return true;
  return false;
}

function split(rel: string): { dir: string; file: string; stem: string; ext: string } {
  const slash = rel.lastIndexOf('/');
  const dir = slash < 0 ? '' : rel.slice(0, slash);
  const file = rel.slice(slash + 1);
  if (TEST_FILE_RE.test(file)) {
    const stem = file.replace(/\.test\.tsx?$/, '');
    return { dir, file, stem, ext: file.slice(stem.length + '.test'.length) };
  }
  const dot = file.lastIndexOf('.');
  return { dir, file, stem: dot < 0 ? file : file.slice(0, dot), ext: dot < 0 ? '' : file.slice(dot) };
}

function withExt(stem: string, ext: string, test: boolean): string {
  return test ? `${stem}.test${ext}` : `${stem}${ext}`;
}

/** dir 的 src↔test 镜像目录（无 src/test 段时返回 null）。 */
function mirroredDir(dir: string): string | null {
  if (dir.includes('/src/')) return dir.replace('/src/', '/test/');
  if (dir.includes('/test/')) return dir.replace('/test/', '/src/');
  if (dir === 'engine/src') return 'engine/test';
  if (dir === 'engine/test') return 'engine/src';
  return null;
}

/**
 * src↔test 关联候选（对偶）：镜像目录同名文件 + 同目录同名文件（plugins faces
 * 同住形态）；`.tsx` 另试 `.test.ts`/`.ts` 变体。
 */
function linkedPaths(rel: string): string[] {
  const { dir, stem, ext } = split(rel);
  const isTest = TEST_FILE_RE.test(rel);
  const candidates = new Set<string>();
  const exts = ext === '.tsx' ? [ext, '.ts'] : [ext];
  const md = mirroredDir(dir);
  for (const e of exts) {
    if (md !== null) candidates.add(`${md}/${withExt(stem, e, !isTest)}`);
    candidates.add(`${dir}/${withExt(stem, e, !isTest)}`);
  }
  return [...candidates];
}

/**
 * 对本批变更清单执行 test-protection，返回违规清单。
 * changedFiles = `git diff --name-only HEAD` 输出（root 相对、`/` 分隔）。
 * 豁免读取按 root 实际文件；删除/不可读文件视为无豁免标注。
 */
export async function checkTestProtection(root: string, changedFiles: readonly string[]): Promise<Violation[]> {
  const changed = new Set(changedFiles.map((p) => p.split('\\').join('/')));
  const violations: Violation[] = [];
  for (const rel of [...changed].sort()) {
    if (isExcludedPath(rel)) continue;
    if (TEST_FILE_RE.test(rel)) {
      if (!TEST_SCOPE_RE.test(rel)) continue;
      if (!linkedPaths(rel).some((c) => changed.has(c))) {
        violations.push({
          path: rel,
          rule: 'test-protection',
          message: '测试改动无同批对应 src 改动（防改测试让绿灯；确属随迁改名/搬迁请在同批带 src 侧 diff 或按评审豁免）',
        });
      }
      continue;
    }
    if (!SRC_SCOPE_RE.test(rel)) continue;
    if (!SOURCE_EXT_RE.test(rel)) continue;
    if (linkedPaths(rel).some((c) => changed.has(c))) continue;
    let exempted = false;
    try {
      exempted = hasTestExemptMark(await readFile(join(root, ...rel.split('/')), 'utf8'));
    } catch {
      exempted = false;
    }
    if (!exempted) {
      violations.push({
        path: rel,
        rule: 'test-protection',
        message: '源码改动无同批镜像测试改动；豁免须在文件头标注 `// gate: test-exempt - 原因`',
      });
    }
  }
  return violations;
}

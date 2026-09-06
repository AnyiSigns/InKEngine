/**
 * gate 扫描器：遍历源码目录并应用规则。core 区规则只作用于 coreDirs；
 * adapters 反向私有 import 规则作用于 adapterDirs；行数/生成文件规则作用于
 * 全部扫描目录；JSON 纪律作用于 jsonScanDirs。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

import { defaultConfig, type GateConfig } from './config.js';
import {
  checkCoreImports,
  checkCoreTokens,
  checkJsonValid,
  checkLineLimit,
  checkUtf8Valid,
  hasCrossDomainSeamMarker,
  type Violation,
} from './rules.js';

const SOURCE_RE = /\.(ts|tsx)$/;
const JSON_RE = /\.json$/;
const REL_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g;

async function collectFiles(dir: string, out: string[], filter: RegExp): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectFiles(full, out, filter);
    } else if (entry.isFile() && filter.test(entry.name)) {
      out.push(full);
    }
  }
}

function isUnder(root: string, file: string): boolean {
  const rel = normalize(relative(root, file));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

function dirOf(file: string): string {
  return dirname(file);
}

/** 把 import 说明符解析为候选 TS 文件绝对路径（NodeNext 下 .js → .ts）。 */
function resolveImportTarget(dir: string, spec: string): string {
  let base = resolve(dir, spec);
  if (base.endsWith('.js')) base = base.slice(0, -3);
  return `${base}.ts`;
}

/** core/adapters 私有 import 检查：跨域私有模块须在目标文件头标注跨域契约标记。 */
async function collectSeamViolations(
  file: string,
  content: string,
  rootNorm: string,
  coreDirs: readonly string[],
  adapterDirs: readonly string[],
  marker: string,
  cache: Map<string, string | null>,
): Promise<Violation[]> {
  const inCore = coreDirs.some((core) => isUnder(join(rootNorm, core), file));
  const inAdapter = adapterDirs.some((ad) => isUnder(join(rootNorm, ad), file));
  if (!inCore && !inAdapter) return [];
  const coreRoots = coreDirs.map((core) => normalize(join(rootNorm, core)));

  const readHead = async (target: string): Promise<string | null> => {
    const cached = cache.get(target);
    if (cached !== undefined) return cached;
    let text: string | null = null;
    try {
      text = await readFile(target, 'utf8');
    } catch {
      text = null;
    }
    cache.set(target, text);
    return text;
  };

  const importerDir = dirOf(file);
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const sourceDir = relative(rootNorm, importerDir).split(sep).join('/');
  REL_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REL_IMPORT_RE.exec(content)) !== null) {
    const spec = (m[1] ?? m[2]) as string;
    if (seen.has(spec)) continue;
    seen.add(spec);
    const target = resolveImportTarget(importerDir, spec);
    if (!coreRoots.some((core) => isUnder(core, target))) continue;
    const targetBase = target.split(sep).pop() ?? '';
    if (!targetBase.startsWith('_')) continue;
    const targetDir = dirOf(target);
    if (inCore && importerDir === targetDir) continue; // 同域私有引用放行
    const text = await readHead(target);
    if (text !== null && hasCrossDomainSeamMarker(text, marker)) continue;
    const relTarget = relative(rootNorm, target).split(sep).join('/');
    if (inAdapter) {
      violations.push({
        path: relTarget,
        rule: 'private-seam',
        message: `adapters（${sourceDir}）反向 import core 私有模块 ${spec}：公共 seam 例外须在目标文件头标注「${marker}」`,
      });
      continue;
    }
    violations.push({
      path: relTarget,
      rule: 'private-seam',
      message: `core 域间跨目录 import 私有模块 ${spec}：共享 seam 须在目标文件头标注「${marker}」并注明理由`,
    });
  }
  return violations;
}

export interface ScanOptions {
  root: string;
  config?: Partial<GateConfig>;
}

/** 扫描 root 下的全部受控目录，返回违规清单（空 = 通过）。 */
export async function scan({ root, config }: ScanOptions): Promise<Violation[]> {
  const cfg: GateConfig = { ...defaultConfig, ...config };
  const rootNorm = normalize(root);
  const violations: Violation[] = [];
  const headCache = new Map<string, string | null>();

  for (const dir of cfg.lineScanDirs) {
    const abs = join(rootNorm, dir);
    let files: string[];
    try {
      files = [];
      await collectFiles(abs, files, SOURCE_RE);
    } catch {
      continue; // 目录尚未存在（空 core 等）视为通过
    }
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const rel = relative(rootNorm, file);
      const inSourceDir = rel.split(sep).includes('src');
      if (inSourceDir) {
        const utf8Violation = checkUtf8Valid(content, rel);
        if (utf8Violation) violations.push(utf8Violation);
      }
      if (inSourceDir && /\.test\.(ts|tsx)$/.test(rel)) {
        violations.push({
          path: rel,
          rule: 'src-test',
          message: '测试文件禁止与业务源码同目录（置于所属包 test/，镜像 src 路径）',
        });
      }
      const violation = checkLineLimit(content, rel, cfg.maxLines);
      if (violation) violations.push(violation);
      const inCore = cfg.coreDirs.some((core) => isUnder(join(rootNorm, core), file));
      if (inCore) {
        violations.push(...checkCoreImports(content, rel, cfg.coreForbiddenRelSubstrings, cfg.coreAllowedNodeModules));
        violations.push(...checkCoreTokens(content, rel, cfg.coreForbiddenTokens, cfg.coreOpaqueTokens));
      }
      violations.push(...(await collectSeamViolations(file, content, rootNorm, cfg.coreDirs, cfg.adapterDirs, cfg.coreSeamMarker, headCache)));
    }
  }

  for (const dir of cfg.jsonScanDirs) {
    const abs = join(rootNorm, dir);
    let files: string[];
    try {
      files = [];
      await collectFiles(abs, files, JSON_RE);
    } catch {
      continue;
    }
    for (const file of files) {
      const rel = relative(rootNorm, file);
      const content = await readFile(file, 'utf-8');
      const violation = checkJsonValid(content, rel);
      if (violation) violations.push(violation);
    }
  }

  if (cfg.lineScanDirs.length === 0 && cfg.coreDirs.length === 0) {
    // 无目录配置时至少保证语义可用（防配置清空误放行）
    const unused = await stat(rootNorm).catch(() => null);
    if (!unused) violations.push({ path: root, rule: 'line-limit', message: '根目录不存在' });
  }
  return violations;
}

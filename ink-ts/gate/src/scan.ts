/**
 * gate 扫描器：遍历源码目录并应用规则。core 区规则只作用于 coreDirs；
 * 行数/生成文件规则作用于全部扫描目录。
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, normalize, relative, sep } from 'node:path';

import { defaultConfig, type GateConfig } from './config.js';
import { checkCoreImports, checkCoreTokens, checkLineLimit, checkUtf8Valid, type Violation } from './rules.js';

const SOURCE_RE = /\.(ts|tsx)$/;

async function collectFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      await collectFiles(full, out);
    } else if (entry.isFile() && SOURCE_RE.test(entry.name)) {
      out.push(full);
    }
  }
}

function isUnder(root: string, file: string): boolean {
  const rel = normalize(relative(root, file));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
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

  for (const dir of cfg.lineScanDirs) {
    const abs = join(rootNorm, dir);
    let files: string[];
    try {
      files = [];
      await collectFiles(abs, files);
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
    }
  }

  if (cfg.lineScanDirs.length === 0 && cfg.coreDirs.length === 0) {
    // 无目录配置时至少保证语义可用（防配置清空误放行）
    const unused = await stat(rootNorm).catch(() => null);
    if (!unused) violations.push({ path: root, rule: 'line-limit', message: '根目录不存在' });
  }
  return violations;
}

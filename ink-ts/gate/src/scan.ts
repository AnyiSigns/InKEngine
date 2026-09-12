/**
 * gate 扫描器：遍历源码目录并应用规则。core 0-IO 纪律（node 内置/裸包 + core-token）
 * 作用于 coreDirs ∪ layerDirs（新搬迁层随 P2-P5 逐层纳入）；禁反向依赖条款
 * （coreForbiddenRelSubstrings）仅作用 coreDirs（P1 裁决 1：dock 公共面可承载
 * adapters re-export，层向纪律归 layer-dag 矩阵）；私有 seam 检查仍只作用
 * coreDirs；adapters 反向私有 import 规则作用于 adapterDirs；行数/生成文件
 * 规则作用于全部扫描目录；JSON 纪律作用于 jsonScanDirs。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

import { defaultConfig, type GateConfig } from './config.js';
import { scanLayerDag } from './layer_dag.js';
import { scanSemanticE2e } from './semantic_e2e.js';
import { checkTestProtection } from './test_protection.js';
import {
  checkCoreImports,
  checkCoreTokens,
  checkJsonValid,
  checkLineLimit,
  checkPendingTokens,
  checkUtf8Valid,
  hasCrossDomainSeamMarker,
  type Violation,
} from './rules.js';

const SOURCE_RE = /\.(ts|tsx)$/;
const JSON_RE = /\.json$/;
const REL_IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g;

export async function collectFiles(dir: string, out: string[], filter: RegExp): Promise<void> {
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
      const inCoreZone = cfg.coreDirs.some((zone) => isUnder(join(rootNorm, zone), file));
      const inLayerZone = cfg.layerDirs.some((zone) => isUnder(join(rootNorm, zone), file));
      if (inCoreZone || inLayerZone) {
        // core-import 两条款（计划 §5.1.2 + P1 裁决 1）：0-IO 条款（node:*/裸包）
        // 作用 coreDirs ∪ layerDirs；禁反向依赖条款（forbiddenRel）仅作用 coreDirs
        // （机制层禁依赖下方 IO 实现；dock 公共面承载 adapters re-export 属 S2 消亡物，
        //  其层向纪律由 layer-dag 矩阵执法）。
        violations.push(...checkCoreImports(content, rel, inCoreZone ? cfg.coreForbiddenRelSubstrings : [], cfg.coreAllowedNodeModules));
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

/** no-pending 扫描（§13.6 第 4 条）：禁待定字面散布于引擎/宿主/渲染器/插件源码。 */
export async function scanNoPending(root: string, cfg: GateConfig): Promise<Violation[]> {
  const rootNorm = normalize(root);
  const violations: Violation[] = [];
  for (const dir of cfg.noPendingDirs) {
    const abs = join(rootNorm, dir);
    let files: string[];
    try {
      files = [];
      await collectFiles(abs, files, SOURCE_RE);
    } catch {
      continue; // 目录不存在 → 跳过（与既有行为一致）
    }
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const rel = relative(rootNorm, file).split(sep).join('/');
      violations.push(...checkPendingTokens(content, rel, cfg.noPendingTokens));
    }
  }
  return violations;
}

export interface ScanAllOptions {
  root: string;
  config?: Partial<GateConfig>;
  /** 本批变更清单（git diff --name-only HEAD，root 相对、`/` 分隔）；undefined = test-protection 跳过。 */
  changedFiles?: readonly string[];
}

export interface ScanAllResult {
  /** 强制模式下的违规（阻断非零退出）。 */
  violations: Violation[];
  /** 报告模式（过渡形态）下的命中：打印 WARN 不阻断；转强制为治理节奏议题。 */
  warnings: Violation[];
  /** 跳过说明（如 git 不可用）。 */
  notes: string[];
}

/** 全量扫描 = 既有 7 规则 + 层向/端到端语义/待定/测试保护新规则按 enforce 分流违规与警告。 */
export async function scanAll({ root, config, changedFiles }: ScanAllOptions): Promise<ScanAllResult> {
  const cfg: GateConfig = { ...defaultConfig, ...config };
  const violations = await scan({ root, config });
  const warnings: Violation[] = [];
  const notes: string[] = [];
  const dag = await scanLayerDag(root, cfg);
  (cfg.layerDagEnforce ? violations : warnings).push(...dag);
  const pending = await scanNoPending(root, cfg);
  (cfg.noPendingEnforce ? violations : warnings).push(...pending);
  const semantic = await scanSemanticE2e(root);
  (cfg.semanticE2eEnforce ? violations : warnings).push(...semantic);
  if (changedFiles === undefined) {
    notes.push('test-protection 跳过：未提供本批变更清单（git 不可用）');
  } else {
    const tp = await checkTestProtection(root, changedFiles);
    (cfg.testProtectionEnforce ? violations : warnings).push(...tp);
  }
  return { violations, warnings, notes };
}

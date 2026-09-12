#!/usr/bin/env node
/**
 * dump_api_surface —— @ink-ts/engine 公共导出面快照生成器（计划 §13.2.2）。
 *
 * 用 typescript 编译器 API 解析 `engine/src/index.ts`（module Resolution
 * NodeNext 下 `export * from` 链由 checker 递归展开），收集全部导出符号
 * `name:kind`（kind ∈ value|type，值面/纯类型面二分），排序去重后逐行输出。
 * 快照文件 `engine/api.surface.snapshot` 为公共面基线：门禁（gate public-api
 * 规则）逐字比对，导出符号增/删/改名即红——宿主零迁移从口头承诺变机器判定。
 *
 * 用法：
 *   node engine/scripts/dump_api_surface.mjs            # 生成并写入快照
 *   node engine/scripts/dump_api_surface.mjs --print    # 输出到 stdout
 *   node engine/scripts/dump_api_surface.mjs --check    # 当前导出面 vs 快照，漂移 exit 1
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..');
const SNAPSHOT = join(ENGINE, 'api.surface.snapshot');

function currentSurface() {
  const pkg = JSON.parse(readFileSync(join(ENGINE, 'package.json'), 'utf8'));
  const entryRel = pkg.exports && pkg.exports['.'];
  if (typeof entryRel !== 'string') {
    throw new Error('package.json exports["."] 非字符串，无法定位公共面入口');
  }
  const entry = join(ENGINE, entryRel.replace(/^\.\//, ''));
  if (!existsSync(entry)) {
    throw new Error(`入口文件不存在: ${entryRel}`);
  }
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(entry) ?? program.getSourceFile(ts.path.normalize(entry));
  if (!sourceFile) {
    throw new Error(`SourceFile 未产生：${entry}`);
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) {
    throw new Error('模块符号未解析（入口为空？）');
  }
  const lines = new Set();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const kind = symbol.flags & ts.SymbolFlags.Value ? 'value' : 'type';
    lines.add(`${symbol.getName()}:${kind}`);
  }
  return [...lines].sort().join('\n') + '\n';
}

const args = process.argv.slice(2);
if (args.includes('--print')) {
  process.stdout.write(currentSurface());
  process.exit(0);
}
if (args.includes('--check')) {
  if (!existsSync(SNAPSHOT)) {
    console.error('dump_api_surface: FAIL —— 快照基线缺失（先运行无参数模式生成并提交）');
    process.exit(1);
  }
  const snapshot = readFileSync(SNAPSHOT, 'utf8').replace(/\r\n/g, '\n');
  const current = currentSurface();
  if (snapshot === current) {
    console.log('dump_api_surface: OK —— 当前导出面与快照逐字一致');
    process.exit(0);
  }
  const a = new Set(snapshot.split('\n').filter(Boolean));
  const b = new Set(current.split('\n').filter(Boolean));
  const missing = [...a].filter((l) => !b.has(l));
  const extra = [...b].filter((l) => !a.has(l));
  console.error(`dump_api_surface: FAIL —— 公共面漂移（缺失 ${missing.length} / 新增 ${extra.length}）`);
  for (const l of missing.slice(0, 40)) console.error(`  - ${l}`);
  for (const l of extra.slice(0, 40)) console.error(`  + ${l}`);
  process.exit(1);
}
if (args.length > 0) {
  console.error(`dump_api_surface: 未知参数 ${args.join(' ')}（用法见头注）`);
  process.exit(2);
}
const surface = currentSurface();
writeFileSync(SNAPSHOT, surface, 'utf8');
console.log(`dump_api_surface: 已写入 ${SNAPSHOT.split(/[\\/]/).pop()} —— ${surface.split('\n').filter(Boolean).length} 个导出符号`);

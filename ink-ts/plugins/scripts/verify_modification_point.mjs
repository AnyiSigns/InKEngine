#!/usr/bin/env node
/**
 * verify_modification_point —— 修改点唯一性抽查（S5 契约收口，§2.4-3/§12.3 S5 行）。
 *
 * 断言给定提交/区间内变更的文件路径全部满足「功能修改只落 plugins/」：
 * - `plugins/**` 路径 = 通过（功能唯一实现位）；
 * - 其余路径须命中 `--allow` 传入的白名单前缀（装配/生成物/门禁/文档等波内例外），否则 = 违约。
 *
 * 用法：
 *   node plugins/scripts/verify_modification_point.mjs --commit <sha> [--allow <prefix>]...
 *       支持单个 sha、区间 sha..sha、或多个 --commit 参数（路径前缀重复累加）。
 *   node plugins/scripts/verify_modification_point.mjs --report [--out <file>]
 *       对内置样本集（S3/S4 迁移波 + 功能改口提交，见样本表）逐条核验并出报告。
 *   node plugins/scripts/verify_modification_point.mjs --help
 *
 * 退出码：存在违约路径 = exit 1（并列违约清单）；全过 = exit 0。
 * 例外判定（违约 = 变更路径既不在 plugins/ 下，也不命中任何 --allow 前缀）。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(HERE, '..', '..'));
const posix = (p) => p.split('\\').join('/');

/** 内置样本集（§14.11 S5 卡 N=5）：S3 命令下沉 + S4 域组改口各笔。
 * 允许（波内例外）：`hosts/lib/src/`（装配面 + 生成物）+ 宿主席位测试/verify/文档/门禁。 */
const SAMPLES = [
  {
    name: 'S3 命令逻辑下沉（主提交）',
    commit: '84f7f3a',
    allow: [
      'plugins/',
      'hosts/lib/src/',
      'hosts/lib/scripts/',
      'hosts/lib/test/',
      'gate/',
      'CODING.md',
      'PLUGINS.md',
      'docs/',
      'hosts/AGENTS.md',
      'engine/AGENTS.md',
    ],
  },
  {
    name: 'S4 域组2 改口（material.import）',
    commit: '7868ed2',
    allow: ['plugins/'],
  },
  {
    name: 'S4 域组3 collab（convene 并域，execution 拆薄壳）',
    commit: '5b90c50',
    // hosts/lib/test 为波内临时测试位（6 文件随后迁 plugins/domains/collab，现 hosts/lib/test 零残留）
    allow: ['plugins/', 'hosts/lib/src/', 'hosts/lib/test/'],
  },
  {
    name: 'S4 域组3 plugin（plugin_command 并域）',
    commit: 'ac152ce',
    allow: ['plugins/', 'hosts/lib/src/'],
  },
  {
    name: 'S4 域组3 exec_client（exec 原生机制件下沉端口）',
    commit: 'c22be38',
    allow: [
      'plugins/',
      'hosts/lib/src/',
      'hosts/lib/test/',
      'hosts/cli/test/',
    ],
  },
];

function gitShowNameStatus(root, ref) {
  const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim().split('\\').join('/');
  const out = execFileSync('git', ['-C', root, 'show', '--name-status', '--format=', ref], { encoding: 'utf8' });
  const entries = [];
  for (const l of out.split('\n')) {
    const line = l.trim();
    if (line.length < 3) continue;
    const status = line[0];
    const rest = line.slice(1).trim();
    if (!['A', 'M', 'D', 'R', 'C'].includes(status)) continue;
    const [rawFrom, rawTo] = rest.split('\t');
    const raw = rawTo || rawFrom;
    const joined = posix(join(top, raw));
    const rel = relative(ROOT, joined).split('\\').join('/');
    if (!rel || rel.startsWith('..')) continue;
    entries.push({ path: rel, status: status === 'R' ? 'A' : status === 'C' ? 'A' : status });
  }
  return entries;
}

/** 单样本核验：返回 { name, commit, violations, allowedFiles }。
 * 删除件（status=D）= 域逻辑迁出 hosts/engine = 良性，不计违约；plugins/ 与 allow 前缀 = 通过。 */
function checkSample(root, sample) {
  const entries = gitShowNameStatus(root, sample.commit);
  const allowPrefixes = (sample.allow ?? []).map((p) => posix(p));
  const violations = [];
  const allowedFiles = [];
  for (const e of entries) {
    if (e.path.startsWith('plugins/') || e.status === 'D') {
      allowedFiles.push(`${e.status} ${e.path}`);
      continue;
    }
    if (allowPrefixes.some((p) => e.path.startsWith(p))) {
      allowedFiles.push(`${e.status} ${e.path}`);
      continue;
    }
    violations.push(`${e.status} ${e.path}`);
  }
  return { name: sample.name, commit: sample.commit, violations, allowedFiles, total: entries.length };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    console.log(`verify_modification_point —— 修改点唯一性抽查（S5）
用法：
  node plugins/scripts/verify_modification_point.mjs --commit <sha> [--allow <prefix>]...
  node plugins/scripts/verify_modification_point.mjs --report [--out <file>]
  node plugins/scripts/verify_modification_point.mjs --help`);
    process.exit(0);
  }

  if (args.includes('--report')) {
    const outIndex = args.indexOf('--out');
    const outFile = outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : null;
    let allPass = true;
    const lines = [
      '# 修改点唯一性抽查报告（S5，N=5）',
      '',
      `> 判据（§2.4-3/§12.3 S5）：功能修改 diff 只落 \`plugins/\`（spec/faces/data）；落 hosts/engine/exec/renderer = 违约（新基建除外，需独立评审）。本报告对迁移波允许装配面/生成物/门禁/文档位为波内例外（各样本 allow 列表）。`,
      '',
      `> 生成时间：${new Date().toISOString()}`,
      '',
      '| 样本 | commit | 变更文件 | 违约文件 | 结论 |',
      '|---|---|---|---|---|',
    ];
    for (const sample of SAMPLES) {
      let result;
      try {
        result = checkSample(ROOT, sample);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`verify_modification_point: 样本 ${sample.name} git 核验失败：${msg}`);
        process.exitCode = 2;
        return;
      }
      const ok = result.violations.length === 0;
      if (!ok) allPass = false;
      lines.push(
        `| ${sample.name} | ${result.commit} | ${result.total} | ${result.violations.length} | ${ok ? '✅ 零违约' : '❌ 存在违约'} |`,
      );
      const pluginCount = result.allowedFiles.filter((f) => f.slice(2).startsWith('plugins/')).length;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${sample.name} (${result.commit})：变更 ${result.total}，违约 ${result.violations.length}；plugins/内 ${pluginCount}，删除/例外 ${result.allowedFiles.length - pluginCount}`);
      for (const v of result.violations) console.log(`  violation: ${v}`);
    }
    if (outFile) {
      const target = resolve(ROOT, outFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, lines.join('\n') + '\n', 'utf8');
      console.log(`报告已写：${relative(ROOT, target)}`);
    }
    console.log(`抽查结论：${allPass ? 'N=5 零违约，修改点唯一性成立' : '存在违约，见上'}`);
    process.exit(allPass ? 0 : 1);
  }

  // 单条/多条 commit 模式
  const refs = [];
  const allows = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit' && args[i + 1]) {
      refs.push(args[i + 1]);
      i += 1;
    } else if (args[i] === '--allow' && args[i + 1]) {
      allows.push(posix(args[i + 1]));
      i += 1;
    }
  }
  if (refs.length === 0) {
    console.error('verify_modification_point: 缺少 --commit（--help 看用法）');
    process.exit(2);
  }
  const prefixSet = new Set(['plugins/']);
  if (allows.length > 0) {
    for (const a of allows) prefixSet.add(posix(a));
  }
  const passing = (e) => e.status === 'D' || [...prefixSet].some((p) => e.path.startsWith(p));
  let allPass = true;
  for (const ref of refs) {
    const entries = gitShowNameStatus(ROOT, ref);
    const violations = entries.filter((e) => !passing(e));
    console.log(`[${violations.length === 0 ? 'PASS' : 'FAIL'}] ${ref}：变更 ${entries.length}，违约 ${violations.length}`);
    for (const v of violations) console.log(`  violation: ${v.status} ${v.path}`);
    if (violations.length > 0) allPass = false;
  }
  process.exit(allPass ? 0 : 1);
}

main();
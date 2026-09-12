import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { scan, scanAll } from '../src/scan.js';
import { checkTestProtection } from '../src/test_protection.js';
import { checkPendingTokens, compareApiSurface } from '../src/rules.js';

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ink-gate-'));
  roots.push(root);
  return root;
}

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content);
}

async function writeBytes(root: string, rel: string, bytes: Buffer): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, bytes);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const cfg = {
  lineScanDirs: ['engine/src', 'cli/src'],
  coreDirs: ['engine/src/core'],
};

describe('gate 规则', () => {
  it('空 core 通过', async () => {
    const root = await makeRoot();
    const violations = await scan({ root, config: cfg });
    expect(violations).toEqual([]);
  });

  it('core 中 node 内置 import 被拒绝', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/io.ts', `import { readFileSync } from 'node:fs';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('core-import');
    expect(violations.map((v) => v.message).join('\n')).toContain('node:fs');
  });

  it('core 中第三方 import 被拒绝', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/x.ts', `import { debounce } from 'lodash';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('core-import');
  });

  it('core 相对 import 放行', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/a.ts', `import { b } from './b.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations).toEqual([]);
  });

  it('kernel 机制件区同受 core import/词汇规则约束', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/kernel/audit_log/io.ts', `import { readFileSync } from 'node:fs';\n`);
    await write(root, 'engine/src/kernel/approval/bad.ts', `const framework = 'tauri';\n`);
    const cfgKernel = { ...cfg, coreDirs: ['engine/src/core', 'engine/src/kernel'] };
    const violations = await scan({ root, config: cfgKernel });
    expect(violations.map((v) => v.rule)).toContain('core-import');
    expect(violations.map((v) => v.rule)).toContain('core-token');
  });

  it('kernel 私有 seam 跨域 import 同受标注约束', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/kernel/x/_types.ts', `export const X = 'x';\n`);
    await write(root, 'engine/src/kernel/a/b.ts', `import { X } from '../x/_types.js';\n`);
    const cfgKernel = { ...cfg, coreDirs: ['engine/src/core', 'engine/src/kernel'] };
    const violations = await scan({ root, config: cfgKernel });
    expect(violations.map((v) => v.rule)).toContain('private-seam');
  });

  it('core 相对 import 内置数据面生成物放行（engine 单源消费，无外部契约包）', async () => {
    const root = await makeRoot();
    await write(
      root,
      'engine/src/core/c.ts',
      `import { PATCH_KINDS } from '../contracts/generated/index.js';\nimport type { FieldKind } from '../contracts/generated/endpointTypes.js';\n`,
    );
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('core-import');
  });

  it('core import 裸包一律拒绝（数据面契约已内置 engine，无裸包放行）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/d.ts', `import { PATCH_KINDS } from '@ink-ts/engine';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('core-import');
  });

  it('core 禁宿主/框架词', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/bad.ts', `const framework = 'cordis';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('core-token');
  });

  it('超限文件无标注被拒，有标注放行', async () => {
    const root = await makeRoot();
    const body = Array.from({ length: 380 }, (_, i) => `const v${i} = ${i};`).join('\n');
    await write(root, 'engine/src/big.ts', body);
    expect((await scan({ root, config: cfg })).map((v) => v.rule)).toContain('line-limit');
    await write(root, 'engine/src/big.ts', `// gate: 超限(381 行) - 单一不可拆的枚举常量表\n${body}\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('line-limit');
  });

  it('宿主区（非 core）允许 node 内置 import', async () => {
    const root = await makeRoot();
    await write(root, 'cli/src/server.ts', `import { createInterface } from 'node:readline';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations).toEqual([]);
  });

  it('layerDirs 扩面：层目录文件 import node:* 违规（core-import 0-IO 扩面）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/dock/io_leak.ts', `import { readFileSync } from 'node:fs';\nexport const r = readFileSync;\n`);
    const off = await scan({ root, config: { ...cfg, layerDirs: [] } });
    expect(off.map((v) => v.rule)).not.toContain('core-import');
    const on = await scan({ root, config: { ...cfg, layerDirs: ['engine/src/dock'] } });
    expect(on.map((v) => v.rule)).toContain('core-import');
    expect(on.map((v) => v.message).join('\n')).toContain('node:fs');
  });

  it('core-import 两条款（P1 裁决 1）：dock re-export adapters 放行（反向依赖条款仅 coreDirs）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/adapters/zzz.ts', `export const z = 1;\n`);
    await write(root, 'engine/src/dock/api.ts', `export * from '../adapters/zzz.js';\n`);
    const violations = await scan({ root, config: { ...cfg, layerDirs: ['engine/src/dock'] } });
    expect(violations.map((v) => v.rule)).not.toContain('core-import');
  });

  it('core-import 两条款（P1 裁决 1）：dock 0-IO 仍拒裸包；coreDirs 反向依赖 adapters 仍拒', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/adapters/zzz.ts', `export const z = 1;\n`);
    await write(root, 'engine/src/dock/bare.ts', `import { debounce } from 'lodash';\nexport const d = debounce;\n`);
    await write(root, 'engine/src/core/rev.ts', `import { z } from '../adapters/zzz.js';\nexport const r = z;\n`);
    const violations = await scan({ root, config: { ...cfg, layerDirs: ['engine/src/dock'] } });
    const msgs = violations
      .filter((v) => v.rule === 'core-import')
      .map((v) => `${v.path.split(/[\\/]/).join('/')}:${v.message}`);
    expect(msgs.some((s) => s.startsWith('engine/src/dock/bare.ts'))).toBe(true);
    expect(msgs.some((s) => s.startsWith('engine/src/core/rev.ts') && s.includes('adapters'))).toBe(true);
  });

  it('src 内夹测试文件被拒（测试须置于 test/）', async () => {
    const root = await makeRoot();
    await write(root, 'cli/src/server.test.ts', `import { describe, it } from 'vitest';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('src-test');
  });

  it('src 文件非合法 UTF-8（损坏编码）被拒', async () => {
    const root = await makeRoot();
    const bytes = Buffer.concat([
      Buffer.from(`const title = '引擎测试';\n`),
      Buffer.from([0x88, 0xf8, 0x0a]),
    ]);
    await writeBytes(root, 'engine/src/gbk_encoded.ts', bytes);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('utf8-valid');
  });

  it('src 文件合法 UTF-8（含中文注释）通过', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/ok.ts', `// 引擎测试注释\nconst x = 1;\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('utf8-valid');
  });

  it('core 域间跨目录 import 私有模块被拒（无跨域契约标注）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/x/_types.ts', `export const X = 'x';\n`);
    await write(root, 'engine/src/core/a/b.ts', `import { X } from '../x/_types.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('private-seam');
  });

  it('core 域间跨目录 import 已标注跨域契约模块的 seam 放行', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/x/_types.ts', `// 跨域契约模块 - 跨域类型 seam：共享数据形态\n/** 类型 seam。 */\nexport const X = 'x';\n`);
    await write(root, 'engine/src/core/a/b.ts', `import { X } from '../x/_types.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('private-seam');
  });

  it('core 同域私有 import 放行', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/a/_types.ts', `export const X = 'x';\n`);
    await write(root, 'engine/src/core/a/b.ts', `import { X } from './_types.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('private-seam');
  });

  it('adapters 反向 import core 私有模块被拒（无公共 seam 标注）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/llm/_shapes.ts', `export interface Shape { a: string }\n`);
    await write(root, 'engine/src/adapters/llm/x.ts', `import type { Shape } from '../../core/llm/_shapes.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('private-seam');
  });

  it('adapters 反向 import 已标注公共 seam 的 core 私有模块放行', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/llm/_shapes.ts', `// 跨域契约模块 - 公共 seam：adapters 厂商载荷消费数据形态\n/** 类型 seam。 */\nexport interface Shape { a: string }\n`);
    await write(root, 'engine/src/adapters/llm/x.ts', `import type { Shape } from '../../core/llm/_shapes.js';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('private-seam');
  });

  it('JSON 非对象顶层被拒', async () => {
    const root = await makeRoot();
    await write(root, 'seed_data/bad.json', `[1, 2, 3]\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('json-valid');
  });

  it('JSON 重复键被拒', async () => {
    const root = await makeRoot();
    await write(root, 'engine/fixtures/dup.json', `{\n  "a": 1,\n  "a": 2\n}\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('json-valid');
    expect(violations.map((v) => v.message).join('\n')).toContain('重复键');
  });

  it('JSON 奇数空格缩进被拒（非 2 空格格线）', async () => {
    const root = await makeRoot();
    await write(root, 'seed_data/odd.json', `{\n   "a": 1\n}\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('json-valid');
  });

  it('JSON tab 缩进被拒', async () => {
    const root = await makeRoot();
    await write(root, 'seed_data/tab.json', `{\n\t"a": 1\n}\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('json-valid');
  });

  it('JSON 合法且 2 空格缩进通过', async () => {
    const root = await makeRoot();
    await write(root, 'seed_data/ok.json', `{\n  "a": 1\n}\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).not.toContain('json-valid');
  });
});

// ── 引擎重排 P0 立法：新增门禁自测（layer-dag / test-protection / public-api / no-pending / no-orphan）──

const layerCfg = (extra: Record<string, unknown> = {}) => ({
  lineScanDirs: ['engine/src'],
  coreDirs: ['engine/src/core'],
  noPendingDirs: [],
  ...extra,
});

describe('layer-dag 层向门禁', () => {
  it('model 零依赖违规；四件→model 放行', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/model/m.ts', `import { l } from '../loop/l.js';\nexport const m = l;\n`);
    await write(root, 'engine/src/loop/l.ts', `import { n } from '../model/n.js';\nexport const l = n + 1;\n`);
    await write(root, 'engine/src/model/n.ts', `export const n = 1;\n`);
    const { violations, warnings } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    expect(violations.length).toBe(1);
    expect(violations[0]!.rule).toBe('layer-dag');
    expect(violations[0]!.path).toContain('model/m.ts');
    expect(warnings).toEqual([]);
  });

  it('四件→dock 仅放行 dock/ports 与 dock/registry 前缀', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/loop/x.ts', `import { p } from '../dock/ports.js';\nimport { c } from '../dock/caps.js';\nexport const x = p + c;\n`);
    const resEnforce = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    const dagViolations = resEnforce.violations.filter((v) => v.rule === 'layer-dag');
    expect(dagViolations).toHaveLength(1);
    expect(dagViolations[0]!.message).toContain('dock/caps');
    const resReport = await scanAll({ root, config: layerCfg({ layerDagEnforce: false, noPendingEnforce: false }) });
    expect(resReport.violations.filter((v) => v.rule === 'layer-dag')).toEqual([]);
    expect(resReport.warnings.some((v) => v.rule === 'layer-dag')).toBe(true);
  });

  it('dock→四件只允许 re-export 机制 contract.ts', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/dock/caps.ts', `export * from '../graph/fm/contract.js';\n`);
    await write(root, 'engine/src/dock/bad.ts', `import { run } from '../graph/exec.js';\nexport const b = run;\n`);
    const { violations } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    const paths = violations.map((v) => v.path);
    expect(paths).not.toContain('engine/src/dock/caps.ts');
    expect(paths).toContain('engine/src/dock/bad.ts');
  });

  it('dock→model 放行（model 被所有层引）；dock→adapters 由 layer-dag 矩阵执法（P1 裁决 1 后不再入 core-import）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/model/yyy.ts', `export const y = 1;\n`);
    await write(root, 'engine/src/dock/xxx.ts', `import { y } from '../model/yyy.js';\nexport const x = y;\n`);
    await write(root, 'engine/src/adapters/zzz.ts', `export const z = 1;\n`);
    await write(root, 'engine/src/dock/leak.ts', `import { z } from '../adapters/zzz.js';\nexport const l = z;\n`);
    const { violations } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true, layerDirs: ['engine/src/dock'] }) });
    expect(violations.map((v) => v.rule)).not.toContain('core-import');
    const paths = violations.filter((v) => v.rule === 'layer-dag').map((v) => v.path);
    expect(paths).not.toContain('engine/src/dock/xxx.ts');
    expect(paths).toContain('engine/src/dock/leak.ts');
  });

  it('adapters 只 import dock/ports 前缀与 model', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/adapters/ok.ts', `import { p } from '../dock/ports.js';\nimport { m } from '../model/m.js';\nexport const ok = [p, m];\n`);
    await write(root, 'engine/src/adapters/bad.ts', `import { l } from '../loop/l.js';\nexport const bad = l;\n`);
    const { violations } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    expect(violations.map((v) => v.path)).toContain('engine/src/adapters/bad.ts');
    expect(violations.map((v) => v.path)).not.toContain('engine/src/adapters/ok.ts');
  });

  it('四件间允许边 loop→graph、evolve→gate；其余互引违规', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/loop/a.ts', `import { g } from '../graph/g.js';\nexport const a = g;\n`);
    await write(root, 'engine/src/evolve/b.ts', `import { gateIt } from '../gate/gate_it.js';\nexport const b = gateIt;\n`);
    await write(root, 'engine/src/gate/c.ts', `import { l } from '../loop/a.js';\nexport const c = l;\n`);
    const { violations } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    expect(violations.map((v) => v.path)).toEqual(['engine/src/gate/c.ts']);
  });

  it('机制层红线：组装模块 import 与组装 token 命中即违规，whitelist 精确抑制', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/loop/r.ts', `import { asm } from '../core/path_assembler.js';\n// 出厂图红线样例\nexport const r = asm;\n`);
    const resHit = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    const msgs = resHit.violations.filter((v) => v.rule === 'layer-dag').map((v) => v.message).join('\n');
    expect(msgs).toContain('path_assembler');
    expect(msgs).toContain('出厂图');
    const resSafe = await scanAll({
      root,
      config: layerCfg({
        layerDagEnforce: true,
        layerDagWhitelist: ['engine/src/loop/r.ts:../core/path_assembler.js', 'engine/src/loop/r.ts:token:出厂图'],
      }),
    });
    expect(resSafe.violations.filter((v) => v.rule === 'layer-dag')).toEqual([]);
  });

  it('新层目录不存在整规则静默（未搬迁波次不误报）', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/core/legacy.ts', `export const legacy = 1;\n`);
    const { violations, warnings } = await scanAll({ root, config: layerCfg({ layerDagEnforce: true }) });
    expect(violations.filter((v) => v.rule === 'layer-dag')).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe('test-protection 测试保护', () => {
  it('源码改动无同批镜像测试 → 违规', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/foo/bar.ts', `export const bar = 1;\n`);
    const violations = await checkTestProtection(root, ['engine/src/foo/bar.ts']);
    expect(violations.map((v) => v.rule)).toContain('test-protection');
  });

  it('源码改动同批镜像测试改动 → 放行', async () => {
    const violations = await checkTestProtection('/nonexistent-root', [
      'engine/src/foo/bar.ts',
      'engine/test/foo/bar.test.ts',
    ]);
    expect(violations).toEqual([]);
  });

  it('文件头 test-exempt 标注豁免', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/foo/gen.ts', `// gate: test-exempt - 生成物镜像，无独立测试面\nexport const g = 1;\n`);
    const violations = await checkTestProtection(root, ['engine/src/foo/gen.ts']);
    expect(violations).toEqual([]);
  });

  it('只改测试不改源码 → 违规（防改测试让绿灯）', async () => {
    const violations = await checkTestProtection('/nonexistent-root', ['engine/test/foo/bar.test.ts']);
    expect(violations.map((v) => v.rule)).toContain('test-protection');
    expect(violations[0]!.message).toContain('src');
  });

  it('.mjs/.json/快照与 engine/scripts、gate 自身豁免；plugins 同住测试对放行', async () => {
    const violations = await checkTestProtection('/nonexistent-root', [
      'engine/scripts/dump_api_surface.mjs',
      'engine/api.surface.snapshot',
      'gate/src/scan.ts',
      'engine/baseline.json',
      'plugins/tools/doc_parse/faces/logic/index.ts',
      'plugins/tools/doc_parse/faces/logic/index.test.ts',
    ]);
    expect(violations).toEqual([]);
  });
});

describe('no-pending 禁待定字面', () => {
  it('命中 token 即 violation（文件聚合含行号）', () => {
    const violations = checkPendingTokens(`const a = 1; // 宿主待接线\nexport const b = a; // 占位\n`, 'engine/src/x.ts', ['待接线', '占位']);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('no-pending');
    expect(violations[0]!.message).toContain('L1');
  });

  it('无命中通过；enforce=false 时 scanAll 分流到 warnings', async () => {
    const root = await makeRoot();
    await write(root, 'engine/src/ok.ts', `export const x = 1;\n`);
    await write(root, 'engine/src/bad.ts', `// 机制先行\nexport const y = 1;\n`);
    const res = await scanAll({
      root,
      config: layerCfg({ noPendingDirs: ['engine/src'], noPendingTokens: ['机制先行'], noPendingEnforce: false }),
    });
    expect(res.violations.filter((v) => v.rule === 'no-pending')).toEqual([]);
    expect(res.warnings.map((v) => v.path)).toEqual(['engine/src/bad.ts']);
    const resEnf = await scanAll({
      root,
      config: layerCfg({ noPendingDirs: ['engine/src'], noPendingTokens: ['机制先行'], noPendingEnforce: true }),
    });
    expect(resEnf.violations.map((v) => v.path)).toContain('engine/src/bad.ts');
  });
});

describe('public-api 快照比对', () => {
  it('逐字一致通过', () => {
    expect(compareApiSurface('alpha:value\nbeta:type\n', 'alpha:value\nbeta:type\n')).toBeNull();
  });

  it('符号缺失/新增即违规且报告差异摘要', () => {
    const violation = compareApiSurface('alpha:value\nbeta:type\n', 'alpha:value\ngamma:value\n');
    expect(violation?.rule).toBe('public-api');
    expect(violation?.message).toContain('beta:type');
    expect(violation?.message).toContain('gamma:value');
  });
});

describe('no-orphan 扫描器', () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine', 'scripts', 'no_orphan.mjs');

  async function makeEngineSrcFixture(): Promise<string> {
    const root = await makeRoot();
    await write(root, 'src/index.ts', `export { a } from './app/main.js';\n`);
    await write(root, 'src/app/main.ts', `import { k } from '../util/kit.js';\nexport const a = k;\n`);
    await write(root, 'src/util/kit.ts', `export const k = 1;\n`);
    await write(root, 'src/island/alone.ts', `export const o = 1;\n`);
    return join(root, 'src');
  }

  it('report 模式列孤儿候选且 exit 0', async () => {
    const src = await makeEngineSrcFixture();
    const out = execFileSync(process.execPath, [scriptPath, '--src', src], { encoding: 'utf8' });
    expect(out).toContain('island/alone.ts');
    expect(out).not.toMatch(/orphan-candidate: app\/main\.ts/);
    expect(out).not.toMatch(/orphan-candidate: util\/kit\.ts/);
    expect(out).not.toMatch(/orphan-candidate: index\.ts/);
  });

  it('--strict 存在孤儿候选 exit 1', async () => {
    const src = await makeEngineSrcFixture();
    let status = 0;
    try {
      execFileSync(process.execPath, [scriptPath, '--src', src, '--strict'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
    }
    expect(status).toBe(1);
  });
});

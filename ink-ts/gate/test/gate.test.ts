import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scan } from '../src/scan.js';

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

  it('src 内夹测试文件被拒（测试须置于 test/）', async () => {
    const root = await makeRoot();
    await write(root, 'cli/src/server.test.ts', `import { describe, it } from 'vitest';\n`);
    const violations = await scan({ root, config: cfg });
    expect(violations.map((v) => v.rule)).toContain('src-test');
  });
});

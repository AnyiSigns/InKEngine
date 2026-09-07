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

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { PATCH_OP_VALUES } from '../../../src/gate/patch/types.js';

const FIXTURE = new URL('../../../fixtures/patch_protocol.fixture.json', import.meta.url);
const SCHEMA = new URL('../../../schemas/patch_protocol.schema.json', import.meta.url);

describe('patch 常量 ↔ 数据面 fixture/schema 一致', () => {
  it('PatchOp 与契约 fixture/schema 对齐（单一数据源）', async () => {
    const fixture = JSON.parse(await readFile(FIXTURE, 'utf-8')) as { patch_ops: string[] };
    const schema = JSON.parse(await readFile(SCHEMA, 'utf-8')) as {
      properties: { patch_ops: { items: { enum: string[] } } };
    };
    expect([...PATCH_OP_VALUES]).toEqual(fixture.patch_ops);
    expect([...PATCH_OP_VALUES]).toEqual(schema.properties.patch_ops.items.enum);
  });
});

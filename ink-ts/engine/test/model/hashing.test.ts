/**
 * 公共哈希 seam 测试（S1-c 自 graph/builder/_sha256.ts 迁入 model/hashing）：
 * 已知向量（FIPS 180-4 标准用例）+ 空输入 + 多块大输入（不溢出）+ hex 形态。
 */

import { describe, expect, it } from 'vitest';
import { sha256_hex } from '../../src/model/hashing.js';

describe('sha256_hex 公共哈希 seam', () => {
  it('空输入已知向量', () => {
    expect(sha256_hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('abc 已知向量', () => {
    expect(sha256_hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('标准长文本已知向量', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    expect(sha256_hex(new TextEncoder().encode(text))).toBe(
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    );
  });

  it('多块大输入（跨 64 字节块）不溢出且恒 64 位小写 hex', () => {
    const text = 'x'.repeat(1000) + 'y'.repeat(1000);
    expect(sha256_hex(new TextEncoder().encode(text))).toMatch(/^[0-9a-f]{64}$/);
  });
});

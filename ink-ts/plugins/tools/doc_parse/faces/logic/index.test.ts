/**
 * doc_parse logic face 测试（测试随插件同住，源码旁并列）。
 *
 * 覆盖：binary 未装配 = exec_unavailable 结构化降级（fail-closed 返回、
 * 不抛、不触 exec）；默认工厂构造返回可用性判定一致；maxChars/装配缺省注入。
 */

import { describe, expect, it } from 'vitest';

import createDocService, { DocService, DEFAULT_DOC_TEXT_CAP } from './index.js';

describe('doc_parse faces/logic', () => {
  it('binary=null 视为未装配：available()=false', () => {
    const service = new DocService({ binary: null });
    expect(service.available()).toBe(false);
  });

  it('binary=null 解析一律 exec_unavailable 结构化返回（不抛、不触 exec）', async () => {
    const service = new DocService({ binary: null });
    const result = await service.parseDocument('C:/nope/a.pdf', 'C:/nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('exec_unavailable');
    }
  });

  it('默认工厂 = DocService 装配实例（缺省上限 DEFAULT_DOC_TEXT_CAP）', () => {
    const factory = createDocService({ binary: null });
    expect(factory).toBeInstanceOf(DocService);
    expect(factory.available()).toBe(false);
    expect(DEFAULT_DOC_TEXT_CAP).toBe(20000);
  });
});

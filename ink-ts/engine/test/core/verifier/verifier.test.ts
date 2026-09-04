/**
 * VTM 验证器门控——verifier 模块语义单测（对标 ink_engine/core/verifier.py）：
 * 评审规格保留键、终败错误归因、LLM 评审流程（seam 注入，消息形态与评审
 * 提示逐字对齐）与 _parse_verdict 解析边界。违规驱动重做 / 重试上限 / 反馈
 * 回写属执行器门控接线（Python 侧在 test_verifier.py 端到端覆盖），本文件
 * 只对标 verifier.py 自身语义。
 */
import { describe, expect, it } from 'vitest';

import {
  LLMOutputVerifier,
  OutputVerificationError,
  VERIFY_FEEDBACK_KEY,
  VERIFY_KEY,
  _parse_verdict,
} from '../../../src/core/verifier/verifier.js';
import type {
  OutputVerifier,
  VerifierLlm,
  VerifierMessage,
  VerifyOptions,
  VerifyResult,
} from '../../../src/core/verifier/verifier.js';
import type { JsonRecord } from '../../../src/core/json.js';

const UNPARSEABLE = '评审输出无法解析';

/** 记录调用的假 LLM：固定返回 content，捕获每次入参消息。 */
class RecordingLlm implements VerifierLlm {
  content: string | null;
  calls: VerifierMessage[][] = [];

  constructor(content: string | null) {
    this.content = content;
  }

  async ainvoke(messages: readonly VerifierMessage[]): Promise<{ content?: string | null }> {
    this.calls.push([...messages]);
    return { content: this.content };
  }
}

/** 上游抛错的假 LLM（验证 LLM 异常原样上抛，Python 侧同样不捕获）。 */
class FailingLlm implements VerifierLlm {
  async ainvoke(_messages: readonly VerifierMessage[]): Promise<{ content?: string | null }> {
    throw new Error('上游故障');
  }
}

/** 可编排的假验证器（协议结构化实现）：按顺序消耗判决，剩余用 pass 兜底。 */
class FakeVerifier implements OutputVerifier {
  results: VerifyResult[];
  calls: Array<{ node: string; output: JsonRecord; spec: JsonRecord }> = [];

  constructor(results: VerifyResult[]) {
    this.results = results;
  }

  async verify(_ctx: unknown, options: VerifyOptions): Promise<VerifyResult> {
    const { node, output, spec } = options;
    const result = this.results.shift() ?? { pass: true, violations: [] };
    this.calls.push({ node, output: { ...output }, spec: { ...spec } });
    return result;
  }
}

describe('评审规格保留键（节点产出声明入口）', () => {
  it('VERIFY_KEY 与 VERIFY_FEEDBACK_KEY 取值为保留键字符串', () => {
    expect(VERIFY_KEY).toBe('__verify__');
    expect(VERIFY_FEEDBACK_KEY).toBe('__verify_feedback__');
    expect(VERIFY_KEY).not.toBe(VERIFY_FEEDBACK_KEY);
  });
});

describe('OutputVerificationError：终败错误归因', () => {
  it('缺省 entity_id = null；消息保留（RuntimeError → Error 子类收口）', () => {
    const err = new OutputVerificationError('节点产出未通过验证: produce');
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('节点产出未通过验证: produce');
    expect(err.entity_id).toBeNull();
  });

  it('携带 entity_id：演化管线据此定向变异', () => {
    const err = new OutputVerificationError('产出未通过验收', 'e1');
    expect(err.name).toBe('OutputVerificationError');
    expect(err.entity_id).toBe('e1');
    expect(err.message).toBe('产出未通过验收');
  });
});

describe('LLM 验证器评审流程（seam 注入）', () => {
  it('pass 放行：消息形态与评审提示拼装对齐 Python', async () => {
    const llm = new RecordingLlm('{"pass": true, "violations": []}');
    const verifier = new LLMOutputVerifier(llm);
    const result = await verifier.verify(null, {
      node: 'produce',
      output: { produced: true },
      spec: { task: '生成结果', requirements: ['含 produced', '非空'] },
    });
    expect(result).toEqual({ pass: true, violations: [] });
    expect(llm.calls).toHaveLength(1);
    const messages = llm.calls[0]!;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]!.content).toBe('你是验收评审器。');
    const prompt = messages[1]!.content;
    expect(prompt).toContain('给定任务、硬性要求与节点产出，判断产出是否通过验收。');
    expect(prompt).toContain('任务：生成结果');
    expect(prompt).toContain('硬性要求：\n- 含 produced\n- 非空');
    expect(prompt).toContain('节点产出：\n{"produced": true}');
    expect(prompt).toContain('只输出 JSON。产出不满足任何硬性要求就 pass=false，不要宽容。');
  });

  it('fail：违规清单原样流入判决', async () => {
    const llm = new RecordingLlm('{"pass": false, "violations": ["缺 produced 标记"]}');
    const verifier = new LLMOutputVerifier(llm);
    const result = await verifier.verify(null, {
      node: 'produce',
      output: { produced: true },
      spec: { task: '生成结果', requirements: ['含 produced'] },
    });
    expect(result).toEqual({ pass: false, violations: ['缺 produced 标记'] });
  });

  it('评审规格缺省 task/requirements：提示照常构造（空要求不出现清单行）', async () => {
    const llm = new RecordingLlm('{"pass": true, "violations": []}');
    const verifier = new LLMOutputVerifier(llm);
    const result = await verifier.verify(null, { node: 'produce', output: {}, spec: {} });
    expect(result).toEqual({ pass: true, violations: [] });
    const prompt = llm.calls[0]![1]!.content;
    expect(prompt).toContain('硬性要求：\n\n节点产出：\n{}');
    expect(prompt).not.toContain('- ');
  });

  it('LLM 返回 content 为 null/空：按无法解析兜底（评审不可信 = fail）', async () => {
    const verifier = new LLMOutputVerifier(new RecordingLlm(null));
    const result = await verifier.verify(null, { node: 'produce', output: {}, spec: {} });
    expect(result).toEqual({ pass: false, violations: [UNPARSEABLE] });
  });

  it('LLM 底层异常原样上抛（verify 不捕获）', async () => {
    const verifier = new LLMOutputVerifier(new FailingLlm());
    await expect(
      verifier.verify(null, { node: 'produce', output: {}, spec: {} }),
    ).rejects.toThrow('上游故障');
  });
});

describe('_parse_verdict 解析边界', () => {
  it('干净 JSON 对象：pass 与 violations 逐项读出', () => {
    expect(_parse_verdict('{"pass": true, "violations": []}')).toEqual({
      pass: true,
      violations: [],
    });
    expect(_parse_verdict('{"pass": false, "violations": ["缺 A", "缺 B"]}')).toEqual({
      pass: false,
      violations: ['缺 A', '缺 B'],
    });
  });

  it('散文前后夹取：只裁首尾花括号之间的文本', () => {
    expect(
      _parse_verdict('评审意见：{"pass": false, "violations": ["缺 A"]}。请修正。'),
    ).toEqual({ pass: false, violations: ['缺 A'] });
  });

  it('代码围栏夹带：JSON 块可正常解析', () => {
    expect(_parse_verdict('```json\n{"pass": true, "violations": []}\n```')).toEqual({
      pass: true,
      violations: [],
    });
  });

  it('无花括号文本 → 无法解析兜底', () => {
    expect(_parse_verdict('纯文本没有评审 JSON')).toEqual({
      pass: false,
      violations: [UNPARSEABLE],
    });
  });

  it('花括号内非 JSON → 无法解析兜底', () => {
    expect(_parse_verdict('前 {不是合法 JSON} 后')).toEqual({
      pass: false,
      violations: [UNPARSEABLE],
    });
  });

  it('多段 JSON 夹散文：首尾配对整段不可解析 → 兜底（对齐 find/rfind）', () => {
    expect(_parse_verdict('{"a": 1}\n然后 {"pass": false, "violations": []}')).toEqual({
      pass: false,
      violations: [UNPARSEABLE],
    });
  });

  it('嵌套对象不破坏边界：末位右花括号收口', () => {
    expect(
      _parse_verdict('前 {"pass": false, "meta": {"deep": [1, 2]}, "violations": ["缺 B"]} 后'),
    ).toEqual({ pass: false, violations: ['缺 B'] });
  });

  it('空对象 {} → pass=false 且违规为空', () => {
    expect(_parse_verdict('{}')).toEqual({ pass: false, violations: [] });
  });

  it('缺 pass / 缺 violations 字段：按缺省取值', () => {
    expect(_parse_verdict('{"task": "x"}')).toEqual({ pass: false, violations: [] });
  });

  it('violations falsy（空串）→ 空清单', () => {
    expect(_parse_verdict('{"pass": true, "violations": ""}')).toEqual({
      pass: true,
      violations: [],
    });
  });

  it('标量违规项按 Python str 口径渲染（None/布尔大写）', () => {
    expect(_parse_verdict('{"pass": false, "violations": [1, null, true, false]}')).toEqual({
      pass: false,
      violations: ['1', 'None', 'True', 'False'],
    });
  });

  it('pass 真值口径对齐 Python bool：字符串 "false" 为真、0 为假', () => {
    expect(_parse_verdict('{"pass": "false", "violations": []}')).toEqual({
      pass: true,
      violations: [],
    });
    expect(_parse_verdict('{"pass": 0, "violations": []}')).toEqual({
      pass: false,
      violations: [],
    });
  });
});

describe('OutputVerifier 协议（宿主注入形状）', () => {
  it('按序消耗判决、剩余 pass 兜底；调用快照记录 node', async () => {
    const verifier = new FakeVerifier([{ pass: false, violations: ['缺 A'] }]);
    const first = await verifier.verify(null, {
      node: 'produce',
      output: { produced: true },
      spec: { task: '生成结果' },
    });
    const fallback = await verifier.verify(null, {
      node: 'produce',
      output: { produced: true },
      spec: { task: '生成结果' },
    });
    expect(first).toEqual({ pass: false, violations: ['缺 A'] });
    expect(fallback).toEqual({ pass: true, violations: [] });
    expect(verifier.calls.map((c) => c.node)).toEqual(['produce', 'produce']);
  });

  it('调用快照为当时 dict 拷贝（事后改动原始对象不影响留痕）', async () => {
    const verifier = new FakeVerifier([]);
    const output = { produced: true };
    await verifier.verify(null, { node: 'produce', output, spec: { task: '生成结果' } });
    output.produced = false;
    expect(verifier.calls[0]!.output).toEqual({ produced: true });
  });
});

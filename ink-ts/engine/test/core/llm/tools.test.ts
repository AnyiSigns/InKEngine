/** 工具 schema 转换单测（ToolSpec → OpenAI tools JSON）——对标 pytest test_llm_tools.py。
 *
 *  Python 端 pydantic 转换测试因 TS core 零第三方（pydantic 为 Python 侧可选依赖）
 *  而不移植：宿主在注册工具时把 pydantic 形态预先 model_dump 为 dict 后再注入。
 *  其余 dict / 非法参数 / 多工具 / 空名拒绝等纯数据形态分支全量覆盖。
 */

import { describe, expect, it } from 'vitest';

import { LLMConfigError } from '../../../src/core/llm/errors.js';
import { ToolSpec, to_openai_tools } from '../../../src/core/llm/tools.js';

const EMPTY_PARAMS = { type: 'object', properties: {} };

describe('to_openai_tools（ToolSpec → OpenAI 兼容 tools 数组）', () => {
  it('none parameters defaults to empty object', () => {
    const tools = to_openai_tools([new ToolSpec({ name: 't1', description: 'desc' })]);
    expect(tools).toEqual([
      {
        type: 'function',
        function: { name: 't1', description: 'desc', parameters: EMPTY_PARAMS },
      },
    ]);
  });

  it('dict parameters passthrough（引用保留）', () => {
    const params = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const tools = to_openai_tools([
      new ToolSpec({ name: 'get_weather', description: '查询天气', parameters: params }),
    ]);
    const fn = tools[0]!['function'] as Record<string, unknown>;
    expect(fn['parameters']).toBe(params);
  });

  it('multiple tools', () => {
    const tools = to_openai_tools([new ToolSpec({ name: 'a' }), new ToolSpec({ name: 'b', description: 'B' })]);
    expect(tools.map((t) => (t['function'] as Record<string, unknown>)['name'])).toEqual(['a', 'b']);
  });

  it('empty name rejected', () => {
    expect(() => to_openai_tools([new ToolSpec({ name: '' })])).toThrow(LLMConfigError);
  });

  it('bad parameters type rejected', () => {
    expect(() => to_openai_tools([new ToolSpec({ name: 't', parameters: 42 })])).toThrow(LLMConfigError);
  });
});

describe('ToolSpec.to_dict/from_dict', () => {
  it('round trip with permissions', () => {
    const spec = new ToolSpec({
      name: 'fs.write',
      description: '写文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      permissions: ['filesystem:write:/book/**'],
    });
    const restored = ToolSpec.from_dict(spec.to_dict());
    expect(restored.name).toBe('fs.write');
    expect(restored.description).toBe('写文件');
    expect(restored.permissions).toEqual(['filesystem:write:/book/**']);
  });

  it('unknown keys ignored（增量演进兼容）', () => {
    const restored = ToolSpec.from_dict({
      name: 't',
      description: 'd',
      parameters: { type: 'object' },
      permissions: [],
      future_field: 'x',
    });
    expect(restored.name).toBe('t');
  });
});
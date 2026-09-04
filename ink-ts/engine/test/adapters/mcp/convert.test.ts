/**
 * MCP 客户端适配器单测：工具转换 / 清单生成 / schema 规范化 / 结果文本。
 */
import { describe, expect, it } from 'vitest';

import { GraphDefinitionError } from '../../../src/core/errors.js';
import { EndpointType } from '../../../src/core/declarative_tools/endpoint_types.js';
import { ToolSource } from '../../../src/core/tool_vetting/tool_vetting.js';
import {
  build_mcp_manifest,
  convert_mcp_tool,
  extract_text,
  normalize_input_schema,
  probe_args_from_schema,
  result_is_error,
} from '../../../src/adapters/mcp/index.js';

const tool = (name = 'search', schema?: Record<string, unknown>) => ({
  name,
  description: '搜索工具',
  inputSchema: schema ?? { type: 'object', properties: { q: { type: 'string' } } },
});

describe('convert_mcp_tool 工具转换', () => {
  it('字段映射：端点 MCP、路由密钥 server_id、按 server 权限', () => {
    const spec = convert_mcp_tool('s1', tool());
    expect(spec.name).toBe('search');
    expect(spec.endpoint).toBe(EndpointType.MCP);
    expect(spec.endpoint_config).toEqual({ server_id: 's1' });
    expect(spec.permissions).toEqual(['mcp:call:s1']);
    expect(spec.parameters['properties']).toEqual({ q: { type: 'string' } });
  });

  it('鸭子类型：非 dict 工具对象同样可转', () => {
    const spec = convert_mcp_tool('s2', { name: 't', description: 'd', inputSchema: null });
    expect(spec.name).toBe('t');
    expect(spec.endpoint_config).toEqual({ server_id: 's2' });
  });

  it('SDK 2.x 字段形态（input_schema）的参数 schema 完整保留', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    };
    const dictSpec = convert_mcp_tool('s1', {
      name: 't',
      description: 'd',
      input_schema: schema,
    });
    expect(dictSpec.parameters).toEqual(schema);
    const objectSpec = convert_mcp_tool('s1', {
      name: 't',
      description: 'd',
      input_schema: schema,
    });
    expect(objectSpec.parameters).toEqual(schema);
  });

  it('inputSchema 与 input_schema 两形态转换结果完全等价（契约文本对齐）', () => {
    const schema = {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    };
    const camel = convert_mcp_tool('s1', { name: 't', description: 'd', inputSchema: schema });
    const snake = convert_mcp_tool('s1', { name: 't', description: 'd', input_schema: schema });
    expect(camel.to_dict()).toEqual(snake.to_dict());
    expect(camel.parameters).toEqual(schema);
  });

  it('input_schema（2.x 字段）优先：同载两形态时以 2.x 为准', () => {
    const schema2x = { type: 'object', properties: { a: { type: 'string' } } };
    const schema1x = { type: 'object', properties: { b: { type: 'string' } } };
    const spec = convert_mcp_tool('s1', {
      name: 't',
      description: 'd',
      inputSchema: schema1x,
      input_schema: schema2x,
    });
    expect(spec.parameters).toEqual(schema2x);
  });

  it('缺 name（协议违规）→ 定义期拒绝', () => {
    expect(() => convert_mcp_tool('s1', { description: '无名字工具' })).toThrow(
      GraphDefinitionError,
    );
  });

  it('非对象 schema 归一为空对象 schema（不重写语义、不死）', () => {
    const spec = convert_mcp_tool('s1', tool('x', { type: 'string' } as Record<string, unknown>));
    expect(spec.parameters).toEqual({ type: 'object', properties: {} });
    const spec2 = convert_mcp_tool('s1', { name: 'x', description: 'd', inputSchema: null });
    expect(spec2.parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('build_mcp_manifest 清单生成', () => {
  it('签名由 server 身份派生（证明工具出自已审批连接）', () => {
    const manifest = build_mcp_manifest('s1', tool(), { source: ToolSource.MARKET });
    expect(manifest.name).toBe('search');
    expect(manifest.source).toBe(ToolSource.MARKET);
    expect(manifest.signature).toBe('mcp:s1:search');
    expect(manifest.permissions).toEqual(['mcp:call:s1']);
  });

  it('显式签名优先（已审批连接的身份标识）', () => {
    const manifest = build_mcp_manifest('s1', tool('a'), {
      source: ToolSource.GITHUB,
      signature: 'signed-by-host',
    });
    expect(manifest.signature).toBe('signed-by-host');
  });
});

describe('结果文本收敛（_result 面）', () => {
  it('dict 内容项文本提取：文本拼接 + 非文本标注类型', () => {
    const result = {
      content: [
        { type: 'text', text: '你好' },
        { type: 'text', text: 42 },
        { type: 'image', data: '...' },
      ],
    };
    expect(extract_text(result)).toBe('你好\n42\n[image]');
  });

  it('isError/is_error 双字段失败标记（2.x 优先）', () => {
    expect(result_is_error({ content: [], is_error: true })).toBe(true);
    expect(result_is_error({ content: [], isError: true })).toBe(true);
    expect(result_is_error({ content: [], isError: true, is_error: false })).toBe(false);
  });
});

describe('探针参数派生', () => {
  it('只取带默认值的可选参数（不猜测必填字段）', () => {
    const schema = {
      type: 'object',
      properties: {
        q: { type: 'string' },
        limit: { type: 'number', default: 10 },
        flag: { type: 'boolean', default: false },
      },
      required: ['q'],
    };
    expect(probe_args_from_schema(schema)).toEqual({ limit: 10, flag: false });
    expect(probe_args_from_schema(null)).toEqual({});
  });

  it('normalize_input_schema 兜底形态', () => {
    expect(normalize_input_schema('nope')).toEqual({ type: 'object', properties: {} });
    expect(normalize_input_schema({ type: 'string' })).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

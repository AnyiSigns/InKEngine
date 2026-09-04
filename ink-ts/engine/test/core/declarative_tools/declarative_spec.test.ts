/**
 * 声明式工具定义（DeclarativeToolSpec）单测——对标 ink_engine/tests/
 * test_declarative_tools.py 的定义层用例（强制权限/端点归一/数据往返/
 * 定义级网络策略/定义期白名单硬校验），逐条同名同义移植。
 *
 * 语义检查点：注册新工具 = 声明一条数据；未声明权限 = 定义期拒绝
 * （fail-closed 提前到建表期）；端点类型字符串形态构造期归一（无
 * 「校验放行但 is 全 False」静默失效）；file_ops operation enum 越域
 * 在定义期暴露而非运行期 fail-closed。
 *
 * 延后用例：真实执行体/IO 属宿主 seam，见 pipeline 各文件的文件头注。
 */
import { describe, expect, it } from 'vitest';

import { ToolSpec } from '../../../src/core/llm/tools.js';
import { NetworkPolicy } from '../../../src/core/permissions/networkPolicy.js';
import {
  DeclarativeToolSpec,
  EndpointType,
  endpoint_operation,
} from '../../../src/core/declarative_tools/index.js';
import { DeclarativeToolExecutors } from '../../../src/core/declarative_tools/index.js';
import { make_declarative_extractor } from '../../../src/core/declarative_tools/index.js';
import { GraphDefinitionError } from '../../../src/core/errors.js';

/** 默认声明式定义构建（对齐 Python 测试 _declarative 辅助）。 */
function declarative(
  endpoint: string = EndpointType.HTTP_FETCH,
  overrides: Partial<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    permissions: readonly string[];
    endpoint_config: Record<string, unknown>;
    meta: Record<string, unknown>;
    network_policy: NetworkPolicy | null;
  }> = {},
): DeclarativeToolSpec {
  return new DeclarativeToolSpec({
    name: 'mytool',
    description: '声明式工具',
    parameters: { type: 'object', properties: { url: { type: 'string' } } },
    permissions: ['network:connect:*.example.com'],
    endpoint,
    ...overrides,
  });
}

describe('强制权限声明', () => {
  it('permissions 缺失/为空 → 定义期拒绝（fail-closed）', () => {
    expect(
      () => new DeclarativeToolSpec({ name: 't', description: 'd', parameters: {}, permissions: [] }),
    ).toThrow('必须声明权限');
  });

  it('非法权限声明形态 → 定义期拒绝', () => {
    expect(() => declarative(EndpointType.HTTP_FETCH, { permissions: ['not-a-valid-permission'] })).toThrow(
      '权限声明非法',
    );
  });
});

describe('端点注册与归一', () => {
  it('未注册端点类型（非内置且未登记）→ 定义期拒绝', () => {
    expect(() => declarative('unknown_endpoint')).toThrow('端点类型未注册');
  });

  it('字符串端点与枚举端点构造等价（构造成功即运行期可用）', () => {
    // 回归：修复前字符串端点经枚举值成员匹配通过校验，但端点推导按恒等
    // 比较全 False——操作提取器无法判定目标，调用被 fail-closed 拒绝。
    // 现在常量字符串承载，构造期天然归一。
    const stringSpec = new DeclarativeToolSpec({
      name: 'fstool',
      description: 'file tool',
      parameters: { type: 'object' },
      permissions: ['filesystem:write:/book/**'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/book' },
    });
    const enumSpec = new DeclarativeToolSpec({
      name: 'fstool',
      description: 'file tool',
      parameters: { type: 'object' },
      permissions: ['filesystem:write:/book/**'],
      endpoint: EndpointType.FILE_OPS,
      endpoint_config: { root: '/book' },
    });
    expect(stringSpec.endpoint).toBe(EndpointType.FILE_OPS);
    expect(stringSpec.to_dict()).toEqual(enumSpec.to_dict());
    expect(stringSpec.to_dict()['endpoint']).toBe('file_ops');
    // 端点归一后操作推导与枚举声明完全一致（修复前此路径返回 null）
    expect(endpoint_operation(stringSpec.endpoint, { operation: 'write', path: '/book/a.md' })).toEqual([
      'write',
      '/book/a.md',
    ]);
    // 其余端点类型的字符串形态同样归一（各端点要求的配置齐全）
    expect(
      new DeclarativeToolSpec({
        name: 't',
        description: 'd',
        parameters: {},
        permissions: ['network:connect:*.example.com'],
        endpoint: 'http_fetch',
      }).endpoint,
    ).toBe(EndpointType.HTTP_FETCH);
    expect(
      new DeclarativeToolSpec({
        name: 't',
        description: 'd',
        parameters: {},
        permissions: ['process:exec:git'],
        endpoint: 'process_exec',
        endpoint_config: { allowlist: ['git'] },
      }).endpoint,
    ).toBe(EndpointType.PROCESS_EXEC);
    expect(
      new DeclarativeToolSpec({
        name: 't',
        description: 'd',
        parameters: {},
        permissions: ['mcp:call:s1'],
        endpoint: 'mcp',
        endpoint_config: { server_id: 's1' },
      }).endpoint,
    ).toBe(EndpointType.MCP);
  });

  it('字符串端点声明的定义经桥接提取器正常推导（登记/分发不依赖枚举入参）', () => {
    const executors = new DeclarativeToolExecutors();
    const definition = new DeclarativeToolSpec({
      name: 'fstool',
      description: 'file tool',
      parameters: { type: 'object' },
      permissions: ['filesystem:write:/book/**'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/book' },
    });
    executors.register_definition(definition);
    const extractor = make_declarative_extractor(executors);
    expect(extractor(definition.to_spec(), { operation: 'write', path: '/book/a.md' })).toEqual([
      'write',
      '/book/a.md',
    ]);
  });
});

describe('数据往返', () => {
  it('声明式定义数据往返（持久化/知识集导出形态）', () => {
    const definition = declarative(EndpointType.PROCESS_EXEC, {
      endpoint_config: { allowlist: ['git'] },
      meta: { source: 'seed' },
    });
    const rebuilt = DeclarativeToolSpec.from_dict(definition.to_dict());
    expect(rebuilt.name).toBe('mytool');
    expect(rebuilt.endpoint).toBe(EndpointType.PROCESS_EXEC);
    expect(rebuilt.endpoint_config).toEqual({ allowlist: ['git'] });
    expect(rebuilt.meta).toEqual({ source: 'seed' });
    expect(rebuilt.permissions).toEqual(['network:connect:*.example.com']);
  });

  it('定义级网络策略字段往返（宿主顶层 policy 不再折叠进 meta）', () => {
    const definition = declarative(EndpointType.HTTP_FETCH, {
      network_policy: new NetworkPolicy(['*.example.com', 'api.demo']),
      meta: { source: 'seed' },
    });
    const data = definition.to_dict();
    expect(data['network_policy']).toEqual({ allow_domains: ['*.example.com', 'api.demo'] });
    expect((data['meta'] as Record<string, unknown>)['network_policy']).toBeUndefined(); // 顶层承载
    const rebuilt = DeclarativeToolSpec.from_dict(data);
    expect(rebuilt.network_policy?.allow_domains).toEqual(definition.network_policy?.allow_domains);
    expect(rebuilt.network_policy?.allow_domains).toEqual(['*.example.com', 'api.demo']);
    // 缺省 None 往返：键省略 + 解析回落 None
    const plainData = declarative().to_dict();
    expect(plainData['network_policy']).toBeUndefined();
    expect(DeclarativeToolSpec.from_dict(plainData).network_policy).toBeNull();
  });

  it('network_policy 声明形态非法 = 定义期拒绝（fail-fast）', () => {
    const base = declarative().to_dict();
    expect(() =>
      DeclarativeToolSpec.from_dict({ ...base, network_policy: { allow_domains: 'x' } }),
    ).toThrow(GraphDefinitionError);
    expect(() => DeclarativeToolSpec.from_dict({ ...base, network_policy: 'http' })).toThrow(
      GraphDefinitionError,
    );
  });

  it('声明式定义 → 引擎工具描述（参数 schema 与权限声明透传）', () => {
    const spec = declarative().to_spec();
    expect(spec).toBeInstanceOf(ToolSpec);
    expect(spec.name).toBe('mytool');
    expect(spec.permissions).toEqual(['network:connect:*.example.com']);
  });
});

describe('端点配置定义期强制声明', () => {
  it('process_exec 端点强制声明命令白名单：缺失/空即拒绝（fail-closed）', () => {
    expect(() => declarative(EndpointType.PROCESS_EXEC)).toThrow('allowlist');
    expect(() =>
      declarative(EndpointType.PROCESS_EXEC, { endpoint_config: { allowlist: [] } }),
    ).toThrow('allowlist');
    // 声明合法白名单 → 通过
    declarative(EndpointType.PROCESS_EXEC, { endpoint_config: { allowlist: ['git'] } });
  });

  it('file_ops 端点强制声明根目录：缺失即拒绝（fail-closed）', () => {
    expect(() => declarative(EndpointType.FILE_OPS)).toThrow('root');
    declarative(EndpointType.FILE_OPS, { endpoint_config: { root: '/book' } });
  });

  it('file_ops 定义期硬校验：operation enum 必须 ⊆ 引擎操作域', () => {
    // 回归：file_edit 曾声明 operation enum 与提取器白名单不一致，运行期
    // 必被 fail-closed 拒绝且无从定位；现在定义期即报错。
    // 合法：enum 全部落在操作域内
    new DeclarativeToolSpec({
      name: 'fstool',
      description: 'file tool',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['read', 'write', 'edit'] },
          path: { type: 'string' },
        },
      },
      permissions: ['filesystem:write:/book/**'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/book' },
    });
    // 非法：enum 含引擎不支持的 chmod → 定义期拒绝
    expect(() =>
      new DeclarativeToolSpec({
        name: 'fstool2',
        description: 'file tool',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string', enum: ['write', 'chmod'] },
            path: { type: 'string' },
          },
        },
        permissions: ['filesystem:write:/book/**'],
        endpoint: 'file_ops',
        endpoint_config: { root: '/book' },
      }),
    ).toThrow('引擎不支持的文件操作');
    // 未声明 operation 参数（无 enum 约束）不触发校验
    new DeclarativeToolSpec({
      name: 'fstool3',
      description: 'file tool',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      permissions: ['filesystem:write:/book/**'],
      endpoint: 'file_ops',
      endpoint_config: { root: '/book' },
    });
  });
});

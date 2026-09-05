/**
 * 端点类型注册表单测——对标 ink_engine/tests/test_declarative_tools.py 的
 * 注册表层用例（内置登记/自定义端点扩展位/重复注册拒绝/一致性校验），
 * 逐条同名同义移植。
 *
 * 语义检查点：内置 7 种端点类型模块加载期登记；宿主自定义端点经注册表
 * 增补后同等走全流水线（构造期校验、判定目标按注册钩子分发、契约输出
 * 按注册表条目取数、注册表守卫自动接线），无「跳过流水线环节」开关；
 * 重复注册（含覆盖内置）与「声明守卫域但缺守卫构造器」= 编程错误显式
 * 拒绝（fail-closed，防静默覆盖引擎安全语义）。
 *
 * 自定义端点测试注册到模块级 endpoint_registry 单例，finally 清理
 * （对齐 Python 测试的 _specs.pop 姿势）。真实文件/子进程 IO 用例延后。
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_ENDPOINT_NAMES, BUILTIN_ENDPOINTS } from '@ink-ts/contracts';
import { SandboxViolation } from '../../../src/core/errors.js';
import { FIELD_ARRAY, SchemaField } from '../../../src/core/schema/schemaValidator.js';
import {
  DeclarativeToolExecutors,
  DeclarativeToolSpec,
  EndpointTypeSpec,
  build_declarative_pipeline,
  endpoint_operation,
  endpoint_operation_failure_reason,
  endpoint_registry,
  tool_contract_from_declaration,
} from '../../../src/core/declarative_tools/index.js';
import { assert_endpoint_contract } from '../../../src/core/declarative_tools/endpoint_types.js';

/** 清空测试期登记的自定义端点（内置 7 种保留）。 */
function removeCustom(name: string): void {
  endpoint_registry._specs.delete(name);
}

/** 自定义端点守卫桩：只放行白名单 target（validate 契约与引擎沙箱同）。 */
class AllowlistTargetSandbox {
  readonly allowed: readonly string[];

  constructor(allowed: readonly string[]) {
    this.allowed = allowed;
  }

  guards_operation(operation: string): boolean {
    return operation === 'query';
  }

  validate(operation: string, target: string): string | null {
    if (!this.allowed.includes(target)) {
      throw new SandboxViolation(`目标不在白名单: ${target}`);
    }
    return target;
  }
}

describe('内置端点注册', () => {
  it('引擎内置 7 种端点类型在模块加载期登记（注册表非空、名全）', () => {
    for (const name of [
      'http_fetch',
      'process_exec',
      'file_ops',
      'mcp',
      'web_search',
      'collab_request',
      'task_manager',
    ]) {
      expect(endpoint_registry.names).toContain(name);
    }
    expect(endpoint_registry.has('file_ops')).toBe(true);
    expect(endpoint_registry.get('file_ops')?.actions).toEqual([
      'read',
      'write',
      'delete',
      'edit',
      'search',
      'search_paths',
    ]);
  });
});

describe('自定义端点扩展位', () => {
  afterEach(() => {
    for (const name of ['database_query', 'db_req_test', 'guarded_query', 'incomplete_endpoint']) {
      removeCustom(name);
    }
  });

  it('宿主注册自定义端点：构造期校验通过、判定目标按注册钩子分发', () => {
    endpoint_registry.register(
      new EndpointTypeSpec({
        name: 'database_query',
        actions: ['query'],
        config_requirements: ['engine'],
        extractor: (args) => (args['table'] ? ['query', String(args['table'])] : null),
        failure_reason: (args) => (args['table'] ? null : 'table 参数缺失'),
        output_fields: [new SchemaField({ name: 'rows', required: true, kind: FIELD_ARRAY })],
      }),
    );
    try {
      const spec = new DeclarativeToolSpec({
        name: 'db_query',
        description: '数据库查询',
        parameters: { type: 'object', properties: { table: { type: 'string' } } },
        permissions: ['database:query:*'],
        endpoint: 'database_query',
        endpoint_config: { engine: 'sqlite' },
      });
      // 自定义端点保留字符串形态（非内置常量），构造期校验通过
      expect(spec.endpoint).toBe('database_query');
      expect(endpoint_operation('database_query', { table: 'books' })).toEqual(['query', 'books']);
      expect(endpoint_operation('database_query', {})).toBeNull();
      const reason = endpoint_operation_failure_reason('database_query', {});
      expect(reason).not.toBeNull();
      expect(reason).toContain('table 参数缺失');
      // 契约输出形态按注册表条目取数
      const contract = tool_contract_from_declaration(spec);
      expect(contract.output_schema?.fields[0]?.name).toBe('rows');
      // 序列化往返保持字符串形态
      const restored = DeclarativeToolSpec.from_dict(spec.to_dict());
      expect(restored.endpoint).toBe('database_query');
      expect(restored.endpoint_config['engine']).toBe('sqlite');
    } finally {
      removeCustom('database_query');
    }
  });

  it('自定义端点 config_requirements 定义期强制（缺声明即拒绝）', () => {
    endpoint_registry.register(
      new EndpointTypeSpec({
        name: 'db_req_test',
        actions: ['query'],
        config_requirements: ['engine'],
        extractor: (args) => (args['table'] ? ['query', String(args['table'])] : null),
      }),
    );
    try {
      expect(
        () =>
          new DeclarativeToolSpec({
            name: 'db_bad',
            description: '缺配置',
            parameters: {},
            permissions: ['database:query:*'],
            endpoint: 'db_req_test',
          }),
      ).toThrow('engine');
    } finally {
      removeCustom('db_req_test');
    }
  });

  it('未注册端点名的工具定义 → 构造期拒绝（fail-closed 于定义期）', () => {
    expect(
      () =>
        new DeclarativeToolSpec({
          name: 'ghost',
          description: '未注册端点',
          parameters: {},
          permissions: ['filesystem:read:*'],
          endpoint: 'no_such_endpoint',
        }),
    ).toThrow('端点类型未注册');
  });

  it('声明了守卫域但无守卫构造器 = 注册即拒绝（一致性校验）', () => {
    expect(
      () =>
        new EndpointTypeSpec({
          name: 'incomplete_endpoint',
          actions: ['query'],
          sandbox_ops: ['query'],
        }),
    ).toThrow('sandbox_builder');
  });

  it('自定义端点走全流水线：注册表守卫自动接线，违规 target 被沙箱拒绝', async () => {
    endpoint_registry.register(
      new EndpointTypeSpec({
        name: 'guarded_query',
        actions: ['query'],
        extractor: (args) => (args['target'] ? ['query', String(args['target'])] : null),
        sandbox_ops: ['query'],
        sandbox_builder: () => new AllowlistTargetSandbox(['ok']),
      }),
    );
    try {
      const definition = new DeclarativeToolSpec({
        name: 'gq',
        description: '带守卫查询',
        parameters: { type: 'object', properties: { target: { type: 'string' } } },
        permissions: ['database:query:*'],
        endpoint: 'guarded_query',
      });
      const executors = new DeclarativeToolExecutors();
      executors.register_definition(definition);
      executors.register('guarded_query', (ctx, defn, args) => `executed:${String(args['target'])}`);
      const pipeline = build_declarative_pipeline(executors);

      class Ctx {
        async emit(): Promise<void> {}
      }

      const ok = await pipeline.execute(new Ctx(), definition.to_spec(), { target: 'ok' });
      expect(ok.ok).toBe(true);
      expect(ok.output).toBe('executed:ok');
      const denied = await pipeline.execute(new Ctx(), definition.to_spec(), { target: 'bad' });
      expect(denied.ok).toBe(false);
      expect(denied.decision).toBe('deny');
      expect(denied.error).toContain('目标不在白名单');
    } finally {
      removeCustom('guarded_query');
    }
  });
});

describe('重复注册拒绝', () => {
  it('重复注册（含覆盖内置）= 显式拒绝（防静默覆盖引擎安全语义）', () => {
    const spec = endpoint_registry.get('file_ops');
    expect(spec).toBeDefined();
    expect(() => endpoint_registry.register(spec!)).toThrow('重复注册');
  });
});

describe('engine 端点枚举 ↔ contracts generated 一致（数据面单源）', () => {
  it('EndpointType 值集合与注册表名 ↔ BUILTIN_ENDPOINT_NAMES 一致', () => {
    expect(() => assert_endpoint_contract()).not.toThrow();
    expect(endpoint_registry.names).toEqual([...BUILTIN_ENDPOINT_NAMES]);
  });

  it('内置注册条目字段 ↔ BUILTIN_ENDPOINTS 全字段一致（数据驱动注册）', () => {
    for (const contract of BUILTIN_ENDPOINTS) {
      const spec = endpoint_registry.get(contract.name);
      expect(spec, `内置端点 ${contract.name} 已登记`).toBeDefined();
      expect(spec!.actions).toEqual([...contract.actions]);
      expect(spec!.config_requirements).toEqual([...contract.config_requirements]);
      expect(spec!.sandbox_ops).toEqual([...contract.sandbox_ops]);
      expect(spec!.output_fields.map((f) => [f.name, f.required, f.kind])).toEqual(
        contract.output_fields.map((f) => [f.name, f.required, f.kind]),
      );
    }
  });
});

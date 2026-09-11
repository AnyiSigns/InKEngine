/**
 * 自指层观察原语单测：内省服务快照正确性 + 元工具注册形态
 * （对标 Python test_introspection.py 服务快照段）。
 *
 * 覆盖：工具描述注册形态（权限声明）、规则/知识/界面/工具表快照
 * （恒定信封、默认严重度补全、深拷贝）、limit 钳制、
 * 未知工具名拒绝、各路快照 JSON 可序列化、OpenAI 工具转换契约。
 *
 * W7-B：inspect_graph 图结构观察子面（set_graph/snapshot_graph/降级视图）
 * 已随组装链路退役删除，图快照用例与函数直挂图夹具一并移除。
 *
 * 延后（defer）：引擎/运行时集成用例——introspection 是对运行时对象
 * 反射，TS 侧以 seam/注册表映射表达（注册表/实体目录为显式类型，
 * 不反射 JS 对象）；内省元工具接入引擎运行时工具表的用例
 * 待引擎运行时接线后补（随 tool_index / entities 先例）。Python 端
 * entities 套件的 TestIntrospectionEntities 亦依赖本模块，待实体目录
 * 快照的宿主接线后补测。
 */
import { describe, expect, it } from 'vitest';

import {
  INTROSPECTION_PERMISSION,
  IntrospectionService,
  IntrospectionSources,
  introspection_tool_specs,
  make_introspection_executor,
} from '../../../src/kernel/introspection/index.js';
import { LEVEL_USER } from '../../../src/core/knowledge_set/_types.js';
import { ToolSpec, to_openai_tools } from '../../../src/kernel/llm/tools.js';
import {
  INTROSPECTION_TOOL_NAMES,
  harness_registry,
  make_service,
} from './helpers.js';

describe('内省元工具注册形态', () => {
  it('五个工具描述：固定名序 + 只读权限声明 + schema/描述齐备', () => {
    const specs = introspection_tool_specs();
    expect(specs).toHaveLength(5);
    expect(specs.map((spec) => spec.name)).toEqual([...INTROSPECTION_TOOL_NAMES]);
    for (const spec of specs) {
      expect(spec.permissions).toEqual([INTROSPECTION_PERMISSION]);
      expect(spec.parameters).not.toBeNull();
      expect(typeof spec.parameters).toBe('object');
      expect(typeof spec.description).toBe('string');
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });
});

describe('规则/知识快照', () => {
  it('规则集快照：缺省严重度补全为 error，而非 null', () => {
    const service = make_service();
    const snapshot = service.snapshot_rules();
    expect(snapshot['count']).toBe(2);
    const rules = snapshot['rules'] as Array<Record<string, unknown>>;
    const by_id = new Map<string, Record<string, unknown>>();
    for (const rule of rules) by_id.set(String(rule['id']), rule);
    expect(by_id.get('rule-1')?.['severity']).toBe('error');
    expect(by_id.get('rule-2')?.['severity']).toBe('warning');
    expect(by_id.get('rule-1')?.['description']).toBe('主角行为须与既定动机一致');
  });

  it('知识集快照：统计 + 近期条目概览，limit 限制条数', () => {
    const service = make_service();
    const snapshot = service.snapshot_knowledge();
    expect(snapshot['count']).toBe(3);
    expect(snapshot['by_kind']).toEqual({ rule: 2, template: 1 });
    expect(snapshot['by_level']).toEqual({ [LEVEL_USER]: 3 });
    const titles = new Set(
      (snapshot['entries'] as Array<{ title: string }>).map((entry) => entry.title),
    );
    expect(titles).toEqual(new Set(['主角动机一致', '伏笔回收', '章节模板']));
    const limited = service.snapshot_knowledge(1) as { entries: unknown[] };
    expect(limited['entries']).toHaveLength(1);
  });

  it('limit 钳制到 [1, 100]：负值/越界不静默失真', () => {
    const service = make_service();
    const negative = service.snapshot_knowledge(-3) as { entries: unknown[] };
    expect(negative['entries']).toHaveLength(1);
    const huge = service.snapshot_knowledge(10000) as { entries: unknown[] };
    expect(huge['entries']).toHaveLength(3);
  });
});

describe('界面/工具表快照', () => {
  it('界面快照返回深拷贝：改写结果不得反写引擎源数据', () => {
    const service = make_service();
    const snapshot = service.snapshot_ui();
    const ui = snapshot['ui_spec'] as Record<string, string>;
    expect(ui['layout']).toBe('panel');
    ui['layout'] = 'mutated';
    const again = service.snapshot_ui()['ui_spec'] as Record<string, string>;
    expect(again['layout']).toBe('panel');
  });

  it('工具表快照含注入面清单与集内 harness 领域', () => {
    const service = make_service({ registry: harness_registry() });
    const snapshot = service.snapshot_tools();
    expect(snapshot['count']).toBe(5);
    const tools = snapshot['tools'] as Array<{ name: string; permissions: string[] }>;
    expect(tools.map((tool) => tool.name)).toContain('inspect_rules');
    expect(snapshot['harnesses']).toEqual(['novel']);
    expect(tools[0]?.permissions).toEqual([INTROSPECTION_PERMISSION]);
  });

  it('注入面与全量注册面分开呈现：注册面含未注入工具', () => {
    const injected = introspection_tool_specs();
    const registered = [
      ...injected,
      new ToolSpec({ name: 'shell_exec', description: '执行命令', parameters: {} }),
    ];
    const service = new IntrospectionService(
      new IntrospectionSources({
        harness_registry: harness_registry(),
        tools: injected,
        registered_tools: registered,
        ui_spec: { layout: 'panel' },
      }),
    );
    const snapshot = service.snapshot_tools();
    expect(snapshot['count']).toBe(5);
    const registered_only = snapshot['registered_tools'] as Array<{ name: string }>;
    expect(registered_only).toHaveLength(1);
    expect(registered_only[0]?.name).toBe('shell_exec');
    expect(snapshot['registered_count']).toBe(1);
  });
});

describe('分发与序列化', () => {
  it('未知工具名显式拒绝（fail-closed）', () => {
    const service = make_service();
    expect(() => service.snapshot('inspect_nothing', {})).toThrow('未知内省工具');
  });

  it('inspect_graph 已退役：分发面显式拒绝', () => {
    const service = make_service();
    expect(() => service.snapshot('inspect_graph', {})).toThrow('未知内省工具');
  });

  it('各快照均为可 JSON 序列化的确定性数据', () => {
    const service = make_service();
    for (const name of INTROSPECTION_TOOL_NAMES) {
      const snapshot = service.snapshot(name, {});
      expect(() => JSON.stringify(snapshot)).not.toThrow();
    }
  });

  it('知识集缺省为 null 时按空态呈现', () => {
    const service = make_service({ knowledge: null });
    expect(service.snapshot_rules()).toEqual({ rules: [], count: 0 });
    expect(service.snapshot_knowledge()).toEqual({
      entries: [],
      count: 0,
      by_kind: {},
      by_level: {},
    });
  });
});

describe('OpenAI 工具转换契约', () => {
  it('内省工具描述可转换为 OpenAI 兼容 tools schema', () => {
    const converted = to_openai_tools([...introspection_tool_specs()]);
    expect(converted).toHaveLength(5);
    const names = new Set(
      converted.map(
        (tool) => (tool['function'] as { name: string }).name,
      ),
    );
    expect(names).toEqual(new Set(INTROSPECTION_TOOL_NAMES));
  });
});

describe('内省执行器（统一工具流水线 executor 契约）', () => {
  const noop_ctx = {
    emit: async (_etype: string, _payload: Record<string, unknown>): Promise<void> => undefined,
  };

  it('执行返回 JSON 快照（只读观察出口，规则集名可解析）', async () => {
    const service = make_service();
    const executor = make_introspection_executor(service);
    const spec = introspection_tool_specs()[0]!;
    expect(spec.name).toBe('inspect_rules');
    const output = await executor(noop_ctx as never, spec, {}, null);
    const data = JSON.parse(String(output)) as { rules: Array<Record<string, unknown>>; count: number };
    expect(data.count).toBe(2);
    expect(data.rules[0]).toHaveProperty('id');
  });

  it('快照出口统一剥离敏感键：凭据不进入模型上下文', async () => {
    const secretService = new IntrospectionService(
      new IntrospectionSources({ ui_spec: { layout: 'panel', api_key: 'sk-LIVE-SECRET' } }),
    );
    const executor = make_introspection_executor(secretService);
    const spec = introspection_tool_specs().find((s) => s.name === 'inspect_ui')!;
    const output = String(await executor(noop_ctx as never, spec, {}, null));
    expect(output).not.toContain('sk-LIVE-SECRET');
    expect((JSON.parse(output) as { ui_spec: Record<string, string> }).ui_spec['api_key']).toBe('');
  });

  it('未知内省工具：执行期显式拒绝（错误文案携带原因）', async () => {
    const service = make_service();
    const executor = make_introspection_executor(service);
    const spec = new ToolSpec({
      name: 'inspect_nothing',
      description: '未知工具',
      parameters: {},
      permissions: [INTROSPECTION_PERMISSION],
    });
    await expect(executor(noop_ctx as never, spec, {}, null)).rejects.toThrow('未知内省工具');
  });
});

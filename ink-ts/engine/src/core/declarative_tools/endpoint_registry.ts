/**
 * 内置端点类型注册表单例（模块加载期登记；重复登记 = 编程错误）。
 *
 * 内置 7 种端点的**数据面**（name/actions/config_requirements/
 * output_fields/sandbox_ops）直接消费 contracts generated BUILTIN_ENDPOINTS
 * ——schema/fixture 为唯一真源，本地不维护第二套字面量；output_fields 的
 * kind 语义 = 数据面 FieldKind（经 schemaValidator.FieldKind 与
 * @ink-ts/contracts 同值域单源化，形状一致，无窄映射缺口；若日后两端
 * 形状分叉，在此做一次显式窄映射）。
 *
 * 引擎特有**钩子面**（判定目标提取 extractor / 失败原因 failure_reason /
 * 沙箱守卫 sandbox_builder）不落 JSON，按端点名在下方本地注册表登记
 * （钩子面规则，CODING §5.2）——hooks 键集合以 satisfies 绑定 generated
 * BuiltinEndpointName 联合，新增内置端点缺钩子 = 编译期错误；端点名集合
 * 双向相等由 endpoint_types 编译期绑定 + assert_endpoint_contract 兜底。
 *
 * 宿主自定义端点经 EndpointTypeRegistry.register 增补到同一注册表后，
 * build_declarative_pipeline 缺省自动生效。
 */
import { BUILTIN_ENDPOINTS, type BuiltinEndpointName } from '@ink-ts/contracts';
import { FileSandbox, ProcessSandbox } from '../sandbox/index.js';
import { SchemaField } from '../schema/schemaValidator.js';
import type { SandboxSeam } from '../tool_pipeline/_types.js';
import { EndpointTypeRegistry, EndpointTypeSpec } from './endpoint_types.js';
import type { EndpointExtractor, EndpointFailureReason } from './endpoint_types.js';
import type { DeclarativeToolSpec } from './declarative_spec.js';
import {
  _extract_collab_request,
  _extract_file_ops,
  _extract_http_fetch,
  _extract_mcp,
  _extract_process_exec,
  _extract_task_manager,
  _extract_web_search,
  _reason_collab_request,
  _reason_file_ops,
  _reason_http_fetch,
  _reason_mcp,
  _reason_process_exec,
  _reason_task_manager,
  _reason_web_search,
} from './_hooks.js';

/** 模块级端点类型注册表（内置默认 + 宿主自定义端点的共享单例）。 */
export const endpoint_registry = new EndpointTypeRegistry();

/** 端点名 → 引擎钩子接线（数据面缺省均来自 BUILTIN_ENDPOINTS）。 */
interface BuiltinHooks {
  extractor: EndpointExtractor;
  failure_reason: EndpointFailureReason;
  /** 沙箱守卫构造器（数据面声明了 sandbox_ops 时必须提供，缺 = 注册即拒）。 */
  sandbox_builder?: (definition: DeclarativeToolSpec) => SandboxSeam;
}

/** 按端点名的引擎钩子表（satisfies 绑定 generated 名联合：内置端点必须
 *  全部登记钩子；沙箱守卫域进程/file_ops 在此按声明配置键接线）。 */
const _BUILTIN_HOOKS = {
  http_fetch: { extractor: _extract_http_fetch, failure_reason: _reason_http_fetch },
  process_exec: {
    extractor: _extract_process_exec,
    failure_reason: _reason_process_exec,
    sandbox_builder: (definition: DeclarativeToolSpec): ProcessSandbox => {
      const allowlist = definition.endpoint_config['allowlist'];
      const path = definition.endpoint_config['path'];
      return new ProcessSandbox(
        Array.isArray(allowlist) ? (allowlist as string[]) : [],
        30.0,
        null,
        undefined,
        null,
        typeof path === 'string' ? path : null,
      );
    },
  },
  file_ops: {
    extractor: _extract_file_ops,
    failure_reason: _reason_file_ops,
    sandbox_builder: (definition: DeclarativeToolSpec): FileSandbox =>
      new FileSandbox(String(definition.endpoint_config['root'] ?? '')),
  },
  mcp: { extractor: _extract_mcp, failure_reason: _reason_mcp },
  web_search: { extractor: _extract_web_search, failure_reason: _reason_web_search },
  collab_request: { extractor: _extract_collab_request, failure_reason: _reason_collab_request },
  task_manager: { extractor: _extract_task_manager, failure_reason: _reason_task_manager },
} as const satisfies Record<BuiltinEndpointName, BuiltinHooks>;

// 数据驱动内置登记：契约条目 → 默认 EndpointTypeSpec（全字段），再叠加
// 引擎特有钩子（extractor/failure_reason/sandbox_builder 按名取表）。
for (const builtin of BUILTIN_ENDPOINTS) {
  const hooks: BuiltinHooks = _BUILTIN_HOOKS[builtin.name];
  const output_fields = builtin.output_fields.map(
    (field) =>
      new SchemaField({ name: field.name, required: field.required, kind: field.kind }),
  );
  endpoint_registry.register(
    new EndpointTypeSpec({
      name: builtin.name,
      actions: builtin.actions,
      config_requirements: builtin.config_requirements,
      output_fields,
      extractor: hooks.extractor,
      failure_reason: hooks.failure_reason,
      sandbox_ops: builtin.sandbox_ops,
      sandbox_builder: hooks.sandbox_builder ?? null,
    }),
  );
}

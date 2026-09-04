/**
 * 内置端点类型注册表单例（模块加载期登记；重复登记 = 编程错误）。
 *
 * 引擎内置 7 种端点类型在此登记（机制语义，declarative_tools.py
 * :371-463 移植）：http_fetch（NetworkPolicy 网络守卫）、process_exec
 * （ProcessSandbox 命令白名单）、file_ops（FileSandbox 根目录）、
 * mcp / web_search / collab_request / task_manager（门禁+审批为边界，
 * 无本地沙箱）。宿主自定义端点经 EndpointTypeRegistry.register 增补到
 * 同一注册表后，build_declarative_pipeline 缺省自动生效（registry
 * 参数缺省 = 本单例）。
 */
import { FileSandbox, ProcessSandbox } from '../sandbox/index.js';
import { FIELD_ARRAY, FIELD_NUMBER, FIELD_OBJECT, FIELD_STRING, SchemaField } from '../schema/schemaValidator.js';
import { EndpointType, EndpointTypeRegistry, EndpointTypeSpec } from './endpoint_types.js';
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

function _register_builtin_endpoint(spec: EndpointTypeSpec): void {
  endpoint_registry.register(spec);
}

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.HTTP_FETCH,
    actions: ['connect'],
    extractor: _extract_http_fetch,
    failure_reason: _reason_http_fetch,
    output_fields: [
      new SchemaField({ name: 'status_code', required: true, kind: FIELD_NUMBER }),
      new SchemaField({ name: 'body', required: true, kind: FIELD_STRING }),
    ],
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.PROCESS_EXEC,
    actions: ['exec'],
    config_requirements: ['allowlist'],
    extractor: _extract_process_exec,
    failure_reason: _reason_process_exec,
    output_fields: [
      new SchemaField({ name: 'stdout', required: true, kind: FIELD_STRING }),
      new SchemaField({ name: 'exit_code', required: true, kind: FIELD_NUMBER }),
    ],
    sandbox_ops: ['exec'],
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
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.FILE_OPS,
    actions: ['read', 'write', 'delete', 'edit', 'search', 'search_paths'],
    config_requirements: ['root'],
    extractor: _extract_file_ops,
    failure_reason: _reason_file_ops,
    output_fields: [new SchemaField({ name: 'result', required: true, kind: FIELD_STRING })],
    sandbox_ops: ['read', 'write', 'delete', 'edit', 'search', 'search_paths'],
    sandbox_builder: (definition: DeclarativeToolSpec): FileSandbox =>
      new FileSandbox(String(definition.endpoint_config['root'] ?? '')),
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.MCP,
    actions: ['call'],
    config_requirements: ['server_id'],
    extractor: _extract_mcp,
    failure_reason: _reason_mcp,
    output_fields: [new SchemaField({ name: 'result', required: true, kind: FIELD_OBJECT })],
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.WEB_SEARCH,
    actions: ['search'],
    extractor: _extract_web_search,
    failure_reason: _reason_web_search,
    output_fields: [new SchemaField({ name: 'results', required: true, kind: FIELD_ARRAY })],
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.COLLAB_REQUEST,
    actions: ['request'],
    extractor: _extract_collab_request,
    failure_reason: _reason_collab_request,
  }),
);

_register_builtin_endpoint(
  new EndpointTypeSpec({
    name: EndpointType.TASK_MANAGER,
    actions: ['manage'],
    extractor: _extract_task_manager,
    failure_reason: _reason_task_manager,
  }),
);

/**
 * 端点判定目标推导与失败原因单测——对标 ink_engine/tests/
 * test_declarative_tools.py 的 endpoint_operation / failure_reason 用例，
 * 逐条同名同义移植。
 *
 * 语义检查点：http_fetch → (connect, host)（仅 http/https + 合法 host，
 * 协议/凭据形态 fail-closed）；process_exec → (exec, 命令名)（operation_param
 * 声明优先、argv 字符串化容错）；file_ops → (操作, 路径)（search/
 * search_paths 无 path 回落根、edit 一等操作域、非法操作无判定目标）；
 * mcp / web_search / collab_request / task_manager 按声明语义取目标；
 * 失败原因钩子给结构化文案（指引模型自我纠正），与提取器同源分发。
 */
import { describe, expect, it } from 'vitest';

import {
  EndpointType,
  endpoint_operation,
  endpoint_operation_failure_reason,
} from '../../../src/core/declarative_tools/index.js';

describe('http_fetch 端点判定', () => {
  it('从参数推导 (connect, host)——域名判定目标', () => {
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'https://api.example.com/v1/books' })).toEqual([
      'connect',
      'api.example.com',
    ]);
    expect(endpoint_operation(EndpointType.HTTP_FETCH, {})).toBeNull();
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'not-a-url' })).toBeNull();
  });

  it('仅 http/https + 合法 host 才产生判定目标（协议白名单）', () => {
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'https://api.example.com:8443/v1' })).toEqual([
      'connect',
      'api.example.com',
    ]);
    // 非白名单协议 / 无协议 → 无法判定（fail-closed）
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'ftp://example.com/f' })).toBeNull();
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'javascript:alert(1)' })).toBeNull();
    // 带凭据的 URL：host 判定目标不含凭据
    expect(endpoint_operation(EndpointType.HTTP_FETCH, { url: 'https://user:pass@example.com/x' })).toEqual([
      'connect',
      'example.com',
    ]);
  });

  it('失败原因：url 缺失 → 有原因；合法调用 → 无原因', () => {
    expect(endpoint_operation_failure_reason(EndpointType.HTTP_FETCH, {})).not.toBeNull();
    expect(
      endpoint_operation_failure_reason(EndpointType.HTTP_FETCH, { url: 'https://a.example.com/x' }),
    ).toBeNull();
  });
});

describe('process_exec 端点判定', () => {
  it('命令名作判定目标', () => {
    expect(endpoint_operation(EndpointType.PROCESS_EXEC, { command: 'git', args: ['status'] })).toEqual([
      'exec',
      'git',
    ]);
  });

  it('操作目标参数名声明：判定优先声明、缺省回落（向后兼容）', () => {
    // 端点配置声明 operation_param 后，判定读声明参数名
    const declared = endpoint_operation(
      EndpointType.PROCESS_EXEC,
      { cmd: 'git', args: ['status'] },
      { config: { allowlist: ['git'], operation_param: 'cmd' } },
    );
    expect(declared).toEqual(['exec', 'git']);
    // 声明优先：声明后不再读 command 参数（防声明与既有参数双源歧义）
    expect(
      endpoint_operation(
        EndpointType.PROCESS_EXEC,
        { cmd: 'git', command: 'curl' },
        { config: { operation_param: 'cmd' } },
      ),
    ).toEqual(['exec', 'git']);
    // 声明参数缺失 = 无法判定目标（fail-closed，不回落 command）
    expect(
      endpoint_operation(EndpointType.PROCESS_EXEC, { command: 'git' }, { config: { operation_param: 'cmd' } }),
    ).toBeNull();
    // 缺省回落：无声明（无 config）仍按 command 推导
    expect(endpoint_operation(EndpointType.PROCESS_EXEC, { command: 'git' })).toEqual(['exec', 'git']);
    expect(
      endpoint_operation(EndpointType.PROCESS_EXEC, { command: 'git' }, { config: { allowlist: ['git'] } }),
    ).toEqual(['exec', 'git']);
  });

  it('argv 参数被模型字符串化时容错（JSON 字符串数组 → 数组）', () => {
    // shell_exec 命令面 = argv[0]：模型常把嵌套数组输出为 JSON 字符串，
    // 提取器须解析为数组再取首元素作判定目标，否则 fail-closed 误拒。
    const config = { operation_param: 'argv', allowlist: ['pip', 'python'] };
    expect(
      endpoint_operation(
        EndpointType.PROCESS_EXEC,
        { command: 'shell_exec', argv: '["pip", "install", "pytest"]' },
        { config },
      ),
    ).toEqual(['exec', 'pip']);
    // 失败原因：容错成功后返回 null（判定可成立）
    expect(
      endpoint_operation_failure_reason(
        EndpointType.PROCESS_EXEC,
        { command: 'shell_exec', argv: '["pip", "install"]' },
        { config },
      ),
    ).toBeNull();
    // 非 JSON / 非数组字符串 = 无法判定（fail-closed），文案指引正确形态
    expect(
      endpoint_operation(EndpointType.PROCESS_EXEC, { command: 'shell_exec', argv: 'pip install' }, { config }),
    ).toBeNull();
    const reason = endpoint_operation_failure_reason(
      EndpointType.PROCESS_EXEC,
      { command: 'shell_exec', argv: 'pip install' },
      { config },
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain('字符串数组');
  });
});

describe('file_ops 端点判定', () => {
  it('操作 + 路径作判定目标（非法操作不产生判定目标）', () => {
    expect(
      endpoint_operation(EndpointType.FILE_OPS, { operation: 'write', path: '/book/ch1.md' }),
    ).toEqual(['write', '/book/ch1.md']);
    expect(endpoint_operation(EndpointType.FILE_OPS, { operation: 'chmod', path: '/x' })).toBeNull();
  });

  it('edit = 就地改写一等操作域，判定目标原样保留（不再归一为 write）', () => {
    expect(
      endpoint_operation(EndpointType.FILE_OPS, { operation: 'edit', path: '/book/ch1.md' }),
    ).toEqual(['edit', '/book/ch1.md']);
    // 未知操作仍无法判定（fail-closed 不破坏）
    expect(endpoint_operation(EndpointType.FILE_OPS, { operation: 'chmod', path: '/x' })).toBeNull();
  });

  it('检索操作：search/search_paths 判定目标（无 path 回落端点根）', () => {
    expect(
      endpoint_operation(EndpointType.FILE_OPS, { operation: 'search', pattern: 'foo' }, { config: { root: '/ws' } }),
    ).toEqual(['search', '/ws']);
    expect(
      endpoint_operation(
        EndpointType.FILE_OPS,
        { operation: 'search_paths', pattern: '**/*.py', path: '/ws/src' },
        { config: { root: '/ws' } },
      ),
    ).toEqual(['search_paths', '/ws/src']);
    // 无根回落（未注入 config）= 无法判定目标（fail-closed）
    expect(endpoint_operation(EndpointType.FILE_OPS, { operation: 'search', pattern: 'x' })).toBeNull();
    // 非法操作仍无法判定（fail-closed）
    expect(endpoint_operation(EndpointType.FILE_OPS, { operation: 'chmod', path: '/x' })).toBeNull();
  });

  it('判定失败原因：缺 operation/非法 operation 给出合法值清单', () => {
    const reason = endpoint_operation_failure_reason(EndpointType.FILE_OPS, { path: '/book/ch1.md' });
    expect(reason).not.toBeNull();
    expect(reason).toContain('operation');
    expect(reason).toContain('edit');
    const bad = endpoint_operation_failure_reason(EndpointType.FILE_OPS, { operation: 'chmod', path: '/x' });
    expect(bad).not.toBeNull();
    expect(bad).not.toContain('chmod');
    // 合法调用不产生失败原因
    expect(
      endpoint_operation_failure_reason(EndpointType.FILE_OPS, { operation: 'write', path: '/a.md' }),
    ).toBeNull();
  });
});

describe('web_search / task_manager 端点判定', () => {
  it('web_search：独立权限动作 search（空查询无法判定）', () => {
    expect(endpoint_operation(EndpointType.WEB_SEARCH, { query: '最新研究', limit: 5 })).toEqual([
      'search',
      '最新研究',
    ]);
    expect(endpoint_operation(EndpointType.WEB_SEARCH, {})).toBeNull();
    expect(endpoint_operation(EndpointType.WEB_SEARCH, { query: '' })).toBeNull();
  });

  it('task_manager 判定目标 = operation 值（todo:manage:<op>）', () => {
    expect(endpoint_operation(EndpointType.TASK_MANAGER, { operation: 'create', title: '任务' })).toEqual([
      'manage',
      'create',
    ]);
    // 缺 operation = fail-closed，失败原因给出操作集指引
    expect(endpoint_operation(EndpointType.TASK_MANAGER, { title: '任务' })).toBeNull();
    const reason = endpoint_operation_failure_reason(EndpointType.TASK_MANAGER, { title: '任务' });
    expect(reason).not.toBeNull();
    expect(reason).toContain('create/update/complete/list/clear/delete');
  });
});

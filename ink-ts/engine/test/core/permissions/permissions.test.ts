/**
 * 声明式权限门禁测试（PermissionGate / NetworkPolicy / 权限声明语义）——
 * 对标 ink_engine/tests/test_permissions.py 的本模块语义用例，逐条同名
 * 同义移植；ToolSpec/to_openai_tools 用例属 tools 模块，不在本测试范围。
 *
 * 覆盖：权限解析、分域匹配（filesystem/process/network/自定义域）、
 * 三路判定（allow/review/deny）、fail-closed 默认拒绝、宿主默认策略让步、
 * 门控分级注入、网络白名单；另含本模块语义的路径越界拒绝与 network 既有
 * search 声明兼容两条（Python 侧同样成立）。
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOW,
  DENY,
  NetworkPolicy,
  PermissionGate,
  REVIEW,
  network_matches,
  parse_permission,
  rule_matches,
} from '../../../src/core/permissions/permissions.js';

describe('权限解析', () => {
  it('parse_permission 三段式', () => {
    const rule = parse_permission('filesystem:write:/book/**');
    expect(rule.domain).toBe('filesystem');
    expect(rule.action).toBe('write');
    expect(rule.pattern).toBe('/book/**');
  });

  it('parse_permission 省略 action', () => {
    const rule = parse_permission('network:*.github.com');
    expect(rule.domain).toBe('network');
    expect(rule.action).toBe('*');
    expect(rule.pattern).toBe('*.github.com');
  });

  it('parse_permission 非法形态抛错', () => {
    for (const bad of ['filesystem', '', ':']) {
      expect(() => parse_permission(bad)).toThrow();
    }
    // 形态缺 action/pattern 之分段与非空约束的消息区分
    expect(() => parse_permission('filesystem')).toThrow('权限声明须为 domain[:action]:pattern 形态');
    expect(() => parse_permission(':')).toThrow('domain/pattern 不能为空');
  });
});

describe('分域匹配', () => {
  it('filesystem glob 匹配', () => {
    const rule = parse_permission('filesystem:write:/book/**');
    expect(rule_matches(rule, 'write', '/book/ch1.md')).toBe(true);
    expect(rule_matches(rule, 'write', '/book/卷2/ch1.md')).toBe(true);
    expect(rule_matches(rule, 'write', '/other/ch1.md')).toBe(false);
    expect(rule_matches(rule, 'read', '/book/ch1.md')).toBe(false); // 动作不符
  });

  it('filesystem 动作通配', () => {
    const rule = parse_permission('filesystem:*:/book/**');
    expect(rule_matches(rule, 'read', '/book/a.md')).toBe(true);
    expect(rule_matches(rule, 'delete', '/book/a.md')).toBe(true);
  });

  it('filesystem 路径越界拒绝：含 .. 段一律不命中', () => {
    const rule = parse_permission('filesystem:write:/book/**');
    expect(rule_matches(rule, 'write', '/book/../../etc/passwd')).toBe(false);
    expect(rule_matches(rule, 'write', 'book/../x')).toBe(false);
    // Windows 反斜杠路径先归一为正斜杠再判定
    expect(rule_matches(rule, 'write', '/book\\ch1.md')).toBe(true);
  });

  it('process 命令白名单', () => {
    const rule = parse_permission('process:exec:git|python');
    expect(rule_matches(rule, 'exec', 'git')).toBe(true);
    expect(rule_matches(rule, 'exec', 'python')).toBe(true);
    expect(rule_matches(rule, 'exec', 'rm')).toBe(false);
  });

  it('network 后缀匹配', () => {
    const rule = parse_permission('network:connect:*.github.com');
    expect(rule_matches(rule, 'connect', 'github.com')).toBe(true);
    expect(rule_matches(rule, 'connect', 'api.github.com')).toBe(true);
    expect(rule_matches(rule, 'connect', 'evil.github.com.cn')).toBe(false);
  });

  it('network_matches 辅助函数', () => {
    expect(network_matches('*.github.com', 'github.com')).toBe(true);
    expect(network_matches('*.github.com', 'api.github.com')).toBe(true);
    expect(network_matches('*.github.com', 'raw.githubusercontent.com')).toBe(false);
    expect(network_matches('*.github.com', 'github.org')).toBe(false);
  });

  it('network 既有声明兼容：connect:* 全通仍放行 search 独立动作', () => {
    const rule = parse_permission('network:connect:*');
    expect(rule_matches(rule, 'search', '任意查询串')).toBe(true);
  });

  it('自定义域走 fnmatch', () => {
    const rule = parse_permission('db:query:users|books');
    expect(rule_matches(rule, 'query', 'users')).toBe(true);
    expect(rule_matches(rule, 'query', 'books')).toBe(true);
    expect(rule_matches(rule, 'query', 'secrets')).toBe(false);
  });
});

describe('三路判定', () => {
  it('声明权限命中 → allow', () => {
    const gate = new PermissionGate();
    const result = gate.check('write_file', 'write', '/book/ch1.md', {
      permissions: ['filesystem:write:/book/**'],
    });
    expect(result.decision).toBe(ALLOW);
    expect(result.tool).toBe('write_file');
  });

  it('未声明权限 → 默认拒绝（fail-closed）', () => {
    const gate = new PermissionGate();
    const result = gate.check('write_file', 'write', '/book/ch1.md');
    expect(result.decision).toBe(DENY);
    expect(result.reason).toContain('默认拒绝');
  });

  it('声明权限未命中 → deny', () => {
    const gate = new PermissionGate();
    const result = gate.check('write_file', 'write', '/etc/passwd', {
      permissions: ['filesystem:write:/book/**'],
    });
    expect(result.decision).toBe(DENY);
    expect(result.reason).toContain('未命中');
  });

  it('filesystem 域拒绝附工作区根绝对前缀提示', () => {
    const gate = new PermissionGate();
    const result = gate.check('write_file', 'write', 'src/ch1.md', {
      permissions: ['filesystem:write:/workspace/**'],
    });
    expect(result.decision).toBe(DENY);
    expect(result.reason).toContain('未命中');
    expect(result.reason).toContain('工作区根绝对前缀');

    // 非 filesystem 操作域（process exec）不附加路径形态提示
    const proc = gate.check('run_cmd', 'exec', 'rm', {
      permissions: ['process:exec:git|python'],
    });
    expect(proc.decision).toBe(DENY);
    expect(proc.reason).not.toContain('工作区根');

    // 未声明任何 filesystem 权限的工具拒绝：不附路径形态提示（缺权限非路径形态问题）
    const bare = gate.check('write_file', 'write', '/etc/passwd');
    expect(bare.decision).toBe(DENY);
    expect(bare.reason).not.toContain('工作区根');
  });

  it('宿主放宽默认策略为 review', () => {
    const gate = new PermissionGate(REVIEW);
    const result = gate.check('write_file', 'write', '/book/ch1.md');
    expect(result.decision).toBe(REVIEW);
    expect(result.reason).toContain('放宽');
  });

  it('宿主放宽默认策略为 allow', () => {
    const gate = new PermissionGate(ALLOW);
    const result = gate.check('write_file', 'write', '/book/ch1.md');
    expect(result.decision).toBe(ALLOW);
  });

  it('门控分级注入：命中后按工具转 review / 直过', () => {
    const gate = new PermissionGate(DENY, (tool: string) => tool === 'write_chapter_content');
    const result = gate.check('write_chapter_content', 'write', '/book/ch1.md', {
      permissions: ['filesystem:write:/book/**'],
    });
    expect(result.decision).toBe(REVIEW);
    expect(result.reason).toContain('门控分级');

    const result2 = gate.check('write_file', 'write', '/book/ch1.md', {
      permissions: ['filesystem:write:/book/**'],
    });
    expect(result2.decision).toBe(ALLOW); // 非分级工具直过
  });
});

describe('网络白名单', () => {
  it('NetworkPolicy 默认禁网', () => {
    const policy = new NetworkPolicy();
    expect(policy.allows('github.com')).toBe(false);
  });

  it('NetworkPolicy 白名单后缀匹配', () => {
    const policy = new NetworkPolicy(['*.github.com', 'example.org']);
    expect(policy.allows('github.com')).toBe(true);
    expect(policy.allows('api.github.com')).toBe(true);
    expect(policy.allows('example.org')).toBe(true);
    expect(policy.allows('example.com')).toBe(false);
    expect(policy.allows('evil.com')).toBe(false);
  });
});

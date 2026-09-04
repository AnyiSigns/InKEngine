/**
 * security.is_sensitive_key / strip_sensitive 测试——驼峰与无下划线后缀覆盖。
 * 对标 ink_engine/tests/test_security.py，逐条同名同义移植；另含本实现
 * PatchChain 分支（base 与补丁 value 剥离，纯函数返回新链）的语义用例。
 *
 * 覆盖：精确集合命中、下划线/无下划线后缀（词尾命中）、驼峰凭据键、大小写
 * 不敏感、业务通用键不误伤（裸 key/monkey/secret_note/token_count 等）、
 * 嵌套递归置空、copy-on-write 零拷贝与纯函数性、集合输入类型不漂移。
 */
import { describe, expect, it } from 'vitest';

import { PatchChain } from '../../../src/core/patch/patchChain.js';
import {
  SENSITIVE_KEYS,
  is_sensitive_key,
  strip_sensitive,
} from '../../../src/core/security/security.js';

// 凭据形态（与 pytest 参数表同集）：精确集合 + 下划线后缀 + 驼峰词尾
const CREDENTIAL_KEYS: readonly string[] = [
  // 精确集合（含驼峰凭据键的小写形态）
  'api_key',
  'clientsecret',
  'openaikey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  // 下划线后缀
  'openai_api_key',
  'client_secret',
  'auth_token',
  'db_password',
  // 无下划线后缀（词尾命中）
  'clientSecret',
  'openAiKey',
  'authToken',
  'accessToken',
  'refreshToken',
  'appKey',
  'privateKey',
  'secretKey',
  'masterToken',
  'userPassword',
  // 大小写不敏感
  'API_KEY',
  'ClientSecret',
  'OPENAIKEY',
];

// 业务通用形态（与 pytest 参数表同集）：不应误伤
const BENIGN_KEYS: readonly string[] = [
  'username',
  'content',
  'title',
  'key', // 裸 key 字段名（中断键/记录主键等业务通用形态）不误伤
  'token_count', // 指标键：_count 词尾不误伤
  'key_insight', // 业务键：_insight 词尾不误伤
  'keywords',
  'keyboard',
  'monkey', // S-1 回归：以 key 结尾的普通英文词不再被词尾启发式误伤
  'turkey',
  'donkey',
  'secret_note', // 业务键：末组件 note 不是凭据词
  'token_count', // 指标键：末组件 count 不是凭据词
];

describe('is_sensitive_key 凭据形态判定', () => {
  it('凭据形态全部命中', () => {
    for (const key of CREDENTIAL_KEYS) {
      expect(is_sensitive_key(key)).toBe(true);
    }
  });

  it('业务通用键不误伤', () => {
    for (const key of BENIGN_KEYS) {
      expect(is_sensitive_key(key)).toBe(false);
    }
  });
});

describe('strip_sensitive 递归剥离', () => {
  it('驼峰凭据键在嵌套结构中同样置空（落库路径回归）', () => {
    const data = {
      clientSecret: 's3cr3t',
      nested: { openAiKey: 'sk-abc', keep: 1 },
      list: [{ authToken: 't' }, { ok: 2 }],
      token_count: 3,
    };
    const out = strip_sensitive(data);
    expect(out.clientSecret).toBe('');
    expect(out.nested.openAiKey).toBe('');
    expect(out.nested.keep).toBe(1);
    expect(out.list[0]!['authToken']).toBe('');
    expect(out.list[1]!['ok']).toBe(2);
    expect(out.token_count).toBe(3);
  });

  it('无敏感键子树零拷贝（热路径）', () => {
    const plain = { url: 'https://example.com', count: 2 };
    expect(strip_sensitive(plain)).toBe(plain);
  });

  it('有敏感键才产生新对象，原对象不变（纯函数）', () => {
    const dirty = { clientSecret: 'x' };
    const out = strip_sensitive(dirty);
    expect(out).not.toBe(dirty);
    expect(out.clientSecret).toBe('');
    expect(dirty.clientSecret).toBe('x');
  });
});

describe('SENSITIVE_KEYS 精确集合', () => {
  it('常见驼峰凭据键的小写形态显式入集合', () => {
    for (const key of ['clientsecret', 'openaikey', 'authtoken']) {
      expect(SENSITIVE_KEYS.has(key)).toBe(true);
    }
  });
});

describe('strip_sensitive 集合类型不漂移', () => {
  it('frozenset 形态输入返回同型集合（ENG6-14 回归语义）', () => {
    const frozen: ReadonlySet<string> = new Set(['a', 'b']);
    const out = strip_sensitive(frozen);
    expect(out).toBe(frozen);
    expect([...out]).toEqual(['a', 'b']);
  });

  it('set 输入返回同型集合且恒等零拷贝', () => {
    const plain = new Set(['a', 'b']);
    const out = strip_sensitive(plain);
    expect(out).toBe(plain);
    expect(out instanceof Set).toBe(true);
    expect([...out]).toEqual(['a', 'b']);
  });
});

describe('strip_sensitive PatchChain 剥离', () => {
  it('base 与补丁 value 递归剥离，返回新链', () => {
    const chain = new PatchChain(
      { session: { api_key: 'sk-live', keep: 1 } },
      [{ op: 'replace', path: ['config', 'client'], value: { client_secret: 's3', keep: 2 } }],
    );
    const out = strip_sensitive(chain);
    expect(out).not.toBe(chain);
    const session = out.base['session'] as unknown as Record<string, unknown>;
    expect(session['api_key']).toBe('');
    expect(session['keep']).toBe(1);
    expect(out.patches[0]!.value).toEqual({ client_secret: '', keep: 2 });
    expect(out.patches[0]!.path).toEqual(['config', 'client']);
  });

  it('纯函数：原链 base 与补丁不被改动', () => {
    const chain = new PatchChain(
      { session: { api_key: 'sk-live', keep: 1 } },
      [{ op: 'replace', path: ['config', 'client'], value: { client_secret: 's3', keep: 2 } }],
    );
    strip_sensitive(chain);
    const session = chain.base['session'] as unknown as Record<string, unknown>;
    expect(session['api_key']).toBe('sk-live');
    expect(session['keep']).toBe(1);
    expect(chain.patches[0]!.value).toEqual({ client_secret: 's3', keep: 2 });
  });
});

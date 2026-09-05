/**
 * exec 授权信封的宿主侧构造与裁决面门。
 *
 * 信封签名 = HMAC-SHA256(会话密钥, body 紧凑文本)；exec 只信任通过签名
 * 复核的同一串 body 字节（不依赖跨语言 canonical JSON）。本模块同时承载
 * **宿主侧裁决面门**：裁决（decision）由引擎审批/权限机制给出后，这里做
 * 「请求是否被裁决覆盖」的一致性复核——越权（命令不在白名单）/越根（路径
 * 不在挂载根内）/未批准一律由宿主拒绝（ExecRefusedError），进程不触达。
 * exec 侧的机械复核（签名 + 根 + 白名单）为第二道防线（fail-closed）。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import type { ExecDecision, ExecEnvelope, ExecOp, SignedEnvelope } from './_types.js';
import { ExecRefusedError } from './_types.js';

/** 信封版本（与 exec crate ENVELOPE_VERSION 对偶）。 */
export const ENVELOPE_VERSION = 1 as const;

/** exec crate 机械上界（host 侧先校验，防把必然被拒的信封送出）。 */
export const EXEC_LIMITS = {
  timeout_secs_min: 1,
  timeout_secs_max: 3600,
  max_chars_min: 64,
  max_chars_max: 1 << 20,
  roots_max: 32,
  list_max: 64,
  argv_max: 128,
  env_entries_max: 64,
} as const;

/** 会话密钥十六进制编码长度（exec client spawn 时生成 32 字节随机值）。 */
export const SESSION_KEY_HEX_LEN = 64;

/** 请求形态（工具名 + 物理 op + 参数；与信封主体一致）。 */
export interface ExecRequest {
  tool: string;
  op: ExecOp;
  args: Record<string, unknown>;
}

/** 宿主侧裁决（引擎审批/权限机制的产出；约束集 = 本次放行的边界）。 */
export interface AdjudicatedDecision extends ExecDecision {
  /** 端点归属名（如 os/file/network；与 op 归属表机械比对在 exec）。 */
  endpoint: string;
  /** 路径根 + 动态挂载根（process/file 必填）。 */
  roots?: string[];
  /** 命令白名单（process 必填；越权 = argv[0] 不在其中）。 */
  allowlist?: string[];
  /** 出网域名白名单（http 必填；`*` = host 显式全放行）。 */
  allow_domains?: string[];
  timeout_secs?: number;
  max_chars?: number;
  cwd?: string | null;
  env?: Record<string, string> | null;
}

/** HMAC-SHA256 十六进制（hex 输入/输出小写）。 */
export function hmacHex(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** 签名校验（常时比较）。 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  if (signature.length !== SESSION_KEY_HEX_LEN) return false;
  const expected = Buffer.from(hmacHex(secret, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** 随机会话密钥（32 字节 hex；spawn 期注入 exec 环境）。 */
export function randomSessionKey(): string {
  return randomBytes(32).toString('hex');
}

/** 路径是否含 `..` 段（词法；与 exec crate has_dotdot 同纪律）。 */
export function pathHasDotdot(target: string): boolean {
  return target.split(/[\\/]/).includes('..');
}

/** 目标是否在某根内（绝对路径前缀判定；exec 侧 canonicalize 为最终防线）。 */
export function isPathWithinRoots(roots: readonly string[], target: string): boolean {
  if (!path.isAbsolute(target)) return false;
  return roots.some((root) => {
    if (!path.isAbsolute(root) || pathHasDotdot(root)) return false;
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/** 域名白名单命中（镜像 exec http_op host_allowed）。 */
export function hostAllowed(patterns: readonly string[], host: string): boolean {
  const normalized = host.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p === '*') return true;
    if (p === normalized) return true;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      return normalized.length > suffix.length && normalized.endsWith(suffix);
    }
    return false;
  });
}

/** URL → host（scheme 校验 + userinfo 拒绝；镜像 exec parse_url_host）。 */
export function parseUrlHost(raw: string): { scheme: string; host: string } {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/.exec(raw.trim());
  if (match === null) throw new ExecRefusedError(`url 非法（缺 scheme://）: ${raw}`);
  const scheme = match[1]?.toLowerCase() ?? '';
  const authority = match[2] ?? '';
  if (scheme !== 'http' && scheme !== 'https') {
    throw new ExecRefusedError(`仅支持 http/https 出网: ${scheme}://`);
  }
  if (authority.includes('@')) {
    throw new ExecRefusedError('url 含用户信息（userinfo）拒绝');
  }
  const host = authority.split(':')[0] ?? '';
  if (host === '') throw new ExecRefusedError(`url host 为空: ${raw}`);
  return { scheme, host: host.toLowerCase() };
}

/** 宿主侧裁决面门复核（不通过抛 ExecRefusedError，进程不触达）。 */
function gateCoverage(input: ExecRequest, decision: AdjudicatedDecision): void {
  if (!decision.approved) {
    throw new ExecRefusedError(`裁决未批准（${decision.by ?? 'unknown'}），host 拒绝下发`);
  }
  if (decision.endpoint === '' || decision.endpoint === undefined) {
    throw new ExecRefusedError('裁决缺端点归属（endpoint）');
  }
  const roots = decision.roots ?? [];
  if (input.op !== 'http' && roots.length === 0) {
    throw new ExecRefusedError(`${input.op} 需要路径根（roots 为空无法保证根内执行）`);
  }
  if (input.op === 'process') {
    const allowlist = decision.allowlist ?? [];
    if (allowlist.length === 0) {
      throw new ExecRefusedError('process 需要命令白名单（裁决未给出放行命令）');
    }
    const argv = input.args['argv'];
    if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
      throw new ExecRefusedError('process argv 缺失或形态非法');
    }
    if (argv.length > EXEC_LIMITS.argv_max) {
      throw new ExecRefusedError(`argv 过长（≤${EXEC_LIMITS.argv_max} 项）`);
    }
    const program = argv[0];
    if (!allowlist.includes(program)) {
      throw new ExecRefusedError(
        `越权拒绝（host 裁决面）：命令 ${program} 不在放行白名单内`,
      );
    }
    const cwd = decision.cwd ?? null;
    if (cwd !== null && cwd !== '' && !isPathWithinRoots(roots, path.resolve(cwd))) {
      throw new ExecRefusedError(`越根拒绝（host 裁决面）：cwd 不在挂载根内: ${cwd}`);
    }
  }
  if (input.op === 'file') {
    const target = input.args['path'];
    if (typeof target !== 'string') {
      throw new ExecRefusedError('file 缺 path（须为绝对路径）');
    }
    if (pathHasDotdot(target)) {
      throw new ExecRefusedError(`越根拒绝（host 裁决面）：路径含 .. 段: ${target}`);
    }
    if (!isPathWithinRoots(roots, path.resolve(target))) {
      throw new ExecRefusedError(`越根拒绝（host 裁决面）：路径不在挂载根内: ${target}`);
    }
  }
  if (input.op === 'http') {
    const allowDomains = decision.allow_domains ?? [];
    if (allowDomains.length === 0) {
      throw new ExecRefusedError('http 需要出网域名白名单（裁决未给出放行域名）');
    }
    const url = input.args['url'];
    if (typeof url !== 'string') {
      throw new ExecRefusedError('http 缺 url');
    }
    const { host } = parseUrlHost(url);
    if (!hostAllowed(allowDomains, host)) {
      throw new ExecRefusedError(`越权拒绝（host 裁决面）：域名不在放行白名单内: ${host}`);
    }
  }
}

/** 组装信封 + 签名（先裁决面门，后签发）。 */
export function buildSignedExecEnvelope(
  input: ExecRequest,
  decision: AdjudicatedDecision,
  sessionKey: string,
  meta: { id?: string; nonce?: string; issued_at?: number } = {},
): SignedEnvelope {
  gateCoverage(input, decision);
  const timeout = decision.timeout_secs ?? 120;
  const maxChars = decision.max_chars ?? 65536;
  if (timeout < EXEC_LIMITS.timeout_secs_min || timeout > EXEC_LIMITS.timeout_secs_max) {
    throw new ExecRefusedError(`timeout_secs 越界（${EXEC_LIMITS.timeout_secs_min}–${EXEC_LIMITS.timeout_secs_max}）`);
  }
  if (maxChars < EXEC_LIMITS.max_chars_min || maxChars > EXEC_LIMITS.max_chars_max) {
    throw new ExecRefusedError(`max_chars 越界（${EXEC_LIMITS.max_chars_min}–${EXEC_LIMITS.max_chars_max}）`);
  }
  const roots = decision.roots ?? [];
  const allowlist = decision.allowlist ?? [];
  const allowDomains = decision.allow_domains ?? [];
  if (roots.length > EXEC_LIMITS.roots_max || allowlist.length > EXEC_LIMITS.list_max || allowDomains.length > EXEC_LIMITS.list_max) {
    throw new ExecRefusedError('roots/allowlist/allow_domains 数量超限');
  }
  const envelope: ExecEnvelope = {
    version: ENVELOPE_VERSION,
    id: meta.id ?? `exec-${Date.now().toString(36)}`,
    tool: input.tool,
    op: input.op,
    args: input.args,
    endpoint: decision.endpoint,
    roots,
    allowlist,
    allow_domains: allowDomains,
    cwd: decision.cwd ?? null,
    env: decision.env ?? null,
    timeout_secs: timeout,
    max_chars: maxChars,
    nonce: meta.nonce ?? Math.random().toString(36).slice(2, 12),
    issued_at: meta.issued_at ?? Date.now(),
    decision: {
      approved: true,
      by: decision.by,
      trace_id: decision.trace_id ?? null,
    },
  };
  const body = JSON.stringify(envelope);
  const signature = hmacHex(sessionKey, body);
  return { body, signature, envelope };
}

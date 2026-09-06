/**
 * cli serve/transport 方法面别名层：扁平旧命令名 ↔ host bridge 点分方法。
 *
 * web 前端适配面仍以旧壳扁平命名发请求（round_send/session_list/...），
 * host bridge 只出点分方法表（rounds.send/sessions.*）；本层把仍可映射的
 * 扁平名对齐到新落点（参数 camel→snake 适配 + 结果形态归一），使 web 真
 * 通道端到端可达。已废弃桌面能力（voice/mount/backup 等）无桥接落点，
 * 不进别名表（命中走 -32601 method not found，web 归一为不可用）。
 *
 * 纪律：别名只做名字/形状翻译，不做语义判断；新增点分方法如需 web 旧面
 * 使用在此补一行（目标缺失 = 跳过，不击穿最小方法面）。
 */

import type { Handler, HandlerContext } from './rpc.js';

interface AliasSpec {
  flat: string;
  dotted: string;
  adaptParams?: (params: unknown) => unknown;
  adaptResult?: (result: unknown) => unknown;
}

function recordFrom(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** camelCase 键映射小表（web 扁平面 → bridge 点分面）。 */
const KEYS: Record<string, string> = {
  threadId: 'thread_id',
  roundId: 'round_id',
  targetLeaf: 'leaf',
  editText: 'input',
};

function camelToSnake(params: unknown): unknown {
  const input = recordFrom(params);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[KEYS[key] ?? key] = value;
  }
  return out;
}

function maybeRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 常用点分方法显式别名（扁平 → 点分；缺目标跳过）。 */
const ALIASES: readonly AliasSpec[] = [
  {
    flat: 'round_send',
    dotted: 'rounds.send',
    adaptParams: (raw) => {
      const p = recordFrom(raw);
      const attachments = Array.isArray(p['attachments']) ? p['attachments'] : undefined;
      return {
        input: typeof p['text'] === 'string' ? p['text'] : (p['input'] ?? ''),
        thread_id: typeof p['threadId'] === 'string' ? p['threadId'] : null,
        round_id: typeof p['roundId'] === 'string' ? p['roundId'] : null,
        ...(attachments !== undefined ? { attachments } : {}),
      };
    },
  },
  {
    flat: 'round_abort',
    dotted: 'rounds.abort',
    adaptParams: () => ({}),
  },
  {
    flat: 'round_resume',
    dotted: 'rounds.resume',
    adaptParams: (raw) => {
      const p = recordFrom(raw);
      return {
        thread_id: p['threadId'] ?? null,
        decision: { key: p['key'] ?? null, decision: p['decision'] ?? null, reason: p['reason'] ?? null },
      };
    },
  },
  {
    flat: 'session_list',
    dotted: 'records.sessions',
    adaptResult: (result) => ({ sessions: Array.isArray(result) ? result : [] }),
  },
  { flat: 'session_create', dotted: 'sessions.create' },
  { flat: 'session_rename', dotted: 'sessions.rename', adaptParams: camelToSnake },
  { flat: 'session_delete', dotted: 'sessions.delete', adaptParams: camelToSnake },
  { flat: 'session_refresh', dotted: 'sessions.refresh', adaptParams: camelToSnake },
  { flat: 'session_tree', dotted: 'sessions.tree', adaptParams: camelToSnake },
  {
    flat: 'session_branch',
    dotted: 'rounds.branch',
    adaptParams: (raw) => {
      const p = recordFrom(raw);
      return {
        thread_id: p['threadId'] ?? null,
        leaf: typeof p['targetLeaf'] === 'number' ? p['targetLeaf'] : null,
        input: typeof p['editText'] === 'string' ? p['editText'] : '',
      };
    },
  },
  { flat: 'tools_snapshot', dotted: 'tools.snapshot' },
  { flat: 'material_import', dotted: 'material.import' },
  { flat: 'search_keys_put', dotted: 'search.keys.set' },
  { flat: 'search_keys_get', dotted: 'search.keys.get' },
  // models 旧扁平面：get/put/reload 直落点分面；models_refresh 语义 = 保存 +
  // 刷新（最小实现即 put，模型清单探测留给 web 协议适配面）
  { flat: 'models_config_get', dotted: 'models.config.get' },
  { flat: 'models_config_put', dotted: 'models.config.put' },
  { flat: 'models_refresh', dotted: 'models.config.put' },
  { flat: 'model.reload', dotted: 'models.config.reload' },
  // capability 旧扁平面（能力记录：get 无参；put 入参 { record: {...} } 解包）
  { flat: 'capability_get', dotted: 'capability.get' },
  {
    flat: 'capability_put',
    dotted: 'capability.put',
    adaptParams: (raw) => {
      const record = maybeRecord(raw);
      if (record !== null && maybeRecord(record['record']) !== null) return record['record'];
      return record ?? {};
    },
  },
  // 策略层路由预览（route_plan → policy.route；入参同形）
  { flat: 'route_plan', dotted: 'policy.route' },
];

/** 把仍可映射的扁平名装入命令面（目标缺失 = 跳过，不击穿最小面）。 */
export function installLegacyAliases(handlers: Map<string, Handler>): void {
  for (const spec of ALIASES) {
    const target = handlers.get(spec.dotted);
    if (target === undefined) continue;
    const alias: Handler = (params: unknown, ctx: HandlerContext) => {
      const adapted = spec.adaptParams !== undefined ? spec.adaptParams(params) : params;
      const outcome = target(adapted, ctx);
      if (spec.adaptResult === undefined) return outcome;
      if (outcome instanceof Promise) {
        return outcome.then((value) => spec.adaptResult?.(value));
      }
      return maybeRecord(outcome) !== null || outcome === undefined
        ? spec.adaptResult(outcome)
        : outcome;
    };
    handlers.set(spec.flat, alias);
  }
}

/** 别名注册表（测试/工具清单可引用；无点分落点 = 不注册）。 */
export function legacyAliasTable(): ReadonlyArray<Pick<AliasSpec, 'flat' | 'dotted'>> {
  return ALIASES.map(({ flat, dotted }) => ({ flat, dotted }));
}

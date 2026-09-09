/**
 * cli serve/transport 方法面别名层：扁平旧命令名 ↔ host bridge 点分方法。
 *
 * web 前端适配面仍以旧壳扁平命名发请求（round_send/session_list/...），
 * host bridge 只出点分方法表（rounds.send/sessions.*）；本层把仍可映射的
 * 扁平名对齐到新落点（参数 camel→snake 适配 + 结果形态归一），使 web 真
 * 通道端到端可达。H2 桥面补桥后：备份/恢复/知识/记忆/成长等域均落
 * 点分方法（round_ledger_merge/mcp_market_preview|add|remove/
 * memory.update_frontmatter 无真源 → 不注册，命中走 -32601）；B5 市场命令面
 * 退役后 mcp.market/mount/unmount 与扁平旧名（mcp_market_status/mount/unmount）
 * 一并移除（web 直调 mcp.status/enable/disable）；H2b 补桥
 * 后架构/演化**读取类**（graph_instance_snapshot/pool_snapshot/pool_evaluate/
 * edge_evidence_list/metrics_snapshot/assemble_stats/cache_stats/
 * path_state/entities_snapshot）落点分只读方法；graph_snapshot/tools_snapshot
 * 无产品消费已删，不注册。path 干预与 edge_downgrade_tier/restore_tier 等
 * 写类不在本批，不注册。
 *
 * 纪律：别名只做名字/形状翻译，不做语义判断；危险操作（recovery.reset /
 * backup.restore）确认标记不回代（缺 confirm 走 fail-closed 拒绝，web 批次
 * 改发标记）；新增点分方法如需 web 旧面使用在此补一行（目标缺失 = 跳过，
 * 不击穿最小方法面）。
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
      const model = maybeRecord(p['model']);
      const modelSel = model !== null && typeof model['model_id'] === 'string'
        ? {
            model_id: model['model_id'],
            ...(typeof model['provider'] === 'string' ? { provider: model['provider'] } : {}),
            ...(typeof model['reasoning_effort'] === 'string' ? { reasoning_effort: model['reasoning_effort'] } : {}),
            ...(typeof model['enable_thinking'] === 'boolean' ? { enable_thinking: model['enable_thinking'] } : {}),
            ...(typeof model['thinking_budget'] === 'number' ? { thinking_budget: model['thinking_budget'] } : {}),
          }
        : undefined;
      return {
        input: typeof p['text'] === 'string' ? p['text'] : (p['input'] ?? ''),
        thread_id: typeof p['threadId'] === 'string' ? p['threadId'] : null,
        round_id: typeof p['roundId'] === 'string' ? p['roundId'] : null,
        ...(attachments !== undefined ? { attachments } : {}),
        ...(modelSel !== undefined ? { model: modelSel } : {}),
        ...(typeof p['pose'] === 'string' ? { pose: p['pose'] } : {}),
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
      const out: Record<string, unknown> = {
        decision: typeof p['decision'] === 'string' ? p['decision'] : null,
      };
      // 裸决议重入：引擎按链尾 interrupt key 自包装（宿主不再手工 key 包装）；
      // edit 决议的编辑内容经 editedContent → edited_content 正确映射
      if (typeof p['reason'] === 'string' && p['reason'] !== '') out['reason'] = p['reason'];
      if (p['editedContent'] !== undefined && p['editedContent'] !== null) {
        out['edited_content'] = p['editedContent'];
      }
      return { thread_id: p['threadId'] ?? null, decision: out };
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
  // H2 桥面：会话消息/链记录/待办/重置/审计窗口/全量工具/基线/档位登记
  {
    flat: 'session_messages',
    dotted: 'sessions.messages',
    adaptParams: camelToSnake,
  },
  { flat: 'round_ledger_chain', dotted: 'records.chain', adaptParams: camelToSnake },
  { flat: 'todo_get', dotted: 'rounds.todos', adaptParams: camelToSnake },
  { flat: 'todo.get', dotted: 'rounds.todos', adaptParams: camelToSnake },
  // recovery 旧扁平面：reset 确认标记不回代（缺 confirm fail-closed 拒绝）
  {
    flat: 'recovery_factory_reset',
    dotted: 'recovery.reset',
    adaptParams: (raw) => {
      const p = recordFrom(raw);
      const out: Record<string, unknown> = {};
      if (typeof p['threadId'] === 'string') out['thread_id'] = p['threadId'];
      return out;
    },
  },
  {
    flat: 'recovery_snapshots',
    dotted: 'recovery.checkpoints',
    adaptParams: camelToSnake,
  },
  {
    flat: 'recovery_restore_snapshot',
    dotted: 'recovery.rollback',
    adaptParams: camelToSnake,
  },
  { flat: 'audit.list', dotted: 'audit.list' },
  { flat: 'tools_manifest', dotted: 'tools.full' },
  { flat: 'tools_baseline_get', dotted: 'capability.baseline.get' },
  { flat: 'tools_baseline_set', dotted: 'capability.baseline.set' },
  {
    flat: 'security_tier_overrides_set',
    dotted: 'capability.tier.set',
    adaptParams: (raw) => {
      const p = recordFrom(raw);
      return {
        tier_overrides:
          p['overrides'] !== undefined && p['overrides'] !== null ? p['overrides'] : p,
      };
    },
  },
  // H2 桥面：备份/恢复/知识/记忆/成长
  { flat: 'backup_export', dotted: 'backup.export' },
  { flat: 'backup_preview', dotted: 'backup.preview' },
  { flat: 'backup_restore', dotted: 'backup.restore' },
  { flat: 'knowledge.list', dotted: 'knowledge.list' },
  { flat: 'knowledge.graph', dotted: 'knowledge.graph' },
  { flat: 'knowledge.export', dotted: 'knowledge.export' },
  { flat: 'memory.list', dotted: 'memory.list' },
  { flat: 'memory.invalidate', dotted: 'memory.invalidate' },
  { flat: 'growth.report', dotted: 'growth.report' },
  // H2b 桥面：架构/演化读取类扁平旧名 → 点分只读方法（无写类落点不注册；
  // tools_snapshot/graph_snapshot 无产品消费已删，不提供）
  { flat: 'graph_instance_snapshot', dotted: 'graph.instance', adaptParams: camelToSnake },
  { flat: 'pool_snapshot', dotted: 'pool.snapshot' },
  { flat: 'pool_evaluate', dotted: 'pool.evaluate' },
  { flat: 'edge_evidence_list', dotted: 'edge_evidence.list' },
  { flat: 'metrics_snapshot', dotted: 'metrics.snapshot' },
  { flat: 'assemble_stats', dotted: 'assemble.stats' },
  { flat: 'cache_stats', dotted: 'cache.stats' },
  { flat: 'path_state', dotted: 'path.state' },
  { flat: 'entities_snapshot', dotted: 'entities.snapshot' },
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

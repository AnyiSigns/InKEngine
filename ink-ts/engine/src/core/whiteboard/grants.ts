/**
 * 受控白板授权（数据面）：作用域↔块类型↔读写三元授权的词表、类型、解析与默认派生。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）。授权是可见性的**唯一裁决源**：
 * 白板只按 grants 放行读写，未授权默认拒绝（fail-closed）。main（作用域 id 'main'）
 * 的「全可见」读特权由 board.ts 的 Whiteboard 在读取侧单独落实，不在此处编码
 * （保持 grants 是「非 main 读者」的显式声明，也让「main 全可见」可被独立测试）。
 *
 * 默认派生 default_whiteboard_grants 把设计稿 §7.2 块模型表的「默认写者/读者」
 * 落成 grant 条目，供 6A3 集成波与 6C convene 波直接装配（main 召集时一次性声明）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import { BLOCK_KINDS, is_whiteboard_block_kind, type WhiteboardBlockKind } from './blocks.js';

/** 访问动作（读 / 写）。 */
export type WhiteboardAccess = 'read' | 'write';

/** 单条授权：作用域对某一块类型具有的访问动作。 */
export interface WhiteboardGrantEntry {
  scope: string;
  kind: WhiteboardBlockKind;
  access: WhiteboardAccess;
}

/** 白板授权集合：召集 mode（blind|open）+ 条目清单。 */
export interface WhiteboardGrants {
  mode: 'blind' | 'open';
  entries: WhiteboardGrantEntry[];
}

/** 模式是否在词表内。 */
function is_mode(value: unknown): value is 'blind' | 'open' {
  return value === 'blind' || value === 'open';
}

/** 访问动作是否在词表内（公开：授权解析与变更解析共用同一词表判定）。 */
export function is_whiteboard_access(value: unknown): value is WhiteboardAccess {
  return value === 'read' || value === 'write';
}

/**
 * 解析授权集合（fail-closed：任何字段非法即抛 GraphDefinitionError）。
 * 期望 dict：{mode:'blind'|'open', entries:[{scope:str, kind:词表, access:'read'|'write'}]}。
 */
export function parse_whiteboard_grants(data: unknown): WhiteboardGrants {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`白板授权非法: 期望 dict，收到 ${typeName(data)}`);
  }
  const mode = data['mode'];
  if (!is_mode(mode)) {
    throw new GraphDefinitionError(`白板授权 mode 非法: ${typeName(mode)}（须为 blind/open）`);
  }
  const entries = data['entries'];
  if (!Array.isArray(entries)) {
    throw new GraphDefinitionError(`白板授权 entries 非法: ${typeName(entries)}（期望 list）`);
  }
  const out: WhiteboardGrantEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!isRecord(e)) {
      throw new GraphDefinitionError(`白板授权 entries[${i}] 非法: ${typeName(e)}（期望 dict）`);
    }
    const scope = e['scope'];
    if (typeof scope !== 'string' || scope === '') {
      throw new GraphDefinitionError(`白板授权 entries[${i}].scope 非法（期望非空 str）`);
    }
    const kind = e['kind'];
    if (!is_whiteboard_block_kind(kind)) {
      throw new GraphDefinitionError(
        `白板授权 entries[${i}].kind 非法: ${typeName(kind)}（须为 ${BLOCK_KINDS.join('/')}）`,
      );
    }
    const access = e['access'];
    if (!is_whiteboard_access(access)) {
      throw new GraphDefinitionError(
        `白板授权 entries[${i}].access 非法: ${typeName(access)}（须为 read/write）`,
      );
    }
    out.push({ scope, kind, access });
  }
  return { mode, entries: out };
}

/** 默认授权的可选参数（前台用户作用域 id，默认 'user'）。 */
export interface DefaultGrantsOptions {
  userScope?: string;
}

/**
 * 按设计稿 §7.2 块模型表派生默认授权（main 召集时一次性声明）。
 *
 * - task：main 写，被召集协作者读；
 * - opinion：协作者写；blind 仅自己可读，open 全体（含自己）可读；main 经「全可见」读；
 * - board：协作者写，全体协作者读（open 圆桌共享空间）；
 * - conclusion：main 写，全体协作者 + 用户读；
 * - summary：main 写，用户读。
 *
 * 注：main 的读特权不在条目中声明（由 board.ts 落实），故此处不写 main 读条目。
 */
export function default_whiteboard_grants(
  mode: 'blind' | 'open',
  collaborators: readonly string[],
  opts: DefaultGrantsOptions = {},
): WhiteboardGrants {
  const userScope = opts.userScope ?? 'user';
  const entries: WhiteboardGrantEntry[] = [];
  const add = (scope: string, kind: WhiteboardBlockKind, access: WhiteboardAccess): void => {
    entries.push({ scope, kind, access });
  };

  // task：main 写，协作者读（广播只读）
  add('main', 'task', 'write');
  for (const c of collaborators) add(c, 'task', 'read');

  // opinion：协作者写；blind 仅作者可读自己（隔离靠 owner-reads-own，不在此授权
  // 跨读），open 全体可读（含自己）
  for (const c of collaborators) add(c, 'opinion', 'write');
  if (mode === 'open') {
    // 每个协作者可读所有协作者（含自己）的意见块
    for (const reader of collaborators) {
      for (const writer of collaborators) add(reader, 'opinion', 'read');
    }
  }

  // board：协作者写，全体协作者读（open 圆桌共享空间）
  for (const c of collaborators) {
    add(c, 'board', 'write');
    add(c, 'board', 'read');
  }

  // conclusion：main 写，全体协作者 + 用户读
  add('main', 'conclusion', 'write');
  for (const c of collaborators) add(c, 'conclusion', 'read');
  add(userScope, 'conclusion', 'read');

  // summary：main 写，用户读
  add('main', 'summary', 'write');
  add(userScope, 'summary', 'read');

  return { mode, entries };
}

// ── 运行中变更（main 仲裁改授权，设计稿 §7.2「运行中变更走 main 仲裁」）──

/** 变更操作词表（增/撤；两值即全部，不扩第三态）。 */
export const GRANT_OPS = ['grant', 'revoke'] as const;

/** 变更操作（由 GRANT_OPS 元组推导，单一事实源）。 */
export type WhiteboardGrantOp = (typeof GRANT_OPS)[number];

/** 变更操作是否在词表内。 */
export function is_grant_op(value: unknown): value is WhiteboardGrantOp {
  return value === 'grant' || value === 'revoke';
}

/** 单条变更：授权三元组（作用域×块类型×读写）+ 操作（增/撤）。 */
export interface WhiteboardGrantChange extends WhiteboardGrantEntry {
  op: WhiteboardGrantOp;
}

/**
 * 授权变更单（main 仲裁改授权的输入）：变更条目清单 + 理由。
 *
 * 撤销语义：revoke 只收窄**后续**视图——作用域对撤权前已读到的内容没有追回
 * 能力（块已在其上下文，无法收回），审计留痕是唯一追溯面。
 */
export interface WhiteboardGrantAmendment {
  changes: WhiteboardGrantChange[];
  reason: string;
}

/** 解析单条变更（fail-closed）。 */
function parse_grant_change(data: unknown, index: number): WhiteboardGrantChange {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`授权变更 changes[${index}] 非法: ${typeName(data)}（期望 dict）`);
  }
  const scope = data['scope'];
  if (typeof scope !== 'string' || scope === '') {
    throw new GraphDefinitionError(`授权变更 changes[${index}].scope 非法（期望非空 str）`);
  }
  const kind = data['kind'];
  if (!is_whiteboard_block_kind(kind)) {
    throw new GraphDefinitionError(
      `授权变更 changes[${index}].kind 非法: ${typeName(kind)}（须为 ${BLOCK_KINDS.join('/')}）`,
    );
  }
  const access = data['access'];
  if (!is_whiteboard_access(access)) {
    throw new GraphDefinitionError(
      `授权变更 changes[${index}].access 非法: ${typeName(access)}（须为 read/write）`,
    );
  }
  const op = data['op'];
  if (!is_grant_op(op)) {
    throw new GraphDefinitionError(
      `授权变更 changes[${index}].op 非法: ${typeName(op)}（须为 ${GRANT_OPS.join('/')}）`,
    );
  }
  return { scope, kind, access, op };
}

/**
 * 解析变更单（fail-closed：非 dict/空清单/非法条目/空理由均抛 GraphDefinitionError）。
 * 期望 dict：{changes:[{scope,kind,access,op:'grant'|'revoke'}], reason:非空 str}。
 */
export function parse_grant_amendment(data: unknown): WhiteboardGrantAmendment {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`授权变更单非法: 期望 dict，收到 ${typeName(data)}`);
  }
  const changes = data['changes'];
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new GraphDefinitionError('授权变更单 changes 非法（期望非空 list）');
  }
  const parsed = changes.map((c, i) => parse_grant_change(c, i));
  const reason = data['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new GraphDefinitionError(`授权变更单 reason 非法: ${typeName(reason)}（期望非空 str）`);
  }
  return { changes: parsed, reason };
}

/** 变更条目与授权条目的同一裁决键（防第二套语义漂移）。 */
function grant_key(e: { scope: string; kind: WhiteboardBlockKind; access: WhiteboardAccess }): string {
  return `${e.scope}|${e.kind}|${e.access}`;
}

/**
 * 应用变更单到授权集（纯函数，返回新集）：grant 幂等去重追加，revoke 移除匹配条目
 * （撤不存在的条目 = 无操作不抛）；mode 保持召集时声明（blind→open 的意见块升级
 * 共享即经 grant 条目落地，不换 mode）。撤销不追回已读内容——本函数只裁决
 * **后续**读写可见性，历史审计不受影响。
 */
export function apply_grant_amendment(
  grants: WhiteboardGrants,
  amendment: WhiteboardGrantAmendment,
): WhiteboardGrants {
  const entries = grants.entries.map((e) => ({ ...e }));
  const keys = new Set(entries.map(grant_key));
  for (const ch of amendment.changes) {
    const k = grant_key(ch);
    if (ch.op === 'grant') {
      if (!keys.has(k)) {
        entries.push({ scope: ch.scope, kind: ch.kind, access: ch.access });
        keys.add(k);
      }
    } else if (keys.delete(k)) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (grant_key(entries[i]!) === k) entries.splice(i, 1);
      }
    }
  }
  return { mode: grants.mode, entries };
}

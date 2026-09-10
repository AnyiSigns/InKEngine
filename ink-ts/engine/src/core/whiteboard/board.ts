/**
 * 受控白板（纯数据面运行时）：按 grants 裁决读写的白板状态机。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）：持有 grants + 已追加块 + 累计审计。
 * 授权是可见性唯一裁决源，默认拒绝（fail-closed）。
 *
 * - 写（append）：未授权写 / owner 与写入者不符 → 显式抛 WhiteboardAccessError；
 *   授权写 → 追加块并产出 1 条 write 审计。
 * - 读（view）：只返回被授权可读块（main 经「全可见」读全部）；每次调用对每个
 *   可见块产出 1 条 read 审计（scope × block × read）。未授权读 = 默认拒绝
 *   （该块不出现在返回集，而非抛错——失败闭合以"缺省不返回"体现）。
 * - 审计（audit）：累计全部读/写审计，供事件带/组织档案接线。
 * - 运行中变更（经 amend.ts 的 amend_grants 门面）：召集时 grants 为缺省声明，
 *   仲裁者（构造声明，缺省 main）改授权后经 commit_amendment 原子替换并产 1 条
 *   amendment 审计（kind='amendment'，action 归 write 语义，含变更清单与理由）。
 * - 序列化（to_dict/from_dict）：版本容忍，未知键忽略（前向兼容）。
 */

import { EngineError } from '../errors.js';
import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import {
  BLOCK_KINDS,
  is_whiteboard_block_kind,
  parse_whiteboard_block,
  whiteboard_block_to_dict,
  type WhiteboardBlock,
  type WhiteboardBlockKind,
} from './blocks.js';
import {
  parse_grant_amendment,
  parse_whiteboard_grants,
  type WhiteboardAccess,
  type WhiteboardGrantAmendment,
  type WhiteboardGrants,
} from './grants.js';

/** 白板数据形态版本（未来字段演进只增键；解析按版本回落当前语义）。 */
export const WHITEBOARD_VERSION = 1;

/** 授权变更审计的特记 kind（审计词汇扩位：不入块类型词表，仅审计面出现）。 */
export const AMENDMENT_AUDIT_KIND = 'amendment' as const;

/** 授权变更审计的保留 block_id（变更对象 = grants 整体，无单块可指）。 */
export const GRANTS_AUDIT_BLOCK_ID = '__grants__';

/** 审计 kind 词汇（块类型 + amendment 特记）。 */
export type WhiteboardAuditKind = WhiteboardBlockKind | typeof AMENDMENT_AUDIT_KIND;

/** 单条审计记录（scope × block × action；action 词汇不扩——amend 归 write 语义）。 */
export interface WhiteboardAuditEntry {
  scope: string;
  block_id: string;
  kind: WhiteboardAuditKind;
  action: WhiteboardAccess;
  /** 授权变更审计特记（kind='amendment' 时必有）：变更清单 + 理由（追溯面）。 */
  amendment?: WhiteboardGrantAmendment;
}

/** 未授权读写等隔离违例（fail-closed 显式拒绝）。 */
export class WhiteboardAccessError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'WhiteboardAccessError';
  }
}

/** main 作用域 id（设计稿 §7.2：主持人，全可见）。 */
export const MAIN_SCOPE = 'main';

/** 解析单条审计记录（fail-closed；kind 允许块类型或 amendment 特记）。 */
function parse_whiteboard_audit(data: unknown): WhiteboardAuditEntry {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`白板审计非法: 期望 dict，收到 ${typeName(data)}`);
  }
  const scope = data['scope'];
  if (typeof scope !== 'string' || scope === '') {
    throw new GraphDefinitionError('白板审计 scope 非法（期望非空 str）');
  }
  const block_id = data['block_id'];
  if (typeof block_id !== 'string' || block_id === '') {
    throw new GraphDefinitionError('白板审计 block_id 非法（期望非空 str）');
  }
  const kind = data['kind'];
  if (kind !== AMENDMENT_AUDIT_KIND && !is_whiteboard_block_kind(kind)) {
    throw new GraphDefinitionError(
      `白板审计 kind 非法: ${typeName(kind)}（须为 ${BLOCK_KINDS.join('/')} 或 amendment）`,
    );
  }
  const action = data['action'];
  if (action !== 'read' && action !== 'write') {
    throw new GraphDefinitionError(`白板审计 action 非法: ${typeName(action)}（须为 read/write）`);
  }
  const entry: WhiteboardAuditEntry = {
    scope,
    block_id,
    kind: kind as WhiteboardAuditKind,
    action,
  };
  const amendment = data['amendment'];
  if (kind === AMENDMENT_AUDIT_KIND) {
    entry.amendment = parse_grant_amendment(amendment); // amendment 审计必带变更单（fail-closed）
  } else if (amendment !== undefined && amendment !== null) {
    throw new GraphDefinitionError('白板审计 amendment 特记仅允许出现在 kind=amendment 的条目');
  }
  return entry;
}

/** 白板构造选项（运行中变更仲裁者的构造声明）。 */
export interface WhiteboardOptions {
  /**
   * 仲裁者作用域（有权运行中变更授权；缺省 = MAIN_SCOPE，即召集时声明的
   * main 仲裁）。非仲裁者经 amend_grants 变更授权被显式拒绝（fail-closed）。
   */
  arbiter?: string;
}

/** 受控白板状态机。 */
export class Whiteboard {
  private grants: WhiteboardGrants;
  private grantSet: Set<string>;
  private readonly blocks: WhiteboardBlock[] = [];
  private readonly auditLog: WhiteboardAuditEntry[] = [];

  /** 授权变更仲裁者（构造声明；缺省 main）。 */
  readonly arbiter: string;

  constructor(grants: WhiteboardGrants, opts: WhiteboardOptions = {}) {
    this.grants = grants;
    this.arbiter =
      typeof opts.arbiter === 'string' && opts.arbiter !== '' ? opts.arbiter : MAIN_SCOPE;
    this.grantSet = new Set(
      grants.entries.map((e) => `${e.scope}|${e.kind}|${e.access}`),
    );
  }

  /**
   * 作用域对某块类型是否可写：main（主持人）全可写，否则须有显式写授权条目。
   */
  private canWrite(scope: string, kind: WhiteboardBlockKind): boolean {
    if (scope === MAIN_SCOPE) return true; // 主持人全可写
    return this.grantSet.has(`${scope}|${kind}|write`);
  }

  /**
   * 作用域对某块是否可读：main 全可见；块作者读自己（私有块隔离）；否则须有
   * 显式读授权条目。盲模式下意见块的互不可见即由「作者读自己 + 无跨读授权」落实。
   */
  private canRead(scope: string, block: WhiteboardBlock): boolean {
    if (scope === MAIN_SCOPE) return true; // 全可见
    if (scope === block.owner) return true; // 作者读自己（私有块）
    return this.grantSet.has(`${scope}|${block.kind}|read`);
  }

  /**
   * 追加块（写入）。未授权写 / owner 与写入者不符 → 显式抛 WhiteboardAccessError；
   * 授权 → 追加并产出 1 条 write 审计返回。
   */
  append(block: WhiteboardBlock, writer_scope: string): WhiteboardAuditEntry[] {
    if (block.owner !== writer_scope) {
      throw new WhiteboardAccessError(
        `块 ${block.id} 的 owner(${block.owner}) 与写入者(${writer_scope}) 不符`,
      );
    }
    if (!this.canWrite(writer_scope, block.kind)) {
      throw new WhiteboardAccessError(`作用域 ${writer_scope} 无权写入 ${block.kind} 块`);
    }
    this.blocks.push(block);
    const entry: WhiteboardAuditEntry = {
      scope: writer_scope,
      block_id: block.id,
      kind: block.kind,
      action: 'write',
    };
    this.auditLog.push(entry);
    return [entry];
  }

  /**
   * 读取被授权可读块（main 经「全可见」读全部）。每次调用对每个可见块产出 1 条
   * read 审计；未授权块默认拒绝（不出现在返回集）。
   */
  view(reader_scope: string): WhiteboardBlock[] {
    const out: WhiteboardBlock[] = [];
    for (const b of this.blocks) {
      if (this.canRead(reader_scope, b)) {
        out.push(b);
        this.auditLog.push({
          scope: reader_scope,
          block_id: b.id,
          kind: b.kind,
          action: 'read',
        });
      }
    }
    return out;
  }

  /** 累计全部读/写/授权变更审计。 */
  audit(): WhiteboardAuditEntry[] {
    return [...this.auditLog];
  }

  /** 当前授权集快照（深拷贝；运行中变更的仲裁者校验面，供 amend_grants 取现态）。 */
  current_grants(): WhiteboardGrants {
    return {
      mode: this.grants.mode,
      entries: this.grants.entries.map((e) => ({ ...e })),
    };
  }

  /**
   * 提交仲裁后的新授权集（原子替换 + 1 条 amendment 审计）。仅供 amend_grants
   * 门面调用——仲裁者身份判定（caller === this.arbiter）在门面完成后才到这里；
   * 直接调用 = 绕过 fail-closed 判定，宿主代码不得绕过门面。
   */
  commit_amendment(
    new_grants: WhiteboardGrants,
    amendment: WhiteboardGrantAmendment,
  ): WhiteboardAuditEntry {
    this.grants = new_grants;
    this.grantSet = new Set(
      new_grants.entries.map((e) => `${e.scope}|${e.kind}|${e.access}`),
    );
    const entry: WhiteboardAuditEntry = {
      scope: this.arbiter,
      block_id: GRANTS_AUDIT_BLOCK_ID,
      kind: AMENDMENT_AUDIT_KIND,
      action: 'write', // 授权变更归 write 语义（action 词汇不扩；kind 特记 amendment）
      amendment: {
        changes: amendment.changes.map((c) => ({ ...c })),
        reason: amendment.reason,
      },
    };
    this.auditLog.push(entry);
    return entry;
  }

  /** 序列化为数据形态（只含 JSON 数据；版本键在首位；arbiter 仅非缺省才落键，零漂移）。 */
  to_dict(): Record<string, unknown> {
    return {
      version: WHITEBOARD_VERSION,
      ...(this.arbiter === MAIN_SCOPE ? {} : { arbiter: this.arbiter }),
      grants: {
        mode: this.grants.mode,
        entries: this.grants.entries.map((e) => ({ ...e })),
      },
      blocks: this.blocks.map(whiteboard_block_to_dict),
      audit: this.auditLog.map((e) => ({ ...e })),
    };
  }

  /**
   * 反序列化（版本容忍：未知键忽略、缺省键回落空）。grants 非法 → 抛
   * GraphDefinitionError；blocks/audit 条目非法 → 抛 GraphDefinitionError。
   */
  static from_dict(data: unknown): Whiteboard {
    if (!isRecord(data)) {
      throw new GraphDefinitionError(`白板非法: 期望 dict，收到 ${typeName(data)}`);
    }
    const grants = parse_whiteboard_grants(data['grants']);
    const rawArbiter = data['arbiter'];
    const wb = new Whiteboard(grants, {
      arbiter: typeof rawArbiter === 'string' && rawArbiter !== '' ? rawArbiter : undefined,
    });

    const rawBlocks = data['blocks'];
    if (rawBlocks !== undefined && rawBlocks !== null && !Array.isArray(rawBlocks)) {
      throw new GraphDefinitionError('白板 blocks 非法（期望 list）');
    }
    for (const rb of (rawBlocks as unknown[] | undefined) ?? []) {
      wb.blocks.push(parse_whiteboard_block(rb));
    }

    const rawAudit = data['audit'];
    if (rawAudit !== undefined && rawAudit !== null && !Array.isArray(rawAudit)) {
      throw new GraphDefinitionError('白板 audit 非法（期望 list）');
    }
    for (const ra of (rawAudit as unknown[] | undefined) ?? []) {
      wb.auditLog.push(parse_whiteboard_audit(ra));
    }
    return wb;
  }
}

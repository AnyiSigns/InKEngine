/**
 * convene 白板装配辅助（召集 ↔ 受控白板的接线面）。
 *
 * 职责边界：convene.ts 只做召集编排（spawn/归并/裁决 turn），本模块承载全部
 * 白板数据面细务——授权名册派生、席位身份、块代写（宿主代子执行写意见块）、
 * whiteboard_audit 事件透出、协作方 produces 契约解析、意见条目投影。
 *
 * 身份模型（可见性唯一裁决源 = Whiteboard grants，fail-closed）：
 * - 白板名册（board_roster）= 意见块写入者席位身份全集，召集时一次性声明：
 *   目录作用域席位 = `<id>#<i>`；临时作用域席位 = temp_scope:<run_id>:0
 *   （convene 提供根 run_id ⇒ 运行时入口装载期计数为 0，id 确定可预授；
 *   每轮每席独立身份，名册覆盖全部轮次×席位）；
 * - 子执行下发快照用**单席位最小名册**（view_scope_of = 子执行实际装载的
 *   作用域 id）：grants 按 (scope, kind) 判定可见性，单席位名册与全名册的
 *   可见性结果等价（blind 只见任务块、open 见全部意见块），且避免轮次×席位
 *   授权条目随快照放大；
 * - main 全可见/全可写为 board 内建特权，main 裁决 turn 的下发名册留空。
 *
 * 纯编排辅助（零 IO）：审计经调用方注入的 onEvent sink 透出（W6A3 既有
 * whiteboard_audit 事件通道），不在本模块自建第二套通道。
 */

import {
  USER_SCOPE,
  Whiteboard,
  default_whiteboard_grants,
  parse_temp_scope_def,
  temp_scope_id,
} from '@ink-ts/engine';
import type {
  OpinionEntry,
  RunEvent,
  ScopeIoContract,
  WhiteboardAuditEntry,
  WhiteboardBlock,
  WhiteboardGrants,
  WhiteboardSession,
} from '@ink-ts/engine';

import type { ConveneTarget } from './convene_params.js';
import { summarize_temp_def } from './convene_params.js';
import type { HostExecutionService } from './service.js';

/** convene 审计事件 sink（与子执行共享的既有事件带通道；缺省 = 不透出）。 */
export type ConveneAuditSink = ((event: RunEvent) => void) | undefined;

// ── 临时协作 sighting 观测（结晶证据流：临时作用域用完即散，观测行留存）──

/**
 * 临时协作观测集合（org.archive 同风格兄弟关注点：storage 结构化记录普通通道，
 * 非演化资产；幂等键 = run_id#seat，重跑覆盖不累加。引擎结晶评估器经
 * evidence.source='temp_sightings' 对齐本集合语义）。
 */
export const TEMP_SIGHTINGS_COLLECTION = 'org.temp_sightings';

/** sighting 存储通道注入面（boot 装配构造；append 失败由调用侧留痕不阻断）。 */
export type TempSightingSink = ((record: Record<string, unknown>) => Promise<void>) | null;

/** convene 装配注入位（sighting sink 由 boot 经 collab 执行体下发；convene 只编排不摸存储）。 */
export interface ConveneInit {
  sightingSink?: TempSightingSink;
  /** sighting 时间戳源（缺省 = Date.now）。 */
  clock?: (() => number) | null;
}

/**
 * 组一条临时协作观测（仅 temp 目标；记录 = role/def 摘要/persona·model/outcome/
 * run_id/seat/times/ts——幂等键 run_id#seat 由 sink 侧组装）。非临时目标或
 * 定义缺失 = null（不产观测行）。
 */
export function make_temp_sighting(
  target: ConveneTarget,
  runId: string,
  seat: number,
  outcome: string,
  ts: number,
): Record<string, unknown> | null {
  if (target.source !== 'temp' || target.temp_def === null) return null;
  const def = summarize_temp_def(target.temp_def);
  if (typeof def['role'] !== 'string' || def['role'] === '') return null;
  return {
    role: def['role'],
    def,
    outcome,
    run_id: runId,
    seat,
    times: 1,
    ts,
  };
}

/**
 * 追加一条观测（best-effort：写入失败不阻断协作回执，但必须经既有事件通道
 * 落 whiteboard_audit 同款留痕——失败可见，证据缺失不能静默）。
 */
export async function record_temp_sighting(
  sink: TempSightingSink | undefined,
  record: Record<string, unknown> | null,
  onEvent: ConveneAuditSink,
  parentRunId: string,
): Promise<void> {
  if (sink === undefined || sink === null || record === null) return;
  try {
    await sink({ ...record });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onEvent?.({
      run_id: String(record['run_id'] ?? ''),
      parent_run_id: parentRunId,
      scope: `temp_sightings:${String(record['role'] ?? '')}`,
      action: 'whiteboard_audit',
      detail: {
        scope: `temp_sightings:${String(record['role'] ?? '')}`,
        block_id: null,
        kind: 'temp_sighting',
        action: 'append_failed',
        error: message,
      },
    });
  }
}

/**
 * 白板名册（召集授权声明的 collaborators）= 意见块写入者席位身份全集。
 * 临时席位按「全部轮次×席位」预派生（run_id 命名与 convene 生成规则一致）。
 */
export function board_roster(target: ConveneTarget, n: number, rounds: number, seq: number): string[] {
  if (target.source === 'temp') {
    const roster: string[] = [];
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n; i++) roster.push(temp_scope_id(`collab:${seq}:${r * n + i + 1}`, 0));
    }
    return roster;
  }
  const scopeId = target.scope_id as string;
  return Array.from({ length: n }, (_, i) => `${scopeId}#${i + 1}`);
}

/** 意见块代写身份（= 该路子执行的席位 id；Whiteboard 要求 owner 与写入者一致）。 */
export function seat_owner(target: ConveneTarget, runId: string, seat: number): string {
  return target.source === 'temp' ? temp_scope_id(runId, 0) : `${target.scope_id as string}#${seat + 1}`;
}

/** 子执行视图作用域（run_one 按 scope.id 取授权视图：目录 id / 本路临时 id）。 */
export function view_scope_of(target: ConveneTarget, runId: string): string {
  return target.source === 'temp' ? temp_scope_id(runId, 0) : target.scope_id as string;
}

/** 协作方 produces 契约（意见块 schema 门禁回退源；无契约 = 不校验）。 */
export function scope_contract(service: HostExecutionService, target: ConveneTarget): ScopeIoContract | null {
  if (target.source === 'directory') {
    return service.loadScope(target.scope_id as string)?.scope?.contract ?? null;
  }
  return (parse_temp_scope_def(target.temp_def).contract as ScopeIoContract | undefined) ?? null;
}

/** 单路意见文本投影（意见块 content / conclusion 前台可见面：契约字段优先，回落 JSON）。 */
export function opinion_text(payload: Record<string, unknown>): string {
  for (const key of ['opinion', 'conclusion', 'reply', 'message', 'answer', 'plan']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const rendered = JSON.stringify(payload);
  return rendered === '{}' ? '' : rendered;
}

/** 子执行产物 → 意见条目（content 投影 + 显式 verdict/stance 信号透传裁决面）。 */
export function opinion_entry_of(payload: Record<string, unknown>, owner: string, seq: number): OpinionEntry {
  const entry: OpinionEntry = { owner, content: opinion_text(payload), seq };
  for (const key of ['verdict', 'stance'] as const) {
    const value = payload[key];
    if (typeof value === 'string' && value !== '') entry[key] = value;
  }
  return entry;
}

/**
 * 召集侧白板写入面（受控白板实例 + 块代写 + 审计透出）。
 * put 追加一块并对其 write 审计逐条发 whiteboard_audit 事件（runId/parent =
 * 事件带归属：convene 命名空间 run 或产物所属的子执行 run）。
 */
export class ConveneBoard {
  private readonly board: Whiteboard;
  private readonly onEvent: ConveneAuditSink;
  private seq = 0;

  constructor(grants: WhiteboardGrants, onEvent: ConveneAuditSink) {
    this.board = new Whiteboard(grants);
    this.onEvent = onEvent;
  }

  /** 追加块（owner = 写入者，fail-closed 授权校验在 Whiteboard 内）并透出审计。 */
  put(kind: WhiteboardBlock['kind'], owner: string, content: string, runId: string, parent: string | null): number {
    this.seq += 1;
    const block: WhiteboardBlock = { id: `wb-${this.seq}`, kind, owner, content, seq: this.seq };
    const entries: WhiteboardAuditEntry[] = this.board.append(block, owner);
    for (const entry of entries) {
      this.onEvent?.({
        run_id: runId,
        parent_run_id: parent,
        scope: entry.scope,
        action: 'whiteboard_audit',
        detail: { scope: entry.scope, block_id: entry.block_id, kind: entry.kind, action: entry.action },
      });
    }
    return this.seq;
  }

  /** 当前块集快照（下发给子执行/main turn 的 whiteboard.blocks；深拷贝零共享）。 */
  blocks(): WhiteboardBlock[] {
    return this.board.to_dict()['blocks'] as WhiteboardBlock[];
  }

  /** 子执行下发快照（单席位最小名册；blocks = 调用时刻的当前态）。 */
  childSession(target: ConveneTarget, runId: string, mode: 'blind' | 'open'): WhiteboardSession {
    return {
      grants: default_whiteboard_grants(mode, [view_scope_of(target, runId)], { userScope: USER_SCOPE }),
      blocks: this.blocks(),
    };
  }

  /** main 裁决 turn 下发快照（main 全可见为内建特权，名册留空）。 */
  mainSession(mode: 'blind' | 'open'): WhiteboardSession {
    return {
      grants: default_whiteboard_grants(mode, [], { userScope: USER_SCOPE }),
      blocks: this.blocks(),
    };
  }
}

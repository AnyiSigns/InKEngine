/**
 * 白板授权运行中变更（main 仲裁，设计稿 §7.2「授权：召集时由 main 一次性声明
 * 随召集下发；运行中变更走 main 仲裁」）。
 *
 * 语义分层：召集时 `default_whiteboard_grants` 声明为**缺省**；运行中经本门面
 * amend_grants 增/撤授权条目生效。盲态意见块升级为共享（blind→open 式圆桌）
 * 也走本门面（grant 全体互读条目；open 模式召集即缺省共享，无需变更）。
 *
 * fail-closed：
 * - 只有仲裁者（Whiteboard 构造声明，缺省 main）可提交变更——非仲裁者调用
 *   显式抛 WhiteboardAccessError，授权与审计零变化；
 * - 变更单结构非法（空清单/词表外字段/缺理由）显式抛 GraphDefinitionError，
 *   即使从类型化豁口穿入（门面内部再解析一次，宿主透传不可信 JSON 不旁路）。
 *
 * 撤销语义：revoke 只收窄**后续**视图——作用域对撤权前已读到的内容没有追回
 * 能力（块已进入其上下文，无法收回），审计留痕（scope=仲裁者 × kind=amendment
 * × 变更清单 × 理由）是唯一追溯面。
 *
 * 纯数据面（零 IO、零宿主词）：变更即原子替换 grants 并产 1 条 amendment 审计。
 */

import { WhiteboardAccessError } from './board.js';
import type { Whiteboard, WhiteboardAuditEntry } from './board.js';
import {
  apply_grant_amendment,
  parse_grant_amendment,
  type WhiteboardGrantAmendment,
} from './grants.js';

/**
 * 提交授权变更（唯一公共变更入口；仲裁者判定 → 解析校验 → 原子生效 → 审计）。
 *
 * @param board 目标白板（持有当前 grants；变更后其 view/append 即时按新授权裁决）
 * @param amendment 变更单：{changes:[{scope,kind,access,op:'grant'|'revoke'}], reason}
 * @param arbiter_scope 调用方声明的作用域——必须等于板构造声明的仲裁者
 *   （缺省 main），否则显式抛 WhiteboardAccessError（fail-closed）。
 * @returns 本次变更产生的 1 条 amendment 审计（scope=仲裁者，kind='amendment'，
 *   action='write'，含变更清单与理由）。
 *
 * 撤销不追回已读：已下发给作用域的块内容不可收回，仅后续 view/append 收窄。
 */
export function amend_grants(
  board: Whiteboard,
  amendment: WhiteboardGrantAmendment,
  arbiter_scope: string,
): WhiteboardAuditEntry {
  if (arbiter_scope !== board.arbiter) {
    throw new WhiteboardAccessError(
      `授权变更须由仲裁者（${board.arbiter}）执行，作用域 ${arbiter_scope} 无仲裁权`,
    );
  }
  const parsed = parse_grant_amendment(amendment); // 类型化豁口防线（结构再校验）
  const next = apply_grant_amendment(board.current_grants(), parsed);
  return board.commit_amendment(next, parsed);
}

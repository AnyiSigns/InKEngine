/**
 * 白板授权的运行中变更执行接线（`__amend` 结构化产物，`__next` 同款风格）。
 *
 * 子执行/模型可在产物保留键 `__amend` 声明「请求改授权」：
 * `__amend: {kind:'amend', changes:[{scope,kind,access,op:'grant'|'revoke'}], reason:str}`。
 * 宿主/运行时（本模块）**校验请求来自 main 作用域（复用仲裁者判定）才生效**：
 * 经 whiteboard/amend_grants 门面提交——非仲裁者作用域的声明不生效且显式判
 * 失败（fail-closed；复用门面的仲裁者判定，不另造第二套权限判断）。本层不实现
 * UI/工具面（宿主展示留后续波次）。
 *
 * 处理结果三态：none = 无声明（含无白板会话——无物可改，键被消费）；
 * applied = 已生效（返回 amendment 审计条目，交 run_loop 走既有审计通道）；
 * rejected = 非仲裁者声明或结构非法（附拒绝理由，run fail-closed 判失败）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import {
  WhiteboardAccessError,
  amend_grants,
  parse_grant_amendment,
} from '../whiteboard/index.js';
import type { Whiteboard, WhiteboardAuditEntry, WhiteboardGrantAmendment } from '../whiteboard/index.js';

/** 产物保留键：运行中改授权声明（`__next` 同款结构化产物面）。 */
export const PAYLOAD_AMEND_KEY = '__amend';

/** `__amend` 声明的 kind 判别值（与 `__next` 声明同款判别字段）。 */
export const AMENDMENT_DECL_KIND = 'amend' as const;

/** 校验 `__amend` 声明 dict（kind 判别 'amend' + 变更单字段；非法显式抛错）。 */
export function parse_amend_decl(raw: unknown): WhiteboardGrantAmendment {
  if (!isRecord(raw)) {
    throw new GraphDefinitionError(`__amend 授权变更声明非法: 期望 dict，收到 ${typeName(raw)}`);
  }
  const kind = raw['kind'];
  if (kind !== AMENDMENT_DECL_KIND) {
    throw new GraphDefinitionError(
      `__amend 授权变更声明 kind 非法: ${typeName(kind)}（须为 '${AMENDMENT_DECL_KIND}'）`,
    );
  }
  return parse_grant_amendment({ changes: raw['changes'], reason: raw['reason'] });
}

/** `__amend` 声明处理结果（三态；run_loop 据此走审计或失败闭合）。 */
export type AmendOutcome =
  | { status: 'none' }
  | { status: 'applied'; entry: WhiteboardAuditEntry }
  | { status: 'rejected'; reason: string };

/**
 * 处理本轮产物中的 `__amend` 声明（不改 produced；消费由调用方删除键完成）。
 *
 * 仲裁者判定复用 whiteboard 门面（board.arbiter + amend_grants），本层只看
 * 当前作用域 id：非仲裁者声明 → rejected（fail-closed，授权零变化）。
 */
export function process_grant_amend(
  whiteboard: Whiteboard | undefined,
  scope_id: string,
  produced: Record<string, unknown>,
): AmendOutcome {
  const raw = produced[PAYLOAD_AMEND_KEY];
  if (raw === undefined || raw === null) return { status: 'none' };
  if (whiteboard === undefined) return { status: 'none' }; // 无白板 = 无授权可改（键被消费）
  let amendment: WhiteboardGrantAmendment;
  try {
    amendment = parse_amend_decl(raw);
  } catch (err) {
    if (err instanceof GraphDefinitionError) return { status: 'rejected', reason: err.message };
    throw err;
  }
  try {
    const entry = amend_grants(whiteboard, amendment, scope_id);
    return { status: 'applied', entry };
  } catch (err) {
    if (err instanceof WhiteboardAccessError) return { status: 'rejected', reason: err.message };
    if (err instanceof GraphDefinitionError) return { status: 'rejected', reason: err.message };
    throw err;
  }
}

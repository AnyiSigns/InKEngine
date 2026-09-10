/**
 * 受控白板数据面子模块公共面（纯 re-export，不实现）。
 *
 * 分组：
 * - 块模型（BLOCK_KINDS / WhiteboardBlock / parse_whiteboard_block / 序列化）；
 * - 授权（WhiteboardGrants / WhiteboardGrantEntry / parse_whiteboard_grants /
 *   default_whiteboard_grants）；
 * - 运行中变更/仲裁（amend_grants / 变更单解析与纯应用）；
 * - 白板状态机（Whiteboard / WhiteboardAuditEntry / WhiteboardAccessError）。
 */

export {
  BLOCK_KINDS,
  is_whiteboard_block_kind,
  parse_whiteboard_block,
  whiteboard_block_to_dict,
} from './blocks.js';
export type { WhiteboardBlock, WhiteboardBlockKind } from './blocks.js';

export {
  GRANT_OPS,
  apply_grant_amendment,
  default_whiteboard_grants,
  is_grant_op,
  is_whiteboard_access,
  parse_grant_amendment,
  parse_whiteboard_grants,
} from './grants.js';
export type {
  DefaultGrantsOptions,
  WhiteboardAccess,
  WhiteboardGrantAmendment,
  WhiteboardGrantChange,
  WhiteboardGrantEntry,
  WhiteboardGrantOp,
  WhiteboardGrants,
} from './grants.js';

export { amend_grants } from './amend.js';

export {
  AMENDMENT_AUDIT_KIND,
  GRANTS_AUDIT_BLOCK_ID,
  MAIN_SCOPE,
  WHITEBOARD_VERSION,
  Whiteboard,
  WhiteboardAccessError,
} from './board.js';
export type {
  WhiteboardAuditEntry,
  WhiteboardAuditKind,
  WhiteboardOptions,
} from './board.js';

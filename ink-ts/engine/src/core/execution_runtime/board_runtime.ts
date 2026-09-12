/**
 * 圆桌共享板面的运行中写路径（`__board` 结构化产物，`__amend`/`__next` 同款风格）。
 *
 * §7.2 board 块（圆桌共享空间）此前只有宿主代写意见块，协作者在 turn 中无法写
 * 共享板面——本模块补齐模型/子执行侧的写路径：产物保留键 `__board` 声明
 * `{kind:'board', op:'append', content:str}`，run_loop 校验写授权后追加 board
 * 块（owner=声明作用域），审计走 whiteboard_audit 既有通道（追加本身产 1 条
 * write 审计，生效分支由 run_loop 显式转发一次，不与 top-of-loop 差量重复）。
 *
 * 写授权（fail-closed，双层）：
 * - 前置判定：main（主持人，board.ts 同口径全可写）或 **open 模式**（圆桌共享
 *   空间的召集模式声明）或召集 grants **显式授 board write**；blind 且无显式
 *   条目 = 显式拒绝（附盲模式理由），授权与板面零变化；
 * - 最终裁决：仍经 Whiteboard.append（canWrite 按 grantSet 判定）——模式判定
 *   不绕过授权条目（open 模式召集缺省 grants 已含协作者 board write，故两判
 *   一致；非协作者作用域在 open 模式无条目时由 append 层兜底拒绝）。
 *
 * 块序：seq = 当前累计审计条数 + 1（单调递增的插入计数器，恢复后延续；read/
 * write/amendment 全审计参与计数，seq 只作排序键不要求连续）；id =
 * `board-<seq>`（单板内唯一）。处理结果三态：none = 无声明（键被消费）；
 * applied = 已生效（返回 write 审计条目）；rejected = 无授权/结构非法
 * （附拒绝理由，run fail-closed 判失败）。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';
import { MAIN_SCOPE, WhiteboardAccessError } from '../whiteboard/index.js';
import type { Whiteboard, WhiteboardAuditEntry, WhiteboardBlock } from '../whiteboard/index.js';

/** 产物保留键：运行中写共享板面声明（`__amend`/`__next` 同款结构化产物面）。 */
export const PAYLOAD_BOARD_KEY = '__board';

/** `__board` 声明的 kind 判别值（与 `__amend` 声明同款判别字段）。 */
export const BOARD_DECL_KIND = 'board' as const;

/** `__board` 声明解析结果（当前唯一操作 = 追加文本块；后续操作扩 op 词表）。 */
export interface BoardWriteDecl {
  op: 'append';
  content: string;
}

/** 校验 `__board` 声明 dict（kind 判别 'board' + op 'append' + 非空 content；
 *  非法显式抛错）。 */
export function parse_board_decl(raw: unknown): BoardWriteDecl {
  if (!isRecord(raw)) {
    throw new GraphDefinitionError(`__board 写板声明非法: 期望 dict，收到 ${typeName(raw)}`);
  }
  const kind = raw['kind'];
  if (kind !== BOARD_DECL_KIND) {
    throw new GraphDefinitionError(
      `__board 写板声明 kind 非法: ${typeName(kind)}（须为 '${BOARD_DECL_KIND}'）`,
    );
  }
  const op = raw['op'];
  if (op !== 'append') {
    throw new GraphDefinitionError(`__board 写板声明 op 非法: ${typeName(op)}（须为 'append'）`);
  }
  const content = raw['content'];
  if (typeof content !== 'string' || content.trim() === '') {
    throw new GraphDefinitionError(
      `__board 写板声明 content 非法: ${typeName(content)}（期望非空 str）`,
    );
  }
  return { op: 'append', content };
}

/** `__board` 声明处理结果（三态；run_loop 据此走审计或失败闭合）。 */
export type BoardWriteOutcome =
  | { status: 'none' }
  | { status: 'applied'; entry: WhiteboardAuditEntry }
  | { status: 'rejected'; reason: string };

/**
 * 写授权前置判定：main（主持人全可写）或 open 模式（圆桌共享空间的召集语义）
 * 或 grants 显式授 board write（blind 模式下的显式开放）。返回 false = 盲模式
 * 且无显式条目（fail-closed 显式拒绝，不落入 append 层）。
 */
function board_write_authorized(whiteboard: Whiteboard, scope_id: string): boolean {
  if (scope_id === MAIN_SCOPE) return true;
  const grants = whiteboard.current_grants();
  if (grants.mode === 'open') return true;
  return grants.entries.some(
    (e) => e.scope === scope_id && e.kind === 'board' && e.access === 'write',
  );
}

/**
 * 处理本轮产物中的 `__board` 声明（不改 produced；消费由调用方删除键完成）。
 *
 * 授权判定 + Whiteboard.append 双层 fail-closed；生效返回 1 条 write 审计
 * （run_loop 经既有 whiteboard_audit 事件通道带出，与 `__amend` 生效同构）。
 */
export function process_board_write(
  whiteboard: Whiteboard | undefined,
  scope_id: string,
  produced: Record<string, unknown>,
): BoardWriteOutcome {
  const raw = produced[PAYLOAD_BOARD_KEY];
  if (raw === undefined || raw === null) return { status: 'none' };
  if (whiteboard === undefined) return { status: 'none' }; // 无白板会话 = 无板可写（键被消费）
  let decl: BoardWriteDecl;
  try {
    decl = parse_board_decl(raw);
  } catch (err) {
    if (err instanceof GraphDefinitionError) return { status: 'rejected', reason: err.message };
    throw err;
  }
  if (!board_write_authorized(whiteboard, scope_id)) {
    return {
      status: 'rejected',
      reason: `作用域 ${scope_id} 无 board 写授权（盲模式且召集 grants 未显式授 board write，fail-closed）`,
    };
  }
  const seq = whiteboard.audit().length + 1;
  const block: WhiteboardBlock = {
    id: `board-${seq}`,
    kind: 'board',
    owner: scope_id,
    content: decl.content,
    seq,
  };
  try {
    const entries = whiteboard.append(block, scope_id);
    return { status: 'applied', entry: entries[0]! };
  } catch (err) {
    if (err instanceof WhiteboardAccessError) return { status: 'rejected', reason: err.message };
    throw err;
  }
}

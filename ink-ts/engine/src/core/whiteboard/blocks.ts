/**
 * 受控白板块模型（数据面）：五类块的词表、类型与解析/序列化辅助。
 *
 * 纯数据面（JSON 进 JSON 出、零 IO、零宿主词）：只定义块的最小数据形态与
 * 词汇表常量，不含任何授权/可见性语义（那部分在 grants.ts / board.ts）。
 *
 * 块类型语义（设计稿 agent_execution_design.md §7.2 块模型表，镜像）：
 * - task：任务块，main 写、被召集协作者读（召集时广播，只读）；
 * - opinion：意见块，各协作者写，blind 仅自己+main 读、open 全体可读；
 * - board：白板块，协作者写、全体+main 读（open 圆桌共享空间）；
 * - conclusion：结论块，main 写、全体+用户读（归并/裁决产物）；
 * - summary：摘要块，main 写、用户读（子执行降级/失败的可见摘要）。
 *
 * 词表单一真源：WhiteboardBlockKind 由 BLOCK_KINDS 元组推导，禁止另立第二套枚举。
 */

import { GraphDefinitionError } from '../errors.js';
import { isRecord, typeName } from '../json.js';

/** 白板块类型词表（五类；顺序即设计稿 §7.2 表序）。 */
export const BLOCK_KINDS = ['task', 'opinion', 'board', 'conclusion', 'summary'] as const;

/** 白板块类型（由 BLOCK_KINDS 元组推导，单一事实源）。 */
export type WhiteboardBlockKind = (typeof BLOCK_KINDS)[number];

/** 单块数据形态（不可变记录；owner = 写入者作用域 id）。 */
export interface WhiteboardBlock {
  id: string;
  kind: WhiteboardBlockKind;
  owner: string;
  content: string;
  seq: number;
}

/** 块类型是否在词表内（类型守卫）。 */
export function is_whiteboard_block_kind(value: unknown): value is WhiteboardBlockKind {
  return typeof value === 'string' && (BLOCK_KINDS as readonly string[]).includes(value);
}

/**
 * 解析单块（fail-closed：任何字段非法即抛 GraphDefinitionError）。
 * 期望 dict：{id:str, kind:词表, owner:str, content:str, seq:number}。
 */
export function parse_whiteboard_block(data: unknown): WhiteboardBlock {
  if (!isRecord(data)) {
    throw new GraphDefinitionError(`白板块非法: 期望 dict，收到 ${typeName(data)}`);
  }
  const id = data['id'];
  if (typeof id !== 'string' || id === '') {
    throw new GraphDefinitionError('白板块缺 id（期望非空 str）');
  }
  const kind = data['kind'];
  if (!is_whiteboard_block_kind(kind)) {
    throw new GraphDefinitionError(
      `白板块 ${id} 的 kind 非法: ${typeName(kind)}（须为 ${BLOCK_KINDS.join('/')}）`,
    );
  }
  const owner = data['owner'];
  if (typeof owner !== 'string' || owner === '') {
    throw new GraphDefinitionError(`白板块 ${id} 缺 owner（期望非空 str）`);
  }
  const content = data['content'];
  if (typeof content !== 'string') {
    throw new GraphDefinitionError(`白板块 ${id} 的 content 非法: ${typeName(content)}（期望 str）`);
  }
  const seq = data['seq'];
  if (typeof seq !== 'number' || !Number.isFinite(seq)) {
    throw new GraphDefinitionError(`白板块 ${id} 的 seq 非法: ${typeName(seq)}（期望 number）`);
  }
  return { id, kind, owner, content, seq };
}

/** 单块序列化为数据形态（只含 JSON 数据；未知键不引入，零漂移）。 */
export function whiteboard_block_to_dict(block: WhiteboardBlock): Record<string, unknown> {
  return {
    id: block.id,
    kind: block.kind,
    owner: block.owner,
    content: block.content,
    seq: block.seq,
  };
}

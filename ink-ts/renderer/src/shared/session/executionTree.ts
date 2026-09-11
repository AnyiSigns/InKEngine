/**
 * 执行树归组与形态判定（纯函数数据面；「run_id/parent_run_id 组织为执行树」）。
 *
 * 消费 execution.run 回执投影（executionTypes 镜像形态），产出可渲染树：
 * - 按 run_id/parent_run_id 归组（根 = 回执 run_id，父子失联/环防挂死：
 *   失联 run 挂根下、环上 run 就地断开——回执来自引擎同批产物理应成树，
 *   这里只兜底脏数据不崩溃）；
 * - 事件按 run_id 归位到节点（白板块 write/read 台账供形态判定与展开明细）；
 * - 组卡形态判定（展示语义）：多路并行 fan_out 子 run = 协作者组卡；
 *   组内跨席位互读意见块（whiteboard_audit opinion read 非己 owner）= 圆桌审议卡；
 * - 问题子执行收集（failure/degraded = 前台摘要块 + 点入复盘的展开目标）。
 */

import type {
  ExecutionCost,
  ExecutionEvent,
  ExecutionReceipt,
  ExecutionRunRecord,
} from './executionTypes';

/** 执行树节点（run 记录 + 归位事件 + 子节点；渲染层唯一数据形态）。 */
export interface ExecutionTreeNode {
  run: ExecutionRunRecord;
  /** 归属本 run 的事件带条目（按回执顺序）。 */
  events: ExecutionEvent[];
  children: ExecutionTreeNode[];
}

/** 组卡形态（卡内结构差异；节点 = scope/状态/成本 的公共面不变）。 */
export const EXECUTION_CARD_FORMS = ['single', 'collab_group', 'roundtable'] as const;
export type ExecutionCardForm = (typeof EXECUTION_CARD_FORMS)[number];

/** 组卡信息（组卡根节点携带：席位/契约/裁决/意见流投影面）。 */
export interface ExecutionGroupInfo {
  form: ExecutionCardForm;
  /** 并行路数（fan_out hop count；缺省 = 席位数）。 */
  lanes: number;
  /** 席位行（子 run 入口作用域 + 终态）。 */
  seats: Array<{ run_id: string; scope: string; outcome: string }>;
  /** 归并契约（merge 事件 detail.contract；full = 全量回传 / best = 择优回传）。 */
  mergeContract: string | null;
  /** 采纳数（merge 事件 detail.adopted）。 */
  adopted: number | null;
  /** 意见块流（whiteboard_audit opinion 写读投影：owner/块/动作）。 */
  opinions: Array<{ run_id: string; scope: string; block_id: string; action: string }>;
}

/** 问题子执行（失败/降级；前台摘要块行 + 点入复盘目标）。 */
export interface ExecutionIssue {
  run: ExecutionRunRecord;
  reason: string;
}

function detailString(event: ExecutionEvent, key: string): string {
  const value = event.detail?.[key];
  return typeof value === 'string' ? value : '';
}

/** 事件归位索引：run_id → 事件列表。 */
function indexEvents(events: ExecutionEvent[]): Map<string, ExecutionEvent[]> {
  const byRun = new Map<string, ExecutionEvent[]>();
  for (const event of events) {
    const list = byRun.get(event.run_id);
    if (list) list.push(event);
    else byRun.set(event.run_id, [event]);
  }
  return byRun;
}

/** 沿 parent 链上溯是否回到自己（脏数据环检测）。 */
function createsCycle(
  nodes: Map<string, ExecutionTreeNode>,
  childId: string,
  parentId: string,
): boolean {
  const seen = new Set<string>([childId]);
  let cursor: string | null = parentId;
  while (cursor !== null) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    const parent: ExecutionTreeNode | undefined = nodes.get(cursor);
    if (!parent) return false;
    cursor = parent.run.parent_run_id;
  }
  return false;
}

/**
 * 回执 → 执行树根节点数组。runs[] 缺失 = 以回执 run_id 合成单节点根
 * （旧回执/裁剪回执仍可渲染）；父失联/成环挂根下（脏数据不崩溃）。
 */
export function buildExecutionTree(receipt: ExecutionReceipt): ExecutionTreeNode[] {
  const eventsByRun = indexEvents(receipt.events);
  const nodes = new Map<string, ExecutionTreeNode>();
  for (const run of receipt.runs) {
    if (!nodes.has(run.run_id)) {
      nodes.set(run.run_id, { run, events: eventsByRun.get(run.run_id) ?? [], children: [] });
    }
  }
  let rootNode = nodes.get(receipt.run_id);
  if (!rootNode) {
    rootNode = {
      run: {
        run_id: receipt.run_id,
        parent_run_id: null,
        entry_scope: '',
        outcome: receipt.outcome ?? 'success',
        hops: [],
        cost: {},
        error: null,
      },
      events: eventsByRun.get(receipt.run_id) ?? [],
      children: [],
    };
    nodes.set(receipt.run_id, rootNode);
  }
  const tree = rootNode;
  for (const node of nodes.values()) {
    if (node === tree) continue;
    const parentId = node.run.parent_run_id;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (parent && parent !== node && !createsCycle(nodes, node.run.run_id, parentId as string)) {
      parent.children.push(node);
    } else {
      tree.children.push(node);
    }
  }
  return [tree];
}

/** 节点及其全部后代 run_id（展开某父 = 展开其子树时的可见集合基础）。 */
export function collectSubtreeIds(node: ExecutionTreeNode): string[] {
  const ids: string[] = [];
  const walk = (current: ExecutionTreeNode): void => {
    ids.push(current.run.run_id);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return ids;
}

/** 从根到目标 run 的祖先链（含两端；未知 id = null。点入复盘展开链用）。 */
export function findPath(node: ExecutionTreeNode, runId: string): ExecutionTreeNode[] | null {
  if (node.run.run_id === runId) return [node];
  for (const child of node.children) {
    const tail = findPath(child, runId);
    if (tail) return [node, ...tail];
  }
  return null;
}

function hasFanOutGroup(node: ExecutionTreeNode): boolean {
  const fanOut = node.run.hops.some((hop) => hop.shape === 'fan_out');
  const routed = node.events.some((event) => event.action.startsWith('route:fan_out'));
  return fanOut || routed || node.children.length > 1;
}

/**
 * 组卡形态判定（展示面差异）：
 * - 非 fan-out 组 → single（普通 run 卡，单子转场同此）；
 * - 组内意见块跨席位互见（opinion write 与它席 read 并存）→ roundtable；
 * - 其余并行组 → blind 协奏 = collab_group（意见块默认私有互不可见）。
 */
export function detectGroupForm(node: ExecutionTreeNode): ExecutionGroupInfo {
  const seats = node.children.map((child) => ({
    run_id: child.run.run_id,
    scope: child.run.entry_scope,
    outcome: child.run.outcome,
  }));
  if (!hasFanOutGroup(node)) {
    return { form: 'single', lanes: 0, seats: [], mergeContract: null, adopted: null, opinions: [] };
  }
  const fanOut = node.run.hops.find((hop) => hop.shape === 'fan_out');
  const opinions: ExecutionGroupInfo['opinions'] = [];
  const writers = new Map<string, string>();
  for (const child of node.children) {
    for (const event of child.events) {
      if (event.action !== 'whiteboard_audit') continue;
      const kind = detailString(event, 'kind');
      const blockId = detailString(event, 'block_id');
      const action = detailString(event, 'action');
      if (kind !== 'opinion' || !blockId) continue;
      // 行为主体以审计行 scope 为准（回执事件的 actor 字段），回落子 run 入口作用域
      const actor = detailString(event, 'scope') || child.run.entry_scope;
      opinions.push({ run_id: child.run.run_id, scope: actor, block_id: blockId, action });
      if (action === 'write') writers.set(blockId, actor);
    }
  }
  const crossSeen = opinions.some(
    (opinion) => opinion.action === 'read'
      && writers.has(opinion.block_id)
      && writers.get(opinion.block_id) !== opinion.scope,
  );
  const merge = node.events.find((event) => event.action === 'merge');
  const adopted = merge?.detail?.adopted;
  return {
    form: crossSeen ? 'roundtable' : 'collab_group',
    lanes: typeof fanOut?.count === 'number' && fanOut.count > 0 ? fanOut.count : seats.length,
    seats,
    mergeContract: merge ? detailString(merge, 'contract') || null : null,
    adopted: typeof adopted === 'number' && Number.isFinite(adopted) ? adopted : null,
    opinions,
  };
}

/** 问题子执行收集（根自身不入列——根终态由回执头呈现；折叠态摘要块消费）。 */
export function collectIssues(node: ExecutionTreeNode): ExecutionIssue[] {
  const issues: ExecutionIssue[] = [];
  const walk = (current: ExecutionTreeNode): void => {
    for (const child of current.children) {
      if (child.run.outcome === 'failure' || child.run.outcome === 'degraded') {
        issues.push({ run: child.run, reason: child.run.error ?? '' });
      }
      walk(child);
    }
  };
  walk(node);
  return issues;
}

/** 节点子树成本合计（头部成本面：自身 + 全部后代；全零 = 空对象缺省）。 */
export function sumSubtreeCost(node: ExecutionTreeNode): ExecutionCost {
  const total = { ...node.run.cost };
  const walk = (current: ExecutionTreeNode): void => {
    for (const child of current.children) {
      for (const key of ['steps', 'cost', 'tokens', 'ms'] as const) {
        const value = child.run.cost[key];
        if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
      }
      walk(child);
    }
  };
  walk(node);
  return total;
}

/** 回执 → 视图模型（根节点 + 头投影字段一次归位）。 */
export interface ExecutionViewModel {
  receipt: ExecutionReceipt;
  root: ExecutionTreeNode;
}

export function buildExecutionViewModel(receipt: ExecutionReceipt): ExecutionViewModel {
  const [root] = buildExecutionTree(receipt);
  return {
    receipt, root: root ?? {
      run: {
        run_id: receipt.run_id,
        parent_run_id: null,
        entry_scope: '',
        outcome: receipt.outcome ?? 'success',
        hops: [],
        cost: {},
        error: null,
      },
      events: [],
      children: [],
    }
  };
}

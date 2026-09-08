/** DAG 图数据形态（自研 SVG 渲染器消费）。 */

export type DagNodeKind = 'orchestrator' | 'tool' | 'terminal';

export type DagNodeStatus = 'idle' | 'running' | 'success' | 'failed';

export interface DagNode {
  id: string;
  label: string;
  /** 语义色走 CSS 类：编排/工具/终结（图语义不占决策色）。 */
  kind: DagNodeKind;
  /** 分组折叠键：同一 group 可折叠为「+N」徽标。 */
  group?: string;
  /** 执行态追踪（实例 tab 经 node_start/end 推进）。 */
  status?: DagNodeStatus;
  /** 节点描述（详情抽屉）。 */
  detail?: string;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
}

export interface DagLayoutNode {
  id: string;
  x: number;
  y: number;
  layer: number;
  column: number;
  node: DagNode;
}

export interface DagLayout {
  positions: DagLayoutNode[];
  width: number;
  height: number;
  layers: number;
}

export const DAG_NODE_W = 168;
export const DAG_NODE_H = 48;
export const DAG_GAP_X = 96;
export const DAG_GAP_Y = 28;
export const DAG_PAD = 32;

/**
 * ui_spec 布局树类型（UIRenderer 契约的输入形态）。
 *
 * 与引擎 UISpec 数据形态同构（同源契约）：
 * - 容器递归组织层级（column/row/views/overlay）；
 * - 组件经动态组件注册表解析（白名单外拒绝渲染）；
 * - bind 声明把组件数据挂到绑定通道（state 家族 / events 家族 / inspect 六元）；
 * - theme 为白名单主题 token 对象（bg.base / text.base / accent.approval /
 *   透明组状态 token）。
 */

export interface UIBind {
  channel: string;
  path?: string;
}

export interface UINode {
  kind: 'container' | 'component';
  type: string;
  props?: Record<string, unknown>;
  bind?: UIBind;
  children?: UINode[];
}

export interface UISpec {
  name: string;
  version?: number;
  theme?: Record<string, string>;
  root: UINode | null;
}

/** 视图选择（渲染器按 node.props.view 过滤 views 容器的直接子级）。 */
export type ViewId =
  // 产品主区页签（spec 驱动的会话主壳：对话/演化/轨迹/待办/机制）
  | 'chat'
  | 'evolution'
  | 'trajectory'
  | 'todo'
  | 'mechanism'
  // 历史视图（设置页/独立深看视图；随产品壳收敛不再用于主装配）
  | 'main'
  | 'simulation'
  | 'source'
  | 'settings'
  | 'admin'
  | 'architecture'
  | 'edit_ui';

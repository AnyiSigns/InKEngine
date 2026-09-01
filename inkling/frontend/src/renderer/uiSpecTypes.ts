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

/** 视图选择（App 侧切换；渲染器按 node.props.view 过滤）。 */
export type ViewId = 'main' | 'evolution' | 'simulation' | 'source' | 'settings' | 'admin' | 'architecture' | 'edit_ui';

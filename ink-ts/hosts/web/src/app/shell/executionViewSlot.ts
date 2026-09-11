/**
 * 执行树视图槽位（W7E 壳装配单点）。
 *
 * 产品主壳布局 = plugins/ui.generated.json 生成物（本波禁改插件声明）；
 * 壳在装配单点把执行树组件节点注入 chat 列（message_list 之下、task_capsule
 * 之上），组件本体住显示设备注册表（execution_tree_card）、数据经绑定通道
 * state.executionRuns 取数——仍是 spec 直渲管线，零硬编码 JSX。闭合集波把
 * 该节点并入插件声明（ui_features 组件插件）后本槽位注入退役。
 */

import type { UINode, UISpec } from '@/renderer/uiSpecTypes';

/** 执行树组件注册名（设备 registerExecutionTreeRenderers 装配）。 */
export const EXECUTION_TREE_COMPONENT = 'execution_tree_card';

/** 执行树绑定通道（会话快照 execution.run 回执落位面）。 */
export const EXECUTION_TREE_BIND_CHANNEL = 'state.executionRuns';

function treeNode(): UINode {
  return {
    kind: 'component',
    type: EXECUTION_TREE_COMPONENT,
    props: { note: '执行树槽位（W7E 壳装配注入；收口并入插件声明后退役）' },
    bind: { channel: EXECUTION_TREE_BIND_CHANNEL, path: '' },
  };
}

function injectNode(node: UINode): UINode {
  if (node.kind !== 'container') return node;
  const children = node.children ?? [];
  if (node.props?.view === 'chat') {
    if (children.some((child) => child.type === EXECUTION_TREE_COMPONENT)) return node;
    const anchor = children.findIndex((child) => child.type === 'task_capsule');
    const at = anchor >= 0 ? anchor : children.length;
    return { ...node, children: [...children.slice(0, at), treeNode(), ...children.slice(at)] };
  }
  return { ...node, children: children.map(injectNode) };
}

/** 注入执行树槽位（幂等：已注入原样返回；无 root/无 chat 列 = 原样返回）。 */
export function injectExecutionViewSlot(spec: UISpec): UISpec {
  if (!spec || !spec.root) return spec;
  return { ...spec, root: injectNode(spec.root) };
}

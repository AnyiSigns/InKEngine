/**
 * inspect_* 五元工具快照类型（演化时间线/孵化面板的数据源）。
 *
 * 对应引擎五元观察工具（inspect_graph / inspect_rules / inspect_knowledge /
 * inspect_ui / inspect_tools）的快照形态；前端侧为只读投影，不持有写入通道。
 */

/** inspect_graph：回合图 + 补丁链（演化时间线主数据源）。 */
export interface GraphSnapshot {
  version: number;
  nodes: Array<{ id: string; type: string; label?: string }>;
  edges: Array<{ from: string; to: string }>;
  patchChain: Array<{
    patchId: string;
    kind: string;
    title: string;
    status: 'proposed' | 'applied' | 'reverted';
    level?: string;
    appliedAt?: number;
    revertedAt?: number;
    revertReason?: string;
  }>;
}

/** inspect_rules：领域规则集快照。 */
export interface RulesSnapshot {
  version: number;
  rules: Array<{ id: string; name: string; level: string; description?: string }>;
}

/** inspect_knowledge：知识集快照（可信度分级）。 */
export interface KnowledgeSnapshot {
  version: number;
  entries: Array<{
    id: string;
    title: string;
    level: 'work' | 'project' | 'user';
    credibility: number;
    usageCount: number;
    tags: string[];
  }>;
}

/** inspect_ui：界面描述快照（组件/绑定通道/主题 token 三层白名单状态）。 */
export interface UiSnapshot {
  version: number;
  componentWhitelist: string[];
  bindChannelWhitelist: string[];
  themeTokenWhitelist: string[];
}

/** inspect_tools：工具表快照（声明/权限/端点）。 */
export interface ToolsSnapshot {
  version: number;
  tools: Array<{
    name: string;
    permission: 'allow' | 'review' | 'deny';
    endpoint: string;
    description?: string;
  }>;
}

export const INSPECT_CHANNEL_NAMES = [
  'inspect_graph',
  'inspect_rules',
  'inspect_knowledge',
  'inspect_ui',
  'inspect_tools',
] as const;

export type InspectChannelName = (typeof INSPECT_CHANNEL_NAMES)[number];

export type InspectSnapshot =
  | GraphSnapshot
  | RulesSnapshot
  | KnowledgeSnapshot
  | UiSnapshot
  | ToolsSnapshot;

export interface InspectSnapshots {
  inspect_graph: GraphSnapshot;
  inspect_rules: RulesSnapshot;
  inspect_knowledge: KnowledgeSnapshot;
  inspect_ui: UiSnapshot;
  inspect_tools: ToolsSnapshot;
}

export function emptyInspectSnapshots(): InspectSnapshots {
  return {
    inspect_graph: { version: 0, nodes: [], edges: [], patchChain: [] },
    inspect_rules: { version: 0, rules: [] },
    inspect_knowledge: { version: 0, entries: [] },
    inspect_ui: { version: 0, componentWhitelist: [], bindChannelWhitelist: [], themeTokenWhitelist: [] },
    inspect_tools: { version: 0, tools: [] },
  };
}

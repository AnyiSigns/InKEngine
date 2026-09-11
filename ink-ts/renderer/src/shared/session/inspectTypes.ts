/**
 * inspect_* 五元工具快照类型（演化时间线/孵化面板的数据源）。
 *
 * 对应引擎五元观察工具（inspect_rules / inspect_knowledge /
 * inspect_ui / inspect_tools / inspect_entities）的快照形态；前端侧为只读
 * 投影，不持有写入通道（inspect_graph 随组装链路退役移除，W7-B）。
 */

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
  'inspect_rules',
  'inspect_knowledge',
  'inspect_ui',
  'inspect_tools',
  'inspect_entities',
] as const;

export type InspectChannelName = (typeof INSPECT_CHANNEL_NAMES)[number];

export type InspectSnapshot =
  | RulesSnapshot
  | KnowledgeSnapshot
  | UiSnapshot
  | ToolsSnapshot
  | EntitySnapshot;

export interface EntitySnapshot {
  version: number;
  entities: Array<{
    id: string;
    label: string;
    model: { provider: string; model_id: string } | null;
  }>;
  count: number;
}

export interface InspectSnapshots {
  inspect_rules: RulesSnapshot;
  inspect_knowledge: KnowledgeSnapshot;
  inspect_ui: UiSnapshot;
  inspect_tools: ToolsSnapshot;
  inspect_entities: EntitySnapshot;
}

export function emptyInspectSnapshots(): InspectSnapshots {
  return {
    inspect_rules: { version: 0, rules: [] },
    inspect_knowledge: { version: 0, entries: [] },
    inspect_ui: { version: 0, componentWhitelist: [], bindChannelWhitelist: [], themeTokenWhitelist: [] },
    inspect_tools: { version: 0, tools: [] },
    inspect_entities: { version: 0, entities: [], count: 0 },
  };
}

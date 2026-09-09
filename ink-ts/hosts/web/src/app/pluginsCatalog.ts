/**
 * 插件目录（壳侧人类视图数据源）：从插件源装配生成物 plugins/manifest.json
 * 派生轻量目录——唯一实体=插件（提供物 = 工具/命令/界面/服务/端点），UI 不
 * 呈现 kind 分组、不设 kind 专属开关（定稿 C：kind 仅在引擎内部作装载路由）。
 *
 * 本模块是**装配期只读视图**：id/kind/capability/package 来自生成物插件行，
 * 不建第二套注册表；行内可管理动作（常驻必带/界面组件启停/服务启停）由面板
 * 各自接既有命令面（capability.baseline / ui_components / mcp.status|enable|disable）。
 * manageable = 该插件存在人类可操作的管理面；命令/端点与界面面板等只读
 * （agent 对话受控接入随 B6，界面面板随装配注册不经 UI 启停）。
 */

import pluginManifest from '../../../../plugins/manifest.json';

/** 插件提供物分类（人类可读视图粒度；非 kind，UI 分组即此分类）。 */
export type PluginProvides =
  /** 工具（tool 行；可常驻必带 = capability.baseline）。 */
  | 'tool'
  /** 界面组件（ui_feature 中出厂组件白名单；可启停 = ui_components）。 */
  | 'ui_component'
  /** 服务（MCP 工具型插件；启停 = mcp.status/enable/disable，B5）。 */
  | 'service'
  /** 命令（command 行；装配期方法面，只读展示）。 */
  | 'command'
  /** 端点（endpoint 行；原生执行件装配基础设施，只读展示）。 */
  | 'endpoint';

export const PLUGIN_PROVIDES_ORDER: readonly PluginProvides[] = [
  'tool',
  'ui_component',
  'service',
  'command',
  'endpoint',
];

/** kind → 提供物（kind 只在引擎内部作装载路由；此处仅作目录归类映射）。 */
const KIND_PROVIDES: Record<string, PluginProvides> = {
  tool: 'tool',
  mcp: 'service',
  command: 'command',
  ui_feature: 'ui_component',
  endpoint: 'endpoint',
};

/** 目录单行（派生视图：插件 id/kind/capability/package + 人类提供物分类）。 */
export interface PluginCatalogRow {
  id: string;
  kind: string;
  capability: string;
  package?: string;
  provides: PluginProvides;
  /** 是否出厂界面组件白名单成员（仅此类 ui_feature 经 ui_components 可启停）。 */
  factoryComponent: boolean;
}

/** 插件目录（壳侧注入人类视图）。 */
export interface PluginsCatalog {
  total: number;
  rows: PluginCatalogRow[];
}

/** 出厂界面组件白名单（可启停界面插件 = components 子集 ∩ ui_feature）。 */
function factoryComponents(): ReadonlySet<string> {
  const manifest = pluginManifest as {
    ui_features?: { components?: string[] };
  };
  return new Set(manifest.ui_features?.components ?? []);
}

/** 从插件源派生目录（装配期静态；多次调用返回同一派生结果）。 */
export function derivePluginsCatalog(): PluginsCatalog {
  const manifest = pluginManifest as {
    plugins?: Array<{
      id: string;
      kind: string;
      capability?: string;
      package?: string;
    }>;
  };
  const components = factoryComponents();
  const rows: PluginCatalogRow[] = (manifest.plugins ?? []).map((row) => ({
    id: row.id,
    kind: row.kind,
    capability: row.capability ?? '',
    ...(typeof row.package === 'string' ? { package: row.package } : {}),
    provides: KIND_PROVIDES[row.kind] ?? 'endpoint',
    factoryComponent: row.kind === 'ui_feature' && components.has(row.id),
  }));
  return { total: rows.length, rows };
}

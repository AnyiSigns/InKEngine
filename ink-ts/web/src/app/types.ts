/**
 * App 视图层共享类型：W4/W5 视图间共享的数据形态。
 *
 * 与 seed_data/*.json 同源契约，前端侧镜像；新增类型先改 seed 数据，
 * 再镜像到本文件。
 */

import type { ArtifactManifestEntry, McpMarketEntrySummary } from '@/shared/backend/backendAdapter';

/**
 * MCP 服务器市场条目（宿主 mcp_market_status 回传；与 seed_data/mcp_market.json
 * servers[] 同源契约）。单一契约源 = backendAdapter.McpMarketEntrySummary，
 * 本类型为其别名，避免两份接口漂移。
 */
export type McpMarketEntry = McpMarketEntrySummary;

/** 组件构件清单条目（扩展 artifactLoader 的 ArtifactManifestEntry）。 */
export interface AppArtifactEntry extends ArtifactManifestEntry {
  category?: string;
  note?: string;
}

/** 工具详情（与 seed_data/tools.json 同源）：行为手册渲染层。 */
export interface ToolDetail {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permissions: string[];
  approval: 'allow' | 'review' | 'deny';
  endpoint: string;
  network_policy?: {
    allow_domains?: string[];
    outbound_domains?: string[];
    note?: string;
  };
  meta?: {
    domain: string;
    executor?: string;
    sandbox?: string;
    tier?: string;
    auto_approvable?: boolean;
    sensor?: string;
    control?: boolean;
    deny_by_default?: boolean;
    note?: string;
  };
}

/** 四层标签筛选 */
export type ToolLayer = 'declarative' | 'introspective' | 'self_referential' | 'dynamic';

/** 四层标签展示 */
export const TOOL_LAYER_LABELS: Record<ToolLayer, string> = {
  declarative: '声明式',
  introspective: '内省',
  self_referential: '自指',
  dynamic: '动态',
};

/** 风险等级中文标签 */
export const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

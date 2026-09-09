/**
 * 生成文件勿手改：命令面声明派生视图（真源 = plugins/commands/<id>/spec.json）。
 * 由 plugins/scripts/sync_plugin_manifest.mjs 生成（data.group 决定实现域、
 * data.order 决定域内顺序；跨域序见 DOMAIN_TABLE）。改命令声明只改
 * plugins/commands/<id>/spec.json 后重跑生成器；verify:plugin-manifest 强制。
 */

/** rounds 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const ROUNDS_COMMANDS = [
  'rounds.send',
  'rounds.abort',
  'rounds.resume',
  'rounds.branch',
  'rounds.fork_trial',
] as const;

export type RoundsCommand = (typeof ROUNDS_COMMANDS)[number];

/** todos 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const TODOS_COMMANDS = [
  'rounds.todos',
] as const;

export type TodosCommand = (typeof TODOS_COMMANDS)[number];

/** records 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const RECORDS_COMMANDS = [
  'records.sessions',
  'records.chain',
] as const;

export type RecordsCommand = (typeof RECORDS_COMMANDS)[number];

/** sessions 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const SESSIONS_COMMANDS = [
  'sessions.create',
  'sessions.rename',
  'sessions.delete',
  'sessions.refresh',
  'sessions.tree',
  'sessions.messages',
] as const;

export type SessionsCommand = (typeof SESSIONS_COMMANDS)[number];

/** approval 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const APPROVAL_COMMANDS = [
  'approval.list',
  'approval.resolve',
] as const;

export type ApprovalCommand = (typeof APPROVAL_COMMANDS)[number];

/** audit 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const AUDIT_COMMANDS = [
  'audit.export',
  'audit.list',
] as const;

export type AuditCommand = (typeof AUDIT_COMMANDS)[number];

/** tools 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const TOOLS_COMMANDS = [
  'tools.full',
] as const;

export type ToolsCommand = (typeof TOOLS_COMMANDS)[number];

/** recovery 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const RECOVERY_COMMANDS = [
  'recovery.checkpoints',
  'recovery.rollback',
  'recovery.reset',
] as const;

export type RecoveryCommand = (typeof RECOVERY_COMMANDS)[number];

/** backup 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const BACKUP_COMMANDS = [
  'backup.export',
  'backup.preview',
  'backup.restore',
] as const;

export type BackupCommand = (typeof BACKUP_COMMANDS)[number];

/** mcp 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const MCP_COMMANDS = [
  'mcp.status',
  'mcp.enable',
  'mcp.disable',
] as const;

export type McpCommand = (typeof MCP_COMMANDS)[number];

/** knowledge 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const KNOWLEDGE_COMMANDS = [
  'knowledge.list',
  'knowledge.graph',
  'knowledge.export',
] as const;

export type KnowledgeCommand = (typeof KNOWLEDGE_COMMANDS)[number];

/** memory 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const MEMORY_COMMANDS = [
  'memory.list',
  'memory.invalidate',
] as const;

export type MemoryCommand = (typeof MEMORY_COMMANDS)[number];

/** growth 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const GROWTH_COMMANDS = [
  'growth.report',
] as const;

export type GrowthCommand = (typeof GROWTH_COMMANDS)[number];

/** graph 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const GRAPH_COMMANDS = [
  'graph.instance',
] as const;

export type GraphCommand = (typeof GRAPH_COMMANDS)[number];

/** skeleton 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const SKELETON_COMMANDS = [
  'skeleton.get',
  'skeleton.edit',
] as const;

export type SkeletonCommand = (typeof SKELETON_COMMANDS)[number];

/** pool 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const POOL_COMMANDS = [
  'pool.snapshot',
  'pool.evaluate',
] as const;

export type PoolCommand = (typeof POOL_COMMANDS)[number];

/** edge_evidence 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const EDGE_EVIDENCE_COMMANDS = [
  'edge_evidence.list',
] as const;

export type EdgeEvidenceCommand = (typeof EDGE_EVIDENCE_COMMANDS)[number];

/** metrics 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const METRICS_COMMANDS = [
  'metrics.snapshot',
] as const;

export type MetricsCommand = (typeof METRICS_COMMANDS)[number];

/** assemble 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const ASSEMBLE_COMMANDS = [
  'assemble.stats',
] as const;

export type AssembleCommand = (typeof ASSEMBLE_COMMANDS)[number];

/** cache 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const CACHE_COMMANDS = [
  'cache.stats',
] as const;

export type CacheCommand = (typeof CACHE_COMMANDS)[number];

/** path 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const PATH_COMMANDS = [
  'path.state',
] as const;

export type PathCommand = (typeof PATH_COMMANDS)[number];

/** entities 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const ENTITIES_COMMANDS = [
  'entities.snapshot',
] as const;

export type EntitiesCommand = (typeof ENTITIES_COMMANDS)[number];

/** os 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const OS_COMMANDS = [
  'os.run',
] as const;

export type OsCommand = (typeof OS_COMMANDS)[number];

/** search 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const SEARCH_COMMANDS = [
  'search.keys.set',
  'search.keys.get',
] as const;

export type SearchCommand = (typeof SEARCH_COMMANDS)[number];

/** material 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const MATERIAL_COMMANDS = [
  'material.import',
] as const;

export type MaterialCommand = (typeof MATERIAL_COMMANDS)[number];

/** models 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const MODELS_COMMANDS = [
  'models.config.get',
  'models.config.put',
  'models.config.reload',
  'models.config.role_pick',
] as const;

export type ModelsCommand = (typeof MODELS_COMMANDS)[number];

/** model_archive 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const MODEL_ARCHIVE_COMMANDS = [
  'model_archive.snapshot',
] as const;

export type ModelArchiveCommand = (typeof MODEL_ARCHIVE_COMMANDS)[number];

/** capability 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const CAPABILITY_COMMANDS = [
  'capability.get',
  'capability.put',
  'capability.baseline.get',
  'capability.baseline.set',
  'capability.tier.set',
] as const;

export type CapabilityCommand = (typeof CAPABILITY_COMMANDS)[number];

/** policy 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const POLICY_COMMANDS = [
  'policy.route',
] as const;

export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

/** ui_components 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const UI_COMPONENTS_COMMANDS = [
  'ui_components.get',
  'ui_components.set_disabled',
] as const;

export type UiComponentsCommand = (typeof UI_COMPONENTS_COMMANDS)[number];

/** workspace 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const WORKSPACE_COMMANDS = [
  'workspace.state',
  'workspace.set',
  'workspace.revoke',
  'workspace.mount.add',
  'workspace.mount.remove',
] as const;

export type WorkspaceCommand = (typeof WORKSPACE_COMMANDS)[number];

/** dialog 命令声明（真源 plugins/commands/<id>/spec.json；域内序 = data.order）。 */
export const DIALOG_COMMANDS = [
  'dialog.open_directory',
] as const;

export type DialogCommand = (typeof DIALOG_COMMANDS)[number];

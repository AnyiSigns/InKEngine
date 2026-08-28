/**
 * 后端适配器（可注入）：会话/回合/授权/审批/设置/备份/工具快照的宿主面。
 *
 * 前端不直接感知 IPC：所有宿主交互经本适配器接口，生产 = Tauri 宿主桥
 * （invoke 直调），测试 = mock 后端注入（同一契约）；宿主不可用时
 * `available=false`，应用回落夹具路径（浏览器 dev / 无壳环境）。
 */

import { createTauriInvoker, type TauriInvoker } from './tauriBridge';

/** 会话记录（引擎 records 通道的会话集合数据形态）。 */
export interface SessionRemoteRecord {
  thread_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  current_leaf: number | null;
  rename_count: number;
  deleted?: boolean;
}

/** 分支树（checkpoint 链的多叶映射）。 */
export interface SessionBranchTree {
  session_id: string;
  nodes: Array<{ leaf: number; parent: number | null; reason?: string | null }>;
  current_leaf: number | null;
}

/** 回合结果（引擎事件流 + 步骤序列）。 */
export interface RoundResult {
  round_id: string;
  thread_id: string;
  reason: string;
  output: string | null;
  events: Array<Record<string, unknown>>;
  steps: Array<unknown>;
}

/** 策略层路由预览（分类/链/计划/档位/守门）。 */
export interface RoutePlanResult {
  kind: string;
  chain_id: string | null;
  plan: Record<string, unknown>;
  policy: { tier: string; max_simulations: number; quota_per_round: number };
  quota_guarded: boolean;
}

/** 备份清单预览（恢复向导的面）。 */
export interface BackupPreview {
  entries_total: number;
  will_overwrite: number;
  total_size: number;
  has_db: boolean;
  created_at: number;
}

/** 启动快照条目（崩溃回退「回上一稳定版本」的取用面）。 */
export interface RecoverySnapshot {
  name: string;
  chain_version: number;
  created_at: number;
}

/** 组件构建产物清单条目（挂载后注册表刷新）。 */
export interface ArtifactManifestEntry {
  name: string;
  url: string;
  hash: string;
  version: string;
  /** 渲染形态声明（mini 内联 / overlay 弹层）。 */
  view_forms?: string[];
  /** 渲染器键：清单条目同时登记为自定义消息渲染器（须为白名单键）。 */
  renderer_key?: string;
}

/** 知识图节点（知识条目拓扑：规则/模板/工具规则/权重）。 */
export interface KnowledgeGraphNode {
  id: string;
  label: string;
  kind: 'rule' | 'template' | 'tool_rule' | 'weight';
  tags?: string[];
}

/** 知识图关系边（标签/引用/来源拓扑维，区别于时间维演化）。 */
export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation: 'tag' | 'reference' | 'source';
}

/** 知识关系图（拓扑视图数据源）。 */
export interface KnowledgeGraphResult {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/** 工具快照条目（四层兜底标签 + 工具族 + 自动审批可登记标记）。 */
export interface ToolSnapshotEntry {
  tool: string;
  zh: string;
  group: string;
  auto_approvable?: boolean;
}

/** 后端状态（引擎就绪/工具面/安全模式/首启引导/执行件随包/运行形态）。 */
export interface BackendStatus {
  engine_ready: boolean;
  tool_count: number;
  safe_mode?: boolean;
  first_run?: boolean;
  exec_ready?: boolean;
  bundled?: boolean;
}

/** 模型档案（按挡位分组，占用/上限联动显示）。 */
export interface ModelProfile {
  id: string;
  name: string;
  tier: string;
  occupancy: number;
  limit: number;
  /** 多模态能力标记（壳侧模型档案 multimodal 标注的镜像；缺省回落 false）。 */
  multimodal?: boolean;
}

/** 模型档案快照（仪表/选择控件数据源）。 */
export interface ModelArchiveSnapshot {
  profiles: ModelProfile[];
}

/**
 * 回合指标快照（TurnMetrics 形态）：回合数 / 失败数 / 失败率 /
 * 平均评审分 + 扩展面（LLM 调用数 / 回合耗时）。
 */
export interface TurnMetricsSnapshot {
  turns: number;
  failures: number;
  failure_rate: number;
  avg_review_score: number;
  llm_calls: number;
  round_duration_ms: number;
}

/**
 * 组装路径统计（path.assemble op 回传 stats，命中率钉死取此）：
 * 缓存命/失/失效/顶替 + 边平均成本。注意：不引用任何缓存存储的
 * 内部 stats 方法，仅消费 op 回传的聚合统计。
 */
export interface AssembleStats {
  cache_hits: number;
  cache_misses: number;
  cache_invalidations: number;
  cache_replacements: number;
  avg_cost: number;
}

/** 单条归一结果（既有资料批量导入扫描预览）。 */
export interface MaterialScanFile {
  path: string;
  format: string;
  size: number;
}

/** 扫描预览结果（目录扫描 + 格式归一，尚未入料）。 */
export interface MaterialScanResult {
  root: string;
  recursive: boolean;
  scanned: number;
  files: MaterialScanFile[];
  skipped: Array<{ path: string; reason: string }>;
}

/** 单文件入料状态（经样例闸门/知识集入料链后）。 */
export interface MaterialImportFileResult {
  path: string;
  status: 'ingested' | 'rejected';
  reason?: string;
}

/** 入料结果（逐文件状态 + 汇总）。 */
export interface MaterialImportResult {
  scanned: number;
  ingested: number;
  rejected: number;
  files: MaterialImportFileResult[];
}

/** 后端适配器接口（生产 = 宿主桥；测试 = mock）。 */
export interface BackendAdapter {
  /** 宿主可用性（false = 回落夹具路径）。 */
  available: boolean;
  status(): Promise<BackendStatus>;
  engineBoot(): Promise<{ snapshot: Record<string, unknown> }>;
  firstRunDismiss(): Promise<{ dismissed: boolean }>;
  roundSend(
    threadId: string,
    roundId: string,
    text: string,
    autoAccept?: boolean,
    attachments?: Array<{ kind: string; url: string; name?: string; mime?: string }>,
  ): Promise<RoundResult>;
  roundAbort(roundId: string): Promise<{ aborted: boolean }>;
  roundResume(
    threadId: string,
    key: string,
    decision: string,
    reason?: string,
    editedContent?: unknown,
  ): Promise<{ reason: string | null; state: Record<string, unknown> }>;
  routePlan(text: string, tier: string): Promise<RoutePlanResult>;
  sessionList(): Promise<SessionRemoteRecord[]>;
  sessionCreate(): Promise<SessionRemoteRecord>;
  sessionRename(threadId: string, title: string): Promise<SessionRemoteRecord>;
  sessionDelete(threadId: string): Promise<unknown>;
  sessionRefresh(threadId: string): Promise<SessionRemoteRecord>;
  sessionTree(threadId: string): Promise<SessionBranchTree>;
  sessionBranch(
    threadId: string,
    action: string,
    targetLeaf: number | null,
    editText?: string,
  ): Promise<{ leaf: number; action: string }>;
  authorizationState(): Promise<{ authorized: boolean; root: string | null }>;
  workspaceAuthorize(path: string): Promise<{ authorized: boolean; root: string }>;
  workspaceRevoke(): Promise<{ authorized: boolean }>;
  approvalRequest(
    threadId: string | null,
    key: string,
    action: Record<string, unknown>,
    payload: Record<string, unknown> | null,
  ): Promise<unknown>;
  approvalResolve(
    threadId: string | null,
    key: string,
    decision: string,
    reason?: string,
    editedContent?: unknown,
  ): Promise<unknown>;
  capabilityGet(): Promise<{ simulation_tier?: string }>;
  capabilityPut(record: Record<string, unknown>): Promise<unknown>;
  backupExport(dest: string): Promise<{ entries: number; size: number; has_db: boolean }>;
  backupPreview(path: string): Promise<BackupPreview>;
  backupRestore(path: string): Promise<{ restored_entries: number; snapshot: string }>;
  recoverySnapshots(): Promise<{ snapshots: RecoverySnapshot[] }>;
  recoveryRestoreSnapshot(name: string): Promise<{ restored: string; chain_version: number }>;
  recoveryFactoryReset(): Promise<{ reverted_patches: number[]; overwritten: boolean }>;
  toolsSnapshot(): Promise<{ tools: ToolSnapshotEntry[] }>;
  componentsManifest(): Promise<{ artifacts: ArtifactManifestEntry[] }>;
  knowledgeGraph(): Promise<KnowledgeGraphResult>;
  // 可观测数据面（仪表 / 模型选择器数据源）
  modelArchiveSnapshot(): Promise<ModelArchiveSnapshot>;
  metricsSnapshot(): Promise<TurnMetricsSnapshot>;
  assembleStats(): Promise<AssembleStats>;
  // 接线面后端桥 op（壳内嵌桥命令，生产透传；无宿主回落不可用）
  graphSnapshot(): Promise<unknown>;
  poolSnapshot(): Promise<unknown>;
  poolEvaluate(): Promise<unknown>;
  edgeEvidenceList(): Promise<unknown>;
  edgeEvidenceUpdate(edgeId: string, patch: Record<string, unknown>): Promise<unknown>;
  pathAssemble(): Promise<unknown>;
  pathClearCandidate(): Promise<unknown>;
  pathSetAssemblerEnabled(enabled: boolean): Promise<unknown>;
  cacheStats(): Promise<unknown>;
  cacheClear(): Promise<unknown>;
  // 干预 op（前端契约；壳侧落地由另一道负责）
  chooseCandidate(candidateId: string | null): Promise<{ chosen: string | null }>;
  setMultipath(enabled: boolean): Promise<{ multipath: boolean }>;
  invalidateCache(scope: string): Promise<{ cleared: string }>;
  downgradeEdgeTier(edgeId: string): Promise<{ edge: string; tier: string }>;
  rebuildCache(scope: string): Promise<{ rebuilt: string }>;
  restoreEdgeTier(edgeId: string): Promise<{ edge: string; tier: string }>;
  // 既有资料批量导入（搬进 InKEngine 第一步）：扫描预览 + 入料
  materialScan(path: string, recursive?: boolean): Promise<MaterialScanResult>;
  materialIngest(path: string, recursive?: boolean): Promise<MaterialImportResult>;
}

/** 宿主不可用的空适配器（夹具回落的显式形态）。 */
export function createUnavailableBackend(): BackendAdapter {
  const unavailable = (): never => {
    throw new Error('宿主后端不可用（请经桌面壳运行）');
  };
  return {
    available: false,
    status: unavailable as never,
    engineBoot: unavailable as never,
    firstRunDismiss: unavailable as never,
    roundSend: unavailable as never,
    roundAbort: unavailable as never,
    roundResume: unavailable as never,
    routePlan: unavailable as never,
    sessionList: unavailable as never,
    sessionCreate: unavailable as never,
    sessionRename: unavailable as never,
    sessionDelete: unavailable as never,
    sessionRefresh: unavailable as never,
    sessionTree: unavailable as never,
    sessionBranch: unavailable as never,
    authorizationState: unavailable as never,
    workspaceAuthorize: unavailable as never,
    workspaceRevoke: unavailable as never,
    approvalRequest: unavailable as never,
    approvalResolve: unavailable as never,
    capabilityGet: unavailable as never,
    capabilityPut: unavailable as never,
    backupExport: unavailable as never,
    backupPreview: unavailable as never,
    backupRestore: unavailable as never,
    recoverySnapshots: unavailable as never,
    recoveryRestoreSnapshot: unavailable as never,
    recoveryFactoryReset: unavailable as never,
    toolsSnapshot: unavailable as never,
    componentsManifest: unavailable as never,
    knowledgeGraph: unavailable as never,
    rebuildCache: unavailable as never,
    restoreEdgeTier: unavailable as never,
    modelArchiveSnapshot: unavailable as never,
    metricsSnapshot: unavailable as never,
    assembleStats: unavailable as never,
    graphSnapshot: unavailable as never,
    poolSnapshot: unavailable as never,
    poolEvaluate: unavailable as never,
    edgeEvidenceList: unavailable as never,
    edgeEvidenceUpdate: unavailable as never,
    pathAssemble: unavailable as never,
    pathClearCandidate: unavailable as never,
    pathSetAssemblerEnabled: unavailable as never,
    cacheStats: unavailable as never,
    cacheClear: unavailable as never,
    chooseCandidate: unavailable as never,
    setMultipath: unavailable as never,
    invalidateCache: unavailable as never,
    downgradeEdgeTier: unavailable as never,
    materialScan: unavailable as never,
    materialIngest: unavailable as never,
  };
}

/** 宿主桥适配器（Tauri invoke 直调；缺宿主 = 不可用适配器）。 */
export function createTauriBackend(invoker?: TauriInvoker): BackendAdapter {
  const transport = invoker ?? createTauriInvoker();
  if (!transport) return createUnavailableBackend();
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const raw = await transport.invoke(cmd, args);
    return raw as T;
  };
  return {
    available: true,
    status: () => call('backend_status'),
    engineBoot: () => call('engine_boot'),
    firstRunDismiss: () => call('first_run_dismiss'),
    roundSend: (threadId, roundId, text, autoAccept, attachments) =>
      call('round_send', attachments
        ? { threadId, roundId, text, autoAcceptReview: autoAccept, attachments }
        : { threadId, roundId, text, autoAcceptReview: autoAccept }),
    roundAbort: (roundId) => call('round_abort', { roundId }),
    roundResume: (threadId, key, decision, reason, editedContent) =>
      call('round_resume', { threadId, key, decision, reason, editedContent }),
    routePlan: (text, tier) => call('route_plan', { text, tier }),
    sessionList: async () => {
      const result = await call<{ sessions: SessionRemoteRecord[] }>('session_list');
      return result.sessions ?? [];
    },
    sessionCreate: () => call('session_create'),
    sessionRename: (threadId, title) =>
      call('session_rename', { threadId, title }),
    sessionDelete: (threadId) => call('session_delete', { threadId }),
    sessionRefresh: (threadId) => call('session_refresh', { threadId }),
    sessionTree: (threadId) => call('session_tree', { threadId }),
    sessionBranch: (threadId, action, targetLeaf, editText) =>
      call('session_branch', { threadId, action, targetLeaf, editText }),
    authorizationState: () => call('authorization_state'),
    workspaceAuthorize: (path) => call('workspace_authorize', { path }),
    workspaceRevoke: () => call('workspace_revoke'),
    approvalRequest: (threadId, key, action, payload) =>
      call('approval_request', { threadId, key, action, payload }),
    approvalResolve: (threadId, key, decision, reason, editedContent) =>
      call('approval_resolve', { threadId, key, decision, reason, editedContent }),
    capabilityGet: () => call('capability_get'),
    capabilityPut: (record) => call('capability_put', { record }),
    backupExport: (dest) => call('backup_export', { dest }),
    backupPreview: (path) => call('backup_preview', { path }),
    backupRestore: (path) => call('backup_restore', { path }),
    recoverySnapshots: () => call('recovery_snapshots'),
    recoveryRestoreSnapshot: (name) => call('recovery_restore_snapshot', { name }),
    recoveryFactoryReset: () => call('recovery_factory_reset'),
    toolsSnapshot: () => call('tools_snapshot'),
    componentsManifest: () => call('components_manifest'),
    modelArchiveSnapshot: () => call('model_archive_snapshot'),
    metricsSnapshot: () => call('metrics_snapshot'),
    assembleStats: () => call('assemble_stats'),
    graphSnapshot: () => call('graph_snapshot'),
    poolSnapshot: () => call('pool_snapshot'),
    poolEvaluate: () => call('pool_evaluate'),
    edgeEvidenceList: () => call('edge_evidence_list'),
    edgeEvidenceUpdate: (edgeId, patch) => call('edge_evidence_update', { edgeId, patch }),
    pathAssemble: () => call('path_assemble'),
    pathClearCandidate: () => call('path_clear_candidate'),
    pathSetAssemblerEnabled: (enabled) => call('path_set_assembler_enabled', { enabled }),
    cacheStats: () => call('cache_stats'),
    cacheClear: () => call('cache_clear'),
    chooseCandidate: (candidateId) => call('path_choose_candidate', { candidateId }),
    setMultipath: (enabled) => call('path_set_multipath', { enabled }),
    invalidateCache: (scope) => call('cache_invalidate', { scope }),
    downgradeEdgeTier: (edgeId) => call('edge_downgrade_tier', { edgeId }),
    rebuildCache: () => Promise.reject(new Error('ENGINE_OP_UNREGISTERED: cache_rebuild 后端未实现')),
    restoreEdgeTier: () => Promise.reject(new Error('ENGINE_OP_UNREGISTERED: edge_restore_tier 后端未实现')),
    knowledgeGraph: () => Promise.reject(new Error('ENGINE_OP_UNREGISTERED: knowledge_graph 后端未实现')),
    materialScan: (path, recursive) => call('material_import', { path, recursive, ingest: false }),
    materialIngest: (path, recursive) => call('material_import', { path, recursive, ingest: true }),
  };
}

/** 后端选择（生产 = 宿主桥；无宿主 = 不可用适配器，调用方回落夹具）。 */
export function createBackend(): BackendAdapter {
  // 允许测试注入（window.__INKLING_TEST_BACKEND__ 形态由测试桩设置）
  const testBackend = (window as unknown as { __INKLING_TEST_BACKEND__?: BackendAdapter })
    .__INKLING_TEST_BACKEND__;
  if (testBackend) return testBackend;
  return createTauriBackend();
}

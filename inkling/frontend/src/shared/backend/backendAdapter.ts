/**
 * 后端适配器（可注入）：会话/回合/授权/审批/设置/备份/工具快照的宿主面。
 *
 * 前端不直接感知 IPC：所有宿主交互经本适配器接口，生产 = Tauri 宿主桥
 * （invoke 直调），测试 = mock 后端注入（同一契约）；宿主不可用时
 * `available=false`，应用回落夹具路径（浏览器 dev / 无壳环境）。
 */

import { createTauriInvoker, handleEngineError, type TauriInvoker } from './tauriBridge';

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

/** 全量工具清单条目（设置页「工具」管理面：常驻必带勾选数据源）。 */
export interface ToolManifestEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permissions?: string[];
  source?: 'introspection' | 'self' | 'declarative';
  endpoint?: string;
  endpoint_config?: Record<string, unknown>;
  meta?: {
    domain?: string;
    tier?: string;
    auto_approvable?: boolean;
    sensor?: string;
    control?: boolean;
    mcp_server?: string;
    [key: string]: unknown;
  };
  approval?: string;
  /** 常驻必带标记（用户指定每回合必带；false = 语义检索动态注册） */
  baseline: boolean;
}

/** MCP 市场条目摘要（与 app/types.ts McpMarketEntry 同源；宿主 status 回传）。 */
export interface McpMarketEntrySummary {
  id: string;
  name: string;
  source: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[];
  credentials: { required: boolean; note: string };
  risk: 'low' | 'medium' | 'high';
  risk_note: string;
  category: string;
  premounted: boolean;
}

/** MCP 市场摘要（连接页列表 / 市场页分组数据源）。 */
export interface McpMarketSummary {
  id: string;
  name: string;
  source: string;
  builtin: boolean;
  servers: McpMarketEntrySummary[];
}

/** MCP 挂载状态快照（市场 + 已挂载服务）。 */
export interface McpMountStatus {
  markets: McpMarketSummary[];
  mounted: Record<string, { server_id: string; tools: string[] }>;
}

/** 市场摄入预览（vetting 通过 = ok，violations = 违规清单）。 */
export interface McpMarketPreview {
  ok: boolean;
  error?: string;
  violations?: string[];
  preview?: {
    name: string;
    source: string;
    server_count: number;
    risk_summary: { low: number; medium: number; high: number };
    servers: Array<{ id: string; name: string; transport: string; risk: string; risk_note: string }>;
  };
}

/** 挂载/卸载结果信封。 */
export interface McpMountOutcome {
  ok: boolean;
  server_id?: string;
  patch_ids?: number[];
  tool_names?: string[];
  status?: string;
  error?: string | null;
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

/** 回合级模型选择（输入框选定；无默认、无档位——选什么跑什么）。
 * provider 缺省 = 当前唯一连接提供方（单提供方形态；多提供方扩展后由
 * 输入框按已配置提供方分组传 provider）。
 * reasoning_effort（off/low/medium/high）= 输入框显式选择的推理档位；
 * 缺省 = 不注入，跟随模型/厂商默认。 */
export interface ModelSelection {
  provider?: string;
  model_id: string;
  reasoning_effort?: 'off' | 'low' | 'medium' | 'high';
}

/** 模型档案条目（壳侧 model_archive.sqlite 记录形态；多模态三态）。 */
export interface ModelArchiveRow {
  model_id: string;
  context_window?: number;
  multimodal?: boolean | 'true' | 'false' | 'unknown';
  metadata?: Record<string, unknown>;
  discovered_at?: string;
}

/** 模型档案快照（Rust model_archive_snapshot 契约：ok + archives）。
 *
 * 设计 ：无默认、无档位——输入选择只消费模型目录（model_id +
 * 多模态 + 窗口），不显示 tier/占用等无数据源字段。
 */
export interface ModelArchiveSnapshot {
  ok?: boolean;
  archives: ModelArchiveRow[];
}

/**
 * 回合指标快照（metrics.snapshot op 回传聚合形态）：回合/LLM/缓存/
 * 边证据/占用汇成单一观测快照。各块缺省容错（缺块 = 0/空，不报错）。
 */
export interface TurnMetricsSnapshot {
  ok: boolean;
  turn_metrics: Record<string, unknown>;
  llm: {
    prompt_tokens_total: number;
    completion_tokens_total: number;
    tokens_total: number;
    last_prompt_tokens: number | null;
    last_completion_tokens: number | null;
    calls_total: number;
  };
  cache: {
    hits: number;
    misses: number;
    invalidations: number;
    replacements: number;
    hit_rate: number;
    caching_llm: Record<string, unknown>;
  };
  edges: {
    count: number;
    avg_cost_mean: number;
    avg_cost_min: number | null;
    avg_cost_max: number | null;
  };
  cache_entries: number;
  occupancy: { current: number; limit: number; over_threshold: boolean } | null;
}

/**
 * 组装路径统计（assemble_stats op 回传）：stats 四计数器（进程内跨
 * 调用累计）+ 缓存条目量。注意：不引用任何缓存存储的内部 stats 方法，
 * 仅消费 op 回传的聚合统计。
 */
export interface AssembleStats {
  ok: boolean;
  stats: {
    cache_hits: number;
    cache_misses: number;
    cache_invalidations: number;
    cache_replacements: number;
  };
  cache_entries: number;
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

/** 回合账本事件（确定性归约后的事实要点）。 */
export interface RoundLedgerEvent {
  kind: string;
  at: number;
  detail: Record<string, unknown>;
}

/** 回合账本（结构化事实快照：意图/结论/事实要点/回合指标）。 */
export interface RoundLedgerItem {
  schema?: string;
  thread_id: string;
  round_id: string;
  created_at: number;
  intent?: string | null;
  conclusion?: string | null;
  events?: RoundLedgerEvent[];
  turn_metrics?: Record<string, unknown>;
  audit_events?: unknown[];
  summary?: string | null;
}

/** 回合账本清单（某线程全部账本，按时间序）。 */
export interface RoundLedgerList {
  thread_id: string;
  ledgers: RoundLedgerItem[];
}

/** 回合账本摘要链（线程 append-only 阶段性小结）。 */
export interface RoundLedgerChain {
  thread_id: string;
  chain: string[];
}

/** 待办清单条目（task_manager 维护的持久化清单）。 */
export interface TodoEntry {
  id: string;
  title: string;
  detail?: string | null;
  priority: string;
  status: 'pending' | 'doing' | 'done' | 'cancelled' | 'blocked';
  evidence?: string | null;
  order: number;
  created_at: number;
  updated_at: number;
  completed_at?: number | null;
}

/** 待办清单读取结果（todo.get op）。 */
export interface TodoList {
  thread_id: string;
  entries: TodoEntry[];
  total: number;
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
    mode?: 'standard' | 'assembly',
    model?: ModelSelection,
  ): Promise<RoundResult>;
  roundAbort(roundId: string): Promise<{ aborted: boolean }>;
  roundResume(
    threadId: string,
    key: string,
    decision: string,
    reason?: string,
    editedContent?: unknown,
  ): Promise<{
    reason: string;
    output: unknown;
    events: unknown[];
    steps: unknown[];
    round_id: string;
  }>;
  routePlan(text: string, tier: string): Promise<RoutePlanResult>;
  sessionList(): Promise<SessionRemoteRecord[]>;
  sessionCreate(): Promise<SessionRemoteRecord>;
  sessionRename(threadId: string, title: string): Promise<SessionRemoteRecord>;
  sessionDelete(threadId: string): Promise<unknown>;
  sessionRefresh(threadId: string): Promise<SessionRemoteRecord>;
  /** 会话历史消息回取（冷启动/切会话：引擎最新检查点消息恢复）。 */
  sessionMessages(threadId: string): Promise<unknown[]>;
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
  openPath(path: string): Promise<void>;
  mountList(): Promise<string[]>;
  mountAuthorize(path: string): Promise<string[]>;
  offlineSettingsGet(): Promise<Record<string, unknown>>;
  offlineSettingsPut(settings: Record<string, unknown>): Promise<unknown>;
  voiceStatus(): Promise<Record<string, unknown>>;
  offlineDetect(): Promise<Record<string, unknown>>;
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
  capabilityGet(): Promise<{
    simulation_tier?: string;
    auto_approve_tools?: string[];
    auto_approve_all_review?: boolean;
    tier_overrides?: Record<string, string>;
    max_tool_rounds?: number;
    ui_spec?: unknown;
  }>;
  capabilityPut(record: Record<string, unknown>): Promise<unknown>;
  /** 逐工具档位覆盖（权限矩阵写面：工具 tab 档位编辑 → 引擎安全域 + 能力记录持久化）。 */
  securityTierOverridesSet(overrides: Record<string, string>): Promise<unknown>;
  backupExport(dest: string): Promise<{ entries: number; size: number; has_db: boolean }>;
  backupPreview(path: string): Promise<BackupPreview>;
  backupRestore(path: string): Promise<{ restored_entries: number; snapshot: string }>;
  recoverySnapshots(): Promise<{ snapshots: RecoverySnapshot[] }>;
  recoveryRestoreSnapshot(name: string): Promise<{ restored: string; chain_version: number }>;
  recoveryFactoryReset(): Promise<{ reverted_patches: number[]; overwritten: boolean }>;
  // 回合账本（事实快照流 / 摘要链 / 压缩触发）
  roundLedgerList(threadId: string): Promise<RoundLedgerList>;
  roundLedgerChain(threadId: string): Promise<RoundLedgerChain>;
  roundLedgerMerge(threadId: string): Promise<unknown>;
  // 待办清单（task_manager 持久化清单只读面；顶栏临时标签数据源）
  todoGet(threadId: string): Promise<TodoList>;
  toolsSnapshot(): Promise<{ tools: ToolSnapshotEntry[] }>;
  toolsManifest(): Promise<{ tools: ToolManifestEntry[]; baseline: string[] }>;
  toolsBaselineGet(): Promise<{ tools: string[] }>;
  toolsBaselineSet(tools: string[]): Promise<{ tools: string[] }>;
  /** 出厂界面组件启停状态（factory/disabled/active 三清单；组件 tab 数据源）。 */
  uiComponentsGet(): Promise<{ factory: string[]; disabled: string[]; active: string[] }>;
  uiComponentsSetDisabled(disabled: string[]): Promise<{ disabled: string[] }>;
  componentsManifest(): Promise<{ artifacts: ArtifactManifestEntry[] }>;
  knowledgeGraph(): Promise<KnowledgeGraphResult>;
  // MCP 市场（连接页市场管理 + 市场页服务挂载/卸载）
  mcpMarketStatus(): Promise<McpMountStatus>;
  mcpMarketMount(serverId: string): Promise<McpMountOutcome>;
  mcpMarketUnmount(serverId: string): Promise<McpMountOutcome>;
  mcpMarketPreview(link: string): Promise<McpMarketPreview>;
  mcpMarketAdd(link: string): Promise<{ ok: boolean; market?: McpMarketSummary; error?: string }>;
  mcpMarketRemove(marketId: string): Promise<{ ok: boolean; error?: string; unmounted?: Array<{ server_id: string; ok: boolean; status?: string }> }>;
  // 可观测数据面（仪表 / 模型选择器数据源）
  modelArchiveSnapshot(): Promise<ModelArchiveSnapshot>;
  metricsSnapshot(): Promise<TurnMetricsSnapshot>;
  assembleStats(): Promise<AssembleStats>;
  // 接线面后端桥 op（壳内嵌桥命令，生产透传；无宿主回落不可用）
  graphSnapshot(): Promise<unknown>;
  graphInstanceSnapshot(threadId: string): Promise<unknown>;
  poolSnapshot(): Promise<unknown>;
  poolEvaluate(): Promise<unknown>;
  entitiesSnapshot(): Promise<unknown>;
  edgeEvidenceList(): Promise<unknown>;
  edgeEvidenceUpdate(edgeId: string, patch: Record<string, unknown>): Promise<unknown>;
  pathAssemble(): Promise<unknown>;
  pathClearCandidate(): Promise<unknown>;
  pathSetAssemblerEnabled(enabled: boolean): Promise<unknown>;
  cacheStats(): Promise<unknown>;
  cacheClear(): Promise<unknown>;
  // 干预 op（前端契约；壳侧落地由另一道负责）
  // 返回形态由引擎 op 决定（键名引擎侧定），此处统一宽松透传、不做假契约
  chooseCandidate(candidateId: string | null): Promise<Record<string, unknown>>;
  setMultipath(enabled: boolean): Promise<Record<string, unknown>>;
  invalidateCache(scope: string): Promise<Record<string, unknown>>;
  downgradeEdgeTier(edgeId: string): Promise<Record<string, unknown>>;
  rebuildCache(scope: string): Promise<Record<string, unknown>>;
  restoreEdgeTier(edgeId: string): Promise<Record<string, unknown>>;
  // 既有资料批量导入（搬进 InKEngine 第一步）：扫描预览 + 入料
  materialScan(path: string, recursive?: boolean): Promise<MaterialScanResult>;
  materialIngest(path: string, recursive?: boolean): Promise<MaterialImportResult>;
  // 界面编辑器（W4.2 补丁链落链面）：读取活跃界面描述 / 落链 / 回退最近界面补丁
  uiSpecGet(): Promise<{ spec: Record<string, unknown> | null }>;
  uiSpecApply(spec: Record<string, unknown>): Promise<{ outcome: unknown }>;
  uiSpecRevert(): Promise<{ outcome: unknown; reason?: string }>;
  // 模型连接配置运行期重载（设置页保存后使引擎感知新配置）
  modelReload(): Promise<{ reloaded: boolean }>;
  // 设置节单通道收口（模型连接配置 / 搜索 key / 成长状态 / 原生目录选择器）
  searchKeysPut(keys: Record<string, string>): Promise<unknown>;
  growthReport(): Promise<{ growth?: Record<string, unknown>; knowledge_count?: number; metrics?: unknown }>;
  modelsRefresh(config: Record<string, unknown>): Promise<unknown>;
  modelsConfigGet(): Promise<Record<string, unknown>>;
  modelsConfigPut(config: Record<string, unknown>): Promise<unknown>;
  openDirectoryDialog(options: { title: string; directory: boolean; multiple: boolean }): Promise<string[] | null>;
  // 知识集条目管理（knowledge.* 命令；知识面板数据面）
  knowledgeList(includeArchived?: boolean): Promise<{ entries: unknown[] }>;
  knowledgeAdd(input: Record<string, unknown>): Promise<unknown>;
  knowledgePromote(id: string): Promise<unknown>;
  knowledgeArchive(id: string): Promise<unknown>;
  knowledgeRestore(id: string): Promise<unknown>;
  knowledgeExport(id: string): Promise<unknown>;
  skillImport(source: string, preview?: boolean): Promise<unknown>;
  skillReimport(id: string): Promise<unknown>;
  // 记忆条目（memory.* 命令；记忆面板数据面）
  memoryList(): Promise<{ entries: unknown[] }>;
  memoryInvalidate(id: string): Promise<unknown>;
  memoryUpdateFrontmatter(id: string, frontmatter: Record<string, unknown>): Promise<unknown>;
  // 审计流水（audit.list；洞察时间线底账）。可选窗口参数：limit（条数
  // 上限）/ before / after（epoch 秒时间窗）——防前端一次拉全量审计集合。
  auditList(opts?: { limit?: number; before?: number; after?: number }): Promise<unknown>;
  // 语音（输入胶囊语音入口）
  voiceRecord(durationMs: number): Promise<number[]>;
  voiceTranscribe(audio: number[]): Promise<{ text?: string }>;
  voiceSynthesize(text: string): Promise<unknown>;
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
    sessionMessages: unavailable as never,
    sessionTree: unavailable as never,
    sessionBranch: unavailable as never,
    authorizationState: unavailable as never,
    workspaceAuthorize: unavailable as never,
    workspaceRevoke: unavailable as never,
    openPath: unavailable as never,
    mountList: unavailable as never,
    mountAuthorize: unavailable as never,
    offlineSettingsGet: unavailable as never,
    offlineSettingsPut: unavailable as never,
    voiceStatus: unavailable as never,
    offlineDetect: unavailable as never,
    approvalRequest: unavailable as never,
    approvalResolve: unavailable as never,
    capabilityGet: unavailable as never,
    capabilityPut: unavailable as never,
    securityTierOverridesSet: unavailable as never,
    backupExport: unavailable as never,
    backupPreview: unavailable as never,
    backupRestore: unavailable as never,
    recoverySnapshots: unavailable as never,
    recoveryRestoreSnapshot: unavailable as never,
    recoveryFactoryReset: unavailable as never,
    roundLedgerList: unavailable as never,
    roundLedgerChain: unavailable as never,
    roundLedgerMerge: unavailable as never,
    todoGet: unavailable as never,
    toolsSnapshot: unavailable as never,
    toolsManifest: unavailable as never,
    toolsBaselineGet: unavailable as never,
    toolsBaselineSet: unavailable as never,
    uiComponentsGet: unavailable as never,
    uiComponentsSetDisabled: unavailable as never,
    componentsManifest: unavailable as never,
    knowledgeGraph: unavailable as never,
    mcpMarketStatus: unavailable as never,
    mcpMarketMount: unavailable as never,
    mcpMarketUnmount: unavailable as never,
    mcpMarketPreview: unavailable as never,
    mcpMarketAdd: unavailable as never,
    mcpMarketRemove: unavailable as never,
    rebuildCache: unavailable as never,
    restoreEdgeTier: unavailable as never,
    modelArchiveSnapshot: unavailable as never,
    metricsSnapshot: unavailable as never,
    assembleStats: unavailable as never,
    graphSnapshot: unavailable as never,
    graphInstanceSnapshot: unavailable as never,
    poolSnapshot: unavailable as never,
    poolEvaluate: unavailable as never,
    entitiesSnapshot: unavailable as never,
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
    uiSpecGet: unavailable as never,
    uiSpecApply: unavailable as never,
    uiSpecRevert: unavailable as never,
    modelReload: unavailable as never,
    searchKeysPut: unavailable as never,
    growthReport: unavailable as never,
    modelsRefresh: unavailable as never,
    modelsConfigGet: unavailable as never,
    modelsConfigPut: unavailable as never,
    openDirectoryDialog: unavailable as never,
    knowledgeList: unavailable as never,
    knowledgeAdd: unavailable as never,
    knowledgePromote: unavailable as never,
    knowledgeArchive: unavailable as never,
    knowledgeRestore: unavailable as never,
    knowledgeExport: unavailable as never,
    skillImport: unavailable as never,
    skillReimport: unavailable as never,
    memoryList: unavailable as never,
    memoryInvalidate: unavailable as never,
    memoryUpdateFrontmatter: unavailable as never,
    auditList: unavailable as never,
    voiceRecord: unavailable as never,
    voiceTranscribe: unavailable as never,
    voiceSynthesize: unavailable as never,
  };
}

/** 宿主桥适配器（Tauri invoke 直调；缺宿主 = 不可用适配器）。 */
export function createTauriBackend(invoker?: TauriInvoker): BackendAdapter {
  const transport = invoker ?? createTauriInvoker();
  if (!transport) return createUnavailableBackend();
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      const raw = await transport.invoke(cmd, args);
      return raw as T;
    } catch (err) {
      handleEngineError(cmd, err);
      throw err;
    }
  };
  return {
    available: true,
    status: () => call('backend_status'),
    engineBoot: () => call('engine_boot'),
    firstRunDismiss: () => call('first_run_dismiss'),
    roundSend: (threadId, roundId, text, autoAccept, attachments, mode, model) =>
      call('round_send', {
        threadId,
        roundId,
        text,
        autoAcceptReview: autoAccept,
        ...(attachments ? { attachments } : {}),
        ...(mode && mode !== 'standard' ? { mode } : {}),
        ...(model ? { model } : {}),
      }),
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
    sessionMessages: async (threadId) => {
      const result = await call<{ messages: unknown[] }>('session_messages', { threadId });
      return result.messages ?? [];
    },
    sessionTree: (threadId) => call('session_tree', { threadId }),
    sessionBranch: (threadId, action, targetLeaf, editText) =>
      call('session_branch', { threadId, action, targetLeaf, editText }),
    authorizationState: () => call('authorization_state'),
    workspaceAuthorize: (path) => call('workspace_authorize', { path }),
    workspaceRevoke: () => call('workspace_revoke'),
    openPath: (path) => call('shell_open_path', { path }),
    mountList: () => call('mount_list'),
    mountAuthorize: (path) => call('mount_authorize', { path }),
    offlineSettingsGet: () => call('offline_settings_get'),
    offlineSettingsPut: (settings) => call('offline_settings_put', { settings }),
    voiceStatus: () => call('voice_status'),
    offlineDetect: () => call('offline_detect'),
    approvalRequest: (threadId, key, action, payload) =>
      call('approval_request', { threadId, key, action, payload }),
    approvalResolve: (threadId, key, decision, reason, editedContent) =>
      call('approval_resolve', { threadId, key, decision, reason, editedContent }),
    capabilityGet: () => call('capability_get'),
    capabilityPut: (record) => call('capability_put', { record }),
    securityTierOverridesSet: (overrides) => call('security_tier_overrides_set', { overrides }),
    backupExport: (dest) => call('backup_export', { dest }),
    backupPreview: (path) => call('backup_preview', { path }),
    backupRestore: (path) => call('backup_restore', { path }),
    recoverySnapshots: () => call('recovery_snapshots'),
    recoveryRestoreSnapshot: (name) => call('recovery_restore_snapshot', { name }),
    recoveryFactoryReset: () => call('recovery_factory_reset'),
    roundLedgerList: (threadId) => call('round_ledger_list', { threadId }),
    roundLedgerChain: (threadId) => call('round_ledger_chain', { threadId }),
    roundLedgerMerge: (threadId) => call('round_ledger_merge', { threadId }),
    // todo.get 走薄转发 args 面（引擎 op 按 thread_id 取键）
    todoGet: (threadId) => call('todo.get', { args: { thread_id: threadId } }),
    toolsSnapshot: () => call('tools_snapshot'),
    toolsManifest: () => call('tools_manifest'),
    toolsBaselineGet: () => call('tools_baseline_get'),
    toolsBaselineSet: (tools) => call('tools_baseline_set', { tools }),
    uiComponentsGet: () => call('ui_components.get'),
    uiComponentsSetDisabled: (disabled) => call('ui_components.set_disabled', { args: { disabled } }),
    componentsManifest: () => call('components_manifest'),
    mcpMarketStatus: () => call('mcp_market_status'),
    mcpMarketMount: (serverId) => call('mcp_market_mount', { serverId }),
    mcpMarketUnmount: (serverId) => call('mcp_market_unmount', { serverId }),
    mcpMarketPreview: (link) => call('mcp_market_preview', { link }),
    mcpMarketAdd: (link) => call('mcp_market_add', { link }),
    mcpMarketRemove: (marketId) => call('mcp_market_remove', { marketId }),
    modelArchiveSnapshot: () => call('model_archive_snapshot'),
    // metrics.snapshot 壳命令参数为 args（非 Option），无参调用须显式空对象
    metricsSnapshot: () => call('metrics_snapshot', { args: {} }),
    assembleStats: () => call('assemble_stats'),
    graphSnapshot: () => call('graph_snapshot'),
    graphInstanceSnapshot: (threadId) => call('graph_instance_snapshot', { args: { thread_id: threadId } }),
    poolSnapshot: () => call('pool_snapshot'),
    poolEvaluate: () => call('pool_evaluate'),
    entitiesSnapshot: () => call('entities_snapshot'),
    edgeEvidenceList: () => call('edge_evidence_list'),
    edgeEvidenceUpdate: (edgeId, patch) =>
      call('edge_evidence_update', { args: { edgeId, ...(patch as Record<string, unknown>) } }),
    pathAssemble: () => call('path_assemble'),
    pathClearCandidate: () => call('path_clear_candidate'),
    pathSetAssemblerEnabled: (enabled) => call('path_set_assembler_enabled', { args: { enabled } }),
    cacheStats: () => call('cache_stats'),
    cacheClear: () => call('cache_clear'),
    chooseCandidate: (candidateId) => call('path_choose_candidate', { candidateId }),
    setMultipath: (enabled) => call('path_set_multipath', { enabled }),
    invalidateCache: (scope) => call('cache_invalidate', { scope }),
    downgradeEdgeTier: (edgeId) => call('edge_downgrade_tier', { edgeId }),
    rebuildCache: (scope) => call('cache_rebuild', { domain: scope }),
    restoreEdgeTier: (edgeId) => call('edge_restore_tier', { edgeId }),
    knowledgeGraph: () => call('knowledge.graph'),
    materialScan: (path, recursive) => call('material_import', { path, recursive, ingest: false }),
    materialIngest: (path, recursive) => call('material_import', { path, recursive, ingest: true }),
    uiSpecGet: () => call('ui_spec.get'),
    uiSpecApply: (spec) => call('ui_spec.apply', { args: { spec } }),
    uiSpecRevert: () => call('ui_spec.revert_latest'),
    modelReload: () => call('model.reload'),
    searchKeysPut: (keys) => call('search_keys_put', { keys }),
    growthReport: () => call('growth.report'),
    modelsRefresh: (config) => call('models_refresh', { config }),
    modelsConfigGet: () => call('models_config_get'),
    modelsConfigPut: (config) => call('models_config_put', { config }),
    openDirectoryDialog: (options) =>
      // tauri-plugin-dialog 2.x 的 open 命令参数为 options: OpenDialogOptions（单键），
      // 须包一层 options；扁平 title/directory/multiple 顶层字段会缺 options 键报错
      call<string | string[] | null>('plugin:dialog|open', { options }).then((picked) => {
        if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
        return picked ? [picked] : null;
      }),
    knowledgeList: (includeArchived) =>
      call('knowledge.list', { args: { includeArchived: !!includeArchived } }),
    knowledgeAdd: (input) => call('knowledge.add', { args: input }),
    knowledgePromote: (id) => call('knowledge.promote', { args: { id } }),
    knowledgeArchive: (id) => call('knowledge.archive', { args: { id } }),
    knowledgeRestore: (id) => call('knowledge.restore', { args: { id } }),
    knowledgeExport: (id) => call('knowledge.export', { args: { id } }),
    skillImport: (source, preview) => call('knowledge.skill_import', { args: { source, preview } }),
    skillReimport: (id) => call('knowledge.skill_reimport', { args: { id } }),
    memoryList: () => call('memory.list'),
    memoryInvalidate: (id) => call('memory.invalidate', { args: { id } }),
    memoryUpdateFrontmatter: (id, frontmatter) =>
      call('memory.update_frontmatter', { args: { id, frontmatter } }),
    auditList: (opts) => (opts ? call('audit.list', { args: opts }) : call('audit.list')),
    voiceRecord: (durationMs) => call('voice_record', { durationMs }),
    voiceTranscribe: (audio) => call('voice_transcribe', { audio }),
    voiceSynthesize: (text) => call('voice_synthesize', { text }),
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

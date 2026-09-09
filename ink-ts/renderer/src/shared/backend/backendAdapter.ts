// gate: 超限(605 行) - 宿主命令面注册表（BackendAdapter 接口与通道映射成对同文件防漂移）
/**
 * 后端适配器（可注入）：会话/回合/授权/工具/审计/备份/恢复/知识/记忆/演化读面的宿主面。
 *
 * 前端不直接感知传输：所有宿主交互经本适配器接口，生产 = serve 通道
 * （cli serve http/ws，request(method, params) 直调），测试 = mock 后端
 * 注入（同一契约）；通道不可用时 `available=false`，应用回落夹具路径
 * （浏览器 dev / serve 未就绪环境）。
 *
 * 命令面纪律（W1 接线）：方法映射到 host bridge 点分方法（BRIDGE_METHODS）
 * 或其扁平旧名别名（hosts/cli/src/legacy_aliases.ts）；无真源命令（shell_open_path、
 * offline、approval_request/resolve、round_ledger_merge、mcp_market_preview/
 * add/remove、knowledge 写类、path/cache 干预、ui_spec 等）一律不在此登记——
 * 调用面在 W1 已随入口删除。危险操作（recovery.reset / backup.restore）在此
 * 侧补 confirm 固定标记（宿主 fail-closed 拒绝缺标记调用）。
 */

import { getServeChannel, handleEngineError, type ServeChannel } from './transport';

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

/** 回合结果（引擎事件流 + 步骤序列；驱动侧只消费落定/失败语义）。 */
export interface RoundResult {
  round_id: string;
  thread_id: string;
  reason: string;
  output: string | null;
  events: Array<Record<string, unknown>>;
  steps: Array<unknown>;
}

/** 备份清单预览（恢复向导的面）。 */
export interface BackupPreview {
  entries_total: number;
  will_overwrite: number;
  total_size: number;
  has_db: boolean;
  created_at: number;
}

/** 会话链可回退点（recovery.checkpoints 投影；thread 上下文取用面）。 */
export interface RecoveryCheckpoint {
  checkpoint_id: number;
  parent_id: number | null;
  reason: string | null;
  graph_path: string[];
}

/** 会话链回退点清单（当前活动会话 thread_id 为上下文；无活动会话 = 空态）。 */
export interface RecoveryCheckpointsView {
  thread_id: string;
  latest: number | null;
  points: RecoveryCheckpoint[];
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

/** tools.full 全量工具视图（设置页「工具」管理面数据源：消费旗标同源）。 */
export interface ToolFullRow {
  name: string;
  uses_vectors: boolean;
  vector: boolean;
  baseline: boolean;
  approved: boolean;
  enabled: boolean;
}

/** tools.full 出参（uses_vectors 全局态 + degraded_reason?）。 */
export interface ToolFullView {
  uses_vectors: boolean;
  degraded_reason?: string | null;
  tools: ToolFullRow[];
}

/** MCP 工具型插件服务行（plugins/mcp/<id>/spec.json 派生 + 运行态）。 */
export interface McpPluginServerView {
  id: string;
  name: string;
  source: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  risk?: string;
  risk_note?: string;
  category?: string;
  /** 已启用（台账启用集命中）。 */
  enabled: boolean;
  /** 会话已连接（stdio 进程在场）。 */
  connected: boolean;
  /** 已导入工具数。 */
  tool_count: number;
  error?: string | null;
}

/** mcp.status 出参（候选清单 + 运行态；真源目录扫描）。 */
export interface McpPluginStatusData {
  source: string;
  servers: McpPluginServerView[];
}

/** 启停结果信封（enable 带已导入工具名；disable 摘除后 tool_count=0）。 */
export interface McpPluginOutcome {
  ok: boolean;
  server_id: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  tool_count: number;
  tools?: string[];
  error?: string | null;
}

/** 回合级模型选择（输入框选定；无默认、无档位——选什么跑什么）。 */
export interface ModelSelection {
  provider?: string;
  model_id: string;
  reasoning_effort?: string;
  /** 推理开关（boolean 语义模型；未设 = 不注入跟随模型默认）。 */
  enable_thinking?: boolean;
  /** 推理 token 预算（budget 语义模型；未设 = 不注入跟随模型默认）。 */
  thinking_budget?: number;
}

/**
 * 弹卡档位（对话输入框三档，统一治理「需确认调用」的裁定姿态）：
 * - review（默认）：需确认调用一律弹卡；
 * - auto：免弹直过，缺准入自动授予（自动转正，审计 + 可回退）；
 * - deny：免问直拒。
 * 机制校验（沙箱边界/越界/L2 vetting）不是档位，任何档都执行不跳过。
 */
export type ApprovalPose = 'auto' | 'review' | 'deny';

/** 模型档案条目（壳侧 model_archive.sqlite 记录形态；多模态三态）。 */
export interface ModelArchiveRow {
  model_id: string;
  /** 归属厂商（TS host providers 面每模型一行；输入框选模型回指用）。 */
  provider_id?: string;
  context_window?: number;
  multimodal?: boolean | 'true' | 'false' | 'unknown';
  /** 推理能力（官配厂商档案透传；未声明/未知 = undefined）。 */
  reasoning?: boolean;
  reasoning_style?: 'effort' | 'boolean' | 'budget' | 'none';
  reasoning_efforts?: string[];
  /** budget 语义的可选 token 预算（模型声明；未声明 = 不显示 budget 控件）。 */
  reasoning_budget?: number[];
  metadata?: Record<string, unknown>;
  discovered_at?: string;
}

/** 模型档案快照（Rust model_archive_snapshot 契约：ok + archives）。 */
export interface ModelArchiveSnapshot {
  ok?: boolean;
  archives: ModelArchiveRow[];
}

/** metrics.snapshot 出参（回合数/失败数/avg 失败率 + 角色槽调用分布）。 */
export interface MetricsSnapshotView {
  available: boolean;
  rounds: number;
  failures: number;
  avg: number;
  last_error: string | null;
  llm_calls_by_role: Record<string, number>;
}

/** rounds.todos 单行（计划未完成步骤 / 挂起审批卡）。 */
export interface RoundTodoRow {
  id: string;
  label: string;
  status: string;
  kind: string;
}

/** rounds.todos 出参（空清单 = 顶栏标签不亮）。 */
export interface RoundTodoList {
  thread_id: string;
  todo: RoundTodoRow[];
}

/** growth.report 出参（enabled + config_summary + weights_snapshot?）。 */
export interface GrowthReport {
  enabled: boolean;
  config_summary: Record<string, unknown> | null;
  weights_snapshot?: Record<string, unknown> | null;
  last_tuned_at?: number | null;
}

/** 知识集条目窗口（knowledge.list 行；只读面渲染视图）。 */
export interface KnowledgeEntryView {
  id: string;
  level: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  tags: string[];
  archived: boolean;
  usage_failures: Array<{ at: number | null; reason: string }>;
  created_at: number;
  updated_at: number;
}

/** 记忆条目窗口（memory.list 行）。 */
export interface MemoryEntryView {
  id: string;
  namespace: string;
  kind: string;
  title: string;
  content: string;
  source: string;
  credibility: number;
  expires_at: number | null;
  created_at: number;
}

/** 后端适配器接口（生产 = 宿主桥；测试 = mock）。 */
export interface BackendAdapter {
  /** 宿主可用性（false = 回落夹具路径）。 */
  available: boolean;
  roundSend(
    threadId: string,
    roundId: string,
    text: string,
    autoAccept?: boolean,
    attachments?: Array<{ kind: string; url: string; path?: string; name?: string; mime?: string }>,
    model?: ModelSelection,
    pose?: string,
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
  sessionList(): Promise<SessionRemoteRecord[]>;
  sessionCreate(): Promise<SessionRemoteRecord>;
  sessionRename(threadId: string, title: string): Promise<SessionRemoteRecord>;
  sessionDelete(threadId: string): Promise<unknown>;
  sessionRefresh(threadId: string): Promise<SessionRemoteRecord>;
  /** 会话历史消息回取（冷启动/切会话：records.chain 投影消息行）。 */
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
  mountList(): Promise<string[]>;
  mountAuthorize(path: string): Promise<string[]>;
  capabilityGet(): Promise<{
    auto_approve_tools?: string[];
    auto_approve_all_review?: boolean;
    tier_overrides?: Record<string, string>;
    max_tool_rounds?: number;
    ui_spec?: unknown;
  }>;
  capabilityPut(record: Record<string, unknown>): Promise<unknown>;
  backupExport(dest: string): Promise<{ entries: number; size: number; has_db: boolean }>;
  backupPreview(path: string): Promise<BackupPreview>;
  /** 备份恢复（confirm 标记 'backup-restore' 随调下发，宿主 fail-closed）。 */
  backupRestore(path: string): Promise<{ restored_entries: number; snapshot: string }>;
  /** 会话链可回退点（recovery.checkpoints；thread_id 为必带上下文）。 */
  recoverySnapshots(threadId: string): Promise<RecoveryCheckpointsView>;
  /** 会话链回退（recovery.rollback；checkpointId 缺省 = 链尾父锚点）。 */
  recoveryRestoreSnapshot(threadId: string, checkpointId?: number | null): Promise<{
    thread_id: string;
    target: number | null;
    deleted: number[];
    current_leaf: number | null;
  }>;
  /** 出厂重置（confirm 标记 'factory-reset' 随调下发，宿主 fail-closed）。 */
  recoveryFactoryReset(): Promise<{ reverted_patches: number[]; overwritten: boolean }>;
  // 待办（rounds.todos：计划未完成步骤 + 挂起审批卡）
  todoGet(threadId: string): Promise<RoundTodoList>;
  toolsManifest(): Promise<ToolFullView>;
  toolsBaselineGet(): Promise<{ tools: string[] }>;
  toolsBaselineSet(tools: string[]): Promise<{ tools: string[] }>;
  /** 出厂界面组件启停状态（factory/disabled/active 三清单；组件 tab 数据源）。 */
  uiComponentsGet(): Promise<{ factory: string[]; disabled: string[]; active: string[] }>;
  uiComponentsSetDisabled(disabled: string[]): Promise<{ disabled: string[] }>;
  // MCP 工具型插件启停（status/enable/disable；市场命令面已退役）
  mcpPluginStatus(): Promise<McpPluginStatusData>;
  mcpPluginEnable(id: string): Promise<McpPluginOutcome>;
  mcpPluginDisable(id: string): Promise<McpPluginOutcome>;
  // 可观测数据面（仪表 / 模型选择器数据源）
  modelArchiveSnapshot(): Promise<ModelArchiveSnapshot>;
  metricsSnapshot(): Promise<MetricsSnapshotView>;
  assembleStats(): Promise<unknown>;
  // 架构/演化读取类（graph instance/pool/edge/metrics/assemble/cache/path/entities 只读投影）
  graphInstanceSnapshot(threadId: string): Promise<unknown>;
  poolSnapshot(): Promise<unknown>;
  poolEvaluate(proposal: Record<string, unknown>): Promise<unknown>;
  entitiesSnapshot(): Promise<unknown>;
  edgeEvidenceList(): Promise<unknown>;
  cacheStats(): Promise<unknown>;
  /** path_assembler 装配状态（path.state 点分读面；无装配 = available:false 空态）。 */
  pathState(): Promise<unknown>;
  // 模型连接配置运行期重载（设置页保存后使引擎感知新配置）
  modelReload(): Promise<{ reloaded: boolean }>;
  // 设置节单通道收口（搜索 key / 成长状态 / 原生目录选择器）
  searchKeysPut(keys: Record<string, string>): Promise<unknown>;
  growthReport(): Promise<GrowthReport>;
  modelsRefresh(config: Record<string, unknown>): Promise<unknown>;
  modelsConfigGet(): Promise<Record<string, unknown>>;
  modelsConfigPut(config: Record<string, unknown>): Promise<unknown>;
  /** 角色槽模型指派（agent = 对话模型；router = 功能槽）。 */
  modelsRolePick(
    role: 'agent' | 'router',
    providerId: string,
    modelId: string,
  ): Promise<unknown>;
  openDirectoryDialog(options: { title: string; directory: boolean; multiple: boolean }): Promise<string[] | null>;
  // 知识集只读面（写操作不提供；web 删除写入口）
  knowledgeList(includeArchived?: boolean): Promise<{ entries: KnowledgeEntryView[] }>;
  knowledgeGraph(): Promise<KnowledgeGraphResult>;
  /** 知识 JSON 导出串（无 kind = 全量补丁链可移植；kind = 单类子集）。 */
  knowledgeExport(kind?: string): Promise<string>;
  // 记忆条目（读面 + 批量失效；update_frontmatter 不提供）
  memoryList(): Promise<{ namespaces: Array<{ name: string; count: number }>; entries: MemoryEntryView[] }>;
  memoryInvalidate(id: string): Promise<unknown>;
  // 审计流水（audit.list → {records} 时间倒序窗口）。可选窗口：limit/before/after/kind
  auditList(opts?: { limit?: number; before?: number; after?: number; kind?: string }): Promise<{ records: unknown[] }>;
}

/** 宿主不可用的空适配器（夹具回落的显式形态）。 */
export function createUnavailableBackend(): BackendAdapter {
  const unavailable = (): never => {
    throw new Error('宿主后端不可用（请经桌面壳运行）');
  };
  return {
    available: false,
    roundSend: unavailable as never,
    roundAbort: unavailable as never,
    roundResume: unavailable as never,
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
    mountList: unavailable as never,
    mountAuthorize: unavailable as never,
    capabilityGet: unavailable as never,
    capabilityPut: unavailable as never,
    backupExport: unavailable as never,
    backupPreview: unavailable as never,
    backupRestore: unavailable as never,
    recoverySnapshots: unavailable as never,
    recoveryRestoreSnapshot: unavailable as never,
    recoveryFactoryReset: unavailable as never,
    todoGet: unavailable as never,
    toolsManifest: unavailable as never,
    toolsBaselineGet: unavailable as never,
    toolsBaselineSet: unavailable as never,
    uiComponentsGet: unavailable as never,
    uiComponentsSetDisabled: unavailable as never,
    mcpPluginStatus: unavailable as never,
    mcpPluginEnable: unavailable as never,
    mcpPluginDisable: unavailable as never,
    modelArchiveSnapshot: unavailable as never,
    metricsSnapshot: unavailable as never,
    assembleStats: unavailable as never,
    graphInstanceSnapshot: unavailable as never,
    poolSnapshot: unavailable as never,
    poolEvaluate: unavailable as never,
    entitiesSnapshot: unavailable as never,
    edgeEvidenceList: unavailable as never,
    cacheStats: unavailable as never,
    pathState: unavailable as never,
    modelReload: unavailable as never,
    searchKeysPut: unavailable as never,
    growthReport: unavailable as never,
    modelsRefresh: unavailable as never,
    modelsConfigGet: unavailable as never,
    modelsConfigPut: unavailable as never,
    modelsRolePick: unavailable as never,
    openDirectoryDialog: unavailable as never,
    knowledgeList: unavailable as never,
    knowledgeGraph: unavailable as never,
    knowledgeExport: unavailable as never,
    memoryList: unavailable as never,
    memoryInvalidate: unavailable as never,
    auditList: unavailable as never,
  };
}

/** 危险操作确认标记（与 host bridge recovery/backup 固定标记同值）。 */
const FACTORY_RESET_CONFIRM = 'factory-reset';
const BACKUP_RESTORE_CONFIRM = 'backup-restore';

/** 宿主通道适配器（serve 通道 request 直调；无可用通道 = 不可用适配器）。 */
export function createServeBackend(channel?: ServeChannel): BackendAdapter {
  const serve = channel ?? getServeChannel();
  if (!serve.available) return createUnavailableBackend();
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      const raw = await serve.request<T>(cmd, args);
      return raw as T;
    } catch (err) {
      handleEngineError(cmd, err);
      throw err;
    }
  };
  return {
    available: true,
    roundSend: (threadId, roundId, text, autoAccept, attachments, model, pose) =>
      call('round_send', {
        threadId,
        roundId,
        text,
        autoAcceptReview: autoAccept,
        ...(attachments ? { attachments } : {}),
        ...(model ? { model } : {}),
        ...(typeof pose === 'string' ? { pose } : {}),
      }),
    roundAbort: (roundId) => call('round_abort', { roundId }),
    roundResume: (threadId, key, decision, reason, editedContent) =>
      call('round_resume', { threadId, key, decision, reason, editedContent }),
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
    authorizationState: async () => {
      const state = await call<{ authorized: boolean; root: string | null }>('workspace.state');
      return { authorized: state.authorized, root: state.root };
    },
    workspaceAuthorize: async (path) => {
      const state = await call<{ authorized: boolean; root: string | null }>('workspace.set', { path });
      return { authorized: state.authorized, root: state.root ?? '' };
    },
    workspaceRevoke: async () => {
      const state = await call<{ authorized: boolean }>('workspace.revoke');
      return { authorized: state.authorized };
    },
    mountList: async () => {
      const state = await call<{ mounts?: string[] }>('workspace.state');
      return state.mounts ?? [];
    },
    mountAuthorize: async (path) => {
      const state = await call<{ mounts?: string[] }>('workspace.mount.add', { path });
      return state.mounts ?? [];
    },
    capabilityGet: () => call('capability_get'),
    capabilityPut: (record) => call('capability_put', { record }),
    backupExport: (dest) => call('backup_export', { dest }),
    backupPreview: (path) => call('backup_preview', { path }),
    backupRestore: (path) =>
      call('backup.restore', { path, confirm: BACKUP_RESTORE_CONFIRM }),
    recoverySnapshots: (threadId) => call('recovery_snapshots', { threadId }),
    recoveryRestoreSnapshot: (threadId, checkpointId) =>
      call('recovery_restore_snapshot', { threadId, checkpointId: checkpointId ?? null }),
    recoveryFactoryReset: () =>
      call('recovery.reset', { confirm: FACTORY_RESET_CONFIRM }),
    todoGet: (threadId) => call('rounds.todos', { thread_id: threadId }),
    toolsManifest: () => call('tools.full'),
    toolsBaselineGet: () => call('tools_baseline_get'),
    toolsBaselineSet: (tools) => call('tools_baseline_set', { tools }),
    uiComponentsGet: () => call('ui_components.get'),
    uiComponentsSetDisabled: (disabled) => call('ui_components.set_disabled', { disabled }),
    mcpPluginStatus: () => call('mcp.status'),
    mcpPluginEnable: (id) => call('mcp.enable', { id }),
    mcpPluginDisable: (id) => call('mcp.disable', { id }),
    modelArchiveSnapshot: () => call('model_archive.snapshot'),
    metricsSnapshot: () => call('metrics.snapshot'),
    assembleStats: () => call('assemble.stats'),
    graphInstanceSnapshot: (threadId) => call('graph.instance', { thread_id: threadId }),
    poolSnapshot: () => call('pool.snapshot'),
    poolEvaluate: (proposal) => call('pool.evaluate', { proposal }),
    entitiesSnapshot: () => call('entities.snapshot'),
    edgeEvidenceList: () => call('edge_evidence.list'),
    cacheStats: () => call('cache.stats'),
    pathState: () => call('path.state'),
    modelReload: () => call('model.reload'),
    searchKeysPut: (keys) => call('search_keys_put', { keys }),
    growthReport: () => call('growth.report'),
    modelsRefresh: (config) => call('models_refresh', { config }),
    modelsConfigGet: () => call('models_config_get'),
    modelsConfigPut: (config) => call('models_config_put', { config }),
    modelsRolePick: (role, providerId, modelId) =>
      call('models.config.role_pick', { role, provider_id: providerId, model_id: modelId }),
    openDirectoryDialog: (options) =>
      call<string | string[] | null>('dialog.open_directory', { options }).then((picked) => {
        if (Array.isArray(picked)) return picked.filter((p): p is string => typeof p === 'string');
        return picked ? [picked] : null;
      }),
    knowledgeList: (includeArchived) =>
      call('knowledge.list', {
        args: { includeArchived: !!includeArchived },
      }).then((result) => result as { entries: KnowledgeEntryView[] }),
    knowledgeGraph: () => call('knowledge.graph'),
    knowledgeExport: (kind) =>
      call<string>('knowledge.export', {
        ...(kind ? { args: { kind } } : {}),
      }),
    memoryList: () =>
      call('memory.list').then((result) => result as {
        namespaces: Array<{ name: string; count: number }>;
        entries: MemoryEntryView[];
      }),
    memoryInvalidate: (id) => call('memory.invalidate', { ids: [id] }),
    auditList: (opts) =>
      call('audit.list', {
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
        ...(opts?.after !== undefined ? { after: opts.after } : {}),
        ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
      }),
  };
}

/** 后端选择（生产 = serve 通道；通道未就绪 = 不可用适配器，调用方回落夹具）。 */
export function createBackend(): BackendAdapter {
  // 允许测试注入（window.__INKLING_TEST_BACKEND__ 形态由测试桩设置）
  const testBackend = (window as unknown as { __INKLING_TEST_BACKEND__?: BackendAdapter })
    .__INKLING_TEST_BACKEND__;
  if (testBackend) return testBackend;
  return createServeBackend();
}

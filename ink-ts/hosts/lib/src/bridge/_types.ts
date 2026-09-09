/**
 * host bridge 数据类型（命令面信封形态）。
 *
 * JSON-RPC 信封错误只回通用、细节走 diag（复用 cli/diag 样式：envelope
 * 层把 handler 异常归一 -32603 generic，本层只声明错误载体与「细节」数据，
 * 不做信封 IO）。BridgeHandler 与 cli 现有 handler 形态结构一致
 * （(params, ctx) => result），host 不 import cli（依赖方向单向下）。
 */

import type { McpClientManager, Runtime } from '@ink-ts/engine';

import type { InkHost } from '../host.js';
import { HOST_SESSIONS_COLLECTION } from '../sessions/model.js';
import type { HostSessionRecord } from '../sessions/model.js';

/** bridge 处理器上下文（与 cli rpc HandlerContext 结构一致，供 cli 直接并入命令面）。 */
export interface BridgeContext {
  autoApprove: boolean;
  signal?: AbortSignal;
}

/** bridge 处理器（方法实现；结果须 JSON 可序列化）。 */
export type BridgeHandler = (
  params: unknown,
  ctx: BridgeContext,
) => Promise<unknown> | unknown;

/** 宿主命令闸（backup.restore 等维护操作期间拒绝并发 bridge 请求）。 */
export interface HostOpGate {
  /** 进行中的维护操作名（null = 空闲）。 */
  readonly op: string | null;
  /** 进入维护操作（已在进行 = 显式报错）。 */
  begin(op: string): void;
  /** 退出维护操作（幂等）。 */
  end(): void;
  /** 断言空闲（维护期间并发请求显式拒绝）。 */
  assertIdle(): void;
}

/** backup.restore 恢复请求（备份条目已在桥层解析；编排闭包消费）。 */
export interface BackupRestoreRequest {
  path: string;
  entries: ReadonlyArray<{ path: string; data: Buffer }>;
  total: number;
  created_at: number | null;
}

/** backup.restore 结果（编排闭包返回；含快照路径与回滚诊断）。 */
export interface BackupRestoreOutcome {
  restored_entries: number;
  failed: number;
  total_size: number;
  snapshot: string;
  /** 数据替换后装配失败 → 已回滚原目录并重建（非空 = 回滚说明）。 */
  rollback_note?: string;
}

/** backup.restore 编排（createHost 注入；backup.ts restore handler 消费）。 */
export type HostRestoreFn = (request: BackupRestoreRequest) => Promise<BackupRestoreOutcome>;

/** 业务/参数错误载体：message 可回给请求方（非内部异常细节），code 供归类。 */
export class BridgeError extends Error {
  readonly code: string;
  /** 可选细节（诊断面；envelope 不回给客户端，细节走 diag）。 */
  readonly details: unknown;

  constructor(message: string, code = 'bridge_error', details: unknown = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export { HOST_SESSIONS_COLLECTION };
export type { HostSessionRecord };

/** 模型运行配置句柄（models.config.* 消费面；createHost 以 InkHost 装配）。
 *  apply = 校验 + 合并 + 关停并置空 _llm（返回掩码当前值）；persist = 当前
 *  model_config 原子写 data_dir/config.json；reload = 从 config.json 重读并应用。 */
export interface ModelConfigHandles {
  apply(input: unknown): Promise<Record<string, unknown>>;
  persist(): Promise<void>;
  reload(): Promise<Record<string, unknown>>;
}

/** bridge 依赖（createHost 装配产物；rounds/records/approval/audit 消费）。 */
export interface HostBridgeDeps {
  runtime: Runtime;
  host: InkHost;
  autoApprove: boolean;
  /** 模型运行配置句柄（models.config.*；缺省 = models 域不可用）。 */
  modelConfig?: ModelConfigHandles;
  /** 附件目录（serve /upload 落盘根；rounds 文档附件解析的授权根）。 */
  attachment_dir?: string;
  /** 单附件文本注入上限（null = 构造缺省）。 */
  docTextCap?: number | null;
  /** 文档解析执行体（rounds 文本注入；缺省 = 跳过解析仅文件名引用）。 */
  docParse?: DocParser;
  /** 厂商模型元数据抓取执行体（model_archive 能力增强；缺省 = 全局 fetch）。 */
  catalogFetch?: import('./model_catalog.js').CatalogFetch;
  /** 检索密钥域（search.keys.set/get + web_search 执行体共用；内存不落盘）。 */
  searchKeys?: SearchKeysStore;
  /** 工作区授权域（workspace.state/set/revoke + mount.*；data_dir 持久化）。 */
  workspace?: WorkspaceStore;
  /** 能力记录域（capability.get/put/baseline/tier；data_dir 持久化）。 */
  capability?: CapabilityStore;
  /** 宿主数据目录（backup.export/restore 与 recovery.reset 的目录根）。 */
  data_dir?: string;
  /** 种子数据目录（mcp 域读该目录内 plugins 源；缺省按包位置探测 plugins/）。 */
  seed_dir?: string;
  /** MCP 管理器（H1 装配段产物；mcp.status/enable/disable 消费）。 */
  mcpManager?: McpClientManager | null;
  /** MCP 工具型插件装载服务（B5；mcp.* 启停语义真源；缺省 = 未装配）。 */
  mcpPlugins?: import('../mcp/plugin.js').McpPluginService | null;
  /** 宿主命令闸（buildBridge 包装各方法；backup.restore 期间拒绝并发）。 */
  gate?: HostOpGate;
  /** backup.restore 恢复编排（createHost 注入：停 → 换 → 装配 → 报告）。 */
  restore?: HostRestoreFn;
  /** 最近在途 run 取消句柄登记（rounds.abort 经 runtime 中止）。 */
}

import type { CapabilityStore } from '../capability/store.js';
import type { DocParser } from '../doc/_types.js';
import type { SearchKeysStore } from '../search/keys.js';
import type { WorkspaceStore } from '../workspace/store.js';
export type { DocParser };
export type { SearchKeysStore };
export type { WorkspaceStore };

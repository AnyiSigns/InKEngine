/**
 * host bridge 命令面装配（buildBridge）：方法集按域分组注册——
 * rounds（send/abort/resume/branch/todos）、records（sessions/链/账本）、
 * sessions（create/rename/delete/refresh/tree/messages）、approval（卡查询/
 * 裁决）、audit（导出/窗口）、tools（全量工具视图）、recovery
 * （回退入口/回退点/重置）、backup（data_dir 快照导出/预览/恢复）、mcp
 * （市场/挂载/卸载）、knowledge（知识集读面）、memory（记忆读面/失效）、
 * growth（自学习报告）、os（OS 执行器受控调用）、search（检索密钥）、
 * material（资料批量导入）、models（模型运行配置）、model_archive（模型
 * 档案快照）、capability（能力记录/基线/档位登记）、policy（策略层路由
 * 预览）、ui_components（出厂组件启停）、workspace（工作区授权/挂载）、
 * dialog（原生目录选择）、graph（图实例摘要）、pool（池治理快照/判定）、
 * edge_evidence（边证据只读窗口）、metrics（回合指标）、assemble（组装链
 * 统计）、cache（缓存计数）、path（装配状态）、entities（实体注册表快照）。
 * 与 cli 现有 host.ping/host.info 并存不冲突
 * （命名空间独立；方法表由 cli 并入命令面）。
 *
 * 方法增删纪律（AGENTS 纪律 3）：本文件是 bridge 方法表单一事实源——
 * 增删方法须同步修改 CODING.md §9 命令面清单。
 */

import type { BridgeHandler, HostBridgeDeps } from './_types.js';
import { buildApprovalHandlers } from './approval.js';
import { buildAssembleHandlers } from './assemble.js';
import { buildAuditHandlers } from './audit.js';
import { buildBackupHandlers } from './backup.js';
import { buildCacheHandlers } from './cache.js';
import { buildCapabilityHandlers } from './capability.js';
import { buildDialogHandlers } from './dialog.js';
import { buildEdgeEvidenceHandlers } from './edge_evidence.js';
import { buildEntitiesHandlers } from './entities.js';
import { buildGraphHandlers } from './graph.js';
import { buildGrowthHandlers } from './growth.js';
import { buildKnowledgeHandlers } from './knowledge.js';
import { buildMaterialHandlers } from './material.js';
import { buildMcpHandlers } from './mcp.js';
import { buildMemoryHandlers } from './memory.js';
import { buildMetricsHandlers } from './metrics.js';
import { buildModelArchiveHandlers } from './model_archive.js';
import { buildModelsHandlers } from './models.js';
import { buildOsHandlers } from './os.js';
import { buildPathHandlers } from './path.js';
import { buildPolicyHandlers } from './policy.js';
import { buildPoolHandlers } from './pool.js';
import { buildRecordsHandlers } from './records.js';
import { buildRecoveryHandlers } from './recovery.js';
import { buildRoundsHandlers } from './rounds.js';
import { buildSearchHandlers } from './search.js';
import { buildSessionsHandlers } from './sessions.js';
import { buildToolsHandlers } from './tools.js';
import { buildTodosHandlers } from './todos.js';
import { buildUiComponentsHandlers } from './ui_components.js';
import { buildWorkspaceHandlers } from './workspace.js';

/** bridge 命令面（域分组方法名清单；声明/文档同步的单一事实源）。 */
export const BRIDGE_METHODS = [
  // rounds：回合驱动（含分支续跑）
  'rounds.send',
  'rounds.abort',
  'rounds.resume',
  'rounds.branch',
  'rounds.todos',
  // records：会话簿记/链记录查询/回合账本窗口
  'records.sessions',
  'records.chain',
  'records.ledger',
  // sessions：会话薄服务（CRUD/刷新/分支树/消息投影）
  'sessions.create',
  'sessions.rename',
  'sessions.delete',
  'sessions.refresh',
  'sessions.tree',
  'sessions.messages',
  // approval：审批卡查询/裁决
  'approval.list',
  'approval.resolve',
  // audit：审计导出/只读窗口
  'audit.export',
  'audit.list',
  // tools：引擎工具注册表全量工具视图
  'tools.full',
  // recovery：可回退点查询/回退入口/重置（confirm 标记 fail-closed）
  'recovery.checkpoints',
  'recovery.rollback',
  'recovery.reset',
  // backup：data_dir 快照导出/预览/恢复（confirm 标记 + 原目录快照）
  'backup.export',
  'backup.preview',
  'backup.restore',
  // mcp：市场浏览（seed 数据 + 挂载态）/挂载/卸载
  'mcp.market',
  'mcp.mount',
  'mcp.unmount',
  // knowledge：知识集读面（list/graph/export）
  'knowledge.list',
  'knowledge.graph',
  'knowledge.export',
  // memory：记忆读面/批量失效
  'memory.list',
  'memory.invalidate',
  // growth：自学习/调参状态报告
  'growth.report',
  // graph：图实例摘要（引擎回合图结构 + 最近一回合执行态）
  'graph.instance',
  // pool：池治理登记快照 / 引擎判定入口（只登记不越权写）
  'pool.snapshot',
  'pool.evaluate',
  // edge_evidence：边证据条目窗口（只读）
  'edge_evidence.list',
  // metrics：回合指标会话窗口（TurnMetrics 投影）
  'metrics.snapshot',
  // assemble：组装链统计（开关位 + 缓存统计 + canary 门）
  'assemble.stats',
  // cache：指纹/多径缓存计数（只读）
  'cache.stats',
  // path：path_assembler 装配状态（挂载/开关/canary/最近组装候选）
  'path.state',
  // entities：实体注册表快照（只读）
  'entities.snapshot',
  // os：受控 OS 执行器调用（headless 显式 --approve 语义）
  'os.run',
  // search：web_search 密钥存取（内存不落盘，web 只回显掩码）
  'search.keys.set',
  'search.keys.get',
  // material：既有资料批量导入（扫描 → doc.parse → 文本/引用入会话）
  'material.import',
  // models：模型运行配置（掩码态查询/校验合并落盘/从文件重载/角色槽指派）
  'models.config.get',
  'models.config.put',
  'models.config.reload',
  'models.config.role_pick',
  // model_archive：模型档案快照（从运行 model_config 聚合，无 sqlite 探测）
  'model_archive.snapshot',
  // capability：能力记录（读档/存档/常驻工具基线/档位登记；data_dir 持久化）
  'capability.get',
  'capability.put',
  'capability.baseline.get',
  'capability.baseline.set',
  'capability.tier.set',
  // policy：策略层路由预览（确定性分类；档位/配额随装配数据输出）
  'policy.route',
  // ui_components：出厂界面组件启停（factory/disabled/active，引擎同源）
  'ui_components.get',
  'ui_components.set_disabled',
  // workspace：工作区授权根/挂载清单（data_dir 持久化）
  'workspace.state',
  'workspace.set',
  'workspace.revoke',
  'workspace.mount.add',
  'workspace.mount.remove',
  // dialog：原生目录选择（exec Rust 稳定原生面；host 中继）
  'dialog.open_directory',
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/**
 * 装配 host bridge 方法表（每 host 实例一次；方法实现闭包持有该 host 的
 * runtime/事件文件传输/会话索引/OS 执行器）。缺省组只含已实现方法——
 * 新增组先实现再登记清单。
 */
export function buildBridge(deps: HostBridgeDeps): ReadonlyMap<string, BridgeHandler> {
  const gate = deps.gate ?? null;
  const wrap = (handler: BridgeHandler): BridgeHandler =>
    gate === null
      ? handler
      : async (params, ctx): Promise<unknown> => {
          gate.assertIdle();
          return handler(params, ctx);
        };
  const groups = [
    buildRoundsHandlers(deps),
    buildTodosHandlers(deps),
    buildRecordsHandlers(deps),
    buildSessionsHandlers(deps),
    buildApprovalHandlers(deps),
    buildAuditHandlers(deps),
    buildToolsHandlers(deps),
    buildRecoveryHandlers(deps),
    buildBackupHandlers(deps),
    buildMcpHandlers(deps),
    buildKnowledgeHandlers(deps),
    buildMemoryHandlers(deps),
    buildGrowthHandlers(deps),
    buildGraphHandlers(deps),
    buildPoolHandlers(deps),
    buildEdgeEvidenceHandlers(deps),
    buildMetricsHandlers(deps),
    buildAssembleHandlers(deps),
    buildCacheHandlers(deps),
    buildPathHandlers(deps),
    buildEntitiesHandlers(deps),
    buildOsHandlers(deps),
    buildSearchHandlers(deps),
    buildMaterialHandlers(deps),
    buildModelsHandlers(deps),
    buildModelArchiveHandlers(deps),
    buildCapabilityHandlers(deps),
    buildPolicyHandlers(),
    buildUiComponentsHandlers(deps),
    buildWorkspaceHandlers(deps.workspace),
    buildDialogHandlers(),
  ];
  const methods = new Map<string, BridgeHandler>();
  for (const group of groups) {
    for (const [name, handler] of group) {
      if (methods.has(name)) {
        throw new Error(`bridge 方法重复注册: ${name}`);
      }
      methods.set(name, handler);
    }
  }
  const declared = new Set<string>(BRIDGE_METHODS);
  for (const name of methods.keys()) {
    if (!declared.has(name)) {
      throw new Error(`bridge 方法未登记 BRIDGE_METHODS: ${name}`);
    }
  }
  for (const name of BRIDGE_METHODS) {
    if (!methods.has(name)) {
      throw new Error(`BRIDGE_METHODS 已声明但未实现: ${name}`);
    }
  }
  // 维护闸包装：restore 期间所有方法（含再次 restore）在入口即被拒绝
  const wrapped = new Map<string, BridgeHandler>();
  for (const [name, handler] of methods) {
    wrapped.set(name, wrap(handler));
  }
  return wrapped;
}

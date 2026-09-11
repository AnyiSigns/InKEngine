/**
 * host bridge 命令面装配（buildBridge）：方法集按域分组注册——
 * rounds（send/abort/resume）、records（sessions/链记录）、
 * sessions（create/rename/delete/refresh/tree/messages）、audit（导出/窗口）、
 * tools（全量工具视图）、recovery（回退入口/回退点/重置）、backup（data_dir
 * 快照导出/预览/恢复）、mcp（市场/挂载/卸载）、knowledge（知识集读面）、
 * memory（记忆读面/失效）、growth（自学习报告）、edge_evidence（边证据只读
 * 窗口）、metrics（回合指标）、entities（实体注册表快照）、os（OS 执行器
 * 受控调用）、search（检索密钥）、material（资料批量导入）、models（模型
 * 运行配置）、model_archive（模型档案快照）、capability（能力记录/基线/档位
 * 登记）、policy（策略层路由预览）、ui_components（出厂组件启停）、workspace
 * （工作区授权/挂载）、dialog（原生目录选择）、execution（执行运行时入口：
 * 作用域转场 + 汇聚点产物，rounds 域并行的执行主线）、evolution（受控演化
 * 入口：临时协作统计结晶 evaluate→闸→落库）。
 * 组装链桥面（assemble/cache/path/pool/skeleton/graph/approval/todos）已随
 * 组装链路退役（W7-B）：graph.instance（组装图投影）与 rounds.todos（计划/
 * 挂起卡投影）数据源随组装退役恒空，审批卡面并入 execution 主线（exec 链
 * 挂卡 + rounds.resume 决议注入）。
 * 与 cli 现有 host.ping/host.info 并存不冲突
 * （命名空间独立；方法表由 cli 并入命令面）。
 *
 * 方法增删纪律（AGENTS 纪律 3）：各域命令声明 = 对应文件导出的
 * `<DOMAIN>_COMMANDS` 元组（方法名唯一真源；实现文件返回与元组键一一对应的
 * 处理器表，编译期强制键集合与声明一致——缺/多/拼错即 typecheck 失败）。
 * 本文件只按序 spread 各域元组派生方法面，不手写方法名；增删方法须同步
 * 修改 CODING.md §9 命令面清单。
 */

import type { BridgeHandler, HostBridgeDeps } from './_types.js';
import { buildAuditCommands, AUDIT_COMMANDS } from './audit.js';
import { buildBackupCommands, BACKUP_COMMANDS } from './backup.js';
import { buildCapabilityCommands, CAPABILITY_COMMANDS } from './capability.js';
import { buildDialogCommands, DIALOG_COMMANDS } from './dialog.js';
import { buildExecutionCommands, EXECUTION_COMMANDS } from './execution.js';
import { buildEvolutionCommands, EVOLUTION_COMMANDS } from './evolution.js';
import { buildEdgeEvidenceCommands, EDGE_EVIDENCE_COMMANDS } from './edge_evidence.js';
import { buildEntitiesCommands, ENTITIES_COMMANDS } from './entities.js';
import { buildGrowthCommands, GROWTH_COMMANDS } from './growth.js';
import { buildKnowledgeCommands, KNOWLEDGE_COMMANDS } from './knowledge.js';
import { buildMaterialCommands, MATERIAL_COMMANDS } from './material.js';
import { buildMcpCommands, MCP_COMMANDS } from './mcp.js';
import { buildMemoryCommands, MEMORY_COMMANDS } from './memory.js';
import { buildMetricsCommands, METRICS_COMMANDS } from './metrics.js';
import { buildModelArchiveCommands, MODEL_ARCHIVE_COMMANDS } from './model_archive.js';
import { buildModelsCommands, MODELS_COMMANDS } from './models.js';
import { buildOsCommands, OS_COMMANDS } from './os.js';
import { buildPolicyCommands, POLICY_COMMANDS } from './policy.js';
import { buildRecordsCommands, RECORDS_COMMANDS } from './records.js';
import { buildRecoveryCommands, RECOVERY_COMMANDS } from './recovery.js';
import { buildRoundsCommands, ROUNDS_COMMANDS } from './rounds.js';
import { buildSearchCommands, SEARCH_COMMANDS } from './search.js';
import { buildSessionsCommands, SESSIONS_COMMANDS } from './sessions.js';
import { buildToolsCommands, TOOLS_COMMANDS } from './tools.js';
import { buildUiComponentsCommands, UI_COMPONENTS_COMMANDS } from './ui_components.js';
import { buildWorkspaceCommands, WORKSPACE_COMMANDS } from './workspace.js';

/**
 * bridge 命令面方法名（各域声明元组按域顺序派生；BRIDGE_METHODS =
 * 各 `*_COMMANDS` spread——方法名不在此手写，增删改各域文件声明即可）。
 * 顺序 = 分域注释块排列；self_check web_command_surface 夹具逐字比对此导出。
 */
export const BRIDGE_METHODS = [
  // rounds：回合驱动（execution 主线：send/abort/resume）
  ...ROUNDS_COMMANDS,
  // records：会话簿记查询/链记录查询
  ...RECORDS_COMMANDS,
  // sessions：会话薄服务（CRUD/刷新/分支树/消息投影）
  ...SESSIONS_COMMANDS,
  // audit：审计导出/只读窗口
  ...AUDIT_COMMANDS,
  // tools：引擎工具注册表全量工具视图
  ...TOOLS_COMMANDS,
  // recovery：可回退点查询/回退入口/重置（confirm 标记 fail-closed）
  ...RECOVERY_COMMANDS,
  // backup：data_dir 快照导出/预览/恢复（confirm 标记 + 原目录快照）
  ...BACKUP_COMMANDS,
  // mcp：市场浏览（seed 数据 + 挂载态）/挂载/卸载
  ...MCP_COMMANDS,
  // knowledge：知识集读面（list/graph/export）
  ...KNOWLEDGE_COMMANDS,
  // memory：记忆读面/批量失效
  ...MEMORY_COMMANDS,
  // growth：自学习/调参状态报告
  ...GROWTH_COMMANDS,
  // edge_evidence：边证据条目窗口（只读）
  ...EDGE_EVIDENCE_COMMANDS,
  // metrics：回合指标会话窗口（TurnMetrics 投影）
  ...METRICS_COMMANDS,
  // entities：实体注册表快照（只读）
  ...ENTITIES_COMMANDS,
  // os：受控 OS 执行器调用（headless 显式 --approve 语义）
  ...OS_COMMANDS,
  // search：web_search 密钥存取（内存不落盘，web 只回显掩码）
  ...SEARCH_COMMANDS,
  // material：既有资料批量导入（扫描 → doc.parse → 文本/引用入会话）
  ...MATERIAL_COMMANDS,
  // models：模型运行配置（掩码态查询/校验合并落盘/从文件重载/角色槽指派）
  ...MODELS_COMMANDS,
  // model_archive：模型档案快照（从运行 model_config 聚合，无 sqlite 探测）
  ...MODEL_ARCHIVE_COMMANDS,
  // capability：能力记录（读档/存档/常驻工具基线/档位登记；data_dir 持久化）
  ...CAPABILITY_COMMANDS,
  // policy：策略层路由预览（确定性分类；档位/配额随装配数据输出）
  ...POLICY_COMMANDS,
  // ui_components：出厂界面组件启停（factory/disabled/active，引擎同源）
  ...UI_COMPONENTS_COMMANDS,
  // workspace：工作区授权根/挂载清单（data_dir 持久化）
  ...WORKSPACE_COMMANDS,
  // dialog：原生目录选择（exec Rust 稳定原生面；host 中继）
  ...DIALOG_COMMANDS,
  // execution：执行运行时（作用域转场/汇聚点产物；rounds 域并行的执行主线）
  ...EXECUTION_COMMANDS,
  // evolution：受控演化（临时协作统计结晶：evaluate → 隔离试跑闸 → 受控落库）
  ...EVOLUTION_COMMANDS,
] as const;

export type BridgeMethod = (typeof BRIDGE_METHODS)[number];

/**
 * 装配 host bridge 方法表（每 host 实例一次；方法实现闭包持有该 host 的
 * runtime/事件文件传输/会话索引/OS 执行器）。装配遍历各域处理器表（键 =
 * 该域声明元组，编译期已锁一致），再统一套命令闸包装。
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
    buildRoundsCommands(deps),
    buildRecordsCommands(deps),
    buildSessionsCommands(deps),
    buildAuditCommands(deps),
    buildToolsCommands(deps),
    buildRecoveryCommands(deps),
    buildBackupCommands(deps),
    buildMcpCommands(deps),
    buildKnowledgeCommands(deps),
    buildMemoryCommands(deps),
    buildGrowthCommands(deps),
    buildEdgeEvidenceCommands(deps),
    buildMetricsCommands(deps),
    buildEntitiesCommands(deps),
    buildOsCommands(deps),
    buildSearchCommands(deps),
    buildMaterialCommands(deps),
    buildModelsCommands(deps),
    buildModelArchiveCommands(deps),
    buildCapabilityCommands(deps),
    buildPolicyCommands(),
    buildUiComponentsCommands(deps),
    buildWorkspaceCommands(deps.workspace),
    buildDialogCommands(),
    buildExecutionCommands(deps),
    buildEvolutionCommands(deps),
  ];
  const methods = new Map<string, BridgeHandler>();
  for (const group of groups) {
    for (const [name, handler] of Object.entries(group)) {
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

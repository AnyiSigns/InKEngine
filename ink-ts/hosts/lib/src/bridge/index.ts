/**
 * host bridge 命令面装配（buildBridge）：S3 后命令实现位 = 插件 logic face
 * （plugins/commands/<id>/faces/logic，spec 顶层 faces.logic 声明 → manifest
 * plugins[] 行带 faces），本文件只做**装配**：
 *
 * - BRIDGE_METHODS 方法名真源 = plugins/commands/<id>/spec.json（id = 方法名），
 *   生成器派生 commands.generated.ts（各域 `*_COMMANDS` 元组 spread；方法名
 *   唯一真源，增删改命令只改 spec.json + 重跑生成器）；
 * - 装配 = 按 BRIDGE_METHODS 遍历，从 loadHostLogicFaces（manifest faces.logic
 *   target=host 的插件行 → 动态 import entry）取命令插件模块 → 调用默认导出
 *   工厂（S0 契约 `(init?: unknown) => 实例`；本装配传 HostBridgeDeps）→ 挂
 *   Map；BRIDGE_METHODS 已声明但插件逻辑面未装载/工厂缺失 = 装配期 fail-closed；
 * - 已装载的命令逻辑面不在 BRIDGE_METHODS = 多余装载，装配期忽略（挂载完整性
 *   反向由 verify:bridge-mount 守——BRIDGE_METHODS ↔ manifest 命令 faces.logic
 *   双向一致）；
 * - 维护闸包装：restore 期间所有方法（含再次 restore）在入口即被拒绝
 *   （op_gate 语义不变；backup.restore 属危险替换操作，执行期间并发请求一律
 *   拒绝，fail-closed）。
 *
 * 方法增删纪律（AGENTS 纪律 3）：改命令 = 新增/删除 plugins/commands/<id>/ 目录
 * （spec id = 方法名、data.group/data.order 声明域与域内序）+ 同步 CODING.md §9
 * 表 + 重跑生成器；本文件不手写方法名。
 */

import type { BridgeHandler, HostBridgeDeps } from './_types.js';
import { loadHostLogicFaces } from '../face/loader.js';
import {
  AUDIT_COMMANDS,
  BACKUP_COMMANDS,
  CAPABILITY_COMMANDS,
  DIALOG_COMMANDS,
  EDGE_EVIDENCE_COMMANDS,
  ENTITIES_COMMANDS,
  EVOLUTION_COMMANDS,
  EXECUTION_COMMANDS,
  GROWTH_COMMANDS,
  KNOWLEDGE_COMMANDS,
  MATERIAL_COMMANDS,
  MCP_COMMANDS,
  MEMORY_COMMANDS,
  METRICS_COMMANDS,
  MODEL_ARCHIVE_COMMANDS,
  MODELS_COMMANDS,
  OS_COMMANDS,
  POLICY_COMMANDS,
  RECORDS_COMMANDS,
  RECOVERY_COMMANDS,
  ROUNDS_COMMANDS,
  SEARCH_COMMANDS,
  SESSIONS_COMMANDS,
  TOOLS_COMMANDS,
  UI_COMPONENTS_COMMANDS,
  WORKSPACE_COMMANDS,
} from './commands.generated.js';

/**
 * bridge 命令面方法名（各域声明元组按域顺序派生；BRIDGE_METHODS =
 * 各 `*_COMMANDS` spread——方法名不在此手写，增删改各域 spec.json 即可）。
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
 * 装配 host bridge 方法表（每 host 实例一次；命令实现 = 插件 logic face，
 * 工厂闭包持有该 host 的 deps——runtime/事件文件传输/会话索引/OS 执行器等，
 * 经 manifest「ports/命令」段装载后注入）。返回方法表（维护闸已包装）。
 */
export async function buildBridge(deps: HostBridgeDeps): Promise<ReadonlyMap<string, BridgeHandler>> {
  const gate = deps.gate ?? null;
  const wrap = (handler: BridgeHandler): BridgeHandler =>
    gate === null
      ? handler
      : async (params, ctx): Promise<unknown> => {
          gate.assertIdle();
          return handler(params, ctx);
        };

  const loaded = await loadHostLogicFaces(deps.seed_dir);
  const methods = new Map<string, BridgeHandler>();
  for (const name of BRIDGE_METHODS) {
    const module = loaded[name];
    if (module === undefined) {
      throw new Error(
        `BRIDGE_METHODS 已声明但命令插件逻辑面未装载: ${name}（检查 plugins/commands/${name}/spec.json 的 faces.logic 声明与 entry，或重跑生成器）`,
      );
    }
    const factory = (module as { default?: unknown })['default'];
    if (typeof factory !== 'function') {
      throw new Error(
        `命令插件 ${name} faces.logic 缺默认导出工厂（S0 faces.logic 契约：默认导出 = 统一工厂 (init?: unknown) => 实例）`,
      );
    }
    const handler = (factory as (init: unknown) => unknown)(deps);
    if (typeof handler !== 'function') {
      throw new Error(`命令插件 ${name} faces.logic 工厂未返回 BridgeHandler`);
    }
    methods.set(name, handler as BridgeHandler);
  }
  // 维护闸包装：restore 期间所有方法（含再次 restore）在入口即被拒绝
  const wrapped = new Map<string, BridgeHandler>();
  for (const [name, handler] of methods) {
    wrapped.set(name, wrap(handler));
  }
  return wrapped;
}

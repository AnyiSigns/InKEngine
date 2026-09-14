/**
 * collab 域插件（多协作者召集协议 + 宿主执行装配）。
 *
 * 域逻辑唯一实现位（S4 域组3 自 hosts/lib/src/execution/{convene,convene_board,
 * convene_params,service}.ts + collab_command.ts 迁入，语义零改）：
 * - convene：把「召唤协作者」的模型工具调用兑现为白板驱动的子执行 + 裁决归并
 *   （blind 并行协奏 / open 圆桌审议；编排只复用 HostExecutionService 装配，
 *   归并/裁决/收敛语义全在 engine core/collab）；
 * - convene_board：白板授权名册/席位身份/块代写/临时协作观测（TEMP_SIGHTINGS_
 *   COLLECTION 结晶证据流）；convene_params：目标解析 + 参数归一入口校验面；
 * - collab_command：collab_request 组织类工具执行接线（声明式定义 + 端点执行体
 *   + 装配产物 buildCollabCommandTools + 临时观测 sink 装配位）；
 * - service（HostExecutionService）：ExecutionRuntime 依赖注入面 + run/resume/
 *   branch 三入口 + 通道审批挂卡 seam（transitionApprovalSeam）。
 *
 * 装配边界：hosts/lib 只留 DI 注入面（boot.ts 每 boot 构造 + restore 重装共用）
 * 与装配契约类型（bridge/_types HostBridgeDeps.execution 跨树 type import）；
 * 命令面/演化资产消费经跨树 import 本插件包取用（TEMP_SIGHTINGS_COLLECTION /
 * HostExecutionService 类型等），不复制实现。
 */

import {
  COLLAB_REQUEST_ENDPOINT,
  buildCollabCommandTools,
  collabRequestDefinition,
  collabRequestExecutor,
  configureCollabTempSightingSink,
} from './collab_command.js';
import type {
  CollabCommandTools,
  CollabRequestService,
} from './collab_command.js';
import {
  CONVENE_MAX_N,
  CONVENE_MAX_ROUNDS,
  ConveneError,
  convene,
  normalize_convene_params,
  resolve_convene_target,
} from './convene.js';
import type {
  ConveneChildOutcome,
  ConveneInit,
  ConveneResult,
  ConveneTarget,
  TempSightingSink,
} from './convene.js';
import { TEMP_SIGHTINGS_COLLECTION } from './convene.js';
import {
  ConveneBoard,
  board_roster,
  make_temp_sighting,
  opinion_entry_of,
  opinion_text,
  record_temp_sighting,
  scope_contract,
  seat_owner,
  view_scope_of,
} from './convene_board.js';
import type { ConveneAuditSink } from './convene_board.js';
import type { ConveneParams } from './convene_params.js';
import { summarize_temp_def } from './convene_params.js';
import { HostExecutionService, transitionApprovalSeam } from './service.js';
import type {
  HostExecutionServiceInit,
  RunExecutionOptions,
} from './service.js';

export {
  COLLAB_REQUEST_ENDPOINT,
  CONVENE_MAX_N,
  CONVENE_MAX_ROUNDS,
  ConveneBoard,
  ConveneError,
  HostExecutionService,
  TEMP_SIGHTINGS_COLLECTION,
  board_roster,
  buildCollabCommandTools,
  collabRequestDefinition,
  collabRequestExecutor,
  configureCollabTempSightingSink,
  convene,
  make_temp_sighting,
  normalize_convene_params,
  opinion_entry_of,
  opinion_text,
  record_temp_sighting,
  resolve_convene_target,
  scope_contract,
  seat_owner,
  summarize_temp_def,
  transitionApprovalSeam,
  view_scope_of,
};
export type {
  CollabCommandTools,
  CollabRequestService,
} from './collab_command.js';
export type {
  ConveneChildOutcome,
  ConveneInit,
  ConveneResult,
  ConveneTarget,
  TempSightingSink,
} from './convene.js';
export type { ConveneAuditSink } from './convene_board.js';
export type { ConveneParams } from './convene_params.js';
export type {
  HostExecutionServiceInit,
  RunExecutionOptions,
} from './service.js';

/** S4 域服务工厂（S0 装载契约）：collab 域服务面 = 执行装配类 + 召集协议 +
 *  组织类工具接线 + 装配位（HostExecutionService 实例由 boot 注入面构造，
 *  工厂返回类与编排函数面；消费方直接 import 域插件包取用）。 */
export default function createCollabDomain(): {
  HostExecutionService: typeof HostExecutionService;
  convene: typeof convene;
  buildCollabCommandTools: typeof buildCollabCommandTools;
  configureCollabTempSightingSink: typeof configureCollabTempSightingSink;
  TEMP_SIGHTINGS_COLLECTION: string;
} {
  return {
    HostExecutionService,
    convene,
    buildCollabCommandTools,
    configureCollabTempSightingSink,
    TEMP_SIGHTINGS_COLLECTION,
  };
}

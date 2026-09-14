/**
 * 命令插件共享私有件（非插件：无 spec.json，生成器跳过；同 ports/_shared 先例）。
 * 本文件 = hosts/lib/src/bridge/evolution.ts 原样迁入（S3 命令逻辑下沉，语义零改）：
 * evolution.crystallize/evaluate 两命令共享参数校验/审批口径/试跑基座/应用环。
 */

import {
  EntitySpec, ControlledEvolutionApplier, OrgArchive, evaluate_and_adapt,
  effective_org_evaluate_thresholds, evaluate_temp_sightings, isApprovalPose,
  make_trial_runner, normalize_org_evaluate_thresholds, run_adoption_gate,
} from '@ink-ts/engine';
import type {
  ApprovalInterruptContext, ExecutionRequest, ExecutionRuntimeDeps, EvolutionProposal,
  InterruptPolicy, LoadedScope, TrialRunner, TrialSpec,
} from '@ink-ts/engine';
import { BridgeError } from '@ink-ts/host';
import type { HostBridgeDeps } from '@ink-ts/host';
// collab 域插件（S4 域组3：HostExecutionService 类型 + TEMP_SIGHTINGS_COLLECTION
// 值随插件，命令共享件跨树取用）
import type { HostExecutionService } from '../../domains/collab/faces/logic/index.js';
import { TEMP_SIGHTINGS_COLLECTION } from '../../domains/collab/faces/logic/index.js';

/** 组织参数产品配置节名（model_config 既有透传通道下；报告声明同此）。 */
export const ORG_EVOLUTION_SECTION = 'org_evolution';
/** 组织档案快照集合/键（与 execution/service.ts 写侧同串；该文件波内禁改）。 */
export const ORG_ARCHIVE_COLLECTION = 'org.archive';
export const ORG_ARCHIVE_KEY = 'snapshot';

export function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 参数公共段（pose/dry_run；两命令同校验语义，报错消息带命令名）。 */
export function parseCommonParams(raw: unknown, cmd: string): { pose: string | null; dry_run: boolean } {
  if (!isObj(raw)) throw new BridgeError(`${cmd} 需参数对象`, 'invalid_params');
  const pose = raw['pose'];
  if (pose !== undefined && pose !== null && (typeof pose !== 'string' || !isApprovalPose(pose))) {
    throw new BridgeError(`${cmd} pose 须为 auto/review/deny`, 'invalid_params');
  }
  const dryRun = raw['dry_run'];
  if (dryRun !== undefined && dryRun !== null && typeof dryRun !== 'boolean') {
    throw new BridgeError(`${cmd} dry_run 须为布尔`, 'invalid_params');
  }
  return { pose: typeof pose === 'string' ? pose : null, dry_run: dryRun === true };
}

/** 运行时装配件（执行服务 + 存储 + 实体目录 + 演化写入器；缺位 = 显式拒绝）。 */
export function requireRuntimeParts(deps: HostBridgeDeps) {
  const service = deps.execution;
  if (service === undefined || service === null) {
    throw new BridgeError('执行运行时未装配（宿主 execution service 缺位）', 'execution_unavailable');
  }
  const storage = deps.runtime.storage;
  const registry = deps.runtime.entity_registry;
  const writer = deps.runtime._mechanism_writer;
  if (storage === null || registry === null) {
    throw new BridgeError('运行时存储/实体目录未装配（runtime 未 boot/已关停）', 'runtime_unavailable');
  }
  if (writer === null) {
    throw new BridgeError('演化写入器未装配（补丁链三闸门缺位）', 'evolution_unavailable');
  }
  return { service, storage, registry, writer };
}

/** 结晶提案资产 id（回执投影用）。 */
export function proposal_asset_id(proposal: EvolutionProposal): string {
  const asset = proposal.payload['asset'];
  return isObj(asset) && typeof asset['id'] === 'string' ? asset['id'] : '';
}

/** 择优提案目标描述（下架 = 作用域 id；短路/降权 = 链/转场引用）。 */
export function proposal_target(proposal: EvolutionProposal): string {
  const payload = proposal.payload;
  if (proposal.kind === 'retire_scope') return typeof payload['scope'] === 'string' ? payload['scope'] : '';
  if (proposal.kind === 'apply_shortcut') {
    return `${String(payload['from'])}→${String(payload['skip_scope'])}→${String(payload['to'])}`;
  }
  const mode = isObj(payload['mode']) ? payload['mode'] : {};
  return `${String(mode['from'])}→${String(mode['to'])}`;
}

/** 无挂卡通道的审批上下文（review 前置检查已挡；此处兜底 = 直拒 fail-closed）。 */
export const CARDLESS_CTX: ApprovalInterruptContext = { interrupt: async () => 'reject' };

/** headless 审批口径（两命令同源）：非 dry_run 且 review 且策略未直过 = 拒绝。 */
export function assertHeadlessApproval(
  policy: InterruptPolicy, cmd: string, pose: string, dryRun: boolean,
  proposals: readonly EvolutionProposal[],
): void {
  if (dryRun || pose !== 'review') return;
  for (const kind of new Set(proposals.map((p) => p.kind))) {
    // key/action 与 applier approval_key/_action 同串（策略直过名单按此匹配）
    if (policy.should_approve(`evolution_apply:${kind}`, { tool: `apply_evolution:${kind}` })) {
      throw new BridgeError(
        `${cmd} review 姿态无审批卡通道：需 autoApprove/--approve、`
        + 'pose=auto 或能力台账直过名单放行（fail-closed 缺省）',
        'approval_required',
      );
    }
  }
}

/** 隔离试跑基座（每命令一次；审批 seam 按姿态活读，护栏隔离走引擎缺省）。 */
export async function trialBase(service: HostExecutionService, pose: string): Promise<Omit<ExecutionRuntimeDeps, 'load_scope'>> {
  return {
    channels: service.channels,
    turn: await service.turnRunner(),
    approval: service.approvalSeam(pose, 'trial'),
    priors: service.priors,
    guardrails: {},
  };
}

/** 提案集合应用环（两命令共用）：dry_run = 真闸不落库；否则 applier 全链。 */
export async function applyProposalSet(applier: ControlledEvolutionApplier, proposals: readonly EvolutionProposal[], options: {
  dryRun: boolean;
  targetOf: (proposal: EvolutionProposal) => string;
  runnerFor: (proposal: EvolutionProposal) => TrialRunner;
}): Promise<{ results: Record<string, unknown>[]; applied: number }> {
  const results: Record<string, unknown>[] = [];
  let applied = 0;
  for (const proposal of proposals) {
    const asset_id = options.targetOf(proposal);
    const target = { asset_id, proposal: proposal.to_dict() };
    if (options.dryRun) {
      const gate = await run_adoption_gate(proposal, { seam: options.runnerFor(proposal) });
      results.push({
        ...target,
        status: gate.blocked ? 'gate_blocked' : 'gate_passed（dry_run 未落库）',
        gate: { required: gate.required, blocked: gate.blocked, verdict: gate.verdict },
        detail: gate.block_reason ?? `隔离试跑判定 ${String(gate.verdict)}（dry_run 不进审批/落库）`,
      });
      continue;
    }
    try {
      const report = await applier.apply(CARDLESS_CTX, proposal, { trialRunner: options.runnerFor(proposal) });
      if (report.status === 'applied') applied += 1;
      const gate = report.gate;
      results.push({
        ...target,
        status: report.status,
        gate: gate === null ? null : { required: gate.required, blocked: gate.blocked, verdict: gate.verdict },
        approval: report.approval,
        violations: report.violations,
        steps_applied: report.steps_applied,
        detail: report.detail,
      });
    } catch (error) {
      results.push({
        ...target,
        status: 'apply_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { results, applied };
}

/** 阈值配置读入（model_config.org_evolution.evaluate_thresholds；缺位 = null）。 */
export function readOrgEvolutionThresholds(deps: HostBridgeDeps): unknown {
  const modelConfig = deps.host.config.model_config;
  if (!isObj(modelConfig)) return null;
  const section = modelConfig[ORG_EVOLUTION_SECTION];
  if (!isObj(section)) return null;
  return section['evaluate_thresholds'] ?? null;
}

/** 目录已注册未下架的作用域资产 id（= 择优下架候选的目录现状边界）。 */
export function registeredScopeIds(registry: { names(): string[]; get(entityId: string): EntitySpec | null }): string[] {
  const out: string[] = [];
  for (const id of registry.names()) {
    const spec = registry.get(id);
    if (spec === null || spec.scope === null) continue;
    if ((spec.meta ?? {})['retired'] === true) continue;
    out.push(id);
  }
  return out;
}

/** 择优提案试跑探针：变更意图指向的入口作用域隔离跑一轮（retire = 被下架作用域
 *  本身；短路/降权 = 转场起点 from）。不在装载面 = null → inconclusive → 闸阻断
 *  （宁拒勿放，与 trial_runner 缺省探针同词表）。 */
export function evaluate_trial_probe(spec: TrialSpec): ExecutionRequest | null {
  const payload = spec.payload;
  const mode = isObj(payload['mode']) ? payload['mode'] : null;
  const entry = payload['scope'] ?? payload['from'] ?? (mode === null ? undefined : mode['from']);
  if (typeof entry !== 'string' || entry === '') return null;
  return {
    task: `隔离试跑验证: ${spec.kind}（${spec.rationale || '未说明理由'}）`,
    trigger: null,
    entry_scope: entry,
    seed_payload: { evidence: spec.evidence },
  };
}

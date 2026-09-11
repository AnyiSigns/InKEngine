import type { EvolutionCommand } from './commands.generated.js';
export { EVOLUTION_COMMANDS, type EvolutionCommand } from './commands.generated.js';
/**
 * evolution 命令面（evolution.crystallize）——临时协作结晶的宿主入口。
 *
 * 设计稿 §五「结晶」+ §六「孵化（统计结晶）同一条受控通道」的桥接线：读
 * org.temp_sightings 观测集合（convene 临时作用域 settle 时经 boot 装配的存储
 * 通道追加）→ 引擎评估器（crystallize.ts，纯函数：阈值 + 目录感知 → add_scope
 * 提案，org-pruning 来源 + 证据摘要）→ 既有采纳闸（org_pruning 新增强制隔离
 * 试跑，trial 用既有 trial_runner：独立 ExecutionRuntime + archive 置空，试跑
 * 胜负不进主执行档案）→ ControlledEvolutionApplier（审批 + 补丁链 +
 * GuardedStorage 落库 + 活跃注册表换入）→ 回执提案/应用结果。
 *
 * 宿主只装配不复制：闸门规则/提案校验/落库三闸门全在引擎；本域做「观测读取 +
 * 依赖注入 + 回执投影」。headless 无挂卡通道：review 姿态且策略非直过 =
 * 显式拒绝（autoApprove/pose=auto/策略直过名单三选一放行，同 os.run 姿势）；
 * dry_run = evaluate + gate（试跑照常隔离执行）但不写。
 */

import {
  EntitySpec,
  ControlledEvolutionApplier,
  evaluate_temp_sightings,
  isApprovalPose,
  make_trial_runner,
  run_adoption_gate,
} from '@ink-ts/engine';
import type { ExecutionRuntimeDeps, LoadedScope, TrialRunner } from '@ink-ts/engine';
import type { InterruptPolicy } from '@ink-ts/engine';
import type { ApprovalInterruptContext } from '@ink-ts/engine';
import type { EvolutionProposal } from '@ink-ts/engine';

import { BridgeError, type BridgeHandler } from './_types.js';
import type { HostBridgeDeps } from './_types.js';
import { TEMP_SIGHTINGS_COLLECTION } from '../execution/convene_board.js';

interface CrystallizeParams {
  pose: string | null;
  role: string | null;
  dry_run: boolean;
}

function asCrystallizeParams(raw: unknown): CrystallizeParams {
  const params = raw as Record<string, unknown> | null;
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const pose = params['pose'];
    if (pose !== undefined && pose !== null && (typeof pose !== 'string' || !isApprovalPose(pose))) {
      throw new BridgeError('evolution.crystallize pose 须为 auto/review/deny', 'invalid_params');
    }
    const role = params['role'];
    if (role !== undefined && role !== null && (typeof role !== 'string' || role.trim() === '')) {
      throw new BridgeError('evolution.crystallize role 须为非空字符串（只结晶该模式）', 'invalid_params');
    }
    const dryRun = params['dry_run'];
    if (dryRun !== undefined && dryRun !== null && typeof dryRun !== 'boolean') {
      throw new BridgeError('evolution.crystallize dry_run 须为布尔', 'invalid_params');
    }
    return {
      pose: typeof pose === 'string' ? pose : null,
      role: typeof role === 'string' ? role.trim() : null,
      dry_run: dryRun === true,
    };
  }
  throw new BridgeError('evolution.crystallize 需参数对象', 'invalid_params');
}

/** 提案资产 id（回执投影用）。 */
function proposal_asset_id(proposal: EvolutionProposal): string {
  const asset = proposal.payload['asset'];
  if (asset !== null && typeof asset === 'object') {
    const id = (asset as Record<string, unknown>)['id'];
    if (typeof id === 'string') return id;
  }
  return '';
}

/** 无挂卡通道的审批上下文（review 前置检查已挡；此处兜底 = 直拒 fail-closed）。 */
const CARDLESS_CTX: ApprovalInterruptContext = {
  interrupt: async () => 'reject',
};

export function buildEvolutionCommands(
  deps: HostBridgeDeps,
): Readonly<Record<EvolutionCommand, BridgeHandler>> {
  const crystallize: BridgeHandler = async (raw, ctx): Promise<unknown> => {
    const params = asCrystallizeParams(raw);
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
    const rows = await storage.list_records(TEMP_SIGHTINGS_COLLECTION);
    const sightings =
      params.role === null
        ? rows
        : rows.filter(
            (row) => row !== null && typeof row === 'object' && row['role'] === params.role,
          );
    const evaluation = evaluate_temp_sightings(sightings, { entity_ids: registry.names() });
    const receipt: Record<string, unknown> = {
      ok: true,
      sightings: sightings.length,
      patterns: evaluation.patterns,
      proposals: evaluation.proposals.map((p) => p.to_dict()),
    };
    if (evaluation.proposals.length === 0) {
      return { ...receipt, status: 'no_proposals', results: [] };
    }
    const pose = params.pose ?? (ctx.autoApprove === true ? 'auto' : 'review');
    const policy: InterruptPolicy = deps.host.interrupt_policy();
    if (!params.dry_run && pose === 'review') {
      // 桥面无挂卡通道（与通道审批 seam 同口径）：策略未直过 = 显式拒绝
      if (policy.should_approve('evolution_apply:add_scope', { tool: 'apply_evolution:add_scope' })) {
        throw new BridgeError(
          'evolution.crystallize review 姿态无审批卡通道：需 autoApprove/--approve、'
          + 'pose=auto 或能力台账直过名单放行（fail-closed 缺省）',
          'approval_required',
        );
      }
    }
    // 隔离试跑基座（每提案独立装载面：提案资产按 id 穿透 load_scope 叠加）
    const turn = await service.turnRunner();
    const baseDeps: Omit<ExecutionRuntimeDeps, 'load_scope'> = {
      channels: service.channels,
      turn,
      approval: service.approvalSeam(pose, 'trial'),
      priors: service.priors,
      guardrails: {},
    };
    const runnerFor = (proposal: EvolutionProposal): TrialRunner => {
      const asset = proposal.payload['asset'] as Record<string, unknown>;
      const assetId = typeof asset['id'] === 'string' ? asset['id'] : '';
      const overlay = (scopeId: string): LoadedScope | null => {
        if (scopeId === assetId && assetId !== '') {
          try {
            return EntitySpec.from_dict(asset);
          } catch {
            return null; // 资产非法 = 试跑装载失败（inconclusive，宁拒勿放）
          }
        }
        return service.loadScope(scopeId);
      };
      return make_trial_runner({
        deps: { ...baseDeps, load_scope: overlay } as ExecutionRuntimeDeps,
      });
    };
    const applier = new ControlledEvolutionApplier({
      entities: registry,
      channels: service.channels,
      writer,
      approvalPolicy: policy,
      pose,
    });
    const results: Record<string, unknown>[] = [];
    let applied = 0;
    for (const proposal of evaluation.proposals) {
      const asset_id = proposal_asset_id(proposal);
      if (params.dry_run) {
        const gate = await run_adoption_gate(proposal, { seam: runnerFor(proposal) });
        results.push({
          asset_id,
          proposal: proposal.to_dict(),
          status: gate.blocked ? 'gate_blocked' : 'gate_passed（dry_run 未落库）',
          gate: { required: gate.required, blocked: gate.blocked, verdict: gate.verdict },
          detail: gate.block_reason ?? `隔离试跑判定 ${String(gate.verdict)}（dry_run 不进审批/落库）`,
        });
        continue;
      }
      try {
        const report = await applier.apply(CARDLESS_CTX, proposal, { trialRunner: runnerFor(proposal) });
        if (report.status === 'applied') applied += 1;
        results.push({
          asset_id,
          proposal: proposal.to_dict(),
          status: report.status,
          gate: report.gate === null
            ? null
            : { required: report.gate.required, blocked: report.gate.blocked, verdict: report.gate.verdict },
          approval: report.approval,
          violations: report.violations,
          steps_applied: report.steps_applied,
          detail: report.detail,
        });
      } catch (error) {
        results.push({
          asset_id,
          proposal: proposal.to_dict(),
          status: 'apply_failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const allApplied = applied === evaluation.proposals.length;
    return {
      ...receipt,
      status: params.dry_run ? 'dry_run' : allApplied ? 'applied' : 'partial',
      applied,
      results,
    };
  };

  return { 'evolution.crystallize': crystallize };
}
